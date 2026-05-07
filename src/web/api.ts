import { clearAuthSession, getAuthToken, getBearerAuthToken } from './authSession.js';

type RequestOptions = RequestInit & {
  timeoutMs?: number | null;
};

function hasContentTypeHeader(headers?: HeadersInit): boolean {
  if (!headers) return false;
  if (headers instanceof Headers) return headers.has('Content-Type') || headers.has('content-type');
  if (Array.isArray(headers)) {
    return headers.some(([key]) => key.toLowerCase() === 'content-type');
  }
  return Object.keys(headers).some((key) => key.toLowerCase() === 'content-type');
}

function normalizeJsonRequestInit(fetchOptions: RequestInit): RequestInit {
  const method = String(fetchOptions.method || 'GET').toUpperCase();
  const shouldEnsureJsonBody = (
    (method === 'POST' || method === 'PUT' || method === 'PATCH')
    && fetchOptions.body == null
    && !hasContentTypeHeader(fetchOptions.headers)
  );

  if (!shouldEnsureJsonBody) return fetchOptions;

  return {
    ...fetchOptions,
    body: '{}',
  };
}

function ensureAuthSession(): void {
  const token = getAuthToken(localStorage);
  if (!token) {
    const hadToken = !!localStorage.getItem('auth_token');
    clearAuthSession(localStorage);
    if (hadToken && typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
      window.location.reload();
    }
    throw new Error('Session expired');
  }
}

async function extractResponseErrorMessage(res: Response): Promise<string> {
  let message = `HTTP ${res.status}`;
  try {
    const text = await res.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        if (json?.message && typeof json.message === 'string') {
          message = json.message;
        } else if (json?.error && typeof json.error === 'string') {
          message = json.error;
        } else if (json?.error?.message && typeof json.error.message === 'string') {
          message = json.error.message;
        } else {
          message = `${message}: ${text.slice(0, 120)}`;
        }
      } catch {
        message = `${message}: ${text.slice(0, 120)}`;
      }
    }
  } catch { }
  return message;
}

async function isAdminSessionStillActive(): Promise<boolean> {
  try {
    const response = await fetch('/api/auth/session', {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!response.ok) return false;
    const payload = await response.json().catch(() => null) as { active?: unknown } | null;
    return payload?.active === true;
  } catch {
    return false;
  }
}

function parseContentDispositionFilename(headerValue: string | null): string | null {
  if (!headerValue) return null;
  const utf8Match = /filename\*=UTF-8''([^;]+)/i.exec(headerValue);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1]);
    } catch {
      return utf8Match[1];
    }
  }
  const quotedMatch = /filename="([^"]+)"/i.exec(headerValue);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const bareMatch = /filename=([^;]+)/i.exec(headerValue);
  return bareMatch?.[1]?.trim() || null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(buffer).toString('base64');
  }

  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

async function fetchAuthenticatedResponse(url: string, options: RequestOptions = {}): Promise<Response> {
  const { timeoutMs = 30_000, signal: externalSignal, ...fetchOptions } = options;
  const normalizedFetchOptions = normalizeJsonRequestInit(fetchOptions);
  const controller = new AbortController();
  const effectiveTimeoutMs = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : null;
  let timeoutHandle: ReturnType<typeof setTimeout> | null = effectiveTimeoutMs
    ? setTimeout(() => {
      controller.abort();
    }, effectiveTimeoutMs)
    : null;
  let cleanupExternalSignal = () => { };

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      const abortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', abortHandler, { once: true });
      cleanupExternalSignal = () => externalSignal.removeEventListener('abort', abortHandler);
    }
  }

  try {
    ensureAuthSession();
    const bearerToken = getBearerAuthToken(localStorage);
    const headers: Record<string, string> = {};
    if (bearerToken) {
      headers['Authorization'] = `Bearer ${bearerToken}`;
    }
    if (normalizedFetchOptions.body) headers['Content-Type'] = 'application/json';

    const res = await fetch(url, {
      ...normalizedFetchOptions,
      credentials: normalizedFetchOptions.credentials ?? 'same-origin',
      signal: controller.signal,
      headers: {
        ...headers,
        ...normalizedFetchOptions.headers as Record<string, string>,
      },
    });
    if (res.status === 401 || res.status === 403) {
      const message = await extractResponseErrorMessage(res.clone());
      const sessionActive = await isAdminSessionStillActive();
      if (!sessionActive) {
        const hadToken = !!getAuthToken(localStorage);
        clearAuthSession(localStorage);
        if (hadToken && typeof window !== 'undefined' && typeof window.location?.reload === 'function') {
          window.location.reload();
        }
        throw new Error('Session expired');
      }
      throw new Error(message);
    }
    return res;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      if (externalSignal?.aborted) throw error;
      const timeoutSeconds = effectiveTimeoutMs ? Math.max(1, Math.round(effectiveTimeoutMs / 1000)) : 30;
      throw new Error(`请求超时（${timeoutSeconds}s）`);
    }
    throw error;
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }
    cleanupExternalSignal();
  }
}

async function request(url: string, options: RequestOptions = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetchAuthenticatedResponse(url, options);
      if (!res.ok) {
        throw new Error(await extractResponseErrorMessage(res));
      }
      return res.json();
    } catch (err) {
      lastError = err;
      if (method !== 'GET' || attempt >= 2) break;
      if (!(err instanceof TypeError)) break;
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw lastError;
}

function buildQueryString(params?: Record<string, string | number | boolean | null | undefined>) {
  if (!params) return '';
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    searchParams.set(key, String(value));
  }
  const serialized = searchParams.toString();
  return serialized ? `?${serialized}` : '';
}

type TestChatRequestPayload = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  targetFormat?: 'openai' | 'claude' | 'responses' | 'gemini';
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
};

export type ProxyTestMethod = 'POST' | 'GET' | 'DELETE';
export type ProxyTestRequestKind = 'json' | 'multipart' | 'empty';

export type ProxyTestMultipartFile = {
  field: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

export type ProxyTestRequestEnvelope = {
  method: ProxyTestMethod;
  path: string;
  requestKind: ProxyTestRequestKind;
  stream?: boolean;
  jobMode?: boolean;
  rawMode?: boolean;
  forcedChannelId?: number | null;
  jsonBody?: unknown;
  rawJsonText?: string;
  multipartFields?: Record<string, string>;
  multipartFiles?: ProxyTestMultipartFile[];
};

const DEFAULT_PROXY_TEST_TIMEOUT_MS = 30_000;
const LONG_RUNNING_PROXY_TEST_TIMEOUT_MS = 150_000;

function resolveProxyTestTimeoutMs(data: ProxyTestRequestEnvelope) {
  if (data.jobMode) return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === '/v1/images/generations') return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === '/v1/images/edits') return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  if (data.path === '/v1/videos' && data.method === 'POST') return LONG_RUNNING_PROXY_TEST_TIMEOUT_MS;
  return DEFAULT_PROXY_TEST_TIMEOUT_MS;
}

export type ProxyTestJobResponse = {
  jobId: string;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
  result?: unknown;
  error?: unknown;
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
};

