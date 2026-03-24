import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { api } from '../api.js';
import { BrandGlyph, getBrand, hashColor, BrandIcon, type BrandInfo } from '../components/BrandIcon.js';
import SiteBadgeLink from '../components/SiteBadgeLink.js';
import { useToast } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import MobileFilterSheet from '../components/MobileFilterSheet.js';
import { useAnimatedVisibility } from '../components/useAnimatedVisibility.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { mergeMarketplaceMetadata, shouldHydrateMarketplaceMetadata } from './helpers/modelsMarketplaceMetadata.js';
import { tr } from '../i18n.js';

type SortColumn = 'name' | 'accountCount' | 'tokenCount' | 'avgLatency' | 'successRate' | 'balance';
type ViewMode = 'card' | 'table';
type AccountDetailSortColumn = 'site' | 'username' | 'latency' | 'balance';

interface ModelTokenInfo {
  id: number;
  name: string;
  isDefault: boolean;
}

interface ModelGroupPricing {
  quotaType: number;
  inputPerMillion?: number;
  outputPerMillion?: number;
  perCallInput?: number;
  perCallOutput?: number;
  perCallTotal?: number;
}

interface ModelPricingSource {
  siteId: number;
  siteName: string;
  accountId: number;
  username: string | null;
  ownerBy: string | null;
  enableGroups: string[];
  groupPricing: Record<string, ModelGroupPricing>;
}

interface ModelAccountInfo {
  id: number;
  site: string;
  username: string | null;
  latency: number | null;
  balance: number;
  tokens: ModelTokenInfo[];
}

interface ModelRow {
  name: string;
  accountCount: number;
  tokenCount: number;
  avgLatency: number | null;
  successRate: number | null;
  balance: number;
  description: string | null;
  tags: string[];
  supportedEndpointTypes: string[];
  pricingSources: ModelPricingSource[];
  accounts: ModelAccountInfo[];
}

interface ModelsMarketplaceResponse {
  models: ModelRow[];
  meta?: {
    refreshRequested?: boolean;
    refreshQueued?: boolean;
    refreshReused?: boolean;
    refreshRunning?: boolean;
    refreshJobId?: string | null;
  };
}

type AvailabilityCheckState = {
  status: 'available' | 'unavailable' | 'error';
  message: string;
  detail?: string | null;
  latencyMs?: number;
  probeEndpoint?: string | null;
  probeClassification?: string | null;
  autoKeyCreated?: boolean;
  autoKeyName?: string | null;
  autoKeyGroup?: string | null;
};

function isKnownLatency(latency: number | null | undefined): latency is number {
  return typeof latency === 'number' && Number.isFinite(latency);
}

function getMetricColor(latency: number | null) {
  if (!isKnownLatency(latency)) return 'var(--color-text-muted)';
  if (latency >= 3000) return 'var(--color-danger)';
  if (latency >= 2000) return 'color-mix(in srgb, var(--color-warning) 30%, var(--color-danger))';
  if (latency >= 1500) return 'color-mix(in srgb, var(--color-warning) 60%, var(--color-danger))';
  if (latency >= 1000) return 'var(--color-warning)';
  if (latency > 500) return 'color-mix(in srgb, var(--color-success) 60%, var(--color-warning))';
  return 'var(--color-success)';
}

function getLatencyBadgeClass(latency: number | null) {
  if (!isKnownLatency(latency)) return 'badge-muted';
  if (latency >= 3000) return 'badge-error';
  if (latency >= 1000) return 'badge-warning';
  return 'badge-success';
}

function formatLatency(latency: number | null): string {
  return isKnownLatency(latency) ? `${latency}ms` : '—';
}

function getSuccessBadgeClass(rate: number | null) {
  if (rate == null) return 'badge-muted';
  if (rate >= 90) return 'badge-success';
  if (rate >= 60) return 'badge-warning';
  return 'badge-error';
}

function resolveMarketplaceDescription(model: ModelRow, metadataHydrating: boolean): string {
  if (model.description && model.description.trim().length > 0) return model.description;
  if (metadataHydrating) return tr('正在加载模型元数据...');

  const hasOtherMetadata = model.tags.length > 0 || model.supportedEndpointTypes.length > 0 || model.pricingSources.length > 0;
  if (hasOtherMetadata) return tr('上游未提供描述文本，但已同步标签、能力或价格信息。');
  return tr('当前上游仅返回模型 ID，未返回描述字段。');
}

function renderGroupPricingValue(pricing: ModelGroupPricing): string {
  if (pricing.quotaType === 0) {
    return `${pricing.inputPerMillion ?? 0}/${pricing.outputPerMillion ?? 0} USD / 1M`;
  }

  if (pricing.perCallInput != null || pricing.perCallOutput != null) {
    return `${pricing.perCallInput ?? 0}/${pricing.perCallOutput ?? 0} USD / call`;
  }

  return `${pricing.perCallTotal ?? 0} USD / call`;
}

function summarizeAvailabilityMessage(input: {
  available: boolean;
  reason?: string | null;
  probeClassification?: string | null;
  probeEndpoint?: string | null;
}): string {
  if (input.available) return '模型可用';

  const endpointLabel = input.probeEndpoint ? `（${humanizeProbeEndpoint(input.probeEndpoint)}）` : '';
  if (input.probeClassification === 'credential') {
    return `当前凭证无权访问该模型${endpointLabel}`;
  }
  if (input.probeClassification === 'protocol_mismatch') {
    return `该站点可能需要不同的请求方式${endpointLabel}`;
  }
  if (input.probeClassification === 'model_unavailable') {
    return `上游已拒绝该模型${endpointLabel}`;
  }
  const reason = String(input.reason || '').trim();
  if (!reason) return '暂未确认该模型可用性';
  if (reason.includes('模型已出现在上游列表中')) return '模型已出现在上游列表中';
  if (reason.includes('实时探测成功')) return '实时探测成功';
  return reason;
}

function humanizeProbeEndpoint(endpoint: string | null | undefined): string {
  const normalized = String(endpoint || '').trim().toLowerCase();
  if (normalized === 'chat') return 'OpenAI Chat';
  if (normalized === 'responses') return 'OpenAI Responses';
  if (normalized === 'messages') return 'Claude Messages';
  if (normalized === 'gemini-native') return 'Gemini 原生协议';
  return String(endpoint || '').trim();
}

function buildAvailabilitySuggestion(input: {
  probeClassification?: string | null;
  probeEndpoint?: string | null;
}): string | null {
  if (input.probeClassification === 'credential') {
    return '建议动作：更换可访问该模型的 API Key，或检查当前 Key 的模型权限/分组。';
  }
  if (input.probeClassification === 'protocol_mismatch') {
    const endpoint = humanizeProbeEndpoint(input.probeEndpoint);
    return endpoint
      ? `建议动作：检查该站点是否应使用 ${endpoint}，并确认对应请求头与密钥格式。`
      : '建议动作：检查该站点实际支持的协议、请求头和密钥格式。';
  }
  if (input.probeClassification === 'model_unavailable') {
    return '建议动作：确认模型名称、模型别名和站点分组权限是否正确。';
  }
  return null;
}

