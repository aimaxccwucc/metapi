import { FastifyInstance } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { rebuildTokenRoutesFromAvailability, refreshModelsAndRebuildRoutes, refreshModelsForAccount } from '../../services/modelService.js';
import { normalizeRouteRoutingStrategy } from '../../services/routeRoutingStrategy.js';
import { invalidateTokenRouterCache, matchesModelPattern, tokenRouter } from '../../services/tokenRouter.js';
import { repairAccountKeysForAccount } from '../../services/accountKeyRepairService.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import { getAdapter } from '../../services/platforms/index.js';
import { resolvePlatformUserId, getCredentialModeFromExtraConfig } from '../../services/accountExtraConfig.js';
import { fetchModelPricingCatalog, selectPreferredTokenGroup } from '../../services/modelPricingService.js';
import { syncTokensFromUpstream } from '../../services/accountTokenService.js';
import {
  clearRouteDecisionSnapshot,
  clearRouteDecisionSnapshots,
  parseRouteDecisionSnapshot,
  saveRouteDecisionSnapshots,
} from '../../services/routeDecisionSnapshotStore.js';

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (/^\/(?:[^\\/]|\\.)+\/[a-z]*$/i.test(normalized)) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  if (!/[\*\?\[]/.test(normalized) && /[()|+^$\\]/.test(normalized)) return false;
  return !/[\*\?\[]/.test(normalized);
}

async function getDefaultTokenId(accountId: number): Promise<number | null> {
  const token = await db.select().from(schema.accountTokens)
    .where(and(eq(schema.accountTokens.accountId, accountId), eq(schema.accountTokens.enabled, true), eq(schema.accountTokens.isDefault, true)))
    .get();
  return token?.id ?? null;
}

function canonicalModelAlias(modelName: string): string {
  const normalized = modelName.trim().toLowerCase();
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

async function tokenSupportsModel(tokenId: number, modelName: string): Promise<boolean> {
  const rows = await db.select().from(schema.tokenModelAvailability)
    .where(
      and(
        eq(schema.tokenModelAvailability.tokenId, tokenId),
        eq(schema.tokenModelAvailability.available, true),
      ),
    )
    .all();
  return rows.some((row) => {
    const availableModelName = row.modelName?.trim();
    if (!availableModelName) return false;
    return availableModelName === modelName || isModelAliasEquivalent(availableModelName, modelName);
  });
}

async function checkTokenBelongsToAccount(tokenId: number, accountId: number): Promise<boolean> {
  const row = await db.select().from(schema.accountTokens)
    .where(and(eq(schema.accountTokens.id, tokenId), eq(schema.accountTokens.accountId, accountId)))
    .get();
  return !!row;
}

type ResolvedChannelBinding = {
  accountId: number;
  tokenId: number | null;
  sourceModel: string;
};

type AccountBindingWarmupState = {
  refreshed: boolean;
  repaired: boolean;
  hasEnabledToken?: boolean;
};

const CHANNEL_BATCH_WARMUP_CONCURRENCY = 6;
const ROUTE_AUTOCREATE_SOFT_TIMEOUT_MS = 4_000;

function buildChannelPairKey(accountId: number, tokenId: number | null | undefined, sourceModel: string): string {
  const normalizedTokenId = typeof tokenId === 'number' && Number.isFinite(tokenId) ? tokenId : 0;
  return `${accountId}::${normalizedTokenId}::${sourceModel.trim().toLowerCase()}`;
}

function isApiKeyConnection(account: typeof schema.accounts.$inferSelect): boolean {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit && explicit !== 'auto') return explicit === 'apikey';
  return !(account.accessToken || '').trim();
}

function resolveTokenGroupLabel(tokenGroup: string | null, tokenName: string | null): string | null {
  const explicit = (tokenGroup || '').trim();
  if (explicit) return explicit;

  const name = (tokenName || '').trim();
  if (!name) return null;
  const normalized = name.toLowerCase();
  if (normalized === 'default' || normalized === '默认' || /^default($|[-_\s])/.test(normalized)) {
    return 'default';
  }
  if (/^token-\d+$/.test(normalized)) return null;
  return name;
}

function buildAutoTokenName(modelName: string, preferredGroup: string): string {
  const normalizedGroup = preferredGroup.trim() || 'default';
  const normalizedModel = modelName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36) || 'model';
  return `metapi-${normalizedGroup}-${normalizedModel}`.slice(0, 64);
}

