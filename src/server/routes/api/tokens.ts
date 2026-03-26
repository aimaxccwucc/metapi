import { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { config } from '../../config.js';
import { rebuildTokenRoutesFromAvailability, refreshModelsAndRebuildRoutes, refreshModelsForAccount } from '../../services/modelService.js';
import {
  ACCOUNT_TOKEN_VALUE_STATUS_READY,
  isUsableAccountToken,
  syncTokensFromUpstream,
} from '../../services/accountTokenService.js';
import { fetchModelPricingCatalog } from '../../services/modelPricingService.js';
import { normalizeRouteRoutingStrategy } from '../../services/routeRoutingStrategy.js';
import {
  invalidateTokenRouterCache,
  listPersistedUnavailableModelEntries,
  listSiteRuntimeHealthSnapshots,
  matchesModelPattern,
  tokenRouter,
} from '../../services/tokenRouter.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import { getAdapter } from '../../services/platforms/index.js';
import { requiresManagedAccountTokens, resolvePlatformUserId } from '../../services/accountExtraConfig.js';
import {
  clearRouteDecisionSnapshot,
  clearRouteDecisionSnapshots,
  parseRouteDecisionSnapshot,
  saveRouteDecisionSnapshots,
} from '../../services/routeDecisionSnapshotStore.js';
import { getModelCircuitSnapshots } from '../../services/modelCircuitBreaker.js';
import {
  getEndpointMemoryCredentialScopeSnapshot,
  getUpstreamEndpointRuntimeMemorySnapshot,
} from '../proxy/upstreamEndpoint.js';
import { listPersistedUpstreamProtocolProfiles } from '../../services/upstreamProtocolProfile.js';
import { listSiteProtocolConfigs } from '../../services/siteProtocolConfigService.js';
import { extractRuntimeHealth } from '../../services/accountHealthService.js';
import { isSchedulableCheckinAccountStatus } from '../../services/checkinService.js';

const ROUTE_AUTOCREATE_SOFT_TIMEOUT_MS = 4_000;

type CheckinLogSnapshot = {
  accountId: number;
  status: string | null;
  message: string | null;
  createdAt: string | null;
};

type RouteDiagnosticsRouteSummary = {
  routeCount: number;
  enabledRouteCount: number;
  channelCount: number;
  enabledChannelCount: number;
};

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?]/.test(normalized);
}

type RouteMode = 'pattern' | 'explicit_group';
type RouteRow = typeof schema.tokenRoutes.$inferSelect & {
  routeMode: RouteMode;
  sourceRouteIds: number[];
};

function normalizeRouteMode(routeMode: unknown): RouteMode {
  return routeMode === 'explicit_group' ? 'explicit_group' : 'pattern';
}

function isExplicitGroupRoute(route: Pick<RouteRow, 'routeMode'> | Pick<typeof schema.tokenRoutes.$inferSelect, 'routeMode'>): boolean {
  return normalizeRouteMode(route.routeMode) === 'explicit_group';
}

function normalizeSourceRouteIdsInput(input: unknown): number[] {
  const rawValues = Array.isArray(input) ? input : [];
  const normalized: number[] = [];
  for (const raw of rawValues) {
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const routeId = Math.trunc(value);
    if (routeId <= 0 || normalized.includes(routeId)) continue;
    normalized.push(routeId);
    if (normalized.length >= 500) break;
  }
  return normalized;
}

async function loadRouteSourceIdsMap(routeIds: number[]): Promise<Map<number, number[]>> {
  const normalizedRouteIds = Array.from(new Set(routeIds.filter((routeId) => Number.isFinite(routeId) && routeId > 0)));
  if (normalizedRouteIds.length === 0) return new Map();

  const rows = await db.select().from(schema.routeGroupSources)
    .where(inArray(schema.routeGroupSources.groupRouteId, normalizedRouteIds))
    .all();
  const sourceRouteIdsByRouteId = new Map<number, number[]>();
  for (const row of rows) {
    if (!sourceRouteIdsByRouteId.has(row.groupRouteId)) {
      sourceRouteIdsByRouteId.set(row.groupRouteId, []);
    }
    sourceRouteIdsByRouteId.get(row.groupRouteId)!.push(row.sourceRouteId);
  }
  for (const [routeId, sourceRouteIds] of sourceRouteIdsByRouteId.entries()) {
    sourceRouteIdsByRouteId.set(routeId, Array.from(new Set(sourceRouteIds)));
  }
  return sourceRouteIdsByRouteId;
}

function decorateRoutesWithSources(
  routes: Array<typeof schema.tokenRoutes.$inferSelect>,
  sourceRouteIdsByRouteId: Map<number, number[]>,
): RouteRow[] {
  return routes.map((route) => ({
    ...route,
    routeMode: normalizeRouteMode(route.routeMode),
    sourceRouteIds: sourceRouteIdsByRouteId.get(route.id) ?? [],
  }));
}

async function listRoutesWithSources(): Promise<RouteRow[]> {
  const routes = await db.select().from(schema.tokenRoutes).all();
  const sourceRouteIdsByRouteId = await loadRouteSourceIdsMap(routes.map((route) => route.id));
  return decorateRoutesWithSources(routes, sourceRouteIdsByRouteId);
}

async function getRouteWithSources(routeId: number): Promise<RouteRow | null> {
  const route = await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, routeId)).get();
  if (!route) return null;
  const sourceRouteIdsByRouteId = await loadRouteSourceIdsMap([routeId]);
  return decorateRoutesWithSources([route], sourceRouteIdsByRouteId)[0] ?? null;
}

async function validateExplicitGroupSourceRoutes(sourceRouteIds: number[], currentRouteId?: number): Promise<{ ok: true } | { ok: false; message: string }> {
  if (sourceRouteIds.length === 0) {
    return { ok: false, message: '显式群组至少需要选择一个来源模型' };
  }

  const routes = await db.select().from(schema.tokenRoutes)
    .where(inArray(schema.tokenRoutes.id, sourceRouteIds))
    .all();
  if (routes.length !== sourceRouteIds.length) {
    return { ok: false, message: '来源模型中存在不存在的路由' };
  }

  for (const route of routes) {
    if (currentRouteId && route.id === currentRouteId) {
      return { ok: false, message: '显式群组不能引用自身作为来源模型' };
    }
    if (normalizeRouteMode(route.routeMode) === 'explicit_group') {
      return { ok: false, message: '显式群组只能选择精确模型路由作为来源模型' };
    }
    if (!isExactModelPattern(route.modelPattern)) {
      return { ok: false, message: '显式群组只能选择精确模型路由作为来源模型' };
    }
  }

  return { ok: true };
}