function buildAvailabilityDetail(input: {
  reason?: string | null;
  probeEndpoint?: string | null;
  probeClassification?: string | null;
  autoKeyCreated?: boolean;
  autoKeyName?: string | null;
  autoKeyGroup?: string | null;
}): string | null {
  const parts: string[] = [];
  if (input.probeClassification) {
    const labelMap: Record<string, string> = {
      supported: '探测结果：已支持',
      model_unavailable: '探测结果：模型不可用',
      credential: '探测结果：凭证权限不足',
      protocol_mismatch: '探测结果：请求协议可能不匹配',
      inconclusive: '探测结果：暂未确认',
    };
    parts.push(labelMap[input.probeClassification] || `探测结果：${input.probeClassification}`);
  }
  if (input.probeEndpoint) parts.push(`探测方式：${humanizeProbeEndpoint(input.probeEndpoint)}`);
  if (input.autoKeyCreated) {
    const autoKeyParts = ['已自动补 Key'];
    if (input.autoKeyName) autoKeyParts.push(`名称 ${input.autoKeyName}`);
    if (input.autoKeyGroup) autoKeyParts.push(`分组 ${input.autoKeyGroup}`);
    parts.push(autoKeyParts.join('，'));
  }
  const reason = String(input.reason || '').trim();
  if (reason) parts.push(`原始原因：${reason}`);
  const suggestion = buildAvailabilitySuggestion(input);
  if (suggestion) parts.push(suggestion);
  return parts.length > 0 ? parts.join('；') : null;
}

const PAGE_SIZES = [10, 20, 50];

function compareModels(a: ModelRow, b: ModelRow, sortBy: SortColumn, sortDir: 'asc' | 'desc'): number {
  if (sortBy === 'name') {
    const cmp = a.name.localeCompare(b.name);
    return sortDir === 'asc' ? cmp : -cmp;
  }

  const resolveNumericSortValue = (model: ModelRow) => {
    if (sortBy === 'successRate') return model.successRate ?? -1;
    if (sortBy === 'avgLatency') {
      if (!isKnownLatency(model.avgLatency)) {
        return sortDir === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
      }
      return model.avgLatency;
    }
    return model[sortBy] ?? 0;
  };

  const va = resolveNumericSortValue(a);
  const vb = resolveNumericSortValue(b);
  if (va === vb) return a.name.localeCompare(b.name);
  return sortDir === 'desc' ? vb - va : va - vb;
}

