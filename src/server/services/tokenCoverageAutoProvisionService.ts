import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  isMaskedPendingAccountToken,
  getPreferredAccountToken,
  isUsableAccountToken,
  syncTokensFromUpstream,
} from './accountTokenService.js';
import {
  getProxyUrlFromExtraConfig,
  requiresManagedAccountTokens,
  resolvePlatformUserId,
} from './accountExtraConfig.js';
import { startBackgroundTask } from './backgroundTaskService.js';
import { fetchModelPricingCatalog } from './modelPricingService.js';
import { getAdapter } from './platforms/index.js';
import { withAccountProxyOverride } from './siteProxy.js';
import { matchesModelPattern } from './tokenRouter.js';

const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const MAX_AUTOPROVISION_TARGETS = 500;
const HISTORICAL_RECONCILE_CONCURRENCY = 4;
const AUTO_PROVISION_TASK_TYPE = 'token';
const AUTO_PROVISION_TASK_TITLE = '自动补齐模型覆盖 Key';

type AccountRow = typeof schema.accounts.$inferSelect;
type SiteRow = typeof schema.sites.$inferSelect;
type TokenRow = typeof schema.accountTokens.$inferSelect;
type AutoprovisionStateRow = typeof schema.tokenCoverageAutoprovisionStates.$inferSelect;
type TokenRouteRow = typeof schema.tokenRoutes.$inferSelect;
type RouteGroupSourceRow = typeof schema.routeGroupSources.$inferSelect;
type EligibleAvailableRow = {
  accountId: number;
  siteId: number;
  username: string | null;
  accessToken: string;
  apiToken: string | null;
  extraConfig: string | null;
  accountStatus: string | null;
  siteStatus: string | null;
  modelName: string;
};
type CoverageRow = {
  accountId: number;
  tokenName: string;
  tokenGroup: string | null;
  modelName: string;
};
type AccountJoinRow = {
  accounts: AccountRow;
  sites: SiteRow;
};
type GroupCoverageRow = {
  availableModelName: string;
  tokenGroup: string | null;
  tokenName: string;
};
type AccountModelRow = {
  accountId: number;
  modelName: string;
  isManual: boolean | null;
};

export type TokenCoverageProvisionMode = 'shared_group' | 'scoped_model';
export type TokenCoverageProvisionScanMode = 'exact_routes' | 'missing_coverage' | 'specific_models' | 'mixed';
export type TokenCoverageProvisionStatus =
  | 'created'
  | 'reused'
  | 'skipped'
  | 'cooldown'
  | 'failed';

export type TokenCoverageProvisionTarget = {
  accountId: number;
  siteId: number;
  modelName: string;
  reason: 'exact_route' | 'group_route_source' | 'missing_token' | 'missing_group' | 'specific_model';
  routeId?: number | null;
  groupRouteId?: number | null;
  requiredGroups?: string[];
};

export type TokenCoverageProvisionItemResult = {
  accountId: number;
  siteId: number;
  modelName: string;
  targetGroup: string;
  status: TokenCoverageProvisionStatus;
  reason: string;
  message?: string;
  createdTokenName?: string | null;
  createdTokenGroup?: string | null;
  createdTokenId?: number | null;
  routeId?: number | null;
  groupRouteId?: number | null;
};

export type TokenCoverageProvisionSummary = {
  total: number;
  created: number;
  reused: number;
  skipped: number;
  cooldown: number;
  failed: number;
};

export type TokenCoverageProvisionResult = {
  mode: TokenCoverageProvisionScanMode;
  provisionMode: TokenCoverageProvisionMode;
  summary: TokenCoverageProvisionSummary;
  results: TokenCoverageProvisionItemResult[];
};

export type TokenCoverageProvisionScope = {
  accountIds?: number[];
  siteIds?: number[];
  routeIds?: number[];
  modelNames?: string[];
};

function hasExplicitProvisionTargets(scope: TokenCoverageProvisionScope): boolean {
  return dedupeIds(scope.routeIds).length > 0 || dedupeModels(scope.modelNames).length > 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeText(value: unknown): string {
  return String(value || '').trim();
}

function normalizeLower(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function canonicalModelAlias(modelName: string): string {
  const normalized = normalizeLower(modelName);
  if (!normalized) return '';
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex >= 0 && slashIndex < normalized.length - 1) {
    return normalized.slice(slashIndex + 1);
  }
  return normalized;
}

function isModelAliasEquivalent(left: string, right: string): boolean {
  const a = canonicalModelAlias(left);
  const b = canonicalModelAlias(right);
  return !!a && !!b && a === b;
}

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = normalizeText(modelPattern);
  if (!normalized) return false;
  return !/[*?[\]()|^$+]/.test(normalized) && !normalized.startsWith('re:');
}

function resolveTokenGroupLabel(tokenGroup: string | null, tokenName: string | null): string | null {
  const explicit = normalizeText(tokenGroup);
  if (explicit) return explicit;

  const name = normalizeText(tokenName);
  if (!name) return null;
  const normalized = name.toLowerCase();
  if (normalized === 'default' || normalized === '默认' || /^default($|[-_\s])/.test(normalized)) {
    return 'default';
  }
  if (/^token-\d+$/.test(normalized)) return null;
  return name;
}

function isAutoManagedTokenName(tokenName: string | null | undefined): boolean {
  return /^metapi-/i.test(normalizeText(tokenName));
}

function buildAutoTokenName(groupName: string): string {
  const normalizedGroup = normalizeText(groupName) || 'default';
  return `metapi-${normalizedGroup}-shared`.slice(0, 64);
}

function buildScopedAutoTokenName(modelName: string, groupName: string): string {
  const normalizedGroup = normalizeText(groupName) || 'default';
  const normalizedModel = normalizeText(modelName)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'model';
  return `metapi-${normalizedGroup}-${normalizedModel}`.slice(0, 64);
}

function buildSummary(results: TokenCoverageProvisionItemResult[]): TokenCoverageProvisionSummary {
  return {
    total: results.length,
    created: results.filter((item) => item.status === 'created').length,
    reused: results.filter((item) => item.status === 'reused').length,
    skipped: results.filter((item) => item.status === 'skipped').length,
    cooldown: results.filter((item) => item.status === 'cooldown').length,
    failed: results.filter((item) => item.status === 'failed').length,
  };
}

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'unknown error';
}

