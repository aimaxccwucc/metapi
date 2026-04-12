import React, { startTransition, useDeferredValue, useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  api,
  type ProxyDebugTraceItem,
  type ProxyDebugTraceSummary,
  type ProxyLogBillingDetails,
  type ProxyLogClientOption,
  type ProxyLogDetail,
  type ProxyLogListItem,
  type ProxyLogsSummary,
  type ProxyLogStatusFilter,
} from '../api.js';
import { useToast } from '../components/Toast.js';
import { ModelBadge } from '../components/BrandIcon.js';
import SiteBadgeLink from '../components/SiteBadgeLink.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import MobileFilterSheet from '../components/MobileFilterSheet.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { formatDateTimeLocal } from './helpers/checkinLogTime.js';
import ModernSelect from '../components/ModernSelect.js';
import { parseProxyLogPathMeta } from './helpers/proxyLogPathMeta.js';
import { tr } from '../i18n.js';

type ProxyLogRenderItem = ProxyLogListItem & {
  billingDetails?: ProxyLogBillingDetails;
  username?: string | null;
  siteName?: string | null;
  siteUrl?: string | null;
  errorMessage?: string | null;
};

type ProxyLogDetailState = {
  loading: boolean;
  data?: ProxyLogDetail;
  error?: string;
};

type ProxyLogSiteOption = {
  id: number;
  name: string;
  status: string | null;
};

const PAGE_SIZES = [20, 50, 100];
const DEFAULT_PAGE_SIZE = 50;
const PROXY_LOG_CLIENT_FAMILY_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude_code: 'Claude Code',
  gemini_cli: 'Gemini CLI',
  generic: '通用',
};
const PROXY_TRACE_KIND_OPTIONS = [
  { value: '', label: '全部事件' },
  { value: 'route_selected', label: '选路命中' },
  { value: 'proxy_retry', label: '代理重试' },
  { value: 'proxy_success', label: '代理成功' },
  { value: 'proxy_exception', label: '代理异常' },
];
const EMPTY_SUMMARY: ProxyLogsSummary = {
  totalCount: 0,
  successCount: 0,
  failedCount: 0,
  totalCost: 0,
  totalTokensAll: 0,
  cacheHitCount: 0,
  cacheMissCount: 0,
  cacheStaleCount: 0,
  cacheSavedCost: 0,
};
const EMPTY_PROXY_TRACE_SUMMARY: ProxyDebugTraceSummary = {
  total: 0,
  kinds: {},
  sites: [],
};

function normalizeProxyLogsSummary(summary?: Partial<ProxyLogsSummary> | null): ProxyLogsSummary {
  return {
    totalCount: Number(summary?.totalCount || 0),
    successCount: Number(summary?.successCount || 0),
    failedCount: Number(summary?.failedCount || 0),
    totalCost: Number(summary?.totalCost || 0),
    totalTokensAll: Number(summary?.totalTokensAll || 0),
    cacheHitCount: Number(summary?.cacheHitCount || 0),
    cacheMissCount: Number(summary?.cacheMissCount || 0),
    cacheStaleCount: Number(summary?.cacheStaleCount || 0),
    cacheSavedCost: Number(summary?.cacheSavedCost || 0),
  };
}

function renderCacheBadge(status?: string | null) {
  const normalized = String(status || '').trim().toLowerCase();
  if (!normalized) return null;
  const label = normalized === 'hit' ? 'HIT' : normalized === 'stale' ? 'STALE' : normalized === 'miss' ? 'MISS' : normalized.toUpperCase();
  const className = normalized === 'hit'
    ? 'badge badge-success'
    : normalized === 'stale'
      ? 'badge badge-warning'
      : 'badge';
  return <span className={className} style={{ fontSize: 10 }}>{label}</span>;
}

function resolveProxyLogSiteLabel(log: ProxyLogRenderItem): string | null {
  const siteName = String(log.siteName || '').trim();
  if (siteName) return siteName;
  const cacheStatus = String(log.cacheStatus || '').trim().toLowerCase();
  if (cacheStatus === 'hit') return '缓存命中';
  if (cacheStatus === 'stale') return '旧缓存兜底';
  return null;
}

function isNonGenerationSuccess(log: ProxyLogRenderItem) {
  if (log.status !== 'success') return false;
  if ((log.promptTokens || 0) > 0 || (log.completionTokens || 0) > 0 || (log.totalTokens || 0) > 0) return false;
  const message = String(log.errorMessage || '').toLowerCase();
  return message.includes('count_tokens') || message.includes('cache') || message.includes('/messages/count_tokens');
}

function formatLatency(ms: number) {
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(ms >= 10000 ? 0 : 1)}s`;
  }
  return `${ms}ms`;
}

function latencyColor(ms: number) {
  if (ms >= 3000) return 'var(--color-danger)';
  if (ms >= 2000) return 'color-mix(in srgb, var(--color-warning) 30%, var(--color-danger))';
  if (ms >= 1500) return 'color-mix(in srgb, var(--color-warning) 60%, var(--color-danger))';
  if (ms >= 1000) return 'var(--color-warning)';
  if (ms > 500) return 'color-mix(in srgb, var(--color-success) 60%, var(--color-warning))';
  return 'var(--color-success)';
}

function latencyBgColor(ms: number) {
  if (ms >= 3000) return 'color-mix(in srgb, var(--color-danger) 12%, transparent)';
  if (ms >= 1000) return 'color-mix(in srgb, var(--color-warning) 12%, transparent)';
  return 'color-mix(in srgb, var(--color-success) 12%, transparent)';
}

function formatCompactNumber(value: number, digits = 6) {
  if (!Number.isFinite(value)) return '0';
  const formatted = value.toFixed(digits).replace(/\.?0+$/, '');
  return formatted || '0';
}

function formatPerMillionPrice(value: number) {
  return `$${formatCompactNumber(value)} / 1M tokens`;
}

function formatBillingDetailSummary(log: ProxyLogRenderItem) {
  const detail = log.billingDetails;
  if (!detail) return null;
  return `模型倍率 ${formatCompactNumber(detail.pricing.modelRatio)}，输出倍率 ${formatCompactNumber(detail.pricing.completionRatio)}，缓存倍率 ${formatCompactNumber(detail.pricing.cacheRatio)}，缓存创建倍率 ${formatCompactNumber(detail.pricing.cacheCreationRatio)}，分组倍率 ${formatCompactNumber(detail.pricing.groupRatio)}`;
}

function renderDownstreamKeySummary(log: ProxyLogRenderItem) {
  const parts = [
    log.downstreamKeyName ? `下游 Key: ${log.downstreamKeyName}` : null,
    log.downstreamKeyGroupName ? `主分组: ${log.downstreamKeyGroupName}` : null,
    Array.isArray(log.downstreamKeyTags) && log.downstreamKeyTags.length > 0 ? `标签: ${log.downstreamKeyTags.join(' / ')}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join('，') : null;
}

