import { and, eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { getAdapter } from './platforms/index.js';
import { ensureDefaultTokenForAccount, getPreferredAccountToken } from './accountTokenService.js';
import { getCredentialModeFromExtraConfig, resolvePlatformUserId } from './accountExtraConfig.js';
import { invalidateTokenRouterCache } from './tokenRouter.js';
import { setAccountRuntimeHealth } from './accountHealthService.js';
import { clearAllRouteDecisionSnapshots } from './routeDecisionSnapshotStore.js';

const API_TOKEN_DISCOVERY_TIMEOUT_MS = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 12_000;
const MODEL_REFRESH_BATCH_SIZE = 3;

function isSiteDisabled(status?: string | null): boolean {
  return (status || 'active') === 'disabled';
}

function isApiKeyConnection(account: typeof schema.accounts.$inferSelect): boolean {
  const explicit = getCredentialModeFromExtraConfig(account.extraConfig);
  if (explicit && explicit !== 'auto') return explicit === 'apikey';
  return !(account.accessToken || '').trim();
}

function normalizeModels(models: string[]): string[] {
  return Array.from(new Set(models.filter((model) => typeof model === 'string' && model.trim().length > 0)));
}

function isExactModelPattern(modelPattern: string): boolean {
  const normalized = modelPattern.trim();
  if (!normalized) return false;
  if (normalized.toLowerCase().startsWith('re:')) return false;
  return !/[\*\?\[]/.test(normalized);
}

async function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function refreshModelsForAccount(accountId: number) {
  const row = await db.select().from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(eq(schema.accounts.id, accountId))
    .get();

  if (!row) {
    return { accountId, refreshed: false, modelCount: 0, reason: 'account_not_found' };
  }

  const account = row.accounts;
  const site = row.sites;
  const adapter = getAdapter(site.platform);

  const accountTokens = await db.select()
    .from(schema.accountTokens)
    .where(eq(schema.accountTokens.accountId, accountId))
    .all();

  await db.delete(schema.modelAvailability)
    .where(eq(schema.modelAvailability.accountId, accountId))
    .run();

  for (const token of accountTokens) {
    await db.delete(schema.tokenModelAvailability)
      .where(eq(schema.tokenModelAvailability.tokenId, token.id))
      .run();
  }

  if (isSiteDisabled(site.status)) {
    return { accountId, refreshed: false, modelCount: 0, reason: 'site_disabled' };
  }

  if (!adapter || account.status !== 'active') {
    return { accountId, refreshed: false, modelCount: 0, reason: 'adapter_or_status' };
  }

  const platformUserId = resolvePlatformUserId(account.extraConfig, account.username);
  let discoveredApiToken: string | null = null;

  if (!account.apiToken && account.accessToken) {
    try {
      discoveredApiToken = await withTimeout(
        () => adapter.getApiToken(site.url, account.accessToken, platformUserId),
        API_TOKEN_DISCOVERY_TIMEOUT_MS,
        `api token discovery timeout (${Math.round(API_TOKEN_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
      );
      if (discoveredApiToken) {
        ensureDefaultTokenForAccount(account.id, discoveredApiToken, { name: 'default', source: 'sync' });
        await db.update(schema.accounts).set({
          apiToken: discoveredApiToken,
          updatedAt: new Date().toISOString(),
        }).where(eq(schema.accounts.id, account.id)).run();
      }
    } catch {}
  }

  let enabledTokens = await db.select()
    .from(schema.accountTokens)
    .where(and(eq(schema.accountTokens.accountId, account.id), eq(schema.accountTokens.enabled, true)))
    .all();

  // Last fallback: if still no managed token but account has a legacy apiToken, mirror it into token table.
  if (!isApiKeyConnection(account) && enabledTokens.length === 0) {
    const fallback = discoveredApiToken || account.apiToken || null;
    if (fallback) {
      ensureDefaultTokenForAccount(account.id, fallback, { name: 'default', source: 'legacy' });
      enabledTokens = await db.select()
        .from(schema.accountTokens)
        .where(and(eq(schema.accountTokens.accountId, account.id), eq(schema.accountTokens.enabled, true)))
        .all();
    }
  }

  const accountModels = new Set<string>();
  const modelLatency = new Map<string, number | null>();
  let scannedTokenCount = 0;
  let discoveredByCredential = false;
  const attemptedCredentials = new Set<string>();

  const mergeDiscoveredModels = (models: string[], latencyMs: number | null) => {
    for (const modelName of models) {
      accountModels.add(modelName);
      const prev = modelLatency.get(modelName);
      if (prev === undefined || prev === null) {
        modelLatency.set(modelName, latencyMs);
        continue;
      }
      if (latencyMs === null) continue;
      if (latencyMs < prev) modelLatency.set(modelName, latencyMs);
    }
  };

  const discoverModelsWithCredential = async (credentialRaw: string | null | undefined) => {
    const credential = (credentialRaw || '').trim();
    if (!credential) return;
    if (attemptedCredentials.has(credential)) return;
    attemptedCredentials.add(credential);

    const startedAt = Date.now();
    let models: string[] = [];
    try {
      models = normalizeModels(
        await withTimeout(
          () => adapter.getModels(site.url, credential, platformUserId),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      );
    } catch {
      models = [];
    }
    if (models.length === 0) return;
    discoveredByCredential = true;
    const latencyMs = Date.now() - startedAt;
    mergeDiscoveredModels(models, latencyMs);
  };

  // Prefer account-level credential discovery so model availability does not rely on managed tokens.
  await discoverModelsWithCredential(account.apiToken);
  await discoverModelsWithCredential(discoveredApiToken);
  await discoverModelsWithCredential(account.accessToken);

  for (const token of enabledTokens) {
    const startedAt = Date.now();
    let models: string[] = [];

    try {
      models = normalizeModels(
        await withTimeout(
          () => adapter.getModels(site.url, token.token, platformUserId),
          MODEL_DISCOVERY_TIMEOUT_MS,
          `model discovery timeout (${Math.round(MODEL_DISCOVERY_TIMEOUT_MS / 1000)}s)`,
        ),
      );
    } catch {
      models = [];
    }

    if (models.length === 0) continue;

    const latencyMs = Date.now() - startedAt;
    const checkedAt = new Date().toISOString();

    await db.insert(schema.tokenModelAvailability).values(
      models.map((modelName) => ({
        tokenId: token.id,
        modelName,
        available: true,
        latencyMs,
        checkedAt,
      })),
    ).run();

    scannedTokenCount++;
    mergeDiscoveredModels(models, latencyMs);
  }

  if (accountModels.size > 0) {
    const checkedAt = new Date().toISOString();
    await db.insert(schema.modelAvailability).values(
      Array.from(accountModels).map((modelName) => ({
        accountId: account.id,
        modelName,
        available: true,
        latencyMs: modelLatency.get(modelName) ?? null,
        checkedAt,
      })),
    ).run();

    if (isApiKeyConnection(account)) {
      await setAccountRuntimeHealth(account.id, {
        state: 'healthy',
        reason: '模型探测成功',
        source: 'model-discovery',
        checkedAt,
      });
    }
  }

  return {
    accountId,
    refreshed: true,
    modelCount: accountModels.size,
    tokenScanned: scannedTokenCount,
    discoveredByCredential,
    discoveredApiToken: !!discoveredApiToken,
  };
}

async function refreshModelsForAllActiveAccounts() {
  const accounts = await db.select({ id: schema.accounts.id }).from(schema.accounts)
    .where(eq(schema.accounts.status, 'active'))
    .all();

  const results: any[] = [];
  for (let offset = 0; offset < accounts.length; offset += MODEL_REFRESH_BATCH_SIZE) {
    const batch = accounts.slice(offset, offset + MODEL_REFRESH_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(async (account) => refreshModelsForAccount(account.id)));
    results.push(...batchResults);
  }
  return results;
}

export async function rebuildTokenRoutesFromAvailability() {
  const tokenRows = await db.select().from(schema.tokenModelAvailability)
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

  const modelTokens = new Map<string, Map<number, number>>();
  for (const row of tokenRows) {
    const modelName = row.token_model_availability.modelName;
    if (!modelTokens.has(modelName)) modelTokens.set(modelName, new Map<number, number>());
    modelTokens.get(modelName)!.set(row.account_tokens.id, row.accounts.id);
  }

  const routes = await db.select().from(schema.tokenRoutes).all();
  const channels = await db.select().from(schema.routeChannels).all();

  let createdRoutes = 0;
  let createdChannels = 0;
  let removedChannels = 0;
  let removedRoutes = 0;

  for (const [modelName, tokenAccountMap] of modelTokens.entries()) {
    let route = routes.find((r) => r.modelPattern === modelName);
    if (!route) {
      const inserted = await db.insert(schema.tokenRoutes).values({
        modelPattern: modelName,
        enabled: true,
      }).run();
      const insertedId = Number(inserted.lastInsertRowid || 0);
      route = insertedId > 0
        ? await db.select().from(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, insertedId)).get()
        : undefined;
      if (!route) continue;
      routes.push(route);
      createdRoutes++;
    }

    const routeChannels = channels.filter((channel) => channel.routeId === route.id);
    const desiredTokenIds = new Set<number>(Array.from(tokenAccountMap.keys()));

    for (const [tokenId, accountId] of tokenAccountMap.entries()) {
      const exists = routeChannels.some((channel) => channel.tokenId === tokenId);
      if (exists) continue;

      const inserted = await db.insert(schema.routeChannels).values({
        routeId: route.id,
        accountId,
        tokenId,
        priority: 0,
        weight: 10,
        enabled: true,
        manualOverride: false,
      }).run();
      const insertedId = Number(inserted.lastInsertRowid || 0);
      if (insertedId <= 0) continue;
      const created = await db.select().from(schema.routeChannels).where(eq(schema.routeChannels.id, insertedId)).get();
      if (!created) continue;
      channels.push(created);
      createdChannels++;
    }

    for (const channel of routeChannels) {
      if (channel.tokenId && desiredTokenIds.has(channel.tokenId)) {
        continue;
      }

      if (!channel.tokenId) {
        const preferred = await getPreferredAccountToken(channel.accountId);
        if (preferred && desiredTokenIds.has(preferred.id)) {
          await db.update(schema.routeChannels)
            .set({ tokenId: preferred.id })
            .where(eq(schema.routeChannels.id, channel.id))
            .run();
          continue;
        }
      }

      if (!channel.manualOverride) {
        await db.delete(schema.routeChannels).where(eq(schema.routeChannels.id, channel.id)).run();
        removedChannels++;
      }
    }
  }

  const latestModelNames = new Set<string>(Array.from(modelTokens.keys()));
  for (const route of routes) {
    const modelPattern = (route.modelPattern || '').trim();
    if (!modelPattern || !isExactModelPattern(modelPattern) || latestModelNames.has(modelPattern)) {
      continue;
    }

    const routeChannelCount = channels.filter((channel) => channel.routeId === route.id).length;
    if (routeChannelCount > 0) {
      removedChannels += routeChannelCount;
    }

    const deleted = (await db.delete(schema.tokenRoutes).where(eq(schema.tokenRoutes.id, route.id)).run()).changes;
    if (deleted > 0) {
      removedRoutes += deleted;
    }
  }

  if (createdRoutes > 0 || createdChannels > 0 || removedChannels > 0 || removedRoutes > 0) {
    await clearAllRouteDecisionSnapshots();
  }

  invalidateTokenRouterCache();

  return {
    models: modelTokens.size,
    createdRoutes,
    createdChannels,
    removedChannels,
    removedRoutes,
  };
}

export async function refreshModelsAndRebuildRoutes() {
  const refresh = await refreshModelsForAllActiveAccounts();
  const rebuild = await rebuildTokenRoutesFromAvailability();
  return { refresh, rebuild };
}
