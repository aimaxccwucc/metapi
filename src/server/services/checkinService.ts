import { db, schema } from '../db/index.js';
import { getAdapter } from './platforms/index.js';
import { eq, and } from 'drizzle-orm';
import { sendNotification } from './notifyService.js';
import { isCloudflareChallenge, isTokenExpiredError } from './alertRules.js';
import { reportTokenExpired } from './alertService.js';
import { refreshBalance } from './balanceService.js';
import { parseCheckinRewardAmount } from './checkinRewardParser.js';
import {
  extractCheckinSnapshot,
  getAutoReloginConfig,
  getProxyUrlFromExtraConfig,
  mergeCheckinSnapshot,
  resolvePlatformUserId,
} from './accountExtraConfig.js';
import { decryptAccountPassword } from './accountCredentialService.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { classifyFailureReason, resolveCheckinExecution } from './failureReasonService.js';
import { formatUtcSqlDateTime } from './localTimeService.js';
import { withAccountProxyOverride } from './siteProxy.js';
import {
  getCheckinSiteBackoffDecision,
  recordCheckinSiteResolution,
} from './checkinSiteRuntime.js';
import {
  deriveSiteAutoCheckinPolicyUpdate,
  normalizeSiteAutoCheckinPolicy,
  resolveSiteAutoCheckinSkip,
} from './siteAutoCheckinService.js';

export function isSchedulableCheckinAccountStatus(status?: string | null): boolean {
  return status === 'active' || status === 'expired';
}

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

async function syncSiteAutoCheckinPolicy(
  site: typeof schema.sites.$inferSelect,
  resolution: ReturnType<typeof resolveCheckinExecution>,
  rawSuccess: boolean,
): Promise<void> {
  const nextPolicy = deriveSiteAutoCheckinPolicyUpdate(resolution);
  const currentPolicy = normalizeSiteAutoCheckinPolicy(site.autoCheckinPolicy);
  const now = new Date().toISOString();

  if (nextPolicy) {
    if (currentPolicy === nextPolicy.policy && (site.autoCheckinReason || '') === nextPolicy.reason) {
      return;
    }

    await db.update(schema.sites)
      .set({
        autoCheckinPolicy: nextPolicy.policy,
        autoCheckinReason: nextPolicy.reason,
        autoCheckinUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.sites.id, site.id))
      .run();
    return;
  }

  if (rawSuccess && currentPolicy !== 'normal') {
    await db.update(schema.sites)
      .set({
        autoCheckinPolicy: 'normal',
        autoCheckinReason: null,
        autoCheckinUpdatedAt: now,
        updatedAt: now,
      })
      .where(eq(schema.sites.id, site.id))
      .run();
  }
}