function buildBillingProcessLines(log: ProxyLogRenderItem) {
  const detail = log.billingDetails;
  if (!detail) return [];

  const lines = [
    `提示价格：${formatPerMillionPrice(detail.breakdown.inputPerMillion)}`,
    `补全价格：${formatPerMillionPrice(detail.breakdown.outputPerMillion)}`,
  ];

  if (detail.usage.cacheReadTokens > 0) {
    lines.push(`缓存价格：${formatPerMillionPrice(detail.breakdown.cacheReadPerMillion)} (缓存倍率: ${formatCompactNumber(detail.pricing.cacheRatio)})`);
  }

  if (detail.usage.cacheCreationTokens > 0) {
    lines.push(`缓存创建价格：${formatPerMillionPrice(detail.breakdown.cacheCreationPerMillion)} (缓存创建倍率: ${formatCompactNumber(detail.pricing.cacheCreationRatio)})`);
  }

  const parts = [
    `提示 ${detail.usage.billablePromptTokens.toLocaleString()} tokens / 1M tokens * $${formatCompactNumber(detail.breakdown.inputPerMillion)}`,
  ];

  if (detail.usage.cacheReadTokens > 0) {
    parts.push(`缓存 ${detail.usage.cacheReadTokens.toLocaleString()} tokens / 1M tokens * $${formatCompactNumber(detail.breakdown.cacheReadPerMillion)}`);
  }

  if (detail.usage.cacheCreationTokens > 0) {
    parts.push(`缓存创建 ${detail.usage.cacheCreationTokens.toLocaleString()} tokens / 1M tokens * $${formatCompactNumber(detail.breakdown.cacheCreationPerMillion)}`);
  }

  parts.push(`补全 ${detail.usage.completionTokens.toLocaleString()} tokens / 1M tokens * $${formatCompactNumber(detail.breakdown.outputPerMillion)} = $${detail.breakdown.totalCost.toFixed(6)}`);
  lines.push(parts.join(' + '));

  return lines;
}

function padDateTimeSegment(value: number) {
  return String(value).padStart(2, '0');
}

function formatDateTimeInputValue(value: Date) {
  return `${value.getFullYear()}-${padDateTimeSegment(value.getMonth() + 1)}-${padDateTimeSegment(value.getDate())}T${padDateTimeSegment(value.getHours())}:${padDateTimeSegment(value.getMinutes())}`;
}

function normalizeRoutePage(raw: string | null): number {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1;
  return parsed;
}

function normalizeRoutePageSize(raw: string | null): number {
  const parsed = Number.parseInt(raw || '', 10);
  return PAGE_SIZES.includes(parsed) ? parsed : DEFAULT_PAGE_SIZE;
}

function normalizeRouteStatus(raw: string | null): ProxyLogStatusFilter {
  if (raw === 'success' || raw === 'failed') return raw;
  return 'all';
}

function normalizeRouteSearch(raw: string | null): string {
  return (raw || '').trim();
}

function normalizeRouteClient(raw: string | null): string {
  const text = (raw || '').trim();
  if (!text) return '';
  return /^((app|family):)/i.test(text) ? text : '';
}

