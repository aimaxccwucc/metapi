import { eq } from 'drizzle-orm';

export const SITE_PROTOCOL_ENDPOINTS = ['chat', 'responses', 'messages'] as const;
export type SiteProtocolEndpoint = typeof SITE_PROTOCOL_ENDPOINTS[number];

export type SiteProtocolConfig = {
  mode: 'auto' | 'manual';
  supportedEndpoints: SiteProtocolEndpoint[];
  preferredEndpoint: SiteProtocolEndpoint | null;
  updatedAtMs: number;
};

type PersistedSiteProtocolConfig = Omit<SiteProtocolConfig, 'mode'> & {
  mode: 'manual';
};

type SiteProtocolConfigPayload = {
  version: 1;
  savedAtMs: number;
  bySiteId: Record<string, PersistedSiteProtocolConfig>;
};

type NormalizeSiteProtocolConfigResult = {
  valid: boolean;
  present: boolean;
  config?: SiteProtocolConfig;
  error?: string;
};

const SITE_PROTOCOL_CONFIG_SETTING_KEY = 'site_protocol_config_v1';
const SITE_PROTOCOL_CONFIG_PERSIST_DEBOUNCE_MS = 500;

const siteProtocolConfigs = new Map<number, SiteProtocolConfig>();
let siteProtocolConfigsLoaded = false;
let siteProtocolConfigsLoadPromise: Promise<void> | null = null;
let siteProtocolConfigsSaveTimer: ReturnType<typeof setTimeout> | null = null;
let siteProtocolConfigsPersistInFlight: Promise<void> | null = null;
let siteProtocolConfigContextTag: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asProtocolEndpoint(value: unknown): SiteProtocolEndpoint | null {
  return typeof value === 'string' && (SITE_PROTOCOL_ENDPOINTS as readonly string[]).includes(value.trim().toLowerCase())
    ? value.trim().toLowerCase() as SiteProtocolEndpoint
    : null;
}

function normalizeSiteProtocolPlatform(sitePlatform: unknown): string {
  return typeof sitePlatform === 'string' ? sitePlatform.trim().toLowerCase() : '';
}

export function getAllowedSiteProtocolEndpoints(sitePlatform?: unknown): SiteProtocolEndpoint[] {
  const platform = normalizeSiteProtocolPlatform(sitePlatform);
  if (platform === 'codex') return ['responses'];
  if (platform === 'claude') return ['messages'];
  if (platform === 'gemini-cli' || platform === 'antigravity') return ['chat'];
  if (platform === 'gemini') return ['responses', 'chat'];
  if (platform === 'anyrouter') return ['messages', 'chat', 'responses'];
  return ['chat', 'responses', 'messages'];
}

function filterSupportedEndpointsByPlatform(
  supportedEndpoints: SiteProtocolEndpoint[],
  sitePlatform?: unknown,
): SiteProtocolEndpoint[] {
  const allowed = new Set(getAllowedSiteProtocolEndpoints(sitePlatform));
  return supportedEndpoints.filter((endpoint) => allowed.has(endpoint));
}

function normalizeSupportedEndpoints(value: unknown): SiteProtocolEndpoint[] {
  if (!Array.isArray(value)) return [];
  const normalized = new Set<SiteProtocolEndpoint>();
  const ordered: SiteProtocolEndpoint[] = [];
  for (const item of value) {
    const endpoint = asProtocolEndpoint(item);
    if (!endpoint || normalized.has(endpoint)) continue;
    normalized.add(endpoint);
    ordered.push(endpoint);
  }
  return ordered;
}

function cloneSiteProtocolConfig(config: SiteProtocolConfig): SiteProtocolConfig {
  return {
    mode: config.mode,
    supportedEndpoints: [...config.supportedEndpoints],
    preferredEndpoint: config.preferredEndpoint,
    updatedAtMs: config.updatedAtMs,
  };
}

function createDefaultSiteProtocolConfig(): SiteProtocolConfig {
  return {
    mode: 'auto',
    supportedEndpoints: [],
    preferredEndpoint: null,
    updatedAtMs: 0,
  };
}

function getCurrentSiteProtocolConfigContextTag(): string | null {
  const dataDir = (process.env.DATA_DIR || '').trim();
  return dataDir || null;
}

