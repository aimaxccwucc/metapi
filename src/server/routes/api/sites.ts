import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { detectSite } from '../../services/siteDetector.js';
import { invalidateSiteProxyCache, parseSiteProxyUrlInput } from '../../services/siteProxy.js';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { invalidateTokenRouterCache } from '../../services/tokenRouter.js';
import { invalidateModelTokenCandidatesCache } from '../../services/modelTokenCandidatesCache.js';
import { invalidateModelsMarketplaceCache } from '../../services/modelsMarketplaceCache.js';
import { parseSiteCustomHeadersInput } from '../../services/siteCustomHeaders.js';
import { getSub2ApiSubscriptionFromExtraConfig } from '../../services/accountExtraConfig.js';
import { maskToken, resolveAccountTokenValueStatus } from '../../services/accountTokenService.js';
import { fetchModelPricingCatalog } from '../../services/modelPricingService.js';
import {
  deleteSiteProtocolConfig,
  flushSiteProtocolConfigPersistence,
  getSiteProtocolConfig,
  listSiteProtocolConfigs,
  normalizeSiteProtocolConfigInput,
  sanitizeSiteProtocolConfigForPlatform,
  resolveSiteProtocolConfig,
  upsertSiteProtocolConfig,
} from '../../services/siteProtocolConfigService.js';
import { SiteProtocolProbeError, probeSiteProtocol } from '../../services/siteProtocolProbeService.js';
import { queueCoverageHealingTask } from '../../services/tokenCoverageAutoProvisionService.js';

function normalizeSiteStatus(input: unknown): 'active' | 'disabled' | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') return null;
  const status = input.trim().toLowerCase();
  if (status === 'active' || status === 'disabled') return status;
  return null;
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

function normalizeUseSystemProxyFlag(input: unknown): boolean | null {
  return normalizePinnedFlag(input);
}

function normalizeSortOrder(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  const parsed = Number.parseInt(String(input), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed);
}

function normalizeGlobalWeight(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(0.01, Math.min(100, Number(parsed.toFixed(3))));
}

function normalizeOptionalExternalCheckinUrl(input: unknown): {
  valid: boolean;
  present: boolean;
  url: string | null;
} {
  if (input === undefined) {
    return { valid: true, present: false, url: null };
  }
  if (input === null) {
    return { valid: true, present: true, url: null };
  }
  if (typeof input !== 'string') {
    return { valid: false, present: true, url: null };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: true, present: true, url: null };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, present: true, url: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, present: true, url: null };
  }
  return { valid: true, present: true, url: parsed.toString().replace(/\/+$/, '') };
}