async function ensurePreferredTokenCoverageForPattern(modelPattern: string): Promise<void> {
  const startedAt = Date.now();
  const rows = await db.select({
    modelName: schema.modelAvailability.modelName,
    accountId: schema.accounts.id,
    accessToken: schema.accounts.accessToken,
    apiToken: schema.accounts.apiToken,
    username: schema.accounts.username,
    extraConfig: schema.accounts.extraConfig,
    accountStatus: schema.accounts.status,
    siteId: schema.sites.id,
    siteUrl: schema.sites.url,
    sitePlatform: schema.sites.platform,
    siteApiKey: schema.sites.apiKey,
    siteStatus: schema.sites.status,
  })
    .from(schema.modelAvailability)
    .innerJoin(schema.accounts, eq(schema.modelAvailability.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.modelAvailability.available, true))
    .all();

  type AccountModelContext = {
    accountId: number;
    modelNames: Set<string>;
    accessToken: string;
    apiToken: string | null;
    username: string | null;
    extraConfig: string | null;
    site: {
      id: number;
      url: string;
      platform: string;
      apiKey: string | null;
    };
  };

  const accountContexts = new Map<number, AccountModelContext>();
  for (const row of rows) {
    const modelName = (row.modelName || '').trim();
    if (!modelName || !matchesModelPattern(modelName, modelPattern)) continue;
    if ((row.accountStatus || 'active') !== 'active' || (row.siteStatus || 'active') !== 'active') continue;
    if (!(row.accessToken || '').trim()) continue;
    if (getCredentialModeFromExtraConfig(row.extraConfig) === 'apikey') continue;

    const current = accountContexts.get(row.accountId);
    if (current) {
      current.modelNames.add(modelName);
      continue;
    }

    accountContexts.set(row.accountId, {
      accountId: row.accountId,
      modelNames: new Set([modelName]),
      accessToken: row.accessToken,
      apiToken: row.apiToken,
      username: row.username,
      extraConfig: row.extraConfig,
      site: {
        id: row.siteId,
        url: row.siteUrl,
        platform: row.sitePlatform,
        apiKey: row.siteApiKey,
      },
    });
  }

  for (const context of accountContexts.values()) {
    if (Date.now() - startedAt > 20_000) break;

    const adapter = getAdapter(context.site.platform);
    if (!adapter) continue;

    const platformUserId = resolvePlatformUserId(context.extraConfig, context.username);
    const availableGroups = await adapter.getUserGroups(context.site.url, context.accessToken, platformUserId).catch(() => ['default']);
    const pricingCatalog = await fetchModelPricingCatalog({
      site: context.site,
      account: {
        id: context.accountId,
        accessToken: context.accessToken,
        apiToken: context.apiToken,
      },
      modelName: '__metadata__',
      totalTokens: 0,
    }).catch(() => null);

    const coverageRows = await db.select({
      tokenGroup: schema.accountTokens.tokenGroup,
      tokenName: schema.accountTokens.name,
      availableModelName: schema.tokenModelAvailability.modelName,
    })
      .from(schema.tokenModelAvailability)
      .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .where(
        and(
          eq(schema.accountTokens.accountId, context.accountId),
          eq(schema.accountTokens.enabled, true),
          eq(schema.tokenModelAvailability.available, true),
        ),
      )
      .all();

    let createdAny = false;
    for (const modelName of context.modelNames) {
      if (Date.now() - startedAt > 20_000) break;
      const normalizedModelName = modelName.trim();
      if (!normalizedModelName) continue;

      const preferred = selectPreferredTokenGroup({
        availableGroups,
        modelNames: [normalizedModelName],
        catalog: pricingCatalog,
      });
      const preferredGroupKey = preferred.group.trim().toLowerCase() || 'default';

      const hasPreferredCoverage = coverageRows.some((item) => {
        const availableModelName = (item.availableModelName || '').trim();
        if (!availableModelName) return false;
        if (availableModelName !== normalizedModelName && !isModelAliasEquivalent(availableModelName, normalizedModelName)) return false;
        const groupLabel = resolveTokenGroupLabel(item.tokenGroup, item.tokenName);
        return (groupLabel || 'default').trim().toLowerCase() === preferredGroupKey;
      });
      if (hasPreferredCoverage) continue;

      const created = await adapter.createApiToken(context.site.url, context.accessToken, platformUserId, {
        name: buildAutoTokenName(normalizedModelName, preferred.group),
        group: preferred.group,
      });
      if (!created) continue;
      createdAny = true;
    }

    if (!createdAny) continue;

    let upstreamTokens = await adapter.getApiTokens(context.site.url, context.accessToken, platformUserId).catch(() => []);
    if (upstreamTokens.length === 0) {
      const single = await adapter.getApiToken(context.site.url, context.accessToken, platformUserId).catch(() => null);
      if (single) {
        upstreamTokens = [{ name: 'default', key: single, enabled: true, tokenGroup: 'default' }];
      }
    }
    if (upstreamTokens.length === 0) continue;

    await syncTokensFromUpstream(context.accountId, upstreamTokens);
    await refreshModelsForAccount(context.accountId);
  }
}

async function runWithSoftTimeout(task: Promise<void>, timeoutMs: number): Promise<void> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    task.catch(() => undefined),
    new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeoutHandle) clearTimeout(timeoutHandle);
}

async function hasEnabledAccountToken(accountId: number): Promise<boolean> {
  const row = await db.select({ id: schema.accountTokens.id }).from(schema.accountTokens)
    .where(and(eq(schema.accountTokens.accountId, accountId), eq(schema.accountTokens.enabled, true)))
    .get();
  return !!row;
}

async function findAccountTokenForSourceModel(accountId: number, sourceModel: string): Promise<number | null> {
  const normalizedSourceModel = sourceModel.trim();
  if (!normalizedSourceModel) return await getDefaultTokenId(accountId);

  const rows = await db.select({
    tokenId: schema.accountTokens.id,
    isDefault: schema.accountTokens.isDefault,
    modelName: schema.tokenModelAvailability.modelName,
  }).from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .where(
      and(
        eq(schema.accountTokens.accountId, accountId),
        eq(schema.accountTokens.enabled, true),
        eq(schema.tokenModelAvailability.available, true),
      ),
    )
    .all();

  const supported = rows.filter((row) => {
    const availableModelName = row.modelName?.trim();
    if (!availableModelName) return false;
    return availableModelName === normalizedSourceModel || isModelAliasEquivalent(availableModelName, normalizedSourceModel);
  });
  if (supported.length === 0) return null;
  const preferred = supported.find((row) => row.isDefault) || supported[0];
  return preferred?.tokenId ?? null;
}