function normalizeRouteSiteId(raw: string | null): number | null {
  const parsed = Number.parseInt(raw || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function normalizeRouteDateTimeInput(raw: string | null): string {
  const text = (raw || '').trim();
  if (!text) return '';
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return '';
  return formatDateTimeInputValue(parsed);
}

function readProxyLogsRouteState(search: string) {
  const params = new URLSearchParams(search);
  return {
    page: normalizeRoutePage(params.get('page')),
    pageSize: normalizeRoutePageSize(params.get('pageSize')),
    status: normalizeRouteStatus(params.get('status')),
    search: normalizeRouteSearch(params.get('q')),
    client: normalizeRouteClient(params.get('client')),
    siteId: normalizeRouteSiteId(params.get('siteId')),
    from: normalizeRouteDateTimeInput(params.get('from')),
    to: normalizeRouteDateTimeInput(params.get('to')),
  };
}

function buildProxyLogsRouteSearch(input: {
  page: number;
  pageSize: number;
  status: ProxyLogStatusFilter;
  search: string;
  client: string;
  siteId: number | null;
  from: string;
  to: string;
}) {
  const params = new URLSearchParams();
  if (input.page > 1) params.set('page', String(input.page));
  if (input.pageSize !== DEFAULT_PAGE_SIZE) params.set('pageSize', String(input.pageSize));
  if (input.status !== 'all') params.set('status', input.status);
  if (input.search.trim()) params.set('q', input.search.trim());
  if (input.client.trim()) params.set('client', input.client.trim());
  if (input.siteId) params.set('siteId', String(input.siteId));
  if (input.from.trim()) params.set('from', input.from.trim());
  if (input.to.trim()) params.set('to', input.to.trim());
  const next = params.toString();
  return next ? `?${next}` : '';
}

function formatProxyLogClientFamilyLabel(clientFamily?: string | null, options?: { includeGeneric?: boolean }) {
  const normalized = typeof clientFamily === 'string' ? clientFamily.trim().toLowerCase() : '';
  if (!normalized) return null;
  if (!options?.includeGeneric && normalized === 'generic') return null;
  return PROXY_LOG_CLIENT_FAMILY_LABELS[normalized] || clientFamily || null;
}

function resolveProxyLogClientDisplay(
  log: Pick<ProxyLogRenderItem, 'clientFamily' | 'clientAppName' | 'clientConfidence'>,
  options?: { includeGeneric?: boolean },
) {
  const familyLabel = formatProxyLogClientFamilyLabel(log.clientFamily, options);
  const appName = typeof log.clientAppName === 'string' ? log.clientAppName.trim() : '';
  if (appName) {
    return {
      primary: appName,
      secondary: familyLabel,
      heuristic: log.clientConfidence === 'heuristic',
    };
  }
  return {
    primary: familyLabel,
    secondary: null,
    heuristic: false,
  };
}

function renderProxyLogClientCell(
  log: Pick<ProxyLogRenderItem, 'clientFamily' | 'clientAppName' | 'clientConfidence'>,
  options?: { includeGeneric?: boolean },
) {
  const display = resolveProxyLogClientDisplay(log, options);
  if (!display.primary) {
    return <span style={{ color: 'var(--color-text-muted)' }}>-</span>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <span>{display.primary}</span>
        {display.heuristic ? (
          <span
            className="badge"
            style={{
              fontSize: 10,
              color: 'var(--color-text-muted)',
              borderColor: 'var(--color-border)',
            }}
          >
            推测
          </span>
        ) : null}
      </div>
      {display.secondary ? (
        <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{display.secondary}</span>
      ) : null}
    </div>
  );
}

function formatProxyTraceKindLabel(kind: string) {
  const match = PROXY_TRACE_KIND_OPTIONS.find((option) => option.value === kind);
  return match?.label || kind || '未知事件';
}

function formatProxyTraceDetail(detail: Record<string, unknown> | null | undefined) {
  if (!detail || typeof detail !== 'object') return '-';
  try {
    return JSON.stringify(detail, null, 2);
  } catch {
    return '[unserializable detail]';
  }
}

function toApiTimeBoundary(value: string): string | undefined {
  const text = value.trim();
  if (!text) return undefined;
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function formatTraceDateTime(value?: string | null) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

export default function ProxyLogs() {
  const location = useLocation();
  const navigate = useNavigate();
  const initialRouteState = useMemo(() => readProxyLogsRouteState(location.search), [location.search]);
  const [logs, setLogs] = useState<ProxyLogListItem[]>([]);
  const [summary, setSummary] = useState<ProxyLogsSummary>(EMPTY_SUMMARY);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<ProxyLogStatusFilter>(initialRouteState.status);
  const [searchInput, setSearchInput] = useState(initialRouteState.search);
  const deferredSearchInput = useDeferredValue(searchInput.trim());
  const [clientFilter, setClientFilter] = useState(initialRouteState.client);
  const [siteFilter, setSiteFilter] = useState<number | null>(initialRouteState.siteId);
  const [fromInput, setFromInput] = useState(initialRouteState.from);
  const [toInput, setToInput] = useState(initialRouteState.to);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [page, setPage] = useState(initialRouteState.page);
  const [pageSize, setPageSize] = useState(initialRouteState.pageSize);
  const [detailById, setDetailById] = useState<Record<number, ProxyLogDetailState>>({});
  const [showFilters, setShowFilters] = useState(false);
  const [sites, setSites] = useState<Array<{ id: number; name: string; status?: string | null }>>([]);
  const [clientOptions, setClientOptions] = useState<ProxyLogClientOption[]>([]);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [traceFilters, setTraceFilters] = useState({
    sessionId: '',
    traceId: '',
    traceHint: '',
    kind: '',
    siteId: '',
    limit: '50',
  });
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceResult, setTraceResult] = useState<null | {
    total: number;
    summary: ProxyDebugTraceSummary;
    items: ProxyDebugTraceItem[];
  }>(null);
  const isMobile = useIsMobile(768);
  const toast = useToast();
  const loadSeq = useRef(0);
  const fromApiBoundary = toApiTimeBoundary(fromInput);
  const toApiBoundaryValue = toApiTimeBoundary(toInput);
  const hasInvalidTimeRange = Boolean(
    fromApiBoundary
    && toApiBoundaryValue
    && new Date(fromApiBoundary).getTime() >= new Date(toApiBoundaryValue).getTime(),
  );

  useEffect(() => {
    const next = readProxyLogsRouteState(location.search);
    setStatusFilter((current) => (current === next.status ? current : next.status));
    setSearchInput((current) => (current === next.search ? current : next.search));
    setClientFilter((current) => (current === next.client ? current : next.client));
    setSiteFilter((current) => (current === next.siteId ? current : next.siteId));
    setFromInput((current) => (current === next.from ? current : next.from));
    setToInput((current) => (current === next.to ? current : next.to));
    setPage((current) => (current === next.page ? current : next.page));
    setPageSize((current) => (current === next.pageSize ? current : next.pageSize));
  }, [location.search]);

  useEffect(() => {
    const nextSearch = buildProxyLogsRouteSearch({
      page,
      pageSize,
      status: statusFilter,
      search: deferredSearchInput,
      client: clientFilter,
      siteId: siteFilter,
      from: fromInput,
      to: toInput,
    });
    if (nextSearch === location.search) return;
    navigate({ pathname: location.pathname, search: nextSearch }, { replace: true });
  }, [clientFilter, deferredSearchInput, fromInput, location.pathname, location.search, navigate, page, pageSize, siteFilter, statusFilter, toInput]);

  useEffect(() => {
    let cancelled = false;

    const loadSites = async () => {
      try {
        const result = await api.getSites();
        const rows = Array.isArray(result) ? result : (result?.sites || []);
        const normalized: ProxyLogSiteOption[] = rows
          .map((site: any) => ({
            id: Number(site?.id || 0),
            name: String(site?.name || '').trim() || `站点 #${site?.id ?? ''}`,
            status: typeof site?.status === 'string' ? site.status : null,
          }))
          .filter((site: ProxyLogSiteOption) => site.id > 0)
          .sort((left: ProxyLogSiteOption, right: ProxyLogSiteOption) => left.name.localeCompare(right.name, 'zh-CN'));
        if (!cancelled) setSites(normalized);
      } catch (error) {
        console.error('Failed to load sites for proxy log filters:', error);
      }
    };

    void loadSites();

    return () => {
      cancelled = true;
    };
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const safePage = Math.min(page, totalPages);
  const currentOffset = (safePage - 1) * pageSize;
  const displayedStart = total === 0 ? 0 : currentOffset + 1;
  const displayedEnd = total === 0 ? 0 : Math.min(currentOffset + logs.length, total);

  const pageNumbers = useMemo(() => (
    Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
      if (totalPages <= 7) return i + 1;
      if (safePage <= 4) return i + 1;
      if (safePage >= totalPages - 3) return totalPages - 6 + i;
      return safePage - 3 + i;
    })
  ), [safePage, totalPages]);

  const siteOptions = useMemo(() => {
    const options = sites.map((site) => ({
      value: String(site.id),
      label: site.status === 'disabled' ? `${site.name}（已禁用）` : site.name,
      description: [site.status === 'disabled' ? 'disabled' : '', `#${site.id}`].filter(Boolean).join(' · '),
      searchText: [site.name, site.status, String(site.id)].filter(Boolean).join(' '),
    }));
    if (siteFilter && !options.some((option) => option.value === String(siteFilter))) {
      options.unshift({
        value: String(siteFilter),
        label: `站点 #${siteFilter}（已删除）`,
        description: 'deleted',
        searchText: String(siteFilter),
      });
    }
    return [
      { value: '', label: '全部站点', description: '查看所有站点' },
      ...options,
    ];
  }, [siteFilter, sites]);

  const resolvedClientOptions = useMemo(() => {
    const options = [...clientOptions];
    if (clientFilter && !options.some((option) => option.value === clientFilter)) {
      options.unshift({
        value: clientFilter,
        label: clientFilter,
      });
    }
    return [
      { value: '', label: '全部客户端' },
      ...options,
    ];
  }, [clientFilter, clientOptions]);

  const activeSiteLabel = useMemo(() => {
    if (!siteFilter) return '全部站点';
    return siteOptions.find((option) => option.value === String(siteFilter))?.label || `站点 #${siteFilter}`;
  }, [siteFilter, siteOptions]);
  const traceSiteOptions = useMemo(() => ([
    { value: '', label: '全部站点', description: '查看所有站点' },
    ...sites.map((site) => ({
      value: String(site.id),
      label: site.status === 'disabled' ? `${site.name}（已禁用）` : site.name,
      description: [site.status === 'disabled' ? 'disabled' : '', `#${site.id}`].filter(Boolean).join(' · '),
      searchText: [site.name, site.status, String(site.id)].filter(Boolean).join(' '),
    })),
  ]), [sites]);
  const siteIdByName = useMemo(() => {
    const index = new Map<string, number>();
    for (const site of sites) {
      const siteName = String(site?.name || '').trim();
      const siteId = Number(site?.id);
      if (!siteName || !Number.isFinite(siteId) || siteId <= 0 || index.has(siteName)) continue;
      index.set(siteName, Math.trunc(siteId));
    }
    return index;
  }, [sites]);

  const load = useCallback(async (silent = false) => {
    const seq = ++loadSeq.current;
    if (hasInvalidTimeRange) {
      setLogs([]);
      setTotal(0);
      setSummary(EMPTY_SUMMARY);
      if (seq === loadSeq.current) setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      const params = {
        limit: pageSize,
        offset: currentOffset,
        status: statusFilter,
        search: deferredSearchInput,
        ...(clientFilter ? { client: clientFilter } : {}),
        ...(siteFilter ? { siteId: siteFilter } : {}),
        ...(fromApiBoundary ? { from: fromApiBoundary } : {}),
        ...(toApiBoundaryValue ? { to: toApiBoundaryValue } : {}),
      };
      const data = await api.getProxyLogs(params);
      if (seq !== loadSeq.current) return;
      startTransition(() => {
        setLogs(Array.isArray(data.items) ? data.items : []);
        setTotal(Number(data.total || 0));
        setSummary(normalizeProxyLogsSummary(data.summary));
        setClientOptions(Array.isArray(data.clientOptions) ? data.clientOptions : []);
      });
    } catch (e: any) {
      if (seq !== loadSeq.current) return;
      if (!silent) toast.error(e.message || '加载日志失败');
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [clientFilter, currentOffset, deferredSearchInput, fromApiBoundary, hasInvalidTimeRange, pageSize, siteFilter, statusFilter, toApiBoundaryValue, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadProxyDebugTraces = useCallback(async () => {
    setTraceLoading(true);
    try {
      const limit = Number.parseInt(traceFilters.limit || '50', 10);
      const response = await api.getProxyDebugTraces({
        sessionId: traceFilters.sessionId.trim() || undefined,
        traceId: traceFilters.traceId.trim() || undefined,
        traceHint: traceFilters.traceHint.trim() || undefined,
        kind: traceFilters.kind.trim() || undefined,
        siteId: traceFilters.siteId ? Number.parseInt(traceFilters.siteId, 10) : undefined,
        limit: Number.isFinite(limit) && limit > 0 ? limit : 50,
      });
      startTransition(() => {
        setTraceResult({
          total: Number(response?.total || 0),
          summary: response?.summary || EMPTY_PROXY_TRACE_SUMMARY,
          items: Array.isArray(response?.items) ? response.items : [],
        });
      });
    } catch (e: any) {
      toast.error(e?.message || '加载 Proxy Trace 失败');
    } finally {
      setTraceLoading(false);
    }
  }, [toast, traceFilters]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => { void load(true); }, 2000);
    return () => clearInterval(timer);
  }, [autoRefresh, load]);

  useEffect(() => {
    if (page <= totalPages) return;
    setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    setExpanded((current) => (
      current !== null && logs.some((log) => log.id === current)
        ? current
        : null
    ));
  }, [logs]);

  const loadDetail = useCallback(async (id: number) => {
    const existing = detailById[id];
    if (existing?.loading || existing?.data) return;

    setDetailById((current) => ({
      ...current,
      [id]: { loading: true },
    }));

    try {
      const data = await api.getProxyLogDetail(id);
      setDetailById((current) => ({
        ...current,
        [id]: { loading: false, data },
      }));
    } catch (e: any) {
      const message = e?.message || '加载日志详情失败';
      setDetailById((current) => ({
        ...current,
        [id]: { loading: false, error: message },
      }));
      toast.error(message);
    }
  }, [detailById, toast]);

  const handleToggleExpand = useCallback((id: number) => {
    const shouldExpand = expanded !== id;
    setExpanded(shouldExpand ? id : null);
    if (shouldExpand) {
      void loadDetail(id);
    }
  }, [expanded, loadDetail]);

  const filterControls = (
    <>
      <div className="pill-tabs">
        {([
          { key: 'all' as ProxyLogStatusFilter, label: '全部', count: summary.totalCount },
          { key: 'success' as ProxyLogStatusFilter, label: '成功', count: summary.successCount },
          { key: 'failed' as ProxyLogStatusFilter, label: '失败', count: summary.failedCount },
        ]).map((tab) => (
          <button
            key={tab.key}
            className={`pill-tab ${statusFilter === tab.key ? 'active' : ''}`}
            onClick={() => {
              setStatusFilter(tab.key);
              setPage(1);
            }}
          >
            {tab.label} <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>{tab.count}</span>
          </button>
        ))}
      </div>
      <div className="proxy-logs-filter-select">
        <ModernSelect
          size="sm"
          value={clientFilter}
          onChange={(nextValue) => {
            setClientFilter(nextValue);
            setPage(1);
          }}
          options={resolvedClientOptions}
          placeholder="全部客户端"
        />
      </div>
      <div className="proxy-logs-filter-select">
        <ModernSelect
          size="sm"
          value={siteFilter ? String(siteFilter) : ''}
          onChange={(nextValue) => {
            setSiteFilter(nextValue ? Number(nextValue) : null);
            setPage(1);
          }}
          options={siteOptions}
          placeholder="全部站点"
          searchable
          searchPlaceholder="搜索站点"
        />
      </div>
      <label className="proxy-logs-time-field">
        <span>开始</span>
        <input
          type="datetime-local"
          value={fromInput}
          max={toInput || undefined}
          onChange={(e) => {
            setFromInput(e.target.value);
            setPage(1);
          }}
        />
      </label>
      <label className="proxy-logs-time-field">
        <span>结束</span>
        <input
          type="datetime-local"
          value={toInput}
          min={fromInput || undefined}
          onChange={(e) => {
            setToInput(e.target.value);
            setPage(1);
          }}
        />
      </label>
      <div className="toolbar-search" style={{ maxWidth: 280 }}>
        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            setPage(1);
          }}
          placeholder="搜索模型、下游 Key、主分组、标签..."
        />
      </div>
      <button
        type="button"
        className="btn btn-ghost proxy-logs-filter-reset"
        onClick={() => {
          setStatusFilter('all');
          setClientFilter('');
          setSiteFilter(null);
          setFromInput('');
          setToInput('');
          setSearchInput('');
          setPage(1);
        }}
      >
        清空筛选
      </button>
    </>
  );

  return (
    <div className="page-shell animate-fade-in">
      <div className="page-hero">
        <div className="page-kicker">Usage Stream</div>
        <div className="page-header" style={{ marginBottom: 0 }}>
          <div>
            <h2 className="page-title">{tr('使用日志')}</h2>
            <p className="page-subtitle">
              这里聚合代理调用明细、成本、缓存命中和 Trace 排障。顶部先给你当前站点视角和总体消耗，再往下做筛选和细查。
            </p>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 10 }}>
          <span className="kpi-chip">
            {activeSiteLabel}
          </span>
          <span className="kpi-chip kpi-chip-success">
            消耗总额 ${summary.totalCost.toFixed(4)}
          </span>
          <span className="kpi-chip kpi-chip-warning">
            {summary.totalTokensAll.toLocaleString()} tokens
          </span>
          <span className="kpi-chip">
            缓存命中 {summary.cacheHitCount}
          </span>
          <span className="kpi-chip kpi-chip-warning">
            回退 {summary.cacheStaleCount}
          </span>
          <span className="kpi-chip kpi-chip-success">
            节省 ${summary.cacheSavedCost.toFixed(4)}
          </span>
            </div>
        </div>
        <div className="page-actions">
          <button
            onClick={() => setAutoRefresh((v) => !v)}
            className={`btn btn-ghost${autoRefresh ? ' btn-ghost-active' : ''}`}
            style={{ border: '1px solid var(--color-border)', padding: '6px 14px' }}
            title={autoRefresh ? '关闭自动刷新' : '开启自动刷新（每2秒）'}
          >
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ animation: autoRefresh ? 'spin 1s linear infinite' : 'none' }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {autoRefresh ? '自动刷新中' : '自动刷新'}
          </button>
          <button onClick={() => load()} disabled={loading} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '6px 14px' }}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}>
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            {loading ? '加载中...' : '刷新'}
          </button>
        </div>
        </div>
      </div>

      {isMobile ? (
        <>
          <div className="mobile-filter-row">
            <button
              type="button"
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
              onClick={() => setShowFilters(true)}
            >
              筛选
            </button>
          </div>
          <MobileFilterSheet
            open={showFilters}
            onClose={() => setShowFilters(false)}
            title={tr('筛选日志')}
          >
            {filterControls}
          </MobileFilterSheet>
        </>
      ) : (
        <div className="toolbar surface-card" style={{ marginBottom: 12 }}>
          {filterControls}
        </div>
      )}

      {hasInvalidTimeRange && (
        <div className="alert alert-error" style={{ marginBottom: 12 }}>
          结束时间必须晚于开始时间
        </div>
      )}

      <div className="card surface-card" style={{ padding: 16, marginBottom: 12, display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="badge badge-info" style={{ fontSize: 11 }}>Proxy Trace 排障</span>
            <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              用于按 `sessionId / traceId / traceHint` 追查代理选路、重试和上游异常。
            </span>
          </div>
          {traceResult ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span className="badge badge-muted" style={{ fontSize: 11 }}>命中 {traceResult.total} 条</span>
              <span className="badge badge-muted" style={{ fontSize: 11 }}>总快照 {traceResult.summary.total}</span>
            </div>
          ) : null}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'minmax(0, 1fr)' : 'repeat(4, minmax(0, 1fr))', gap: 10 }}>
          <input
            placeholder="Session ID"
            value={traceFilters.sessionId}
            onChange={(e) => setTraceFilters((current) => ({ ...current, sessionId: e.target.value }))}
            style={{ minHeight: 38 }}
          />
          <input
            placeholder="Trace ID"
            value={traceFilters.traceId}
            onChange={(e) => setTraceFilters((current) => ({ ...current, traceId: e.target.value }))}
            style={{ minHeight: 38 }}
          />
          <input
            placeholder="Trace Hint"
            value={traceFilters.traceHint}
            onChange={(e) => setTraceFilters((current) => ({ ...current, traceHint: e.target.value }))}
            style={{ minHeight: 38 }}
          />
          <div className="proxy-logs-filter-select">
            <ModernSelect
              size="sm"
              value={traceFilters.kind}
              onChange={(nextValue) => setTraceFilters((current) => ({ ...current, kind: nextValue }))}
              options={PROXY_TRACE_KIND_OPTIONS}
              placeholder="Trace 事件类型"
            />
          </div>
          <div className="proxy-logs-filter-select">
            <ModernSelect
              size="sm"
              value={traceFilters.siteId}
              onChange={(nextValue) => setTraceFilters((current) => ({ ...current, siteId: nextValue }))}
              options={traceSiteOptions}
              placeholder="Trace 站点"
              searchable
              searchPlaceholder="搜索 Trace 站点"
            />
          </div>
          <input
            placeholder="条数限制"
            value={traceFilters.limit}
            onChange={(e) => setTraceFilters((current) => ({ ...current, limit: e.target.value.replace(/\D/g, '') }))}
            style={{ minHeight: 38 }}
          />
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', gridColumn: isMobile ? 'auto' : 'span 2' }}>
            <button
              type="button"
              className="btn btn-ghost"
              data-testid="proxy-trace-query"
              onClick={() => { void loadProxyDebugTraces(); }}
              disabled={traceLoading}
              style={{ border: '1px solid var(--color-border)' }}
            >
              {traceLoading ? '查询中...' : '查询 Trace'}
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                setTraceFilters({
                  sessionId: '',
                  traceId: '',
                  traceHint: '',
                  kind: '',
                  siteId: '',
                  limit: '50',
                });
                setTraceResult(null);
              }}
            >
              清空 Trace
            </button>
          </div>
        </div>

        {traceResult ? (
          traceResult.items.length > 0 ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {Object.entries(traceResult.summary.kinds || {})
                  .sort((left, right) => right[1] - left[1])
                  .slice(0, 6)
                  .map(([kind, count]) => (
                    <span key={`trace-kind-${kind}`} className="badge badge-muted" style={{ fontSize: 11 }}>
                      {formatProxyTraceKindLabel(kind)} {count}
                    </span>
                  ))}
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>事件</th>
                      <th>链路</th>
                      <th>站点</th>
                      <th>模型</th>
                      <th>状态</th>
                      <th>详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {traceResult.items.map((item, index) => (
                      <tr key={`${item.traceId}-${item.at}-${index}`} data-testid={`proxy-trace-row-${index}`}>
                        <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{formatTraceDateTime(item.at)}</td>
                        <td style={{ fontSize: 12 }}>{formatProxyTraceKindLabel(item.kind)}</td>
                        <td style={{ fontSize: 12, minWidth: 220 }}>
                          <div style={{ display: 'grid', gap: 4 }}>
                            <span><strong>session:</strong> {item.sessionId || '-'}</span>
                            <span><strong>trace:</strong> {item.traceId}</span>
                            {item.traceHint ? <span><strong>hint:</strong> {item.traceHint}</span> : null}
                          </div>
                        </td>
                        <td style={{ fontSize: 12 }}>{item.siteName || (item.siteId ? `站点 #${item.siteId}` : '-')}</td>
                        <td style={{ fontSize: 12 }}>
                          <div style={{ display: 'grid', gap: 4 }}>
                            <span>{item.requestedModel || '-'}</span>
                            {item.actualModel && item.actualModel !== item.requestedModel ? (
                              <span style={{ color: 'var(--color-text-muted)' }}>实际 {item.actualModel}</span>
                            ) : null}
                          </div>
                        </td>
                        <td style={{ fontSize: 12 }}>
                          <div style={{ display: 'grid', gap: 4 }}>
                            <span>{typeof item.status === 'number' ? item.status : '-'}</span>
                            <span style={{ color: 'var(--color-text-muted)' }}>重试 {item.retryCount || 0}</span>
                            {item.reason ? <span style={{ color: 'var(--color-danger)' }}>{item.reason}</span> : null}
                          </div>
                        </td>
                        <td style={{ minWidth: 300 }}>
                          <details>
                            <summary style={{ cursor: 'pointer', fontSize: 12 }}>查看 detail</summary>
                            <pre style={{
                              marginTop: 8,
                              marginBottom: 0,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              fontSize: 11,
                              lineHeight: 1.5,
                              color: 'var(--color-text-secondary)',
                            }}
                            >
                              {formatProxyTraceDetail(item.detail)}
                            </pre>
                          </details>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
              当前筛选下没有命中的 Proxy Trace。
            </div>
          )
        ) : null}
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        {loading ? (
          <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[...Array(8)].map((_, i) => (
              <div key={i} style={{ display: 'flex', gap: 16 }}>
                <div className="skeleton" style={{ width: 140, height: 16 }} />
                <div className="skeleton" style={{ width: 200, height: 16 }} />
                <div className="skeleton" style={{ width: 50, height: 16 }} />
                <div className="skeleton" style={{ width: 50, height: 16 }} />
                <div className="skeleton" style={{ width: 50, height: 16 }} />
                <div className="skeleton" style={{ width: 70, height: 16 }} />
              </div>
            ))}
          </div>
        ) : isMobile ? (
          <div className="mobile-card-list">
            {logs.map((log) => {
              const detailState = detailById[log.id];
              const detail = detailState?.data;
              const detailLog: ProxyLogRenderItem = detail ? { ...log, ...detail } : log;
              const pathMeta = parseProxyLogPathMeta(detailLog.errorMessage || undefined);
              const billingDetailSummary = detail ? formatBillingDetailSummary(detailLog) : null;
              const billingProcessLines = detail ? buildBillingProcessLines(detailLog) : [];
              const downstreamKeySummary = renderDownstreamKeySummary(detailLog);
              const isExpanded = expanded === log.id;
              const clientDisplay = resolveProxyLogClientDisplay(detailLog);
              const siteLabel = resolveProxyLogSiteLabel(detailLog);

              return (
                <MobileCard
                  key={log.id}
                  title={detailLog.modelRequested || 'unknown'}
                  subtitle={formatDateTimeLocal(log.createdAt)}
                  compact
                  headerActions={(
                    <span className={`badge ${log.status === 'success' ? 'badge-success' : 'badge-error'}`} style={{ fontSize: 10 }}>
                      {log.status === 'success' ? '成功' : '失败'}
                    </span>
                  )}
                  footerActions={(
                    <button
                      type="button"
                      className="btn btn-link"
                      onClick={() => handleToggleExpand(log.id)}
                    >
                      {isExpanded ? '收起详情' : '详情'}
                    </button>
                  )}
                >
                  <div className="mobile-inline-meta-row">
                    <SiteBadgeLink siteId={siteIdByName.get(String(siteLabel || '').trim())} siteName={siteLabel} badgeStyle={{ fontSize: 11 }} />
                    {renderCacheBadge(log.cacheStatus)}
                    {clientDisplay.primary ? (
                      <span className="badge badge-muted" style={{ fontSize: 10 }}>
                        {clientDisplay.primary}
                      </span>
                    ) : null}
                    {clientDisplay.secondary ? (
                      <span className="badge badge-muted" style={{ fontSize: 10 }}>
                        {clientDisplay.secondary}
                      </span>
                    ) : null}
                  </div>
                  <div className="mobile-summary-grid">
                    <div className="mobile-summary-metric">
                      <div className="mobile-summary-metric-label">用时</div>
                      <div className="mobile-summary-metric-value">{formatLatency(log.latencyMs)}</div>
                    </div>
                    <div className="mobile-summary-metric">
                      <div className="mobile-summary-metric-label">输入</div>
                      <div className="mobile-summary-metric-value">{log.promptTokens?.toLocaleString() || '-'}</div>
                    </div>
                    <div className="mobile-summary-metric">
                      <div className="mobile-summary-metric-label">输出</div>
                      <div className="mobile-summary-metric-value">{log.completionTokens?.toLocaleString() || '-'}</div>
                    </div>
                    <div className="mobile-summary-metric">
                      <div className="mobile-summary-metric-label">花费</div>
                      <div className="mobile-summary-metric-value">{typeof log.estimatedCost === 'number' ? `$${log.estimatedCost.toFixed(6)}` : '-'}</div>
                    </div>
                    <div className="mobile-summary-metric">
                      <div className="mobile-summary-metric-label">缓存节省</div>
                      <div className="mobile-summary-metric-value">{typeof log.cacheSavedCost === 'number' && log.cacheSavedCost > 0 ? `$${log.cacheSavedCost.toFixed(6)}` : '-'}</div>
                    </div>
                  </div>
                  {isExpanded ? (
                    <div className="mobile-card-extra">
                      <MobileField label="时间" value={formatDateTimeLocal(log.createdAt)} />
                      <MobileField label="站点" value={<SiteBadgeLink siteId={siteIdByName.get(String(siteLabel || '').trim())} siteName={siteLabel} badgeStyle={{ fontSize: 11 }} />} />
                      <MobileField label="重试" value={log.retryCount > 0 ? log.retryCount : 0} />
                      {detailState?.loading && <div style={{ color: 'var(--color-text-muted)' }}>加载详情中...</div>}
                      {detailState?.error && <div style={{ color: 'var(--color-danger)' }}>{detailState.error}</div>}
                      {billingDetailSummary && <div style={{ color: 'var(--color-text-muted)' }}>{billingDetailSummary}</div>}
                      <MobileField label="客户端详情" value={renderProxyLogClientCell(detailLog, { includeGeneric: true })} />
                      {downstreamKeySummary && <div style={{ color: 'var(--color-text-muted)' }}>{downstreamKeySummary}</div>}
                      {billingProcessLines.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          {billingProcessLines.map((line, index) => (
                            <span key={`${log.id}-billing-mobile-${index}`}>{line}</span>
                          ))}
                        </div>
                      )}
                      {detail && pathMeta.errorMessage.trim().length > 0 && (
                        <div style={{ color: 'var(--color-danger)' }}>{pathMeta.errorMessage}</div>
                      )}
                    </div>
                  ) : null}
                </MobileCard>
              );
            })}
          </div>
        ) : (
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>时间</th>
                <th>模型</th>
                <th>站点</th>
                <th>客户端</th>
                <th>{tr('状态')}</th>
                <th style={{ textAlign: 'center' }}>用时</th>
                <th style={{ textAlign: 'right' }}>输入</th>
                <th style={{ textAlign: 'right' }}>输出</th>
                <th style={{ textAlign: 'right' }}>花费</th>
                <th style={{ textAlign: 'right' }}>缓存节省</th>
                <th style={{ textAlign: 'center' }}>重试</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log) => {
                const detailState = detailById[log.id];
                const detail = detailState?.data;
                const detailLog: ProxyLogRenderItem = detail ? { ...log, ...detail } : log;
                const pathMeta = parseProxyLogPathMeta(detailLog.errorMessage || undefined);
                const billingDetailSummary = detail ? formatBillingDetailSummary(detailLog) : null;
                const billingProcessLines = detail ? buildBillingProcessLines(detailLog) : [];
                const downstreamKeySummary = renderDownstreamKeySummary(detailLog);
                const siteLabel = resolveProxyLogSiteLabel(detailLog);

                return (
                  <React.Fragment key={log.id}>
                    <tr
                      data-testid={`proxy-log-row-${log.id}`}
                      onClick={() => handleToggleExpand(log.id)}
                      style={{
                        cursor: 'pointer',
                        background: expanded === log.id ? 'var(--color-primary-light)' : undefined,
                        transition: 'background 0.15s',
                      }}
                    >
                      <td style={{ padding: '8px 4px 8px 12px' }}>
                        <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{
                          transform: expanded === log.id ? 'rotate(90deg)' : 'none',
                          transition: 'transform 0.2s',
                          color: 'var(--color-text-muted)',
                        }}>
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                        </svg>
                      </td>
                      <td style={{ fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)' }}>
                        {formatDateTimeLocal(log.createdAt)}
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <ModelBadge model={log.modelRequested} style={{ alignSelf: 'flex-start' }} />
                          {renderCacheBadge(log.cacheStatus)}
                          {downstreamKeySummary ? (
                            <div style={{ fontSize: 11, lineHeight: 1.45, color: 'var(--color-text-muted)' }}>
                              {downstreamKeySummary}
                            </div>
                          ) : null}
                        </div>
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        <SiteBadgeLink siteId={siteIdByName.get(String(siteLabel || '').trim())} siteName={siteLabel} badgeStyle={{ fontSize: 11 }} />
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        {renderProxyLogClientCell(detailLog)}
                      </td>
                      <td>
                        <span className={`badge ${log.status === 'success' ? 'badge-success' : 'badge-error'}`} style={{ fontSize: 11, fontWeight: 600 }}>
                          <span style={{
                            width: 6, height: 6, borderRadius: '50%',
                            background: log.status === 'success' ? 'var(--color-success)' : 'var(--color-danger)',
                          }} />
                          {log.status === 'success' ? '成功' : '失败'}
                        </span>
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <span style={{
                          fontVariantNumeric: 'tabular-nums',
                          fontSize: 12,
                          fontWeight: 600,
                          color: latencyColor(log.latencyMs),
                          background: latencyBgColor(log.latencyMs),
                          padding: '2px 8px',
                          borderRadius: 4,
                        }}>
                          {formatLatency(log.latencyMs)}
                        </span>
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)' }}>
                        {log.promptTokens?.toLocaleString() || '-'}
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)' }}>
                        {log.completionTokens?.toLocaleString() || '-'}
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                        {typeof log.estimatedCost === 'number' ? `$${log.estimatedCost.toFixed(6)}` : '-'}
                      </td>
                      <td style={{ textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)' }}>
                        {typeof log.cacheSavedCost === 'number' && log.cacheSavedCost > 0 ? `$${log.cacheSavedCost.toFixed(6)}` : '-'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {log.retryCount > 0 ? (
                          <span className="badge badge-warning" style={{ fontSize: 11 }}>{log.retryCount}</span>
                        ) : (
                          <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>0</span>
                        )}
                      </td>
                    </tr>
                    {expanded === log.id && (
                      <tr style={{ background: 'var(--color-bg)' }}>
                        <td colSpan={12} style={{ padding: 0 }}>
                          <div className="anim-collapse is-open">
                            <div className="anim-collapse-inner">
                              <div className="animate-fade-in" style={{
                                padding: '14px 20px 14px 40px',
                                borderTop: '1px solid var(--color-border-light)',
                                borderBottom: '1px solid var(--color-border-light)',
                                fontSize: 12,
                                lineHeight: 1.9,
                                color: 'var(--color-text-secondary)',
                              }}>
                                <div style={{ display: 'flex', gap: 6 }}>
                                  <span style={{ fontWeight: 600, color: 'var(--color-warning)', flexShrink: 0 }}>日志详情</span>
                                  <div>
                                    <div>
                                      请求模型: <strong style={{ color: 'var(--color-text-primary)' }}>{detailLog.modelRequested}</strong>
                                      {detailLog.modelActual && detailLog.modelActual !== detailLog.modelRequested && (
                                        <>{' -> '}实际模型: <strong style={{ color: 'var(--color-text-primary)' }}>{detailLog.modelActual}</strong></>
                                      )}
                                      ，状态: <strong style={{ color: detailLog.status === 'success' ? 'var(--color-success)' : 'var(--color-danger)' }}>{detailLog.status === 'success' ? '成功' : '失败'}</strong>
                                      ，用时: <strong style={{ color: latencyColor(detailLog.latencyMs) }}>{formatLatency(detailLog.latencyMs)}</strong>
                                      {detail && (
                                        <>
                                          ，站点: <strong style={{ color: 'var(--color-text-primary)' }}>{detailLog.siteName || '未知站点'}</strong>
                                          ，账号: <strong style={{ color: 'var(--color-text-primary)' }}>{detailLog.username || '未知账号'}</strong>
                                        </>
                                      )}
                                      {isNonGenerationSuccess(detailLog) && (
                                        <>
                                          ，类型: <strong style={{ color: 'var(--color-warning)' }}>非生成型成功</strong>
                                        </>
                                      )}
                                    </div>
                                    {detailState?.loading && <div style={{ color: 'var(--color-text-muted)' }}>加载详情中...</div>}
                                    {detailState?.error && <div style={{ color: 'var(--color-danger)' }}>{detailState.error}</div>}
                                    {billingDetailSummary && (
                                      <div style={{ color: 'var(--color-text-muted)' }}>{billingDetailSummary}</div>
                                    )}
                                    <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                                      <span style={{ color: 'var(--color-text-muted)', flexShrink: 0 }}>客户端</span>
                                      <div style={{ minWidth: 0 }}>
                                        {renderProxyLogClientCell(detailLog, { includeGeneric: true })}
                                      </div>
                                    </div>
                                    {downstreamKeySummary && (
                                      <div style={{ color: 'var(--color-text-muted)' }}>{downstreamKeySummary}</div>
                                    )}
                                  </div>
                                </div>

                                {detailLog.billingDetails && detailLog.billingDetails.usage.cacheReadTokens > 0 && (
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    <span style={{ fontWeight: 600, color: 'var(--color-warning)', flexShrink: 0 }}>缓存 Tokens</span>
                                    <span>{detailLog.billingDetails.usage.cacheReadTokens.toLocaleString()}</span>
                                  </div>
                                )}

                                {detailLog.billingDetails && detailLog.billingDetails.usage.cacheCreationTokens > 0 && (
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    <span style={{ fontWeight: 600, color: 'var(--color-warning)', flexShrink: 0 }}>缓存创建 Tokens</span>
                                    <span>{detailLog.billingDetails.usage.cacheCreationTokens.toLocaleString()}</span>
                                  </div>
                                )}

                                <div style={{ display: 'flex', gap: 6 }}>
                                  <span style={{ fontWeight: 600, color: 'var(--color-info)', flexShrink: 0 }}>计费过程</span>
                                  {billingProcessLines.length > 0 ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                                      {billingProcessLines.map((line, index) => (
                                        <span key={`${log.id}-billing-${index}`}>{line}</span>
                                      ))}
                                      <span style={{ color: 'var(--color-text-muted)' }}>仅供参考，以实际扣费为准</span>
                                    </div>
                                  ) : (
                                    <span>
                                      输入 {detailLog.promptTokens?.toLocaleString() || 0} tokens
                                      {' + '}输出 {detailLog.completionTokens?.toLocaleString() || 0} tokens
                                      {' = '}总计 {detailLog.totalTokens?.toLocaleString() || 0} tokens
                                      {typeof detailLog.estimatedCost === 'number' && (
                                        <>，预估费用 <strong style={{ color: 'var(--color-text-primary)' }}>${detailLog.estimatedCost.toFixed(6)}</strong></>
                                      )}
                                    </span>
                                  )}
                                </div>

                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                  <span style={{ fontWeight: 600, color: 'var(--color-primary)', flexShrink: 0 }}>下游请求路径</span>
                                  {detail && pathMeta.downstreamPath ? (
                                    <code style={{
                                      fontFamily: 'var(--font-mono)', fontSize: 12,
                                      background: 'var(--color-bg-card)', padding: '1px 8px', borderRadius: 4,
                                      border: '1px solid var(--color-border-light)',
                                    }}>
                                      {pathMeta.downstreamPath}
                                    </code>
                                  ) : (
                                    <span style={{ color: 'var(--color-text-muted)' }}>未记录</span>
                                  )}
                                </div>

                                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                  <span style={{ fontWeight: 600, color: 'var(--color-primary)', flexShrink: 0 }}>上游请求路径</span>
                                  {detail && pathMeta.upstreamPath ? (
                                    <code style={{
                                      fontFamily: 'var(--font-mono)', fontSize: 12,
                                      background: 'var(--color-bg-card)', padding: '1px 8px', borderRadius: 4,
                                      border: '1px solid var(--color-border-light)',
                                    }}>
                                      {pathMeta.upstreamPath}
                                    </code>
                                  ) : (
                                    <span style={{ color: 'var(--color-text-muted)' }}>未记录</span>
                                  )}
                                </div>

                                {detail && pathMeta.errorMessage.trim().length > 0 && (
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    <span style={{ fontWeight: 600, color: 'var(--color-danger)', flexShrink: 0 }}>错误信息</span>
                                    <span style={{ color: 'var(--color-danger)', whiteSpace: 'pre-wrap' }}>{pathMeta.errorMessage}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
        {!loading && logs.length === 0 && (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
            <div className="empty-state-title">{tr('暂无使用日志')}</div>
            <div className="empty-state-desc">当请求通过代理时，日志将显示在这里</div>
          </div>
        )}
      </div>

      {total > 0 && (
        <div className="pagination">
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginRight: 'auto' }}>
            显示第 {displayedStart} - {displayedEnd} 条，共 {total} 条
          </div>
          <button className="pagination-btn" disabled={safePage <= 1} onClick={() => setPage((current) => current - 1)}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          {pageNumbers.map((num) => (
            <button key={num} className={`pagination-btn ${safePage === num ? 'active' : ''}`} onClick={() => setPage(num)}>
              {num}
            </button>
          ))}
          <button className="pagination-btn" disabled={safePage >= totalPages} onClick={() => setPage((current) => current + 1)}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
          <div className="pagination-size">
            每页条数:
            <div style={{ minWidth: 86 }}>
              <ModernSelect
                size="sm"
                value={String(pageSize)}
                onChange={(nextValue) => {
                  setPageSize(Number(nextValue));
                  setPage(1);
                }}
                options={PAGE_SIZES.map((s) => ({ value: String(s), label: String(s) }))}
                placeholder={String(pageSize)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