async function persistSkippedCheckin(
  account: typeof schema.accounts.$inferSelect,
  site: typeof schema.sites.$inferSelect,
  resolution: ReturnType<typeof resolveCheckinExecution>,
  options?: { skipEvent?: boolean; scheduleMode?: 'cron' | 'interval' },
) {
  const createdAt = formatUtcSqlDateTime(new Date());
  setAccountRuntimeHealth(account.id, {
    state: resolution.healthState,
    reason: resolution.title,
    source: 'checkin',
  });
  await db.insert(schema.checkinLogs).values({
    accountId: account.id,
    status: resolution.normalizedStatus,
    message: resolution.logMessage,
    createdAt,
  }).run();
  const snapshotNow = new Date().toISOString();
  await db.update(schema.accounts)
    .set({
      extraConfig: mergeCheckinSnapshot(account.extraConfig, {
        version: 1,
        status: resolution.checkinSnapshotStatus,
        reasonCode: resolution.code,
        retryable: resolution.retryable,
        requiresManual: resolution.requiresManual,
        unsupported: resolution.unsupported,
        lastAttemptAt: snapshotNow,
        lastIntervalAttemptAt: options?.scheduleMode === 'interval' ? snapshotNow : null,
        lastSuccessAt: extractCheckinSnapshot(account.extraConfig)?.lastSuccessAt ?? null,
        nextRetryAt: null,
        message: resolution.logMessage,
        reward: null,
        scheduleMode: options?.scheduleMode === 'interval' ? 'interval' : 'cron',
        source: 'checkin',
      }),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(schema.accounts.id, account.id))
    .run();

  if (!options?.skipEvent) {
    await db.insert(schema.events).values({
      type: 'checkin',
      title: 'checkin skipped',
      message: `${account.username || 'ID:' + account.id} @ ${site.name}: ${resolution.logMessage}`,
      level: 'info',
      relatedId: account.id,
      relatedType: 'account',
      createdAt,
    }).run();
  }

  await recordCheckinSiteResolution(site.id, resolution);

  return {
    success: true,
    status: 'skipped' as const,
    skipped: true,
    reason: resolution.code,
    reasonCode: resolution.code,
    checkinSnapshotStatus: resolution.checkinSnapshotStatus,
    message: resolution.logMessage,
  };
}


function shouldAttemptAutoRelogin(input: { message?: string | null; status?: number | null }): boolean {
  const message = input.message;
  if (!message) return false;

  const structured = classifyFailureReason({
    message,
    status: 'failed',
    httpStatus: input.status,
  });
  if (structured.code === 'token_expired' || structured.category === 'auth') return true;
  if (isTokenExpiredError({ status: input.status ?? undefined, message })) return true;

  const text = message.toLowerCase();
  if (text.includes('new-api-user')) return true;
  if (text.includes('access token')) return true;
  return false;
}

function inferRewardFromBalanceDelta(previousBalance: unknown, latestBalance: unknown): number {
  const before = typeof previousBalance === 'number' && Number.isFinite(previousBalance)
    ? previousBalance
    : null;
  const after = typeof latestBalance === 'number' && Number.isFinite(latestBalance)
    ? latestBalance
    : null;
  if (before == null || after == null) return 0;

  const delta = after - before;
  if (!Number.isFinite(delta) || delta <= 0) return 0;
  return Math.round(delta * 1_000_000) / 1_000_000;
}

async function tryAutoRelogin(account: any, site: any): Promise<string | null> {
  const adapter = getAdapter(site.platform);
  if (!adapter) return null;

  const relogin = getAutoReloginConfig(account.extraConfig);
  if (!relogin) return null;

  const password = decryptAccountPassword(relogin.passwordCipher);
  if (!password) return null;

  const result = await withAccountProxyOverride(
    getProxyUrlFromExtraConfig(account.extraConfig),
    () => adapter.login(site.url, relogin.username, password),
  );
  if (!result.success || !result.accessToken) return null;

  await db.update(schema.accounts)
    .set({
      accessToken: result.accessToken,
      updatedAt: new Date().toISOString(),
      status: account.status === 'expired' ? 'active' : account.status,
    })
    .where(eq(schema.accounts.id, account.id))
    .run();

  return result.accessToken;
}

export async function checkinAccount(accountId: number, options?: { skipEvent?: boolean; scheduleMode?: 'cron' | 'interval' }) {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .all();

  if (rows.length === 0) return { success: false, message: 'account not found' };

  const account = rows[0].accounts;
  const site = rows[0].sites;

  if (isSiteDisabled(site.status)) {
    const resolution = resolveCheckinExecution({
      success: false,
      message: 'site disabled',
      status: 'skipped',
      scheduleMode: options?.scheduleMode,
    });
    return await persistSkippedCheckin(account, site, resolution, options);
  }

  const adapter = getAdapter(site.platform);
  if (!adapter) return { success: false, status: 'failed' as const, message: `unsupported platform: ${site.platform}` };

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);

  const accountProxyUrl = getProxyUrlFromExtraConfig(account.extraConfig);
  let activeAccessToken = account.accessToken;
  let result = await withAccountProxyOverride(accountProxyUrl,
    () => adapter.checkin(site.url, activeAccessToken, platformUserId));

  if (!result.success && (account.status === 'expired' || shouldAttemptAutoRelogin({
    message: result.message,
    status: typeof result.status === 'number'
      ? result.status
      : (typeof result.httpStatus === 'number' ? result.httpStatus : null),
  }))) {
    const refreshedAccessToken = await tryAutoRelogin(account, site);
    if (refreshedAccessToken) {
      activeAccessToken = refreshedAccessToken;
      result = await withAccountProxyOverride(accountProxyUrl,
        () => adapter.checkin(site.url, activeAccessToken, platformUserId));
    }
  }

  const resolution = resolveCheckinExecution({
    success: result.success,
    message: result.message,
    status: result.success ? 'success' : 'failed',
    scheduleMode: options?.scheduleMode,
  });
  const effectiveSuccess = resolution.lifecycle !== 'failed';
  const shouldRefreshBalance = resolution.refreshBalance;
  const shouldAdvanceLastCheckinAt = resolution.advanceLastCheckinAt;
  const normalizedStatus = resolution.normalizedStatus;
  let logReward = result.reward;
  let refreshedBalanceInfo: Awaited<ReturnType<typeof refreshBalance>> | null = null;

  if (effectiveSuccess) {
    setAccountRuntimeHealth(account.id, {
      state: resolution.healthState,
      reason: resolution.title,
      source: 'checkin',
    });

    const updates: Record<string, unknown> = {};
    if (shouldAdvanceLastCheckinAt) {
      updates.lastCheckinAt = new Date().toISOString();
    }
    if (account.status === 'expired') {
      updates.status = 'active';
      updates.updatedAt = new Date().toISOString();
    }

    if (shouldRefreshBalance) {
      try {
        refreshedBalanceInfo = await refreshBalance(account.id);
      } catch {}
    }

    const parsedReward = parseCheckinRewardAmount(logReward) || parseCheckinRewardAmount(result.message);
    if (result.success && parsedReward <= 0) {
      const inferredReward = inferRewardFromBalanceDelta(account.balance, refreshedBalanceInfo?.balance);
      if (inferredReward > 0) {
        logReward = inferredReward.toString();
      }
    }

    const lastSuccessAt = resolution.normalizedStatus === 'success'
      ? (shouldAdvanceLastCheckinAt ? new Date().toISOString() : (extractCheckinSnapshot(account.extraConfig)?.lastSuccessAt ?? null))
      : extractCheckinSnapshot(account.extraConfig)?.lastSuccessAt ?? null;
    const snapshotNow = new Date().toISOString();
    updates.extraConfig = mergeCheckinSnapshot(account.extraConfig, {
      version: 1,
      status: resolution.checkinSnapshotStatus,
      reasonCode: resolution.code,
      retryable: resolution.retryable,
      requiresManual: resolution.requiresManual,
      unsupported: resolution.unsupported,
      lastAttemptAt: snapshotNow,
      lastIntervalAttemptAt: options?.scheduleMode === 'interval' ? snapshotNow : null,
      lastSuccessAt,
      nextRetryAt: null,
      message: resolution.logMessage,
      reward: logReward ?? null,
      scheduleMode: options?.scheduleMode === 'interval' ? 'interval' : 'cron',
      source: 'checkin',
    });
    if (Object.keys(updates).length > 0) {
      await db.update(schema.accounts)
        .set(updates)
        .where(eq(schema.accounts.id, accountId))
        .run();
    }
  } else {
    const nextRetryAt = resolution.retryable
      ? new Date(Date.now() + (options?.scheduleMode === 'interval' ? 60 * 60 * 1000 : 30 * 60 * 1000)).toISOString()
      : null;
    const snapshotNow = new Date().toISOString();
    await db.update(schema.accounts)
      .set({
        extraConfig: mergeCheckinSnapshot(account.extraConfig, {
          version: 1,
          status: resolution.checkinSnapshotStatus,
          reasonCode: resolution.code,
          retryable: resolution.retryable,
          requiresManual: resolution.requiresManual,
          unsupported: resolution.unsupported,
          lastAttemptAt: snapshotNow,
          lastIntervalAttemptAt: options?.scheduleMode === 'interval' ? snapshotNow : null,
          lastSuccessAt: extractCheckinSnapshot(account.extraConfig)?.lastSuccessAt ?? null,
          nextRetryAt,
          message: resolution.logMessage,
          reward: null,
          scheduleMode: options?.scheduleMode === 'interval' ? 'interval' : 'cron',
          source: 'checkin',
        }),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(schema.accounts.id, accountId))
      .run();
  }

  const createdAt = formatUtcSqlDateTime(new Date());
  await db.insert(schema.checkinLogs).values({
    accountId: account.id,
    status: normalizedStatus,
    message: resolution.logMessage,
    reward: logReward,
    createdAt,
  }).run();

  if (!options?.skipEvent) {
    await db.insert(schema.events).values({
      type: 'checkin',
      title: effectiveSuccess
        ? (normalizedStatus === 'skipped' ? 'checkin skipped' : 'checkin success')
        : (resolution.requiresManual ? 'checkin failed (manual required)' : 'checkin failed'),
      message: `${account.username || 'ID:' + accountId} @ ${site.name}: ${resolution.logMessage}`,
      level: resolution.eventLevel,
      relatedId: accountId,
      relatedType: 'account',
      createdAt,
    }).run();
  }

  if (!effectiveSuccess) {
    setAccountRuntimeHealth(account.id, {
      state: resolution.healthState,
      reason: resolution.logMessage || '\u7b7e\u5230\u5931\u8d25',
      source: 'checkin',
    });
    if (isTokenExpiredError({ message: result.message })) {
      await reportTokenExpired({
        accountId: account.id,
        username: account.username,
        siteName: site.name,
        detail: result.message,
      });
    }

    if (isCloudflareChallenge(result.message)) {
      await sendNotification(
        'Cloudflare challenge',
        `${account.username || 'ID:' + accountId} @ ${site.name}: ${result.message}`,
        'warning',
      );
    }

    if (!resolution.unsupported && !resolution.requiresManual) {
      await sendNotification(
        'checkin failed',
        `${account.username || 'ID:' + accountId} @ ${site.name}: ${result.message}`,
        'error',
      );
    }
  }

  await recordCheckinSiteResolution(site.id, resolution);
  await syncSiteAutoCheckinPolicy(site, resolution, result.success === true);


  return {
    ...result,
    success: effectiveSuccess,
    status: normalizedStatus,
    reasonCode: resolution.code,
    checkinSnapshotStatus: resolution.checkinSnapshotStatus,
    ...(normalizedStatus === 'skipped' ? { skipped: true } : {}),
  };
}

export async function checkinAll(options?: { accountIds?: number[]; scheduleMode?: 'cron' | 'interval' }) {
  const rows = await db
    .select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.accounts.checkinEnabled, true),
      ),
    )
    .all();

  const scopedAccountIds = options?.accountIds ? new Set(options.accountIds) : null;
  const results: Array<{ accountId: number; username: string | null; site: string; result: any }> = [];

  const grouped = new Map<number, typeof rows>();
  for (const row of rows) {
    if (scopedAccountIds && !scopedAccountIds.has(row.accounts.id)) continue;
    if (!isSchedulableCheckinAccountStatus(row.accounts.status)) continue;
    const siteId = row.sites.id;
    if (!grouped.has(siteId)) grouped.set(siteId, []);
    grouped.get(siteId)!.push(row);
  }

  const promises = Array.from(grouped.entries()).map(async ([siteId, siteRows]) => {
    const siteSkip = resolveSiteAutoCheckinSkip(siteRows[0]?.sites);
    if (siteSkip) {
      for (const row of siteRows) {
        const resolution = resolveCheckinExecution({
          success: false,
          message: siteSkip.message,
          status: 'skipped',
          scheduleMode: options?.scheduleMode,
        });
        const r = await persistSkippedCheckin(row.accounts, row.sites, resolution, {
          skipEvent: true,
          scheduleMode: options?.scheduleMode,
        });
        results.push({
          accountId: row.accounts.id,
          username: row.accounts.username,
          site: row.sites.name,
          result: r,
        });
      }
      return;
    }

    const siteBackoff = await getCheckinSiteBackoffDecision(siteId);
    if (siteBackoff.blocked) {
      for (const row of siteRows) {
        results.push({
          accountId: row.accounts.id,
          username: row.accounts.username,
          site: row.sites.name,
          result: {
            success: true,
            status: 'skipped' as const,
            skipped: true,
            reason: 'site_checkin_backoff_active',
            reasonCode: siteBackoff.lastReasonCode ?? 'site_checkin_backoff_active',
            message: siteBackoff.lastMessage || 'site checkin backoff active',
            blockedUntil: siteBackoff.blockedUntil,
            blockedUntilMs: siteBackoff.blockedUntilMs,
            failureStreak: siteBackoff.failureStreak,
          },
        });
      }
      return;
    }

    for (const row of siteRows) {
      try {
        const r = await checkinAccount(row.accounts.id, {
          skipEvent: true,
          scheduleMode: options?.scheduleMode,
        });
        results.push({
          accountId: row.accounts.id,
          username: row.accounts.username,
          site: row.sites.name,
          result: r,
        });
      } catch (error) {
        const message = error instanceof Error
          ? (error.message || 'unknown error')
          : String(error || 'unknown error');
        console.error(`[Checkin] Account ${row.accounts.id} failed with uncaught error:`, error);
        results.push({
          accountId: row.accounts.id,
          username: row.accounts.username,
          site: row.sites.name,
          result: {
            success: false,
            status: 'failed' as const,
            message,
          },
        });
      }
    }
  });

  await Promise.all(promises);
  return results;
}