async function resolveChannelBinding(params: {
  route: typeof schema.tokenRoutes.$inferSelect;
  accountId: number;
  tokenId?: number;
  sourceModel?: string;
  allowAccountRepair?: boolean;
  warmupState?: AccountBindingWarmupState;
}): Promise<ResolvedChannelBinding> {
  const { route, accountId } = params;
  const exactRoute = isExactModelPattern(route.modelPattern);
  const requestedSourceModel = typeof params.sourceModel === 'string'
    ? params.sourceModel.trim()
    : (exactRoute ? route.modelPattern.trim() : '');

  if (!requestedSourceModel) {
    throw new Error('当前路由必须指定来源模型后才能添加通道');
  }

  if (params.tokenId && !await checkTokenBelongsToAccount(params.tokenId, accountId)) {
    throw new Error(`令牌 ${params.tokenId} 不属于账号 ${accountId}`);
  }

  if (params.tokenId) {
    const supports = await tokenSupportsModel(params.tokenId, requestedSourceModel);
    if (!supports) {
      throw new Error('该令牌不支持当前模型');
    }
    return {
      accountId,
      tokenId: params.tokenId,
      sourceModel: requestedSourceModel,
    };
  }

  const warmupState = params.warmupState ?? { refreshed: false, repaired: false };
  if (typeof warmupState.hasEnabledToken !== 'boolean') {
    warmupState.hasEnabledToken = await hasEnabledAccountToken(accountId);
  }

  const resolveImplicitToken = async (): Promise<number | null> => {
    const existing = await findAccountTokenForSourceModel(accountId, requestedSourceModel);
    if (existing) return existing;
    if (!warmupState.refreshed && warmupState.hasEnabledToken) {
      await refreshModelsForAccount(accountId);
      warmupState.refreshed = true;
    }
    return await findAccountTokenForSourceModel(accountId, requestedSourceModel);
  };

  let resolvedTokenId = await resolveImplicitToken();
  if (!resolvedTokenId && params.allowAccountRepair !== false && !warmupState.repaired) {
    const repair = await repairAccountKeysForAccount(accountId);
    warmupState.repaired = true;
    if (repair && !['failed', 'skipped'].includes(repair.status)) {
      warmupState.hasEnabledToken = true;
      const shouldRefreshAfterRepair = !warmupState.refreshed || ['created', 'synced'].includes(repair.status);
      if (shouldRefreshAfterRepair) {
        await refreshModelsForAccount(accountId);
        warmupState.refreshed = true;
      }
      resolvedTokenId = await findAccountTokenForSourceModel(accountId, requestedSourceModel);
    }
  }

  if (!resolvedTokenId) {
    throw new Error('账号当前没有支持该模型的可用 key，已尝试自动创建但仍不可用');
  }

  if (exactRoute) {
    const defaultTokenId = await getDefaultTokenId(accountId);
    if (defaultTokenId && defaultTokenId === resolvedTokenId) {
      return {
        accountId,
        tokenId: null,
        sourceModel: requestedSourceModel,
      };
    }
  }

  return {
    accountId,
    tokenId: resolvedTokenId,
    sourceModel: requestedSourceModel,
  };
}

async function runGroupsWithConcurrency<T>(groups: T[][], limit: number, worker: (group: T[]) => Promise<void>): Promise<void> {
  const concurrency = Math.max(1, Math.min(limit, groups.length || 1));
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= groups.length) return;
      await worker(groups[index]);
    }
  }));
}