function refreshSiteProtocolConfigContext(): void {
  const nextContextTag = getCurrentSiteProtocolConfigContextTag();
  if (nextContextTag === siteProtocolConfigContextTag) return;

  siteProtocolConfigs.clear();
  siteProtocolConfigsLoaded = false;
  siteProtocolConfigsLoadPromise = null;
  if (siteProtocolConfigsSaveTimer) {
    clearTimeout(siteProtocolConfigsSaveTimer);
    siteProtocolConfigsSaveTimer = null;
  }
  siteProtocolConfigsPersistInFlight = null;
  siteProtocolConfigContextTag = nextContextTag;
}

function normalizePersistedSiteProtocolConfig(raw: unknown): PersistedSiteProtocolConfig | null {
  if (!isRecord(raw)) return null;
  const supportedEndpoints = normalizeSupportedEndpoints(raw.supportedEndpoints);
  if (supportedEndpoints.length === 0) return null;
  const preferredEndpoint = asProtocolEndpoint(raw.preferredEndpoint);
  const updatedAtMs = typeof raw.updatedAtMs === 'number' && Number.isFinite(raw.updatedAtMs)
    ? Math.max(0, Math.trunc(raw.updatedAtMs))
    : Date.now();
  return {
    mode: 'manual',
    supportedEndpoints,
    preferredEndpoint: preferredEndpoint && supportedEndpoints.includes(preferredEndpoint)
      ? preferredEndpoint
      : null,
    updatedAtMs,
  };
}

function buildPersistencePayload(nowMs = Date.now()): SiteProtocolConfigPayload {
  const bySiteId: Record<string, PersistedSiteProtocolConfig> = {};
  for (const [siteId, config] of siteProtocolConfigs.entries()) {
    if (config.mode !== 'manual' || config.supportedEndpoints.length === 0) continue;
    bySiteId[String(siteId)] = {
      mode: 'manual',
      supportedEndpoints: [...config.supportedEndpoints],
      preferredEndpoint: config.preferredEndpoint,
      updatedAtMs: config.updatedAtMs,
    };
  }
  return {
    version: 1,
    savedAtMs: nowMs,
    bySiteId,
  };
}

async function persistSiteProtocolConfigs(): Promise<void> {
  if (siteProtocolConfigsPersistInFlight) {
    await siteProtocolConfigsPersistInFlight;
    return;
  }

  const persistTask = (async () => {
    try {
      const [{ upsertSetting }] = await Promise.all([
        import('../db/upsertSetting.js'),
      ]);
      await upsertSetting(SITE_PROTOCOL_CONFIG_SETTING_KEY, buildPersistencePayload());
    } catch {
      // Allow memory-only fallback when db is unavailable or partially mocked in tests.
    }
  })();

  siteProtocolConfigsPersistInFlight = persistTask.finally(() => {
    if (siteProtocolConfigsPersistInFlight === persistTask) {
      siteProtocolConfigsPersistInFlight = null;
    }
  });

  await siteProtocolConfigsPersistInFlight;
}

function scheduleSiteProtocolConfigPersistence(): void {
  if (siteProtocolConfigsSaveTimer) return;
  siteProtocolConfigsSaveTimer = setTimeout(() => {
    siteProtocolConfigsSaveTimer = null;
    void persistSiteProtocolConfigs();
  }, SITE_PROTOCOL_CONFIG_PERSIST_DEBOUNCE_MS);
}

async function loadSiteProtocolConfigsFromSettings(): Promise<void> {
  try {
    const [{ db, schema }] = await Promise.all([
      import('../db/index.js'),
    ]);
    if (!db || typeof (db as any).select !== 'function' || !schema?.settings) {
      return;
    }

    const row = await db.select({ value: schema.settings.value })
      .from(schema.settings)
      .where(eq(schema.settings.key, SITE_PROTOCOL_CONFIG_SETTING_KEY))
      .get();
    if (!row?.value) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.value);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    const bySiteId = isRecord(parsed.bySiteId) ? parsed.bySiteId : {};
    for (const [siteIdKey, rawConfig] of Object.entries(bySiteId)) {
      const siteId = Number(siteIdKey);
      if (!Number.isFinite(siteId) || siteId <= 0) continue;
      const config = normalizePersistedSiteProtocolConfig(rawConfig);
      if (!config) continue;
      siteProtocolConfigs.set(siteId, config);
    }
  } catch {
    // Allow memory-only fallback when db is unavailable.
  }
}

