import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import CenteredModal from '../components/CenteredModal.js';
import MobileBatchBar from '../components/MobileBatchBar.js';
import MobileFilterSheet from '../components/MobileFilterSheet.js';
import { useToast } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import ResponsiveFormGrid from '../components/ResponsiveFormGrid.js';
import { useIsMobile } from '../components/useIsMobile.js';
import DeleteConfirmModal from '../components/DeleteConfirmModal.js';
import { formatDateTimeLocal } from './helpers/checkinLogTime.js';
import { clearFocusParams, readFocusSiteId } from './helpers/navigationFocus.js';
import { tr } from '../i18n.js';
import { buildCustomReorderUpdates, compareCustomOrderedItems, sortItemsForDisplay, type SortMode } from './helpers/listSorting.js';
import { shouldIgnoreRowSelectionClick } from './helpers/rowSelection.js';
import { resolveInitialConnectionSegment } from './helpers/defaultConnectionSegment.js';
import {
  buildSiteSaveAction,
  emptySiteCustomHeader,
  emptySiteForm,
  getAllowedProtocolEndpointsForPlatform,
  serializeSiteCustomHeaders,
  siteFormFromSite,
  type SiteEditorState,
  type SiteForm,
} from './helpers/sitesEditor.js';

type SiteSortMode = SortMode | 'reachability-desc' | 'reachability-asc';

type SiteSubscriptionSummary = {
  activeCount: number;
  totalUsedUsd: number;
  totalMonthlyLimitUsd?: number | null;
  totalRemainingUsd?: number | null;
  nextExpiresAt?: string | null;
  planNames?: string[];
  updatedAt?: number | null;
};

type SiteRow = {
  id: number;
  name: string;
  url: string;
  externalCheckinUrl?: string | null;
  platform?: string;
  status?: string;
  healthStatus?: 'alive' | 'unreachable' | 'unknown' | string;
  healthReason?: string | null;
  healthCheckedAt?: string | null;
  autoCheckinPolicy?: 'normal' | 'unsupported' | 'manual_required' | string;
  autoCheckinReason?: string | null;
  autoCheckinUpdatedAt?: string | null;
  proxyUrl?: string | null;
  useSystemProxy?: boolean;
  customHeaders?: string | null;
  globalWeight?: number;
  isPinned?: boolean;
  sortOrder?: number;
  totalBalance?: number;
  subscriptionSummary?: SiteSubscriptionSummary | null;
  createdAt?: string;
  protocolConfig?: {
    mode?: 'auto' | 'manual';
    supportedEndpoints?: Array<'chat' | 'responses' | 'messages'>;
    preferredEndpoint?: 'chat' | 'responses' | 'messages' | null;
    updatedAtMs?: number;
  } | null;
};

type SiteProtocolProbeResult = {
  success: true;
  siteId: number;
  modelName: string;
  preferredEndpoint: 'chat' | 'responses' | 'messages';
  supportedEndpoints: Array<'chat' | 'responses' | 'messages'>;
  probeSource?: 'live' | 'cache' | 'cooldown_cache';
  cacheHit?: boolean;
  cooldownUntilMs?: number | null;
  cooldownRemainingMs?: number;
  attemptSummary?: string[];
  attempts?: Array<{
    endpoint: 'chat' | 'responses' | 'messages';
    ok: boolean;
    classification: string;
    reason: string;
  }>;
  protocolConfig?: {
    mode?: 'auto' | 'manual';
    supportedEndpoints?: Array<'chat' | 'responses' | 'messages'>;
    preferredEndpoint?: 'chat' | 'responses' | 'messages' | null;
    updatedAtMs?: number;
  } | null;
};

function buildDiagnosticPath(targetType: 'site' | 'account' | 'token', targetId: number): string {
  const params = new URLSearchParams();
  params.set('targetType', targetType);
  params.set('targetId', String(targetId));
  return `/diagnostics?${params.toString()}`;
}

function hasConfiguredCustomHeaders(customHeaders?: string | null): boolean {
  return typeof customHeaders === 'string' && customHeaders.trim().length > 0;
}

function formatUsd(value?: number | null): string {
  return `$${(value || 0).toFixed(2)}`;
}

function formatSubscriptionDate(value?: string | null): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toISOString().slice(0, 10);
}

function formatRemainingDuration(value?: string | null): string | null {
  if (!value) return null;
  const targetMs = Date.parse(value);
  if (!Number.isFinite(targetMs)) return null;
  const deltaMs = targetMs - Date.now();
  if (deltaMs <= 0) return '已到期';

  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;
  if (deltaMs >= dayMs) return `剩余${Math.ceil(deltaMs / dayMs)}天`;
  if (deltaMs >= hourMs) return `剩余${Math.ceil(deltaMs / hourMs)}小时`;
  if (deltaMs >= minuteMs) return `剩余${Math.ceil(deltaMs / minuteMs)}分钟`;
  return `剩余${Math.max(1, Math.ceil(deltaMs / 1000))}秒`;
}

function buildSubscriptionInlineValue(summary?: SiteSubscriptionSummary | null): string | null {
  if (!summary) return null;
  const remainingValue = typeof summary.totalRemainingUsd === 'number' && Number.isFinite(summary.totalRemainingUsd)
    ? formatUsd(summary.totalRemainingUsd)
    : '--';
  const usedValue = formatUsd(summary.totalUsedUsd);
  const remainingDuration = formatRemainingDuration(summary.nextExpiresAt);
  const remainingSuffix = remainingDuration ? `（${remainingDuration}）` : '';
  if (usedValue === '$0.00' && remainingValue === '--' && !remainingSuffix) return null;
  return `${remainingValue}${remainingSuffix}`;
}

function buildSubscriptionTooltip(summary?: SiteSubscriptionSummary | null): string | null {
  if (!summary) return null;
  const parts: string[] = [];
  if (summary.activeCount > 0) parts.push(`生效订阅 ${summary.activeCount} 个`);

  const planNames = Array.isArray(summary.planNames)
    ? summary.planNames.filter((item) => typeof item === 'string' && item.trim())
    : [];
  if (planNames.length > 0) parts.push(`套餐 ${planNames.join(' / ')}`);

  if (typeof summary.totalRemainingUsd === 'number' && Number.isFinite(summary.totalRemainingUsd)) {
    parts.push(`订阅余额 ${formatUsd(summary.totalRemainingUsd)}`);
  }
  parts.push(`已用 ${formatUsd(summary.totalUsedUsd)}`);

  if (typeof summary.totalMonthlyLimitUsd === 'number' && Number.isFinite(summary.totalMonthlyLimitUsd)) {
    parts.push(`总额度 ${formatUsd(summary.totalMonthlyLimitUsd)}`);
  }

  const remainingDuration = formatRemainingDuration(summary.nextExpiresAt);
  if (remainingDuration) parts.push(remainingDuration);

  if (summary.nextExpiresAt) parts.push(`到期 ${formatSubscriptionDate(summary.nextExpiresAt)}`);

  return parts.join(' | ');
}

function SiteBalanceDisplay(props: {
  balance?: number | null;
  summary?: SiteSubscriptionSummary | null;
  align?: 'start' | 'end';
}) {
  const { balance, summary, align = 'start' } = props;
  const walletBalanceText = formatUsd(balance);
  const subscriptionValue = buildSubscriptionInlineValue(summary);
  const tooltip = buildSubscriptionTooltip(summary);

  return (
    <div
      className={`site-balance-inline ${align === 'end' ? 'align-end' : ''}`.trim()}
    >
      <span className="site-balance-primary">{walletBalanceText}</span>
      {subscriptionValue ? (
        <>
          <span className="site-balance-divider">/</span>
          <span
            className="site-balance-subscription"
            data-tooltip={tooltip || undefined}
            data-tooltip-align={align === 'end' ? 'end' : 'start'}
            data-tooltip-side="top"
            tabIndex={tooltip ? 0 : undefined}
          >
            {subscriptionValue}
          </span>
        </>
      ) : null}
    </div>
  );
}