function dedupeIds(ids?: number[]): number[] {
  return Array.from(new Set((ids || []).filter((value) => Number.isFinite(value) && value > 0).map((value) => Math.trunc(value))));
}

function dedupeModels(models?: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of models || []) {
    const modelName = normalizeText(raw);
    if (!modelName) continue;
    const key = modelName.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(modelName);
  }
  return result;
}

function chooseScanMode(scope: TokenCoverageProvisionScope): TokenCoverageProvisionScanMode {
  if (scope.routeIds?.length) return 'exact_routes';
  if (scope.modelNames?.length) return 'specific_models';
  if (scope.accountIds?.length || scope.siteIds?.length) return 'missing_coverage';
  return 'mixed';
}

function selectPreferredTokenGroupForModel(
  modelName: string,
  availableGroups: string[],
  catalog: Awaited<ReturnType<typeof fetchModelPricingCatalog>>,
  requiredGroups?: string[],
): string {
  const normalizedGroups = Array.from(new Set(
    availableGroups.map((group) => normalizeText(group)).filter(Boolean),
  ));
  if (normalizedGroups.length === 0) return 'default';
  if (normalizedGroups.length === 1) return normalizedGroups[0] || 'default';

  const requiredGroupSet = new Set((requiredGroups || []).map((group) => normalizeLower(group)).filter(Boolean));
  const groupRatio = catalog?.groupRatio || {};
  const modelEntry = catalog?.models.find((item) => item.modelName === modelName)
    || catalog?.models.find((item) => isModelAliasEquivalent(item.modelName, modelName))
    || catalog?.models.find((item) => normalizedGroups.some((group) => item.enableGroups.includes(group)));
  const allowedGroups = new Set(
    (modelEntry?.enableGroups || normalizedGroups)
      .map((group) => normalizeText(group))
      .filter(Boolean),
  );

  const rankedGroups = normalizedGroups
    .filter((group) => {
      if (requiredGroupSet.size > 0 && !requiredGroupSet.has(group.toLowerCase())) return false;
      return allowedGroups.has(group);
    })
    .map((group) => ({
      group,
      ratio: typeof groupRatio[group] === 'number' && Number.isFinite(groupRatio[group])
        ? groupRatio[group]
        : Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.ratio - right.ratio || left.group.localeCompare(right.group));

  const preferred = rankedGroups.find((item) => Number.isFinite(item.ratio));
  return preferred?.group || rankedGroups[0]?.group || normalizedGroups[0] || 'default';
}

async function listProvisionCandidateTargets(scope: TokenCoverageProvisionScope): Promise<{
  mode: TokenCoverageProvisionScanMode;
  targets: TokenCoverageProvisionTarget[];
}> {
  const routeIds = dedupeIds(scope.routeIds);
  const accountIds = dedupeIds(scope.accountIds);
  const siteIds = dedupeIds(scope.siteIds);
  const modelNames = dedupeModels(scope.modelNames);
  const mode = chooseScanMode({ routeIds, accountIds, siteIds, modelNames });
  const targets = new Map<string, TokenCoverageProvisionTarget>();

  const addTarget = (target: TokenCoverageProvisionTarget) => {
    const modelName = normalizeText(target.modelName);
    if (!modelName) return;
    const key = `${target.accountId}::${modelName.toLowerCase()}::${(target.requiredGroups || []).map((item) => item.toLowerCase()).sort().join(',')}`;
    if (targets.has(key)) return;
    targets.set(key, {
      ...target,
      modelName,
      requiredGroups: dedupeModels(target.requiredGroups),
    });
  };

  const eligibleRows: EligibleAvailableRow[] = await db.select({
    accountId: schema.accounts.id,
    siteId: schema.sites.id,
    username: schema.accounts.username,
    accessToken: schema.accounts.accessToken,
    apiToken: schema.accounts.apiToken,
    extraConfig: schema.accounts.extraConfig,
    accountStatus: schema.accounts.status,
    siteStatus: schema.sites.status,
    modelName: schema.modelAvailability.modelName,
  })
    .from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.modelAvailability.available, true))
    .all();

  const availableRows = eligibleRows.filter((row: EligibleAvailableRow) => {
    if ((row.accountStatus || 'active') !== 'active') return false;
    if ((row.siteStatus || 'active') !== 'active') return false;
    if (!requiresManagedAccountTokens(row)) return false;
    if (accountIds.length > 0 && !accountIds.includes(row.accountId)) return false;
    if (siteIds.length > 0 && !siteIds.includes(row.siteId)) return false;
    if (modelNames.length > 0 && !modelNames.some((item) => item === row.modelName || isModelAliasEquivalent(item, row.modelName))) {
      return false;
    }
    return true;
  });

  if (routeIds.length > 0) {
    const routes: TokenRouteRow[] = await db.select().from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, routeIds))
      .all();
    const routeMap = new Map<number, TokenRouteRow>(routes.map((route: TokenRouteRow) => [route.id, route]));

    const groupLinks: RouteGroupSourceRow[] = await db.select().from(schema.routeGroupSources)
      .where(inArray(schema.routeGroupSources.groupRouteId, routeIds))
      .all();
    const sourceRouteIds = Array.from(new Set(groupLinks.map((item: RouteGroupSourceRow) => item.sourceRouteId)));
    const sourceRoutes: TokenRouteRow[] = sourceRouteIds.length > 0
      ? await db.select().from(schema.tokenRoutes)
        .where(inArray(schema.tokenRoutes.id, sourceRouteIds))
        .all()
      : [];
    const sourceRouteMap = new Map<number, TokenRouteRow>(sourceRoutes.map((route: TokenRouteRow) => [route.id, route]));

    for (const routeId of routeIds) {
      const route = routeMap.get(routeId);
      if (!route || !route.enabled) continue;
      if (route.routeMode === 'explicit_group') {
        const links = groupLinks.filter((item: RouteGroupSourceRow) => item.groupRouteId === routeId);
        for (const link of links) {
          const sourceRoute = sourceRouteMap.get(link.sourceRouteId);
          if (!sourceRoute || !isExactModelPattern(sourceRoute.modelPattern)) continue;
          const modelName = normalizeText(sourceRoute.modelPattern);
          for (const row of availableRows) {
            if (row.modelName !== modelName && !isModelAliasEquivalent(row.modelName, modelName)) continue;
            addTarget({
              accountId: row.accountId,
              siteId: row.siteId,
              modelName,
              reason: 'group_route_source',
              routeId: sourceRoute.id,
              groupRouteId: route.id,
            });
          }
        }
        continue;
      }

      if (!isExactModelPattern(route.modelPattern)) continue;
      const modelName = normalizeText(route.modelPattern);
      for (const row of availableRows) {
        if (row.modelName !== modelName && !isModelAliasEquivalent(row.modelName, modelName)) continue;
        addTarget({
          accountId: row.accountId,
          siteId: row.siteId,
          modelName,
          reason: 'exact_route',
          routeId: route.id,
        });
      }
    }
  }

  if (routeIds.length === 0 || accountIds.length > 0 || siteIds.length > 0 || modelNames.length > 0) {
    const coverageRows: CoverageRow[] = await db.select({
      accountId: schema.accountTokens.accountId,
      tokenName: schema.accountTokens.name,
      tokenGroup: schema.accountTokens.tokenGroup,
      modelName: schema.tokenModelAvailability.modelName,
    })
      .from(schema.tokenModelAvailability)
      .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .where(and(
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      ))
      .all();

    const covered = new Set<string>();
    const coveredGroups = new Map<string, Set<string>>();
    for (const row of coverageRows as CoverageRow[]) {
      const modelName = normalizeText(row.modelName);
      if (!modelName) continue;
      const key = `${row.accountId}::${modelName.toLowerCase()}`;
      covered.add(key);
      const groupLabel = resolveTokenGroupLabel(row.tokenGroup, row.tokenName);
      if (!groupLabel) continue;
      if (!coveredGroups.has(key)) coveredGroups.set(key, new Set());
      coveredGroups.get(key)!.add(groupLabel.toLowerCase());
    }

    const accountRows = Array.from(
      new Map<string, EligibleAvailableRow>(availableRows.map((row: EligibleAvailableRow) => [`${row.accountId}::${row.modelName.toLowerCase()}`, row])).values(),
    );
    const accountJoins = accountRows.length > 0
      ? await db.select().from(schema.accounts)
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .where(inArray(schema.accounts.id, Array.from(new Set(accountRows.map((row: EligibleAvailableRow) => row.accountId)))))
        .all()
      : [];

    const metadataResults = await Promise.all(
      (accountJoins as AccountJoinRow[]).map(async (row: AccountJoinRow) => {
        try {
          const catalog = await fetchModelPricingCatalog({
            site: {
              id: row.sites.id,
              url: row.sites.url,
              platform: row.sites.platform,
              apiKey: row.sites.apiKey,
            },
            account: {
              id: row.accounts.id,
              accessToken: row.accounts.accessToken,
              apiToken: row.accounts.apiToken,
            },
            modelName: '__metadata__',
            totalTokens: 0,
          });
          return { accountId: row.accounts.id, catalog };
        } catch {
          return { accountId: row.accounts.id, catalog: null as Awaited<ReturnType<typeof fetchModelPricingCatalog>> };
        }
      }),
    );
    const requiredGroupsByAccountModel = new Map<string, string[]>();
    for (const result of metadataResults) {
      if (!result.catalog) continue;
      for (const model of result.catalog.models) {
        const modelName = normalizeText(model.modelName);
        if (!modelName || !Array.isArray(model.enableGroups) || model.enableGroups.length === 0) continue;
        requiredGroupsByAccountModel.set(
          `${result.accountId}::${modelName.toLowerCase()}`,
          Array.from(new Set(model.enableGroups.map((group: string) => normalizeText(group)).filter(Boolean))),
        );
      }
    }

    for (const row of accountRows) {
      const modelName = normalizeText(row.modelName);
      if (!modelName) continue;
      const key = `${row.accountId}::${modelName.toLowerCase()}`;
      if (!covered.has(key)) {
        addTarget({
          accountId: row.accountId,
          siteId: row.siteId,
          modelName,
          reason: 'missing_token',
        });
        continue;
      }

      const requiredGroups = requiredGroupsByAccountModel.get(key) || [];
      if (requiredGroups.length === 0) continue;
      const existingGroups = coveredGroups.get(key) || new Set<string>();
      if (existingGroups.size > 0) continue;
    }

    for (const modelName of modelNames) {
      for (const row of availableRows as EligibleAvailableRow[]) {
        if (row.modelName !== modelName && !isModelAliasEquivalent(row.modelName, modelName)) continue;
        addTarget({
          accountId: row.accountId,
          siteId: row.siteId,
          modelName,
          reason: 'specific_model',
        });
      }
    }

  }

  return {
    mode,
    targets: Array.from(targets.values()).slice(0, MAX_AUTOPROVISION_TARGETS),
  };
}