export type RouteDecisionCandidate = {
  channelId: number;
  accountId: number;
  username: string;
  siteName: string;
  tokenName: string;
  priority: number;
  weight: number;
  eligible: boolean;
  recentlyFailed: boolean;
  avoidedByRecentFailure: boolean;
  avoidedByInflightLease?: boolean;
  cooldownUntil?: string | null;
  lastFailAt?: string | null;
  leasedUntil?: string | null;
  consecutiveFailCount?: number;
  cooldownLevel?: number;
  probability: number;
  reason: string;
  circuitStatus?: {
    state?: string;
    isOpen?: boolean;
    reason?: string;
  };
  modelCircuitStatus?: {
    state?: string;
    isOpen?: boolean;
    isHalfOpen?: boolean;
    reason?: string;
    effectiveMultiplier?: number;
  };
  siteRuntimeState?: {
    globalMultiplier?: number;
    modelMultiplier?: number;
    combinedMultiplier?: number;
    globalBreakerOpen?: boolean;
    modelBreakerOpen?: boolean;
  };
};

export type RouteDecision = {
  requestedModel: string;
  actualModel: string;
  matched: boolean;
  routeId?: number;
  modelPattern?: string;
  selectedChannelId?: number;
  selectedAccountId?: number;
  selectedLabel?: string;
  summary: string[];
  candidates: RouteDecisionCandidate[];
};

export type AddAccountResponse = {
  batch?: false;
  id?: number;
  username?: string | null;
  queued?: boolean;
  message?: string;
  tokenType?: 'session' | 'apikey' | 'unknown';
  credentialMode?: 'session' | 'apikey';
  usernameDetected?: boolean;
  apiTokenFound?: boolean;
} | {
  success: boolean;
  batch: true;
  total: number;
  successCount: number;
  failedCount: number;
  successItems: Array<{
    id: number;
    username: string | null;
    tokenType: 'session' | 'apikey' | 'unknown';
    queued: boolean;
    jobId?: string;
  }>;
  failedItems: Array<{
    value: string;
    message: string;
  }>;
  message: string;
};

export type RouteDiagnosticsResponse = {
  success: boolean;
  generatedAt: string;
  limits: {
    itemLimit: number;
  };
  routeSummary: {
    routeCount: number;
    enabledRouteCount: number;
    channelCount: number;
    enabledChannelCount: number;
  };
  snapshotCounts: {
    endpointRuntimeMemory: number;
    endpointCredentialScopes: number;
    persistedEndpointProfiles: number;
    modelCircuits: number;
    siteRuntimeStates: number;
    accountRuntimeStates: number;
    unavailableModels: number;
    siteProfiles: number;
    checkinTodoSites: number;
    checkinSiteRuntimeStates: number;
  };
  endpointRuntimeMemory: {
    total: number;
    items: Array<{
      key: string;
      siteId: number | null;
      siteName: string | null;
      preferredEndpoint: string | null;
      preferredUpdatedAtMs: number;
      blockedUntilMsByEndpoint: Record<string, number | undefined>;
      activeBlocks: string[];
      hasFreshPreference: boolean;
    }>;
  };
  endpointCredentialScopes: {
    total: number;
    items: Array<{
      cacheKey: string;
      siteId: number;
      siteName: string | null;
      accountId: number | null;
      accountUsername: string | null;
      credentialSource: string;
      credentialFingerprint: string | null;
    }>;
  };
  persistedEndpointProfiles: {
    total: number;
    items: Array<{
      key: string;
      siteId: number | null;
      siteName: string | null;
      preferredEndpoint: string | null;
      preferredUpdatedAtMs: number;
      blockedUntilMsByEndpoint: Record<string, number | undefined>;
      activeBlocks: string[];
      hasFreshPreference: boolean;
    }>;
  };
  modelCircuits: {
    total: number;
    openCount: number;
    halfOpenCount: number;
    items: Array<{
      channelId: number;
      modelName: string;
      state: string;
      failCount: number;
      openedAtMs: number | null;
      openUntilMs: number | null;
      lastErrorAtMs: number | null;
      lastSuccessAtMs: number | null;
      probeInFlight: boolean;
      status: {
        state: string;
        isOpen: boolean;
        isHalfOpen: boolean;
        openUntil: number | null;
        reason: string;
        effectiveMultiplier: number;
      };
      routeId: number | null;
      routeModelPattern: string | null;
      accountId: number | null;
      accountUsername: string | null;
      siteId: number | null;
      siteName: string | null;
    }>;
  };
  siteRuntimeHealth: {
    total: number;
    breakerOpenCount: number;
    penalizedCount: number;
    items: Array<{
      siteId: number;
      siteName: string;
      sitePlatform: string;
      siteStatus: string;
      modelName: string | null;
      scope: 'global' | 'model';
      penaltyScore: number;
      latencyEmaMs: number | null;
      transientFailureStreak: number;
      breakerLevel: number;
      breakerUntilMs: number | null;
      breakerUntil: string | null;
      lastUpdatedAtMs: number;
      lastFailureAtMs: number | null;
      lastFailureAt: string | null;
      lastSuccessAtMs: number | null;
      lastSuccessAt: string | null;
      multiplier: number;
      breakerOpen: boolean;
    }>;
  };
  accountRuntimeHealth: {
    total: number;
    busyCount: number;
    stickyActiveCount: number;
    items: Array<{
      accountId: number;
      siteId: number | null;
      username: string | null;
      siteName: string | null;
      inflightCount: number;
      concurrencyBudget: number;
      successEma: number;
      recentFailures: number;
      stickyActiveCount: number;
      rateBudgetPerMinute: number;
      rateTokensRemaining: number;
      rateBudgetState: string;
      stickyAssignmentsHash: string | null;
      lastStickyUpdatedAtMs: number | null;
      lastSuccessAtMs: number | null;
      lastSuccessAt: string | null;
      lastFailureAtMs: number | null;
      lastFailureAt: string | null;
      updatedAtMs: number;
    }>;
  };
  unavailableModels: {
    total: number;
    blockingCount: number;
    items: Array<{
      scope: 'token' | 'account';
      ownerId: number;
      tokenId: number | null;
      accountId: number | null;
      accountUsername: string | null;
      siteId: number | null;
      siteName: string | null;
      modelName: string;
      checkedAt: string | null;
      checkedAtMs: number;
      stillBlocking: boolean;
      ageMs: number;
    }>;
  };
  checkinSiteRuntime: {
    total: number;
    blockedCount: number;
    items: Array<{
      siteId: number;
      siteName: string;
      sitePlatform: string;
      siteStatus: string;
      failureStreak: number;
      blockedUntilMs: number | null;
      blockedUntil: string | null;
      blocked: boolean;
      lastFailureAtMs: number | null;
      lastFailureAt: string | null;
      lastSuccessAtMs: number | null;
      lastSuccessAt: string | null;
      lastReasonCode: string | null;
      lastMessage: string | null;
      updatedAtMs: number;
    }>;
  };
  siteProfiles: {
    total: number;
    manualConfiguredCount: number;
    items: Array<{
      siteId: number;
      siteName: string;
      siteUrl: string;
      platform: string;
      status: string;
      protocolMode: 'auto' | 'manual';
      supportedEndpoints: string[];
      preferredEndpoint: string | null;
      protocolUpdatedAt: string | null;
      schedulableCheckinAccounts: number;
      activeAccounts: number;
      expiredAccounts: number;
      degradedAccounts: number;
    }>;
  };
  checkinTodo: {
    scheduleMode: 'cron' | 'interval';
    intervalHours: number;
    totalSchedulableAccounts: number;
    dueNowCount: number;
    manualRequiredCount: number;
    unsupportedCount: number;
    failedRecentCount: number;
    attentionCount: number;
    siteBackoffBlockedCount: number;
    sites: Array<{
      siteId: number;
      siteName: string;
      siteStatus: string;
      siteBackoffBlocked: boolean;
      siteBackoffUntil: string | null;
      siteBackoffUntilMs: number | null;
      siteBackoffFailureStreak: number;
      siteBackoffReasonCode: string | null;
      siteBackoffMessage: string | null;
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
        checkinSnapshot: {
          status: string;
          reasonCode: string;
          retryable: boolean;
          requiresManual: boolean;
          unsupported: boolean;
          lastAttemptAt: string;
          lastSuccessAt?: string | null;
          nextRetryAt?: string | null;
          message: string;
          reward?: string | null;
          scheduleMode?: 'cron' | 'interval';
          source: 'checkin';
        } | null;
        runtimeHealth: {
          state: string;
          reason: string;
          source: string;
          checkedAt: string | null;
        } | null;
        latestCheckinStatus: string | null;
        latestCheckinMessage: string | null;
        latestCheckinAt: string | null;
      }>;
    }>;
  };
};