async function getPatternTokenCandidates(modelPattern: string): Promise<Array<{ tokenId: number; accountId: number; sourceModel: string }>> {
  const rows = await db.select().from(schema.tokenModelAvailability)
    .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
    .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(
      and(
        eq(schema.tokenModelAvailability.available, true),
        eq(schema.accountTokens.enabled, true),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  const result: Array<{ tokenId: number; accountId: number; sourceModel: string }> = [];
  for (const row of rows) {
    const modelName = row.token_model_availability.modelName?.trim();
    if (!modelName) continue;
    if (!matchesModelPattern(modelName, modelPattern)) continue;
    result.push({
      tokenId: row.account_tokens.id,
      accountId: row.accounts.id,
      sourceModel: modelName,
    });
  }

  return result;
}

async function getMatchedExactRouteChannelCandidates(modelPattern: string): Promise<Array<{
  tokenId: number | null;
  accountId: number;
  sourceModel: string;
  priority: number;
  weight: number;
  enabled: boolean;
  manualOverride: boolean;
}>> {
  const matchedRoutes = (await db.select().from(schema.tokenRoutes)
    .where(eq(schema.tokenRoutes.enabled, true))
    .all())
    .filter((route) => isExactModelPattern(route.modelPattern) && matchesModelPattern(route.modelPattern, modelPattern));

  if (matchedRoutes.length === 0) return [];
  const routeMap = new Map<number, typeof matchedRoutes[number]>();
  for (const route of matchedRoutes) routeMap.set(route.id, route);

  const channels = await db.select().from(schema.routeChannels)
    .where(inArray(schema.routeChannels.routeId, matchedRoutes.map((route) => route.id)))
    .all();

  return channels.map((channel) => ({
    tokenId: channel.tokenId ?? null,
    accountId: channel.accountId,
    sourceModel: (channel.sourceModel || routeMap.get(channel.routeId)?.modelPattern || '').trim(),
    priority: channel.priority ?? 0,
    weight: channel.weight ?? 10,
    enabled: !!channel.enabled,
    manualOverride: !!channel.manualOverride,
  })).filter((candidate) => candidate.sourceModel.length > 0);
}

async function populateRouteChannelsByModelPattern(routeId: number, modelPattern: string): Promise<number> {
  await runWithSoftTimeout(ensurePreferredTokenCoverageForPattern(modelPattern), ROUTE_AUTOCREATE_SOFT_TIMEOUT_MS);
  const routeCandidates = await getMatchedExactRouteChannelCandidates(modelPattern);
  const availabilityCandidates = (await getPatternTokenCandidates(modelPattern)).map((candidate) => ({
    tokenId: candidate.tokenId,
    accountId: candidate.accountId,
    sourceModel: candidate.sourceModel,
    priority: 0,
    weight: 10,
    enabled: true,
    manualOverride: false,
  }));
  const candidates = [...routeCandidates, ...availabilityCandidates];
  if (candidates.length === 0) return 0;

  const existingChannels = await db.select().from(schema.routeChannels)
    .where(eq(schema.routeChannels.routeId, routeId))
    .all();
  const existingPairs = new Set<string>(
    existingChannels
      .map((channel) => {
        const tokenId = typeof channel.tokenId === 'number' && Number.isFinite(channel.tokenId) ? channel.tokenId : 0;
        const sourceModel = (channel.sourceModel || '').trim().toLowerCase();
        return `${channel.accountId}::${tokenId}::${sourceModel}`;
      }),
  );

  let created = 0;
  for (const candidate of candidates) {
    const tokenId = typeof candidate.tokenId === 'number' && Number.isFinite(candidate.tokenId) ? candidate.tokenId : 0;
    const pairKey = `${candidate.accountId}::${tokenId}::${candidate.sourceModel.trim().toLowerCase()}`;
    if (existingPairs.has(pairKey)) continue;
    await db.insert(schema.routeChannels).values({
      routeId,
      accountId: candidate.accountId,
      tokenId: candidate.tokenId,
      sourceModel: candidate.sourceModel,
      priority: candidate.priority,
      weight: candidate.weight,
      enabled: candidate.enabled,
      manualOverride: candidate.manualOverride,
    }).run();
    existingPairs.add(pairKey);
    created += 1;
  }

  return created;
}

async function rebuildAutomaticRouteChannelsByModelPattern(routeId: number, modelPattern: string): Promise<{
  removedChannels: number;
  createdChannels: number;
}> {
  const removableChannels = await db.select().from(schema.routeChannels)
    .where(
      and(
        eq(schema.routeChannels.routeId, routeId),
        eq(schema.routeChannels.manualOverride, false),
      ),
    )
    .all();

  for (const channel of removableChannels) {
    await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
  }

  const createdChannels = await populateRouteChannelsByModelPattern(routeId, modelPattern);
  return {
    removedChannels: removableChannels.length,
    createdChannels,
  };
}

type BatchChannelPriorityUpdate = {
  id: number;
  priority: number;
};

type BatchRouteDecisionModels = {
  models: string[];
  refreshPricingCatalog?: boolean;
  persistSnapshots?: boolean;
};

type BatchRouteDecisionRouteModels = {
  items: Array<{
    routeId: number;
    model: string;
  }>;
  refreshPricingCatalog?: boolean;
  persistSnapshots?: boolean;
};

type BatchRouteWideDecisionRouteIds = {
  routeIds: number[];
  refreshPricingCatalog?: boolean;
  persistSnapshots?: boolean;
};

function parseBatchChannelUpdates(input: unknown): { ok: true; updates: BatchChannelPriorityUpdate[] } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const updates = (input as { updates?: unknown }).updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return { ok: false, message: 'updates 必须是非空数组' };
  }

  const normalized: BatchChannelPriorityUpdate[] = [];
  for (let index = 0; index < updates.length; index += 1) {
    const item = updates[index];
    if (!item || typeof item !== 'object') {
      return { ok: false, message: `updates[${index}] 必须是对象` };
    }

    const { id, priority } = item as { id?: unknown; priority?: unknown };
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      return { ok: false, message: `updates[${index}].id 必须是有限数字` };
    }
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      return { ok: false, message: `updates[${index}].priority 必须是有限数字` };
    }

    const normalizedId = Math.trunc(id);
    if (normalizedId <= 0) {
      return { ok: false, message: `updates[${index}].id 必须大于 0` };
    }

    normalized.push({
      id: normalizedId,
      priority: Math.max(0, Math.trunc(priority)),
    });
  }

  return { ok: true, updates: normalized };
}

function parseBatchRouteDecisionModels(
  input: unknown,
): { ok: true; models: string[]; refreshPricingCatalog: boolean; persistSnapshots: boolean } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const models = (input as BatchRouteDecisionModels).models;
  if (!Array.isArray(models) || models.length === 0) {
    return { ok: false, message: 'models 必须是非空数组' };
  }

  const dedupe = new Set<string>();
  const normalized: string[] = [];
  for (const raw of models) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || dedupe.has(trimmed)) continue;
    dedupe.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= 500) break;
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'models 中没有有效模型名称' };
  }

  return {
    ok: true,
    models: normalized,
    refreshPricingCatalog: (input as { refreshPricingCatalog?: unknown }).refreshPricingCatalog === true,
    persistSnapshots: (input as { persistSnapshots?: unknown }).persistSnapshots === true,
  };
}

