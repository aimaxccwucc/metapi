import { asc, eq } from 'drizzle-orm';
import cron from 'node-cron';
import { db, schema } from '../db/index.js';
import { getPlatformUserIdFromExtraConfig, mergeAccountExtraConfig, type AccountCredentialMode } from './accountExtraConfig.js';
import { repairDefaultToken } from './accountTokenService.js';

const BACKUP_VERSION = '2.0';

export type BackupExportType = 'all' | 'accounts' | 'preferences';

type SiteRow = typeof schema.sites.$inferSelect;
type AccountRow = typeof schema.accounts.$inferSelect;
type AccountTokenRow = typeof schema.accountTokens.$inferSelect;
type TokenRouteRow = typeof schema.tokenRoutes.$inferSelect;
type RouteChannelRow = typeof schema.routeChannels.$inferSelect;

interface AccountsBackupSection {
  sites: SiteRow[];
  accounts: AccountRow[];
  accountTokens: AccountTokenRow[];
  tokenRoutes: TokenRouteRow[];
  routeChannels: RouteChannelRow[];
}

interface PreferencesBackupSection {
  settings: Array<{ key: string; value: unknown }>;
}

interface BackupFullV2 {
  version: string;
  timestamp: number;
  accounts: AccountsBackupSection;
  preferences: PreferencesBackupSection;
}

interface BackupAccountsPartialV2 {
  version: string;
  timestamp: number;
  type: 'accounts';
  accounts: AccountsBackupSection;
}

interface BackupPreferencesPartialV2 {
  version: string;
  timestamp: number;
  type: 'preferences';
  preferences: PreferencesBackupSection;
}

type BackupV2 = BackupFullV2 | BackupAccountsPartialV2 | BackupPreferencesPartialV2;

type RawBackupData = Record<string, unknown>;

interface BackupImportResult {
  allImported: boolean;
  sections: {
    accounts: boolean;
    preferences: boolean;
  };
  appliedSettings: Array<{ key: string; value: unknown }>;
}

interface AllApiHubMergeImportResult {
  importedRows: number;
  skippedRows: number;
  sites: {
    created: number;
    reused: number;
  };
  accounts: {
    created: number;
    updated: number;
    reused: number;
  };
  tokens: {
    created: number;
    reused: number;
  };
  repairedDefaultTokenAccounts: number;
}