export type OperationalOptimizationOverview = {
  success: true;
  generatedAt: string;
  scores: {
    usability: number;
    stability: number;
    speed: number;
    tokenSavings: number;
    overall: number;
  };
  counts: {
    sites: number;
    activeSites: number;
    siteProfiles: number;
    protocolProfiles: number;
    accounts: number;
    activeAccounts: number;
    checkinStates: number;
    checkinAttention: number;
    modelCapabilities: number;
    governanceSuppressed: number;
    governanceProbing: number;
    responseCacheHits: number;
    responseCacheMisses: number;
  };
  policies: {
    responseCache: {
      enabled: boolean;
      ttlMs: number;
      maxRows: number;
      staleIfErrorMs: number;
      deterministicOnly: boolean;
    };
    retryBudget: {
      requestBudgetMs: number;
      maxRetries: number;
      maxChannelAttempts: number;
      honorRetryAfter: boolean;
      failFastOnKnownBadEndpoint: boolean;
    };
  };
  topSites: Array<{
    siteId: number;
    name: string;
    platform: string;
    operationalScore: number;
    onboardingScore: number;
    accountCount: number;
    activeAccountCount: number;
    checkinAttention: number;
    routeGovernanceCount: number;
    protocolPreferredEndpoint: string | null;
  }>;
  attention: Array<{
    type: 'site' | 'account' | 'route' | 'gateway';
    severity: 'info' | 'warning' | 'error';
    title: string;
    detail: string;
    action: string;
    targetId?: number;
  }>;
  optimizationItems: Array<{
    id: string;
    title: string;
    area: string;
    status: 'ready' | 'attention' | 'missing';
    evidence: string;
    action: string;
  }>;
  metrics: {
    responseCache: {
      ready: boolean;
      savedTokens: number;
      savedCost: number;
      hits: number;
      staleHits: number;
      misses: number;
      [key: string]: unknown;
    };
    retryBackoff: {
      totalMs: number;
      count: number;
      retryAfterHonoredCount: number;
      budgetExhaustedCount: number;
      [key: string]: unknown;
    };
  };
};

export type ProxyDebugTraceItem = {
  at: string;
  kind: string;
  traceId: string;
  sessionId: string | null;
  traceHint: string | null;
  requestedModel: string | null;
  actualModel?: string | null;
  downstreamPath?: string | null;
  routeId?: number | null;
  channelId?: number | null;
  siteId?: number | null;
  siteName?: string | null;
  endpoint?: string | null;
  endpointPath?: string | null;
  status?: number | null;
  retryCount?: number | null;
  reason?: string | null;
  detail?: Record<string, unknown> | null;
};

export type ProxyDebugTraceSummary = {
  total: number;
  kinds: Record<string, number>;
  sites: Array<{
    siteId: number | null;
    siteName: string | null;
    count: number;
  }>;
};

export type ProxyDebugTracesResponse = {
  success: boolean;
  total: number;
  summary?: ProxyDebugTraceSummary;
  items: ProxyDebugTraceItem[];
};

export type RouteOverviewResponse = {
  success: true;
  generatedAt: string;
  routeSummary: {
    routeCount: number;
    enabledRouteCount: number;
    channelCount: number;
    enabledChannelCount: number;
  };
  governance: {
    total: number;
    suppressed: number;
    probing: number;
    byReason: Record<string, number>;
  };
  runtime: {
    modelCircuitOpen: number;
    modelCircuitHalfOpen: number;
    siteRuntimeBreakerOpen: number;
    siteRuntimePenalized: number;
    unavailableModelBlocking: number;
    checkinAttention: number;
    checkinSiteBackoffBlocked: number;
  };
};

