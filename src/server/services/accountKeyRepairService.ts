import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { resolvePlatformUserId } from './accountExtraConfig.js';
import { ensureDefaultTokenForAccount, repairDefaultToken, syncTokensFromUpstream } from './accountTokenService.js';
import { fetchModelPricingCatalog } from './modelPricingService.js';
import { getAdapter } from './platforms/index.js';

export type AccountKeyRepairStatus = 'already_ok' | 'repaired' | 'created' | 'synced' | 'skipped' | 'failed';

export type AccountKeyRepairExecutionResult = {
  accountId: number;
  accountName: string;
  accountStatus: string | null;
  siteId: number;
  siteName: string;
  siteUrlOrigin: string;
  siteStatus: string | null;
  status: AccountKeyRepairStatus;
  reason?: string;
  message?: string;
  synced?: boolean;
  created?: number;
  updated?: number;
  total?: number;
};

export type AccountKeyRepairSummary = {
  total: number;
  eligible: number;
  alreadyOk: number;
  repaired: number;
  created: number;
  synced: number;
  skipped: number;
  failed: number;
};

export type AccountKeyRepairResult = {
  summary: AccountKeyRepairSummary;
  results: AccountKeyRepairExecutionResult[];
};

type AccountWithSiteRow = {
  accounts: typeof schema.accounts.$inferSelect;
  sites: typeof schema.sites.$inferSelect;
};

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

function getOriginKey(siteUrl: string): string {
  try {
    return new URL(siteUrl).origin.toLowerCase();
  } catch {
    return siteUrl.trim().toLowerCase();
  }
}

function buildBaseResult(row: AccountWithSiteRow): Omit<AccountKeyRepairExecutionResult, 'status'> {
  return {
    accountId: row.accounts.id,
    accountName: row.accounts.username || `account-${row.accounts.id}`,
    accountStatus: row.accounts.status,
    siteId: row.sites.id,
    siteName: row.sites.name,
    siteUrlOrigin: getOriginKey(row.sites.url),
    siteStatus: row.sites.status,
  };
}

function normalizeToken(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function summarize(results: AccountKeyRepairExecutionResult[]): AccountKeyRepairSummary {
  return {
    total: results.length,
    eligible: results.filter((item) => item.status !== 'skipped').length,
    alreadyOk: results.filter((item) => item.status === 'already_ok').length,
    repaired: results.filter((item) => item.status === 'repaired').length,
    created: results.filter((item) => item.status === 'created').length,
    synced: results.filter((item) => item.status === 'synced').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    failed: results.filter((item) => item.status === 'failed').length,
  };
}

async function runPerKeySequential<T>(params: {
  items: T[];
  getKey: (item: T) => string;
  worker: (item: T) => Promise<void>;
}) {
  const { items, getKey, worker } = params;
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }

  await Promise.all(
    Array.from(groups.values()).map(async (group) => {
      for (const item of group) {
        await worker(item);
      }
    }),
  );
}

