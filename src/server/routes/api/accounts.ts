import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { refreshBalance } from '../../services/balanceService.js';
import { getAdapter } from '../../services/platforms/index.js';
import { refreshModelsForAccount, rebuildTokenRoutesFromAvailability } from '../../services/modelService.js';
import { ensureDefaultTokenForAccount, syncTokensFromUpstream } from '../../services/accountTokenService.js';
import {
  getCredentialModeFromExtraConfig,
  guessPlatformUserIdFromUsername,
  getSub2ApiAuthFromExtraConfig,
  mergeAccountExtraConfig,
  normalizeCredentialMode as normalizeCredentialModeInput,
  resolvePlatformUserId,
  type AccountCredentialMode,
} from '../../services/accountExtraConfig.js';
import { encryptAccountPassword } from '../../services/accountCredentialService.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import { parseCheckinRewardAmount } from '../../services/checkinRewardParser.js';
import { estimateRewardWithTodayIncomeFallback } from '../../services/todayIncomeRewardService.js';
import { getLocalDayRangeUtc } from '../../services/localTimeService.js';
import {
  buildRuntimeHealthForAccount,
  setAccountRuntimeHealth,
  type RuntimeHealthState,
} from '../../services/accountHealthService.js';
import { appendSessionTokenRebindHint } from '../../services/alertRules.js';
import { withExplicitProxyRequestInit } from '../../services/siteProxy.js';

type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

type AccountHealthRefreshResult = {
  accountId: number;
  username: string | null;
  siteName: string;
  status: 'success' | 'failed' | 'skipped';
  state: RuntimeHealthState;
  message: string;
};

type AccountCapabilities = {
  canCheckin: boolean;
  canRefreshBalance: boolean;
  proxyOnly: boolean;
};