async function findReusableTokenByGroup(accountId: number, targetGroup: string): Promise<TokenRow | null> {
  const tokens = await db.select().from(schema.accountTokens)
    .where(and(
      eq(schema.accountTokens.accountId, accountId),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
    ))
    .all();
  const targetGroupKey = normalizeLower(targetGroup) || 'default';
  return tokens.find((token: TokenRow) => {
    if (!isUsableAccountToken(token)) return false;
    const groupLabel = resolveTokenGroupLabel(token.tokenGroup, token.name);
    return (normalizeLower(groupLabel) || 'default') === targetGroupKey;
  }) || null;
}

async function findProvisionedUsableToken(
  accountId: number,
  targetGroup: string,
  tokenName: string,
): Promise<TokenRow | null> {
  const tokens = await db.select().from(schema.accountTokens)
    .where(and(
      eq(schema.accountTokens.accountId, accountId),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
    ))
    .all();

  const targetGroupKey = normalizeLower(targetGroup) || 'default';
  const normalizedTokenName = normalizeText(tokenName);

  return tokens.find((token: TokenRow) => {
    if (!isUsableAccountToken(token)) return false;
    if (normalizeText(token.name) !== normalizedTokenName) return false;
    const groupLabel = resolveTokenGroupLabel(token.tokenGroup, token.name);
    return (normalizeLower(groupLabel) || 'default') === targetGroupKey;
  }) || null;
}