export type RoutingGovernanceSubject = {
  id: number;
  subjectType: 'site' | 'account' | 'token' | 'channel';
  subjectId: number;
  diagnosticTargetType?: 'site' | 'account' | 'token';
  diagnosticTargetId?: number | null;
  modelName: string;
  state: 'suppressed' | 'probing';
  reasonCode: string;
  reasonDetail: string | null;
  probeModelName: string | null;
  lastHttpStatus: number | null;
  failureCount: number;
  successCount: number;
  suppressUntil: string | null;
  probeAfter: string | null;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
  lastProbeAt: string | null;
  lastProbeStatus: string | null;
  lastProbeMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type RouteSummaryRow = {
  id: number;
  modelPattern: string;
  displayName: string | null;
  displayIcon: string | null;
  routeMode: 'pattern' | 'explicit_group';
  probePolicy: 'system' | 'manual';
  sourceRouteIds: number[];
  modelMapping: string | null;
  routingStrategy: string;
  enabled: boolean;
  channelCount: number;
  enabledChannelCount: number;
  siteNames: string[];
  decisionSnapshot: RouteDecision | null;
  decisionSnapshotAvailable: boolean;
  decisionRefreshedAt: string | null;
};

export type RouteGovernanceSubjectsResponse = {
  success: true;
  total: number;
  summary: {
    total: number;
    suppressedCount: number;
    probingCount: number;
    countsByReason: Record<string, number>;
    countsBySubjectType: Record<string, number>;
  };
  items: RoutingGovernanceSubject[];
};

export type RouteGovernanceRecoveryPassResponse = {
  success: true;
  scanned: number;
  promotedToProbing: number;
  keptSuppressed: number;
  restored: number;
  items: Array<{
    id: number;
    subjectType: 'site' | 'account' | 'token' | 'channel';
    subjectId: number;
    modelName: string;
    action: 'promoted_to_probing' | 'already_probing';
    state: 'suppressed' | 'probing';
  }>;
};

export type RouteProbeItem = {
  channelId: number;
  accountId: number;
  accountName: string | null;
  siteId: number;
  siteName: string;
  tokenId: number | null;
  tokenName: string | null;
  sourceModel: string | null;
  available: boolean;
  inconclusive?: boolean;
  reason: string;
  probeClassification: 'supported' | 'model_unavailable' | 'credential' | 'protocol_mismatch' | 'inconclusive' | null;
  probeEndpoint: string | null;
  latencyMs: number | null;
  detectionMethod: 'model_list' | 'realtime_probe' | 'unknown' | 'probe_failed';
  governanceAction: 'suppressed' | 'cleared' | 'none';
  governanceReasonCode: string | null;
};

export type RouteProbeResponse = {
  success: true;
  routeId: number;
  routeModelPattern: string;
  probedModel: string;
  autoGovernance: boolean;
  total: number;
  availableCount: number;
  unavailableCount: number;
  skippedCount: number;
  inconclusiveCount: number;
  failedCount: number;
  items: RouteProbeItem[];
};

export type RuntimeOverview = {
  service: {
    name: string;
    version: string;
    uptimeSec: number;
    startedAt: string;
    now: string;
    environment: {
      port: number;
      host: string;
      dbDialect: string;
      dataDir: string;
    };
  };
  database: {
    ready: boolean;
    dialect: string;
  };
  oauthLoopback: {
    total: number;
    ready: number;
    attempted: number;
    states: Array<{
      provider: string;
      attempted: boolean;
      ready: boolean;
      host?: string;
      port: number;
      path: string;
      origin: string;
      redirectUri: string;
      error?: string;
    }>;
  };
  backgroundTasks: {
    total: number;
    pending: number;
    running: number;
    failed: number;
  };
  notifications: {
    webhookEnabled: boolean;
    barkEnabled: boolean;
    telegramEnabled: boolean;
    serverChanEnabled: boolean;
    smtpEnabled: boolean;
    cooldownSec: number;
  };
  recentActivity: {
    proxyRequests24h: number;
    proxyFailures24h: number;
    unreadEvents: number;
  };
};

export type SystemProxyTestRequest = {
  proxyUrl?: string;
};

export type SystemProxyTestResponse = {
  success: true;
  proxyUrl: string;
  probeUrl: string;
  finalUrl: string;
  reachable: true;
  ok: boolean;
  statusCode: number;
  latencyMs: number;
};

export type CredentialDiagnosticTarget = {
  type: 'site' | 'account' | 'token';
  site: {
    id: number;
    name: string;
    url: string;
    platform: string;
    status: string;
  };
  account: {
    id: number;
    username: string | null;
    status: string | null;
  } | null;
  token: {
    id: number;
    name: string;
    enabled: boolean;
  } | null;
};

export type CredentialDiagnosticResponse = {
  success: true;
  target: CredentialDiagnosticTarget;
  connectivity: {
    normalizedUrl: string;
    reachable: boolean | null;
    status: string;
    message: string | null;
    checkedAt: string | null;
    credentialPresent: boolean;
    credentialSource: string;
    probe: {
      reachable: boolean | null;
      statusCode: number | null;
      latencyMs: number | null;
      detail: string | null;
    };
  };
  protocol: {
    ok: boolean;
    protocol: string | null;
    preferredEndpoint: string | null;
    supportedEndpoints: string[];
    probeSource: string;
    latencyMs: number | null;
    attemptSummary: string[];
    accountId: number | null;
    accountName: string | null;
    error?: string;
  };
  models: {
    source: string;
    total: number;
    recommendedBaseModel: string | null;
    items: Array<{
      name: string;
      latencyMs: number | null;
      disabled: boolean;
      isManual: boolean;
    }>;
  };
  debug: {
    ok: boolean;
    modelName: string | null;
    requestPath: string | null;
    requestFormat: string | null;
    errorSummary: string | null;
    rawPreview: string | null;
    classification?: string | null;
    statusCode?: number | null;
  };
  routing: {
    referencedRoutes: Array<{
      id: number;
      modelPattern: string;
      displayName: string | null;
      decisionSnapshot: unknown | null;
      decisionRefreshedAt: string | null;
      decisionModelName: string | null;
    }>;
    governance: Array<{
      id: number;
      subjectType: string;
      subjectId: number;
      state: string;
      reasonCode: string;
      modelName: string;
      updatedAt: string | null;
    }>;
    downstreamKeys: Array<{
      id: number;
      name: string;
      groupName: string | null;
    }>;
  };
  capability: {
    hasAdapter: boolean;
    canReadModels: boolean;
    canBenchmark: boolean;
  };
};

export type CredentialBenchmarkResponse = {
  success: true;
  rounds: 1 | 3;
  target: {
    type: 'site' | 'account' | 'token';
    siteId: number;
    accountId: number | null;
    tokenId: number | null;
  };
  recommended: {
    modelName: string;
    reason: string;
  } | null;
  items: Array<{
    modelName: string;
    rounds: number;
    samples: Array<{
      ok: boolean;
      elapsedMs: number | null;
      firstTokenMs: number | null;
      error: string | null;
    }>;
    successRate: number;
    avgLatencyMs: number | null;
    medianLatencyMs: number | null;
    medianFirstTokenMs: number | null;
  }>;
};

export type ProxyLogStatusFilter = 'all' | 'success' | 'failed';
export type ProxyLogClientConfidence = 'exact' | 'heuristic' | 'unknown' | null;

export type ProxyLogBillingDetails = {
  quotaType: number;
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    billablePromptTokens: number;
    promptTokensIncludeCache: boolean | null;
  };
  pricing: {
    modelRatio: number;
    completionRatio: number;
    cacheRatio: number;
    cacheCreationRatio: number;
    groupRatio: number;
  };
  breakdown: {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion: number;
    cacheCreationPerMillion: number;
    inputCost: number;
    outputCost: number;
    cacheReadCost: number;
    cacheCreationCost: number;
    totalCost: number;
  };
} | null;

export type ProxyLogListItem = {
  id: number;
  createdAt: string;
  modelRequested: string;
  modelActual: string;
  status: string;
  latencyMs: number;
  totalTokens: number | null;
  retryCount: number;
  accountId?: number | null;
  accountBalance?: number | null;
  accountBalanceEstimated?: number | null;
  siteId?: number | null;
  username?: string | null;
  siteName?: string | null;
  siteUrl?: string | null;
  errorMessage?: string | null;
  downstreamKeyId?: number | null;
  downstreamKeyName?: string | null;
  downstreamKeyGroupName?: string | null;
  downstreamKeyTags?: string[];
  clientFamily?: string | null;
  clientAppId?: string | null;
  clientAppName?: string | null;
  clientConfidence?: ProxyLogClientConfidence;
  promptTokens?: number | null;
  completionTokens?: number | null;
  estimatedCost?: number | null;
  cacheStatus?: string | null;
  cacheSavedCost?: number | null;
};