const platformColors: Record<string, string> = {
  'new-api': 'badge-info',
  'one-api': 'badge-success',
  anyrouter: 'badge-warning',
  veloera: 'badge-warning',
  'one-hub': 'badge-muted',
  'done-hub': 'badge-muted',
  sub2api: 'badge-muted',
  openai: 'badge-success',
  codex: 'badge-success',
  claude: 'badge-warning',
  gemini: 'badge-info',
  cliproxyapi: 'badge-info',
};

const siteReachabilityMap: Record<string, {
  label: string;
  cls: string;
  dotClass: string;
  pulse?: boolean;
}> = {
  alive: { label: '可达', cls: 'badge-success', dotClass: 'status-dot-success', pulse: true },
  unreachable: { label: '不可达', cls: 'badge-error', dotClass: 'status-dot-error', pulse: true },
  unknown: { label: '未知', cls: 'badge-muted', dotClass: 'status-dot-muted' },
};

function resolveSiteAutoCheckinMeta(site: SiteRow): { label: string; cls: string; detail: string } {
  const reason = (site.autoCheckinReason || '').trim();
  const policy = (site.autoCheckinPolicy || 'normal').trim();

  if (site.status === 'disabled') {
    return {
      label: '已关闭',
      cls: 'badge-muted',
      detail: '站点已禁用，批量签到不会执行',
    };
  }

  if (policy === 'unsupported') {
    return {
      label: '永久跳过',
      cls: 'badge-warning',
      detail: reason || '站点未提供签到接口，已永久跳过自动签到',
    };
  }

  if (policy === 'manual_required') {
    return {
      label: '人工处理',
      cls: 'badge-warning',
      detail: reason || '站点需要人工验证，已永久跳过自动签到',
    };
  }

  if ((site.healthStatus || 'unknown') === 'unreachable') {
    return {
      label: '临时跳过',
      cls: 'badge-error',
      detail: '站点当前不可达，批量签到会临时跳过；恢复可达后会自动重新纳入',
    };
  }

  if ((site.healthStatus || 'unknown') === 'alive') {
    return {
      label: '正常',
      cls: 'badge-success',
      detail: '当前参与批量签到',
    };
  }

  return {
    label: '待确认',
    cls: 'badge-muted',
    detail: '尚未确认自动签到状态',
  };
}

const SITE_PLATFORM_OPTIONS = [
  { value: '', label: '平台类型（可自动检测）' },
  { value: 'new-api', label: 'new-api' },
  { value: 'one-api', label: 'one-api' },
  { value: 'anyrouter', label: 'anyrouter' },
  { value: 'veloera', label: 'veloera' },
  { value: 'one-hub', label: 'one-hub' },
  { value: 'done-hub', label: 'done-hub' },
  { value: 'sub2api', label: 'sub2api' },
  { value: 'openai', label: 'openai' },
  { value: 'codex', label: 'codex' },
  { value: 'claude', label: 'claude' },
  { value: 'gemini', label: 'gemini' },
  { value: 'cliproxyapi', label: 'cliproxyapi' },
];

const SITE_PROTOCOL_MODE_OPTIONS = [
  { value: 'auto', label: '自动学习' },
  { value: 'manual', label: '手动指定' },
];

const SITE_PROTOCOL_ENDPOINT_OPTIONS = [
  { value: 'chat', label: '/v1/chat/completions' },
  { value: 'responses', label: '/v1/responses' },
  { value: 'messages', label: '/v1/messages' },
] as const;

function buildSiteProtocolSummary(site: SiteRow): string {
  const config = site.protocolConfig;
  if (!config || config.mode !== 'manual') return '自动';
  const supported = Array.isArray(config.supportedEndpoints)
    ? config.supportedEndpoints.filter(Boolean)
    : [];
  if (supported.length === 0) return '自动';
  const preferred = config.preferredEndpoint ? `首选 ${config.preferredEndpoint}` : null;
  return [supported.join(' / '), preferred].filter(Boolean).join(' · ');
}