async function cleanupAutoManagedTokensForAccount(
  accountId: number,
  expectedGroups: Set<string>,
): Promise<void> {
  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();
  if (!row) return;

  const account = row.accounts;
  const site = row.sites;
  const adapter = getAdapter(site.platform);
  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  const accountProxyUrl = getProxyUrlFromExtraConfig(account.extraConfig);

  const tokens = await db.select().from(schema.accountTokens)
    .where(and(
      eq(schema.accountTokens.accountId, accountId),
      inArray(schema.accountTokens.valueStatus, [ACCOUNT_TOKEN_VALUE_STATUS_READY, 'masked_pending']),
    ))
    .all();

  const autoTokens = tokens.filter((token) => (
    (isUsableAccountToken(token) || isMaskedPendingAccountToken(token)) && isAutoManagedTokenName(token.name)
  ));

  const grouped = new Map<string, TokenRow[]>();
  for (const token of autoTokens) {
    const groupKey = normalizeLower(resolveTokenGroupLabel(token.tokenGroup, token.name)) || 'default';
    const list = grouped.get(groupKey) || [];
    list.push(token);
    grouped.set(groupKey, list);
  }

  const deleteToken = async (token: TokenRow) => {
    if (
      adapter
      && !isMaskedPendingAccountToken(token)
      && normalizeText(account.accessToken)
    ) {
      const deleted = await withAccountProxyOverride(
        accountProxyUrl,
        () => adapter.deleteApiToken(site.url, account.accessToken, token.token, platformUserId),
      ).catch(() => false);
      if (!deleted) return;
    }
    await db.delete(schema.accountTokens).where(eq(schema.accountTokens.id, token.id)).run();
  };

  for (const [groupKey, groupTokens] of grouped.entries()) {
    const sorted = [...groupTokens].sort((left, right) => {
      const leftShared = /-shared$/i.test(normalizeText(left.name)) ? 1 : 0;
      const rightShared = /-shared$/i.test(normalizeText(right.name)) ? 1 : 0;
      return rightShared - leftShared || right.id - left.id;
    });

    if (!expectedGroups.has(groupKey)) {
      for (const token of sorted) {
        await deleteToken(token);
      }
      continue;
    }

    for (const token of sorted.slice(1)) {
      await deleteToken(token);
    }
  }
}

async function deletePendingAutoManagedTokensForAccount(
  accountId: number,
  tokenIds: number[],
): Promise<void> {
  const normalizedIds = Array.from(new Set(
    tokenIds.filter((value) => Number.isFinite(value) && value > 0).map((value) => Math.trunc(value)),
  ));
  if (normalizedIds.length === 0) return;

  const rows = await db.select().from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();
  const targets = rows.filter((row) => (
    normalizedIds.includes(row.id)
    && isMaskedPendingAccountToken(row)
    && isAutoManagedTokenName(row.name)
  ));
  for (const token of targets) {
    await db.delete(schema.accountTokens)
      .where(eq(schema.accountTokens.id, token.id))
      .run();
  }
}

async function listActiveExplicitTargetModelsByAccount(accountIds: number[]): Promise<Map<number, string[]>> {
  const normalizedAccountIds = dedupeIds(accountIds);
  const result = new Map<number, string[]>();
  if (normalizedAccountIds.length === 0) return result;

  const exactRoutePatterns = (await db.select({
    modelPattern: schema.tokenRoutes.modelPattern,
  })
    .from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.enabled, true))
    .all())
    .map((row) => normalizeText(row.modelPattern))
    .filter((modelPattern) => isExactModelPattern(modelPattern));

  const availableRows: AccountModelRow[] = await db.select({
    accountId: schema.modelAvailability.accountId,
    modelName: schema.modelAvailability.modelName,
    isManual: schema.modelAvailability.isManual,
  })
    .from(schema.modelAvailability)
    .where(and(
      inArray(schema.modelAvailability.accountId, normalizedAccountIds),
      eq(schema.modelAvailability.available, true),
    ))
    .all();

  for (const row of availableRows) {
    const modelName = normalizeText(row.modelName);
    if (!modelName) continue;
    const isExplicitTarget = !!row.isManual || exactRoutePatterns.some((pattern) => (
      pattern === modelName || isModelAliasEquivalent(pattern, modelName)
    ));
    if (!isExplicitTarget) continue;
    const existing = result.get(row.accountId) || [];
    if (!existing.some((item) => item === modelName || isModelAliasEquivalent(item, modelName))) {
      existing.push(modelName);
      result.set(row.accountId, existing);
    }
  }

  return result;
}

async function resolveExpectedSharedGroupsForAccounts(accountIds: number[]): Promise<Map<number, Set<string>>> {
  const normalizedAccountIds = dedupeIds(accountIds);
  const groupsByAccount = new Map<number, Set<string>>();
  if (normalizedAccountIds.length === 0) return groupsByAccount;

  const explicitModelsByAccount = await listActiveExplicitTargetModelsByAccount(normalizedAccountIds);
  const accountRows = normalizedAccountIds.length > 0
    ? await db.select().from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(inArray(schema.accounts.id, normalizedAccountIds))
      .all()
    : [];

  for (const row of accountRows as AccountJoinRow[]) {
    const models = explicitModelsByAccount.get(row.accounts.id) || [];
    if (models.length === 0) continue;
    if ((row.accounts.status || 'active') !== 'active' || (row.sites.status || 'active') !== 'active') continue;
    if (!requiresManagedAccountTokens(row.accounts)) continue;

    const adapter = getAdapter(row.sites.platform);
    if (!adapter) continue;

    const platformUserId = resolvePlatformUserId(row.accounts.extraConfig, row.accounts.username);
    const availableGroups = await adapter.getUserGroups(row.sites.url, row.accounts.accessToken, platformUserId).catch(() => ['default']);
    const pricingCatalog = await fetchModelPricingCatalog({
      site: {
        id: row.sites.id,
        url: row.sites.url,
        platform: row.sites.platform,
        apiKey: row.sites.apiKey,
      },
      account: {
        id: row.accounts.id,
        accessToken: row.accounts.accessToken,
        apiToken: row.accounts.apiToken,
      },
      modelName: '__metadata__',
      totalTokens: 0,
    }).catch(() => null);

    const expectedGroups = new Set<string>();
    for (const modelName of models) {
      expectedGroups.add(normalizeLower(selectPreferredTokenGroupForModel(
        modelName,
        availableGroups,
        pricingCatalog,
      )) || 'default');
    }
    groupsByAccount.set(row.accounts.id, expectedGroups);
  }

  return groupsByAccount;
}