function parseBatchRouteDecisionRouteModels(
  input: unknown,
): { ok: true; items: Array<{ routeId: number; model: string }>; refreshPricingCatalog: boolean; persistSnapshots: boolean } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const items = (input as BatchRouteDecisionRouteModels).items;
  if (!Array.isArray(items) || items.length === 0) {
    return { ok: false, message: 'items 必须是非空数组' };
  }

  const dedupe = new Set<string>();
  const normalized: Array<{ routeId: number; model: string }> = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const routeIdRaw = (item as { routeId?: unknown }).routeId;
    const modelRaw = (item as { model?: unknown }).model;
    if (typeof routeIdRaw !== 'number' || !Number.isFinite(routeIdRaw)) continue;
    if (typeof modelRaw !== 'string') continue;

    const routeId = Math.trunc(routeIdRaw);
    const model = modelRaw.trim();
    if (routeId <= 0 || !model) continue;

    const key = `${routeId}::${model}`;
    if (dedupe.has(key)) continue;
    dedupe.add(key);
    normalized.push({ routeId, model });
    if (normalized.length >= 500) break;
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'items 中没有有效 routeId/model' };
  }

  return {
    ok: true,
    items: normalized,
    refreshPricingCatalog: (input as { refreshPricingCatalog?: unknown }).refreshPricingCatalog === true,
    persistSnapshots: (input as { persistSnapshots?: unknown }).persistSnapshots === true,
  };
}

function parseBatchRouteWideDecisionRouteIds(
  input: unknown,
): { ok: true; routeIds: number[]; refreshPricingCatalog: boolean; persistSnapshots: boolean } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') {
    return { ok: false, message: '请求体必须是对象' };
  }

  const routeIds = (input as BatchRouteWideDecisionRouteIds).routeIds;
  if (!Array.isArray(routeIds) || routeIds.length === 0) {
    return { ok: false, message: 'routeIds 必须是非空数组' };
  }

  const dedupe = new Set<number>();
  const normalized: number[] = [];
  for (const raw of routeIds) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const routeId = Math.trunc(raw);
    if (routeId <= 0 || dedupe.has(routeId)) continue;
    dedupe.add(routeId);
    normalized.push(routeId);
    if (normalized.length >= 500) break;
  }

  if (normalized.length === 0) {
    return { ok: false, message: 'routeIds 中没有有效 routeId' };
  }

  return {
    ok: true,
    routeIds: normalized,
    refreshPricingCatalog: (input as { refreshPricingCatalog?: unknown }).refreshPricingCatalog === true,
    persistSnapshots: (input as { persistSnapshots?: unknown }).persistSnapshots === true,
  };
}

async function fetchChannelsForRoutes(routeIds: number[]): Promise<Map<number, any[]>> {
  if (routeIds.length === 0) return new Map();

  const channelRows = await db.select().from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(inArray(schema.routeChannels.routeId, routeIds))
    .all();

  const channelsByRoute = new Map<number, any[]>();

  for (const row of channelRows) {
    const routeId = row.route_channels.routeId;
    if (!channelsByRoute.has(routeId)) channelsByRoute.set(routeId, []);
    channelsByRoute.get(routeId)!.push({
      ...row.route_channels,
      account: row.accounts,
      site: row.sites,
      token: row.account_tokens
        ? {
          id: row.account_tokens.id,
          name: row.account_tokens.name,
          accountId: row.account_tokens.accountId,
          enabled: row.account_tokens.enabled,
          isDefault: row.account_tokens.isDefault,
        }
        : null,
    });
  }

  return channelsByRoute;
}