export type ProxyLogDetail = ProxyLogListItem & {
  routeId?: number | null;
  channelId?: number | null;
  httpStatus?: number | null;
  billingDetails?: ProxyLogBillingDetails;
};

export type ProxyLogsSummary = {
  totalCount: number;
  successCount: number;
  failedCount: number;
  totalCost: number;
  totalTokensAll: number;
  cacheHitCount: number;
  cacheMissCount: number;
  cacheStaleCount: number;
  cacheSavedCost: number;
};

export type ProxyLogsQuery = {
  limit?: number;
  offset?: number;
  status?: ProxyLogStatusFilter;
  search?: string;
  client?: string;
  siteId?: number;
  from?: string;
  to?: string;
};

export type ProxyLogClientOption = {
  value: string;
  label: string;
};

export type ProxyLogsResponse = {
  items: ProxyLogListItem[];
  total: number;
  page: number;
  pageSize: number;
  clientOptions: ProxyLogClientOption[];
  summary: ProxyLogsSummary;
};

export type AccountKeyRepairResponse = {
  success: boolean;
  queued?: boolean;
  reused?: boolean;
  jobId?: string;
  status?: string;
  message?: string;
};

export type OAuthProviderInfo = {
  provider: string;
  label: string;
  platform: string;
  enabled: boolean;
  loginType: 'oauth';
  requiresProjectId: boolean;
  supportsDirectAccountRouting: boolean;
  supportsCloudValidation: boolean;
  supportsNativeProxy: boolean;
};

export type OAuthStartInstructions = {
  redirectUri: string;
  callbackPort: number;
  callbackPath: string;
  manualCallbackDelayMs: number;
  sshTunnelCommand?: string;
  sshTunnelKeyCommand?: string;
};

export type OAuthStartResponse = {
  provider: string;
  state: string;
  authorizationUrl: string;
  instructions: OAuthStartInstructions;
};

export type OAuthSessionInfo = {
  provider: string;
  state: string;
  status: 'pending' | 'success' | 'error';
  accountId?: number;
  siteId?: number;
  error?: string;
};

export type OAuthQuotaWindowInfo = {
  supported: boolean;
  limit?: number | null;
  used?: number | null;
  remaining?: number | null;
  resetAt?: string | null;
  message?: string | null;
};

export type OAuthQuotaInfo = {
  status: 'supported' | 'unsupported' | 'error';
  source: 'official' | 'reverse_engineered';
  lastSyncAt?: string | null;
  lastError?: string | null;
  providerMessage?: string | null;
  subscription?: {
    planType?: string | null;
    activeStart?: string | null;
    activeUntil?: string | null;
  } | null;
  windows: {
    fiveHour: OAuthQuotaWindowInfo;
    sevenDay: OAuthQuotaWindowInfo;
  };
  lastLimitResetAt?: string | null;
};

export type OAuthConnectionInfo = {
  accountId: number;
  siteId: number;
  provider: string;
  username?: string | null;
  email?: string | null;
  accountKey?: string | null;
  planType?: string | null;
  projectId?: string | null;
  modelCount: number;
  modelsPreview: string[];
  status: 'healthy' | 'abnormal';
  quota?: OAuthQuotaInfo | null;
  routeChannelCount?: number;
  lastModelSyncAt?: string | null;
  lastModelSyncError?: string | null;
  site?: { id: number; name: string; url: string; platform: string } | null;
};

export type OAuthConnectionsResponse = {
  items: OAuthConnectionInfo[];
  total: number;
  limit: number;
  offset: number;
};