async function listManagedAccountIds(): Promise<number[]> {
  const rows = await db.select({
    id: schema.accounts.id,
    username: schema.accounts.username,
    accessToken: schema.accounts.accessToken,
    apiToken: schema.accounts.apiToken,
    extraConfig: schema.accounts.extraConfig,
    accountStatus: schema.accounts.status,
    siteStatus: schema.sites.status,
  })
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .all();

  return rows
    .filter((row) => (
      (row.accountStatus || 'active') === 'active'
      && (row.siteStatus || 'active') === 'active'
      && requiresManagedAccountTokens({
        accessToken: row.accessToken,
        apiToken: row.apiToken,
        extraConfig: row.extraConfig,
      })
    ))
    .map((row) => row.id);
}

export async function reconcileHistoricalSharedGroupAutoTokens(): Promise<{
  accountsScanned: number;
  accountsWithExplicitTargets: number;
  accountsWithoutExplicitTargets: number;
  provisionSummary: TokenCoverageProvisionSummary;
}> {
  const accountIds = await listManagedAccountIds();
  const explicitModelsByAccount = await listActiveExplicitTargetModelsByAccount(accountIds);
  const explicitAccountIds = Array.from(explicitModelsByAccount.keys());

  const provisionResults: TokenCoverageProvisionItemResult[] = [];
  const accountsNeedingRouteRefresh = new Set<number>();

  for (let index = 0; index < explicitAccountIds.length; index += HISTORICAL_RECONCILE_CONCURRENCY) {
    const batchAccountIds = explicitAccountIds.slice(index, index + HISTORICAL_RECONCILE_CONCURRENCY);
    const batchResults = await Promise.all(
      batchAccountIds.map(async (accountId) => {
        const modelNames = explicitModelsByAccount.get(accountId) || [];
        if (modelNames.length === 0) return null;
        const result = await autoProvisionTokenCoverage({
          accountIds: [accountId],
          modelNames,
        }, {
          provisionMode: 'shared_group',
          refreshRouteChannels: false,
        });
        if (result.results.some((item) => item.status === 'created' || item.status === 'reused')) {
          accountsNeedingRouteRefresh.add(accountId);
        }
        return result;
      }),
    );

    for (const result of batchResults) {
      if (!result) continue;
      provisionResults.push(...result.results);
    }
  }

  const explicitAccountIdSet = new Set(explicitAccountIds);
  for (const accountId of accountIds) {
    if (explicitAccountIdSet.has(accountId)) continue;
    await cleanupAutoManagedTokensForAccount(accountId, new Set()).catch(() => undefined);
    accountsNeedingRouteRefresh.add(accountId);
  }

  if (accountsNeedingRouteRefresh.size > 0) {
    await rebuildTokenRoutesFromAvailabilityScopedDeferred({
      accountIds: Array.from(accountsNeedingRouteRefresh),
    }).catch(() => undefined);
  }

  return {
    accountsScanned: accountIds.length,
    accountsWithExplicitTargets: explicitAccountIds.length,
    accountsWithoutExplicitTargets: Math.max(0, accountIds.length - explicitAccountIds.length),
    provisionSummary: buildSummary(provisionResults),
  };
}

async function findReusableSharedTokenForModel(accountId: number, modelName: string): Promise<{
  token: TokenRow;
  groupLabel: string | null;
} | null> {
  const rows = await db.select({
    token: schema.accountTokens,
    availableModelName: schema.tokenModelAvailability.modelName,
  })
    .from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .where(and(
      eq(schema.accountTokens.accountId, accountId),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      eq(schema.tokenModelAvailability.available, true),
    ))
    .all();

  for (const row of rows) {
    const token = row.token;
    if (!isUsableAccountToken(token)) continue;
    const tokenName = normalizeText(token.name);
    if (!/^metapi-.+-shared$/i.test(tokenName)) continue;
    const availableModel = normalizeText(row.availableModelName);
    if (!availableModel) continue;
    if (availableModel !== modelName && !isModelAliasEquivalent(availableModel, modelName)) continue;
    return {
      token,
      groupLabel: resolveTokenGroupLabel(token.tokenGroup, token.name),
    };
  }
  return null;
}

async function findReusableSharedTokenForModelInGroup(
  accountId: number,
  modelName: string,
  targetGroup: string,
): Promise<{
  token: TokenRow;
  groupLabel: string | null;
} | null> {
  const reusable = await findReusableSharedTokenForModel(accountId, modelName);
  if (!reusable) return null;
  const reusableGroup = normalizeLower(reusable.groupLabel) || 'default';
  const expectedGroup = normalizeLower(targetGroup) || 'default';
  if (reusableGroup !== expectedGroup) return null;
  return reusable;
}

async function refreshModelsForAccountDeferred(accountId: number) {
  const modelService = await import('./modelService.js');
  return await modelService.refreshModelsForAccount(accountId);
}

async function rebuildTokenRoutesFromAvailabilityScopedDeferred(scope: {
  accountIds?: number[];
  siteIds?: number[];
}) {
  const modelService = await import('./modelService.js');
  return await modelService.rebuildTokenRoutesFromAvailabilityScoped(scope);
}

async function hasCoverageInGroup(accountId: number, modelName: string, targetGroup: string): Promise<boolean> {
  const rows: GroupCoverageRow[] = await db.select({
    availableModelName: schema.tokenModelAvailability.modelName,
    tokenGroup: schema.accountTokens.tokenGroup,
    tokenName: schema.accountTokens.name,
  })
    .from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .where(and(
      eq(schema.accountTokens.accountId, accountId),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
      eq(schema.tokenModelAvailability.available, true),
    ))
    .all();

  const targetGroupKey = normalizeLower(targetGroup) || 'default';
  return rows.some((row: GroupCoverageRow) => {
    const availableModel = normalizeText(row.availableModelName);
    if (!availableModel) return false;
    if (availableModel !== modelName && !isModelAliasEquivalent(availableModel, modelName)) return false;
    const groupLabel = resolveTokenGroupLabel(row.tokenGroup, row.tokenName);
    return (normalizeLower(groupLabel) || 'default') === targetGroupKey;
  });
}