/* ---- component ---- */
export default function Models() {
  const toast = useToast();
  const [data, setData] = useState<ModelsMarketplaceResponse>({ models: [] });
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortColumn>('accountCount');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [activeSite, setActiveSite] = useState<string | null>(null);
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('card');
  const [accountDetailSortBy, setAccountDetailSortBy] = useState<AccountDetailSortColumn>('latency');
  const [accountDetailSortDir, setAccountDetailSortDir] = useState<'asc' | 'desc'>('asc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [copied, setCopied] = useState<string | null>(null);
  const [filterCollapsed, setFilterCollapsed] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [metadataHydrating, setMetadataHydrating] = useState(false);
  const [availabilityTesting, setAvailabilityTesting] = useState<Record<string, boolean>>({});
  const [availabilityChecks, setAvailabilityChecks] = useState<Record<string, AvailabilityCheckState>>({});
  const [expandedCheckDetails, setExpandedCheckDetails] = useState<Record<string, boolean>>({});
  const isMobile = useIsMobile();
  const filterPanelPresence = useAnimatedVisibility(!isMobile && !filterCollapsed, 220);
  const latestPrimaryRequestRef = useRef(0);
  const latestMetadataRequestRef = useRef(0);
  const location = useLocation();
  const siteIdByName = useMemo(() => {
    const index = new Map<string, number>();
    for (const model of data.models) {
      for (const source of model.pricingSources || []) {
        const siteName = String(source.siteName || '').trim();
        const siteId = Number(source.siteId);
        if (!siteName || !Number.isFinite(siteId) || siteId <= 0 || index.has(siteName)) continue;
        index.set(siteName, Math.trunc(siteId));
      }
    }
    return index;
  }, [data.models]);

  const loadBaseMarketplace = useCallback(async (refresh = false) => {
    const requestId = ++latestPrimaryRequestRef.current;
    latestMetadataRequestRef.current += 1;
    setMetadataHydrating(false);
    setLoading(true);
    try {
      const res = await api.getModelsMarketplace({
        refresh,
        includePricing: false,
      });
      if (requestId !== latestPrimaryRequestRef.current) return null;
      const next = res as ModelsMarketplaceResponse;
      setData(next);
      if (refresh && next.meta?.refreshRequested) {
        if (next.meta.refreshReused) {
          toast.info(tr('模型广场刷新进行中'));
        } else if (next.meta.refreshQueued) {
          toast.info(tr('已开始刷新模型广场'));
        }
      }
      return next;
    } catch {
      if (requestId !== latestPrimaryRequestRef.current) return null;
      setData({ models: [] });
      return null;
    } finally {
      if (requestId === latestPrimaryRequestRef.current) {
        setLoading(false);
      }
    }
  }, [toast]);

  const hydrateMarketplaceMetadata = useCallback(async (baseModels: ModelRow[]) => {
    if (!shouldHydrateMarketplaceMetadata(baseModels)) return;

    const metadataRequestId = ++latestMetadataRequestRef.current;
    const baseRequestId = latestPrimaryRequestRef.current;
    setMetadataHydrating(true);
    try {
      const res = await api.getModelsMarketplace({
        includePricing: true,
      });
      if (metadataRequestId !== latestMetadataRequestRef.current) return;
      if (baseRequestId !== latestPrimaryRequestRef.current) return;

      const detailed = res as ModelsMarketplaceResponse;
      setData((current) => ({
        ...current,
        models: mergeMarketplaceMetadata(current.models, detailed.models),
        meta: detailed.meta ?? current.meta,
      }));
    } catch {
      // Keep the fast base list when metadata fetch fails.
    } finally {
      if (metadataRequestId === latestMetadataRequestRef.current) {
        setMetadataHydrating(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!isMobile) return;
    if (viewMode !== 'card') {
      setViewMode('card');
    }
    if (!filterCollapsed) {
      setFilterCollapsed(true);
    }
  }, [filterCollapsed, isMobile, viewMode]);

  useEffect(() => {
    let cancelled = false;
    let metadataTimer: ReturnType<typeof setTimeout> | null = null;
    const bootstrap = async () => {
      const initial = await loadBaseMarketplace(false);
      if (!initial || cancelled) return;
      metadataTimer = setTimeout(() => {
        if (!cancelled) {
          void hydrateMarketplaceMetadata(initial.models);
        }
      }, 1200);
    };
    void bootstrap();
    return () => {
      cancelled = true;
      if (metadataTimer) clearTimeout(metadataTimer);
      latestMetadataRequestRef.current += 1;
    };
  }, [hydrateMarketplaceMetadata, loadBaseMarketplace]);

  const handleRefresh = useCallback(() => {
    void (async () => {
      const refreshed = await loadBaseMarketplace(true);
      if (!refreshed) return;
      setTimeout(() => {
        void hydrateMarketplaceMetadata(refreshed.models);
      }, 600);
    })();
  }, [hydrateMarketplaceMetadata, loadBaseMarketplace]);

  useEffect(() => {
    const q = new URLSearchParams(location.search).get('q') || '';
    setSearch(q);
  }, [location.search]);

  /* ---- derived: brand list ---- */
  const brandList = useMemo(() => {
    const m = new Map<string, { count: number; brand: BrandInfo }>();
    let otherCount = 0;
    for (const model of data.models) {
      const brand = getBrand(model.name);
      if (brand) {
        const existing = m.get(brand.name);
        if (existing) existing.count++;
        else m.set(brand.name, { count: 1, brand });
      } else {
        otherCount++;
      }
    }
    const list = [...m.entries()].sort((a, b) => b[1].count - a[1].count);
    return { list, otherCount };
  }, [data.models]);

  /* ---- derived: site list ---- */
  const siteMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const model of data.models) {
      for (const a of model.accounts) {
        m.set(a.site, (m.get(a.site) || 0) + 1);
      }
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data.models]);

  /* ---- filtered ---- */
  const filteredModels = useMemo(() => {
    let list = data.models;

    if (activeBrand) {
      if (activeBrand === '__other__') {
        list = list.filter(m => !getBrand(m.name));
      } else {
        list = list.filter(m => getBrand(m.name)?.name === activeBrand);
      }
    }

    if (activeSite) {
      list = list.filter(m => m.accounts.some(a => a.site === activeSite));
    }

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(m => m.name.toLowerCase().includes(q));
    }

    return list;
  }, [data.models, search, activeSite, activeBrand]);

  // Keep expanded detail consistent with filters (especially site filter).
  // The list-level filter uses "model has at least one account on this site" semantics;
  // once a model is shown, its detail should honor the active site as well.
  const detailModels = useMemo(() => {
    const scopedModels = filteredModels.map((model) => {
      const accounts = activeSite
        ? model.accounts.filter((account) => account.site === activeSite)
        : model.accounts;
      const pricingSources = activeSite
        ? model.pricingSources.filter((source) => source.siteName === activeSite)
        : model.pricingSources;
      const latencyValues = accounts
        .map((account) => account.latency)
        .filter(isKnownLatency);
      return {
        ...model,
        accounts,
        pricingSources,
        accountCount: accounts.length,
        tokenCount: accounts.reduce((sum, account) => sum + account.tokens.length, 0),
        balance: accounts.reduce((sum, account) => sum + (account.balance || 0), 0),
        avgLatency: latencyValues.length > 0
          ? Math.round(latencyValues.reduce((sum, latency) => sum + latency, 0) / latencyValues.length)
          : null,
      };
    });

    return [...scopedModels].sort((a, b) => compareModels(a, b, sortBy, sortDir));
  }, [filteredModels, activeSite, sortBy, sortDir]);

  /* ---- pagination ---- */
  const totalPages = Math.max(1, Math.ceil(detailModels.length / pageSize));
  const safePageVal = Math.min(page, totalPages);
  const paged = detailModels.slice((safePageVal - 1) * pageSize, safePageVal * pageSize);

  useEffect(() => { setPage(1); }, [search, activeSite, activeBrand, pageSize]);

  /* ---- stats ---- */
  const totalCoverageSlots = detailModels.reduce((s, m) => s + m.accountCount, 0);
  const uniqueAccountCount = (() => {
    const ids = new Set<number>();
    for (const model of detailModels) {
      for (const account of model.accounts) {
        ids.add(account.id);
      }
    }
    return ids.size;
  })();
  const latencyMetrics = detailModels
    .map((model) => model.avgLatency)
    .filter(isKnownLatency);
  const avgLatency = latencyMetrics.length > 0
    ? Math.round(latencyMetrics.reduce((sum, latency) => sum + latency, 0) / latencyMetrics.length)
    : null;

  /* ---- copy ---- */
  const copyName = (name: string) => {
    navigator.clipboard.writeText(name).catch(() => { });
    setCopied(name);
    setTimeout(() => setCopied(null), 1500);
  };

  const toggleSort = (nextSortBy: SortColumn) => {
    if (sortBy === nextSortBy) {
      setSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setSortBy(nextSortBy);
    setSortDir(nextSortBy === 'name' ? 'asc' : 'desc');
  };

  const accountModelKey = (modelName: string, accountId: number) => `${modelName}::${accountId}`;

  const toggleAccountDetailSort = (nextSortBy: AccountDetailSortColumn) => {
    if (accountDetailSortBy === nextSortBy) {
      setAccountDetailSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'));
      return;
    }
    setAccountDetailSortBy(nextSortBy);
    setAccountDetailSortDir(nextSortBy === 'site' || nextSortBy === 'username' ? 'asc' : 'desc');
  };

  const accountDetailSortHeaderProps = (column: AccountDetailSortColumn, testId?: string) => ({
    'data-testid': testId,
    onClick: (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      toggleAccountDetailSort(column);
    },
  });

  const sortAccountsForDetail = (accounts: ModelAccountInfo[]) => {
    const valueOf = (account: ModelAccountInfo) => {
      if (accountDetailSortBy === 'site') return String(account.site || '').toLowerCase();
      if (accountDetailSortBy === 'username') return String(account.username || `id:${account.id}`).toLowerCase();
      if (accountDetailSortBy === 'latency') {
        return typeof account.latency === 'number' && Number.isFinite(account.latency)
          ? account.latency
          : (accountDetailSortDir === 'asc' ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY);
      }
      return Number(account.balance || 0);
    };

    return [...accounts].sort((a, b) => {
      const va = valueOf(a);
      const vb = valueOf(b);
      if (typeof va === 'string' && typeof vb === 'string') {
        const cmp = va.localeCompare(vb);
        if (cmp !== 0) return accountDetailSortDir === 'asc' ? cmp : -cmp;
        return a.id - b.id;
      }
      if (va === vb) return a.id - b.id;
      return accountDetailSortDir === 'desc'
        ? Number(vb) - Number(va)
        : Number(va) - Number(vb);
    });
  };

  const testModelAvailability = async (modelName: string, account: ModelAccountInfo) => {
    const key = accountModelKey(modelName, account.id);
    setAvailabilityTesting((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await api.testMarketplaceModelAvailability({
        modelName,
        accountId: account.id,
        siteName: account.site,
      }) as {
        available?: boolean;
        reason?: string;
        latencyMs?: number;
        probeEndpoint?: string | null;
        probeClassification?: string | null;
        autoKeyCreated?: boolean;
        autoKeyName?: string | null;
        autoKeyGroup?: string | null;
      };
      const available = res?.available === true;
      const state: AvailabilityCheckState = {
        status: available ? 'available' : 'unavailable',
        message: summarizeAvailabilityMessage({
          available,
          reason: res?.reason,
          probeClassification: res?.probeClassification,
          probeEndpoint: res?.probeEndpoint,
        }),
        detail: buildAvailabilityDetail({
          reason: res?.reason,
          probeClassification: res?.probeClassification,
          probeEndpoint: res?.probeEndpoint,
          autoKeyCreated: res?.autoKeyCreated === true,
          autoKeyName: typeof res?.autoKeyName === 'string' ? res.autoKeyName : null,
          autoKeyGroup: typeof res?.autoKeyGroup === 'string' ? res.autoKeyGroup : null,
        }),
        latencyMs: Number.isFinite(res?.latencyMs as number) ? Number(res?.latencyMs) : undefined,
        probeEndpoint: typeof res?.probeEndpoint === 'string' ? res.probeEndpoint : null,
        probeClassification: typeof res?.probeClassification === 'string' ? res.probeClassification : null,
        autoKeyCreated: res?.autoKeyCreated === true,
        autoKeyName: typeof res?.autoKeyName === 'string' ? res.autoKeyName : null,
        autoKeyGroup: typeof res?.autoKeyGroup === 'string' ? res.autoKeyGroup : null,
      };
      setAvailabilityChecks((prev) => ({
        ...prev,
        [key]: state,
      }));

      if (available) {
        toast.success(state.autoKeyCreated
          ? `${account.site}/${account.username || account.id}: 模型可用，已自动补 Key`
          : `${account.site}/${account.username || account.id}: 模型可用`);
      } else {
        toast.info(`${account.site}/${account.username || account.id}: ${state.message}`);
      }
    } catch (error: any) {
      const message = String(error?.message || '检测失败');
      setAvailabilityChecks((prev) => ({
        ...prev,
        [key]: {
          status: 'error',
          message,
        },
      }));
      toast.error(message);
    } finally {
      setAvailabilityTesting((prev) => ({ ...prev, [key]: false }));
    }
  };

  const filterControls = (
    <>
      <div className="filter-panel-section">
        <div className="filter-panel-title">
          {tr('品牌')}
          {activeBrand && <button onClick={() => setActiveBrand(null)}>{tr('重置')}</button>}
        </div>
        <div
          className={`filter-item ${!activeBrand ? 'active' : ''}`}
          onClick={() => setActiveBrand(null)}
        >
          <span className="filter-item-icon" style={{ background: 'var(--color-primary-light)', color: 'var(--color-primary)' }}>✓</span>
          {tr('全部品牌')}
          <span className="filter-item-count">{data.models.length}</span>
        </div>
        {brandList.list.map(([brandName, { count, brand }]) => (
          <div
            key={brandName}
            className={`filter-item ${activeBrand === brandName ? 'active' : ''}`}
            onClick={() => setActiveBrand(activeBrand === brandName ? null : brandName)}
          >
            <span className="filter-item-icon" style={{ background: 'var(--color-bg)', borderRadius: 4, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <BrandGlyph brand={brand} size={14} fallbackText={brandName} />
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{brandName}</span>
            <span className="filter-item-count">{count}</span>
          </div>
        ))}
        {brandList.otherCount > 0 && (
          <div
            className={`filter-item ${activeBrand === '__other__' ? 'active' : ''}`}
            onClick={() => setActiveBrand(activeBrand === '__other__' ? null : '__other__')}
          >
            <span className="filter-item-icon" style={{ background: 'var(--color-bg)', color: 'var(--color-text-muted)', fontSize: 10, borderRadius: 4 }}>?</span>
            {tr('其他')}
            <span className="filter-item-count">{brandList.otherCount}</span>
          </div>
        )}
      </div>

      <div className="filter-panel-section">
        <div className="filter-panel-title">
          {tr('供应商')}
          {activeSite && <button onClick={() => setActiveSite(null)}>{tr('重置')}</button>}
        </div>
        {siteMap.map(([site, count]) => (
          <div
            key={site}
            className={`filter-item ${activeSite === site ? 'active' : ''}`}
            onClick={() => setActiveSite(activeSite === site ? null : site)}
          >
            <span className="filter-item-icon" style={{ background: hashColor(site), color: 'white', fontSize: 9, borderRadius: 4 }}>
              {site.slice(0, 2).toUpperCase()}
            </span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{site}</span>
            <span className="filter-item-count">{count}</span>
          </div>
        ))}
      </div>

      <div className="filter-panel-section">
        <div className="filter-panel-title">{tr('排序方式')}</div>
        {[
          { key: 'accountCount' as SortColumn, label: tr('账号数') },
          { key: 'tokenCount' as SortColumn, label: tr('令牌数') },
          { key: 'avgLatency' as SortColumn, label: tr('延迟') },
          { key: 'successRate' as SortColumn, label: tr('成功率') },
          { key: 'name' as SortColumn, label: tr('名称') },
        ].map(opt => (
          <div
            key={opt.key}
            className={`filter-item ${sortBy === opt.key ? 'active' : ''}`}
            onClick={() => {
              if (sortBy === opt.key) {
                setSortDir(d => d === 'asc' ? 'desc' : 'asc');
              } else {
                setSortBy(opt.key);
                setSortDir(opt.key === 'name' ? 'asc' : 'desc');
              }
            }}
          >
            {opt.label}
            {sortBy === opt.key && (
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--color-primary)' }}>
                {sortDir === 'desc' ? '↓' : '↑'}
              </span>
            )}
          </div>
        ))}
      </div>
    </>
  );

  /* ---- loading skeleton ---- */
  if (loading) {
    return (
      <div className="animate-fade-in" style={{ display: 'flex', gap: 24, minHeight: 400 }}>
        {!isMobile && (
          <div style={{ width: 240 }}>
            {[...Array(6)].map((_, i) => <div key={i} className="skeleton" style={{ height: 28, marginBottom: 8, borderRadius: 8 }} />)}
          </div>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="page-header" style={{ marginBottom: 16 }}>
            <div>
              <div className="skeleton" style={{ width: 220, height: 28, marginBottom: 8 }} />
              <div className="skeleton" style={{ width: 160, height: 16 }} />
            </div>
            <div className="page-actions">
              {isMobile && (
                <button
                  className="btn btn-ghost"
                  style={{ border: '1px solid var(--color-border)', padding: '6px 12px' }}
                  onClick={() => setShowFilters(true)}
                >
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>
                  {tr('筛选')}
                </button>
              )}
            </div>
          </div>
          {isMobile && (
            <MobileFilterSheet
              open={showFilters}
              onClose={() => setShowFilters(false)}
              title={tr('筛选模型')}
            >
              {filterControls}
            </MobileFilterSheet>
          )}
          {[...Array(4)].map((_, i) => <div key={i} className="skeleton" style={{ height: 100, marginBottom: 12, borderRadius: 12 }} />)}
        </div>
      </div>
    );
  }

  return (
    <div className="animate-fade-in" style={{ display: 'flex', gap: 24, minHeight: 400 }}>
      {!isMobile && filterPanelPresence.shouldRender && (
        <div className={`filter-panel filter-collapsible ${filterPanelPresence.isVisible ? '' : 'is-closing'}`.trim()}>
          {filterControls}
          <button
            className="btn btn-ghost"
            style={{ width: '100%', fontSize: 12, padding: '6px 10px', marginTop: 8, justifyContent: 'center', border: '1px solid var(--color-border)' }}
            onClick={() => setFilterCollapsed(true)}
          >
            {tr('收起')}
          </button>
        </div>
      )}

      {/* ====== RIGHT: Content Area ====== */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Header */}
        <div className="page-header" style={{ marginBottom: 16 }}>
          <div>
            <h2 className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {activeBrand || activeSite || tr('模型广场')}
              <span className="badge badge-info" style={{ fontSize: 12, fontWeight: 500 }}>
                {tr('共')} {filteredModels.length} {tr('个模型')}
              </span>
            </h2>
            {(activeBrand || activeSite) && (
              <p style={{ fontSize: 12, color: 'var(--color-text-muted)', margin: '4px 0 0' }}>
                {activeBrand && activeBrand !== '__other__' ? `${tr('查看')} ${activeBrand} ${tr('品牌的所有模型')}` : activeSite ? `${tr('来自供应商')} ${activeSite} ${tr('的模型')}` : tr('其他未归类的模型')}
              </p>
            )}
          </div>
          <div className="page-actions">
            {(isMobile || filterCollapsed) && (
              <button
                className="btn btn-ghost"
                style={{ border: '1px solid var(--color-border)', padding: '6px 12px' }}
                onClick={() => {
                  if (isMobile) {
                    setShowFilters(true);
                    return;
                  }
                  setFilterCollapsed(false);
                }}
              >
                <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" /></svg>
                {tr('筛选')}
              </button>
            )}
            <button onClick={handleRefresh} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '6px 12px' }}>
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
            {metadataHydrating && (
              <span className="badge badge-muted" style={{ fontSize: 11 }}>{tr('加载元数据中...')}</span>
            )}
            {!isMobile && (
              <div className="view-toggle">
                <button className={`view-toggle-btn ${viewMode === 'card' ? 'active' : ''}`} onClick={() => setViewMode('card')} data-tooltip={tr('卡片视图')} aria-label={tr('卡片视图')}>
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" /></svg>
                </button>
                <button className={`view-toggle-btn ${viewMode === 'table' ? 'active' : ''}`} onClick={() => setViewMode('table')} data-tooltip={tr('表格视图')} aria-label={tr('表格视图')}>
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h18M3 14h18M3 6h18M3 18h18M10 3v18M14 3v18" /></svg>
                </button>
              </div>
            )}
          </div>
        </div>

        {isMobile && (
          <MobileFilterSheet
            open={showFilters}
            onClose={() => setShowFilters(false)}
            title={tr('筛选模型')}
          >
            {filterControls}
          </MobileFilterSheet>
        )}

        {/* Toolbar */}
        <div className="toolbar">
          <div className="toolbar-search">
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={tr('搜索模型（支持名称片段）')}
            />
          </div>
          {/* Quick stats */}
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--color-text-muted)', alignItems: 'center' }}>
            <span data-tooltip={tr('所有模型 accountCount 累计值，同一账号在多个模型中会重复计数')}>
              {tr('覆盖档位')} <b style={{ color: 'var(--color-text-primary)' }}>{totalCoverageSlots}</b>
            </span>
            <span data-tooltip={tr('当前筛选范围内去重后的唯一账号数')}>
              {tr('去重账号')} <b style={{ color: 'var(--color-text-primary)' }}>{uniqueAccountCount}</b>
            </span>
            <span>{tr('平均延迟')} <b style={{ color: getMetricColor(avgLatency) }}>{formatLatency(avgLatency)}</b></span>
          </div>
        </div>

        {/* Empty */}
        {detailModels.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <svg width="40" height="40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
              </svg>
            </div>
            <div className="empty-state-title">{tr('暂无模型结果')}</div>
            <div className="empty-state-desc">{tr('请先检查站点与账号状态，然后点击刷新。')}</div>
          </div>
        ) : viewMode === 'card' ? (
          /* ====== Card View ====== */
          <div>
            {paged.map((m) => {
              const isExpanded = expanded === m.name;
              return (
              <div key={m.name} className="model-card" onClick={() => setExpanded(isExpanded ? null : m.name)}>
                <div className="model-card-header">
                  <BrandIcon model={m.name} size={44} />
                  <div className="model-card-info">
                    <div className="model-card-name">{m.name}</div>
                    <div className="model-card-meta">
                      <span>
                        <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                        {m.accountCount} {tr('个账号')}
                      </span>
                      <span>
                        <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
                        {m.tokenCount} {tr('令牌')}
                      </span>
                      <span
                        className={`badge ${getLatencyBadgeClass(m.avgLatency)}`}
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                        data-tooltip={tr('平均延迟')}
                      >
                        {tr('延迟')} {formatLatency(m.avgLatency)}
                      </span>
                      <span
                        className={`badge ${getSuccessBadgeClass(m.successRate)}`}
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                        data-tooltip={tr('成功率')}
                      >
                        {tr('成功率')} {m.successRate != null ? `${m.successRate}%` : '—'}
                      </span>
                    </div>
                  </div>
                  <div className="model-card-actions" onClick={e => e.stopPropagation()}>
                    <button className="model-card-action-btn" data-tooltip={tr('复制模型名')} aria-label={tr('复制模型名')} onClick={() => copyName(m.name)}>
                      {copied === m.name ? (
                        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="var(--color-success)"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                      ) : (
                        <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                      )}
                    </button>
                    <button
                      className="model-card-action-btn"
                      data-tooltip={isExpanded ? tr('收起') : tr('展开')}
                      aria-label={isExpanded ? tr('收起') : tr('展开')}
                    >
                      <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                  </div>
                </div>

                {/* Tags */}
                <div className="model-card-tags">
                  {getBrand(m.name) && (
                    <span className="model-tag model-tag-purple">{getBrand(m.name)!.name}</span>
                  )}
                  {m.accounts.map(a => a.site).filter((v, i, arr) => arr.indexOf(v) === i).map(site => (
                    <span key={site} className="model-tag model-tag-blue">{site}</span>
                  ))}
                  {m.successRate != null && m.successRate >= 90 && (
                    <span className="model-tag model-tag-green">{tr('健康')}</span>
                  )}
                  {m.successRate != null && m.successRate < 60 && (
                    <span className="model-tag model-tag-orange">{tr('风险')}</span>
                  )}
                  {isKnownLatency(m.avgLatency) && m.avgLatency <= 500 && (
                    <span className="model-tag model-tag-purple">{tr('低延迟')}</span>
                  )}
                </div>

                {/* Expand: Account Details */}
                {isExpanded ? (
                <div className="anim-collapse is-open" onClick={e => e.stopPropagation()}>
                  <div className="anim-collapse-inner">
                    <div className="model-card-expand">
                    <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
                      <div className="card" style={{ padding: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{tr('基础信息')}</div>
                        <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                          {resolveMarketplaceDescription(m, metadataHydrating)}
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                          {m.tags.length > 0 ? m.tags.map((tag) => (
                            <span key={tag} className="badge badge-info">{tag}</span>
                          )) : <span className="badge badge-muted">{metadataHydrating ? tr('加载元数据中...') : tr('暂无标签')}</span>}
                        </div>
                      </div>

                      <div className="card" style={{ padding: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{tr('接口能力')}</div>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {m.supportedEndpointTypes.length > 0 ? m.supportedEndpointTypes.map((endpoint) => (
                            <span key={endpoint} className="badge badge-success">{endpoint}</span>
                          )) : <span className="badge badge-muted">{metadataHydrating ? tr('加载元数据中...') : tr('未提供')}</span>}
                        </div>
                      </div>

                      <div className="card" style={{ padding: 10 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{tr('分组计费')}</div>
                        {m.pricingSources.length > 0 ? (
                          <div style={{ display: 'grid', gap: 8 }}>
                            {m.pricingSources.map((source) => (
                              <div
                                key={`${source.siteId}-${source.accountId}`}
                                style={{ border: '1px solid var(--color-border-light)', borderRadius: 8, padding: 8 }}
                              >
                                <div style={{ fontSize: 12, marginBottom: 6 }}>
                                  <SiteBadgeLink siteId={source.siteId} siteName={source.siteName} badgeStyle={{ fontSize: 11 }} /> · {source.username || `ID:${source.accountId}`}
                                </div>
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                  {Object.entries(source.groupPricing).map(([group, pricing]) => (
                                    <span key={group} className="badge badge-info">
                                      {group}: {renderGroupPricingValue(pricing)}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="badge badge-muted">{metadataHydrating ? tr('正在加载价格元数据...') : tr('暂无价格元数据')}</span>
                        )}
                      </div>
                    </div>

                    {isMobile ? (
                      <div style={{ display: 'grid', gap: 8 }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-secondary)' }}>{tr('账号明细')}</div>
                        {sortAccountsForDetail(m.accounts).map((a) => (
                          <div
                            key={a.id}
                            className="card"
                            style={{ padding: 10, display: 'grid', gap: 8 }}
                          >
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                              <SiteBadgeLink siteId={siteIdByName.get(a.site)} siteName={a.site} badgeClassName="badge badge-info" badgeStyle={{ fontSize: 11 }} />
                              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>{a.username || `ID:${a.id}`}</span>
                            </div>
                            <div style={{ display: 'grid', gap: 6 }}>
                              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                                <span style={{ color: 'var(--color-text-muted)' }}>{tr('延迟')}</span>
                                <span style={{ color: getMetricColor(a.latency), fontVariantNumeric: 'tabular-nums' }}>
                                  {a.latency != null ? `${a.latency}ms` : '—'}
                                </span>
                              </div>
                              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 12 }}>
                                <span style={{ color: 'var(--color-text-muted)' }}>{tr('余额')}</span>
                                <span style={{ fontVariantNumeric: 'tabular-nums' }}>${(a.balance || 0).toFixed(2)}</span>
                              </div>
                              <div style={{ display: 'grid', gap: 6 }}>
                                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('可用性检测')}</span>
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                  <button
                                    className="btn btn-ghost"
                                    style={{ border: '1px solid var(--color-border)', fontSize: 11, padding: '3px 8px' }}
                                    onClick={() => { void testModelAvailability(m.name, a); }}
                                    disabled={!!availabilityTesting[accountModelKey(m.name, a.id)]}
                                  >
                                    {availabilityTesting[accountModelKey(m.name, a.id)] ? tr('检测中...') : tr('检测')}
                                  </button>
                                  {availabilityChecks[accountModelKey(m.name, a.id)] ? (
                                    <span
                                      className={`badge ${availabilityChecks[accountModelKey(m.name, a.id)]!.status === 'available' ? 'badge-success' : (availabilityChecks[accountModelKey(m.name, a.id)]!.status === 'unavailable' ? 'badge-warning' : 'badge-error')}`}
                                      style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}
                                      title={availabilityChecks[accountModelKey(m.name, a.id)]!.message}
                                    >
                                      {availabilityChecks[accountModelKey(m.name, a.id)]!.status === 'available'
                                        ? tr('可用')
                                        : (availabilityChecks[accountModelKey(m.name, a.id)]!.status === 'unavailable' ? tr('不可用') : tr('失败'))}
                                      {availabilityChecks[accountModelKey(m.name, a.id)]!.latencyMs != null ? ` ${availabilityChecks[accountModelKey(m.name, a.id)]!.latencyMs}ms` : ''}
                                    </span>
                                  ) : null}
                                  {availabilityChecks[accountModelKey(m.name, a.id)] ? (
                                    <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                                      {availabilityChecks[accountModelKey(m.name, a.id)]!.message}
                                    </span>
                                  ) : null}
                                </div>
                                {availabilityChecks[accountModelKey(m.name, a.id)]?.autoKeyCreated ? (
                                  <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                                    {`自动补 Key: ${availabilityChecks[accountModelKey(m.name, a.id)]?.autoKeyGroup || 'default'} / ${availabilityChecks[accountModelKey(m.name, a.id)]?.autoKeyName || '-'}`}
                                  </span>
                                ) : null}
                              </div>
                              <div style={{ display: 'grid', gap: 6 }}>
                                <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('令牌')}</span>
                                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                  {a.tokens.length > 0 ? a.tokens.map((t) => (
                                    <span key={t.id} className={`badge ${t.isDefault ? 'badge-success' : 'badge-muted'}`} style={{ fontSize: 11 }}>{t.name}</span>
                                  )) : <span style={{ color: 'var(--color-text-muted)', fontSize: 12 }}>—</span>}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <table className="data-table" style={{ width: '100%' }}>
                        <thead>
                          <tr>
                            <th style={{ fontWeight: 500, cursor: 'pointer' }} {...accountDetailSortHeaderProps('site')}>{tr('站点')} {accountDetailSortBy === 'site' ? (accountDetailSortDir === 'desc' ? '↓' : '↑') : ''}</th>
                            <th style={{ fontWeight: 500, cursor: 'pointer' }} {...accountDetailSortHeaderProps('username')}>{tr('账号')} {accountDetailSortBy === 'username' ? (accountDetailSortDir === 'desc' ? '↓' : '↑') : ''}</th>
                            <th style={{ fontWeight: 500 }}>{tr('令牌')}</th>
                            <th style={{ fontWeight: 500, cursor: 'pointer' }} {...accountDetailSortHeaderProps('latency', 'model-detail-sort-latency')}>{tr('延迟')} {accountDetailSortBy === 'latency' ? (accountDetailSortDir === 'desc' ? '↓' : '↑') : ''}</th>
                            <th style={{ fontWeight: 500 }}>{tr('可用性检测')}</th>
                            <th style={{ fontWeight: 500, cursor: 'pointer' }} {...accountDetailSortHeaderProps('balance', 'model-detail-sort-balance')}>{tr('余额')} {accountDetailSortBy === 'balance' ? (accountDetailSortDir === 'desc' ? '↓' : '↑') : ''}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortAccountsForDetail(m.accounts).map(a => {
                            const rowKey = accountModelKey(m.name, a.id);
                            const checking = !!availabilityTesting[rowKey];
                            const check = availabilityChecks[rowKey];
                            return (
                            <tr key={a.id}>
                              <td><SiteBadgeLink siteId={siteIdByName.get(a.site)} siteName={a.site} badgeClassName="badge badge-info" badgeStyle={{ fontSize: 11 }} /></td>
                              <td style={{ fontSize: 12 }}>{a.username || `ID:${a.id}`}</td>
                              <td style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                {a.tokens.length > 0 ? a.tokens.map(t => (
                                  <span key={t.id} className={`badge ${t.isDefault ? 'badge-success' : 'badge-muted'}`} style={{ fontSize: 11 }}>{t.name}</span>
                                )) : <span style={{ color: 'var(--color-text-muted)' }}>—</span>}
                              </td>
                              <td>
                                {a.latency != null ? (
                                  <span style={{ color: getMetricColor(a.latency), fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{a.latency}ms</span>
                                ) : '—'}
                              </td>
                              <td>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                                  <button
                                    className="btn btn-ghost"
                                    style={{ border: '1px solid var(--color-border)', fontSize: 11, padding: '3px 8px' }}
                                    onClick={() => { void testModelAvailability(m.name, a); }}
                                    disabled={checking}
                                  >
                                    {checking ? tr('检测中...') : tr('检测')}
                                  </button>
                                  {check ? (
                                    <span
                                      className={`badge ${check.status === 'available' ? 'badge-success' : (check.status === 'unavailable' ? 'badge-warning' : 'badge-error')}`}
                                      style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}
                                      title={check.message}
                                    >
                                      {check.status === 'available' ? tr('可用') : (check.status === 'unavailable' ? tr('不可用') : tr('失败'))}
                                      {check.latencyMs != null ? ` ${check.latencyMs}ms` : ''}
                                    </span>
                                  ) : null}
                                  {check ? (
                                    <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>
                                      {check.message}
                                    </span>
                                  ) : null}
                                  {check?.autoKeyCreated ? (
                                    <span className="badge badge-info" style={{ fontSize: 11 }}>
                                      {tr('已自动补 Key')}
                                    </span>
                                  ) : null}
                                  {check?.detail ? (
                                    <button
                                      className="btn btn-ghost"
                                      style={{ border: '1px solid var(--color-border)', fontSize: 11, padding: '3px 8px' }}
                                      onClick={() => setExpandedCheckDetails((prev) => ({ ...prev, [rowKey]: !prev[rowKey] }))}
                                    >
                                      {expandedCheckDetails[rowKey] ? tr('收起详情') : tr('查看详情')}
                                    </button>
                                  ) : null}
                                </div>
                                {check?.detail && expandedCheckDetails[rowKey] ? (
                                  <div style={{ marginTop: 6, fontSize: 11, color: 'var(--color-text-muted)', lineHeight: 1.5 }}>
                                    {check.detail}
                                  </div>
                                ) : null}
                              </td>
                              <td style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>${(a.balance || 0).toFixed(2)}</td>
                            </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                    </div>
                  </div>
                </div>
                ) : null}
              </div>
              );
            })}
          </div>
        ) : (
          /* ====== Table View ====== */
          <div className="card" style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th style={{ width: 44 }} />
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('name')}>
                    {tr('模型名称')} {sortBy === 'name' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
                  </th>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('accountCount')}>
                    {tr('账号数')} {sortBy === 'accountCount' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
                  </th>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('tokenCount')}>
                    {tr('令牌数')} {sortBy === 'tokenCount' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
                  </th>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('avgLatency')}>
                    {tr('延迟')} {sortBy === 'avgLatency' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
                  </th>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('successRate')}>
                    {tr('成功率')} {sortBy === 'successRate' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
                  </th>
                  <th style={{ cursor: 'pointer' }} onClick={() => toggleSort('balance')}>
                    {tr('余额')} {sortBy === 'balance' ? (sortDir === 'desc' ? '↓' : '↑') : ''}
                  </th>
                  <th style={{ width: 60 }}>{tr('操作')}</th>
                </tr>
              </thead>
              <tbody>
                {paged.map((m) => {
                  const isExpanded = expanded === m.name;
                  return (
                  <React.Fragment key={m.name}>
                    <tr onClick={() => setExpanded(isExpanded ? null : m.name)} style={{ cursor: 'pointer' }}>
                      <td>
                        <BrandIcon model={m.name} size={28} />
                      </td>
                      <td>
                        <code style={{ fontSize: 12, padding: '3px 8px', background: 'var(--color-bg)', borderRadius: 4, border: '1px solid var(--color-border-light)' }}>
                          {m.name}
                        </code>
                      </td>
                      <td><span className="badge badge-info">{m.accountCount}</span></td>
                      <td><span className="badge badge-muted">{m.tokenCount}</span></td>
                      <td>
                        <span
                          className={`badge ${getLatencyBadgeClass(m.avgLatency)}`}
                          style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
                        >
                          {formatLatency(m.avgLatency)}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`badge ${getSuccessBadgeClass(m.successRate)}`}
                          style={{ fontSize: 12, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}
                        >
                          {m.successRate != null ? `${m.successRate}%` : '—'}
                        </span>
                      </td>
                      <td style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>${m.balance.toFixed(2)}</td>
                      <td onClick={e => e.stopPropagation()}>
                        <button className="model-card-action-btn" data-tooltip={tr('复制')} aria-label={tr('复制')} onClick={() => copyName(m.name)}>
                          {copied === m.name ? (
                            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="var(--color-success)"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                          ) : (
                            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
                          )}
                        </button>
                      </td>
                    </tr>
                    {isExpanded ? (
                    <tr className="log-detail-row">
                      <td colSpan={8} style={{ padding: 0 }}>
                        <div className="anim-collapse is-open">
                          <div className="anim-collapse-inner">
                            <div style={{ padding: '12px 16px 12px 54px' }}>
                            <div style={{ display: 'grid', gap: 8, marginBottom: 10 }}>
                              <div className="card" style={{ padding: 10 }}>
                                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{tr('基础信息')}</div>
                                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                                  {resolveMarketplaceDescription(m, metadataHydrating)}
                                </div>
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                                  {m.tags.length > 0 ? m.tags.map((tag) => (
                                    <span key={tag} className="badge badge-info">{tag}</span>
                                  )) : <span className="badge badge-muted">{metadataHydrating ? tr('加载元数据中...') : tr('暂无标签')}</span>}
                                </div>
                              </div>

                              <div className="card" style={{ padding: 10 }}>
                                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{tr('接口能力')}</div>
                                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                  {m.supportedEndpointTypes.length > 0 ? m.supportedEndpointTypes.map((endpoint) => (
                                    <span key={endpoint} className="badge badge-success">{endpoint}</span>
                                  )) : <span className="badge badge-muted">{metadataHydrating ? tr('加载元数据中...') : tr('未提供')}</span>}
                                </div>
                              </div>

                              <div className="card" style={{ padding: 10 }}>
                                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>{tr('分组计费')}</div>
                                {m.pricingSources.length > 0 ? (
                                  <div style={{ display: 'grid', gap: 8 }}>
                                    {m.pricingSources.map((source) => (
                                      <div
                                        key={`${source.siteId}-${source.accountId}`}
                                        style={{ border: '1px solid var(--color-border-light)', borderRadius: 8, padding: 8 }}
                                      >
                                        <div style={{ fontSize: 12, marginBottom: 6 }}>
                                          <SiteBadgeLink siteId={source.siteId} siteName={source.siteName} badgeStyle={{ fontSize: 11 }} /> · {source.username || `ID:${source.accountId}`}
                                        </div>
                                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                          {Object.entries(source.groupPricing).map(([group, pricing]) => (
                                            <span key={group} className="badge badge-info">
                                              {group}: {renderGroupPricingValue(pricing)}
                                            </span>
                                          ))}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <span className="badge badge-muted">{metadataHydrating ? tr('正在加载价格元数据...') : tr('暂无价格元数据')}</span>
                                )}
                              </div>
                            </div>

                            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                              <thead><tr style={{ color: 'var(--color-text-muted)' }}>
                                <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500, cursor: 'pointer' }} {...accountDetailSortHeaderProps('site')}>{tr('站点')} {accountDetailSortBy === 'site' ? (accountDetailSortDir === 'desc' ? '↓' : '↑') : ''}</th>
                                <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500, cursor: 'pointer' }} {...accountDetailSortHeaderProps('username')}>{tr('账号')} {accountDetailSortBy === 'username' ? (accountDetailSortDir === 'desc' ? '↓' : '↑') : ''}</th>
                                <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500 }}>{tr('令牌')}</th>
                                <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500, cursor: 'pointer' }} {...accountDetailSortHeaderProps('latency', 'model-card-detail-sort-latency')}>{tr('延迟')} {accountDetailSortBy === 'latency' ? (accountDetailSortDir === 'desc' ? '↓' : '↑') : ''}</th>
                                <th style={{ textAlign: 'left', padding: '6px 8px', fontWeight: 500, cursor: 'pointer' }} {...accountDetailSortHeaderProps('balance', 'model-card-detail-sort-balance')}>{tr('余额')} {accountDetailSortBy === 'balance' ? (accountDetailSortDir === 'desc' ? '↓' : '↑') : ''}</th>
                              </tr></thead>
                              <tbody>
                                {sortAccountsForDetail(m.accounts).map(a => (
                                  <tr key={a.id} style={{ borderTop: '1px solid var(--color-border-light)' }}>
                                    <td style={{ padding: 8 }}><SiteBadgeLink siteId={siteIdByName.get(a.site)} siteName={a.site} badgeClassName="badge badge-info" badgeStyle={{ fontSize: 11 }} /></td>
                                    <td style={{ padding: 8 }}>{a.username || `ID:${a.id}`}</td>
                                    <td style={{ padding: 8, display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                                      {a.tokens.length > 0 ? a.tokens.map(t => (
                                        <span key={t.id} className={`badge ${t.isDefault ? 'badge-success' : 'badge-info'}`}>{t.name}</span>
                                      )) : '—'}
                                    </td>
                                    <td style={{ padding: 8, color: a.latency != null ? getMetricColor(a.latency) : 'var(--color-text-muted)' }}>
                                      {a.latency != null ? `${a.latency}ms` : '—'}
                                    </td>
                                    <td style={{ padding: 8 }}>${(a.balance || 0).toFixed(2)}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                    ) : null}
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        {filteredModels.length > 0 && (
          <div className="pagination">
            <button className="pagination-btn" disabled={safePageVal <= 1} onClick={() => setPage(p => p - 1)}>
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </button>
            {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
              let pageNum: number;
              if (totalPages <= 7) {
                pageNum = i + 1;
              } else if (safePageVal <= 4) {
                pageNum = i + 1;
              } else if (safePageVal >= totalPages - 3) {
                pageNum = totalPages - 6 + i;
              } else {
                pageNum = safePageVal - 3 + i;
              }
              return (
                <button key={pageNum} className={`pagination-btn ${safePageVal === pageNum ? 'active' : ''}`} onClick={() => setPage(pageNum)}>
                  {pageNum}
                </button>
              );
            })}
            <button className="pagination-btn" disabled={safePageVal >= totalPages} onClick={() => setPage(p => p + 1)}>
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </button>
            <div className="pagination-size">
              {tr('每页条数')}:
              <div style={{ minWidth: 86 }}>
                <ModernSelect
                  size="sm"
                  value={String(pageSize)}
                  onChange={(nextValue) => setPageSize(Number(nextValue))}
                  options={PAGE_SIZES.map((s) => ({ value: String(s), label: String(s) }))}
                  placeholder={String(pageSize)}
                />
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