function hasSessionTokenValue(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveRequestedCredentialMode(input: unknown): AccountCredentialMode {
  return normalizeCredentialModeInput(input) || 'auto';
}

function resolveStoredCredentialMode(account: typeof schema.accounts.$inferSelect): AccountCredentialMode {
  const fromConfig = getCredentialModeFromExtraConfig(account.extraConfig);
  if (fromConfig && fromConfig !== 'auto') return fromConfig;
  return hasSessionTokenValue(account.accessToken) ? 'session' : 'apikey';
}

function buildCapabilitiesFromCredentialMode(
  credentialMode: AccountCredentialMode,
  hasSessionToken: boolean,
): AccountCapabilities {
  const sessionCapable = credentialMode === 'session'
    ? hasSessionToken
    : (credentialMode === 'apikey' ? false : hasSessionToken);
  return {
    canCheckin: sessionCapable,
    canRefreshBalance: sessionCapable,
    proxyOnly: !sessionCapable,
  };
}

function buildCapabilitiesForAccount(account: typeof schema.accounts.$inferSelect): AccountCapabilities {
  const credentialMode = resolveStoredCredentialMode(account);
  return buildCapabilitiesFromCredentialMode(credentialMode, hasSessionTokenValue(account.accessToken));
}

function normalizePinnedFlag(input: unknown): boolean | null {
  if (input === undefined || input === null) return null;
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') return input !== 0;
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return null;
}

function normalizeSortOrder(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  const parsed = Number.parseInt(String(input), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed);
}

function normalizeManagedRefreshToken(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined;
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeManagedTokenExpiresAt(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) return Math.trunc(input);
  if (typeof input === 'string') {
    const parsed = Number.parseInt(input.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

function getNextAccountSortOrder(): number {
  const rows = db.select({ sortOrder: schema.accounts.sortOrder }).from(schema.accounts).all();
  const max = rows.reduce((currentMax, row) => Math.max(currentMax, row.sortOrder || 0), -1);
  return max + 1;
}

type LoginFailureInfo = {
  message: string;
  shieldBlocked: boolean;
};

function normalizeLoginFailure(message: string | null | undefined): LoginFailureInfo {
  const raw = (message || '').trim();
  const lowered = raw.toLowerCase();
  const looksLikeHtmlJsonParseError = (
    lowered.includes('unexpected token')
    && lowered.includes('not valid json')
    && (lowered.includes('<html') || lowered.includes('<script'))
  );
  const looksLikeShieldChallenge = (
    lowered.includes('acw_sc__v2')
    || lowered.includes('var arg1')
    || lowered.includes('captcha')
    || lowered.includes('challenge')
    || lowered.includes('cloudflare tunnel error')
  );

  if (looksLikeHtmlJsonParseError || looksLikeShieldChallenge) {
    return {
      shieldBlocked: true,
      message: 'This site is shielded by anti-bot challenge. Account/password login is blocked. Create an API key on the target site and import that key.',
    };
  }

  return {
    shieldBlocked: false,
    message: raw || 'login failed',
  };
}

function summarizeAccountHealthRefresh(results: AccountHealthRefreshResult[]) {
  return {
    total: results.length,
    healthy: results.filter((item) => item.state === 'healthy').length,
    unhealthy: results.filter((item) => item.state === 'unhealthy').length,
    degraded: results.filter((item) => item.state === 'degraded').length,
    disabled: results.filter((item) => item.state === 'disabled').length,
    unknown: results.filter((item) => item.state === 'unknown').length,
    success: results.filter((item) => item.status === 'success').length,
    failed: results.filter((item) => item.status === 'failed').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
  };
}

async function refreshRuntimeHealthForRow(row: AccountWithSiteRow): Promise<AccountHealthRefreshResult> {
  const accountId = row.accounts.id;
  const username = row.accounts.username;
  const siteName = row.sites.name;

  if ((row.accounts.status || 'active') === 'disabled' || (row.sites.status || 'active') === 'disabled') {
    setAccountRuntimeHealth(accountId, {
      state: 'disabled',
      reason: '账号或站点已禁用',
      source: 'health-refresh',
    });
    return {
      accountId,
      username,
      siteName,
      status: 'skipped',
      state: 'disabled',
      message: '账号或站点已禁用',
    };
  }

  try {
    await refreshBalance(accountId);
    const refreshedAccount = db.select().from(schema.accounts)
      .where(eq(schema.accounts.id, accountId))
      .get();
    const runtimeHealth = buildRuntimeHealthForAccount({
      accountStatus: refreshedAccount?.status || row.accounts.status,
      siteStatus: row.sites.status,
      extraConfig: refreshedAccount?.extraConfig ?? row.accounts.extraConfig,
    });

    return {
      accountId,
      username,
      siteName,
      status: runtimeHealth.state === 'unhealthy' ? 'failed' : 'success',
      state: runtimeHealth.state,
      message: runtimeHealth.reason,
    };
  } catch (error: any) {
    const message = String(error?.message || '健康检查失败');
    setAccountRuntimeHealth(accountId, {
      state: 'unhealthy',
      reason: message,
      source: 'health-refresh',
    });
    return {
      accountId,
      username,
      siteName,
      status: 'failed',
      state: 'unhealthy',
      message,
    };
  }
}

async function executeRefreshAccountRuntimeHealth(accountId?: number) {
  const rows = db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  const targetRows = Number.isFinite(accountId as number)
    ? rows.filter((row) => row.accounts.id === accountId)
    : rows;

  const results: AccountHealthRefreshResult[] = [];
  for (const row of targetRows) {
    results.push(await refreshRuntimeHealthForRow(row));
  }

  return {
    summary: summarizeAccountHealthRefresh(results),
    results,
  };
}

export async function accountsRoutes(app: FastifyInstance) {
  // List all accounts (with site info)
  app.get('/api/accounts', async () => {
    const rows = db.select().from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id)).all();

    const { localDay, startUtc, endUtc } = getLocalDayRangeUtc();

    // Aggregate today's spend per account from proxy logs
    const todaySpendRows = db.select({
      accountId: schema.proxyLogs.accountId,
      totalSpend: sql<number>`coalesce(sum(${schema.proxyLogs.estimatedCost}), 0)`,
    }).from(schema.proxyLogs)
      .where(and(gte(schema.proxyLogs.createdAt, startUtc), lt(schema.proxyLogs.createdAt, endUtc)))
      .groupBy(schema.proxyLogs.accountId)
      .all();
    const spendByAccount: Record<number, number> = {};
    for (const row of todaySpendRows) {
      if (row.accountId == null) continue;
      spendByAccount[row.accountId] = Number(row.totalSpend || 0);
    }

    // Aggregate today's checkin rewards per account
    const todayCheckins = db.select({
      accountId: schema.checkinLogs.accountId,
      reward: schema.checkinLogs.reward,
      message: schema.checkinLogs.message,
    }).from(schema.checkinLogs)
      .where(and(
        gte(schema.checkinLogs.createdAt, startUtc),
        lt(schema.checkinLogs.createdAt, endUtc),
        eq(schema.checkinLogs.status, 'success'),
      ))
      .all();
    const rewardByAccount: Record<number, number> = {};
    const successCountByAccount: Record<number, number> = {};
    const parsedRewardCountByAccount: Record<number, number> = {};
    for (const log of todayCheckins) {
      successCountByAccount[log.accountId] = (successCountByAccount[log.accountId] || 0) + 1;
      const rewardNum = parseCheckinRewardAmount(log.reward) || parseCheckinRewardAmount(log.message);
      if (rewardNum <= 0) continue;
      rewardByAccount[log.accountId] = (rewardByAccount[log.accountId] || 0) + rewardNum;
      parsedRewardCountByAccount[log.accountId] = (parsedRewardCountByAccount[log.accountId] || 0) + 1;
    }

    return rows.map((r) => {
      const credentialMode = resolveStoredCredentialMode(r.accounts);
      return {
        ...r.accounts,
        site: r.sites,
        credentialMode,
        capabilities: buildCapabilitiesFromCredentialMode(
          credentialMode,
          hasSessionTokenValue(r.accounts.accessToken),
        ),
        todaySpend: Math.round((spendByAccount[r.accounts.id] || 0) * 1_000_000) / 1_000_000,
        todayReward: Math.round(estimateRewardWithTodayIncomeFallback({
          day: localDay,
          successCount: successCountByAccount[r.accounts.id] || 0,
          parsedRewardCount: parsedRewardCountByAccount[r.accounts.id] || 0,
          rewardSum: rewardByAccount[r.accounts.id] || 0,
          extraConfig: r.accounts.extraConfig,
        }) * 1_000_000) / 1_000_000,
        runtimeHealth: buildRuntimeHealthForAccount({
          accountStatus: r.accounts.status,
          siteStatus: r.sites.status,
          extraConfig: r.accounts.extraConfig,
        }),
      };
    });
  });

  // Login to a site and auto-create account
  app.post<{ Body: { siteId: number; username: string; password: string } }>('/api/accounts/login', async (request) => {
    const { siteId, username, password } = request.body;

    // Get site info
    const site = db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!site) return { success: false, message: 'site not found' };

    // Get platform adapter
    const adapter = getAdapter(site.platform);
    if (!adapter) return { success: false, message: `婵炴垶鎸哥粔鐢稿极椤曗偓楠炴劖鎷呴悜妯兼殸濡ょ姷鍋涢崯鑳亹? ${site.platform}` };

    // Login to the target site
    const loginResult = await adapter.login(site.url, username, password);
    if (!loginResult.success || !loginResult.accessToken) {
      const normalizedFailure = normalizeLoginFailure(loginResult.message);
      return {
        success: false,
        shieldBlocked: normalizedFailure.shieldBlocked,
        message: normalizedFailure.message,
      };
    }

    const guessedPlatformUserId = guessPlatformUserIdFromUsername(username);

    // Auto-fetch API token(s)
    let apiToken: string | null = null;
    let apiTokens: Array<{ name?: string | null; key?: string | null; enabled?: boolean | null }> = [];
    try {
      apiToken = await adapter.getApiToken(site.url, loginResult.accessToken, guessedPlatformUserId);
    } catch { }
    try {
      apiTokens = await adapter.getApiTokens(site.url, loginResult.accessToken, guessedPlatformUserId);
    } catch { }

    const preferredApiToken = apiTokens.find((token) => token.enabled !== false && token.key)?.key || apiToken || null;
    const existing = db.select().from(schema.accounts)
      .where(and(eq(schema.accounts.siteId, siteId), eq(schema.accounts.username, username)))
      .get();

    const extraConfigPatch: Record<string, unknown> = {
      credentialMode: 'session',
      autoRelogin: {
        username,
        passwordCipher: encryptAccountPassword(password),
        updatedAt: new Date().toISOString(),
      },
    };
    if (guessedPlatformUserId) {
      extraConfigPatch.platformUserId = guessedPlatformUserId;
    }
    const extraConfig = mergeAccountExtraConfig(existing?.extraConfig, extraConfigPatch);

    // Create or update account
    let accountId = existing?.id;
    if (existing) {
      db.update(schema.accounts).set({
        accessToken: loginResult.accessToken,
        apiToken: preferredApiToken || undefined,
        checkinEnabled: true,
        status: 'active',
        extraConfig,
        updatedAt: new Date().toISOString(),
      }).where(eq(schema.accounts.id, existing.id)).run();
    } else {
      const created = db.insert(schema.accounts).values({
        siteId,
        username,
        accessToken: loginResult.accessToken,
        apiToken: preferredApiToken || undefined,
        checkinEnabled: true,
        extraConfig,
        isPinned: false,
        sortOrder: getNextAccountSortOrder(),
      }).returning().get();
      accountId = created.id;
    }

    const result = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId!)).get();
    if (!result) {
      return { success: false, message: 'account create failed' };
    }

    if (apiTokens.length > 0) {
      try {
        syncTokensFromUpstream(result.id, apiTokens);
      } catch { }
    } else if (preferredApiToken) {
      try {
        ensureDefaultTokenForAccount(result.id, preferredApiToken, { name: 'default', source: 'sync' });
      } catch { }
    }

    // Auto-refresh balance
    try { await refreshBalance(result.id); } catch { }
    try {
      await refreshModelsForAccount(result.id);
      rebuildTokenRoutesFromAvailability();
    } catch { }

    const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, result.id)).get();
    return {
      success: true,
      account,
      apiTokenFound: !!preferredApiToken,
      tokenCount: apiTokens.length,
      reusedAccount: !!existing,
    };
  });

  // Verify credentials against a site.
  app.post<{ Body: { siteId: number; accessToken: string; platformUserId?: number; credentialMode?: AccountCredentialMode } }>('/api/accounts/verify-token', async (request) => {
    const { siteId, platformUserId } = request.body;
    const accessToken = (request.body.accessToken || '').trim();
    const credentialMode = resolveRequestedCredentialMode(request.body.credentialMode);
    const site = db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!site) return { success: false, message: 'site not found' };

    if (!accessToken) {
      return { success: false, message: 'Token 不能为空' };
    }

    const adapter = getAdapter(site.platform);
    if (!adapter) return { success: false, message: `婵炴垶鎸哥粔鐢稿极椤曗偓楠炴劖鎷呴悜妯兼殸濡ょ姷鍋涢崯鑳亹? ${site.platform}` };

    if (credentialMode === 'apikey') {
      try {
        const models = await adapter.getModels(site.url, accessToken, platformUserId);
        const availableModels = Array.isArray(models) ? models.filter((item) => typeof item === 'string' && item.trim().length > 0) : [];
        if (availableModels.length === 0) {
          return {
            success: false,
            message: 'API Key 验证失败：未获取到可用模型',
          };
        }
        return {
          success: true,
          tokenType: 'apikey',
          modelCount: availableModels.length,
          models: availableModels.slice(0, 10),
        };
      } catch (err: any) {
        return {
          success: false,
          message: err?.message || 'API Key 验证失败',
        };
      }
    }

    let result: any;
    try {
      result = await adapter.verifyToken(site.url, accessToken, platformUserId);
    } catch (err: any) {
      return {
        success: false,
        message: appendSessionTokenRebindHint(err?.message || 'Token 验证失败'),
      };
    }

    if (result.tokenType === 'session') {
      return {
        success: true,
        tokenType: 'session',
        userInfo: result.userInfo,
        balance: result.balance,
        apiToken: result.apiToken,
      };
    }

    if (result.tokenType === 'apikey') {
      if (credentialMode === 'session') {
        return {
          success: false,
          message: '当前凭证是 API Key，请切换到 API Key 模式，或改用 Session Token',
        };
      }
      return {
        success: true,
        tokenType: 'apikey',
        modelCount: result.models?.length || 0,
        models: result.models?.slice(0, 10),
      };
    }

    // Try to explain unknown failures: missing user id vs anti-bot challenge page.
    const normalizedPlatform = String(adapter.platformName || site.platform || '').trim().toLowerCase();
    // New-API family already runs shield-aware probing inside adapters.
    // Raw fallback probe below does not include challenge-solving and can
    // misclassify valid Cookie/Session flows as shield-blocked.
    const skipRawShieldDetection = normalizedPlatform === 'new-api' || normalizedPlatform === 'anyrouter';
    type VerifyFailureReason = 'needs-user-id' | 'shield-blocked' | null;
    const detectVerifyFailureReason = async (): Promise<VerifyFailureReason> => {
      const parseFailureReason = (bodyText: string, contentType: string): VerifyFailureReason => {
        const text = bodyText || '';
        const ct = (contentType || '').toLowerCase();
        if (
          !skipRawShieldDetection
          && ct.includes('text/html')
          && /var\s+arg1\s*=|acw_sc__v2|cdn_sec_tc|<script/i.test(text)
        ) {
          return 'shield-blocked';
        }

        try {
          const body = JSON.parse(text) as any;
          const message = typeof body?.message === 'string' ? body.message : '';
          if (/mismatch|new-api-user|user id/i.test(message)) return 'needs-user-id';
          if (!skipRawShieldDetection && /shield|challenge|captcha|acw_sc__v2|arg1/i.test(message)) {
            return 'shield-blocked';
          }
        } catch { }

        return null;
      };

      try {
        const { fetch } = await import('undici');
        const candidates = new Set<string>();
        const raw = accessToken.startsWith('Bearer ') ? accessToken.slice(7).trim() : accessToken;
        if (raw) {
          if (raw.includes('=')) candidates.add(raw);
          candidates.add(`session=${raw}`);
          candidates.add(`token=${raw}`);
        }

        const headerVariants: Record<string, string>[] = [
          { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'New-Api-User': '0' },
        ];

        for (const cookie of candidates) {
          headerVariants.push({
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-Requested-With': 'XMLHttpRequest',
          });
        }

        for (const headers of headerVariants) {
          try {
            const testRes = await fetch(`${site.url}/api/user/self`, withExplicitProxyRequestInit(site.proxyUrl, { headers }));
            const bodyText = await testRes.text();
            const contentType = testRes.headers.get('content-type') || '';
            const reason = parseFailureReason(bodyText, contentType);
            if (reason) return reason;
          } catch { }
        }
      } catch { }

      return null;
    };

    const failureReason = await detectVerifyFailureReason();
    if (failureReason === 'needs-user-id') {
      return {
        success: false,
        needsUserId: true,
        message: 'This site requires a user ID. Please fill in your site user ID.',
      };
    }

    if (failureReason === 'shield-blocked') {
      return {
        success: false,
        shieldBlocked: true,
        message: 'This site is shielded by anti-bot challenge. Create an API key on the target site and import that key.',
      };
    }

    return {
      success: false,
      message: credentialMode === 'session'
        ? 'Session Token 验证失败'
        : 'Token invalid: cannot use it as session cookie or API key',
    };
  });

  app.post<{ Params: { id: string }; Body: { accessToken: string; platformUserId?: number } }>(
    '/api/accounts/:id/rebind-session',
    async (request, reply) => {
      const accountId = Number.parseInt(request.params.id, 10);
      if (!Number.isFinite(accountId) || accountId <= 0) {
        return reply.code(400).send({ success: false, message: '账号 ID 无效' });
      }

      const nextAccessToken = (request.body?.accessToken || '').trim();
      if (!nextAccessToken) {
        return reply.code(400).send({ success: false, message: '请提供新的 Session Token' });
      }

      const row = db.select()
        .from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(eq(schema.accounts.id, accountId))
        .get();
      if (!row) {
        return reply.code(404).send({ success: false, message: '账号不存在' });
      }

      const account = row.accounts;
      const site = row.sites;
      const adapter = getAdapter(site.platform);
      if (!adapter) {
        return reply.code(400).send({ success: false, message: `platform not supported: ${site.platform}` });
      }

      const bodyPlatformUserId = Number.parseInt(String(request.body?.platformUserId ?? ''), 10);
      const candidatePlatformUserId = Number.isFinite(bodyPlatformUserId) && bodyPlatformUserId > 0
        ? bodyPlatformUserId
        : resolvePlatformUserId(account.extraConfig, account.username);

      let verifyResult: any;
      try {
        verifyResult = await adapter.verifyToken(site.url, nextAccessToken, candidatePlatformUserId);
      } catch (err: any) {
        return reply.code(400).send({
          success: false,
          message: appendSessionTokenRebindHint(err?.message || 'Token 验证失败'),
        });
      }

      if (verifyResult?.tokenType !== 'session') {
        return reply.code(400).send({
          success: false,
          message: '新的 Token 验证失败：请提供可用的 Session Token',
        });
      }

      const nextUsernameRaw = typeof verifyResult?.userInfo?.username === 'string'
        ? verifyResult.userInfo.username.trim()
        : '';
      const nextUsername = nextUsernameRaw || account.username || '';
      const inferredPlatformUserId = resolvePlatformUserId(account.extraConfig, nextUsername);
      const resolvedPlatformUserId = Number.isFinite(bodyPlatformUserId) && bodyPlatformUserId > 0
        ? bodyPlatformUserId
        : inferredPlatformUserId;
      const nextApiToken = typeof verifyResult?.apiToken === 'string' && verifyResult.apiToken.trim().length > 0
        ? verifyResult.apiToken.trim()
        : (account.apiToken || '');

      const updates: Record<string, unknown> = {
        accessToken: nextAccessToken,
        status: 'active',
        updatedAt: new Date().toISOString(),
      };
      if (nextUsername) {
        updates.username = nextUsername;
      }
      if (nextApiToken) {
        updates.apiToken = nextApiToken;
      }
      const extraConfigPatch: Record<string, unknown> = { credentialMode: 'session' };
      if (resolvedPlatformUserId) {
        extraConfigPatch.platformUserId = resolvedPlatformUserId;
      }
      updates.extraConfig = mergeAccountExtraConfig(account.extraConfig, extraConfigPatch);

      db.update(schema.accounts).set(updates).where(eq(schema.accounts.id, accountId)).run();

      if (nextApiToken) {
        try {
          ensureDefaultTokenForAccount(accountId, nextApiToken, { name: 'default', source: 'sync' });
        } catch {}
      }

      try {
        await refreshBalance(accountId);
      } catch {}
      try {
        await refreshModelsForAccount(accountId);
        rebuildTokenRoutesFromAvailability();
      } catch {}

      const latest = db.select().from(schema.accounts).where(eq(schema.accounts.id, accountId)).get();
      return {
        success: true,
        account: latest,
        tokenType: 'session',
        credentialMode: 'session',
        capabilities: latest ? buildCapabilitiesForAccount(latest) : buildCapabilitiesFromCredentialMode('session', true),
        apiTokenFound: !!nextApiToken,
      };
    },
  );

  // Add an account (manual credential input)
  app.post<{ Body: { siteId: number; username?: string; accessToken: string; apiToken?: string; platformUserId?: number; checkinEnabled?: boolean; credentialMode?: AccountCredentialMode; refreshToken?: string; tokenExpiresAt?: number | string } }>('/api/accounts', async (request, reply) => {
    const body = request.body;
    const site = db.select().from(schema.sites).where(eq(schema.sites.id, body.siteId)).get();
    if (!site) {
      return reply.code(400).send({ success: false, message: 'site not found' });
    }

    const adapter = getAdapter(site.platform);
    if (!adapter) {
      return reply.code(400).send({ success: false, message: `platform not supported: ${site.platform}` });
    }

    const credentialMode = resolveRequestedCredentialMode(body.credentialMode);
    const rawAccessToken = (body.accessToken || '').trim();
    if (!rawAccessToken) {
      return reply.code(400).send({ success: false, message: '请填写 Token' });
    }

    let username = (body.username || '').trim();
    let accessToken = rawAccessToken;
    let apiToken = (body.apiToken || '').trim();
    let tokenType: 'session' | 'apikey' | 'unknown' = 'unknown';
    let verifiedModels: string[] = [];

    if (credentialMode === 'apikey') {
      try {
        const models = await adapter.getModels(site.url, rawAccessToken, body.platformUserId);
        verifiedModels = Array.isArray(models)
          ? models.filter((item) => typeof item === 'string' && item.trim().length > 0)
          : [];
      } catch (err: any) {
        return reply.code(400).send({
          success: false,
          message: err?.message || 'API Key 验证失败',
        });
      }

      if (verifiedModels.length === 0) {
        return reply.code(400).send({
          success: false,
          requiresVerification: true,
          message: 'API Key 验证失败：未获取到可用模型',
        });
      }

      tokenType = 'apikey';
      accessToken = '';
      if (!apiToken) apiToken = rawAccessToken;
    } else {
      let verifyResult: any;
      try {
        verifyResult = await adapter.verifyToken(site.url, rawAccessToken, body.platformUserId);
      } catch (err: any) {
        return reply.code(400).send({
          success: false,
          message: appendSessionTokenRebindHint(err?.message || 'Token 验证失败'),
        });
      }

      tokenType = verifyResult.tokenType;
      if (tokenType === 'unknown') {
        return reply.code(400).send({
          success: false,
          requiresVerification: true,
          message: 'Token 验证失败，请先点击“验证 Token”，验证成功后再绑定账号',
        });
      }

      if (credentialMode === 'session' && tokenType !== 'session') {
        return reply.code(400).send({
          success: false,
          message: '当前凭证是 API Key，请切换到 API Key 模式，或改用 Session Token',
        });
      }

      if (tokenType === 'session') {
        if (!username && verifyResult.userInfo?.username) username = String(verifyResult.userInfo.username).trim();
        if (!apiToken && verifyResult.apiToken) apiToken = String(verifyResult.apiToken).trim();
      } else if (tokenType === 'apikey') {
        accessToken = '';
        if (!apiToken) apiToken = rawAccessToken;
        verifiedModels = Array.isArray(verifyResult.models)
          ? verifyResult.models.filter((item: unknown) => typeof item === 'string' && item.trim().length > 0)
          : [];
      }
    }

    // Store platformUserId and credential mode in extraConfig.
    const resolvedPlatformUserId =
      body.platformUserId || guessPlatformUserIdFromUsername(username) || undefined;
    const resolvedCredentialMode: AccountCredentialMode = tokenType === 'apikey' ? 'apikey' : 'session';
    const extraConfigPatch: Record<string, unknown> = { credentialMode: resolvedCredentialMode };
    if (resolvedPlatformUserId) {
      extraConfigPatch.platformUserId = resolvedPlatformUserId;
    }
    if ((site.platform || '').toLowerCase() === 'sub2api') {
      const managedRefreshToken = normalizeManagedRefreshToken(body.refreshToken);
      const managedTokenExpiresAt = normalizeManagedTokenExpiresAt(body.tokenExpiresAt);
      if (managedRefreshToken) {
        extraConfigPatch.sub2apiAuth = managedTokenExpiresAt
          ? { refreshToken: managedRefreshToken, tokenExpiresAt: managedTokenExpiresAt }
          : { refreshToken: managedRefreshToken };
      }
    }
    const extraConfig = mergeAccountExtraConfig(undefined, extraConfigPatch);

    const result = db.insert(schema.accounts).values({
      siteId: body.siteId,
      username: username || undefined,
      accessToken,
      apiToken: apiToken || undefined,
      checkinEnabled: tokenType === 'session' ? (body.checkinEnabled ?? true) : false,
      extraConfig,
      isPinned: false,
      sortOrder: getNextAccountSortOrder(),
    }).returning().get();

    if (apiToken) {
      try {
        ensureDefaultTokenForAccount(result.id, apiToken, { name: 'default', source: 'manual' });
      } catch { }
    }

    if (tokenType === 'session' && accessToken) {
      try {
        const syncedTokens = await adapter.getApiTokens(site.url, accessToken, resolvedPlatformUserId);
        if (syncedTokens.length > 0) {
          syncTokensFromUpstream(result.id, syncedTokens);
        }
      } catch { }
    }

    // Try to refresh balance
    if (tokenType === 'session') {
      try { await refreshBalance(result.id); } catch { }
    }
    try {
      await refreshModelsForAccount(result.id);
      rebuildTokenRoutesFromAvailability();
    } catch { }

    const account = db.select().from(schema.accounts).where(eq(schema.accounts.id, result.id)).get();
    const finalCredentialMode = account ? resolveStoredCredentialMode(account) : resolvedCredentialMode;
    const capabilities = account
      ? buildCapabilitiesForAccount(account)
      : buildCapabilitiesFromCredentialMode(finalCredentialMode, tokenType === 'session');
    return {
      ...account,
      tokenType,
      credentialMode: finalCredentialMode,
      capabilities,
      modelCount: verifiedModels.length,
      apiTokenFound: !!apiToken,
      usernameDetected: !!(!body.username && username),
    };
  });

  // Update an account
  app.put<{ Params: { id: string }; Body: any }>('/api/accounts/:id', async (request, reply) => {
    const id = parseInt(request.params.id);
    const body = request.body as Record<string, unknown>;
    const row = db.select()
      .from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(eq(schema.accounts.id, id))
      .get();
    if (!row) {
      return reply.code(404).send({ message: 'account not found' });
    }
    const account = row.accounts;
    const site = row.sites;
    const updates: any = {};
    for (const key of ['username', 'accessToken', 'apiToken', 'status', 'checkinEnabled', 'unitCost', 'extraConfig']) {
      if (body[key] !== undefined) updates[key] = body[key];
    }

    const wantsManagedSub2ApiAuthPatch =
      Object.prototype.hasOwnProperty.call(body, 'refreshToken')
      || Object.prototype.hasOwnProperty.call(body, 'tokenExpiresAt');
    if (wantsManagedSub2ApiAuthPatch && (site.platform || '').toLowerCase() === 'sub2api') {
      const baseExtraConfig = typeof updates.extraConfig === 'string'
        ? updates.extraConfig
        : account.extraConfig;
      const existingManagedAuth = getSub2ApiAuthFromExtraConfig(baseExtraConfig);

      const nextRefreshToken = Object.prototype.hasOwnProperty.call(body, 'refreshToken')
        ? normalizeManagedRefreshToken(body.refreshToken)
        : existingManagedAuth?.refreshToken;
      const nextTokenExpiresAt = Object.prototype.hasOwnProperty.call(body, 'tokenExpiresAt')
        ? normalizeManagedTokenExpiresAt(body.tokenExpiresAt)
        : existingManagedAuth?.tokenExpiresAt;

      updates.extraConfig = mergeAccountExtraConfig(baseExtraConfig, {
        sub2apiAuth: nextRefreshToken
          ? (nextTokenExpiresAt
            ? { refreshToken: nextRefreshToken, tokenExpiresAt: nextTokenExpiresAt }
            : { refreshToken: nextRefreshToken })
          : undefined,
      });
    }

    if (body.isPinned !== undefined) {
      const normalizedPinned = normalizePinnedFlag(body.isPinned);
      if (normalizedPinned === null) {
        return reply.code(400).send({ message: 'Invalid isPinned value. Expected boolean.' });
      }
      updates.isPinned = normalizedPinned;
    }

    if (body.sortOrder !== undefined) {
      const normalizedSortOrder = normalizeSortOrder(body.sortOrder);
      if (normalizedSortOrder === null) {
        return reply.code(400).send({ message: 'Invalid sortOrder value. Expected non-negative integer.' });
      }
      updates.sortOrder = normalizedSortOrder;
    }

    updates.updatedAt = new Date().toISOString();
    db.update(schema.accounts).set(updates).where(eq(schema.accounts.id, id)).run();

    if (typeof updates.apiToken === 'string' && updates.apiToken.trim()) {
      try {
        ensureDefaultTokenForAccount(id, updates.apiToken, { name: 'default', source: 'manual' });
      } catch { }
    }

    try {
      await refreshModelsForAccount(id);
      rebuildTokenRoutesFromAvailability();
    } catch { }

    return db.select().from(schema.accounts).where(eq(schema.accounts.id, id)).get();
  });

  // Delete an account
  app.delete<{ Params: { id: string } }>('/api/accounts/:id', async (request) => {
    const id = parseInt(request.params.id);
    db.delete(schema.accounts).where(eq(schema.accounts.id, id)).run();
    try {
      rebuildTokenRoutesFromAvailability();
    } catch { }
    return { success: true };
  });

  app.post<{ Body?: { accountId?: number; wait?: boolean } }>('/api/accounts/health/refresh', async (request, reply) => {
    const rawAccountId = request.body?.accountId as unknown;
    const hasAccountId = rawAccountId !== undefined && rawAccountId !== null && String(rawAccountId).trim() !== '';
    const accountId = hasAccountId ? Number.parseInt(String(rawAccountId), 10) : undefined;
    const wait = request.body?.wait === true;

    if (hasAccountId && (!Number.isFinite(accountId) || (accountId as number) <= 0)) {
      return reply.code(400).send({ success: false, message: '账号 ID 无效' });
    }

    if (wait) {
      const result = await executeRefreshAccountRuntimeHealth(accountId);
      if (accountId && result.summary.total === 0) {
        return reply.code(404).send({ success: false, message: '账号不存在' });
      }
      return {
        success: true,
        ...result,
      };
    }

    const taskTitle = accountId ? `刷新账号运行健康状态 #${accountId}` : '刷新全部账号运行健康状态';
    const dedupeKey = accountId ? `refresh-account-runtime-health-${accountId}` : 'refresh-all-account-runtime-health';

    const { task, reused } = startBackgroundTask(
      {
        type: 'status',
        title: taskTitle,
        dedupeKey,
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const summary = (currentTask.result as { summary?: ReturnType<typeof summarizeAccountHealthRefresh> })?.summary;
          if (!summary) return `${taskTitle}已完成`;
          return `${taskTitle}完成：健康 ${summary.healthy}，异常 ${summary.unhealthy}，禁用 ${summary.disabled}`;
        },
        failureMessage: (currentTask) => `${taskTitle}失败：${currentTask.error || 'unknown error'}`,
      },
      async () => executeRefreshAccountRuntimeHealth(accountId),
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '账号运行健康状态刷新进行中，请稍后查看账号列表'
        : '已开始刷新账号运行健康状态，请稍后查看账号列表',
    });
  });

  // Refresh balance for an account
  app.post<{ Params: { id: string } }>('/api/accounts/:id/balance', async (request, reply) => {
    const id = parseInt(request.params.id);
    try {
      const result = await refreshBalance(id);
      if (!result) {
        reply.code(404);
        return { message: 'account not found or platform not supported' };
      }
      return result;
    } catch (err: any) {
      reply.code(400);
      return { message: err?.message || 'failed to fetch balance' };
    }
  });
}