async function loadOrInitState(target: TokenCoverageProvisionTarget, targetGroup: string): Promise<AutoprovisionStateRow | null> {
  const existing = await db.select().from(schema.tokenCoverageAutoprovisionStates)
    .where(and(
      eq(schema.tokenCoverageAutoprovisionStates.accountId, target.accountId),
      eq(schema.tokenCoverageAutoprovisionStates.modelName, target.modelName),
      eq(schema.tokenCoverageAutoprovisionStates.targetGroup, targetGroup),
    ))
    .get();
  if (existing) return existing;

  const timestamp = nowIso();
  try {
    await db.insert(schema.tokenCoverageAutoprovisionStates).values({
      accountId: target.accountId,
      siteId: target.siteId,
      modelName: target.modelName,
      targetGroup,
      status: 'pending',
      attemptCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    }).run();
  } catch {}

  return await db.select().from(schema.tokenCoverageAutoprovisionStates)
    .where(and(
      eq(schema.tokenCoverageAutoprovisionStates.accountId, target.accountId),
      eq(schema.tokenCoverageAutoprovisionStates.modelName, target.modelName),
      eq(schema.tokenCoverageAutoprovisionStates.targetGroup, targetGroup),
    ))
    .get();
}

async function updateStateResult(params: {
  target: TokenCoverageProvisionTarget;
  targetGroup: string;
  status: string;
  reasonCode?: string | null;
  message?: string | null;
  createdTokenName?: string | null;
  createdTokenGroup?: string | null;
  success?: boolean;
  cooldownMs?: number;
}): Promise<void> {
  const current = await loadOrInitState(params.target, params.targetGroup);
  if (!current) return;
  const timestamp = nowIso();
  const nextAttemptCount = params.status === 'failed'
    ? Math.max(1, (current.attemptCount || 0) + 1)
    : Math.max(current.attemptCount || 0, 0);
  const cooldownUntil = params.status === 'failed' && (params.cooldownMs || 0) > 0
    ? new Date(Date.now() + (params.cooldownMs || 0)).toISOString()
    : null;
  await db.update(schema.tokenCoverageAutoprovisionStates)
    .set({
      status: params.status,
      reasonCode: params.reasonCode || null,
      message: params.message || null,
      attemptCount: nextAttemptCount,
      lastAttemptAt: timestamp,
      lastSuccessAt: params.success ? timestamp : current.lastSuccessAt,
      cooldownUntil,
      lastCreatedTokenName: params.createdTokenName ?? current.lastCreatedTokenName,
      lastCreatedTokenGroup: params.createdTokenGroup ?? current.lastCreatedTokenGroup,
      updatedAt: timestamp,
    })
    .where(eq(schema.tokenCoverageAutoprovisionStates.id, current.id))
    .run();
}

async function shouldCooldown(target: TokenCoverageProvisionTarget, targetGroup: string): Promise<AutoprovisionStateRow | null> {
  const state = await loadOrInitState(target, targetGroup);
  if (!state) return null;
  const cooldownUntil = state.cooldownUntil ? Date.parse(state.cooldownUntil) : 0;
  if (state.status === 'failed' && Number.isFinite(cooldownUntil) && cooldownUntil > Date.now()) {
    return state;
  }
  return null;
}