export const api = {
  createAdminSession: async (token: string) => {
    const response = await fetch('/api/auth/session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      throw new Error(await extractResponseErrorMessage(response));
    }
    return response.json();
  },
  getAdminSession: async () => {
    const response = await fetch('/api/auth/session', {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new Error(await extractResponseErrorMessage(response));
    }
    return response.json();
  },
  clearAdminSession: async () => {
    const response = await fetch('/api/auth/session', {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!response.ok) {
      throw new Error(await extractResponseErrorMessage(response));
    }
    return response.json();
  },
  // Sites
  getSites: () => request('/api/sites'),
  addSite: (data: any) => request('/api/sites', { method: 'POST', body: JSON.stringify(data) }),
  updateSite: (id: number, data: any) => request(`/api/sites/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSite: (id: number) => request(`/api/sites/${id}`, { method: 'DELETE' }),
  batchUpdateSites: (data: any) => request('/api/sites/batch', { method: 'POST', body: JSON.stringify(data) }),
  refreshSiteHealth: (data?: { wait?: boolean }) => request('/api/sites/health/refresh', {
    method: 'POST',
    body: JSON.stringify(data || {}),
    timeoutMs: data?.wait ? 150_000 : 30_000,
  }),
  cleanupUnreachableSites: (data?: { wait?: boolean; dryRun?: boolean }) => request('/api/sites/cleanup-unreachable', {
    method: 'POST',
    body: JSON.stringify(data || {}),
    timeoutMs: data?.wait ? 150_000 : 30_000,
  }),
  detectSite: (url: string) => request('/api/sites/detect', { method: 'POST', body: JSON.stringify({ url }) }),
  probeSiteProtocol: (siteId: number, data?: { modelName?: string }) =>
    request(`/api/sites/${siteId}/protocol-probe`, { method: 'POST', body: JSON.stringify(data || {}) }),
  getSiteDisabledModels: (siteId: number) => request(`/api/sites/${siteId}/disabled-models`),
  updateSiteDisabledModels: (siteId: number, models: string[]) => request(`/api/sites/${siteId}/disabled-models`, { method: 'PUT', body: JSON.stringify({ models }) }),

  // Accounts
  getAccounts: () => request('/api/accounts'),
  addAccount: (data: any) => request('/api/accounts', { method: 'POST', body: JSON.stringify(data) }) as Promise<AddAccountResponse>,
  loginAccount: (data: { siteId: number; username: string; password: string }) => request('/api/accounts/login', { method: 'POST', body: JSON.stringify(data) }),
  verifyToken: (data: { siteId: number; accessToken: string; platformUserId?: number; credentialMode?: 'auto' | 'session' | 'apikey' }) => request('/api/accounts/verify-token', { method: 'POST', body: JSON.stringify(data) }),
  rebindAccountSession: (id: number, data: { accessToken: string; platformUserId?: number; refreshToken?: string; tokenExpiresAt?: number }) =>
    request(`/api/accounts/${id}/rebind-session`, { method: 'POST', body: JSON.stringify(data) }),
  updateAccount: (id: number, data: any) => request(`/api/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAccount: (id: number) => request(`/api/accounts/${id}`, { method: 'DELETE' }),
  batchUpdateAccounts: (data: any) => request('/api/accounts/batch', { method: 'POST', body: JSON.stringify(data) }),
  refreshBalance: (id: number) => request(`/api/accounts/${id}/balance`, { method: 'POST' }),
  getAccountModels: (id: number) => request(`/api/accounts/${id}/models`),
  addAccountAvailableModels: (accountId: number, models: string[]) => request(`/api/accounts/${accountId}/models/manual`, { method: 'POST', body: JSON.stringify({ models }) }),
  refreshAccountHealth: (data?: { accountId?: number; wait?: boolean }) => request('/api/accounts/health/refresh', {
    method: 'POST',
    body: JSON.stringify(data || {}),
    timeoutMs: data?.wait ? 150_000 : 30_000,
  }),
  repairAccountKeys: (data?: { wait?: boolean }) => request('/api/accounts/keys/repair', {
    method: 'POST',
    body: JSON.stringify(data || {}),
    timeoutMs: data?.wait ? 150_000 : 30_000,
  }) as Promise<AccountKeyRepairResponse>,

  // Account tokens
  getAccountTokens: (accountId?: number) => request(`/api/account-tokens${accountId ? `?accountId=${accountId}` : ''}`),
  addAccountToken: (data: any) => request('/api/account-tokens', { method: 'POST', body: JSON.stringify(data) }),
  updateAccountToken: (id: number, data: any) => request(`/api/account-tokens/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAccountToken: (id: number) => request(`/api/account-tokens/${id}`, { method: 'DELETE' }),
  batchUpdateAccountTokens: (data: any) => request('/api/account-tokens/batch', { method: 'POST', body: JSON.stringify(data) }),
  getAccountTokenGroups: (accountId: number) => request(`/api/account-tokens/groups/${accountId}`),
  setDefaultAccountToken: (id: number) => request(`/api/account-tokens/${id}/default`, { method: 'POST' }),
  getAccountTokenValue: (id: number) => request(`/api/account-tokens/${id}/value`),
  syncAccountTokens: (accountId: number) => request(`/api/account-tokens/sync/${accountId}`, { method: 'POST', timeoutMs: 45_000 }),
  syncAllAccountTokens: (wait = false) => request('/api/account-tokens/sync-all', {
    method: 'POST',
    body: JSON.stringify(wait ? { wait: true } : {}),
    timeoutMs: wait ? 150_000 : 30_000,
  }),

  // Check-in
  triggerCheckinAll: () => request('/api/checkin/trigger', { method: 'POST', body: JSON.stringify({}) }),
  triggerCheckin: (id: number) => request(`/api/checkin/trigger/${id}`, { method: 'POST', body: JSON.stringify({}) }),
  getCheckinLogs: (params?: string) => request(`/api/checkin/logs${params ? '?' + params : ''}`),
  updateCheckinSchedule: (cron: string) => request('/api/checkin/schedule', { method: 'PUT', body: JSON.stringify({ cron }) }),

  // Routes
  getRoutes: () => request('/api/routes'),
  getRoutesLite: () => request('/api/routes/lite'),
  getRoutesSummary: () => request('/api/routes/summary') as Promise<RouteSummaryRow[]>,
  getRouteOverview: () => request('/api/routes/overview') as Promise<RouteOverviewResponse>,
  getRouteGovernanceSubjects: (params?: { subjectType?: string; state?: string; reasonCode?: string; limit?: number }) =>
    request(`/api/routes/governance/subjects${buildQueryString(params)}`) as Promise<RouteGovernanceSubjectsResponse>,
  runRouteGovernanceRecoveryPass: (data?: { limit?: number }) =>
    request('/api/routes/governance/recovery-pass', { method: 'POST', body: JSON.stringify(data || {}) }) as Promise<RouteGovernanceRecoveryPassResponse>,
  getRouteChannels: (routeId: number) => request(`/api/routes/${routeId}/channels`),
  probeRouteChannels: (routeId: number, data?: { limit?: number; autoGovernance?: boolean }) =>
    request(`/api/routes/${routeId}/probe`, {
      method: 'POST',
      body: JSON.stringify(data || {}),
      timeoutMs: 360_000,
    }) as Promise<RouteProbeResponse>,
  probeBatchRoutes: (data: { routeIds?: number[]; allExactModelRoutes?: boolean; limit?: number; autoGovernance?: boolean; earlyStopOnAvailable?: boolean }) =>
    request('/api/routes/probe-batch', {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs: 120_000,
    }) as Promise<{ success: boolean; results: RouteProbeResponse[]; totalProbed: number }>,
  batchAddChannels: (routeId: number, channels: Array<{ accountId: number; tokenId?: number; sourceModel?: string }>) =>
    request(`/api/routes/${routeId}/channels/batch`, { method: 'POST', body: JSON.stringify({ channels }) }),
  addRoute: (data: any) => request('/api/routes', { method: 'POST', body: JSON.stringify(data) }),
  updateRoute: (id: number, data: any) => request(`/api/routes/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteRoute: (id: number) => request(`/api/routes/${id}`, { method: 'DELETE' }),
  addChannel: (routeId: number, data: any) => request(`/api/routes/${routeId}/channels`, { method: 'POST', body: JSON.stringify(data) }),
  updateChannel: (id: number, data: any) => request(`/api/channels/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  batchUpdateChannels: (updates: Array<{ id: number; priority: number }>) =>
    request('/api/channels/batch', { method: 'PUT', body: JSON.stringify({ updates }) }),
  deleteChannel: (id: number) => request(`/api/channels/${id}`, { method: 'DELETE' }),
  rebuildRoutes: (refreshModels = true, wait = false) => request('/api/routes/rebuild', {
    method: 'POST',
    body: JSON.stringify({ refreshModels, ...(wait ? { wait: true } : {}) }),
    timeoutMs: wait ? 150_000 : 30_000,
  }),
  getRouteDecision: (model: string) => request(`/api/routes/decision?model=${encodeURIComponent(model)}`) as Promise<{ success: true; decision: RouteDecision }>,
  getRouteDecisionsBatch: (models: string[], options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean }) => request('/api/routes/decision/batch', {
    method: 'POST',
    body: JSON.stringify({
      models,
      ...(options?.refreshPricingCatalog ? { refreshPricingCatalog: true } : {}),
      ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
    }),
  }),
  getRouteDecisionsByRouteBatch: (items: Array<{ routeId: number; model: string }>, options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean }) => request('/api/routes/decision/by-route/batch', {
    method: 'POST',
    body: JSON.stringify({
      items,
      ...(options?.refreshPricingCatalog ? { refreshPricingCatalog: true } : {}),
      ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
    }),
  }),
  getRouteWideDecisionsBatch: (routeIds: number[], options?: { refreshPricingCatalog?: boolean; persistSnapshots?: boolean }) => request('/api/routes/decision/route-wide/batch', {
    method: 'POST',
    body: JSON.stringify({
      routeIds,
      ...(options?.refreshPricingCatalog ? { refreshPricingCatalog: true } : {}),
      ...(options?.persistSnapshots ? { persistSnapshots: true } : {}),
    }),
  }),
  getRouteDiagnostics: (limit?: number) =>
    request(`/api/routes/diagnostics${buildQueryString({ limit: typeof limit === 'number' ? Math.trunc(limit) : undefined })}`) as Promise<RouteDiagnosticsResponse>,
  getOptimizationOverview: () => request('/api/optimization/overview') as Promise<OperationalOptimizationOverview>,
  getOptimizationDiagnosticsText: () => request('/api/optimization/diagnostics-text') as Promise<{ success: true; text: string }>,
  syncOptimizationProfiles: () => request('/api/optimization/sync', { method: 'POST' }) as Promise<{ success: true; queued: boolean; reused: boolean; jobId: string; status: string }>,
  runOptimizationRecoveryPass: (data?: { limit?: number; includeProbing?: boolean }) =>
    request('/api/optimization/recovery-pass', { method: 'POST', body: JSON.stringify(data || {}) }) as Promise<RouteGovernanceRecoveryPassResponse>,
  updateOptimizationPolicies: (data: {
    responseCache?: Partial<OperationalOptimizationOverview['policies']['responseCache']>;
    retryBudget?: Partial<OperationalOptimizationOverview['policies']['retryBudget']>;
  }) => request('/api/optimization/policies', { method: 'PUT', body: JSON.stringify(data) }) as Promise<{ success: true; policies: OperationalOptimizationOverview['policies'] }>,

  // Stats
  getDashboard: () => request('/api/stats/dashboard'),
  getRuntimeOverview: () => request('/api/system/runtime-overview') as Promise<RuntimeOverview>,
  getProxyLogs: (params?: ProxyLogsQuery) => request(`/api/stats/proxy-logs${buildQueryString(params)}`) as Promise<ProxyLogsResponse>,
  getProxyLogDetail: (id: number) => request(`/api/stats/proxy-logs/${id}`) as Promise<ProxyLogDetail>,
  getProxyDebugTraces: (params?: { traceId?: string; sessionId?: string; traceHint?: string; kind?: string; siteId?: number | null; limit?: number }) =>
    request(`/api/stats/proxy-debug-traces${buildQueryString(params)}`) as Promise<ProxyDebugTracesResponse>,
  checkModels: (accountId: number) => request(`/api/models/check/${accountId}`, { method: 'POST' }),
  getSiteDistribution: () => request('/api/stats/site-distribution'),
  getSiteTrend: (days = 7) => request(`/api/stats/site-trend?days=${days}`),
  getModelBySite: (siteId?: number, days = 7) =>
    request(`/api/stats/model-by-site?${siteId ? `siteId=${siteId}&` : ''}days=${days}`),

  // Search
  search: (query: string) => request('/api/search', { method: 'POST', body: JSON.stringify({ query, limit: 20 }) }),

  // OAuth
  getOAuthProviders: () => request('/api/oauth/providers') as Promise<{ providers: OAuthProviderInfo[] }>,
  startOAuthProvider: (provider: string, data?: { accountId?: number; projectId?: string }) => request(`/api/oauth/providers/${encodeURIComponent(provider)}/start`, {
    method: 'POST',
    body: JSON.stringify(data || {}),
  }) as Promise<OAuthStartResponse>,
  getOAuthSession: (state: string) => request(`/api/oauth/sessions/${encodeURIComponent(state)}`) as Promise<OAuthSessionInfo>,
  submitOAuthManualCallback: (state: string, callbackUrl: string) => request(`/api/oauth/sessions/${encodeURIComponent(state)}/manual-callback`, {
    method: 'POST',
    body: JSON.stringify({ callbackUrl }),
  }) as Promise<{ success: true }>,
  getOAuthConnections: (params?: { limit?: number; offset?: number }) =>
    request(`/api/oauth/connections${buildQueryString(params)}`) as Promise<OAuthConnectionsResponse>,
  refreshOAuthConnectionQuota: (accountId: number) => request(`/api/oauth/connections/${accountId}/quota/refresh`, {
    method: 'POST',
    body: JSON.stringify({}),
  }) as Promise<{ success: true; quota: OAuthQuotaInfo }>,
  rebindOAuthConnection: (accountId: number) => request(`/api/oauth/connections/${accountId}/rebind`, {
    method: 'POST',
    body: JSON.stringify({}),
  }) as Promise<OAuthStartResponse>,
  deleteOAuthConnection: (accountId: number) => request(`/api/oauth/connections/${accountId}`, {
    method: 'DELETE',
  }) as Promise<{ success: true }>,

  // Events
  getEvents: (params?: string) => request(`/api/events${params ? '?' + params : ''}`),
  getEventCount: () => request('/api/events/count'),
  markEventRead: (id: number) => request(`/api/events/${id}/read`, { method: 'POST' }),
  markAllEventsRead: () => request('/api/events/read-all', { method: 'POST' }),
  clearEvents: () => request('/api/events', { method: 'DELETE' }),
  getSiteAnnouncements: (params?: string) => request(`/api/site-announcements${params ? '?' + params : ''}`),
  markSiteAnnouncementRead: (id: number) => request(`/api/site-announcements/${id}/read`, { method: 'POST' }),
  markAllSiteAnnouncementsRead: () => request('/api/site-announcements/read-all', { method: 'POST' }),
  clearSiteAnnouncements: () => request('/api/site-announcements', { method: 'DELETE' }),
  syncSiteAnnouncements: (payload?: { siteId?: number }) => request('/api/site-announcements/sync', {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  }),
  getTasks: (limit = 50) => request(`/api/tasks?limit=${Math.max(1, Math.min(200, Math.trunc(limit)))}`),
  getTask: (id: string) => request(`/api/tasks/${encodeURIComponent(id)}`),

  // Auth management
  getAuthInfo: () => request('/api/settings/auth/info'),
  changeAuthToken: (oldToken: string, newToken: string) => request('/api/settings/auth/change', {
    method: 'POST', body: JSON.stringify({ oldToken, newToken }),
  }),
  getRuntimeSettings: () => request('/api/settings/runtime'),
  updateRuntimeSettings: (data: any) => request('/api/settings/runtime', {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  testSystemProxy: (data: SystemProxyTestRequest) => request('/api/settings/system-proxy/test', {
    method: 'POST',
    body: JSON.stringify(data),
    timeoutMs: 20_000,
  }),
  getRuntimeDatabaseConfig: () => request('/api/settings/database/runtime'),
  updateRuntimeDatabaseConfig: (data: { dialect: 'sqlite' | 'mysql' | 'postgres'; connectionString: string; ssl?: boolean }) =>
    request('/api/settings/database/runtime', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  testExternalDatabaseConnection: (data: { dialect: 'sqlite' | 'mysql' | 'postgres'; connectionString: string; ssl?: boolean }) =>
    request('/api/settings/database/test-connection', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getCredentialDiagnostic: (params: { targetType: 'site' | 'account' | 'token'; targetId: number }) =>
    request(`/api/diagnostics/credential${buildQueryString(params)}`) as Promise<CredentialDiagnosticResponse>,
  benchmarkCredentialModels: (data: { targetType: 'site' | 'account' | 'token'; targetId: number; modelNames?: string[]; rounds?: 1 | 3 }) =>
    request('/api/diagnostics/credential/benchmark', {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs: 120_000,
    }) as Promise<CredentialBenchmarkResponse>,
  migrateExternalDatabase: (data: { dialect: 'sqlite' | 'mysql' | 'postgres'; connectionString: string; overwrite?: boolean; ssl?: boolean }) =>
    request('/api/settings/database/migrate', {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs: 120_000,
    }),
  getDownstreamApiKeys: () => request('/api/downstream-keys'),
  createDownstreamApiKey: (data: any) => request('/api/downstream-keys', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  updateDownstreamApiKey: (id: number, data: any) => request(`/api/downstream-keys/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  deleteDownstreamApiKey: (id: number) => request(`/api/downstream-keys/${id}`, {
    method: 'DELETE',
  }),
  batchDownstreamApiKeys: (data: {
    ids: number[];
    action: 'enable' | 'disable' | 'delete' | 'resetUsage' | 'updateMetadata';
    groupOperation?: 'keep' | 'set' | 'clear';
    groupName?: string;
    tagOperation?: 'keep' | 'append';
    tags?: string[];
  }) =>
    request('/api/downstream-keys/batch', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  resetDownstreamApiKeyUsage: (id: number) => request(`/api/downstream-keys/${id}/reset-usage`, {
    method: 'POST',
  }),
  getDownstreamApiKeysSummary: (params?: { range?: '24h' | '7d' | 'all'; status?: 'all' | 'enabled' | 'disabled'; search?: string }) =>
    request(`/api/downstream-keys/summary${buildQueryString(params)}`),
  getDownstreamApiKeyOverview: (id: number) => request(`/api/downstream-keys/${id}/overview`),
  getDownstreamApiKeyTrend: (id: number, params?: { range?: '24h' | '7d' | 'all' }) =>
    request(`/api/downstream-keys/${id}/trend${buildQueryString(params)}`),
  exportBackup: (type: 'all' | 'accounts' | 'preferences' = 'all') =>
    request(`/api/settings/backup/export?type=${encodeURIComponent(type)}`),
  importBackup: (data: any) =>
    request('/api/settings/backup/import', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),
  getBackupWebdavConfig: () => request('/api/settings/backup/webdav'),
  saveBackupWebdavConfig: (data: {
    enabled: boolean;
    fileUrl: string;
    username: string;
    password?: string;
    clearPassword?: boolean;
    exportType: 'all' | 'accounts' | 'preferences';
    autoSyncEnabled: boolean;
    autoSyncCron: string;
  }) =>
    request('/api/settings/backup/webdav', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  exportBackupToWebdav: (type?: 'all' | 'accounts' | 'preferences') =>
    request('/api/settings/backup/webdav/export', {
      method: 'POST',
      body: JSON.stringify(type ? { type } : {}),
      timeoutMs: 60_000,
    }),
  importBackupFromWebdav: () =>
    request('/api/settings/backup/webdav/import', {
      method: 'POST',
      body: JSON.stringify({}),
      timeoutMs: 60_000,
    }),
  clearRuntimeCache: () => request('/api/settings/maintenance/clear-cache', { method: 'POST' }),
  clearUsageData: () => request('/api/settings/maintenance/clear-usage', { method: 'POST' }),
  resetRoutingRuntimeState: () => request('/api/settings/maintenance/reset-routing-runtime', { method: 'POST' }),
  factoryReset: () => request('/api/settings/maintenance/factory-reset', { method: 'POST' }),
  testNotification: () => request('/api/settings/notify/test', { method: 'POST' }),

  // Monitor embed
  getMonitorConfig: () => request('/api/monitor/config'),
  updateMonitorConfig: (data: { ldohCookie?: string | null }) => request('/api/monitor/config', {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  initMonitorSession: () => request('/api/monitor/session', { method: 'POST' }),

  // Models marketplace
  getModelsMarketplace: (options?: { refresh?: boolean; includePricing?: boolean }) => {
    const params = new URLSearchParams();
    if (options?.refresh) params.set('refresh', '1');
    if (options?.includePricing) params.set('includePricing', '1');
    const query = params.toString();
    const timeoutMs = options?.includePricing ? 150_000 : (options?.refresh ? 45_000 : 15_000);
    return request(`/api/models/marketplace${query ? `?${query}` : ''}`, { timeoutMs });
  },
  testMarketplaceModelAvailability: (data: { modelName: string; accountId?: number; siteName?: string; routeId?: number; channelId?: number }) =>
    request('/api/models/marketplace/test', {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs: 300_000,
    }),
  getModelTokenCandidates: () => request('/api/models/token-candidates'),

  // Simple chat test from admin panel
  startTestChatJob: (data: TestChatRequestPayload) =>
    request('/api/test/chat/jobs', { method: 'POST', body: JSON.stringify(data) }),
  getTestChatJob: (jobId: string) => request(`/api/test/chat/jobs/${encodeURIComponent(jobId)}`),
  deleteTestChatJob: (jobId: string) => request(`/api/test/chat/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),
  startProxyTestJob: (data: ProxyTestRequestEnvelope) =>
    request('/api/test/proxy/jobs', {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs: resolveProxyTestTimeoutMs(data),
    }),
  getProxyTestJob: (jobId: string) => request(`/api/test/proxy/jobs/${encodeURIComponent(jobId)}`),
  deleteProxyTestJob: (jobId: string) => request(`/api/test/proxy/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),
  getProxyFileContentDataUrl: async (
    fileId: string,
    options: Pick<RequestOptions, 'signal' | 'timeoutMs'> = {},
  ) => {
    const response = await fetchAuthenticatedResponse(`/api/test/proxy/files/${encodeURIComponent(fileId)}/content`, {
      method: 'GET',
      ...options,
    });
    if (!response.ok) {
      throw new Error(await extractResponseErrorMessage(response));
    }

    const mimeType = (response.headers.get('content-type') || 'application/octet-stream')
      .split(';')[0]
      .trim() || 'application/octet-stream';
    const filename = parseContentDispositionFilename(response.headers.get('content-disposition'));
    const base64 = arrayBufferToBase64(await response.arrayBuffer());
    return {
      filename,
      mimeType,
      data: `data:${mimeType};base64,${base64}`,
    };
  },
  testProxy: (data: ProxyTestRequestEnvelope) =>
    request('/api/test/proxy', {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs: resolveProxyTestTimeoutMs(data),
    }),
  proxyTest: (data: ProxyTestRequestEnvelope) =>
    request('/api/test/proxy', {
      method: 'POST',
      body: JSON.stringify(data),
      timeoutMs: resolveProxyTestTimeoutMs(data),
    }),
  testChat: (data: TestChatRequestPayload) =>
    request('/api/test/chat', { method: 'POST', body: JSON.stringify(data) }),
  testProxyStream: async (data: ProxyTestRequestEnvelope, signal?: AbortSignal) => {
    return fetchAuthenticatedResponse('/api/test/proxy/stream', {
      method: 'POST',
      signal,
      body: JSON.stringify(data),
      timeoutMs: null,
    });
  },
  proxyTestStream: async (data: ProxyTestRequestEnvelope, signal?: AbortSignal) => {
    return fetchAuthenticatedResponse('/api/test/proxy/stream', {
      method: 'POST',
      signal,
      body: JSON.stringify(data),
      timeoutMs: null,
    });
  },
  testChatStream: async (data: TestChatRequestPayload, signal?: AbortSignal) => {
    return fetchAuthenticatedResponse('/api/test/chat/stream', {
      method: 'POST',
      signal,
      body: JSON.stringify(data),
      timeoutMs: null,
    });
  },
};