function normalizeSiteUrl(input: string): string {
  const trimmed = String(input || '').trim();
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return parsed.origin;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function normalizeTokenGroup(input?: string | null): string {
  const trimmed = String(input || '').trim();
  return trimmed || 'default';
}

function normalizeModelName(input?: string | null): string {
  return String(input || '').trim();
}

type SiteDetailAccountRow = typeof schema.accounts.$inferSelect;
type SiteDetailTokenRow = typeof schema.accountTokens.$inferSelect;
type SiteDetailGroupSource = 'pricing' | 'token' | 'default';
type SiteDetailPricing = {
  quotaType: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  cacheReadPerMillion?: number;
  cacheCreationPerMillion?: number;
  perCallInput?: number;
  perCallOutput?: number;
  perCallTotal?: number;
} | null;

type SiteSubscriptionAggregate = {
  activeCount: number;
  totalUsedUsd: number;
  totalMonthlyLimitUsd: number | null;
  totalRemainingUsd: number | null;
  nextExpiresAt: string | null;
  planNames: string[];
  updatedAt: number | null;
};

function roundMetric(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function pickEarlierIsoDate(current?: string | null, next?: string | null): string | null {
  if (!current) return next || null;
  if (!next) return current;
  const currentMs = Date.parse(current);
  const nextMs = Date.parse(next);
  if (!Number.isFinite(currentMs)) return next;
  if (!Number.isFinite(nextMs)) return current;
  return nextMs < currentMs ? next : current;
}

function aggregateSiteSubscription(
  current: SiteSubscriptionAggregate | undefined,
  extraConfig?: string | null,
): SiteSubscriptionAggregate | undefined {
  const stored = getSub2ApiSubscriptionFromExtraConfig(extraConfig);
  if (!stored) return current;

  const planNames = new Set(current?.planNames || []);
  let totalMonthlyLimitUsd = current?.totalMonthlyLimitUsd ?? null;
  let nextExpiresAt = current?.nextExpiresAt ?? null;

  for (const item of stored.subscriptions) {
    if (item.groupName) planNames.add(item.groupName);
    if (typeof item.monthlyLimitUsd === 'number' && Number.isFinite(item.monthlyLimitUsd)) {
      totalMonthlyLimitUsd = roundMetric((totalMonthlyLimitUsd ?? 0) + item.monthlyLimitUsd);
    }
    nextExpiresAt = pickEarlierIsoDate(nextExpiresAt, item.expiresAt);
  }

  const totalUsedUsd = roundMetric((current?.totalUsedUsd || 0) + stored.totalUsedUsd);
  const totalRemainingUsd = totalMonthlyLimitUsd == null
    ? null
    : roundMetric(Math.max(0, totalMonthlyLimitUsd - totalUsedUsd));

  return {
    activeCount: (current?.activeCount || 0) + stored.activeCount,
    totalUsedUsd,
    totalMonthlyLimitUsd,
    totalRemainingUsd,
    nextExpiresAt,
    planNames: Array.from(planNames),
    updatedAt: Math.max(current?.updatedAt || 0, stored.updatedAt || 0) || null,
  };
}

export async function sitesRoutes(app: FastifyInstance) {
  function invalidateSiteCaches() {
    invalidateSiteProxyCache();
    invalidateTokenRouterCache();
    invalidateModelTokenCandidatesCache();
    invalidateModelsMarketplaceCache();
  }

  async function applySiteStatusSideEffects(
    siteId: number,
    existingSiteName: string,
    normalizedStatus: 'active' | 'disabled',
  ) {
    const now = new Date().toISOString();
    if (normalizedStatus === 'disabled') {
      await db.update(schema.accounts)
        .set({ status: 'disabled', updatedAt: now })
        .where(eq(schema.accounts.siteId, siteId))
        .run();

      try {
        const createdAt = formatUtcSqlDateTime(new Date());
        await db.insert(schema.events).values({
          type: 'status',
          title: '站点已禁用',
          message: `${existingSiteName} 已禁用，关联账号已全部置为禁用`,
          level: 'warning',
          relatedId: siteId,
          relatedType: 'site',
          createdAt,
        }).run();
      } catch { }
      return;
    }

    await db.update(schema.accounts)
      .set({ status: 'active', updatedAt: now })
      .where(and(eq(schema.accounts.siteId, siteId), eq(schema.accounts.status, 'disabled')))
      .run();

    try {
      const createdAt = formatUtcSqlDateTime(new Date());
      await db.insert(schema.events).values({
        type: 'status',
        title: '站点已启用',
        message: `${existingSiteName} 已启用，关联禁用账号已恢复为活跃`,
        level: 'info',
        relatedId: siteId,
        relatedType: 'site',
        createdAt,
      }).run();
    } catch { }
  }

  function normalizeBatchIds(input: unknown): number[] {
    if (!Array.isArray(input)) return [];
    return input
      .map((item) => Number.parseInt(String(item), 10))
      .filter((id) => Number.isFinite(id) && id > 0);
  }

  // List all sites
  app.get('/api/sites', async () => {
    const siteRows = await db.select().from(schema.sites).all();
    const protocolConfigs = await listSiteProtocolConfigs();
    const accountRows = await db.select({
      siteId: schema.accounts.siteId,
      balance: schema.accounts.balance,
      extraConfig: schema.accounts.extraConfig,
    }).from(schema.accounts).all();

    const totalBalanceBySiteId: Record<number, number> = {};
    const accountCountBySiteId: Record<number, number> = {};
    const subscriptionBySiteId: Record<number, SiteSubscriptionAggregate | undefined> = {};
    for (const row of accountRows) {
      totalBalanceBySiteId[row.siteId] = roundMetric((totalBalanceBySiteId[row.siteId] || 0) + Number(row.balance || 0));
      accountCountBySiteId[row.siteId] = (accountCountBySiteId[row.siteId] || 0) + 1;
      subscriptionBySiteId[row.siteId] = aggregateSiteSubscription(subscriptionBySiteId[row.siteId], row.extraConfig);
    }

    return siteRows.map((site) => ({
      ...site,
      totalBalance: Math.round((totalBalanceBySiteId[site.id] || 0) * 1_000_000) / 1_000_000,
      accountCount: accountCountBySiteId[site.id] || 0,
      subscriptionSummary: subscriptionBySiteId[site.id] || null,
      protocolConfig: sanitizeSiteProtocolConfigForPlatform(protocolConfigs[site.id] || {
        mode: 'auto',
        supportedEndpoints: [],
        preferredEndpoint: null,
        updatedAtMs: 0,
      }, site.platform),
    }));
  });

  app.get<{ Params: { id: string } }>('/api/sites/:id/detail', async (request, reply) => {
    const siteId = Number.parseInt(request.params.id, 10);
    if (!Number.isFinite(siteId) || siteId <= 0) {
      return reply.code(400).send({ error: 'Invalid site id' });
    }

    const site = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!site) {
      return reply.code(404).send({ error: 'Site not found' });
    }

    const accountRows = await db.select().from(schema.accounts)
      .where(eq(schema.accounts.siteId, siteId))
      .all();
    const accountIds = accountRows.map((account) => account.id);

    const tokenRows = accountIds.length > 0
      ? await db.select().from(schema.accountTokens)
        .where(inArray(schema.accountTokens.accountId, accountIds))
        .all()
      : [];
    const tokenIds = tokenRows.map((token) => token.id);

    const accountModelRows = accountIds.length > 0
      ? await db.select().from(schema.modelAvailability)
        .where(inArray(schema.modelAvailability.accountId, accountIds))
        .all()
      : [];
    const tokenModelRows = tokenIds.length > 0
      ? await db.select().from(schema.tokenModelAvailability)
        .where(inArray(schema.tokenModelAvailability.tokenId, tokenIds))
        .all()
      : [];

    const accountById = new Map<number, SiteDetailAccountRow>(
      accountRows.map((account) => [account.id, account as SiteDetailAccountRow]),
    );
    const tokenById = new Map<number, SiteDetailTokenRow>(
      tokenRows.map((token) => [token.id, token as SiteDetailTokenRow]),
    );
    const modelsByAccountId = new Map<number, Set<string>>();
    const modelsByTokenId = new Map<number, Set<string>>();

    for (const row of accountModelRows) {
      if (row.available === false) continue;
      const modelName = normalizeModelName(row.modelName);
      if (!modelName) continue;
      const bucket = modelsByAccountId.get(row.accountId) || new Set<string>();
      bucket.add(modelName);
      modelsByAccountId.set(row.accountId, bucket);
    }

    for (const row of tokenModelRows) {
      if (row.available === false) continue;
      const modelName = normalizeModelName(row.modelName);
      if (!modelName) continue;
      const bucket = modelsByTokenId.get(row.tokenId) || new Set<string>();
      bucket.add(modelName);
      modelsByTokenId.set(row.tokenId, bucket);
    }

    const siteGroupSources = new Map<string, Set<SiteDetailGroupSource>>();
    const addSiteGroup = (groupInput?: string | null, source: SiteDetailGroupSource = 'default') => {
      const group = normalizeTokenGroup(groupInput);
      const sources = siteGroupSources.get(group) || new Set<SiteDetailGroupSource>();
      sources.add(source);
      siteGroupSources.set(group, sources);
      return group;
    };
    addSiteGroup('default', 'default');
    for (const token of tokenRows) {
      addSiteGroup(token.tokenGroup, 'token');
    }

    const pricingGroupsByModel = new Map<string, Set<string>>();
    const groupRatioByGroup = new Map<string, number>();
    const pricingByModelGroup = new Map<string, Map<string, SiteDetailPricing>>();
    const defaultGroupRatio = 1;
    groupRatioByGroup.set('default', defaultGroupRatio);
    try {
      const pricingAccount = accountRows.find((account) => account.accessToken?.trim() || account.apiToken?.trim()) || accountRows[0] || null;
      if (pricingAccount || site.apiKey?.trim()) {
        const catalog = await Promise.race([
          fetchModelPricingCatalog({
            site: {
              id: site.id,
              url: site.url,
              platform: site.platform,
              apiKey: site.apiKey,
            },
            account: pricingAccount
              ? {
                id: pricingAccount.id,
                accessToken: pricingAccount.accessToken,
                apiToken: pricingAccount.apiToken,
              }
              : {
                id: 0,
                accessToken: null,
                apiToken: site.apiKey,
              },
            modelName: '',
          }),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
        ]);
        Object.entries(catalog?.groupRatio || {}).forEach(([group, ratio]) => {
          const normalizedGroup = addSiteGroup(group, 'pricing');
          if (typeof ratio === 'number' && Number.isFinite(ratio)) {
            groupRatioByGroup.set(normalizedGroup, ratio);
          }
        });
        for (const item of catalog?.models || []) {
          const modelName = normalizeModelName(item.modelName);
          if (!modelName) continue;
          const groups = new Set<string>();
          for (const group of item.enableGroups || []) {
            groups.add(addSiteGroup(group, 'pricing'));
          }
          if (groups.size === 0) groups.add(addSiteGroup('default', 'default'));
          pricingGroupsByModel.set(modelName, groups);
          const pricingByGroup = new Map<string, SiteDetailPricing>();
          Object.entries(item.groupPricing || {}).forEach(([group, pricing]) => {
            const normalizedGroup = normalizeTokenGroup(group);
            pricingByGroup.set(normalizedGroup, pricing ? { ...pricing } : null);
          });
          pricingByModelGroup.set(modelName, pricingByGroup);
        }
      }
    } catch { }

    const modelMap = new Map<string, {
      modelName: string;
      accountIds: Set<number>;
      tokenIds: Set<number>;
      groups: Map<string, {
        group: string;
        groupRatio: number | null;
        pricing: SiteDetailPricing;
        accountIds: Set<number>;
        tokenIds: Set<number>;
      }>;
    }>();
    const groupMap = new Map<string, {
      group: string;
      groupRatio: number | null;
      modelNames: Set<string>;
      accountIds: Set<number>;
      tokenIds: Set<number>;
    }>();

    const ensureModel = (modelName: string) => {
      let item = modelMap.get(modelName);
      if (!item) {
        item = {
          modelName,
          accountIds: new Set<number>(),
          tokenIds: new Set<number>(),
          groups: new Map(),
        };
        modelMap.set(modelName, item);
      }
      return item;
    };

    const ensureGroup = (group: string) => {
      let item = groupMap.get(group);
      if (!item) {
        item = {
          group,
          groupRatio: groupRatioByGroup.get(group) ?? null,
          modelNames: new Set<string>(),
          accountIds: new Set<number>(),
          tokenIds: new Set<number>(),
        };
        groupMap.set(group, item);
      }
      return item;
    };

    const siteModelNames = new Set<string>();
    for (const modelSet of modelsByAccountId.values()) {
      for (const modelName of modelSet) siteModelNames.add(modelName);
    }
    for (const modelSet of modelsByTokenId.values()) {
      for (const modelName of modelSet) siteModelNames.add(modelName);
    }
    for (const modelName of pricingGroupsByModel.keys()) {
      siteModelNames.add(modelName);
    }

    const knownSiteGroups = Array.from(siteGroupSources.keys()).sort((left, right) => left.localeCompare(right));
    const resolveGroupsForModel = (modelName: string) => {
      const pricingGroups = pricingGroupsByModel.get(modelName);
      if (pricingGroups && pricingGroups.size > 0) return Array.from(pricingGroups);
      return knownSiteGroups.length > 0 ? knownSiteGroups : ['default'];
    };
    const resolveModelGroupPricing = (modelName: string, group: string): SiteDetailPricing => (
      pricingByModelGroup.get(modelName)?.get(group)
      || pricingByModelGroup.get(modelName)?.get('default')
      || null
    );

    for (const modelName of siteModelNames) {
      const modelItem = ensureModel(modelName);
      for (const account of accountRows) {
        if (modelsByAccountId.get(account.id)?.has(modelName)) {
          modelItem.accountIds.add(account.id);
        }
      }

      for (const group of resolveGroupsForModel(modelName)) {
        let groupItem = modelItem.groups.get(group);
        if (!groupItem) {
          groupItem = {
            group,
            groupRatio: groupRatioByGroup.get(group) ?? null,
            pricing: resolveModelGroupPricing(modelName, group),
            accountIds: new Set<number>(),
            tokenIds: new Set<number>(),
          };
          modelItem.groups.set(group, groupItem);
        }

        for (const account of accountRows) {
          if (modelsByAccountId.get(account.id)?.has(modelName)) {
            groupItem.accountIds.add(account.id);
          }
        }

        const siteGroup = ensureGroup(group);
        siteGroup.modelNames.add(modelName);
        for (const accountId of groupItem.accountIds) {
          siteGroup.accountIds.add(accountId);
        }
      }
    }

    for (const token of tokenRows) {
      const tokenModels = modelsByTokenId.get(token.id) || modelsByAccountId.get(token.accountId) || new Set<string>();
      const group = normalizeTokenGroup(token.tokenGroup);
      for (const modelName of tokenModels) {
        const modelItem = ensureModel(modelName);
        modelItem.tokenIds.add(token.id);
        let groupItem = modelItem.groups.get(group);
        if (!groupItem) {
          groupItem = {
            group,
            groupRatio: groupRatioByGroup.get(group) ?? null,
            pricing: resolveModelGroupPricing(modelName, group),
            accountIds: new Set<number>(),
            tokenIds: new Set<number>(),
          };
          modelItem.groups.set(group, groupItem);
        }
        groupItem.accountIds.add(token.accountId);
        groupItem.tokenIds.add(token.id);

        const siteGroup = ensureGroup(group);
        siteGroup.modelNames.add(modelName);
        siteGroup.accountIds.add(token.accountId);
        siteGroup.tokenIds.add(token.id);
      }
    }

    const accounts = accountRows
      .map((account) => ({
        id: account.id,
        username: account.username,
        status: account.status,
        balance: account.balance,
        credentialMode: account.accessToken?.trim() ? 'session' : 'apikey',
        tokenCount: tokenRows.filter((token) => token.accountId === account.id).length,
        modelCount: modelsByAccountId.get(account.id)?.size || 0,
      }))
      .sort((left, right) => String(left.username || left.id).localeCompare(String(right.username || right.id)));

    const tokens = tokenRows
      .map((token) => {
        const account = accountById.get(token.accountId);
        const modelSet = modelsByTokenId.get(token.id) || modelsByAccountId.get(token.accountId) || new Set<string>();
        return {
          id: token.id,
          accountId: token.accountId,
          accountName: account?.username || `ID:${token.accountId}`,
          name: token.name,
          group: normalizeTokenGroup(token.tokenGroup),
          enabled: token.enabled !== false,
          isDefault: token.isDefault === true,
          source: token.source,
          valueStatus: resolveAccountTokenValueStatus(token),
          tokenMasked: maskToken(token.token, site.platform),
          modelCount: modelSet.size,
          models: Array.from(modelSet).sort((left, right) => left.localeCompare(right)).slice(0, 40),
          createdAt: token.createdAt,
          updatedAt: token.updatedAt,
        };
      })
      .sort((left, right) => {
        const groupCompare = left.group.localeCompare(right.group);
        if (groupCompare !== 0) return groupCompare;
        return left.name.localeCompare(right.name);
      });

    const models = Array.from(modelMap.values())
      .map((item) => ({
        name: item.modelName,
        accountCount: item.accountIds.size,
        tokenCount: item.tokenIds.size,
        groups: Array.from(item.groups.values())
          .map((group) => ({
            group: group.group,
            groupRatio: group.groupRatio,
            pricing: group.pricing,
            accountCount: group.accountIds.size,
            tokenCount: group.tokenIds.size,
            tokens: Array.from(group.tokenIds)
              .map((tokenId) => {
                const token = tokenById.get(tokenId);
                const account = token ? accountById.get(token.accountId) : null;
                return token ? {
                  id: token.id,
                  name: token.name,
                  accountId: token.accountId,
                  accountName: account?.username || `ID:${token.accountId}`,
                  enabled: token.enabled !== false,
                  isDefault: token.isDefault === true,
                } : null;
              })
              .filter((token): token is {
                id: number;
                name: string;
                accountId: number;
                accountName: string;
                enabled: boolean;
                isDefault: boolean;
              } => token !== null),
          }))
          .sort((left, right) => left.group.localeCompare(right.group)),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));

    const groups = Array.from(groupMap.values())
      .map((item) => ({
        group: item.group,
        groupRatio: item.groupRatio,
        modelCount: item.modelNames.size,
        accountCount: item.accountIds.size,
        tokenCount: item.tokenIds.size,
        models: Array.from(item.modelNames).sort((left, right) => left.localeCompare(right)).slice(0, 80),
      }))
      .sort((left, right) => left.group.localeCompare(right.group));

    return {
      site: {
        id: site.id,
        name: site.name,
        url: site.url,
        platform: site.platform,
        status: site.status,
      },
      summary: {
        accountCount: accounts.length,
        tokenCount: tokens.length,
        modelCount: models.length,
        groupCount: groups.length,
      },
      accounts,
      tokens,
      models,
      groups,
    };
  });

  // Add a site
  app.post<{ Body: {
    name: string;
    url: string;
    platform?: string;
    proxyUrl?: string | null;
    flaresolverrUrl?: string | null;
    useSystemProxy?: boolean;
    customHeaders?: string | null;
    externalCheckinUrl?: string | null;
    protocolConfig?: unknown;
    status?: string;
    isPinned?: boolean;
    sortOrder?: number;
    globalWeight?: number;
  } }>('/api/sites', async (request, reply) => {
    const { name, url, platform, proxyUrl, flaresolverrUrl, useSystemProxy, customHeaders, externalCheckinUrl, protocolConfig, status, isPinned, sortOrder, globalWeight } = request.body;
    const normalizedStatus = normalizeSiteStatus(status);
    if (status !== undefined && !normalizedStatus) {
      return reply.code(400).send({ error: 'Invalid site status. Expected active or disabled.' });
    }
    const normalizedUseSystemProxy = normalizeUseSystemProxyFlag(useSystemProxy);
    if (useSystemProxy !== undefined && normalizedUseSystemProxy === null) {
      return reply.code(400).send({ error: 'Invalid useSystemProxy value. Expected boolean.' });
    }
    const normalizedProxyUrl = parseSiteProxyUrlInput(proxyUrl);
    if (!normalizedProxyUrl.valid) {
      return reply.code(400).send({ error: 'Invalid proxyUrl. Expected a valid http(s)/socks proxy URL.' });
    }
    const normalizedExternalCheckinUrl = normalizeOptionalExternalCheckinUrl(externalCheckinUrl);
    if (!normalizedExternalCheckinUrl.valid) {
      return reply.code(400).send({ error: 'Invalid externalCheckinUrl. Expected a valid http(s) URL.' });
    }
    const normalizedPinned = normalizePinnedFlag(isPinned);
    if (isPinned !== undefined && normalizedPinned === null) {
      return reply.code(400).send({ error: 'Invalid isPinned value. Expected boolean.' });
    }
    const normalizedSortOrder = normalizeSortOrder(sortOrder);
    if (sortOrder !== undefined && normalizedSortOrder === null) {
      return reply.code(400).send({ error: 'Invalid sortOrder value. Expected non-negative integer.' });
    }
    const normalizedGlobalWeight = normalizeGlobalWeight(globalWeight);
    if (globalWeight !== undefined && normalizedGlobalWeight === null) {
      return reply.code(400).send({ error: 'Invalid globalWeight value. Expected a positive number.' });
    }
    const normalizedCustomHeaders = parseSiteCustomHeadersInput(customHeaders);
    if (!normalizedCustomHeaders.valid) {
      return reply.code(400).send({ error: normalizedCustomHeaders.error || 'Invalid customHeaders.' });
    }
    const normalizedProtocolConfig = normalizeSiteProtocolConfigInput(protocolConfig, platform);
    if (!normalizedProtocolConfig.valid) {
      return reply.code(400).send({ error: normalizedProtocolConfig.error || 'Invalid protocolConfig.' });
    }

    const maxResult = await db.select({ maxOrder: sql<number>`coalesce(MAX(${schema.sites.sortOrder}), -1)` }).from(schema.sites).get();
    const maxSortOrder = maxResult?.maxOrder ?? -1;

    let detectedPlatform = platform;
    if (!detectedPlatform) {
      const detected = await detectSite(url);
      detectedPlatform = detected?.platform;
    }
    if (!detectedPlatform) {
      return reply.code(400).send({ error: 'Could not detect platform. Please specify manually.' });
    }
    const inserted = await db.insert(schema.sites).values({
      name,
      url: normalizeSiteUrl(url),
      platform: detectedPlatform,
      proxyUrl: normalizedProxyUrl.proxyUrl,
      flaresolverrUrl: flaresolverrUrl?.trim() || null,
      useSystemProxy: normalizedUseSystemProxy ?? false,
      customHeaders: normalizedCustomHeaders.customHeaders,
      externalCheckinUrl: normalizedExternalCheckinUrl.url,
      status: normalizedStatus ?? 'active',
      isPinned: normalizedPinned ?? false,
      sortOrder: normalizedSortOrder ?? (maxSortOrder + 1),
      globalWeight: normalizedGlobalWeight ?? 1,
    }).run();
    const siteId = Number(inserted.lastInsertRowid || 0);
    if (siteId <= 0) {
      return reply.code(500).send({ error: 'Create site failed' });
    }
    const result = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!result) {
      return reply.code(500).send({ error: 'Create site failed' });
    }
    if (normalizedProtocolConfig.present && normalizedProtocolConfig.config) {
      await upsertSiteProtocolConfig(siteId, normalizedProtocolConfig.config);
      await flushSiteProtocolConfigPersistence();
    }
    invalidateSiteCaches();
    if ((result.status || 'active') === 'active') {
      queueCoverageHealingTask({
        siteIds: [result.id],
      }, {
        dedupeKey: `coverage-heal:site-onboard:${result.id}`,
        title: `站点接入后自动诊断补齐 #${result.id}`,
      });
    }
    return {
      ...result,
      protocolConfig: sanitizeSiteProtocolConfigForPlatform(await resolveSiteProtocolConfig(siteId), result.platform),
    };
  });

  // Update a site
  app.put<{ Params: { id: string }; Body: {
    name?: string;
    url?: string;
    platform?: string;
    proxyUrl?: string | null;
    flaresolverrUrl?: string | null;
    useSystemProxy?: boolean;
    customHeaders?: string | null;
    externalCheckinUrl?: string | null;
    protocolConfig?: unknown;
    status?: string;
    isPinned?: boolean;
    sortOrder?: number;
    globalWeight?: number;
  } }>('/api/sites/:id', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ error: 'Invalid site id' });
    }

    const existingSite = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    if (!existingSite) {
      return reply.code(404).send({ error: 'Site not found' });
    }

    const updates: any = {};
    const body = request.body;
    const normalizedStatus = normalizeSiteStatus(body.status);
    if (body.status !== undefined && !normalizedStatus) {
      return reply.code(400).send({ error: 'Invalid site status. Expected active or disabled.' });
    }
    const normalizedUseSystemProxy = normalizeUseSystemProxyFlag(body.useSystemProxy);
    if (body.useSystemProxy !== undefined && normalizedUseSystemProxy === null) {
      return reply.code(400).send({ error: 'Invalid useSystemProxy value. Expected boolean.' });
    }
    const normalizedProxyUrl = parseSiteProxyUrlInput(body.proxyUrl);
    if (!normalizedProxyUrl.valid) {
      return reply.code(400).send({ error: 'Invalid proxyUrl. Expected a valid http(s)/socks proxy URL.' });
    }
    const normalizedExternalCheckinUrl = normalizeOptionalExternalCheckinUrl(body.externalCheckinUrl);
    if (!normalizedExternalCheckinUrl.valid) {
      return reply.code(400).send({ error: 'Invalid externalCheckinUrl. Expected a valid http(s) URL.' });
    }
    const normalizedPinned = normalizePinnedFlag(body.isPinned);
    if (body.isPinned !== undefined && normalizedPinned === null) {
      return reply.code(400).send({ error: 'Invalid isPinned value. Expected boolean.' });
    }
    const normalizedSortOrder = normalizeSortOrder(body.sortOrder);
    if (body.sortOrder !== undefined && normalizedSortOrder === null) {
      return reply.code(400).send({ error: 'Invalid sortOrder value. Expected non-negative integer.' });
    }
    const normalizedGlobalWeight = normalizeGlobalWeight(body.globalWeight);
    if (body.globalWeight !== undefined && normalizedGlobalWeight === null) {
      return reply.code(400).send({ error: 'Invalid globalWeight value. Expected a positive number.' });
    }
    const normalizedCustomHeaders = parseSiteCustomHeadersInput(body.customHeaders);
    if (!normalizedCustomHeaders.valid) {
      return reply.code(400).send({ error: normalizedCustomHeaders.error || 'Invalid customHeaders.' });
    }
    const nextPlatform = body.platform !== undefined ? body.platform : existingSite.platform;
    const normalizedProtocolConfig = normalizeSiteProtocolConfigInput(body.protocolConfig, nextPlatform);
    if (!normalizedProtocolConfig.valid) {
      return reply.code(400).send({ error: normalizedProtocolConfig.error || 'Invalid protocolConfig.' });
    }

    if (body.name !== undefined) updates.name = body.name;
    if (body.url !== undefined) updates.url = normalizeSiteUrl(body.url);
    if (body.platform !== undefined) updates.platform = body.platform;
    if (normalizedProxyUrl.present) updates.proxyUrl = normalizedProxyUrl.proxyUrl;
    if (body.flaresolverrUrl !== undefined) updates.flaresolverrUrl = body.flaresolverrUrl?.trim() || null;
    if (body.useSystemProxy !== undefined) updates.useSystemProxy = normalizedUseSystemProxy;
    if (normalizedCustomHeaders.present) updates.customHeaders = normalizedCustomHeaders.customHeaders;
    if (normalizedExternalCheckinUrl.present) updates.externalCheckinUrl = normalizedExternalCheckinUrl.url;
    if (body.status !== undefined) updates.status = normalizedStatus;
    if (body.isPinned !== undefined) updates.isPinned = normalizedPinned;
    if (body.sortOrder !== undefined) updates.sortOrder = normalizedSortOrder;
    if (body.globalWeight !== undefined) updates.globalWeight = normalizedGlobalWeight;
    updates.updatedAt = new Date().toISOString();
    await db.update(schema.sites).set(updates).where(eq(schema.sites.id, id)).run();
    if (normalizedProtocolConfig.present && normalizedProtocolConfig.config) {
      await upsertSiteProtocolConfig(id, normalizedProtocolConfig.config);
      await flushSiteProtocolConfigPersistence();
    } else if (body.platform !== undefined) {
      const sanitizedExistingProtocolConfig = sanitizeSiteProtocolConfigForPlatform(
        await getSiteProtocolConfig(id),
        nextPlatform,
      );
      if (!sanitizedExistingProtocolConfig || sanitizedExistingProtocolConfig.mode !== 'manual') {
        await deleteSiteProtocolConfig(id);
      } else {
        await upsertSiteProtocolConfig(id, sanitizedExistingProtocolConfig);
      }
      await flushSiteProtocolConfigPersistence();
    }

    if (body.status !== undefined && normalizedStatus) {
      await applySiteStatusSideEffects(id, existingSite.name, normalizedStatus);
    }

    invalidateSiteCaches();

    const updatedSite = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    return updatedSite
      ? {
        ...updatedSite,
        protocolConfig: sanitizeSiteProtocolConfigForPlatform(await resolveSiteProtocolConfig(id), updatedSite.platform),
      }
      : updatedSite;
  });

  // Delete a site
  app.delete<{ Params: { id: string } }>('/api/sites/:id', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send({ error: 'Invalid id' });
    await db.delete(schema.sites).where(eq(schema.sites.id, id)).run();
    await deleteSiteProtocolConfig(id);
    await flushSiteProtocolConfigPersistence();
    invalidateSiteCaches();
    return { success: true };
  });

  app.post<{ Body?: { ids?: number[]; action?: string } }>('/api/sites/batch', async (request, reply) => {
    const ids = normalizeBatchIds(request.body?.ids);
    const action = String(request.body?.action || '').trim();
    if (ids.length === 0) {
      return reply.code(400).send({ message: 'ids is required' });
    }
    if (!['enable', 'disable', 'delete', 'enableSystemProxy', 'disableSystemProxy'].includes(action)) {
      return reply.code(400).send({ message: 'Invalid action' });
    }

    const successIds: number[] = [];
    const failedItems: Array<{ id: number; message: string }> = [];
    let protocolConfigChanged = false;

    const existingSites = await db.select().from(schema.sites)
      .where(inArray(schema.sites.id, ids)).all() as typeof schema.sites.$inferSelect[];
    const existingMap = new Map<number, typeof schema.sites.$inferSelect>(existingSites.map((s: typeof schema.sites.$inferSelect) => [s.id, s]));
    const foundIds: number[] = [];
    for (const id of ids) {
      if (existingMap.has(id)) {
        foundIds.push(id);
      } else {
        failedItems.push({ id, message: 'Site not found' });
      }
    }

    if (foundIds.length > 0) {
      try {
        if (action === 'delete') {
          await db.delete(schema.sites).where(inArray(schema.sites.id, foundIds)).run();
          for (const id of foundIds) {
            await deleteSiteProtocolConfig(id);
          }
          protocolConfigChanged = true;
          successIds.push(...foundIds);
        } else if (action === 'enableSystemProxy') {
          await db.update(schema.sites)
            .set({ useSystemProxy: true, updatedAt: new Date().toISOString() })
            .where(inArray(schema.sites.id, foundIds))
            .run();
          successIds.push(...foundIds);
        } else if (action === 'disableSystemProxy') {
          await db.update(schema.sites)
            .set({ useSystemProxy: false, updatedAt: new Date().toISOString() })
            .where(inArray(schema.sites.id, foundIds))
            .run();
          successIds.push(...foundIds);
        } else {
          const nextStatus = action === 'enable' ? 'active' : 'disabled';
          await db.update(schema.sites)
            .set({ status: nextStatus, updatedAt: new Date().toISOString() })
            .where(inArray(schema.sites.id, foundIds))
            .run();
          for (const id of foundIds) {
            const site = existingMap.get(id)!;
            await applySiteStatusSideEffects(id, site.name, nextStatus);
          }
          successIds.push(...foundIds);
        }
      } catch (error: any) {
        failedItems.push(...foundIds.map((id) => ({ id, message: error?.message || 'Batch operation failed' })));
      }
    }

    if (protocolConfigChanged) {
      await flushSiteProtocolConfigPersistence();
    }
    invalidateSiteCaches();
    return {
      success: true,
      successIds,
      failedItems,
    };
  });

  app.post<{ Params: { id: string }; Body?: { modelName?: string } }>('/api/sites/:id/protocol-probe', async (request, reply) => {
    const id = parseInt(request.params.id, 10);
    if (!Number.isFinite(id) || id <= 0) {
      return reply.code(400).send({ error: 'Invalid site id' });
    }

    const existingSite = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    if (!existingSite) {
      return reply.code(404).send({ error: 'Site not found' });
    }
    if (existingSite.status !== 'active') {
      return reply.code(400).send({ error: '站点已禁用，无法自动探测协议' });
    }

    try {
      const result = await probeSiteProtocol({
        siteId: id,
        modelName: request.body?.modelName,
      });
      await upsertSiteProtocolConfig(id, result.protocolConfig);
      await flushSiteProtocolConfigPersistence();
      invalidateSiteCaches();

      return {
        success: true,
        ...result,
        protocolConfig: sanitizeSiteProtocolConfigForPlatform(await resolveSiteProtocolConfig(id), existingSite.platform),
      };
    } catch (error: any) {
      if (error instanceof SiteProtocolProbeError) {
        return reply.code(error.probeSource === 'cooldown_cache' ? 429 : 400).send({
          error: error.message,
          siteId: error.siteId,
          siteName: error.siteName,
          sitePlatform: error.sitePlatform,
          modelName: error.modelName,
          probeSource: error.probeSource,
          cacheHit: error.probeSource !== 'live',
          cooldownUntilMs: error.cooldownUntilMs,
          cooldownRemainingMs: error.cooldownRemainingMs,
          attempts: error.attempts,
          attemptSummary: error.attemptSummary,
        });
      }
      const message = typeof error?.message === 'string' && error.message.trim()
        ? error.message.trim()
        : '站点协议自动探测失败';
      return reply.code(400).send({ error: message });
    }
  });

  // Get disabled models for a site
  app.get<{ Params: { id: string } }>('/api/sites/:id/disabled-models', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send({ error: 'Invalid site id' });
    const existingSite = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    if (!existingSite) {
      return reply.code(404).send({ error: 'Site not found' });
    }
    const rows = await db.select({ modelName: schema.siteDisabledModels.modelName })
      .from(schema.siteDisabledModels)
      .where(eq(schema.siteDisabledModels.siteId, id))
      .all();
    return { siteId: id, models: rows.map((r) => r.modelName) };
  });

  // Update disabled models for a site (full replace)
  app.put<{ Params: { id: string }; Body: { models?: string[] } }>('/api/sites/:id/disabled-models', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (!Number.isFinite(id) || id <= 0) return reply.code(400).send({ error: 'Invalid site id' });
    const existingSite = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    if (!existingSite) {
      return reply.code(404).send({ error: 'Site not found' });
    }
    const rawModels = request.body?.models;
    if (!Array.isArray(rawModels)) {
      return reply.code(400).send({ error: 'models must be an array of strings' });
    }
    const models = rawModels
      .filter((m): m is string => typeof m === 'string')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);
    const uniqueModels = Array.from(new Set(models));

    await db.delete(schema.siteDisabledModels)
      .where(eq(schema.siteDisabledModels.siteId, id))
      .run();

    if (uniqueModels.length > 0) {
      await db.insert(schema.siteDisabledModels).values(
        uniqueModels.map((modelName) => ({ siteId: id, modelName })),
      ).run();
    }

    invalidateSiteCaches();
    return { siteId: id, models: uniqueModels };
  });

  // Detect platform for a URL
  app.post<{ Body: { url: string } }>('/api/sites/detect', async (request, reply) => {
    const result = await detectSite(request.body.url);
    if (result) return result;
    return reply.code(400).send({ error: 'Could not detect platform' });
  });
}