export async function tokensRoutes(app: FastifyInstance) {
  // List routes with basic info only (lightweight for selectors)
  app.get('/api/routes/lite', async () => {
    return await db.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      displayName: schema.tokenRoutes.displayName,
      displayIcon: schema.tokenRoutes.displayIcon,
      routingStrategy: schema.tokenRoutes.routingStrategy,
      enabled: schema.tokenRoutes.enabled,
    }).from(schema.tokenRoutes).all();
  });

  // Route summary (no channel details) for first-screen rendering
  app.get('/api/routes/summary', async () => {
    const routes = await db.select().from(schema.tokenRoutes).all();
    if (routes.length === 0) return [];

    const routeIds = routes.map((route) => route.id);

    // Aggregate channel counts and site names per route
    const channelRows = await db.select({
      routeId: schema.routeChannels.routeId,
      enabled: schema.routeChannels.enabled,
      siteName: schema.sites.name,
    }).from(schema.routeChannels)
      .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(inArray(schema.routeChannels.routeId, routeIds))
      .all();

    const aggByRoute = new Map<number, { channelCount: number; enabledChannelCount: number; siteNames: Set<string> }>();
    for (const row of channelRows) {
      let agg = aggByRoute.get(row.routeId);
      if (!agg) {
        agg = { channelCount: 0, enabledChannelCount: 0, siteNames: new Set() };
        aggByRoute.set(row.routeId, agg);
      }
      agg.channelCount += 1;
      if (row.enabled) agg.enabledChannelCount += 1;
      if (row.siteName) agg.siteNames.add(row.siteName);
    }

    return routes.map((route) => {
      const agg = aggByRoute.get(route.id);
      return {
        id: route.id,
        modelPattern: route.modelPattern,
        displayName: route.displayName ?? null,
        displayIcon: route.displayIcon ?? null,
        modelMapping: route.modelMapping ?? null,
        routingStrategy: route.routingStrategy ?? 'weighted',
        enabled: route.enabled,
        channelCount: agg?.channelCount ?? 0,
        enabledChannelCount: agg?.enabledChannelCount ?? 0,
        siteNames: agg ? Array.from(agg.siteNames) : [],
        decisionSnapshot: parseRouteDecisionSnapshot(route.decisionSnapshot),
        decisionRefreshedAt: route.decisionRefreshedAt ?? null,
      };
    });
  });

  // Get channels for a single route (on-demand loading)
  app.get<{ Params: { id: string } }>('/api/routes/:id/channels', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    const route = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).get();
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    const channelsByRoute = await fetchChannelsForRoutes([routeId]);
    return channelsByRoute.get(routeId) || [];
  });

  // Batch add channels to a route
  app.post<{ Params: { id: string }; Body: { channels: Array<{ accountId: number; tokenId?: number; sourceModel?: string }> } }>('/api/routes/:id/channels/batch', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    const body = request.body;

    const route = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).get();
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }

    if (!body?.channels || !Array.isArray(body.channels) || body.channels.length === 0) {
      return reply.code(400).send({ success: false, message: 'channels 必须是非空数组' });
    }

    const existingChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, routeId))
      .all();
    const existingPairs = new Set<string>(
      existingChannels.map((channel) => buildChannelPairKey(channel.accountId, channel.tokenId, channel.sourceModel || '')),
    );

    let created = 0;
    let skipped = 0;
    const errors: string[] = [];
    const warmupStateByAccount = new Map<number, AccountBindingWarmupState>();
    const groupedItems = new Map<number, Array<{ accountId: number; tokenId?: number; sourceModel?: string }>>();

    for (const item of body.channels) {
      if (!item?.accountId || typeof item.accountId !== 'number') {
        errors.push('无效的 accountId');
        continue;
      }
      const group = groupedItems.get(item.accountId);
      if (group) group.push(item);
      else groupedItems.set(item.accountId, [item]);
    }

    await runGroupsWithConcurrency(Array.from(groupedItems.values()), CHANNEL_BATCH_WARMUP_CONCURRENCY, async (group) => {
      const accountId = group[0]!.accountId;
      const warmupState = warmupStateByAccount.get(accountId) || { refreshed: false, repaired: false };
      warmupStateByAccount.set(accountId, warmupState);

      for (const item of group) {
        try {
          const resolved = await resolveChannelBinding({
            route,
            accountId: item.accountId,
            tokenId: item.tokenId,
            sourceModel: item.sourceModel,
            warmupState,
          });
          const pairKey = buildChannelPairKey(resolved.accountId, resolved.tokenId, resolved.sourceModel);
          if (existingPairs.has(pairKey)) {
            skipped += 1;
            continue;
          }

          await db.insert(schema.routeChannels).values({
            routeId,
            accountId: resolved.accountId,
            tokenId: resolved.tokenId,
            sourceModel: resolved.sourceModel || null,
            priority: 0,
            weight: 10,
            manualOverride: true,
          }).run();
          existingPairs.add(pairKey);
          created += 1;
        } catch (e: any) {
          errors.push(e.message || `添加通道失败: accountId=${item.accountId}`);
        }
      }
    });

    if (created > 0) {
      await clearRouteDecisionSnapshot(routeId);
      invalidateTokenRouterCache();
    }

    return { success: true, created, skipped, errors };
  });

  // List all routes
  app.get('/api/routes', async () => {
    const routes = await db.select().from(schema.tokenRoutes).all();
    if (routes.length === 0) return [];

    const routeIds = routes.map((route) => route.id);
    const channelsByRoute = await fetchChannelsForRoutes(routeIds);

    return routes.map((route) => ({
      ...route,
      decisionSnapshot: parseRouteDecisionSnapshot(route.decisionSnapshot),
      decisionRefreshedAt: route.decisionRefreshedAt ?? null,
      channels: channelsByRoute.get(route.id) || [],
    }));
  });

  app.get<{ Querystring: { model?: string } }>('/api/routes/decision', async (request, reply) => {
    const model = (request.query.model || '').trim();
    if (!model) {
      return reply.code(400).send({ success: false, message: 'model 不能为空' });
    }

    const decision = await tokenRouter.explainSelection(model);
    return { success: true, decision };
  });

  app.post<{ Body: BatchRouteDecisionModels }>('/api/routes/decision/batch', async (request, reply) => {
    const parsed = parseBatchRouteDecisionModels(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const decisions: Record<string, Awaited<ReturnType<typeof tokenRouter.explainSelection>>> = {};
    const routes = parsed.persistSnapshots
      ? await db.select({
        id: schema.tokenRoutes.id,
        modelPattern: schema.tokenRoutes.modelPattern,
      }).from(schema.tokenRoutes).all()
      : [];
    const refreshedKeys = parsed.refreshPricingCatalog ? new Set<string>() : undefined;
    for (const model of parsed.models) {
      if (parsed.refreshPricingCatalog) {
        await tokenRouter.refreshPricingReferenceCosts(model, { refreshedKeys });
      }
      decisions[model] = await tokenRouter.explainSelection(model);
    }

    if (parsed.persistSnapshots) {
      const snapshotWrites: Array<{ routeId: number; snapshot: unknown }> = [];
      for (const model of parsed.models) {
        const decision = decisions[model];
        for (const route of routes) {
          if (!isExactModelPattern(route.modelPattern)) continue;
          if (!matchesModelPattern(model, route.modelPattern)) continue;
          snapshotWrites.push({ routeId: route.id, snapshot: decision });
        }
      }
      await saveRouteDecisionSnapshots(snapshotWrites);
    }

    return { success: true, decisions };
  });

  app.post<{ Body: BatchRouteDecisionRouteModels }>('/api/routes/decision/by-route/batch', async (request, reply) => {
    const parsed = parseBatchRouteDecisionRouteModels(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const decisions: Record<string, Record<string, Awaited<ReturnType<typeof tokenRouter.explainSelectionForRoute>>>> = {};
    const refreshedKeys = parsed.refreshPricingCatalog ? new Set<string>() : undefined;
    for (const item of parsed.items) {
      const routeKey = String(item.routeId);
      if (!decisions[routeKey]) decisions[routeKey] = {};
      if (parsed.refreshPricingCatalog) {
        await tokenRouter.refreshPricingReferenceCostsForRoute(item.routeId, item.model, { refreshedKeys });
      }
      decisions[routeKey][item.model] = await tokenRouter.explainSelectionForRoute(item.routeId, item.model);
    }

    if (parsed.persistSnapshots) {
      await saveRouteDecisionSnapshots(parsed.items.map((item) => ({
        routeId: item.routeId,
        snapshot: decisions[String(item.routeId)]?.[item.model] ?? null,
      })));
    }

    return { success: true, decisions };
  });

  app.post<{ Body: BatchRouteWideDecisionRouteIds }>('/api/routes/decision/route-wide/batch', async (request, reply) => {
    const parsed = parseBatchRouteWideDecisionRouteIds(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const decisions: Record<string, Awaited<ReturnType<typeof tokenRouter.explainSelectionRouteWide>>> = {};
    const refreshedKeys = parsed.refreshPricingCatalog ? new Set<string>() : undefined;
    for (const routeId of parsed.routeIds) {
      if (parsed.refreshPricingCatalog) {
        await tokenRouter.refreshRouteWidePricingReferenceCosts(routeId, { refreshedKeys });
      }
      decisions[String(routeId)] = await tokenRouter.explainSelectionRouteWide(routeId);
    }

    if (parsed.persistSnapshots) {
      await saveRouteDecisionSnapshots(parsed.routeIds.map((routeId) => ({
        routeId,
        snapshot: decisions[String(routeId)] ?? null,
      })));
    }

    return { success: true, decisions };
  });

  // Create a route
  app.post<{ Body: { modelPattern: string; displayName?: string; displayIcon?: string; modelMapping?: string; routingStrategy?: string; enabled?: boolean } }>('/api/routes', async (request) => {
    const body = request.body;
    const insertedRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern: body.modelPattern,
      displayName: body.displayName,
      displayIcon: body.displayIcon,
      modelMapping: body.modelMapping,
      routingStrategy: normalizeRouteRoutingStrategy(body.routingStrategy),
      enabled: body.enabled ?? true,
    }).run();
    const routeId = Number(insertedRoute.lastInsertRowid || 0);
    if (routeId <= 0) {
      return { success: false, message: '创建路由失败' };
    }
    const route = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).get();
    if (!route) {
      return { success: false, message: '创建路由失败' };
    }

    await populateRouteChannelsByModelPattern(route.id, body.modelPattern);
    invalidateTokenRouterCache();
    return route;
  });

  // Update a route
  app.put<{ Params: { id: string }; Body: any }>('/api/routes/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const body = request.body as Record<string, unknown>;
    const existingRoute = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, id)).get();
    if (!existingRoute) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }

    const updates: Record<string, unknown> = {};
    let nextModelPattern = existingRoute.modelPattern;

    if (body.displayName !== undefined) updates.displayName = body.displayName;
    if (body.displayIcon !== undefined) updates.displayIcon = body.displayIcon;
    if (body.modelPattern !== undefined) {
      nextModelPattern = String(body.modelPattern);
      updates.modelPattern = nextModelPattern;
    }
    if (body.modelMapping !== undefined) updates.modelMapping = body.modelMapping;
    if (body.routingStrategy !== undefined) updates.routingStrategy = normalizeRouteRoutingStrategy(body.routingStrategy);
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    updates.updatedAt = new Date().toISOString();

    await db.update(schema.tokenRoutes).set(updates).where(eq(schema.tokenRoutes.id, id)).run();
    const modelPatternChanged = body.modelPattern !== undefined && nextModelPattern !== existingRoute.modelPattern;
    const routeBehaviorChanged = modelPatternChanged
      || body.modelMapping !== undefined
      || body.routingStrategy !== undefined
      || body.enabled !== undefined;
    if (modelPatternChanged) {
      await rebuildAutomaticRouteChannelsByModelPattern(id, nextModelPattern);
    }
    if (routeBehaviorChanged) {
      await clearRouteDecisionSnapshot(id);
    }
    invalidateTokenRouterCache();
    return await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, id)).get();
  });

  // Delete a route
  app.delete<{ Params: { id: string } }>('/api/routes/:id', async (request) => {
    const id = parseInt(request.params.id, 10);
    await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, id)).run();
    invalidateTokenRouterCache();
    return { success: true };
  });

  // Add a channel to a route
  app.post<{ Params: { id: string }; Body: { accountId: number; tokenId?: number; sourceModel?: string; priority?: number; weight?: number } }>('/api/routes/:id/channels', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    const body = request.body;

    const route = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).get();
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }

    let resolved: ResolvedChannelBinding;
    try {
      resolved = await resolveChannelBinding({
        route,
        accountId: body.accountId,
        tokenId: body.tokenId,
        sourceModel: body.sourceModel,
      });
    } catch (error: any) {
      return reply.code(400).send({ success: false, message: error?.message || '创建通道失败' });
    }

    const duplicate = (await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, routeId))
      .all())
      .some((channel) => buildChannelPairKey(channel.accountId, channel.tokenId, channel.sourceModel || '') === buildChannelPairKey(
        resolved.accountId,
        resolved.tokenId,
        resolved.sourceModel,
      ));
    if (duplicate) {
      return reply.code(400).send({ success: false, message: '该来源模型的通道已存在' });
    }

    const insertedChannel = await db.insert(schema.routeChannels).values({
      routeId,
      accountId: resolved.accountId,
      tokenId: resolved.tokenId,
      sourceModel: resolved.sourceModel || null,
      priority: body.priority ?? 0,
      weight: body.weight ?? 10,
      manualOverride: true,
    }).run();
    const channelId = Number(insertedChannel.lastInsertRowid || 0);
    if (channelId <= 0) {
      return reply.code(500).send({ success: false, message: '创建通道失败' });
    }
    const created = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get();
    if (!created) {
      return reply.code(500).send({ success: false, message: '创建通道失败' });
    }
    await clearRouteDecisionSnapshot(routeId);
    invalidateTokenRouterCache();
    return created;
  });

  // Batch update channel priorities
  app.put<{ Body: { updates: Array<{ id: number; priority: number }> } }>('/api/channels/batch', async (request, reply) => {
    const parsed = parseBatchChannelUpdates(request.body);
    if (!parsed.ok) {
      return reply.code(400).send({ success: false, message: parsed.message });
    }

    const channelIds = Array.from(new Set(parsed.updates.map((update) => update.id)));
    const existingChannels = await db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, channelIds))
      .all();
    if (existingChannels.length !== channelIds.length) {
      const existingIds = new Set(existingChannels.map((channel) => channel.id));
      const missingId = channelIds.find((id) => !existingIds.has(id));
      return reply.code(404).send({ success: false, message: `通道不存在: ${missingId}` });
    }

    for (const update of parsed.updates) {
      await db.update(schema.routeChannels).set({
        priority: update.priority,
        manualOverride: true,
      }).where(eq(schema.routeChannels.id, update.id)).run();
    }

    const updatedChannels = await db.select().from(schema.routeChannels)
      .where(inArray(schema.routeChannels.id, channelIds))
      .all();
    await clearRouteDecisionSnapshots(existingChannels.map((channel) => channel.routeId));
    invalidateTokenRouterCache();
    return { success: true, channels: updatedChannels };
  });

  // Update a channel
  app.put<{ Params: { channelId: string }; Body: any }>('/api/channels/:channelId', async (request, reply) => {
    const channelId = parseInt(request.params.channelId, 10);
    const body = request.body as Record<string, unknown>;

    const channel = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get();
    if (!channel) {
      return reply.code(404).send({ success: false, message: '通道不存在' });
    }

    const route = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, channel.routeId)).get();
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }

    if (body.tokenId !== undefined && body.tokenId !== null) {
      const tokenId = Number(body.tokenId);
      if (!Number.isFinite(tokenId) || !await checkTokenBelongsToAccount(tokenId, channel.accountId)) {
        return reply.code(400).send({ success: false, message: '令牌不存在或不属于通道账号' });
      }
    }

    const nextTokenId = body.tokenId === undefined
      ? (channel.tokenId ?? await getDefaultTokenId(channel.accountId))
      : (body.tokenId === null ? await getDefaultTokenId(channel.accountId) : Number(body.tokenId));

    if (isExactModelPattern(route.modelPattern) && nextTokenId && !await tokenSupportsModel(nextTokenId, route.modelPattern)) {
      return reply.code(400).send({ success: false, message: '该令牌不支持当前模型' });
    }

    const updates: Record<string, unknown> = { manualOverride: true };
    if (body.sourceModel !== undefined) {
      if (body.sourceModel === null) updates.sourceModel = null;
      else updates.sourceModel = String(body.sourceModel).trim() || null;
    }

    for (const key of ['priority', 'weight', 'enabled', 'tokenId']) {
      if (body[key] !== undefined) updates[key] = body[key];
    }

    await db.update(schema.routeChannels).set(updates).where(eq(schema.routeChannels.id, channelId)).run();
    await clearRouteDecisionSnapshot(channel.routeId);
    invalidateTokenRouterCache();
    return await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get();
  });

  // Delete a channel
  app.delete<{ Params: { channelId: string } }>('/api/channels/:channelId', async (request) => {
    const channelId = parseInt(request.params.channelId, 10);
    const channel = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).get();
    await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channelId)).run();
    if (channel) {
      await clearRouteDecisionSnapshot(channel.routeId);
    }
    invalidateTokenRouterCache();
    return { success: true };
  });

  // Rebuild routes/channels from model availability.
  app.post<{ Body?: { refreshModels?: boolean; wait?: boolean } }>('/api/routes/rebuild', async (request, reply) => {
    const body = (request.body || {}) as { refreshModels?: boolean };
    if (body.refreshModels === false) {
      const rebuild = rebuildTokenRoutesFromAvailability();
      return { success: true, rebuild };
    }

    if ((request.body as { wait?: boolean } | undefined)?.wait) {
      const result = await refreshModelsAndRebuildRoutes();
      return { success: true, ...result };
    }

    const { task, reused } = startBackgroundTask(
      {
        type: 'route',
        title: '刷新模型并重建路由',
        dedupeKey: 'refresh-models-and-rebuild-routes',
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const rebuild = (currentTask.result as any)?.rebuild;
          if (!rebuild) return '刷新模型并重建路由已完成';
          return `刷新模型并重建路由完成：新增路由 ${rebuild.createdRoutes}，移除旧路由 ${rebuild.removedRoutes ?? 0}，新增通道 ${rebuild.createdChannels}，移除通道 ${rebuild.removedChannels}`;
        },
        failureMessage: (currentTask) => `刷新模型并重建路由失败：${currentTask.error || 'unknown error'}`,
      },
      async () => refreshModelsAndRebuildRoutes(),
    );

    return reply.code(202).send({
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused
        ? '路由重建任务执行中，请稍后查看程序日志'
        : '已开始路由重建，请稍后查看程序日志',
    });
  });
}