async function ensureSiteProtocolConfigsLoaded(): Promise<void> {
  refreshSiteProtocolConfigContext();
  if (siteProtocolConfigsLoaded) return;
  if (!siteProtocolConfigsLoadPromise) {
    siteProtocolConfigsLoadPromise = (async () => {
      try {
        await loadSiteProtocolConfigsFromSettings();
      } finally {
        siteProtocolConfigsLoaded = true;
      }
    })();
  }
  await siteProtocolConfigsLoadPromise;
}

export function normalizeSiteProtocolConfigInput(
  input: unknown,
  sitePlatform?: unknown,
): NormalizeSiteProtocolConfigResult {
  if (input === undefined) {
    return { valid: true, present: false };
  }
  if (input === null) {
    return {
      valid: true,
      present: true,
      config: {
        mode: 'auto',
        supportedEndpoints: [],
        preferredEndpoint: null,
        updatedAtMs: Date.now(),
      },
    };
  }
  if (!isRecord(input)) {
    return { valid: false, present: true, error: 'Invalid protocolConfig. Expected an object.' };
  }

  const rawMode = typeof input.mode === 'string' ? input.mode.trim().toLowerCase() : 'auto';
  if (rawMode !== 'auto' && rawMode !== 'manual') {
    return { valid: false, present: true, error: 'Invalid protocolConfig.mode. Expected auto or manual.' };
  }

  if (rawMode === 'auto') {
    return {
      valid: true,
      present: true,
      config: {
        mode: 'auto',
        supportedEndpoints: [],
        preferredEndpoint: null,
        updatedAtMs: Date.now(),
      },
    };
  }

  const supportedEndpoints = normalizeSupportedEndpoints(input.supportedEndpoints);
  if (supportedEndpoints.length === 0) {
    return {
      valid: false,
      present: true,
      error: 'Manual protocolConfig requires at least one supported endpoint.',
    };
  }
  const platformSupportedEndpoints = filterSupportedEndpointsByPlatform(supportedEndpoints, sitePlatform);
  if (platformSupportedEndpoints.length !== supportedEndpoints.length) {
    return {
      valid: false,
      present: true,
      error: 'protocolConfig contains unsupported endpoints for the current site platform.',
    };
  }

  const preferredEndpoint = input.preferredEndpoint == null
    ? null
    : asProtocolEndpoint(input.preferredEndpoint);
  if (input.preferredEndpoint != null && !preferredEndpoint) {
    return {
      valid: false,
      present: true,
      error: 'Invalid protocolConfig.preferredEndpoint.',
    };
  }
  if (preferredEndpoint && !supportedEndpoints.includes(preferredEndpoint)) {
    return {
      valid: false,
      present: true,
      error: 'protocolConfig.preferredEndpoint must exist in supportedEndpoints.',
    };
  }

  return {
    valid: true,
    present: true,
    config: {
      mode: 'manual',
      supportedEndpoints: platformSupportedEndpoints,
      preferredEndpoint,
      updatedAtMs: Date.now(),
    },
  };
}

export function sanitizeSiteProtocolConfigForPlatform(
  config: SiteProtocolConfig | null | undefined,
  sitePlatform?: unknown,
): SiteProtocolConfig | null {
  if (!config || config.mode !== 'manual') return config ?? null;

  const supportedEndpoints = filterSupportedEndpointsByPlatform(config.supportedEndpoints, sitePlatform);
  if (supportedEndpoints.length === 0) {
    return {
      mode: 'auto',
      supportedEndpoints: [],
      preferredEndpoint: null,
      updatedAtMs: Date.now(),
    };
  }

  const preferredEndpoint = config.preferredEndpoint && supportedEndpoints.includes(config.preferredEndpoint)
    ? config.preferredEndpoint
    : null;

  return {
    mode: 'manual',
    supportedEndpoints,
    preferredEndpoint,
    updatedAtMs: config.updatedAtMs || Date.now(),
  };
}

