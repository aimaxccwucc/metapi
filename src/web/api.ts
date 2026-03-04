import { clearAuthSession, getAuthToken } from './authSession.js';

type RequestOptions = RequestInit & {
  timeoutMs?: number;
};

async function request(url: string, options: RequestOptions = {}) {
  const { timeoutMs = 30_000, signal: externalSignal, ...fetchOptions } = options;
  const controller = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  let cleanupExternalSignal = () => {};

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      const abortHandler = () => controller.abort();
      externalSignal.addEventListener('abort', abortHandler, { once: true });
      cleanupExternalSignal = () => externalSignal.removeEventListener('abort', abortHandler);
    }
  }

  const token = getAuthToken(localStorage);
  if (!token) {
    clearAuthSession(localStorage);
    throw new Error('Session expired');
  }
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${token}`,
  };
  if (fetchOptions.body) headers['Content-Type'] = 'application/json';

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal,
      headers: {
        ...headers,
        ...fetchOptions.headers as Record<string, string>,
      },
    });
    if (res.status === 401 || res.status === 403) {
      const hadToken = !!getAuthToken(localStorage);
      clearAuthSession(localStorage);
      if (hadToken) window.location.reload();
      throw new Error('Session expired');
    }
    if (!res.ok) {
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
            } else {
              message = `${message}: ${text.slice(0, 120)}`;
            }
          } catch {
            message = `${message}: ${text.slice(0, 120)}`;
          }
        }
      } catch {}
      throw new Error(message);
    }
    return res.json();
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      if (externalSignal?.aborted) throw error;
      throw new Error(`请求超时（${Math.max(1, Math.round(timeoutMs / 1000))}s）`);
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

type TestChatRequestPayload = {
  model: string;
  messages: Array<{ role: string; content: string }>;
  targetFormat?: 'openai' | 'claude' | 'responses';
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  seed?: number;
};

export const api = {
  // Sites
  getSites: () => request('/api/sites'),
  addSite: (data: any) => request('/api/sites', { method: 'POST', body: JSON.stringify(data) }),
  updateSite: (id: number, data: any) => request(`/api/sites/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteSite: (id: number) => request(`/api/sites/${id}`, { method: 'DELETE' }),
  detectSite: (url: string) => request('/api/sites/detect', { method: 'POST', body: JSON.stringify({ url }) }),

  // Accounts
  getAccounts: () => request('/api/accounts'),
  addAccount: (data: any) => request('/api/accounts', {
    method: 'POST',
    body: JSON.stringify(data),
    timeoutMs: 120_000,
  }),
  loginAccount: (data: { siteId: number; username: string; password: string }) => request('/api/accounts/login', { method: 'POST', body: JSON.stringify(data) }),
  verifyToken: (data: { siteId: number; accessToken: string; platformUserId?: number; credentialMode?: 'auto' | 'session' | 'apikey' }) => request('/api/accounts/verify-token', {
    method: 'POST',
    body: JSON.stringify(data),
    timeoutMs: 90_000,
  }),
  rebindAccountSession: (id: number, data: { accessToken: string; platformUserId?: number }) =>
    request(`/api/accounts/${id}/rebind-session`, { method: 'POST', body: JSON.stringify(data) }),
  updateAccount: (id: number, data: any) => request(`/api/accounts/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAccount: (id: number) => request(`/api/accounts/${id}`, { method: 'DELETE' }),
  refreshBalance: (id: number) => request(`/api/accounts/${id}/balance`, { method: 'POST' }),
  refreshAccountHealth: (data?: { accountId?: number; wait?: boolean }) => request('/api/accounts/health/refresh', {
    method: 'POST',
    body: JSON.stringify(data || {}),
    timeoutMs: data?.wait ? 150_000 : 30_000,
  }),

  // Account tokens
  getAccountTokens: (accountId?: number) => request(`/api/account-tokens${accountId ? `?accountId=${accountId}` : ''}`),
  addAccountToken: (data: any) => request('/api/account-tokens', { method: 'POST', body: JSON.stringify(data) }),
  updateAccountToken: (id: number, data: any) => request(`/api/account-tokens/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteAccountToken: (id: number) => request(`/api/account-tokens/${id}`, { method: 'DELETE' }),
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
  triggerCheckinAll: () => request('/api/checkin/trigger', { method: 'POST' }),
  triggerCheckin: (id: number) => request(`/api/checkin/trigger/${id}`, { method: 'POST' }),
  getCheckinLogs: (params?: string) => request(`/api/checkin/logs${params ? '?' + params : ''}`),
  updateCheckinSchedule: (cron: string) => request('/api/checkin/schedule', { method: 'PUT', body: JSON.stringify({ cron }) }),

  // Routes
  getRoutes: () => request('/api/routes'),
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
  getRouteDecision: (model: string) => request(`/api/routes/decision?model=${encodeURIComponent(model)}`),
  getRouteDecisionsBatch: (models: string[]) => request('/api/routes/decision/batch', {
    method: 'POST',
    body: JSON.stringify({ models }),
  }),
  getRouteDecisionsByRouteBatch: (items: Array<{ routeId: number; model: string }>) => request('/api/routes/decision/by-route/batch', {
    method: 'POST',
    body: JSON.stringify({ items }),
  }),
  getRouteWideDecisionsBatch: (routeIds: number[]) => request('/api/routes/decision/route-wide/batch', {
    method: 'POST',
    body: JSON.stringify({ routeIds }),
  }),

  // Stats
  getDashboard: () => request('/api/stats/dashboard'),
  getProxyLogs: (params?: string) => request(`/api/stats/proxy-logs${params ? '?' + params : ''}`),
  checkModels: (accountId: number) => request(`/api/models/check/${accountId}`, { method: 'POST' }),
  getSiteDistribution: () => request('/api/stats/site-distribution'),
  getSiteTrend: (days = 7) => request(`/api/stats/site-trend?days=${days}`),
  getModelBySite: (siteId?: number, days = 7) =>
    request(`/api/stats/model-by-site?${siteId ? `siteId=${siteId}&` : ''}days=${days}`),

  // Search
  search: (query: string) => request('/api/search', { method: 'POST', body: JSON.stringify({ query, limit: 20 }) }),

  // Events
  getEvents: (params?: string) => request(`/api/events${params ? '?' + params : ''}`),
  getEventCount: () => request('/api/events/count'),
  markEventRead: (id: number) => request(`/api/events/${id}/read`, { method: 'POST' }),
  markAllEventsRead: () => request('/api/events/read-all', { method: 'POST' }),
  clearEvents: () => request('/api/events', { method: 'DELETE' }),
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
  resetDownstreamApiKeyUsage: (id: number) => request(`/api/downstream-keys/${id}/reset-usage`, {
    method: 'POST',
  }),
  exportBackup: (type: 'all' | 'accounts' | 'preferences' = 'all') =>
    request(`/api/settings/backup/export?type=${encodeURIComponent(type)}`),
  importBackup: (data: any) =>
    request('/api/settings/backup/import', {
      method: 'POST',
      body: JSON.stringify({ data }),
    }),
  clearRuntimeCache: () => request('/api/settings/maintenance/clear-cache', { method: 'POST' }),
  clearUsageData: () => request('/api/settings/maintenance/clear-usage', { method: 'POST' }),
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
    return request(`/api/models/marketplace${query ? `?${query}` : ''}`, { timeoutMs: options?.refresh ? 45_000 : 15_000 });
  },
  getModelTokenCandidates: () => request('/api/models/token-candidates'),

  // Simple chat test from admin panel
  startTestChatJob: (data: TestChatRequestPayload) =>
    request('/api/test/chat/jobs', { method: 'POST', body: JSON.stringify(data) }),
  getTestChatJob: (jobId: string) => request(`/api/test/chat/jobs/${encodeURIComponent(jobId)}`),
  deleteTestChatJob: (jobId: string) => request(`/api/test/chat/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),
  testChat: (data: TestChatRequestPayload) =>
    request('/api/test/chat', { method: 'POST', body: JSON.stringify(data) }),
  testChatStream: async (data: TestChatRequestPayload, signal?: AbortSignal) => {
    const token = getAuthToken(localStorage);
    if (!token) {
      clearAuthSession(localStorage);
      throw new Error('Session expired');
    }
    return fetch('/api/test/chat/stream', {
      method: 'POST',
      signal,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
  },
};