export default function Sites() {
  const location = useLocation();
  const navigate = useNavigate();
  const [sites, setSites] = useState<SiteRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sortMode, setSortMode] = useState<SiteSortMode>('custom');
  const [highlightSiteId, setHighlightSiteId] = useState<number | null>(null);
  const [editor, setEditor] = useState<SiteEditorState | null>(null);
  const [form, setForm] = useState<SiteForm>(emptySiteForm());
  const [detecting, setDetecting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<number | null>(null);
  const [togglingSiteId, setTogglingSiteId] = useState<number | null>(null);
  const [orderingSiteId, setOrderingSiteId] = useState<number | null>(null);
  const [pinningSiteId, setPinningSiteId] = useState<number | null>(null);
  const [siteOpsLoading, setSiteOpsLoading] = useState<Record<string, boolean>>({});
  const [selectedSiteIds, setSelectedSiteIds] = useState<number[]>([]);
  const [expandedSiteIds, setExpandedSiteIds] = useState<number[]>([]);
  const isMobile = useIsMobile();
  const [showMobileTools, setShowMobileTools] = useState(false);
  const [batchActionLoading, setBatchActionLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<null | {
    mode: 'single' | 'batch';
    siteId?: number;
    siteName?: string;
    count?: number;
  }>(null);
  const lastEditorRef = useRef<SiteEditorState | null>(null);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const highlightTimerRef = useRef<number | null>(null);
  const toast = useToast();
  const [disabledModels, setDisabledModels] = useState<string[]>([]);
  const [disabledModelInput, setDisabledModelInput] = useState('');
  const [disabledModelsLoading, setDisabledModelsLoading] = useState(false);
  const [disabledModelsSaving, setDisabledModelsSaving] = useState(false);
  const [protocolProbing, setProtocolProbing] = useState(false);
  const [lastProbeResult, setLastProbeResult] = useState<SiteProtocolProbeResult | null>(null);

  if (editor) lastEditorRef.current = editor;
  const activeEditor = editor || lastEditorRef.current;
  const isEditing = activeEditor?.mode === 'edit';
  const isAdding = editor?.mode === 'add';
  const allowedProtocolEndpoints = useMemo(
    () => getAllowedProtocolEndpointsForPlatform(form.platform),
    [form.platform],
  );
  const allowedProtocolEndpointSet = useMemo(
    () => new Set(allowedProtocolEndpoints),
    [allowedProtocolEndpoints],
  );
  const formInputStyle = {
    width: '100%',
    padding: '10px 14px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    outline: 'none',
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
  } as const;

  const load = async () => {
    try {
      const rows = await api.getSites();
      setSites(rows || []);
      setSelectedSiteIds((current) => current.filter((id) => (rows || []).some((site: SiteRow) => site.id === id)));
    } catch {
      toast.error('加载站点列表失败');
    } finally {
      setLoaded(true);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const withSiteOpLoading = async (key: string, fn: () => Promise<void>) => {
    setSiteOpsLoading((prev) => ({ ...prev, [key]: true }));
    try {
      await fn();
    } finally {
      setSiteOpsLoading((prev) => ({ ...prev, [key]: false }));
    }
  };

  const handleRefreshSiteHealth = async () => {
    await withSiteOpLoading('refresh-site-health', async () => {
      const result = await api.refreshSiteHealth();
      toast.success(result?.message || '已开始检测站点存活状态，请到任务中心查看结果');
    });
  };

  const handleDryRunCleanup = async () => {
    await withSiteOpLoading('dryrun-cleanup', async () => {
      const result = await api.cleanupUnreachableSites({ dryRun: true });
      toast.success(result?.message || '已开始预检失活站点，请到任务中心查看结果');
    });
  };

  const handleCleanupUnreachable = async () => {
    if (!window.confirm('将移除不可达站点，并级联删除其账号/Key/签到日志。确认继续？')) return;
    await withSiteOpLoading('cleanup-unreachable', async () => {
      const result = await api.cleanupUnreachableSites();
      toast.success(result?.message || '已开始移除失活站点，请到任务中心查看结果');
      await load();
    });
  };

  const renderSiteReachability = (site: SiteRow) => {
    const healthKey = site.healthStatus || 'unknown';
    const health = siteReachabilityMap[healthKey] || siteReachabilityMap.unknown;
    const reason = (site.healthReason || '').trim();
    const checkedAt = site.healthCheckedAt ? formatDateTimeLocal(site.healthCheckedAt) : '';
    const detail = reason || (checkedAt ? `最后检测: ${checkedAt}` : '尚未检测');

    return (
      <div>
        <span className={`badge ${health.cls}`} style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, width: 'fit-content' }}>
          <span className={`status-dot ${health.dotClass} ${health.pulse ? 'animate-pulse-dot' : ''}`} style={{ marginRight: 0 }} />
          {health.label}
        </span>
        <div
          style={{
            marginTop: 4,
            maxWidth: 220,
            fontSize: 11,
            lineHeight: 1.35,
            color: 'var(--color-text-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={detail}
        >
          {detail}
        </div>
      </div>
    );
  };

  const renderSiteAutoCheckin = (site: SiteRow) => {
    const meta = resolveSiteAutoCheckinMeta(site);
    return (
      <div>
        <span className={`badge ${meta.cls}`} style={{ fontSize: 11 }}>
          {meta.label}
        </span>
        <div
          style={{
            marginTop: 4,
            maxWidth: 240,
            fontSize: 11,
            lineHeight: 1.35,
            color: 'var(--color-text-muted)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
          title={meta.detail}
        >
          {meta.detail}
        </div>
      </div>
    );
  };

  const getSiteReachabilityRank = useMemo(() => (
    (site: SiteRow) => {
      switch (site.healthStatus || 'unknown') {
        case 'alive':
          return 2;
        case 'unknown':
          return 1;
        case 'unreachable':
        default:
          return 0;
      }
    }
  ), []);

  const sortedSites = useMemo(
    () => {
      if (sortMode === 'custom' || sortMode === 'balance-desc' || sortMode === 'balance-asc') {
        return sortItemsForDisplay(sites, sortMode, (site) => site.totalBalance || 0);
      }

      const list = [...sites];
      return list.sort((a, b) => {
        const rankDiff = getSiteReachabilityRank(a) - getSiteReachabilityRank(b);
        if (rankDiff !== 0) {
          return sortMode === 'reachability-desc' ? -rankDiff : rankDiff;
        }
        return compareCustomOrderedItems(a, b);
      });
    },
    [getSiteReachabilityRank, sites, sortMode],
  );
  const allVisibleSitesSelected = sortedSites.length > 0 && sortedSites.every((site) => selectedSiteIds.includes(site.id));
  const siteSortOptions: Array<{ value: SiteSortMode; label: string }> = [
    { value: 'custom', label: '自定义排序' },
    { value: 'balance-desc', label: '余额高到低' },
    { value: 'balance-asc', label: '余额低到高' },
    { value: 'reachability-desc', label: '可达状态: 可达优先' },
    { value: 'reachability-asc', label: '可达状态: 异常优先' },
  ];

  const getSiteHeaderSortMeta = (field: 'balance' | 'reachability') => {
    if (field === 'balance') {
      if (sortMode === 'balance-desc') return { active: true, direction: 'desc' as const };
      if (sortMode === 'balance-asc') return { active: true, direction: 'asc' as const };
      return { active: false, direction: null };
    }
    if (sortMode === 'reachability-desc') return { active: true, direction: 'desc' as const };
    if (sortMode === 'reachability-asc') return { active: true, direction: 'asc' as const };
    return { active: false, direction: null };
  };

  const toggleSiteHeaderSort = (field: 'balance' | 'reachability') => {
    setSortMode((current) => {
      if (field === 'balance') {
        return current === 'balance-desc' ? 'balance-asc' : 'balance-desc';
      }
      return current === 'reachability-desc' ? 'reachability-asc' : 'reachability-desc';
    });
  };

  const platformOptions = useMemo(() => {
    const current = form.platform.trim();
    if (!current || SITE_PLATFORM_OPTIONS.some((option) => option.value === current)) {
      return SITE_PLATFORM_OPTIONS;
    }
    return [
      ...SITE_PLATFORM_OPTIONS,
      { value: current, label: `${current}（当前值）` },
    ];
  }, [form.platform]);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const focusSiteId = readFocusSiteId(location.search);
    if (!focusSiteId || !loaded) return;

    const row = rowRefs.current.get(focusSiteId);
    const cleanedSearch = clearFocusParams(location.search);
    if (!row) {
      navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
      return;
    }

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightSiteId(focusSiteId);
    if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightSiteId((current) => (current === focusSiteId ? null : current));
    }, 2200);

    navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
  }, [loaded, location.pathname, location.search, navigate, sortedSites]);

  const closeEditor = () => {
    setEditor(null);
    setForm(emptySiteForm());
  };

  const scrollToEditorTop = () => {
    const scrollTo = (globalThis as { scrollTo?: (options?: ScrollToOptions) => void }).scrollTo;
    if (typeof scrollTo === 'function') {
      scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const openAdd = () => {
    if (isAdding) {
      closeEditor();
      return;
    }
    setEditor({ mode: 'add' });
    setForm(emptySiteForm());
    scrollToEditorTop();
  };

  const openEdit = (site: SiteRow) => {
    setEditor({ mode: 'edit', editingSiteId: site.id });
    setForm(siteFormFromSite(site));
    scrollToEditorTop();
    // Load disabled models for this site
    setDisabledModelsLoading(true);
    setDisabledModels([]);
    setDisabledModelInput('');
    api.getSiteDisabledModels(site.id)
      .then((res: any) => setDisabledModels(Array.isArray(res?.models) ? res.models : []))
      .catch(() => { })
      .finally(() => setDisabledModelsLoading(false));
  };

  const handleAddDisabledModel = () => {
    const model = disabledModelInput.trim();
    if (!model) return;
    if (disabledModels.includes(model)) {
      toast.info(`模型 "${model}" 已在禁用列表中`);
      setDisabledModelInput('');
      return;
    }
    setDisabledModels((prev) => [...prev, model]);
    setDisabledModelInput('');
  };

  const handleRemoveDisabledModel = (model: string) => {
    setDisabledModels((prev) => prev.filter((m) => m !== model));
  };

  const handleSaveDisabledModels = async () => {
    if (!editor || editor.mode !== 'edit') return;
    setDisabledModelsSaving(true);
    try {
      await api.updateSiteDisabledModels(editor.editingSiteId, disabledModels);
      try {
        await api.rebuildRoutes(false, false);
        toast.success('禁用模型列表已保存，路由已重建');
      } catch {
        toast.error('禁用模型列表已保存，但路由重建失败，请手动刷新路由');
      }
    } catch (e: any) {
      toast.error(e.message || '保存禁用模型失败');
    } finally {
      setDisabledModelsSaving(false);
    }
  };

  const handleProbeProtocol = async () => {
    if (!editor || editor.mode !== 'edit') {
      toast.info('请先保存站点后再自动探测协议');
      return;
    }
    setProtocolProbing(true);
    try {
      const result = await api.probeSiteProtocol(editor.editingSiteId) as SiteProtocolProbeResult;
      setLastProbeResult(result);
      const nextSupported = Array.isArray(result?.supportedEndpoints)
        ? result.supportedEndpoints.filter((endpoint): endpoint is 'chat' | 'responses' | 'messages' => (
          (endpoint === 'chat' || endpoint === 'responses' || endpoint === 'messages')
          && allowedProtocolEndpointSet.has(endpoint)
        ))
        : [];
      const nextPreferred = result?.preferredEndpoint === 'chat'
        || result?.preferredEndpoint === 'responses'
        || result?.preferredEndpoint === 'messages'
        ? result.preferredEndpoint
        : '';
      setForm((prev) => ({
        ...prev,
        protocolMode: 'manual',
        supportedEndpoints: nextSupported,
        preferredEndpoint: nextPreferred,
      }));
      const sourceLabel = result.probeSource === 'cache'
        ? '缓存命中'
        : result.probeSource === 'cooldown_cache'
          ? '冷却缓存'
          : '实时探测';
      toast.success(`已探测协议：${result.preferredEndpoint}，模型 ${result.modelName}（${sourceLabel}）`);
      await load();
    } catch (e: any) {
      toast.error(e.message || '自动探测站点协议失败');
    } finally {
      setProtocolProbing(false);
    }
  };

  const handleSave = async () => {
    if (!editor) return;
    const parsedGlobalWeight = Number(form.globalWeight);
    if (!Number.isFinite(parsedGlobalWeight) || parsedGlobalWeight <= 0) {
      toast.error('全局权重必须是大于 0 的数字');
      return;
    }
    const serializedCustomHeaders = serializeSiteCustomHeaders(form.customHeaders);
    if (!serializedCustomHeaders.valid) {
      toast.error(serializedCustomHeaders.error || '自定义请求头格式不正确');
      return;
    }

    const filteredSupportedEndpoints = form.supportedEndpoints.filter((endpoint) => allowedProtocolEndpointSet.has(endpoint));
    const payload = {
      name: form.name.trim(),
      url: form.url.trim(),
      externalCheckinUrl: form.externalCheckinUrl.trim(),
      platform: form.platform.trim(),
      proxyUrl: form.proxyUrl.trim(),
      useSystemProxy: !!form.useSystemProxy,
      customHeaders: serializedCustomHeaders.customHeaders,
      globalWeight: Number(parsedGlobalWeight.toFixed(3)),
      protocolConfig: {
        mode: form.protocolMode,
        supportedEndpoints: form.protocolMode === 'manual' ? filteredSupportedEndpoints : [],
        preferredEndpoint: (
          form.protocolMode === 'manual'
          && form.preferredEndpoint
          && filteredSupportedEndpoints.includes(form.preferredEndpoint as 'chat' | 'responses' | 'messages')
        )
          ? form.preferredEndpoint as 'chat' | 'responses' | 'messages'
          : null,
      },
    };
    if (!payload.name || !payload.url) {
      toast.error('请填写站点名称和 URL');
      return;
    }
    if (form.protocolMode === 'manual' && filteredSupportedEndpoints.length === 0) {
      toast.error('手动协议模式下至少选择一个上游协议');
      return;
    }

    setSaving(true);
    try {
      const action = buildSiteSaveAction(editor, payload);
      if (action.kind === 'add') {
        const created = await api.addSite(action.payload);
        toast.success(`站点 "${payload.name}" 已添加`);
        const createdSiteId = Number(created?.id) || 0;
        if (createdSiteId > 0) {
          const createdPlatform = typeof created?.platform === 'string' && created.platform.trim()
            ? created.platform.trim()
            : payload.platform;
          const params = new URLSearchParams({
            create: '1',
            siteId: String(createdSiteId),
          });
          if (String(createdPlatform || '').trim().toLowerCase() === 'codex') {
            params.set('provider', 'codex');
            navigate(`/oauth?${params.toString()}`);
            return;
          }
          const initialSegment = resolveInitialConnectionSegment(createdPlatform);
          if (initialSegment === 'apikey') {
            params.set('segment', 'apikey');
          }
          navigate(`/accounts?${params.toString()}`);
        }
      } else {
        await api.updateSite(action.id, action.payload);
        toast.success(`站点 "${payload.name}" 已更新`);
      }
      closeEditor();
      await load();
    } catch (e: any) {
      toast.error(e.message || '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const updateCustomHeaderRow = (index: number, field: 'key' | 'value', value: string) => {
    setForm((prev) => ({
      ...prev,
      customHeaders: prev.customHeaders.map((item, itemIndex) => (
        itemIndex === index
          ? { ...item, [field]: value }
          : item
      )),
    }));
  };

  const addCustomHeaderRow = () => {
    setForm((prev) => ({
      ...prev,
      customHeaders: [...prev.customHeaders, emptySiteCustomHeader()],
    }));
  };

  const removeCustomHeaderRow = (index: number) => {
    setForm((prev) => {
      const nextHeaders = prev.customHeaders.filter((_, itemIndex) => itemIndex !== index);
      return {
        ...prev,
        customHeaders: nextHeaders.length > 0 ? nextHeaders : [emptySiteCustomHeader()],
      };
    });
  };

  const handleDetect = async () => {
    if (!form.url.trim()) {
      toast.error('请先输入 URL');
      return;
    }
    setDetecting(true);
    try {
      const result = await api.detectSite(form.url.trim());
      if (result?.platform) {
        setForm((prev) => ({ ...prev, platform: result.platform }));
        toast.success(`检测到平台: ${result.platform}`);
      } else {
        toast.error(result?.error || '无法识别平台类型');
      }
    } catch (e: any) {
      toast.error(e.message || '自动检测失败');
    } finally {
      setDetecting(false);
    }
  };

  const handleDelete = async (site: SiteRow) => {
    setDeleteConfirm({ mode: 'single', siteId: site.id, siteName: site.name });
  };

  const handleToggleStatus = async (site: SiteRow) => {
    const nextStatus = site.status === 'disabled' ? 'active' : 'disabled';
    setTogglingSiteId(site.id);
    try {
      await api.updateSite(site.id, { status: nextStatus });
      toast.success(nextStatus === 'disabled' ? `站点 "${site.name}" 已禁用` : `站点 "${site.name}" 已启用`);
      await load();
    } catch (e: any) {
      toast.error(e.message || '切换站点状态失败');
    } finally {
      setTogglingSiteId(null);
    }
  };

  const handleTogglePin = async (site: SiteRow) => {
    const nextPinned = !site.isPinned;
    setPinningSiteId(site.id);
    try {
      await api.updateSite(site.id, { isPinned: nextPinned });
      toast.success(nextPinned ? `站点 "${site.name}" 已置顶` : `站点 "${site.name}" 已取消置顶`);
      await load();
    } catch (e: any) {
      toast.error(e.message || '切换置顶失败');
    } finally {
      setPinningSiteId(null);
    }
  };

  const handleMoveCustomOrder = async (site: SiteRow, direction: 'up' | 'down') => {
    const updates = buildCustomReorderUpdates(sites, site.id, direction);
    if (updates.length === 0) return;

    setOrderingSiteId(site.id);
    try {
      await Promise.all(updates.map((update) => api.updateSite(update.id, { sortOrder: update.sortOrder })));
      await load();
    } catch (e: any) {
      toast.error(e.message || '更新排序失败');
    } finally {
      setOrderingSiteId(null);
    }
  };

  const toggleSiteSelection = (siteId: number, checked: boolean) => {
    setSelectedSiteIds((current) => (
      checked
        ? Array.from(new Set([...current, siteId]))
        : current.filter((id) => id !== siteId)
    ));
  };

  const toggleSelectAllVisible = (checked: boolean) => {
    if (!checked) {
      setSelectedSiteIds((current) => current.filter((id) => !sortedSites.some((site) => site.id === id)));
      return;
    }
    setSelectedSiteIds((current) => Array.from(new Set([...current, ...sortedSites.map((site) => site.id)])));
  };

  const toggleSiteDetails = (siteId: number) => {
    setExpandedSiteIds((current) => (
      current.includes(siteId)
        ? current.filter((id) => id !== siteId)
        : [...current, siteId]
    ));
  };

  const runBatchAction = async (action: 'enable' | 'disable' | 'delete' | 'enableSystemProxy' | 'disableSystemProxy', skipDeleteConfirm = false) => {
    if (selectedSiteIds.length === 0) return;
    if (action === 'delete' && !skipDeleteConfirm) {
      setDeleteConfirm({ mode: 'batch', count: selectedSiteIds.length });
      return;
    }

    setBatchActionLoading(true);
    try {
      const result = await api.batchUpdateSites({
        ids: selectedSiteIds,
        action,
      });
      const successIds = Array.isArray(result?.successIds) ? result.successIds.map((id: unknown) => Number(id)) : [];
      const failedItems = Array.isArray(result?.failedItems) ? result.failedItems : [];
      if (failedItems.length > 0) {
        toast.info(`批量操作完成：成功 ${successIds.length}，失败 ${failedItems.length}`);
      } else {
        toast.success(`批量操作完成：成功 ${successIds.length}`);
      }
      setSelectedSiteIds(failedItems.map((item: any) => Number(item.id)).filter((id: number) => Number.isFinite(id) && id > 0));
      await load();
    } catch (e: any) {
      toast.error(e.message || '批量操作失败');
    } finally {
      setBatchActionLoading(false);
    }
  };

  const confirmDelete = async () => {
    const target = deleteConfirm;
    if (!target) return;

    setDeleteConfirm(null);
    if (target.mode === 'single' && target.siteId) {
      setDeleting(target.siteId);
      try {
        await api.deleteSite(target.siteId);
        toast.success(`站点 "${target.siteName || target.siteId}" 已删除`);
        await load();
      } catch (e: any) {
        toast.error(e.message || '删除失败');
      } finally {
        setDeleting(null);
      }
      return;
    }

    await runBatchAction('delete', true);
  };

  const handleSiteRowClick = (siteId: number, event: React.MouseEvent<HTMLTableRowElement>) => {
    if (shouldIgnoreRowSelectionClick(event.target)) return;
    const isSelected = selectedSiteIds.includes(siteId);
    toggleSiteSelection(siteId, !isSelected);
  };

  return (
    <div className="page-shell animate-fade-in">
      <div className="page-hero">
        <div className="page-kicker">Site Registry</div>
        <div className="page-header" style={{ marginBottom: 0 }}>
          <div>
            <h2 className="page-title">{tr('站点管理')}</h2>
            <p className="page-subtitle">
              管理上游站点地址、平台能力、权重、签到入口和代理设置。这里更适合做“站点级别”的健康治理，而不是逐账号排查。
            </p>
          </div>
        <div className="page-actions sites-page-actions">
          {isMobile ? (
            <>
              <button
                type="button"
                onClick={() => setShowMobileTools(true)}
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)' }}
              >
                排序与操作
              </button>
              <button
                type="button"
                data-testid="sites-mobile-select-all"
                onClick={() => toggleSelectAllVisible(!allVisibleSitesSelected)}
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)' }}
              >
                {allVisibleSitesSelected ? '取消全选' : '全选可见项'}
              </button>
            </>
          ) : (
            <div className="sites-sort-select" style={{ minWidth: 156, position: 'relative', zIndex: 20 }}>
              <ModernSelect
                size="sm"
                value={sortMode}
                onChange={(nextValue) => setSortMode(nextValue as SiteSortMode)}
                options={siteSortOptions}
                placeholder="自定义排序"
              />
            </div>
          )}
          <button onClick={openAdd} className="btn btn-primary">
            {isAdding ? '取消' : '+ 添加站点'}
          </button>
        </div>
        </div>
      </div>

      <MobileFilterSheet open={showMobileTools} onClose={() => setShowMobileTools(false)} title="站点排序与操作">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>排序方式</div>
            <ModernSelect
              value={sortMode}
              onChange={(nextValue) => setSortMode(nextValue as SiteSortMode)}
              options={siteSortOptions}
              placeholder="自定义排序"
            />
          </div>
          <button
            type="button"
            onClick={() => {
              toggleSelectAllVisible(!allVisibleSitesSelected);
              setShowMobileTools(false);
            }}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
          >
            {allVisibleSitesSelected ? '取消全选可见项' : '全选可见项'}
          </button>
        </div>
      </MobileFilterSheet>

      {!isMobile && selectedSiteIds.length > 0 && (
        <div className="card" style={{ padding: 12, marginBottom: 12, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>已选 {selectedSiteIds.length} 项</span>
          <button
            data-testid="sites-batch-enable-system-proxy"
            onClick={() => runBatchAction('enableSystemProxy')}
            disabled={batchActionLoading}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
          >
            批量开启系统代理
          </button>
          <button
            onClick={() => runBatchAction('disableSystemProxy')}
            disabled={batchActionLoading}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
          >
            批量关闭系统代理
          </button>
          <button onClick={() => runBatchAction('enable')} disabled={batchActionLoading} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>
            批量启用
          </button>
          <button onClick={() => runBatchAction('disable')} disabled={batchActionLoading} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>
            批量禁用
          </button>
          <button onClick={() => runBatchAction('delete')} disabled={batchActionLoading} className="btn btn-link btn-link-danger">
            批量删除
          </button>
        </div>
      )}

      {isMobile && selectedSiteIds.length > 0 && (
        <MobileBatchBar info={`已选 ${selectedSiteIds.length} 项`}>
            <button
              data-testid="sites-batch-enable-system-proxy"
              onClick={() => runBatchAction('enableSystemProxy')}
              disabled={batchActionLoading}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
            >
              批量开启系统代理
            </button>
            <button
              onClick={() => runBatchAction('disableSystemProxy')}
              disabled={batchActionLoading}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
            >
              批量关闭系统代理
            </button>
            <button onClick={() => runBatchAction('enable')} disabled={batchActionLoading} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>
              批量启用
            </button>
            <button onClick={() => runBatchAction('disable')} disabled={batchActionLoading} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>
              批量禁用
            </button>
            <button onClick={() => runBatchAction('delete')} disabled={batchActionLoading} className="btn btn-link btn-link-danger">
              批量删除
            </button>
        </MobileBatchBar>
      )}

      <div className="info-tip surface-card" style={{ marginBottom: 12 }}>
        站点权重说明：最终站点倍率 = 站点全局权重 × 设置页中下游 API Key 的站点倍率。它会与路由策略因子（基础权重、价值分、成本、余额、使用频次）共同作用。数值越大，该站点在同优先级下越容易被选中。建议范围 0.5-3，默认 1；长期不建议超过 5。
      </div>

      <div className="card surface-card" style={{ marginBottom: 12, padding: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button
            onClick={handleRefreshSiteHealth}
            disabled={!!siteOpsLoading['refresh-site-health']}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
          >
            {siteOpsLoading['refresh-site-health'] ? <><span className="spinner spinner-sm" /> 检测中...</> : '一键检测站点存活'}
          </button>
          <button
            onClick={handleDryRunCleanup}
            disabled={!!siteOpsLoading['dryrun-cleanup']}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)' }}
          >
            {siteOpsLoading['dryrun-cleanup'] ? <><span className="spinner spinner-sm" /> 预检中...</> : '预检可移除站点'}
          </button>
          <button
            onClick={handleCleanupUnreachable}
            disabled={!!siteOpsLoading['cleanup-unreachable']}
            className="btn btn-link btn-link-danger"
          >
            {siteOpsLoading['cleanup-unreachable'] ? <><span className="spinner spinner-sm" /> 移除中...</> : '一键移除失活站点+账号'}
          </button>
        </div>
      </div>

      <DeleteConfirmModal
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={confirmDelete}
        title="确认删除站点"
        confirmText="确认删除"
        loading={batchActionLoading || (deleteConfirm?.mode === 'single' && deleting === deleteConfirm?.siteId)}
        description={deleteConfirm?.mode === 'single'
          ? <>确定要删除站点 <strong>{deleteConfirm.siteName || `#${deleteConfirm.siteId}`}</strong> 吗？</>
          : <>确定要删除选中的 <strong>{deleteConfirm?.count || 0}</strong> 个站点吗？</>}
      />

      {activeEditor && (
        <CenteredModal
          open={Boolean(editor)}
          onClose={closeEditor}
          title={(
            <div style={{ fontSize: 14, fontWeight: 600 }}>
              {isEditing ? '编辑站点' : '添加站点'}
            </div>
          )}
          maxWidth={920}
          bodyStyle={{
            maxHeight: isMobile ? '78vh' : '72vh',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
          footer={(
            <>
              <button onClick={closeEditor} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }}>
                取消
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !form.name.trim() || !form.url.trim()}
                className="btn btn-primary"
              >
                {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : (isEditing ? '保存修改' : '保存站点')}
              </button>
            </>
          )}
        >
          <ResponsiveFormGrid>
            <input
              placeholder="站点名称"
              value={form.name}
              onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
              style={formInputStyle}
            />
            <div style={{ display: 'flex', gap: 8, flexDirection: isMobile ? 'column' : 'row' }}>
              <input
                placeholder="站点 URL (例如 https://api.example.com)"
                value={form.url}
                onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))}
                onBlur={() => {
                  if (form.url.trim() && !form.platform.trim()) {
                    handleDetect();
                  }
                }}
                style={{ ...formInputStyle, flex: 1 }}
              />
              <button
                onClick={handleDetect}
                disabled={detecting || !form.url.trim()}
                className="btn btn-ghost"
                style={{ padding: '10px 14px', minWidth: 96, border: '1px solid var(--color-border)' }}
              >
                {detecting ? <><span className="spinner spinner-sm" /> 检测中</> : '自动检测'}
              </button>
            </div>
            <div
              style={{
                border: `1px solid ${form.platform.trim() ? 'color-mix(in srgb, var(--color-success) 48%, transparent)' : 'var(--color-border)'}`,
                borderRadius: 'var(--radius-sm)',
                background: form.platform.trim() ? 'color-mix(in srgb, var(--color-success) 10%, var(--color-bg))' : 'var(--color-bg)',
                transition: 'border-color 0.2s ease, background-color 0.2s ease',
              }}
            >
              <ModernSelect
                value={form.platform}
                onChange={(value) => setForm((prev) => {
                  const nextAllowed = new Set(getAllowedProtocolEndpointsForPlatform(value));
                  const nextSupported = prev.supportedEndpoints.filter((endpoint) => nextAllowed.has(endpoint));
                  const nextPreferred = prev.preferredEndpoint && nextAllowed.has(prev.preferredEndpoint)
                    ? prev.preferredEndpoint
                    : '';
                  return {
                    ...prev,
                    platform: value,
                    supportedEndpoints: nextSupported,
                    preferredEndpoint: nextPreferred,
                  };
                })}
                options={platformOptions}
                placeholder="平台类型（可自动检测）"
              />
            </div>
            <input
              placeholder="外部签到/福利站点 URL（可选）"
              value={form.externalCheckinUrl}
              onChange={(e) => setForm((prev) => ({ ...prev, externalCheckinUrl: e.target.value }))}
              style={formInputStyle}
            />
          </ResponsiveFormGrid>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: 12,
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'color-mix(in srgb, var(--color-surface) 82%, transparent)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                站点协议
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  仅支持单模型有限探测，不会扫描全站模型
                </div>
                <button
                  type="button"
                  onClick={handleProbeProtocol}
                  disabled={protocolProbing || !isEditing}
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)', minWidth: 132 }}
                >
                  {protocolProbing ? <><span className="spinner spinner-sm" /> 探测中...</> : '自动探测协议'}
                </button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'minmax(160px, 220px) 1fr', gap: 12, alignItems: 'start' }}>
              <div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>模式</div>
                <ModernSelect
                  value={form.protocolMode}
                  onChange={(value) => setForm((prev) => ({
                    ...prev,
                    protocolMode: value === 'manual' ? 'manual' : 'auto',
                    supportedEndpoints: value === 'manual' ? prev.supportedEndpoints : [],
                    preferredEndpoint: value === 'manual' ? prev.preferredEndpoint : '',
                  }))}
                  options={SITE_PROTOCOL_MODE_OPTIONS}
                  placeholder="协议模式"
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>支持的上游协议</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {SITE_PROTOCOL_ENDPOINT_OPTIONS.filter((option) => allowedProtocolEndpointSet.has(option.value)).map((option) => {
                    const checked = form.supportedEndpoints.includes(option.value);
                    const disabled = form.protocolMode !== 'manual';
                    return (
                      <label
                        key={option.value}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '8px 10px',
                          borderRadius: '999px',
                          border: '1px solid var(--color-border)',
                          background: checked ? 'color-mix(in srgb, var(--color-primary) 12%, var(--color-bg))' : 'var(--color-bg)',
                          color: disabled ? 'var(--color-text-muted)' : 'var(--color-text-primary)',
                          cursor: disabled ? 'not-allowed' : 'pointer',
                        }}
                      >
                        <input
                          data-testid={`site-protocol-endpoint-${option.value}`}
                          type="checkbox"
                          checked={checked}
                          disabled={disabled}
                          onChange={(e) => {
                            const nextChecked = e.target.checked;
                            setForm((prev) => {
                              const nextSupported = nextChecked
                                ? Array.from(new Set([...prev.supportedEndpoints, option.value]))
                                : prev.supportedEndpoints.filter((endpoint) => endpoint !== option.value);
                              const nextPreferred = nextSupported.includes(prev.preferredEndpoint as any)
                                ? prev.preferredEndpoint
                                : '';
                              return {
                                ...prev,
                                supportedEndpoints: nextSupported,
                                preferredEndpoint: nextPreferred,
                              };
                            });
                          }}
                        />
                        <span style={{ fontSize: 12 }}>{option.label}</span>
                      </label>
                    );
                  })}
                </div>
                <div style={{ maxWidth: 260 }}>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>首选协议</div>
                  <ModernSelect
                    value={form.preferredEndpoint}
                    onChange={(value) => setForm((prev) => ({
                      ...prev,
                      preferredEndpoint: value === 'chat' || value === 'responses' || value === 'messages'
                        ? value
                        : '',
                    }))}
                    options={[
                      { value: '', label: '不指定，由顺序决定' },
                      ...SITE_PROTOCOL_ENDPOINT_OPTIONS
                        .filter((option) => allowedProtocolEndpointSet.has(option.value) && form.supportedEndpoints.includes(option.value))
                        .map((option) => ({ value: option.value, label: option.label })),
                    ]}
                    placeholder="首选协议"
                  />
                </div>
              </div>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
              自动模式下，系统只根据真实成功/失败被动学习，不会主动扫站点全部模型。点击“自动探测协议”时，也只会拿该站点一个已知可用模型做有限协议尝试。手动模式下，路由会优先限制在你勾选的协议范围内，再结合实时失败记忆与被动画像排序。
            </div>
            {lastProbeResult ? (
              <div
                style={{
                  display: 'grid',
                  gap: 8,
                  padding: 10,
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--color-border-light)',
                  background: 'color-mix(in srgb, var(--color-primary) 4%, var(--color-bg))',
                }}
              >
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                  <span className="badge badge-info" style={{ fontSize: 11 }}>
                    {lastProbeResult.probeSource === 'cache'
                      ? '缓存命中'
                      : lastProbeResult.probeSource === 'cooldown_cache'
                        ? '冷却缓存'
                        : '实时探测'}
                  </span>
                  <span style={{ fontSize: 12 }}>模型 {lastProbeResult.modelName}</span>
                  <span style={{ fontSize: 12 }}>首选 {lastProbeResult.preferredEndpoint}</span>
                  {typeof lastProbeResult.cooldownRemainingMs === 'number' && lastProbeResult.cooldownRemainingMs > 0 ? (
                    <span style={{ fontSize: 12, color: 'var(--color-warning)' }}>
                      冷却剩余 {Math.max(1, Math.ceil(lastProbeResult.cooldownRemainingMs / 1000))} 秒
                    </span>
                  ) : null}
                </div>
                {Array.isArray(lastProbeResult.attemptSummary) && lastProbeResult.attemptSummary.length > 0 ? (
                  <div style={{ display: 'grid', gap: 4 }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>最近探测摘要</div>
                    <div style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--color-text-secondary)' }}>
                      {lastProbeResult.attemptSummary.join(' ｜ ')}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: 12,
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'color-mix(in srgb, var(--color-surface) 82%, transparent)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                站点自定义请求头
              </div>
              <button
                type="button"
                onClick={addCustomHeaderRow}
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)' }}
              >
                + 添加请求头
              </button>
            </div>
            {form.customHeaders.map((header, index) => (
              <div
                key={`custom-header-${index}`}
                style={{
                  display: 'flex',
                  gap: 8,
                  flexDirection: isMobile ? 'column' : 'row',
                  alignItems: isMobile ? 'stretch' : 'center',
                }}
              >
                <input
                  placeholder="Header 名称"
                  value={header.key}
                  onChange={(e) => updateCustomHeaderRow(index, 'key', e.target.value)}
                  style={{ ...formInputStyle, flex: 1, fontFamily: 'var(--font-mono)' }}
                />
                <input
                  placeholder="Header 值"
                  value={header.value}
                  onChange={(e) => updateCustomHeaderRow(index, 'value', e.target.value)}
                  style={{ ...formInputStyle, flex: 1, fontFamily: 'var(--font-mono)' }}
                />
                <button
                  type="button"
                  onClick={() => removeCustomHeaderRow(index)}
                  className="btn btn-link btn-link-danger"
                  style={isMobile ? { alignSelf: 'flex-end' } : undefined}
                >
                  删除
                </button>
              </div>
            ))}
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>
              按 key/value 逐条填写。整行留空会自动忽略；同名请求头不允许重复；请求本身显式传入的请求头优先级更高。
            </div>
            {isEditing && (
              <div style={{ marginTop: 16, padding: '14px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-bg)' }}>
                <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>禁用模型管理</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>
                  在此站点禁用指定模型后，路由重建时将不为该站点的这些模型创建通道。
                </div>
                {disabledModelsLoading ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-muted)' }}>
                    <span className="spinner spinner-sm" /> 加载中...
                  </div>
                ) : (
                  <>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, minHeight: 24 }}>
                      {disabledModels.length === 0 && (
                        <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>暂无禁用模型</span>
                      )}
                      {disabledModels.map((model) => (
                        <span
                          key={model}
                          className="badge badge-muted"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '3px 8px' }}
                        >
                          {model}
                          <button
                            type="button"
                            onClick={() => handleRemoveDisabledModel(model)}
                            style={{
                              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
                              fontSize: 13, lineHeight: 1, color: 'var(--color-text-muted)',
                            }}
                            title={`移除 ${model}`}
                          >
                            ×
                          </button>
                        </span>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <input
                        placeholder="输入模型名称，如 gpt-4o"
                        value={disabledModelInput}
                        onChange={(e) => setDisabledModelInput(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAddDisabledModel(); } }}
                        style={{
                          flex: 1, padding: '8px 12px', border: '1px solid var(--color-border)',
                          borderRadius: 'var(--radius-sm)', fontSize: 12, outline: 'none',
                          background: 'var(--color-bg)', color: 'var(--color-text-primary)',
                        }}
                      />
                      <button onClick={handleAddDisabledModel} className="btn btn-ghost" style={{ padding: '8px 14px', fontSize: 12, border: '1px solid var(--color-border)' }}>
                        添加
                      </button>
                    </div>
                    <button
                      onClick={handleSaveDisabledModels}
                      disabled={disabledModelsSaving}
                      className="btn btn-primary"
                      style={{ marginTop: 10, fontSize: 12, padding: '6px 16px' }}
                    >
                      {disabledModelsSaving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} /> 保存中...</> : '保存禁用列表'}
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <ResponsiveFormGrid>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input
                placeholder="站点代理（可选，如 http://127.0.0.1:7890 或 socks5://127.0.0.1:1080）"
                value={form.proxyUrl}
                onChange={(e) => setForm((prev) => ({ ...prev, proxyUrl: e.target.value }))}
                style={formInputStyle}
              />
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                填写后优先使用站点代理；留空则使用系统代理或直连(取决于设置开关状态)。
              </div>
            </div>
            <label style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 14px',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 13,
              background: 'var(--color-bg)',
              color: 'var(--color-text-primary)',
            }}>
              <input
                type="checkbox"
                checked={form.useSystemProxy}
                onChange={(e) => setForm((prev) => ({ ...prev, useSystemProxy: e.target.checked }))}
              />
              使用系统代理
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input
                placeholder="站点全局权重（默认 1）"
                value={form.globalWeight}
                onChange={(e) => setForm((prev) => ({ ...prev, globalWeight: e.target.value }))}
                style={formInputStyle}
              />
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                越大越容易被路由选中。建议 0.5-3，默认 1。
              </div>
            </div>
          </ResponsiveFormGrid>
        </CenteredModal>
      )}

      <div className="card" style={{ overflowX: 'auto' }}>
        {sites.length > 0 ? (
          isMobile ? (
            <div className="mobile-card-list">
              {sortedSites.map((site) => {
                const isExpanded = expandedSiteIds.includes(site.id);
                return (
                  <MobileCard
                    key={site.id}
                    title={(
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <span>{site.name || '-'}</span>
                        {site.url ? (
                          <a
                            href={site.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="sites-url-link"
                            style={{
                              fontSize: 12,
                              fontFamily: 'var(--font-mono)',
                              color: 'var(--color-primary)',
                              textDecoration: 'underline',
                              wordBreak: 'break-all',
                            }}
                          >
                            {site.url}
                          </a>
                        ) : null}
                      </div>
                    )}
                    headerActions={(
                      <input
                        type="checkbox"
                        aria-label={`选择站点 ${site.name || site.id}`}
                        checked={selectedSiteIds.includes(site.id)}
                        onChange={(event) => toggleSiteSelection(site.id, event.target.checked)}
                      />
                    )}
                    footerActions={(
                      <>
                        <button
                          type="button"
                          onClick={() => toggleSiteDetails(site.id)}
                          className="btn btn-link"
                        >
                          {isExpanded ? '收起' : '详情'}
                        </button>
                        <button
                          onClick={() => openEdit(site)}
                          className="btn btn-link btn-link-primary"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => navigate(buildDiagnosticPath('site', site.id))}
                          className="btn btn-link btn-link-info"
                          data-testid={`site-diagnostics-${site.id}`}
                        >
                          诊断
                        </button>
                        <button
                          onClick={() => handleToggleStatus(site)}
                          disabled={togglingSiteId === site.id}
                          className={`btn btn-link ${site.status === 'disabled' ? 'btn-link-primary' : 'btn-link-warning'}`}
                        >
                          {togglingSiteId === site.id ? <span className="spinner spinner-sm" /> : (site.status === 'disabled' ? '启用' : '禁用')}
                        </button>
                      </>
                    )}
                  >
                    <MobileField
                      label="状态"
                      value={(
                        <span className={`badge ${site.status === 'disabled' ? 'badge-muted' : 'badge-success'}`} style={{ fontSize: 11 }}>
                          {site.status === 'disabled' ? '禁用' : '启用'}
                        </span>
                      )}
                    />
                    <MobileField label="可达状态" value={renderSiteReachability(site)} stacked />
                    <MobileField label="自动签到" value={renderSiteAutoCheckin(site)} stacked />
                    <MobileField
                      label="平台"
                      value={(
                        <span className={`badge ${platformColors[site.platform || ''] || 'badge-muted'}`} style={{ fontSize: 11 }}>
                          {site.platform || '-'}
                        </span>
                      )}
                    />
                    <MobileField
                      label="站点协议"
                      value={buildSiteProtocolSummary(site)}
                    />
                    <MobileField
                      label="余额"
                      value={(
                        <SiteBalanceDisplay
                          balance={site.totalBalance}
                          summary={site.subscriptionSummary}
                          align="end"
                        />
                      )}
                    />
                    <MobileField label="权重" value={(site.globalWeight || 1).toFixed(2)} />
                    {isExpanded ? (
                      <div className="mobile-card-extra">
                        <MobileField
                          label="主站点 URL"
                          stacked
                          value={site.url ? (
                            <a
                              href={site.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="sites-url-link"
                              style={{
                                fontSize: 12,
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--color-primary)',
                                textDecoration: 'underline',
                                wordBreak: 'break-all',
                              }}
                            >
                              {site.url}
                            </a>
                          ) : '-'}
                        />
                        <MobileField
                          label="系统代理"
                          value={(
                            <span className={`badge ${site.useSystemProxy ? 'badge-info' : 'badge-muted'}`} style={{ fontSize: 11 }}>
                              {site.useSystemProxy ? '已开启' : '未开启'}
                            </span>
                          )}
                        />
                        <MobileField
                          label="外部签到站URL"
                          value={site.externalCheckinUrl ? (
                            <a
                              href={site.externalCheckinUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="sites-url-link"
                              style={{
                                fontSize: 12,
                                fontFamily: 'var(--font-mono)',
                                color: 'var(--color-primary)',
                                textDecoration: 'underline',
                                wordBreak: 'break-all',
                              }}
                            >
                              {site.externalCheckinUrl}
                            </a>
                          ) : '-'}
                        />
                        <MobileField
                          label="自定义头"
                          value={hasConfiguredCustomHeaders(site.customHeaders) ? '已配置' : '-'}
                        />
                        <MobileField
                          label="创建时间"
                          value={formatDateTimeLocal(site.createdAt)}
                        />
                        <div className="mobile-card-actions">
                          <button
                            onClick={() => handleTogglePin(site)}
                            disabled={pinningSiteId === site.id}
                            className={`btn btn-link ${site.isPinned ? 'btn-link-warning' : 'btn-link-primary'}`}
                          >
                            {pinningSiteId === site.id ? <span className="spinner spinner-sm" /> : (site.isPinned ? '取消置顶' : '置顶')}
                          </button>
                          {sortMode === 'custom' && (
                            <>
                              <button
                                onClick={() => handleMoveCustomOrder(site, 'up')}
                                disabled={orderingSiteId === site.id}
                                className="btn btn-link btn-link-muted"
                              >
                                ↑ 上移
                              </button>
                              <button
                                onClick={() => handleMoveCustomOrder(site, 'down')}
                                disabled={orderingSiteId === site.id}
                                className="btn btn-link btn-link-muted"
                              >
                                ↓ 下移
                              </button>
                            </>
                          )}
                          <button
                            onClick={() => handleDelete(site)}
                            disabled={deleting === site.id}
                            className="btn btn-link btn-link-danger"
                          >
                            {deleting === site.id ? <span className="spinner spinner-sm" /> : null}
                            删除
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </MobileCard>
                );
              })}
            </div>
          ) : (
            <table className="data-table sites-table">
              <thead>
                <tr>
                  <th style={{ width: 44 }}>
                    <input
                      type="checkbox"
                      checked={allVisibleSitesSelected}
                      onChange={(e) => toggleSelectAllVisible(e.target.checked)}
                    />
                  </th>
                  <th>名称</th>
                  <th>外部签到站URL</th>
                  <th
                    onClick={() => toggleSiteHeaderSort('balance')}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    data-testid="sites-sort-balance"
                  >
                    总余额 {getSiteHeaderSortMeta('balance').active ? (getSiteHeaderSortMeta('balance').direction === 'desc' ? '↓' : '↑') : ''}
                  </th>
                  <th>状态</th>
                  <th
                    onClick={() => toggleSiteHeaderSort('reachability')}
                    style={{ cursor: 'pointer', userSelect: 'none' }}
                    data-testid="sites-sort-reachability"
                  >
                    可达状态 {getSiteHeaderSortMeta('reachability').active ? (getSiteHeaderSortMeta('reachability').direction === 'desc' ? '↓' : '↑') : ''}
                  </th>
                  <th>自动签到</th>
                  <th>系统代理</th>
                  <th>权重</th>
                  <th>平台</th>
                  <th>站点协议</th>
                  <th>创建时间</th>
                  <th className="sites-actions-col" style={{ textAlign: 'right' }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {sortedSites.map((site, i) => (
                  <tr
                    key={site.id}
                    data-testid={`site-row-${site.id}`}
                    ref={(node) => {
                      if (node) rowRefs.current.set(site.id, node);
                      else rowRefs.current.delete(site.id);
                    }}
                    onClick={(event) => handleSiteRowClick(site.id, event)}
                    className={`row-selectable ${selectedSiteIds.includes(site.id) ? 'row-selected' : ''} ${highlightSiteId === site.id ? 'row-focus-highlight' : ''}`.trim()}
                  >
                    <td>
                      <input
                        data-testid={`site-select-${site.id}`}
                        type="checkbox"
                        checked={selectedSiteIds.includes(site.id)}
                        onChange={(e) => toggleSiteSelection(site.id, e.target.checked)}
                      />
                    </td>
                    <td style={{ fontWeight: 600 }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                        <a
                          href={site.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{
                            color: 'var(--color-text-primary)',
                            textDecoration: 'underline',
                          }}
                        >
                          {site.name}
                        </a>
                        {hasConfiguredCustomHeaders(site.customHeaders) ? (
                          <span className="badge badge-info" style={{ fontSize: 11 }}>
                            自定义头
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="sites-url-cell" style={{ maxWidth: 300 }}>
                      {site.externalCheckinUrl ? (
                        <a
                          href={site.externalCheckinUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="sites-url-link"
                          style={{
                            fontSize: 12,
                            fontFamily: 'var(--font-mono)',
                            color: 'var(--color-primary)',
                            textDecoration: 'underline',
                            wordBreak: 'break-all',
                          }}
                        >
                          {site.externalCheckinUrl}
                        </a>
                      ) : null}
                    </td>
                    <td className="site-balance-cell">
                      <SiteBalanceDisplay
                        balance={site.totalBalance}
                        summary={site.subscriptionSummary}
                      />
                    </td>
                    <td>
                      <span className={`badge ${site.status === 'disabled' ? 'badge-muted' : 'badge-success'}`} style={{ fontSize: 11 }}>
                        {site.status === 'disabled' ? '禁用' : '启用'}
                      </span>
                    </td>
                    <td>{renderSiteReachability(site)}</td>
                    <td>{renderSiteAutoCheckin(site)}</td>
                    <td>
                      <span className={`badge ${site.useSystemProxy ? 'badge-info' : 'badge-muted'}`} style={{ fontSize: 11 }}>
                        {site.useSystemProxy ? '已开启' : '未开启'}
                      </span>
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                      {(site.globalWeight || 1).toFixed(2)}
                    </td>
                    <td>
                      <a
                        href={site.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ textDecoration: 'none' }}
                      >
                        <span className={`badge ${platformColors[site.platform || ''] || 'badge-muted'}`}>
                          {site.platform || '-'}
                        </span>
                      </a>
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                      {buildSiteProtocolSummary(site)}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                      <a
                        href={site.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--color-text-muted)', textDecoration: 'underline' }}
                      >
                        {formatDateTimeLocal(site.createdAt)}
                      </a>
                    </td>
                    <td className="sites-actions-cell" style={{ textAlign: 'right' }}>
                      <div className="sites-row-actions">
                        <button
                          onClick={() => handleTogglePin(site)}
                          disabled={pinningSiteId === site.id}
                          className={`btn btn-link ${site.isPinned ? 'btn-link-warning' : 'btn-link-primary'}`}
                        >
                          {pinningSiteId === site.id ? <span className="spinner spinner-sm" /> : (site.isPinned ? '取消置顶' : '置顶')}
                        </button>
                        {sortMode === 'custom' && (
                          <>
                            <button
                              onClick={() => handleMoveCustomOrder(site, 'up')}
                              disabled={orderingSiteId === site.id}
                              className="btn btn-link btn-link-muted"
                            >
                              ↑
                            </button>
                            <button
                              onClick={() => handleMoveCustomOrder(site, 'down')}
                              disabled={orderingSiteId === site.id}
                              className="btn btn-link btn-link-muted"
                            >
                              ↓
                            </button>
                          </>
                        )}
                        <button
                          onClick={() => openEdit(site)}
                          className="btn btn-link btn-link-primary"
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          onClick={() => navigate(buildDiagnosticPath('site', site.id))}
                          className="btn btn-link btn-link-info"
                          data-testid={`site-diagnostics-${site.id}`}
                        >
                          诊断
                        </button>
                        <button
                          onClick={() => handleToggleStatus(site)}
                          disabled={togglingSiteId === site.id}
                          className={`btn btn-link ${site.status === 'disabled' ? 'btn-link-primary' : 'btn-link-warning'}`}
                        >
                          {togglingSiteId === site.id ? <span className="spinner spinner-sm" /> : (site.status === 'disabled' ? '启用' : '禁用')}
                        </button>
                        <button
                          onClick={() => handleDelete(site)}
                          disabled={deleting === site.id}
                          className="btn btn-link btn-link-danger"
                        >
                          {deleting === site.id ? <span className="spinner spinner-sm" /> : null}
                          删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9"
              />
            </svg>
            <div className="empty-state-title">暂无站点</div>
            <div className="empty-state-desc">点击“+ 添加站点”开始使用。</div>
          </div>
        )}
      </div>
    </div>
  );
}