const EXCLUDED_SETTING_KEYS = new Set<string>([
  // Keep current admin login credential unchanged to avoid accidental lock-out.
  'auth_token',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim();
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  return fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toIsoString(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function normalizeLegacyQuota(raw: unknown): number {
  const value = asNumber(raw, 0);
  if (!Number.isFinite(value) || value <= 0) return 0;
  // ref-all-api-hub stores quota in raw units for NewAPI-like sites.
  // Convert obvious raw values to display currency units.
  if (value >= 10_000) return value / 500_000;
  return value;
}

function normalizeLegacyPlatform(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (!value) return 'new-api';

  const supported = new Set([
    'new-api',
    'one-api',
    'anyrouter',
    'one-hub',
    'done-hub',
    'sub2api',
    'veloera',
  ]);
  if (supported.has(value)) return value;

  if (value.includes('wong')) return 'new-api';
  if (value.includes('anyrouter')) return 'anyrouter';
  if (value.includes('done')) return 'done-hub';

  return 'new-api';
}

function normalizeSiteBaseUrl(input: unknown): string {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function normalizeOptionalExternalCheckinUrl(input: unknown): string | null {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function resolveLegacyExternalCheckinUrl(item: Record<string, unknown>): string | null {
  const checkin = isRecord(item.checkIn) ? item.checkIn : null;
  const customCheckin = isRecord(checkin?.customCheckIn) ? checkin.customCheckIn : null;

  const candidates: unknown[] = [
    customCheckin?.url,
    customCheckin?.redeemUrl,
    item.externalCheckinUrl,
    item.external_checkin_url,
    item.checkinUrl,
    item.checkin_url,
  ];

  for (const candidate of candidates) {
    const normalized = normalizeOptionalExternalCheckinUrl(candidate);
    if (normalized) return normalized;
  }
  return null;
}

function normalizeKeyToken(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function normalizeLegacyAuthType(raw: unknown): string {
  return asString(raw).toLowerCase();
}

function resolveCredentialModeForLegacyImport(authType: string, accessToken: string, keyCandidates: string[]): AccountCredentialMode {
  if (authType === 'api_key' || authType === 'apikey') return 'apikey';
  if (authType === 'cookie' || authType === 'access_token') return 'session';

  const hasSessionLikeToken = accessToken.length > 0 && !keyCandidates.includes(accessToken);
  if (hasSessionLikeToken) return 'session';
  return keyCandidates.length > 0 ? 'apikey' : 'auto';
}

function collectLegacyKeyCandidates(item: Record<string, unknown>, accountInfo: Record<string, unknown>, accountAccessToken: string, authType: string): string[] {
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    const normalized = normalizeKeyToken(value);
    if (!normalized) return;
    candidates.add(normalized);
  };

  const appendArrayTokens = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const tokenRow of value) {
      if (!isRecord(tokenRow)) continue;
      add(tokenRow.key);
      add(tokenRow.token);
      add(tokenRow.value);
    }
  };

  add(item.apiKey);
  add(item.api_key);
  add(item.key);
  add(item.token);
  add(item.defaultApiKey);
  add(item.default_api_key);
  add(accountInfo.apiKey);
  add(accountInfo.api_key);
  add(accountInfo.key);
  add(accountInfo.token);
  add(accountInfo.defaultApiKey);
  add(accountInfo.default_api_key);

  appendArrayTokens(item.apiTokens);
  appendArrayTokens(item.accountTokens);
  appendArrayTokens(item.tokens);
  appendArrayTokens(accountInfo.apiTokens);
  appendArrayTokens(accountInfo.accountTokens);
  appendArrayTokens(accountInfo.tokens);

  if (authType === 'api_key' || authType === 'apikey') {
    add(accountAccessToken);
  }

  return Array.from(candidates);
}

function collectAllApiHubAccounts(data: RawBackupData): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];

  const pushRows = (source: unknown) => {
    if (!Array.isArray(source)) return;
    for (const row of source) {
      if (!isRecord(row)) continue;
      rows.push(row);
    }
  };

  if (isRecord(data.accounts) && Array.isArray(data.accounts.accounts)) {
    pushRows(data.accounts.accounts);
  }

  if (Array.isArray(data.accounts)) {
    pushRows(data.accounts);
  }

  if (isRecord(data.data)) {
    if (isRecord(data.data.accounts) && Array.isArray(data.data.accounts.accounts)) {
      pushRows(data.data.accounts.accounts);
    }
    if (Array.isArray(data.data.accounts)) {
      pushRows(data.data.accounts);
    }
  }

  return rows;
}

function buildSiteLookupKey(platform: string, siteUrl: string): string {
  return `${platform.trim().toLowerCase()}::${normalizeSiteBaseUrl(siteUrl)}`;
}

function buildAccountLookupKey(siteId: number, value: string | number): string {
  return `${siteId}::${String(value).trim().toLowerCase()}`;
}

function shouldPreferIncomingByUpdatedAt(existingUpdatedAt: string | null | undefined, incomingUpdatedAt: string): boolean {
  const incomingTime = Date.parse(incomingUpdatedAt);
  if (!Number.isFinite(incomingTime)) return false;

  const existingTime = Date.parse(existingUpdatedAt || '');
  if (!Number.isFinite(existingTime)) return true;
  return incomingTime >= existingTime;
}

function maxSortOrder(rows: Array<{ sortOrder: number | null }>): number {
  return rows.reduce((max, row) => Math.max(max, row.sortOrder || 0), -1);
}

function indexAccountLookupMaps(
  account: AccountRow,
  userIdIndex: Map<string, AccountRow>,
  usernameIndex: Map<string, AccountRow>,
  accessTokenIndex: Map<string, AccountRow>,
) {
  const userId = getPlatformUserIdFromExtraConfig(account.extraConfig);
  if (userId && userId > 0) {
    userIdIndex.set(buildAccountLookupKey(account.siteId, userId), account);
  }

  const username = asString(account.username);
  if (username) {
    usernameIndex.set(buildAccountLookupKey(account.siteId, username), account);
  }

  const accessToken = asString(account.accessToken);
  if (accessToken) {
    accessTokenIndex.set(buildAccountLookupKey(account.siteId, accessToken), account);
  }
}

function resolveExistingAccountByImportRow(
  siteId: number,
  platformUserId: number,
  username: string,
  accessToken: string,
  userIdIndex: Map<string, AccountRow>,
  usernameIndex: Map<string, AccountRow>,
  accessTokenIndex: Map<string, AccountRow>,
): AccountRow | null {
  if (platformUserId > 0) {
    const byUserId = userIdIndex.get(buildAccountLookupKey(siteId, platformUserId));
    if (byUserId) return byUserId;
  }

  if (username) {
    const byUsername = usernameIndex.get(buildAccountLookupKey(siteId, username));
    if (byUsername) return byUsername;
  }

  if (accessToken) {
    const byAccessToken = accessTokenIndex.get(buildAccountLookupKey(siteId, accessToken));
    if (byAccessToken) return byAccessToken;
  }

  return null;
}

function buildAccountsSectionFromRefBackup(data: RawBackupData): AccountsBackupSection | null {
  const accountsContainer = isRecord(data.accounts) ? data.accounts : null;
  const rows = Array.isArray(accountsContainer?.accounts) ? accountsContainer.accounts : null;
  if (!rows) return null;

  const sites: SiteRow[] = [];
  const accounts: AccountRow[] = [];
  const accountTokens: AccountTokenRow[] = [];
  const tokenRoutes: TokenRouteRow[] = [];
  const routeChannels: RouteChannelRow[] = [];

  const siteIdByKey = new Map<string, number>();
  let nextSiteId = 1;
  let nextAccountId = 1;
  let nextTokenId = 1;

  for (const item of rows) {
    if (!isRecord(item)) continue;

    const siteUrl = asString(item.site_url);
    if (!siteUrl) continue;

    const platform = normalizeLegacyPlatform(asString(item.site_type));
    const siteName = asString(item.site_name) || siteUrl;
    const importedExternalCheckinUrl = resolveLegacyExternalCheckinUrl(item);
    const siteKey = `${platform}::${siteUrl}`;

    let siteId = siteIdByKey.get(siteKey) || 0;
    if (!siteId) {
      siteId = nextSiteId++;
      siteIdByKey.set(siteKey, siteId);
      sites.push({
        id: siteId,
        name: siteName,
        url: siteUrl,
        externalCheckinUrl: importedExternalCheckinUrl,
        platform,
        proxyUrl: null,
        status: 'active',
        healthStatus: 'unknown',
        healthReason: null,
        healthCheckedAt: null,
        isPinned: false,
        sortOrder: sites.length,
        globalWeight: 1,
        apiKey: null,
        createdAt: toIsoString(item.created_at),
        updatedAt: toIsoString(item.updated_at),
      });
    }

    const accountInfo = isRecord(item.account_info) ? item.account_info : {};
    const cookieAuth = isRecord(item.cookieAuth) ? item.cookieAuth : {};
    const authType = asString(item.authType);

    const accountAccessToken =
      asString(accountInfo.access_token)
      || asString(cookieAuth.sessionCookie)
      || asString((item as Record<string, unknown>).access_token);
    if (!accountAccessToken) continue;

    const platformUserId = asNumber(accountInfo.id, 0);
    const username = asString(accountInfo.username)
      || asString(item.username)
      || (platformUserId > 0 ? `user-${platformUserId}` : `account-${nextAccountId}`);

    let apiToken: string | null = null;
    if (authType === 'api_key') {
      apiToken = accountAccessToken;
    }

    const createdAt = toIsoString(item.created_at);
    const updatedAt = toIsoString(item.updated_at);
    const checkin = isRecord(item.checkIn) ? item.checkIn : {};
    const extraConfigPayload = {
      platformUserId: platformUserId > 0 ? platformUserId : undefined,
      authType: authType || undefined,
      source: 'ref-all-api-hub',
    };

    const accountId = nextAccountId++;
    const importedBalance = normalizeLegacyQuota(accountInfo.quota);
    const importedUsed = normalizeLegacyQuota(accountInfo.today_quota_consumption);
    const importedQuota = importedBalance + importedUsed;

    accounts.push({
      id: accountId,
      siteId,
      username,
      accessToken: accountAccessToken,
      apiToken,
      balance: importedBalance,
      balanceUsed: importedUsed,
      quota: importedQuota > 0 ? importedQuota : importedBalance,
      unitCost: null,
      valueScore: 0,
      status: asBoolean(item.disabled, false) ? 'disabled' : 'active',
      isPinned: false,
      sortOrder: accounts.length,
      checkinEnabled: asBoolean(checkin.autoCheckInEnabled, true),
      lastCheckinAt: null,
      lastBalanceRefresh: null,
      extraConfig: JSON.stringify(extraConfigPayload),
      createdAt,
      updatedAt,
    });

    if (apiToken) {
      accountTokens.push({
        id: nextTokenId++,
        accountId,
        name: 'default',
        token: apiToken,
        tokenGroup: 'default',
        source: 'legacy',
        enabled: true,
        isDefault: true,
        createdAt,
        updatedAt,
      });
    }
  }

  return {
    sites,
    accounts,
    accountTokens,
    tokenRoutes,
    routeChannels,
  };
}

function buildPreferencesSectionFromRefBackup(data: RawBackupData): PreferencesBackupSection | null {
  const settings: Array<{ key: string; value: unknown }> = [];

  if (isRecord(data.preferences)) {
    settings.push({ key: 'legacy_preferences_ref_v2', value: data.preferences });
  }
  if (isRecord(data.channelConfigs)) {
    settings.push({ key: 'legacy_channel_configs_ref_v2', value: data.channelConfigs });
  }
  if (isRecord(data.apiCredentialProfiles)) {
    settings.push({ key: 'legacy_api_credential_profiles_ref_v2', value: data.apiCredentialProfiles });
  }
  if (isRecord(data.tagStore)) {
    settings.push({ key: 'legacy_tag_store_ref_v2', value: data.tagStore });
  }

  if (settings.length === 0) return null;
  return { settings };
}

function parseSettingValue(raw: string | null): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function stringifySettingValue(value: unknown): string {
  return JSON.stringify(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isSettingValueAcceptable(key: string, value: unknown): boolean {
  if (key === 'checkin_cron' || key === 'balance_refresh_cron' || key === 'site_health_refresh_cron') {
    return typeof value === 'string' && cron.validate(value);
  }

  if (key === 'proxy_token') {
    return typeof value === 'string'
      && value.trim().length >= 6
      && value.trim().startsWith('sk-');
  }

  if (key === 'smtp_port') {
    return isFiniteNumber(value) && value > 0;
  }

  if (key === 'routing_weights') {
    if (!isRecord(value)) return false;
    const keys = ['baseWeightFactor', 'valueScoreFactor', 'costWeight', 'balanceWeight', 'usageWeight'] as const;
    return keys.every((weightKey) => value[weightKey] === undefined || isFiniteNumber(value[weightKey]));
  }

  return true;
}

function exportAccountsSection(): AccountsBackupSection {
  const sites = db.select().from(schema.sites).orderBy(asc(schema.sites.id)).all();
  const accounts = db.select().from(schema.accounts).orderBy(asc(schema.accounts.id)).all();
  const accountTokens = db.select().from(schema.accountTokens).orderBy(asc(schema.accountTokens.id)).all();
  const tokenRoutes = db.select().from(schema.tokenRoutes).orderBy(asc(schema.tokenRoutes.id)).all();
  const routeChannels = db.select().from(schema.routeChannels).orderBy(asc(schema.routeChannels.id)).all();

  return {
    sites,
    accounts,
    accountTokens,
    tokenRoutes,
    routeChannels,
  };
}

function exportPreferencesSection(): PreferencesBackupSection {
  const settings = db.select().from(schema.settings).all()
    .filter((row) => !EXCLUDED_SETTING_KEYS.has(row.key))
    .map((row) => ({
      key: row.key,
      value: parseSettingValue(row.value),
    }));

  return { settings };
}

export function exportBackup(type: BackupExportType): BackupV2 {
  const now = Date.now();
  if (type === 'accounts') {
    return {
      version: BACKUP_VERSION,
      timestamp: now,
      type: 'accounts',
      accounts: exportAccountsSection(),
    };
  }

  if (type === 'preferences') {
    return {
      version: BACKUP_VERSION,
      timestamp: now,
      type: 'preferences',
      preferences: exportPreferencesSection(),
    };
  }

  return {
    version: BACKUP_VERSION,
    timestamp: now,
    accounts: exportAccountsSection(),
    preferences: exportPreferencesSection(),
  };
}

function coerceAccountsSection(input: unknown): AccountsBackupSection | null {
  if (!isRecord(input)) return null;

  const sites = Array.isArray(input.sites) ? input.sites as SiteRow[] : null;
  const accounts = Array.isArray(input.accounts) ? input.accounts as AccountRow[] : null;
  const accountTokens = Array.isArray(input.accountTokens) ? input.accountTokens as AccountTokenRow[] : null;
  const tokenRoutes = Array.isArray(input.tokenRoutes) ? input.tokenRoutes as TokenRouteRow[] : null;
  const routeChannels = Array.isArray(input.routeChannels) ? input.routeChannels as RouteChannelRow[] : null;

  if (!sites || !accounts || !accountTokens || !tokenRoutes || !routeChannels) return null;

  return {
    sites,
    accounts,
    accountTokens,
    tokenRoutes,
    routeChannels,
  };
}

function coercePreferencesSection(input: unknown): PreferencesBackupSection | null {
  if (!isRecord(input)) return null;
  const settingsRaw = input.settings;
  if (!Array.isArray(settingsRaw)) return null;

  const settings = settingsRaw
    .map((row) => {
      if (!isRecord(row)) return null;
      const key = typeof row.key === 'string' ? row.key.trim() : '';
      if (!key || EXCLUDED_SETTING_KEYS.has(key)) return null;
      return { key, value: row.value };
    })
    .filter((row): row is { key: string; value: unknown } => !!row);

  return { settings };
}

function detectAccountsSection(data: RawBackupData): AccountsBackupSection | null {
  const rootMatch = coerceAccountsSection(data);
  if (rootMatch) return rootMatch;

  if ('accounts' in data) {
    const nested = coerceAccountsSection(data.accounts);
    if (nested) return nested;
  }

  if (isRecord(data.data) && 'accounts' in data.data) {
    const legacyNested = coerceAccountsSection((data.data as Record<string, unknown>).accounts);
    if (legacyNested) return legacyNested;
  }

  const refFormat = buildAccountsSectionFromRefBackup(data);
  if (refFormat) return refFormat;

  return null;
}

function detectPreferencesSection(data: RawBackupData): PreferencesBackupSection | null {
  const rootMatch = coercePreferencesSection(data);
  if (rootMatch) return rootMatch;

  if ('preferences' in data) {
    const nested = coercePreferencesSection(data.preferences);
    if (nested) return nested;
  }

  if (isRecord(data.data) && 'preferences' in data.data) {
    const legacyNested = coercePreferencesSection((data.data as Record<string, unknown>).preferences);
    if (legacyNested) return legacyNested;
  }

  const refFormat = buildPreferencesSectionFromRefBackup(data);
  if (refFormat) return refFormat;

  return null;
}

function importAccountsSection(section: AccountsBackupSection) {
  db.transaction((tx) => {
    tx.delete(schema.routeChannels).run();
    tx.delete(schema.tokenRoutes).run();
    tx.delete(schema.tokenModelAvailability).run();
    tx.delete(schema.modelAvailability).run();
    tx.delete(schema.proxyLogs).run();
    tx.delete(schema.checkinLogs).run();
    tx.delete(schema.accountTokens).run();
    tx.delete(schema.accounts).run();
    tx.delete(schema.sites).run();

    for (const row of section.sites) {
      tx.insert(schema.sites).values({
        id: row.id,
        name: row.name,
        url: row.url,
        platform: row.platform,
        proxyUrl: row.proxyUrl ?? null,
        status: row.status || 'active',
        isPinned: row.isPinned ?? false,
        sortOrder: row.sortOrder ?? 0,
        globalWeight: row.globalWeight ?? 1,
        apiKey: row.apiKey,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }).run();
    }

    for (const row of section.accounts) {
      tx.insert(schema.accounts).values({
        id: row.id,
        siteId: row.siteId,
        username: row.username,
        accessToken: row.accessToken,
        apiToken: row.apiToken,
        balance: row.balance,
        balanceUsed: row.balanceUsed,
        quota: row.quota,
        unitCost: row.unitCost,
        valueScore: row.valueScore,
        status: row.status,
        isPinned: row.isPinned ?? false,
        sortOrder: row.sortOrder ?? 0,
        checkinEnabled: row.checkinEnabled,
        lastCheckinAt: row.lastCheckinAt,
        lastBalanceRefresh: row.lastBalanceRefresh,
        extraConfig: row.extraConfig,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }).run();
    }

    for (const row of section.accountTokens) {
      tx.insert(schema.accountTokens).values({
        id: row.id,
        accountId: row.accountId,
        name: row.name,
        token: row.token,
        tokenGroup: row.tokenGroup ?? null,
        source: row.source,
        enabled: row.enabled,
        isDefault: row.isDefault,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }).run();
    }

    for (const row of section.tokenRoutes) {
      tx.insert(schema.tokenRoutes).values({
        id: row.id,
        modelPattern: row.modelPattern,
        displayName: row.displayName ?? null,
        displayIcon: row.displayIcon ?? null,
        modelMapping: row.modelMapping,
        enabled: row.enabled,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }).run();
    }

    for (const row of section.routeChannels) {
      tx.insert(schema.routeChannels).values({
        id: row.id,
        routeId: row.routeId,
        accountId: row.accountId,
        tokenId: row.tokenId,
        sourceModel: row.sourceModel ?? null,
        priority: row.priority,
        weight: row.weight,
        enabled: row.enabled,
        manualOverride: row.manualOverride,
        successCount: row.successCount,
        failCount: row.failCount,
        totalLatencyMs: row.totalLatencyMs,
        totalCost: row.totalCost,
        lastUsedAt: row.lastUsedAt,
        lastFailAt: row.lastFailAt,
        cooldownUntil: row.cooldownUntil,
      }).run();
    }
  });
}

function importPreferencesSection(section: PreferencesBackupSection): Array<{ key: string; value: unknown }> {
  const applied: Array<{ key: string; value: unknown }> = [];

  db.transaction((tx) => {
    for (const row of section.settings) {
      if (!isSettingValueAcceptable(row.key, row.value)) continue;

      tx.insert(schema.settings).values({
        key: row.key,
        value: stringifySettingValue(row.value),
      }).onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: stringifySettingValue(row.value) },
      }).run();
      applied.push({ key: row.key, value: row.value });
    }
  });

  return applied;
}