export async function listSiteProtocolConfigs(): Promise<Record<number, SiteProtocolConfig>> {
  await ensureSiteProtocolConfigsLoaded();
  const snapshot: Record<number, SiteProtocolConfig> = {};
  for (const [siteId, config] of siteProtocolConfigs.entries()) {
    snapshot[siteId] = cloneSiteProtocolConfig(config);
  }
  return snapshot;
}

export async function getSiteProtocolConfig(siteId: number): Promise<SiteProtocolConfig | null> {
  await ensureSiteProtocolConfigsLoaded();
  return siteProtocolConfigs.get(siteId) ? cloneSiteProtocolConfig(siteProtocolConfigs.get(siteId)!) : null;
}

export async function resolveSiteProtocolConfig(siteId: number): Promise<SiteProtocolConfig> {
  return (await getSiteProtocolConfig(siteId)) ?? createDefaultSiteProtocolConfig();
}

export async function upsertSiteProtocolConfig(siteId: number, config: SiteProtocolConfig): Promise<void> {
  await ensureSiteProtocolConfigsLoaded();
  if (config.mode !== 'manual' || config.supportedEndpoints.length === 0) {
    siteProtocolConfigs.delete(siteId);
  } else {
    siteProtocolConfigs.set(siteId, cloneSiteProtocolConfig(config));
  }
  scheduleSiteProtocolConfigPersistence();
}

export async function deleteSiteProtocolConfig(siteId: number): Promise<void> {
  await ensureSiteProtocolConfigsLoaded();
  if (!siteProtocolConfigs.has(siteId)) return;
  siteProtocolConfigs.delete(siteId);
  scheduleSiteProtocolConfigPersistence();
}

export async function deleteSiteProtocolConfigs(siteIds: number[]): Promise<void> {
  await ensureSiteProtocolConfigsLoaded();
  let changed = false;
  for (const rawSiteId of siteIds) {
    const siteId = Math.trunc(rawSiteId);
    if (!Number.isFinite(siteId) || siteId <= 0) continue;
    changed = siteProtocolConfigs.delete(siteId) || changed;
  }
  if (changed) {
    scheduleSiteProtocolConfigPersistence();
  }
}

export async function applyManualSiteProtocolConfig(
  candidates: SiteProtocolEndpoint[],
  siteId: number,
  sitePlatform?: unknown,
): Promise<{ candidates: SiteProtocolEndpoint[]; config: SiteProtocolConfig | null }> {
  const config = sanitizeSiteProtocolConfigForPlatform(await getSiteProtocolConfig(siteId), sitePlatform);
  if (!config || config.mode !== 'manual' || config.supportedEndpoints.length === 0) {
    return { candidates, config: null };
  }

  const supported = new Set<SiteProtocolEndpoint>(config.supportedEndpoints);
  const expandedPool = [
    ...candidates,
    ...getAllowedSiteProtocolEndpoints(sitePlatform).filter((endpoint) => supported.has(endpoint) && !candidates.includes(endpoint)),
  ];
  const expandedSet = new Set(expandedPool);
  let next = config.supportedEndpoints.filter((endpoint) => expandedSet.has(endpoint));
  if (next.length === 0) {
    next = [...candidates];
  }

  if (config.preferredEndpoint && next.includes(config.preferredEndpoint)) {
    next = [
      config.preferredEndpoint,
      ...next.filter((endpoint) => endpoint !== config.preferredEndpoint),
    ];
  }

  return { candidates: next, config };
}

export function resetSiteProtocolConfigState(): void {
  siteProtocolConfigs.clear();
  siteProtocolConfigsLoaded = false;
  siteProtocolConfigsLoadPromise = null;
  if (siteProtocolConfigsSaveTimer) {
    clearTimeout(siteProtocolConfigsSaveTimer);
    siteProtocolConfigsSaveTimer = null;
  }
  siteProtocolConfigsPersistInFlight = null;
  siteProtocolConfigContextTag = getCurrentSiteProtocolConfigContextTag();
}

export async function flushSiteProtocolConfigPersistence(): Promise<void> {
  if (siteProtocolConfigsSaveTimer) {
    clearTimeout(siteProtocolConfigsSaveTimer);
    siteProtocolConfigsSaveTimer = null;
    await persistSiteProtocolConfigs();
    return;
  }
  if (siteProtocolConfigsPersistInFlight) {
    await siteProtocolConfigsPersistInFlight;
  }
}