async function provisionSingleTarget(
  target: TokenCoverageProvisionTarget,
  provisionMode: TokenCoverageProvisionMode,
): Promise<TokenCoverageProvisionItemResult> {
  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, target.accountId))
    .get();
  if (!row) {
    return {
      accountId: target.accountId,
      siteId: target.siteId,
      modelName: target.modelName,
      targetGroup: 'default',
      status: 'skipped',
      reason: 'account_not_found',
      message: 'account not found',
      routeId: target.routeId ?? null,
      groupRouteId: target.groupRouteId ?? null,
    };
  }

  const account: AccountRow = row.accounts;
  const site: SiteRow = row.sites;
  if ((account.status || 'active') !== 'active' || (site.status || 'active') !== 'active') {
    return {
      accountId: target.accountId,
      siteId: target.siteId,
      modelName: target.modelName,
      targetGroup: 'default',
      status: 'skipped',
      reason: 'account_or_site_disabled',
      message: 'account/site disabled',
      routeId: target.routeId ?? null,
      groupRouteId: target.groupRouteId ?? null,
    };
  }
  if (!requiresManagedAccountTokens(account)) {
    return {
      accountId: target.accountId,
      siteId: target.siteId,
      modelName: target.modelName,
      targetGroup: 'default',
      status: 'skipped',
      reason: 'managed_tokens_not_required',
      message: 'managed tokens not required',
      routeId: target.routeId ?? null,
      groupRouteId: target.groupRouteId ?? null,
    };
  }

  const adapter = getAdapter(site.platform);
  if (!adapter) {
    return {
      accountId: target.accountId,
      siteId: target.siteId,
      modelName: target.modelName,
      targetGroup: 'default',
      status: 'skipped',
      reason: 'unsupported_platform',
      message: `unsupported platform: ${site.platform}`,
      routeId: target.routeId ?? null,
      groupRouteId: target.groupRouteId ?? null,
    };
  }

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  const availableGroups = await adapter.getUserGroups(site.url, account.accessToken, platformUserId).catch(() => ['default']);
  const pricingCatalog = await fetchModelPricingCatalog({
    site: {
      id: site.id,
      url: site.url,
      platform: site.platform,
      apiKey: site.apiKey,
    },
    account: {
      id: account.id,
      accessToken: account.accessToken,
      apiToken: account.apiToken,
    },
    modelName: '__metadata__',
    totalTokens: 0,
  }).catch(() => null);

  const targetGroup = selectPreferredTokenGroupForModel(
    target.modelName,
    availableGroups,
    pricingCatalog,
    provisionMode === 'shared_group' ? target.requiredGroups : undefined,
  );

  if (provisionMode === 'shared_group') {
    const reusableSharedToken = await findReusableSharedTokenForModelInGroup(target.accountId, target.modelName, targetGroup);
    if (reusableSharedToken) {
      const reusableGroup = reusableSharedToken.groupLabel || targetGroup;
      await updateStateResult({
        target,
        targetGroup: reusableGroup,
        status: 'succeeded',
        reasonCode: 'reused_existing_shared_token',
        message: 'reused existing shared token',
        createdTokenName: reusableSharedToken.token.name,
        createdTokenGroup: reusableSharedToken.groupLabel,
        success: true,
      });
      return {
        accountId: target.accountId,
        siteId: target.siteId,
        modelName: target.modelName,
        targetGroup: reusableGroup,
        status: 'reused',
        reason: 'reused_existing_shared_token',
        message: 'reused existing shared token',
        createdTokenId: reusableSharedToken.token.id,
        createdTokenName: reusableSharedToken.token.name,
        createdTokenGroup: reusableSharedToken.groupLabel,
        routeId: target.routeId ?? null,
        groupRouteId: target.groupRouteId ?? null,
      };
    }
  }

  const coolingState = await shouldCooldown(target, targetGroup);
  if (coolingState) {
    return {
      accountId: target.accountId,
      siteId: target.siteId,
      modelName: target.modelName,
      targetGroup,
      status: 'cooldown',
      reason: coolingState.reasonCode || 'cooldown',
      message: coolingState.message || `cooldown until ${coolingState.cooldownUntil}`,
      routeId: target.routeId ?? null,
      groupRouteId: target.groupRouteId ?? null,
    };
  }

  if (await hasCoverageInGroup(target.accountId, target.modelName, targetGroup)) {
    await updateStateResult({
      target,
      targetGroup,
      status: 'succeeded',
      reasonCode: 'already_covered',
      message: 'coverage already available',
      success: true,
    });
    return {
      accountId: target.accountId,
      siteId: target.siteId,
      modelName: target.modelName,
      targetGroup,
      status: 'reused',
      reason: 'already_covered',
      message: 'coverage already available',
      routeId: target.routeId ?? null,
      groupRouteId: target.groupRouteId ?? null,
    };
  }

  const reusableToken = provisionMode === 'shared_group'
    ? await findReusableTokenByGroup(target.accountId, targetGroup)
    : null;
  if (reusableToken) {
    await refreshModelsForAccountDeferred(target.accountId).catch(() => undefined);
    const hasCoverageAfterRefresh = await hasCoverageInGroup(target.accountId, target.modelName, targetGroup);
    await updateStateResult({
      target,
      targetGroup,
      status: 'succeeded',
      reasonCode: hasCoverageAfterRefresh ? 'reused_group_token' : 'reused_group_token_pending_refresh',
      message: hasCoverageAfterRefresh ? 'reused existing group token' : 'reused existing group token before coverage refresh',
      createdTokenName: reusableToken.name,
      createdTokenGroup: resolveTokenGroupLabel(reusableToken.tokenGroup, reusableToken.name),
      success: true,
    });
    return {
      accountId: target.accountId,
      siteId: target.siteId,
      modelName: target.modelName,
      targetGroup,
      status: 'reused',
      reason: hasCoverageAfterRefresh ? 'reused_group_token' : 'reused_group_token_pending_refresh',
      message: hasCoverageAfterRefresh ? 'reused existing group token' : 'reused existing group token before coverage refresh',
      createdTokenId: reusableToken.id,
      createdTokenName: reusableToken.name,
      createdTokenGroup: resolveTokenGroupLabel(reusableToken.tokenGroup, reusableToken.name),
      routeId: target.routeId ?? null,
      groupRouteId: target.groupRouteId ?? null,
    };
  }

  const tokenName = provisionMode === 'scoped_model'
    ? buildScopedAutoTokenName(target.modelName, targetGroup)
    : buildAutoTokenName(targetGroup);

  try {
    const created = await adapter.createApiToken(site.url, account.accessToken, platformUserId, {
      name: tokenName,
      group: targetGroup,
      ...(provisionMode === 'scoped_model'
        ? {
          modelLimitsEnabled: true,
          modelLimits: target.modelName,
        }
        : {}),
    });
    if (!created) {
      await updateStateResult({
        target,
        targetGroup,
        status: 'failed',
        reasonCode: 'create_token_failed',
        message: 'upstream create token failed',
        cooldownMs: DEFAULT_COOLDOWN_MS,
      });
      return {
        accountId: target.accountId,
        siteId: target.siteId,
        modelName: target.modelName,
        targetGroup,
        status: 'failed',
        reason: 'create_token_failed',
        message: 'upstream create token failed',
        routeId: target.routeId ?? null,
        groupRouteId: target.groupRouteId ?? null,
      };
    }

    let upstreamTokens = await adapter.getApiTokens(site.url, account.accessToken, platformUserId).catch(() => []);
    if (upstreamTokens.length === 0) {
      const single = await adapter.getApiToken(site.url, account.accessToken, platformUserId).catch(() => null);
      if (single) {
        upstreamTokens = [{
          name: tokenName,
          key: single,
          enabled: true,
          tokenGroup: targetGroup,
        }];
      }
    }
    if (upstreamTokens.length === 0) {
      await updateStateResult({
        target,
        targetGroup,
        status: 'failed',
        reasonCode: 'token_list_empty_after_create',
        message: 'upstream token list empty after create',
        cooldownMs: DEFAULT_COOLDOWN_MS,
      });
      return {
        accountId: target.accountId,
        siteId: target.siteId,
        modelName: target.modelName,
        targetGroup,
        status: 'failed',
        reason: 'token_list_empty_after_create',
        message: 'upstream token list empty after create',
        routeId: target.routeId ?? null,
        groupRouteId: target.groupRouteId ?? null,
      };
    }

    const syncResult = await syncTokensFromUpstream(target.accountId, upstreamTokens);
    await refreshModelsForAccountDeferred(target.accountId);
    const createdToken = await findProvisionedUsableToken(target.accountId, targetGroup, tokenName);
    const hasCoverageAfterCreate = await hasCoverageInGroup(target.accountId, target.modelName, targetGroup);
    if (!createdToken || !hasCoverageAfterCreate) {
      const reasonCode = syncResult.maskedPending > 0
        ? 'created_token_masked_pending'
        : !createdToken
          ? 'created_token_not_ready'
          : 'created_token_missing_coverage';
      const message = syncResult.maskedPending > 0
        ? 'upstream returned masked token after create; local token remains pending'
        : !createdToken
          ? 'created token did not become a ready local token'
          : 'created token missing model coverage after refresh';
      if (syncResult.maskedPending > 0) {
        await deletePendingAutoManagedTokensForAccount(target.accountId, syncResult.pendingTokenIds).catch(() => undefined);
      }
      await updateStateResult({
        target,
        targetGroup,
        status: 'failed',
        reasonCode,
        message,
        createdTokenName: tokenName,
        createdTokenGroup: targetGroup,
        cooldownMs: DEFAULT_COOLDOWN_MS,
      });
      return {
        accountId: target.accountId,
        siteId: target.siteId,
        modelName: target.modelName,
        targetGroup,
        status: 'failed',
        reason: reasonCode,
        message,
        routeId: target.routeId ?? null,
        groupRouteId: target.groupRouteId ?? null,
      };
    }
    await updateStateResult({
      target,
      targetGroup,
      status: 'succeeded',
      reasonCode: 'created',
      message: 'auto token created',
      createdTokenName: tokenName,
      createdTokenGroup: targetGroup,
      success: true,
    });
    return {
      accountId: target.accountId,
      siteId: target.siteId,
      modelName: target.modelName,
      targetGroup,
      status: 'created',
      reason: 'created',
      message: 'auto token created',
      createdTokenId: createdToken.id,
      createdTokenName: tokenName,
      createdTokenGroup: targetGroup,
      routeId: target.routeId ?? null,
      groupRouteId: target.groupRouteId ?? null,
    };
  } catch (error) {
    const message = summarizeError(error);
    await updateStateResult({
      target,
      targetGroup,
      status: 'failed',
      reasonCode: 'exception',
      message,
      cooldownMs: DEFAULT_COOLDOWN_MS,
    });
    return {
      accountId: target.accountId,
      siteId: target.siteId,
      modelName: target.modelName,
      targetGroup,
      status: 'failed',
      reason: 'exception',
      message,
      routeId: target.routeId ?? null,
      groupRouteId: target.groupRouteId ?? null,
    };
  }
}