export function importAllApiHubAccountsMerge(data: RawBackupData): AllApiHubMergeImportResult {
  if (!isRecord(data)) {
    throw new Error('导入数据格式错误：必须为 JSON 对象');
  }

  const rows = collectAllApiHubAccounts(data);
  if (rows.length === 0) {
    throw new Error('导入数据中没有可识别的 all-api-hub 账号列表（accounts.accounts）');
  }

  const existingSites = db.select().from(schema.sites).orderBy(asc(schema.sites.id)).all();
  const existingAccounts = db.select().from(schema.accounts).orderBy(asc(schema.accounts.id)).all();
  const existingTokens = db.select().from(schema.accountTokens).orderBy(asc(schema.accountTokens.id)).all();

  const siteByKey = new Map<string, SiteRow>();
  for (const site of existingSites) {
    siteByKey.set(buildSiteLookupKey(site.platform, site.url), site);
  }

  const accountBySiteUserId = new Map<string, AccountRow>();
  const accountBySiteUsername = new Map<string, AccountRow>();
  const accountBySiteAccessToken = new Map<string, AccountRow>();
  for (const account of existingAccounts) {
    indexAccountLookupMaps(account, accountBySiteUserId, accountBySiteUsername, accountBySiteAccessToken);
  }

  const tokenByAccountId = new Map<number, Set<string>>();
  for (const token of existingTokens) {
    const set = tokenByAccountId.get(token.accountId) || new Set<string>();
    set.add(token.token);
    tokenByAccountId.set(token.accountId, set);
  }

  let nextSiteSortOrder = maxSortOrder(existingSites) + 1;
  let nextAccountSortOrder = maxSortOrder(existingAccounts) + 1;

  const result: AllApiHubMergeImportResult = {
    importedRows: 0,
    skippedRows: 0,
    sites: { created: 0, reused: 0 },
    accounts: { created: 0, updated: 0, reused: 0 },
    tokens: { created: 0, reused: 0 },
    repairedDefaultTokenAccounts: 0,
  };

  const repairedAccountIds = new Set<number>();

  db.transaction((tx) => {
    for (const item of rows) {
      const siteUrl = normalizeSiteBaseUrl(item.site_url);
      if (!siteUrl) {
        result.skippedRows += 1;
        continue;
      }

      const platform = normalizeLegacyPlatform(asString(item.site_type));
      const siteName = asString(item.site_name) || siteUrl;
      const importedExternalCheckinUrl = resolveLegacyExternalCheckinUrl(item);
      const siteKey = buildSiteLookupKey(platform, siteUrl);

      let site = siteByKey.get(siteKey) || null;
      if (!site) {
        const now = new Date().toISOString();
        site = tx.insert(schema.sites).values({
          name: siteName,
          url: siteUrl,
          externalCheckinUrl: importedExternalCheckinUrl,
          platform,
          status: 'active',
          isPinned: false,
          sortOrder: nextSiteSortOrder++,
          globalWeight: 1,
          createdAt: now,
          updatedAt: now,
        }).returning().get();
        siteByKey.set(siteKey, site);
        result.sites.created += 1;
      } else {
        if (!site.externalCheckinUrl && importedExternalCheckinUrl) {
          tx.update(schema.sites).set({
            externalCheckinUrl: importedExternalCheckinUrl,
            updatedAt: new Date().toISOString(),
          }).where(eq(schema.sites.id, site.id)).run();
          const refreshedSite = tx.select().from(schema.sites).where(eq(schema.sites.id, site.id)).get();
          if (refreshedSite) {
            site = refreshedSite;
            siteByKey.set(siteKey, site);
          }
        }
        result.sites.reused += 1;
      }

      const accountInfo = isRecord(item.account_info) ? item.account_info : {};
      const cookieAuth = isRecord(item.cookieAuth) ? item.cookieAuth : {};
      const authType = normalizeLegacyAuthType(item.authType);
      const accountAccessToken =
        asString(accountInfo.access_token)
        || asString(cookieAuth.sessionCookie)
        || asString(item.access_token);
      if (!accountAccessToken) {
        result.skippedRows += 1;
        continue;
      }

      const platformUserId = asNumber(accountInfo.id, 0);
      const username = asString(accountInfo.username)
        || asString(item.username)
        || (platformUserId > 0 ? `user-${platformUserId}` : `account-${site.id}-${result.importedRows + result.skippedRows + 1}`);
      const createdAt = toIsoString(item.created_at);
      const updatedAt = toIsoString(item.updated_at);
      const checkin = isRecord(item.checkIn) ? item.checkIn : {};
      const importedBalance = normalizeLegacyQuota(accountInfo.quota);
      const importedUsed = normalizeLegacyQuota(accountInfo.today_quota_consumption);
      const importedQuota = importedBalance + importedUsed;

      const keyCandidates = collectLegacyKeyCandidates(item, accountInfo, accountAccessToken, authType);
      const credentialMode = resolveCredentialModeForLegacyImport(authType, accountAccessToken, keyCandidates);

      let existingAccount = resolveExistingAccountByImportRow(
        site.id,
        platformUserId,
        username,
        accountAccessToken,
        accountBySiteUserId,
        accountBySiteUsername,
        accountBySiteAccessToken,
      );

      if (!existingAccount) {
        const extraConfigPatch: Record<string, unknown> = {
          credentialMode,
          source: 'all-api-hub-import',
        };
        if (platformUserId > 0) {
          extraConfigPatch.platformUserId = platformUserId;
        }
        const created = tx.insert(schema.accounts).values({
          siteId: site.id,
          username,
          accessToken: accountAccessToken,
          apiToken: keyCandidates[0] || null,
          balance: importedBalance,
          balanceUsed: importedUsed,
          quota: importedQuota > 0 ? importedQuota : importedBalance,
          unitCost: null,
          valueScore: 0,
          status: asBoolean(item.disabled, false) ? 'disabled' : 'active',
          isPinned: false,
          sortOrder: nextAccountSortOrder++,
          checkinEnabled: asBoolean(checkin.autoCheckInEnabled, true),
          lastCheckinAt: null,
          lastBalanceRefresh: null,
          extraConfig: JSON.stringify(extraConfigPatch),
          createdAt,
          updatedAt,
        }).returning().get();

        existingAccount = created;
        indexAccountLookupMaps(existingAccount, accountBySiteUserId, accountBySiteUsername, accountBySiteAccessToken);
        result.accounts.created += 1;
      } else {
        const shouldUpdate = shouldPreferIncomingByUpdatedAt(existingAccount.updatedAt, updatedAt);
        if (shouldUpdate) {
          const mergedExtraConfig = mergeAccountExtraConfig(existingAccount.extraConfig, {
            credentialMode,
            source: 'all-api-hub-import',
            ...(platformUserId > 0 ? { platformUserId } : {}),
          });
          tx.update(schema.accounts).set({
            username: username || existingAccount.username,
            accessToken: accountAccessToken || existingAccount.accessToken,
            balance: importedBalance,
            balanceUsed: importedUsed,
            quota: importedQuota > 0 ? importedQuota : importedBalance,
            status: asBoolean(item.disabled, false) ? 'disabled' : 'active',
            checkinEnabled: asBoolean(checkin.autoCheckInEnabled, existingAccount.checkinEnabled ?? true),
            extraConfig: mergedExtraConfig,
            updatedAt,
          }).where(eq(schema.accounts.id, existingAccount.id)).run();

          const refreshed = tx.select().from(schema.accounts).where(eq(schema.accounts.id, existingAccount.id)).get();
          if (refreshed) {
            existingAccount = refreshed;
            indexAccountLookupMaps(existingAccount, accountBySiteUserId, accountBySiteUsername, accountBySiteAccessToken);
          }
          result.accounts.updated += 1;
        } else {
          result.accounts.reused += 1;
        }
      }

      const tokenSet = tokenByAccountId.get(existingAccount.id) || new Set<string>();
      if (keyCandidates.length === 0 && existingAccount.apiToken) {
        keyCandidates.push(existingAccount.apiToken);
      }

      for (const keyToken of keyCandidates) {
        if (!keyToken) continue;
        if (tokenSet.has(keyToken)) {
          result.tokens.reused += 1;
          continue;
        }
        tx.insert(schema.accountTokens).values({
          accountId: existingAccount.id,
          name: tokenSet.size === 0 ? 'default' : `imported-${tokenSet.size + 1}`,
          token: keyToken,
          tokenGroup: 'default',
          source: 'legacy',
          enabled: true,
          isDefault: false,
          createdAt: updatedAt,
          updatedAt,
        }).run();
        tokenSet.add(keyToken);
        result.tokens.created += 1;
      }
      tokenByAccountId.set(existingAccount.id, tokenSet);

      if (tokenSet.size > 0 || existingAccount.apiToken) {
        repairedAccountIds.add(existingAccount.id);
      }

      result.importedRows += 1;
    }
  });

  for (const accountId of repairedAccountIds) {
    repairDefaultToken(accountId);
  }
  result.repairedDefaultTokenAccounts = repairedAccountIds.size;

  return result;
}