async function resolveLowestRatioGroup(params: {
  site: typeof schema.sites.$inferSelect;
  account: typeof schema.accounts.$inferSelect;
  availableGroups: string[];
}): Promise<string | null> {
  const normalizedGroups = Array.from(new Set(
    params.availableGroups
      .map((group) => String(group || '').trim())
      .filter(Boolean),
  ));
  if (normalizedGroups.length === 0) return null;
  if (normalizedGroups.length === 1) return normalizedGroups[0] || null;

  const availableModelRows = await db.select({
    modelName: schema.modelAvailability.modelName,
  }).from(schema.modelAvailability)
    .where(and(
      eq(schema.modelAvailability.accountId, params.account.id),
      eq(schema.modelAvailability.available, true),
    ))
    .all();

  const candidateModelName = availableModelRows
    .map((row) => String(row.modelName || '').trim())
    .find(Boolean);
  if (!candidateModelName) return normalizedGroups[0] || null;

  const catalog = await fetchModelPricingCatalog({
    site: {
      id: params.site.id,
      url: params.site.url,
      platform: params.site.platform,
      apiKey: params.site.apiKey,
    },
    account: {
      id: params.account.id,
      accessToken: params.account.accessToken,
      apiToken: params.account.apiToken,
    },
    modelName: candidateModelName,
  }).catch(() => null);

  const groupRatio = catalog?.groupRatio || {};
  const modelEntry = catalog?.models.find((item) => item.modelName === candidateModelName)
    || catalog?.models.find((item) => normalizedGroups.some((group) => item.enableGroups.includes(group)));

  const allowedGroups = new Set(modelEntry?.enableGroups || normalizedGroups);
  const rankedGroups = normalizedGroups
    .filter((group) => allowedGroups.has(group))
    .map((group) => ({
      group,
      ratio: typeof groupRatio[group] === 'number' && Number.isFinite(groupRatio[group]) ? groupRatio[group] : Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.ratio - right.ratio || left.group.localeCompare(right.group));

  const preferred = rankedGroups.find((item) => Number.isFinite(item.ratio));
  return preferred?.group || normalizedGroups[0] || null;
}

export async function repairAccountKeysForAccount(accountId: number): Promise<AccountKeyRepairExecutionResult | null> {
  const row = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get() as AccountWithSiteRow | undefined;

  if (!row) return null;
  return await repairSingleAccount(row);
}

async function repairSingleAccount(row: AccountWithSiteRow): Promise<AccountKeyRepairExecutionResult> {
  const base = buildBaseResult(row);
  const account = row.accounts;
  const site = row.sites;

  if (isSiteDisabled(site.status)) {
    return {
      ...base,
      status: 'skipped',
      reason: 'site_disabled',
      message: 'site disabled',
    };
  }

  if ((account.status || 'active') === 'disabled') {
    return {
      ...base,
      status: 'skipped',
      reason: 'account_disabled',
      message: 'account disabled',
    };
  }

  const localTokens = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, account.id))
    .all();
  const enabledTokens = localTokens.filter((token) => token.enabled);

  if (enabledTokens.length > 0) {
    const localDefault = enabledTokens.find((token) => token.isDefault) || enabledTokens[0];
    const accountApiToken = normalizeToken(account.apiToken);
    const changed = !enabledTokens.some((token) => token.isDefault) || (accountApiToken !== localDefault.token);
    if (changed) {
      await repairDefaultToken(account.id);
      return {
        ...base,
        status: 'repaired',
        message: 'default token repaired',
      };
    }
    return {
      ...base,
      status: 'already_ok',
      message: 'already has default token',
    };
  }

  const fallbackApiToken = normalizeToken(account.apiToken);
  if (fallbackApiToken) {
    await ensureDefaultTokenForAccount(account.id, fallbackApiToken, {
      name: 'default',
      source: 'legacy',
      enabled: true,
      tokenGroup: 'default',
    });
    return {
      ...base,
      status: 'created',
      message: 'created default token from account.apiToken',
    };
  }

  const accessToken = normalizeToken(account.accessToken);
  if (!accessToken) {
    return {
      ...base,
      status: 'skipped',
      reason: 'missing_access_token',
      message: 'missing access token',
    };
  }

  const adapter = getAdapter(site.platform);
  if (!adapter) {
    return {
      ...base,
      status: 'skipped',
      reason: 'unsupported_platform',
      message: `unsupported platform: ${site.platform}`,
    };
  }

  try {
    const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
    let upstreamTokens = await adapter.getApiTokens(site.url, accessToken, platformUserId);
    if (upstreamTokens.length === 0) {
      const single = await adapter.getApiToken(site.url, accessToken, platformUserId);
      if (single) {
        upstreamTokens = [{ name: 'default', key: single, enabled: true, tokenGroup: 'default' }];
      }
    }

    if (upstreamTokens.length === 0) {
      const availableGroups = await adapter.getUserGroups(site.url, accessToken, platformUserId).catch(() => ['default']);
      const fallbackGroup = await resolveLowestRatioGroup({
        site,
        account,
        availableGroups,
      }) || 'default';
      const created = await adapter.createApiToken(site.url, accessToken, platformUserId, {
        name: 'metapi-default',
        group: fallbackGroup,
      });
      if (!created) {
        return {
          ...base,
          status: 'failed',
          reason: 'create_upstream_token_failed',
          message: 'upstream create token failed',
        };
      }

      upstreamTokens = await adapter.getApiTokens(site.url, accessToken, platformUserId);
      if (upstreamTokens.length === 0) {
        const createdToken = await adapter.getApiToken(site.url, accessToken, platformUserId);
        if (createdToken) {
          upstreamTokens = [{ name: 'default', key: createdToken, enabled: true, tokenGroup: 'default' }];
        }
      }
    }

    if (upstreamTokens.length === 0) {
      return {
        ...base,
        status: 'failed',
        reason: 'upstream_token_not_found_after_create',
        message: 'upstream token not found after create',
      };
    }

    const synced = await syncTokensFromUpstream(account.id, upstreamTokens);
    return {
      ...base,
      status: 'synced',
      synced: true,
      ...synced,
      message: `synced ${synced.total} token(s)`,
    };
  } catch (error: any) {
    return {
      ...base,
      status: 'failed',
      reason: 'repair_error',
      message: error?.message || 'repair failed',
    };
  }
}

export async function repairAllAccountKeys(): Promise<AccountKeyRepairResult> {
  const rows = await db.select()
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all() as AccountWithSiteRow[];

  const results: AccountKeyRepairExecutionResult[] = [];

  await runPerKeySequential<AccountWithSiteRow>({
    items: rows,
    getKey: (row) => getOriginKey(row.sites.url),
    worker: async (row) => {
      const result = await repairSingleAccount(row);
      results.push(result);
    },
  });

  return {
    summary: summarize(results),
    results,
  };
}