export async function autoProvisionTokenCoverage(
  scope: TokenCoverageProvisionScope = {},
  options?: {
    provisionMode?: TokenCoverageProvisionMode;
    refreshRouteChannels?: boolean;
  },
): Promise<TokenCoverageProvisionResult> {
  const provisionMode = options?.provisionMode || 'shared_group';
  if (!hasExplicitProvisionTargets(scope)) {
    return {
      mode: 'mixed',
      provisionMode,
      summary: buildSummary([]),
      results: [],
    };
  }
  const { mode, targets } = await listProvisionCandidateTargets(scope);
  const groupedByAccount = new Map<number, TokenCoverageProvisionTarget[]>();
  for (const target of targets) {
    const list = groupedByAccount.get(target.accountId) || [];
    list.push(target);
    groupedByAccount.set(target.accountId, list);
  }

  const results: TokenCoverageProvisionItemResult[] = [];
  for (const accountTargets of groupedByAccount.values()) {
    for (const target of accountTargets) {
      results.push(await provisionSingleTarget(target, provisionMode));
    }
  }

  const successfulAccountIds = Array.from(new Set(
    results
      .filter((item) => item.status === 'created' || item.status === 'reused')
      .map((item) => item.accountId),
  ));
  if (provisionMode === 'shared_group' && successfulAccountIds.length > 0) {
    const expectedGroupsByAccount = await resolveExpectedSharedGroupsForAccounts(successfulAccountIds).catch(() => new Map<number, Set<string>>());
    for (const accountId of successfulAccountIds) {
      const expectedGroups = expectedGroupsByAccount.get(accountId) || new Set<string>();
      await cleanupAutoManagedTokensForAccount(accountId, expectedGroups).catch(() => undefined);
    }
  }
  if (options?.refreshRouteChannels !== false && successfulAccountIds.length > 0) {
    await rebuildTokenRoutesFromAvailabilityScopedDeferred({
      accountIds: successfulAccountIds,
    }).catch(() => undefined);
  }

  return {
    mode,
    provisionMode,
    summary: buildSummary(results),
    results,
  };
}

export function queueAutoProvisionTokenCoverageTask(
  scope: TokenCoverageProvisionScope = {},
  options?: {
    provisionMode?: TokenCoverageProvisionMode;
    dedupeKey?: string;
    title?: string;
  },
) {
  const accountIds = dedupeIds(scope.accountIds);
  const siteIds = dedupeIds(scope.siteIds);
  const routeIds = dedupeIds(scope.routeIds);
  const modelNames = dedupeModels(scope.modelNames);
  const suffix = [
    accountIds.length > 0 ? `a:${accountIds.join(',')}` : '',
    siteIds.length > 0 ? `s:${siteIds.join(',')}` : '',
    routeIds.length > 0 ? `r:${routeIds.join(',')}` : '',
    modelNames.length > 0 ? `m:${modelNames.join(',')}` : '',
    `mode:${options?.provisionMode || 'shared_group'}`,
  ].filter(Boolean).join('|') || 'all';

  return startBackgroundTask(
    {
      type: AUTO_PROVISION_TASK_TYPE,
      title: options?.title || AUTO_PROVISION_TASK_TITLE,
      dedupeKey: options?.dedupeKey || `auto-provision-token-coverage:${suffix}`,
      notifyOnFailure: true,
      successMessage: (task) => {
        const result = task.result as TokenCoverageProvisionResult | null;
        if (!result?.summary) return '自动补齐模型覆盖 Key 已完成';
        return `自动补齐模型覆盖 Key 完成：创建 ${result.summary.created}，复用 ${result.summary.reused}，冷却 ${result.summary.cooldown}，失败 ${result.summary.failed}`;
      },
      failureMessage: (task) => `自动补齐模型覆盖 Key 失败：${task.error || 'unknown error'}`,
    },
    async () => autoProvisionTokenCoverage(
      {
        accountIds,
        siteIds,
        routeIds,
        modelNames,
      },
      {
        provisionMode: options?.provisionMode,
        refreshRouteChannels: true,
      },
    ),
  );
}

export const __tokenCoverageAutoProvisionTestUtils = {
  async listTargets(scope: TokenCoverageProvisionScope = {}) {
    return await listProvisionCandidateTargets(scope);
  },
  async listExplicitTargetModelsByAccount(accountIds: number[]) {
    return await listActiveExplicitTargetModelsByAccount(accountIds);
  },
};