async function replaceRouteSourceRouteIds(routeId: number, sourceRouteIds: number[]): Promise<void> {
  await db.delete(schema.routeGroupSources).where(eq(schema.routeGroupSources.groupRouteId, routeId)).run();
  if (sourceRouteIds.length === 0) return;
  await db.insert(schema.routeGroupSources).values(
    sourceRouteIds.map((sourceRouteId) => ({
      groupRouteId: routeId,
      sourceRouteId,
    })),
  ).run();
}

async function clearDependentExplicitGroupSnapshotsBySourceRouteIds(sourceRouteIds: number[]): Promise<void> {
  const normalizedSourceRouteIds = Array.from(new Set(
    sourceRouteIds.filter((routeId): routeId is number => Number.isFinite(routeId) && routeId > 0),
  ));
  if (normalizedSourceRouteIds.length === 0) return;

  const rows = await db.select({ groupRouteId: schema.routeGroupSources.groupRouteId })
    .from(schema.routeGroupSources)
    .where(inArray(schema.routeGroupSources.sourceRouteId, normalizedSourceRouteIds))
    .all();
  const dependentRouteIdSet = new Set<number>();
  for (const row of rows) {
    const routeId = Number(row.groupRouteId);
    if (Number.isFinite(routeId) && routeId > 0) {
      dependentRouteIdSet.add(routeId);
    }
  }
  const dependentRouteIds = Array.from(dependentRouteIdSet);
  if (dependentRouteIds.length === 0) return;
  await clearRouteDecisionSnapshots(dependentRouteIds);
}