export function importBackup(data: RawBackupData): BackupImportResult {
  if (!isRecord(data)) {
    throw new Error('导入数据格式错误：必须为 JSON 对象');
  }

  if (!('timestamp' in data) || data.timestamp === null || data.timestamp === undefined) {
    throw new Error('导入数据格式错误：缺少 timestamp');
  }

  const accountsSection = detectAccountsSection(data);
  const preferencesSection = detectPreferencesSection(data);

  const type = typeof data.type === 'string' ? data.type : '';
  const accountsRequested = type === 'accounts' || !!accountsSection;
  const preferencesRequested = type === 'preferences' || !!preferencesSection;

  if (!accountsRequested && !preferencesRequested) {
    throw new Error('导入数据中没有可识别的账号或设置数据');
  }

  let accountsImported = false;
  let preferencesImported = false;
  let appliedSettings: Array<{ key: string; value: unknown }> = [];

  if (accountsRequested) {
    if (!accountsSection) {
      throw new Error('导入数据格式错误：账号数据结构不正确');
    }
    importAccountsSection(accountsSection);
    accountsImported = true;
  }

  if (preferencesRequested) {
    if (!preferencesSection) {
      throw new Error('导入数据格式错误：设置数据结构不正确');
    }
    appliedSettings = importPreferencesSection(preferencesSection);
    preferencesImported = true;
  }

  return {
    allImported: (!accountsRequested || accountsImported) && (!preferencesRequested || preferencesImported),
    sections: {
      accounts: accountsImported,
      preferences: preferencesImported,
    },
    appliedSettings,
  };
}