async function getDefaultTokenId(accountId: number): Promise<number | null> {
  const token = await db.select().from(schema.accountTokens)
    .where(and(
      eq(schema.accountTokens.accountId, accountId),
      eq(schema.accountTokens.enabled, true),
      eq(schema.accountTokens.isDefault, true),
      eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
    ))
    .get();
  return isUsableAccountToken(token ?? null) ? token!.id : null;
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

function selectPreferredTokenGroupForModel(
  modelName: string,
  availableGroups: string[],
  catalog: Awaited<ReturnType<typeof fetchModelPricingCatalog>>,
): string {
  const normalizedGroups = Array.from(new Set(
    availableGroups.map((group) => String(group || '').trim()).filter(Boolean),
  ));
  if (normalizedGroups.length === 0) return 'default';
  if (normalizedGroups.length === 1) return normalizedGroups[0] || 'default';

  const groupRatio = catalog?.groupRatio || {};
  const modelEntry = catalog?.models.find((item) => item.modelName === modelName)
    || catalog?.models.find((item) => isModelAliasEquivalent(item.modelName, modelName))
    || catalog?.models.find((item) => normalizedGroups.some((group) => item.enableGroups.includes(group)));
  const allowedGroups = new Set(modelEntry?.enableGroups || normalizedGroups);

  const rankedGroups = normalizedGroups
    .filter((group) => allowedGroups.has(group))
    .map((group) => ({
      group,
      ratio: typeof groupRatio[group] === 'number' && Number.isFinite(groupRatio[group])
        ? groupRatio[group]
        : Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.ratio - right.ratio || left.group.localeCompare(right.group));

  const preferred = rankedGroups.find((item) => Number.isFinite(item.ratio));
  return preferred?.group || normalizedGroups[0] || 'default';
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
    if (!requiresManagedAccountTokens({
      accessToken: row.accessToken,
      apiToken: row.apiToken,
      extraConfig: row.extraConfig,
    })) continue;

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
    const availableGroups = await adapter.getUserGroups(
      context.site.url,
      context.accessToken,
      platformUserId,
    ).catch(() => ['default']);
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
          eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
          eq(schema.tokenModelAvailability.available, true),
        ),
      )
      .all();

    let createdAny = false;
    const createdGroups: string[] = [];
    for (const modelName of context.modelNames) {
      if (Date.now() - startedAt > 20_000) break;

      const normalizedModelName = modelName.trim();
      if (!normalizedModelName) continue;

      const preferredGroup = selectPreferredTokenGroupForModel(
        normalizedModelName,
        availableGroups,
        pricingCatalog,
      );
      const preferredGroupKey = preferredGroup.trim().toLowerCase() || 'default';

      const hasPreferredCoverage = coverageRows.some((item) => {
        const availableModelName = (item.availableModelName || '').trim();
        if (!availableModelName) return false;
        if (availableModelName !== normalizedModelName && !isModelAliasEquivalent(availableModelName, normalizedModelName)) {
          return false;
        }
        const groupLabel = resolveTokenGroupLabel(item.tokenGroup, item.tokenName);
        return (groupLabel || 'default').trim().toLowerCase() === preferredGroupKey;
      });
      if (hasPreferredCoverage) continue;

      const created = await adapter.createApiToken(context.site.url, context.accessToken, platformUserId, {
        name: buildAutoTokenName(normalizedModelName, preferredGroup),
        group: preferredGroup,
      });
      if (!created) continue;

      createdAny = true;
      createdGroups.push(preferredGroup);
    }

    if (!createdAny) continue;

    let upstreamTokens = await adapter.getApiTokens(context.site.url, context.accessToken, platformUserId).catch(() => []);
    if (upstreamTokens.length === 0) {
      const single = await adapter.getApiToken(context.site.url, context.accessToken, platformUserId).catch(() => null);
      if (single) {
        upstreamTokens = [{
          name: 'default',
          key: single,
          enabled: true,
          tokenGroup: createdGroups[0] || 'default',
        }];
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
  return isUsableAccountToken(row ?? null);
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
        eq(schema.accountTokens.valueStatus, ACCOUNT_TOKEN_VALUE_STATUS_READY),
        eq(schema.accounts.status, 'active'),
        eq(schema.sites.status, 'active'),
      ),
    )
    .all();

  const result: Array<{ tokenId: number; accountId: number; sourceModel: string }> = [];
  for (const row of rows) {
    if (!isUsableAccountToken(row.account_tokens)) continue;
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
  await runWithSoftTimeout(
    ensurePreferredTokenCoverageForPattern(modelPattern),
    ROUTE_AUTOCREATE_SOFT_TIMEOUT_MS,
  );
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

type RouteChannelSummary = {
  channelCount: number;
  enabledChannelCount: number;
  siteNames: Set<string>;
};

async function fetchChannelsForRouteRows(routes: RouteRow[]): Promise<Map<number, any[]>> {
  if (routes.length === 0) return new Map();

  const explicitSourceRouteIds = Array.from(new Set(routes
    .filter((route) => isExplicitGroupRoute(route))
    .flatMap((route) => route.sourceRouteIds)));
  const explicitSourceRoutes = explicitSourceRouteIds.length > 0
    ? (await db.select({
      id: schema.tokenRoutes.id,
      modelPattern: schema.tokenRoutes.modelPattern,
      routeMode: schema.tokenRoutes.routeMode,
      enabled: schema.tokenRoutes.enabled,
    }).from(schema.tokenRoutes)
      .where(inArray(schema.tokenRoutes.id, explicitSourceRouteIds))
      .all())
    : [];
  const enabledExplicitSourceRouteIds = explicitSourceRoutes
    .filter((route) => route.enabled && !isExplicitGroupRoute(route) && isExactModelPattern(route.modelPattern))
    .map((route) => route.id);
  const actualRouteIds = Array.from(new Set([
    ...routes.filter((route) => !isExplicitGroupRoute(route)).map((route) => route.id),
    ...enabledExplicitSourceRouteIds,
  ]));
  if (actualRouteIds.length === 0) {
    return new Map(routes.map((route) => [route.id, []]));
  }

  const actualRouteById = new Map<number, { modelPattern: string; routeMode: string | null }>();
  for (const route of routes.filter((item) => !isExplicitGroupRoute(item))) {
    actualRouteById.set(route.id, { modelPattern: route.modelPattern, routeMode: route.routeMode ?? null });
  }
  for (const route of explicitSourceRoutes) {
    actualRouteById.set(route.id, { modelPattern: route.modelPattern, routeMode: route.routeMode ?? null });
  }

  const channelRows = await db.select().from(schema.routeChannels)
    .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .leftJoin(schema.accountTokens, eq(schema.routeChannels.tokenId, schema.accountTokens.id))
    .where(inArray(schema.routeChannels.routeId, actualRouteIds))
    .all();

  const channelsByActualRouteId = new Map<number, any[]>();

  for (const row of channelRows) {
    const routeId = row.route_channels.routeId;
    const actualRoute = actualRouteById.get(routeId);
    const fallbackSourceModel = actualRoute && !isExplicitGroupRoute(actualRoute) && isExactModelPattern(actualRoute.modelPattern)
      ? actualRoute.modelPattern
      : null;
    const resolvedSourceModel = (row.route_channels.sourceModel || fallbackSourceModel || '').trim();
    if (!channelsByActualRouteId.has(routeId)) channelsByActualRouteId.set(routeId, []);
    channelsByActualRouteId.get(routeId)!.push({
      ...row.route_channels,
      sourceModel: resolvedSourceModel || null,
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

  const channelsByRoute = new Map<number, any[]>();
  for (const route of routes) {
    if (isExplicitGroupRoute(route)) {
      channelsByRoute.set(route.id, route.sourceRouteIds.flatMap((sourceRouteId) => channelsByActualRouteId.get(sourceRouteId) || []));
      continue;
    }
    channelsByRoute.set(route.id, channelsByActualRouteId.get(route.id) || []);
  }

  return channelsByRoute;
}

async function fetchChannelsForRoutes(routeIds: number[]): Promise<Map<number, any[]>> {
  if (routeIds.length === 0) return new Map();
  return await fetchChannelsForRouteRows(await listRoutesWithSources()).then((channelsByRoute) => {
    const filtered = new Map<number, any[]>();
    for (const routeId of routeIds) {
      filtered.set(routeId, channelsByRoute.get(routeId) || []);
    }
    return filtered;
  });
}

async function buildRouteChannelSummaryMap(routes: RouteRow[]): Promise<Map<number, RouteChannelSummary>> {
  const channelsByRoute = await fetchChannelsForRouteRows(routes);
  const summaryByRoute = new Map<number, RouteChannelSummary>();
  for (const route of routes) {
    const channels = channelsByRoute.get(route.id) || [];
    const siteNames = new Set<string>();
    let enabledChannelCount = 0;
    for (const channel of channels) {
      if (channel.enabled) enabledChannelCount += 1;
      if (channel.site?.name) siteNames.add(channel.site.name);
    }
    summaryByRoute.set(route.id, {
      channelCount: channels.length,
      enabledChannelCount,
      siteNames,
    });
  }
  return summaryByRoute;
}

function parseDateTimeMs(value?: string | null): number | null {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isManualCheckinRequiredMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    text.includes('turnstile')
    || text.includes('manual')
    || text.includes('人工签到')
    || text.includes('人工验证')
  );
}

function isUnsupportedCheckinResultMessage(message?: string | null): boolean {
  if (!message) return false;
  const text = message.toLowerCase();
  return (
    text.includes('unsupported')
    || text.includes('not support checkin')
    || text.includes('not supported')
    || text.includes('不支持签到')
  );
}

function resolveRouteDiagnosticsLimit(rawLimit: unknown): number {
  const fallback = 120;
  if (rawLimit === undefined || rawLimit === null || rawLimit === '') return fallback;
  const parsed = Number.parseInt(String(rawLimit), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(20, Math.min(500, parsed));
}

export async function tokensRoutes(app: FastifyInstance) {
  // List routes with basic info only (lightweight for selectors)
  app.get('/api/routes/lite', async () => {
    return (await listRoutesWithSources()).map((route) => ({
      id: route.id,
      modelPattern: route.modelPattern,
      displayName: route.displayName,
      displayIcon: route.displayIcon,
      routeMode: route.routeMode,
      sourceRouteIds: route.sourceRouteIds,
      routingStrategy: route.routingStrategy,
      enabled: route.enabled,
    }));
  });

  // Route summary (no channel details) for first-screen rendering
  app.get('/api/routes/summary', async () => {
    const routes = await listRoutesWithSources();
    if (routes.length === 0) return [];
    const aggByRoute = await buildRouteChannelSummaryMap(routes);

    return routes.map((route) => {
      const agg = aggByRoute.get(route.id);
      return {
        id: route.id,
        modelPattern: route.modelPattern,
        displayName: route.displayName ?? null,
        displayIcon: route.displayIcon ?? null,
        routeMode: route.routeMode,
        sourceRouteIds: route.sourceRouteIds,
        modelMapping: route.modelMapping ?? null,
        routingStrategy: route.routingStrategy ?? 'weighted',
        enabled: route.enabled,
        channelCount: agg?.channelCount ?? 0,
        enabledChannelCount: agg?.enabledChannelCount ?? 0,
        siteNames: agg ? Array.from(agg.siteNames) : [],
        decisionSnapshot: null,
        decisionSnapshotAvailable: typeof route.decisionSnapshot === 'string' && route.decisionSnapshot.trim().length > 0,
        decisionRefreshedAt: route.decisionRefreshedAt ?? null,
      };
    });
  });

  app.get<{ Querystring: { limit?: string } }>('/api/routes/diagnostics', async (request) => {
    const itemLimit = resolveRouteDiagnosticsLimit(request.query.limit);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const [
      routeRows,
      channelRows,
      siteRows,
      accountRows,
      checkinLogs,
      siteProtocolConfigs,
      endpointRuntimeMemoryRows,
      endpointCredentialScopeRows,
      persistedEndpointProfiles,
      modelCircuitRows,
      siteRuntimeRows,
      unavailableModelRows,
    ] = await Promise.all([
      db.select({
        id: schema.tokenRoutes.id,
        enabled: schema.tokenRoutes.enabled,
      }).from(schema.tokenRoutes).all(),
      db.select({
        id: schema.routeChannels.id,
        routeId: schema.routeChannels.routeId,
        accountId: schema.routeChannels.accountId,
        sourceModel: schema.routeChannels.sourceModel,
        tokenId: schema.routeChannels.tokenId,
        enabled: schema.routeChannels.enabled,
        priority: schema.routeChannels.priority,
        weight: schema.routeChannels.weight,
        cooldownUntil: schema.routeChannels.cooldownUntil,
        lastFailAt: schema.routeChannels.lastFailAt,
        consecutiveFailCount: schema.routeChannels.consecutiveFailCount,
        failCount: schema.routeChannels.failCount,
        routeModelPattern: schema.tokenRoutes.modelPattern,
        routeEnabled: schema.tokenRoutes.enabled,
        siteId: schema.accounts.siteId,
        accountUsername: schema.accounts.username,
        accountStatus: schema.accounts.status,
        siteName: schema.sites.name,
        sitePlatform: schema.sites.platform,
        siteStatus: schema.sites.status,
      }).from(schema.routeChannels)
        .innerJoin(schema.tokenRoutes, eq(schema.routeChannels.routeId, schema.tokenRoutes.id))
        .innerJoin(schema.accounts, eq(schema.routeChannels.accountId, schema.accounts.id))
        .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
        .all(),
      db.select({
        id: schema.sites.id,
        name: schema.sites.name,
        url: schema.sites.url,
        platform: schema.sites.platform,
        status: schema.sites.status,
      }).from(schema.sites).all(),
      db.select({
        id: schema.accounts.id,
        siteId: schema.accounts.siteId,
        username: schema.accounts.username,
        status: schema.accounts.status,
        checkinEnabled: schema.accounts.checkinEnabled,
        lastCheckinAt: schema.accounts.lastCheckinAt,
        extraConfig: schema.accounts.extraConfig,
      }).from(schema.accounts).all(),
      db.select({
        accountId: schema.checkinLogs.accountId,
        status: schema.checkinLogs.status,
        message: schema.checkinLogs.message,
        createdAt: schema.checkinLogs.createdAt,
      }).from(schema.checkinLogs)
        .orderBy(desc(schema.checkinLogs.createdAt))
        .limit(20_000)
        .all(),
      listSiteProtocolConfigs(),
      getUpstreamEndpointRuntimeMemorySnapshot(nowMs),
      getEndpointMemoryCredentialScopeSnapshot(),
      listPersistedUpstreamProtocolProfiles(nowMs),
      getModelCircuitSnapshots(nowMs),
      listSiteRuntimeHealthSnapshots(nowMs),
      listPersistedUnavailableModelEntries(),
    ]);

    const siteById = new Map<number, {
      id: number;
      name: string;
      url: string;
      platform: string;
      status: string;
    }>();
    for (const site of siteRows) {
      siteById.set(site.id, {
        id: site.id,
        name: site.name || `site-${site.id}`,
        url: site.url || '',
        platform: site.platform || '',
        status: site.status || 'active',
      });
    }

    const accountById = new Map<number, {
      id: number;
      siteId: number;
      username: string | null;
      status: string | null;
      checkinEnabled: boolean;
      lastCheckinAt: string | null;
      extraConfig: string | null;
    }>();
    for (const account of accountRows) {
      accountById.set(account.id, {
        id: account.id,
        siteId: account.siteId,
        username: account.username ?? null,
        status: account.status ?? null,
        checkinEnabled: account.checkinEnabled === true,
        lastCheckinAt: account.lastCheckinAt ?? null,
        extraConfig: account.extraConfig ?? null,
      });
    }

    const latestCheckinByAccount = new Map<number, CheckinLogSnapshot>();
    for (const log of checkinLogs) {
      if (!Number.isFinite(log.accountId) || log.accountId <= 0) continue;
      if (latestCheckinByAccount.has(log.accountId)) continue;
      latestCheckinByAccount.set(log.accountId, {
        accountId: log.accountId,
        status: log.status ?? null,
        message: log.message ?? null,
        createdAt: log.createdAt ?? null,
      });
    }

    const routeSummary: RouteDiagnosticsRouteSummary = {
      routeCount: routeRows.length,
      enabledRouteCount: routeRows.filter((row) => row.enabled === true).length,
      channelCount: channelRows.length,
      enabledChannelCount: channelRows.filter((row) => row.enabled === true).length,
    };

    const channelById = new Map<number, {
      id: number;
      routeId: number;
      routeModelPattern: string;
      routeEnabled: boolean;
      accountId: number;
      accountUsername: string | null;
      accountStatus: string | null;
      siteId: number;
      siteName: string;
      sitePlatform: string;
      siteStatus: string;
      sourceModel: string | null;
      tokenId: number | null;
      enabled: boolean;
      priority: number;
      weight: number;
      cooldownUntil: string | null;
      lastFailAt: string | null;
      consecutiveFailCount: number;
      failCount: number;
    }>();
    for (const channel of channelRows) {
      channelById.set(channel.id, {
        id: channel.id,
        routeId: channel.routeId,
        routeModelPattern: channel.routeModelPattern || '',
        routeEnabled: channel.routeEnabled === true,
        accountId: channel.accountId,
        accountUsername: channel.accountUsername ?? null,
        accountStatus: channel.accountStatus ?? null,
        siteId: channel.siteId,
        siteName: channel.siteName || `site-${channel.siteId}`,
        sitePlatform: channel.sitePlatform || '',
        siteStatus: channel.siteStatus || 'active',
        sourceModel: channel.sourceModel ?? null,
        tokenId: typeof channel.tokenId === 'number' && Number.isFinite(channel.tokenId) ? channel.tokenId : null,
        enabled: channel.enabled === true,
        priority: Number.isFinite(channel.priority) ? channel.priority : 0,
        weight: Number.isFinite(channel.weight) ? channel.weight : 0,
        cooldownUntil: channel.cooldownUntil ?? null,
        lastFailAt: channel.lastFailAt ?? null,
        consecutiveFailCount: Number.isFinite(channel.consecutiveFailCount) ? channel.consecutiveFailCount : 0,
        failCount: Number.isFinite(channel.failCount) ? channel.failCount : 0,
      });
    }

    const modelCircuitItems = modelCircuitRows.map((row) => {
      const channel = channelById.get(row.channelId);
      return {
        channelId: row.channelId,
        modelName: row.modelName,
        state: row.state,
        failCount: row.failCount,
        openedAtMs: row.openedAt,
        openUntilMs: row.openUntil,
        lastErrorAtMs: row.lastErrorAt,
        lastSuccessAtMs: row.lastSuccessAt,
        probeInFlight: row.probeInFlight,
        status: row.status,
        routeId: channel?.routeId ?? null,
        routeModelPattern: channel?.routeModelPattern ?? null,
        accountId: channel?.accountId ?? null,
        accountUsername: channel?.accountUsername ?? null,
        siteId: channel?.siteId ?? null,
        siteName: channel?.siteName ?? null,
      };
    });
    const modelCircuitOpenCount = modelCircuitItems.filter((item) => item.status.isOpen).length;
    const modelCircuitHalfOpenCount = modelCircuitItems.filter((item) => item.status.isHalfOpen).length;

    const siteRuntimeItems = siteRuntimeRows.map((row) => {
      const site = siteById.get(row.siteId);
      return {
        ...row,
        siteName: site?.name || `site-${row.siteId}`,
        sitePlatform: site?.platform || '',
        siteStatus: site?.status || 'active',
        breakerUntil: row.breakerUntilMs ? new Date(row.breakerUntilMs).toISOString() : null,
        lastFailureAt: row.lastFailureAtMs ? new Date(row.lastFailureAtMs).toISOString() : null,
        lastSuccessAt: row.lastSuccessAtMs ? new Date(row.lastSuccessAtMs).toISOString() : null,
      };
    });
    const siteRuntimeBreakerOpenCount = siteRuntimeItems.filter((item) => item.breakerOpen).length;
    const siteRuntimePenalizedCount = siteRuntimeItems.filter((item) => item.multiplier < 0.999).length;

    const unavailableModelItems = unavailableModelRows.map((row) => {
      if (row.scope === 'token') {
        const channel = row.ownerId > 0
          ? channelRows.find((item) => item.tokenId === row.ownerId)
          : null;
        return {
          ...row,
          tokenId: row.ownerId,
          accountId: channel?.accountId ?? null,
          accountUsername: channel?.accountUsername ?? null,
          siteId: channel?.siteId ?? null,
          siteName: channel?.siteName ?? null,
        };
      }
      const account = accountById.get(row.ownerId);
      const site = account ? siteById.get(account.siteId) : null;
      return {
        ...row,
        tokenId: null,
        accountId: account?.id ?? row.ownerId,
        accountUsername: account?.username ?? null,
        siteId: site?.id ?? null,
        siteName: site?.name ?? null,
      };
    });
    const unavailableBlockingCount = unavailableModelItems.filter((item) => item.stillBlocking).length;

    const endpointRuntimeItems = endpointRuntimeMemoryRows.map((row) => {
      const siteId = Number.parseInt(String(row.key.split(':')[0] || ''), 10);
      const site = Number.isFinite(siteId) ? siteById.get(siteId) : null;
      return {
        ...row,
        siteId: Number.isFinite(siteId) ? siteId : null,
        siteName: site?.name ?? null,
      };
    });
    const endpointCredentialScopeItems = endpointCredentialScopeRows.map((row) => {
      const site = siteById.get(row.siteId);
      const account = row.accountId != null ? accountById.get(row.accountId) : null;
      return {
        ...row,
        siteName: site?.name ?? null,
        accountUsername: account?.username ?? null,
      };
    });
    const persistedEndpointProfileItems = persistedEndpointProfiles.map((row) => {
      const siteId = Number.parseInt(String(row.key.split(':')[0] || ''), 10);
      const site = Number.isFinite(siteId) ? siteById.get(siteId) : null;
      return {
        ...row,
        siteId: Number.isFinite(siteId) ? siteId : null,
        siteName: site?.name ?? null,
      };
    });

    const siteProfiles = siteRows.map((site) => {
      const protocolConfig = siteProtocolConfigs[site.id];
      const siteAccounts = accountRows.filter((account) => account.siteId === site.id);
      const schedulableAccounts = siteAccounts.filter((account) => (
        account.checkinEnabled === true
        && isSchedulableCheckinAccountStatus(account.status)
        && site.status !== 'disabled'
      ));
      return {
        siteId: site.id,
        siteName: site.name || `site-${site.id}`,
        siteUrl: site.url || '',
        platform: site.platform || '',
        status: site.status || 'active',
        protocolMode: protocolConfig?.mode === 'manual' ? 'manual' : 'auto',
        supportedEndpoints: protocolConfig?.supportedEndpoints || [],
        preferredEndpoint: protocolConfig?.preferredEndpoint || null,
        protocolUpdatedAt: protocolConfig?.updatedAtMs ? new Date(protocolConfig.updatedAtMs).toISOString() : null,
        schedulableCheckinAccounts: schedulableAccounts.length,
        activeAccounts: siteAccounts.filter((account) => account.status === 'active').length,
        expiredAccounts: siteAccounts.filter((account) => account.status === 'expired').length,
        degradedAccounts: siteAccounts.filter((account) => (
          extractRuntimeHealth(account.extraConfig)?.state === 'degraded'
        )).length,
      };
    });
    const manualSiteProfileCount = siteProfiles.filter((item) => item.protocolMode === 'manual').length;

    const checkinIntervalMs = Math.max(1, config.checkinIntervalHours) * 60 * 60 * 1000;
    const checkinCronFallbackMs = 24 * 60 * 60 * 1000;
    const checkinDueThresholdMs = config.checkinScheduleMode === 'interval'
      ? checkinIntervalMs
      : checkinCronFallbackMs;

    const checkinSiteTodoMap = new Map<number, {
      siteId: number;
      siteName: string;
      siteStatus: string;
      totalSchedulableAccounts: number;
      dueNowCount: number;
      manualRequiredCount: number;
      unsupportedCount: number;
      failedRecentCount: number;
      expiredCount: number;
      unhealthyCount: number;
      attentionCount: number;
      sampleAccounts: Array<{
        accountId: number;
        username: string | null;
        status: string | null;
        dueNow: boolean;
        requiresManual: boolean;
        unsupported: boolean;
        failedRecent: boolean;
        runtimeHealth: ReturnType<typeof extractRuntimeHealth>;
        latestCheckinStatus: string | null;
        latestCheckinMessage: string | null;
        latestCheckinAt: string | null;
      }>;
    }>();

    for (const account of accountRows) {
      const site = siteById.get(account.siteId);
      if (!site) continue;
      if (site.status === 'disabled') continue;
      if (account.checkinEnabled !== true) continue;
      if (!isSchedulableCheckinAccountStatus(account.status)) continue;

      const latest = latestCheckinByAccount.get(account.id) || null;
      const lastCheckinAtMs = parseDateTimeMs(account.lastCheckinAt);
      const dueNow = !lastCheckinAtMs || (nowMs - lastCheckinAtMs) >= checkinDueThresholdMs;
      const requiresManual = latest?.status === 'skipped' && isManualCheckinRequiredMessage(latest.message);
      const unsupported = latest?.status === 'skipped' && isUnsupportedCheckinResultMessage(latest.message);
      const failedRecent = latest?.status === 'failed';
      const runtimeHealth = extractRuntimeHealth(account.extraConfig);
      const unhealthy = runtimeHealth?.state === 'unhealthy';
      const expired = account.status === 'expired';
      const attention = requiresManual || failedRecent || unhealthy || expired;

      if (!checkinSiteTodoMap.has(site.id)) {
        checkinSiteTodoMap.set(site.id, {
          siteId: site.id,
          siteName: site.name,
          siteStatus: site.status,
          totalSchedulableAccounts: 0,
          dueNowCount: 0,
          manualRequiredCount: 0,
          unsupportedCount: 0,
          failedRecentCount: 0,
          expiredCount: 0,
          unhealthyCount: 0,
          attentionCount: 0,
          sampleAccounts: [],
        });
      }

      const bucket = checkinSiteTodoMap.get(site.id)!;
      bucket.totalSchedulableAccounts += 1;
      if (dueNow) bucket.dueNowCount += 1;
      if (requiresManual) bucket.manualRequiredCount += 1;
      if (unsupported) bucket.unsupportedCount += 1;
      if (failedRecent) bucket.failedRecentCount += 1;
      if (expired) bucket.expiredCount += 1;
      if (unhealthy) bucket.unhealthyCount += 1;
      if (attention) bucket.attentionCount += 1;

      if (attention && bucket.sampleAccounts.length < 5) {
        bucket.sampleAccounts.push({
          accountId: account.id,
          username: account.username ?? null,
          status: account.status ?? null,
          dueNow,
          requiresManual,
          unsupported,
          failedRecent,
          runtimeHealth,
          latestCheckinStatus: latest?.status ?? null,
          latestCheckinMessage: latest?.message ?? null,
          latestCheckinAt: latest?.createdAt ?? null,
        });
      }
    }

    const checkinTodoSites = Array.from(checkinSiteTodoMap.values())
      .sort((left, right) => (
        right.attentionCount - left.attentionCount
        || right.dueNowCount - left.dueNowCount
        || left.siteName.localeCompare(right.siteName, undefined, { sensitivity: 'base' })
      ));

    const checkinTodoSummary = {
      scheduleMode: config.checkinScheduleMode,
      intervalHours: config.checkinIntervalHours,
      totalSchedulableAccounts: checkinTodoSites.reduce((sum, item) => sum + item.totalSchedulableAccounts, 0),
      dueNowCount: checkinTodoSites.reduce((sum, item) => sum + item.dueNowCount, 0),
      manualRequiredCount: checkinTodoSites.reduce((sum, item) => sum + item.manualRequiredCount, 0),
      unsupportedCount: checkinTodoSites.reduce((sum, item) => sum + item.unsupportedCount, 0),
      failedRecentCount: checkinTodoSites.reduce((sum, item) => sum + item.failedRecentCount, 0),
      attentionCount: checkinTodoSites.reduce((sum, item) => sum + item.attentionCount, 0),
    };

    return {
      success: true,
      generatedAt: nowIso,
      limits: {
        itemLimit,
      },
      routeSummary,
      snapshotCounts: {
        endpointRuntimeMemory: endpointRuntimeItems.length,
        endpointCredentialScopes: endpointCredentialScopeItems.length,
        persistedEndpointProfiles: persistedEndpointProfileItems.length,
        modelCircuits: modelCircuitItems.length,
        siteRuntimeStates: siteRuntimeItems.length,
        unavailableModels: unavailableModelItems.length,
        siteProfiles: siteProfiles.length,
        checkinTodoSites: checkinTodoSites.length,
      },
      endpointRuntimeMemory: {
        total: endpointRuntimeItems.length,
        items: endpointRuntimeItems.slice(0, itemLimit),
      },
      endpointCredentialScopes: {
        total: endpointCredentialScopeItems.length,
        items: endpointCredentialScopeItems.slice(0, itemLimit),
      },
      persistedEndpointProfiles: {
        total: persistedEndpointProfileItems.length,
        items: persistedEndpointProfileItems.slice(0, itemLimit),
      },
      modelCircuits: {
        total: modelCircuitItems.length,
        openCount: modelCircuitOpenCount,
        halfOpenCount: modelCircuitHalfOpenCount,
        items: modelCircuitItems.slice(0, itemLimit),
      },
      siteRuntimeHealth: {
        total: siteRuntimeItems.length,
        breakerOpenCount: siteRuntimeBreakerOpenCount,
        penalizedCount: siteRuntimePenalizedCount,
        items: siteRuntimeItems.slice(0, itemLimit),
      },
      unavailableModels: {
        total: unavailableModelItems.length,
        blockingCount: unavailableBlockingCount,
        items: unavailableModelItems.slice(0, itemLimit),
      },
      siteProfiles: {
        total: siteProfiles.length,
        manualConfiguredCount: manualSiteProfileCount,
        items: siteProfiles.slice(0, itemLimit),
      },
      checkinTodo: {
        ...checkinTodoSummary,
        sites: checkinTodoSites.slice(0, itemLimit),
      },
    };
  });

  // Get channels for a single route (on-demand loading)
  app.get<{ Params: { id: string } }>('/api/routes/:id/channels', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    const route = await getRouteWithSources(routeId);
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    const channelsByRoute = await fetchChannelsForRouteRows([route]);
    return channelsByRoute.get(routeId) || [];
  });

  // Batch add channels to a route
  app.post<{ Params: { id: string }; Body: { channels: Array<{ accountId: number; tokenId?: number; sourceModel?: string }> } }>('/api/routes/:id/channels/batch', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    const body = request.body;

    const route = await getRouteWithSources(routeId);
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    if (isExplicitGroupRoute(route)) {
      return reply.code(400).send({ success: false, message: '显式群组不支持直接维护通道' });
    }

    if (!body?.channels || !Array.isArray(body.channels) || body.channels.length === 0) {
      return reply.code(400).send({ success: false, message: 'channels 必须是非空数组' });
    }

    const existingChannels = await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, routeId))
      .all();
    const existingPairs = new Set<string>(
      existingChannels.map((channel) => {
        const tokenId = typeof channel.tokenId === 'number' && Number.isFinite(channel.tokenId) ? channel.tokenId : 0;
        const sourceModel = (channel.sourceModel || '').trim().toLowerCase();
        return `${channel.accountId}::${tokenId}::${sourceModel}`;
      }),
    );

    let created = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const item of body.channels) {
      if (!item?.accountId || typeof item.accountId !== 'number') {
        errors.push('无效的 accountId');
        continue;
      }

      const sourceModel = typeof item.sourceModel === 'string'
        ? item.sourceModel.trim()
        : (isExactModelPattern(route.modelPattern) ? route.modelPattern.trim() : '');
      const effectiveTokenId = item.tokenId ?? await getDefaultTokenId(item.accountId);

      if (item.tokenId && !await checkTokenBelongsToAccount(item.tokenId, item.accountId)) {
        errors.push(`令牌 ${item.tokenId} 不属于账号 ${item.accountId}`);
        continue;
      }

      const tokenIdForKey = typeof effectiveTokenId === 'number' && Number.isFinite(effectiveTokenId) ? effectiveTokenId : 0;
      const pairKey = `${item.accountId}::${tokenIdForKey}::${sourceModel.toLowerCase()}`;
      if (existingPairs.has(pairKey)) {
        skipped += 1;
        continue;
      }

      try {
        await db.insert(schema.routeChannels).values({
          routeId,
          accountId: item.accountId,
          tokenId: effectiveTokenId,
          sourceModel: sourceModel || null,
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

    if (created > 0) {
      await clearRouteDecisionSnapshot(routeId);
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds([routeId]);
      invalidateTokenRouterCache();
    }

    return { success: true, created, skipped, errors };
  });

  // List all routes
  app.get('/api/routes', async () => {
    const routes = await listRoutesWithSources();
    if (routes.length === 0) return [];

    const channelsByRoute = await fetchChannelsForRouteRows(routes);

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
  app.post<{ Body: { routeMode?: string; modelPattern?: string; displayName?: string; displayIcon?: string; modelMapping?: string; routingStrategy?: string; enabled?: boolean; sourceRouteIds?: number[] } }>('/api/routes', async (request, reply) => {
    const body = request.body;
    const routeMode = normalizeRouteMode(body.routeMode);
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    const sourceRouteIds = normalizeSourceRouteIdsInput(body.sourceRouteIds);
    const modelPattern = routeMode === 'explicit_group'
      ? displayName
      : (typeof body.modelPattern === 'string' ? body.modelPattern.trim() : '');

    if (routeMode === 'explicit_group') {
      if (!displayName) {
        return reply.code(400).send({ success: false, message: '显式群组必须填写对外模型名' });
      }
      const validation = await validateExplicitGroupSourceRoutes(sourceRouteIds);
      if (!validation.ok) {
        return reply.code(400).send({ success: false, message: validation.message });
      }
    } else if (!modelPattern) {
      return reply.code(400).send({ success: false, message: '模型匹配不能为空' });
    }

    const insertedRoute = await db.insert(schema.tokenRoutes).values({
      modelPattern,
      displayName: displayName || body.displayName,
      displayIcon: body.displayIcon,
      routeMode,
      modelMapping: body.modelMapping,
      routingStrategy: normalizeRouteRoutingStrategy(body.routingStrategy),
      enabled: body.enabled ?? true,
    }).run();
    const routeId = Number(insertedRoute.lastInsertRowid || 0);
    if (routeId <= 0) {
      return { success: false, message: '创建路由失败' };
    }
    const route = await getRouteWithSources(routeId);
    if (!route) {
      return { success: false, message: '创建路由失败' };
    }

    if (routeMode === 'explicit_group') {
      await replaceRouteSourceRouteIds(route.id, sourceRouteIds);
      for (const sourceRouteId of sourceRouteIds) {
        const sourceRoute = await getRouteWithSources(sourceRouteId);
        if (!sourceRoute) continue;
        await populateRouteChannelsByModelPattern(sourceRoute.id, sourceRoute.modelPattern);
      }
    } else {
      await populateRouteChannelsByModelPattern(route.id, modelPattern);
    }
    invalidateTokenRouterCache();
    return await getRouteWithSources(routeId);
  });

  // Update a route
  app.put<{ Params: { id: string }; Body: any }>('/api/routes/:id', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    const body = request.body as Record<string, unknown>;
    const existingRoute = await getRouteWithSources(id);
    if (!existingRoute) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    const routeMode = normalizeRouteMode(body.routeMode ?? existingRoute.routeMode);
    if (routeMode !== existingRoute.routeMode) {
      return reply.code(400).send({ success: false, message: '暂不支持在不同群组模式之间直接切换' });
    }

    const updates: Record<string, unknown> = {};
    let nextModelPattern = existingRoute.modelPattern;
    let nextDisplayName = existingRoute.displayName ?? '';
    let nextSourceRouteIds = existingRoute.sourceRouteIds;

    if (body.displayName !== undefined) {
      nextDisplayName = String(body.displayName || '').trim();
      updates.displayName = nextDisplayName || null;
    }
    if (body.displayIcon !== undefined) updates.displayIcon = body.displayIcon;
    if (routeMode === 'explicit_group') {
      nextModelPattern = nextDisplayName;
      updates.modelPattern = nextModelPattern;
      if (body.sourceRouteIds !== undefined) {
        nextSourceRouteIds = normalizeSourceRouteIdsInput(body.sourceRouteIds);
      }
      if (!nextDisplayName) {
        return reply.code(400).send({ success: false, message: '显式群组必须填写对外模型名' });
      }
      const validation = await validateExplicitGroupSourceRoutes(nextSourceRouteIds, id);
      if (!validation.ok) {
        return reply.code(400).send({ success: false, message: validation.message });
      }
    } else if (body.modelPattern !== undefined) {
      nextModelPattern = String(body.modelPattern);
      updates.modelPattern = nextModelPattern;
    }
    if (body.modelMapping !== undefined) updates.modelMapping = body.modelMapping;
    if (body.routingStrategy !== undefined) updates.routingStrategy = normalizeRouteRoutingStrategy(body.routingStrategy);
    if (body.enabled !== undefined) updates.enabled = body.enabled;
    if (body.routeMode !== undefined) updates.routeMode = routeMode;
    updates.updatedAt = new Date().toISOString();

    await db.update(schema.tokenRoutes).set(updates).where(eq(schema.tokenRoutes.id, id)).run();
    if (routeMode === 'explicit_group' && body.sourceRouteIds !== undefined) {
      await replaceRouteSourceRouteIds(id, nextSourceRouteIds);
      for (const sourceRouteId of nextSourceRouteIds) {
        const sourceRoute = await getRouteWithSources(sourceRouteId);
        if (!sourceRoute) continue;
        await populateRouteChannelsByModelPattern(sourceRoute.id, sourceRoute.modelPattern);
      }
    }
    const modelPatternChanged = nextModelPattern !== existingRoute.modelPattern;
    const routeBehaviorChanged = modelPatternChanged
      || (routeMode === 'explicit_group' && body.sourceRouteIds !== undefined)
      || body.modelMapping !== undefined
      || body.routingStrategy !== undefined
      || body.enabled !== undefined;
    if (routeMode === 'pattern' && modelPatternChanged) {
      await rebuildAutomaticRouteChannelsByModelPattern(id, nextModelPattern);
    }
    if (routeBehaviorChanged) {
      await clearRouteDecisionSnapshot(id);
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds([id]);
    }
    invalidateTokenRouterCache();
    return await getRouteWithSources(id);
  });

  // Delete a route
  app.delete<{ Params: { id: string } }>('/api/routes/:id', async (request) => {
    const id = parseInt(request.params.id, 10);
    await clearDependentExplicitGroupSnapshotsBySourceRouteIds([id]);
    await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, id)).run();
    invalidateTokenRouterCache();
    return { success: true };
  });

  // Add a channel to a route
  app.post<{ Params: { id: string }; Body: { accountId: number; tokenId?: number; sourceModel?: string; priority?: number; weight?: number } }>('/api/routes/:id/channels', async (request, reply) => {
    const routeId = parseInt(request.params.id, 10);
    const body = request.body;

    const route = await getRouteWithSources(routeId);
    if (!route) {
      return reply.code(404).send({ success: false, message: '路由不存在' });
    }
    if (isExplicitGroupRoute(route)) {
      return reply.code(400).send({ success: false, message: '显式群组不支持直接维护通道' });
    }

    const sourceModel = typeof body.sourceModel === 'string'
      ? body.sourceModel.trim()
      : (isExactModelPattern(route.modelPattern) ? route.modelPattern.trim() : '');
    const effectiveTokenId = body.tokenId ?? await getDefaultTokenId(body.accountId);

    if (body.tokenId && !await checkTokenBelongsToAccount(body.tokenId, body.accountId)) {
      return reply.code(400).send({ success: false, message: '令牌不存在或不属于当前账号' });
    }

    if (isExactModelPattern(route.modelPattern) && effectiveTokenId && !await tokenSupportsModel(effectiveTokenId, route.modelPattern)) {
      return reply.code(400).send({ success: false, message: '该令牌不支持当前模型' });
    }

    const duplicate = (await db.select().from(schema.routeChannels)
      .where(eq(schema.routeChannels.routeId, routeId))
      .all())
      .some((channel) =>
        channel.accountId === body.accountId
        && (channel.tokenId ?? null) === (body.tokenId ?? null)
        && (channel.sourceModel || '').trim().toLowerCase() === sourceModel.toLowerCase(),
      );
    if (duplicate) {
      return reply.code(400).send({ success: false, message: '该来源模型的通道已存在' });
    }

    const insertedChannel = await db.insert(schema.routeChannels).values({
      routeId,
      accountId: body.accountId,
      tokenId: body.tokenId,
      sourceModel: sourceModel || null,
      priority: body.priority ?? 0,
      weight: body.weight ?? 10,
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
    await clearDependentExplicitGroupSnapshotsBySourceRouteIds([routeId]);
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
    await clearDependentExplicitGroupSnapshotsBySourceRouteIds(existingChannels.map((channel) => channel.routeId));
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
    await clearDependentExplicitGroupSnapshotsBySourceRouteIds([channel.routeId]);
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
      await clearDependentExplicitGroupSnapshotsBySourceRouteIds([channel.routeId]);
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

