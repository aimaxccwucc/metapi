import { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { arrayMove } from '@dnd-kit/sortable';
import type { DragEndEvent } from '@dnd-kit/core';
import { api } from '../api.js';
import type { RouteDiagnosticsResponse, RouteOverviewResponse, RoutingGovernanceSubject, RouteProbeResponse } from '../api.js';
import { BrandGlyph, getBrand, InlineBrandIcon, type BrandInfo } from '../components/BrandIcon.js';
import { useToast } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import MobileFilterSheet from '../components/MobileFilterSheet.js';
import { useIsMobile } from '../components/useIsMobile.js';
import { tr } from '../i18n.js';
import {
  buildRouteModelCandidatesIndex,
  type RouteCandidateView,
  type RouteModelCandidatesByModelName,
} from './helpers/routeModelCandidatesIndex.js';
import { getInitialVisibleCount, getNextVisibleCount } from './helpers/progressiveRender.js';
import {
  buildRouteMissingTokenIndex,
  normalizeMissingTokenModels,
  type MissingTokenModelsByName,
} from './helpers/routeMissingTokenHints.js';
import { buildVisibleRouteList } from './helpers/routeListVisibility.js';
import { buildZeroChannelPlaceholderRoutes } from './helpers/zeroChannelRoutes.js';

import type {
  RouteSortBy,
  RouteSortDir,
  GroupFilter,
  RouteSummaryRow,
  RouteRoutingStrategy,
  RouteMode,
  RouteProbePolicy,
  RouteDecision,
  RouteIconOption,
  MissingTokenRouteSiteActionItem,
  MissingTokenGroupRouteSiteActionItem,
  GroupRouteItem,
  ExplicitGroupSourceHealthSummary,
  RouteProbeSummary,
  SourceRouteOption,
} from './token-routes/types.js';
import {
  AUTO_ROUTE_DECISION_LIMIT,
  ROUTE_RENDER_CHUNK,
  isExactModelPattern,
  isExplicitGroupRoute,
  isRouteExactModel,
  matchesModelPattern,
  normalizeRouteMode,
  resolveRouteTitle,
  resolveRouteBrand,
  resolveRouteIcon,
  toBrandIconValue,
  normalizeRouteDisplayIconValue,
  inferEndpointTypesFromPlatform,
  getModelPatternError,
} from './token-routes/utils.js';
import { useRouteChannels } from './token-routes/useRouteChannels.js';
import RouteFilterBar from './token-routes/RouteFilterBar.js';
import ManualRoutePanel from './token-routes/ManualRoutePanel.js';
import RouteCard from './token-routes/RouteCard.js';
import AddChannelModal from './token-routes/AddChannelModal.js';
import { buildAccountFocusPath } from './helpers/navigationFocus.js';

const EMPTY_ROUTE_CANDIDATE_VIEW: RouteCandidateView = {
  routeCandidates: [],
  accountOptions: [],
  tokenOptionsByAccountId: {},
};
const EMPTY_MISSING_ITEMS: MissingTokenRouteSiteActionItem[] = [];
const EMPTY_MISSING_GROUP_ITEMS: MissingTokenGroupRouteSiteActionItem[] = [];
const ROUTE_ICON_OPTIONS: RouteIconOption[] = [
  { value: '', label: '自动品牌图标', description: '按模型匹配规则自动识别品牌', iconText: '✦' },
];

type RouteEditorForm = {
  routeMode: RouteMode;
  probePolicy: RouteProbePolicy;
  displayName: string;
  displayIcon: string;
  modelPattern: string;
  sourceRouteKeys: string[];
  advancedOpen: boolean;
};

const EMPTY_ROUTE_FORM: RouteEditorForm = {
  routeMode: 'explicit_group',
  probePolicy: 'manual',
  displayName: '',
  displayIcon: '',
  modelPattern: '',
  sourceRouteKeys: [],
  advancedOpen: false,
};

type ModelTokenCandidatesPayload = {
  models?: RouteModelCandidatesByModelName;
  modelsWithoutToken?: MissingTokenModelsByName;
  modelsMissingTokenGroups?: MissingTokenModelsByName;
  endpointTypesByModel?: Record<string, string[]>;
};

type RouteGovernanceSubjectsResponse = {
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

type RouteGovernanceRecoveryPassResponse = {
  success: true;
  scanned: number;
  promotedToProbing: number;
  keptSuppressed: number;
  restored: number;
  items: Array<{
    id: number;
    subjectType: string;
    subjectId: number;
    modelName: string;
    action: string;
    state: string;
  }>;
};

type RouteGovernanceApi = {
  getRouteOverview(): Promise<RouteOverviewResponse>;
  getRouteGovernanceSubjects(limit?: number): Promise<RouteGovernanceSubjectsResponse>;
  runRouteGovernanceRecoveryPass(body?: {
    limit?: number;
    includeProbing?: boolean;
  }): Promise<RouteGovernanceRecoveryPassResponse>;
};

function pickFeedbackExamples(names: string[]): string {
  return names.slice(0, 2).join('、');
}

function buildVirtualSourceRouteKey(modelName: string): string {
  return `model:${modelName.trim()}`;
}

function buildPersistedSourceRouteKey(routeId: number): string {
  return `route:${routeId}`;
}

function resolveSourceKeyFromRoute(route: Pick<RouteSummaryRow, 'id' | 'modelPattern' | 'routeMode'>): string {
  if (Number.isFinite(route.id) && route.id > 0) return buildPersistedSourceRouteKey(route.id);
  return buildVirtualSourceRouteKey(route.modelPattern);
}

function buildExplicitGroupSaveFeedback(
  sourceRouteIds: number[],
  summaries: RouteSummaryRow[],
  candidateRows?: ModelTokenCandidatesPayload,
): ExplicitGroupSourceHealthSummary | null {
  const normalizedSourceRouteIds = Array.from(new Set(
    (sourceRouteIds || []).filter((routeId) => Number.isFinite(routeId) && routeId > 0),
  ));
  if (normalizedSourceRouteIds.length === 0) return null;

  const selectedRoutes = summaries.filter((route) => normalizedSourceRouteIds.includes(route.id));
  const routePatterns = selectedRoutes.map((route) => ({
    id: route.id,
    modelPattern: route.modelPattern,
  }));
  const missingTokenIndex = buildRouteMissingTokenIndex(
    routePatterns,
    normalizeMissingTokenModels(candidateRows?.modelsWithoutToken || {}),
    matchesModelPattern,
  );
  const missingGroupIndex = buildRouteMissingTokenIndex(
    routePatterns,
    normalizeMissingTokenModels(candidateRows?.modelsMissingTokenGroups || {}),
    matchesModelPattern,
  );

  const zeroChannelRoutes: string[] = [];
  const missingTokenRoutes: string[] = [];
  const missingGroupRoutes: string[] = [];
  let readyCount = 0;

  for (const route of selectedRoutes) {
    const title = resolveRouteTitle(route);
    const hasChannels = (route.enabledChannelCount || route.channelCount || 0) > 0;
    const missingTokenHints = missingTokenIndex[route.id] || [];
    const missingGroupHints = missingGroupIndex[route.id] || [];
    if (hasChannels) readyCount += 1;
    else zeroChannelRoutes.push(title);
    if (missingTokenHints.length > 0) missingTokenRoutes.push(title);
    if (missingGroupHints.length > 0) missingGroupRoutes.push(title);
  }

  return {
    totalCount: normalizedSourceRouteIds.length,
    readyCount,
    zeroChannelRoutes,
    missingTokenRoutes,
    missingGroupRoutes,
  };
}

function formatExplicitGroupSaveFeedback(feedback: ExplicitGroupSourceHealthSummary): string {
  const parts = [`来源检查：${feedback.readyCount}/${feedback.totalCount} 个来源模型已有可用通道`];
  if (feedback.zeroChannelRoutes.length > 0) {
    parts.push(`无通道 ${feedback.zeroChannelRoutes.length} 个（${pickFeedbackExamples(feedback.zeroChannelRoutes)}）`);
  }
  if (feedback.missingTokenRoutes.length > 0) {
    parts.push(`缺少 Key ${feedback.missingTokenRoutes.length} 个（${pickFeedbackExamples(feedback.missingTokenRoutes)}）`);
  }
  if (feedback.missingGroupRoutes.length > 0) {
    parts.push(`缺少分组 ${feedback.missingGroupRoutes.length} 个（${pickFeedbackExamples(feedback.missingGroupRoutes)}）`);
  }
  if (
    feedback.zeroChannelRoutes.length === 0
    && feedback.missingTokenRoutes.length === 0
    && feedback.missingGroupRoutes.length === 0
  ) {
    parts.push('来源可直接用于转发');
  }
  return parts.join('；');
}

function formatExplicitGroupHealthHint(summary: ExplicitGroupSourceHealthSummary): string {
  const parts = [`来源健康 ${summary.readyCount}/${summary.totalCount}`];
  if (summary.zeroChannelRoutes.length > 0) parts.push(`无通道 ${summary.zeroChannelRoutes.length}`);
  if (summary.missingTokenRoutes.length > 0) parts.push(`缺少 Key ${summary.missingTokenRoutes.length}`);
  if (summary.missingGroupRoutes.length > 0) parts.push(`缺少分组 ${summary.missingGroupRoutes.length}`);
  if (
    summary.zeroChannelRoutes.length === 0
    && summary.missingTokenRoutes.length === 0
    && summary.missingGroupRoutes.length === 0
  ) {
    parts.push('可直接转发');
  }
  return parts.join(' · ');
}

function normalizeRouteRoutingStrategyValue(value?: RouteRoutingStrategy | null): RouteRoutingStrategy {
  if (value === 'round_robin' || value === 'stable_first') return value;
  return 'weighted';
}

function getRouteRoutingStrategyLabel(value?: RouteRoutingStrategy | null): string {
  const strategy = normalizeRouteRoutingStrategyValue(value);
  if (strategy === 'round_robin') return tr('轮询');
  if (strategy === 'stable_first') return tr('稳定优先');
  return tr('权重随机');
}

function getRouteRoutingStrategySuccessMessage(value: RouteRoutingStrategy): string {
  if (value === 'round_robin') return '已切换为轮询策略';
  if (value === 'stable_first') return '已切换为稳定优先策略';
  return '已切换为权重随机策略';
}

function hasModelCircuitIssue(candidate: NonNullable<RouteDecision['candidates']>[number]): boolean {
  return candidate.modelCircuitStatus?.isOpen === true
    || candidate.modelCircuitStatus?.state === 'open';
}

function hasSiteRuntimeIssue(candidate: NonNullable<RouteDecision['candidates']>[number]): boolean {
  const siteRuntimeState = candidate.siteRuntimeState;
  if (!siteRuntimeState) return false;
  if (siteRuntimeState.globalBreakerOpen || siteRuntimeState.modelBreakerOpen) return true;
  const multipliers = [
    siteRuntimeState.globalMultiplier,
    siteRuntimeState.modelMultiplier,
    siteRuntimeState.combinedMultiplier,
  ];
  return multipliers.some((value) => typeof value === 'number' && Number.isFinite(value) && value < 0.999);
}

function hasActiveCooldown(candidate: NonNullable<RouteDecision['candidates']>[number], nowIso: string): boolean {
  return !!candidate.cooldownUntil && candidate.cooldownUntil > nowIso;
}

function formatIsoDateTime(input?: string | null): string {
  if (!input) return '-';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function formatCheckinSnapshotSummary(account: {
  checkinSnapshot?: {
    status?: string;
    reasonCode?: string;
    message?: string;
    nextRetryAt?: string | null;
  } | null;
  latestCheckinStatus?: string | null;
  latestCheckinMessage?: string | null;
  latestCheckinAt?: string | null;
}) {
  const snapshot = account.checkinSnapshot;
  const parts: string[] = [];
  if (snapshot?.status) parts.push(snapshot.status);
  if (snapshot?.reasonCode) parts.push(snapshot.reasonCode);
  if (snapshot?.message) parts.push(snapshot.message);
  if (parts.length === 0 && account.latestCheckinStatus) parts.push(account.latestCheckinStatus);
  if (parts.length === 0 && account.latestCheckinMessage) parts.push(account.latestCheckinMessage);
  return parts.length > 0 ? parts.join(' / ') : '-';
}

function isManualGovernedRoute(route: Pick<RouteSummaryRow, 'probePolicy' | 'routeMode'>): boolean {
  if (route.probePolicy === 'manual') return true;
  if (route.probePolicy === 'system') return false;
  return normalizeRouteMode(route.routeMode) === 'explicit_group';
}

function buildDiagnosticPath(targetType: 'site' | 'account' | 'token', targetId: number): string {
  const params = new URLSearchParams();
  params.set('targetType', targetType);
  params.set('targetId', String(targetId));
  return `/diagnostics?${params.toString()}`;
}

export default function TokenRoutes() {
  const navigate = useNavigate();
  const governanceApi = api as unknown as RouteGovernanceApi;
  const [routeSummaries, setRouteSummaries] = useState<RouteSummaryRow[]>([]);
  const [modelCandidates, setModelCandidates] = useState<RouteModelCandidatesByModelName>({});
  const [missingTokenModelsByName, setMissingTokenModelsByName] = useState<MissingTokenModelsByName>({});
  const [missingTokenGroupModelsByName, setMissingTokenGroupModelsByName] = useState<MissingTokenModelsByName>({});
  const [endpointTypesByModel, setEndpointTypesByModel] = useState<Record<string, string[]>>({});
  const [routeCandidatesLoaded, setRouteCandidatesLoaded] = useState(false);
  const [routeCandidatesLoading, setRouteCandidatesLoading] = useState(false);

  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search.trim());
  const [activeBrand, setActiveBrand] = useState<string | null>(null);
  const [activeSite, setActiveSite] = useState<string | null>(null);
  const [activeEndpointType, setActiveEndpointType] = useState<string | null>(null);
  const [activeGroupFilter, setActiveGroupFilter] = useState<GroupFilter>(null);
  const [filterCollapsed, setFilterCollapsed] = useState(true);
  const [showFilters, setShowFilters] = useState(false);
  const [showZeroChannelRoutes, setShowZeroChannelRoutes] = useState(false);
  const [showOnlyManualRoutes, setShowOnlyManualRoutes] = useState(true);
  const [sortBy, setSortBy] = useState<RouteSortBy>('channelCount');
  const [sortDir, setSortDir] = useState<RouteSortDir>('desc');

  const [showManual, setShowManual] = useState(false);
  const [form, setForm] = useState<RouteEditorForm>(EMPTY_ROUTE_FORM);
  const [editingRouteId, setEditingRouteId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [resettingRoutingRuntime, setResettingRoutingRuntime] = useState(false);

  const [channelTokenDraft, setChannelTokenDraft] = useState<Record<number, number>>({});
  const [updatingChannel, setUpdatingChannel] = useState<Record<number, boolean>>({});
  const [savingPriorityByRoute, setSavingPriorityByRoute] = useState<Record<number, boolean>>({});
  const [updatingRoutingStrategyByRoute, setUpdatingRoutingStrategyByRoute] = useState<Record<number, boolean>>({});

  const [decisionByRoute, setDecisionByRoute] = useState<Record<number, RouteDecision | null>>({});
  const [loadingDecision, setLoadingDecision] = useState(false);
  const [decisionAutoSkipped, setDecisionAutoSkipped] = useState(false);
  const [routeOverview, setRouteOverview] = useState<RouteOverviewResponse | null>(null);
  const [loadingRouteOverview, setLoadingRouteOverview] = useState(false);
  const [governanceSubjects, setGovernanceSubjects] = useState<RoutingGovernanceSubject[]>([]);
  const [loadingGovernanceSubjects, setLoadingGovernanceSubjects] = useState(false);
  const [governanceSubjectsLoaded, setGovernanceSubjectsLoaded] = useState(false);
  const [governanceSubjectsDirty, setGovernanceSubjectsDirty] = useState(false);
  const [routeDiagnostics, setRouteDiagnostics] = useState<RouteDiagnosticsResponse | null>(null);
  const [loadingRouteDiagnostics, setLoadingRouteDiagnostics] = useState(false);
  const [routeProbeSummaryByRouteId, setRouteProbeSummaryByRouteId] = useState<Record<number, RouteProbeSummary>>({});
  const [probingRouteId, setProbingRouteId] = useState<number | null>(null);
  const [probingBatch, setProbingBatch] = useState(false);
  const [diagnosticsExpanded, setDiagnosticsExpanded] = useState(false);
  const [governanceExpanded, setGovernanceExpanded] = useState(false);
  const [showRuntimeStatus, setShowRuntimeStatus] = useState(false);
  const [runningGovernanceRecovery, setRunningGovernanceRecovery] = useState(false);
  const [visibleRouteCount, setVisibleRouteCount] = useState(ROUTE_RENDER_CHUNK);
  const [expandedSourceGroupMap, setExpandedSourceGroupMap] = useState<Record<string, boolean>>({});
  const [expandedRouteIds, setExpandedRouteIds] = useState<number[]>([]);
  const [addChannelModalRouteId, setAddChannelModalRouteId] = useState<number | null>(null);
  const isMobile = useIsMobile();

  const {
    channelsByRouteId,
    loadingChannelsByRouteId,
    loadChannels,
    invalidateChannels,
    setChannels,
  } = useRouteChannels();

  const toast = useToast();

  const loadRouteDecisions = async (
    routeRows: RouteSummaryRow[],
    options?: { force?: boolean; refreshPricingCatalog?: boolean; persistSnapshots?: boolean },
  ) => {
    const rows = routeRows || [];
    const exactRoutes = rows.filter((route) => isRouteExactModel(route));
    const wildcardRouteIds = rows
      .filter((route) => !isRouteExactModel(route))
      .map((route) => route.id);

    const requestedModels = Array.from(new Set<string>(exactRoutes.map((route) => route.modelPattern)));

    const defaultState: Record<number, RouteDecision | null> = {};
    for (const route of rows) defaultState[route.id] = null;

    if (requestedModels.length === 0 && wildcardRouteIds.length === 0) {
      setDecisionByRoute(defaultState);
      setDecisionAutoSkipped(false);
      return;
    }

    const totalDecisionRequests = requestedModels.length + wildcardRouteIds.length;
    if (!options?.force && totalDecisionRequests > AUTO_ROUTE_DECISION_LIMIT) {
      setDecisionByRoute(defaultState);
      setDecisionAutoSkipped(true);
      return;
    }

    setLoadingDecision(true);
    try {
      setDecisionAutoSkipped(false);
      const decisionRequestOptions = options?.refreshPricingCatalog
        ? {
          refreshPricingCatalog: true as const,
          ...(options?.persistSnapshots ? { persistSnapshots: true as const } : {}),
        }
        : options?.persistSnapshots
          ? { persistSnapshots: true as const }
          : undefined;
      const [exactRes, wildcardRes] = await Promise.all([
        requestedModels.length > 0
          ? api.getRouteDecisionsBatch(requestedModels, decisionRequestOptions)
          : Promise.resolve({ decisions: {} }),
        wildcardRouteIds.length > 0
          ? api.getRouteWideDecisionsBatch(wildcardRouteIds, decisionRequestOptions)
          : Promise.resolve({ decisions: {} }),
      ]);

      const decisionMap = (exactRes?.decisions || {}) as Record<string, RouteDecision | null>;
      const wildcardDecisionMap = (wildcardRes?.decisions || {}) as Record<string, RouteDecision | null>;
      const next = { ...defaultState };
      for (const route of exactRoutes) {
        next[route.id] = decisionMap[route.modelPattern] || null;
      }
      for (const routeId of wildcardRouteIds) {
        next[routeId] = wildcardDecisionMap[String(routeId)] || null;
      }

      setDecisionByRoute(next);
    } catch {
      setDecisionByRoute(defaultState);
      setDecisionAutoSkipped(false);
    } finally {
      setLoadingDecision(false);
    }
  };

  const loadRouteDiagnostics = useCallback(async () => {
    setLoadingRouteDiagnostics(true);
    try {
      const res = await api.getRouteDiagnostics(120);
      startTransition(() => {
        setRouteDiagnostics(res as RouteDiagnosticsResponse);
      });
      return res as RouteDiagnosticsResponse;
    } catch (error) {
      startTransition(() => {
        setRouteDiagnostics(null);
      });
      throw error;
    } finally {
      setLoadingRouteDiagnostics(false);
    }
  }, []);

  const loadRouteOverview = useCallback(async () => {
    setLoadingRouteOverview(true);
    try {
      const res = await governanceApi.getRouteOverview();
      startTransition(() => {
        setRouteOverview(res);
      });
      return res;
    } finally {
      setLoadingRouteOverview(false);
    }
  }, [governanceApi]);

  const loadGovernanceSubjects = useCallback(async () => {
    setLoadingGovernanceSubjects(true);
    try {
      const res = await governanceApi.getRouteGovernanceSubjects(200);
      startTransition(() => {
        setGovernanceSubjects(Array.isArray(res?.items) ? res.items : []);
        setGovernanceSubjectsLoaded(true);
        setGovernanceSubjectsDirty(false);
      });
      return res;
    } finally {
      setLoadingGovernanceSubjects(false);
    }
  }, [governanceApi]);

  const refreshGovernanceSubjects = useCallback(async () => {
    if (!governanceExpanded) {
      setGovernanceSubjectsDirty(true);
      return null;
    }
    return loadGovernanceSubjects();
  }, [governanceExpanded, loadGovernanceSubjects]);

  const applyRouteCandidateRows = useCallback((candidateRows: any) => {
    startTransition(() => {
      setModelCandidates((candidateRows?.models || {}) as RouteModelCandidatesByModelName);
      setMissingTokenModelsByName(
        normalizeMissingTokenModels((candidateRows?.modelsWithoutToken || {}) as MissingTokenModelsByName),
      );
      setMissingTokenGroupModelsByName(
        normalizeMissingTokenModels((candidateRows?.modelsMissingTokenGroups || {}) as MissingTokenModelsByName),
      );
      setEndpointTypesByModel(candidateRows?.endpointTypesByModel || {});
      setRouteCandidatesLoaded(true);
    });
  }, []);

  const loadRouteCandidates = useCallback(async (force = false) => {
    if (routeCandidatesLoading) return;
    if (routeCandidatesLoaded && !force) return;
    setRouteCandidatesLoading(true);
    try {
      const candidateRows = await api.getModelTokenCandidates();
      applyRouteCandidateRows(candidateRows);
    } finally {
      setRouteCandidatesLoading(false);
    }
  }, [applyRouteCandidateRows, routeCandidatesLoaded, routeCandidatesLoading]);

  const ensureRouteCandidatesLoaded = useCallback(() => {
    if (!routeCandidatesLoaded && !routeCandidatesLoading) {
      void loadRouteCandidates();
    }
  }, [loadRouteCandidates, routeCandidatesLoaded, routeCandidatesLoading]);

  const load = async (options?: { includeCandidates?: boolean; forceCandidates?: boolean }) => {
    const summaryRows = await api.getRoutesSummary();

    const summaries = (summaryRows || []) as RouteSummaryRow[];
    startTransition(() => {
      setRouteSummaries(summaries);
    });
    const shouldIncludeCandidates = !!options?.includeCandidates;
    let candidateRows: ModelTokenCandidatesPayload | undefined;
    if (shouldIncludeCandidates) {
      candidateRows = await api.getModelTokenCandidates() as ModelTokenCandidatesPayload;
      applyRouteCandidateRows(candidateRows);
    }
    const decisionPlaceholder: Record<number, RouteDecision | null> = {};
    for (const route of summaries) {
      decisionPlaceholder[route.id] = route.decisionSnapshot || null;
    }
    startTransition(() => {
      setDecisionByRoute(decisionPlaceholder);
      setDecisionAutoSkipped(
        summaries.some((route) => isRouteExactModel(route) && !(route.decisionSnapshot || route.decisionSnapshotAvailable)),
      );
    });
    return { summaries, candidateRows };
  };

  useEffect(() => {
    (async () => {
      try {
        await Promise.all([load(), loadRouteOverview()]);
      } catch {
        toast.error('加载路由配置失败');
      }
    })();
  }, [loadRouteOverview, toast]);

  useEffect(() => {
    if (!governanceExpanded || loadingGovernanceSubjects) return;
    if (governanceSubjectsLoaded && !governanceSubjectsDirty) return;
    void loadGovernanceSubjects().catch(() => {
      toast.error('加载系统隔离列表失败');
    });
  }, [
    governanceExpanded,
    governanceSubjectsDirty,
    governanceSubjectsLoaded,
    loadingGovernanceSubjects,
    loadGovernanceSubjects,
    toast,
  ]);

  useEffect(() => {
    if (!diagnosticsExpanded || routeDiagnostics || loadingRouteDiagnostics) return;
    void loadRouteDiagnostics().catch(() => {
      toast.error('加载路由诊断失败');
    });
  }, [diagnosticsExpanded, loadRouteDiagnostics, loadingRouteDiagnostics, routeDiagnostics, toast]);

  useEffect(() => {
    if (showZeroChannelRoutes || showFilters || showManual || !filterCollapsed) {
      ensureRouteCandidatesLoaded();
    }
  }, [ensureRouteCandidatesLoaded, filterCollapsed, showFilters, showManual, showZeroChannelRoutes]);

  const handleRefreshRouteDecisions = async () => {
    try {
      await Promise.all([
        loadRouteDecisions(routeSummaries, { force: true, refreshPricingCatalog: true, persistSnapshots: true }),
        loadRouteOverview(),
        diagnosticsExpanded ? loadRouteDiagnostics() : Promise.resolve(null),
      ]);
      toast.success(tr('路由决策已刷新'));
    } catch {
      toast.error(tr('刷新路由决策失败'));
    }
  };

  const handleResetRoutingRuntime = async () => {
    if (!window.confirm('确认清理路由运行时状态？这会清除通道冷却、连续失败计数、站点运行时惩罚和模型熔断，但不会删除历史统计。')) return;
    setResettingRoutingRuntime(true);
    try {
      const res = await api.resetRoutingRuntimeState();
      toast.success(`路由运行时状态已清理（通道 ${res.updatedChannels || 0} 个，模型熔断 ${res.clearedModelCircuits || 0} 条）`);
      const refreshed = await load({ includeCandidates: routeCandidatesLoaded, forceCandidates: routeCandidatesLoaded });
      await Promise.all([
        loadRouteDecisions(refreshed.summaries, { force: true, refreshPricingCatalog: true, persistSnapshots: true }),
        loadRouteOverview(),
        refreshGovernanceSubjects(),
        diagnosticsExpanded ? loadRouteDiagnostics() : Promise.resolve(null),
      ]);
    } catch (e: any) {
      toast.error(e.message || '清理路由运行时状态失败');
    } finally {
      setResettingRoutingRuntime(false);
    }
  };

  const exactRouteCount = useMemo(
    () => buildVisibleRouteList(routeSummaries, isExactModelPattern, matchesModelPattern)
      .filter((route) => isRouteExactModel(route)).length,
    [routeSummaries],
  );

  const zeroChannelPlaceholderRoutes = useMemo(
    () => buildZeroChannelPlaceholderRoutes(routeSummaries, missingTokenModelsByName, missingTokenGroupModelsByName),
    [routeSummaries, missingTokenModelsByName, missingTokenGroupModelsByName],
  );

  const visibleRouteRows = useMemo(
    () => (showZeroChannelRoutes ? [...routeSummaries, ...zeroChannelPlaceholderRoutes] : routeSummaries),
    [routeSummaries, showZeroChannelRoutes, zeroChannelPlaceholderRoutes],
  );

  const canSaveRoute = useMemo(() => {
    if (saving) return false;
    if (form.routeMode === 'explicit_group') {
      return !!form.displayName.trim() && form.sourceRouteKeys.length > 0;
    }
    return !!form.modelPattern.trim() && !getModelPatternError(form.modelPattern);
  }, [form.displayName, form.modelPattern, form.routeMode, form.sourceRouteKeys.length, saving]);

  const previewModelSamples = useMemo(() => {
    const names = new Set<string>();
    for (const modelName of Object.keys(modelCandidates || {})) {
      const normalized = modelName.trim();
      if (normalized) names.add(normalized);
    }
    for (const route of routeSummaries) {
      if (!isRouteExactModel(route)) continue;
      const normalized = route.modelPattern.trim();
      if (normalized) names.add(normalized);
    }
    return Array.from(names)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }, [modelCandidates, routeSummaries]);

  const sourceRouteOptions = useMemo<SourceRouteOption[]>(() => {
    const exactRoutes = routeSummaries.filter((route) => isRouteExactModel(route));
    const coveredModels = new Set<string>();
    const options: SourceRouteOption[] = exactRoutes.map((route) => {
      const modelName = route.modelPattern.trim();
      if (modelName) coveredModels.add(modelName);
      return {
        ...route,
        sourceKey: resolveSourceKeyFromRoute(route),
        backingRouteId: route.id,
      };
    });

    const fallbackSiteNamesByModel = new Map<string, string[]>();
    const mergeSiteNames = (modelName: string, siteNames: string[]) => {
      if (siteNames.length === 0) return;
      const existing = new Set(fallbackSiteNamesByModel.get(modelName) || []);
      for (const siteName of siteNames) existing.add(siteName);
      fallbackSiteNamesByModel.set(
        modelName,
        Array.from(existing).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
      );
    };

    for (const [modelName, candidates] of Object.entries(modelCandidates || {})) {
      const normalized = modelName.trim();
      if (!normalized) continue;
      mergeSiteNames(
        normalized,
        (candidates || []).map((item) => String(item.siteName || '').trim()).filter(Boolean),
      );
    }
    for (const [modelName, accounts] of Object.entries(missingTokenModelsByName || {})) {
      const normalized = modelName.trim();
      if (!normalized) continue;
      mergeSiteNames(
        normalized,
        (accounts || []).map((item) => String(item.siteName || '').trim()).filter(Boolean),
      );
    }
    for (const [modelName, accounts] of Object.entries(missingTokenGroupModelsByName || {})) {
      const normalized = modelName.trim();
      if (!normalized) continue;
      mergeSiteNames(
        normalized,
        (accounts || []).map((item) => String(item.siteName || '').trim()).filter(Boolean),
      );
    }

    for (const route of routeSummaries) {
      const modelName = route.modelPattern.trim();
      if (!modelName) continue;
      if (!isRouteExactModel(route)) continue;
      coveredModels.add(modelName);
    }

    const virtualModelNames = new Set<string>();
    for (const modelName of Object.keys(modelCandidates || {})) {
      const normalized = modelName.trim();
      if (normalized && !coveredModels.has(normalized)) virtualModelNames.add(normalized);
    }
    for (const modelName of Object.keys(missingTokenModelsByName || {})) {
      const normalized = modelName.trim();
      if (normalized && !coveredModels.has(normalized)) virtualModelNames.add(normalized);
    }
    for (const modelName of Object.keys(missingTokenGroupModelsByName || {})) {
      const normalized = modelName.trim();
      if (normalized && !coveredModels.has(normalized)) virtualModelNames.add(normalized);
    }

    for (const modelName of Array.from(virtualModelNames).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))) {
      const channelCount = (modelCandidates[modelName] || []).length;
      const enabledChannelCount = channelCount;
      options.push({
        id: 0,
        modelPattern: modelName,
        displayName: null,
        displayIcon: null,
        routeMode: 'pattern',
        probePolicy: 'system',
        sourceRouteIds: [],
        modelMapping: null,
        routingStrategy: null,
        enabled: true,
        channelCount,
        enabledChannelCount,
        siteNames: fallbackSiteNamesByModel.get(modelName) || [],
        decisionSnapshot: null,
        decisionRefreshedAt: null,
        sourceKey: buildVirtualSourceRouteKey(modelName),
        backingRouteId: null,
        isVirtual: true,
        readOnly: true,
      });
    }

    return options;
  }, [modelCandidates, missingTokenGroupModelsByName, missingTokenModelsByName, routeSummaries]);

  const sourceEndpointTypesBySourceKey = useMemo(() => {
    const next: Record<string, string[]> = {};
    for (const option of sourceRouteOptions) {
      next[option.sourceKey] = Array.from(endpointTypesByModel[option.modelPattern] || [])
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    }
    return next;
  }, [endpointTypesByModel, sourceRouteOptions]);

  const resetRouteForm = () => {
    setForm(EMPTY_ROUTE_FORM);
    setEditingRouteId(null);
  };

  const resolveExplicitGroupSourceRouteIds = useCallback(async (sourceRouteKeys: string[]): Promise<number[]> => {
    const normalizedKeys = Array.from(new Set(
      (sourceRouteKeys || []).map((key) => String(key || '').trim()).filter(Boolean),
    ));
    if (normalizedKeys.length === 0) return [];

    const exactRouteById = new Map<number, RouteSummaryRow>();
    const exactRouteByModel = new Map<string, RouteSummaryRow[]>();
    for (const route of routeSummaries) {
      if (!isRouteExactModel(route)) continue;
      const modelName = route.modelPattern.trim();
      if (!modelName) continue;
      exactRouteById.set(route.id, route);
      if (!exactRouteByModel.has(modelName)) exactRouteByModel.set(modelName, []);
      exactRouteByModel.get(modelName)!.push(route);
    }

    const resolvedIds: number[] = [];
    for (const sourceKey of normalizedKeys) {
      if (sourceKey.startsWith('route:')) {
        const routeId = Number.parseInt(sourceKey.slice('route:'.length), 10);
        const existingRoute = Number.isFinite(routeId) ? exactRouteById.get(routeId) : null;
        if (!existingRoute?.id) {
          throw new Error(`来源模型路由不存在: ${sourceKey}`);
        }
        resolvedIds.push(existingRoute.id);
        continue;
      }

      const modelName = sourceKey.startsWith('model:') ? sourceKey.slice('model:'.length).trim() : '';
      if (!modelName) continue;

      const existingRoutes = exactRouteByModel.get(modelName) || [];
      if (existingRoutes[0]?.id) {
        resolvedIds.push(existingRoutes[0].id);
        continue;
      }

      const created = await api.addRoute({
        routeMode: 'pattern',
        probePolicy: 'system',
        modelPattern: modelName,
      }) as RouteSummaryRow;
      if (!created?.id) {
        throw new Error(`自动补建来源模型失败: ${modelName}`);
      }
      exactRouteById.set(created.id, created);
      exactRouteByModel.set(modelName, [created]);
      resolvedIds.push(created.id);
    }

    return Array.from(new Set(resolvedIds));
  }, [routeSummaries]);

  const handleAddRoute = async () => {
    const trimmedDisplayName = form.displayName.trim() ? form.displayName.trim() : undefined;
    const trimmedDisplayIcon = form.displayIcon.trim() ? form.displayIcon.trim() : undefined;
    const trimmedModelPattern = form.modelPattern.trim();
    const routeMode = normalizeRouteMode(form.routeMode);
    if (routeMode === 'explicit_group') {
      if (!trimmedDisplayName) {
        toast.error('请填写对外模型名');
        return;
      }
      if (form.sourceRouteKeys.length === 0) {
        toast.error('请至少选择一个来源模型');
        return;
      }
    } else {
      if (!trimmedModelPattern) return;
      const modelPatternError = getModelPatternError(form.modelPattern);
      if (modelPatternError) {
        toast.error(modelPatternError);
        return;
      }
    }

    setSaving(true);
    try {
      const selectedSourceRouteIds = routeMode === 'explicit_group'
        ? await resolveExplicitGroupSourceRouteIds(form.sourceRouteKeys)
        : [];
      if (editingRouteId) {
        const currentRoute = routeSummaries.find((route) => route.id === editingRouteId) || null;
        const modelPatternChanged = routeMode === 'pattern' && !!currentRoute && currentRoute.modelPattern !== trimmedModelPattern;
        await api.updateRoute(editingRouteId, {
          routeMode,
          probePolicy: form.probePolicy,
          ...(routeMode === 'pattern' ? { modelPattern: trimmedModelPattern } : {}),
          displayName: trimmedDisplayName,
          displayIcon: trimmedDisplayIcon,
          ...(routeMode === 'explicit_group' ? { sourceRouteIds: selectedSourceRouteIds } : {}),
        });
        toast.success(routeMode === 'pattern' && modelPatternChanged ? tr('群组已更新并重新匹配通道') : tr('群组已更新'));
      } else {
        await api.addRoute({
          routeMode,
          probePolicy: form.probePolicy,
          ...(routeMode === 'pattern' ? { modelPattern: trimmedModelPattern } : {}),
          displayName: trimmedDisplayName,
          displayIcon: trimmedDisplayIcon,
          ...(routeMode === 'explicit_group' ? { sourceRouteIds: selectedSourceRouteIds } : {}),
        });
        toast.success(tr('群组已创建'));
      }
      const refreshed = await load({ includeCandidates: routeMode === 'explicit_group' || routeCandidatesLoaded, forceCandidates: routeMode === 'explicit_group' || routeCandidatesLoaded });
      await Promise.all([
        loadRouteOverview(),
        refreshGovernanceSubjects(),
      ]);
      if (routeMode === 'explicit_group') {
        const feedback = buildExplicitGroupSaveFeedback(selectedSourceRouteIds, refreshed.summaries, refreshed.candidateRows);
        if (feedback) {
          toast.info(formatExplicitGroupSaveFeedback(feedback));
        }
      }
      setShowManual(false);
      resetRouteForm();
      setShowOnlyManualRoutes(true);
      setActiveBrand(null);
      setActiveSite(null);
      setActiveEndpointType(null);
      setActiveGroupFilter(null);
      setSearch('');
    } catch (e: any) {
      toast.error(e.message || (editingRouteId ? tr('更新群组失败') : tr('创建群组失败')));
    } finally {
      setSaving(false);
    }
  };

  const handleEditRoute = (route: RouteSummaryRow) => {
    setEditingRouteId(route.id);
    const routeMode = normalizeRouteMode(route.routeMode);
    setForm({
      routeMode,
      probePolicy: isManualGovernedRoute(route) ? 'manual' : 'system',
      modelPattern: route.modelPattern || '',
      displayName: route.displayName || '',
      displayIcon: normalizeRouteDisplayIconValue(route.displayIcon),
      sourceRouteKeys: routeMode === 'explicit_group'
        ? routeSummaries
          .filter((candidate) => (route.sourceRouteIds || []).includes(candidate.id))
          .map((candidate) => resolveSourceKeyFromRoute(candidate))
        : [],
      advancedOpen: routeMode === 'pattern',
    });
    setShowManual(true);
    ensureRouteCandidatesLoaded();
  };

  const handleCancelEditRoute = () => {
    resetRouteForm();
    setShowManual(false);
  };

  const handleDeleteRoute = async (routeId: number) => {
    try {
      await api.deleteRoute(routeId);
      toast.success('路由已删除');
      await Promise.all([
        load({ includeCandidates: routeCandidatesLoaded }),
        loadRouteOverview(),
        refreshGovernanceSubjects(),
      ]);
    } catch (e: any) {
      toast.error(e.message || '删除路由失败');
    }
  };

  const handleToggleRouteEnabled = async (route: RouteSummaryRow) => {
    const newEnabled = !route.enabled;
    setRouteSummaries((prev) =>
      prev.map((item) => (item.id === route.id ? { ...item, enabled: newEnabled } : item)),
    );
    try {
      await api.updateRoute(route.id, { enabled: newEnabled });
      await loadRouteOverview();
      toast.success(newEnabled ? '路由已启用' : '路由已禁用');
    } catch (e: any) {
      setRouteSummaries((prev) =>
        prev.map((item) => (item.id === route.id ? { ...item, enabled: route.enabled } : item)),
      );
      toast.error(e.message || '切换路由状态失败');
    }
  };

  const handleRoutingStrategyChange = async (route: RouteSummaryRow, routingStrategy: RouteRoutingStrategy) => {
    const currentStrategy = normalizeRouteRoutingStrategyValue(route.routingStrategy);
    if (routingStrategy === currentStrategy) return;

    setUpdatingRoutingStrategyByRoute((prev) => ({ ...prev, [route.id]: true }));
    setRouteSummaries((prev) => prev.map((item) => (
      item.id === route.id
        ? { ...item, routingStrategy }
        : item
    )));
    try {
      await api.updateRoute(route.id, { routingStrategy });
      toast.success(getRouteRoutingStrategySuccessMessage(routingStrategy));
    } catch (e: any) {
      setRouteSummaries((prev) => prev.map((item) => (
        item.id === route.id
          ? { ...item, routingStrategy: currentStrategy }
          : item
      )));
      toast.error(e.message || '更新路由策略失败');
      return;
    } finally {
      setUpdatingRoutingStrategyByRoute((prev) => ({ ...prev, [route.id]: false }));
    }

    try {
      await Promise.all([load(), loadRouteOverview(), refreshGovernanceSubjects()]);
    } catch (e: any) {
      toast.error(e?.message || '路由策略已保存，但刷新列表失败');
    }
  };

  // Stable derived value: only changes when route patterns change (not on enabled toggle)
  const routePatterns = useMemo(
    () => visibleRouteRows.map((r) => ({ id: r.id, modelPattern: r.modelPattern, routeMode: r.routeMode })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [visibleRouteRows.map((r) => `${r.id}:${r.modelPattern}:${r.routeMode || 'pattern'}`).join(',')],
  );

  const routeBrandById = useMemo(() => {
    const next = new Map<number, BrandInfo | null>();
    for (const route of visibleRouteRows) {
      next.set(route.id, resolveRouteBrand(route));
    }
    return next;
  }, [visibleRouteRows]);

  const listVisibleRoutes = useMemo(
    () => buildVisibleRouteList(visibleRouteRows, isExactModelPattern, matchesModelPattern),
    [visibleRouteRows],
  );

  const brandList = useMemo(() => {
    const grouped = new Map<string, { count: number; brand: BrandInfo }>();
    let otherCount = 0;

    for (const route of listVisibleRoutes) {
      const brand = routeBrandById.get(route.id) || null;
      if (!brand) {
        otherCount++;
        continue;
      }

      const existing = grouped.get(brand.name);
      if (existing) {
        existing.count++;
      } else {
        grouped.set(brand.name, { count: 1, brand });
      }
    }

    return {
      list: [...grouped.entries()].sort((a, b) => {
        if (a[1].count === b[1].count) return a[0].localeCompare(b[0]);
        return b[1].count - a[1].count;
      }) as [string, { count: number; brand: BrandInfo }][],
      otherCount,
    };
  }, [listVisibleRoutes, routeBrandById]);

  const siteList = useMemo(() => {
    const grouped = new Map<string, { count: number; siteId: number }>();

    for (const route of listVisibleRoutes) {
      const seenSites = new Set<string>();
      for (const siteName of route.siteNames || []) {
        if (!siteName || seenSites.has(siteName)) continue;
        seenSites.add(siteName);

        const existing = grouped.get(siteName);
        if (existing) {
          existing.count++;
        } else {
          grouped.set(siteName, { count: 1, siteId: 0 });
        }
      }
    }

    return [...grouped.entries()].sort((a, b) => {
      if (a[1].count === b[1].count) return a[0].localeCompare(b[0]);
      return b[1].count - a[1].count;
    }) as [string, { count: number; siteId: number }][];
  }, [listVisibleRoutes]);

  const routeEndpointTypesByRouteId = useMemo(() => {
    const index: Record<number, Set<string>> = {};
    const entries = Object.entries(endpointTypesByModel || {});
    for (const route of routePatterns) {
      const pattern = (route.modelPattern || '').trim();
      if (!pattern) {
        index[route.id] = new Set<string>();
        continue;
      }
      const endpointTypes = new Set<string>();
      for (const [modelName, rawTypes] of entries) {
        if (!matchesModelPattern(modelName, pattern)) continue;
        for (const rawType of Array.isArray(rawTypes) ? rawTypes : []) {
          const endpointType = String(rawType || '').trim();
          if (!endpointType) continue;
          endpointTypes.add(endpointType);
        }
      }
      // Fallback: infer from siteNames isn't possible without platform info,
      // but we'll keep endpoint types from model availability
      index[route.id] = endpointTypes;
    }
    return index;
  }, [routePatterns, endpointTypesByModel]);

  const endpointTypeList = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const route of listVisibleRoutes) {
      const endpointTypes = routeEndpointTypesByRouteId[route.id] || new Set<string>();
      for (const endpointType of endpointTypes) {
        grouped.set(endpointType, (grouped.get(endpointType) || 0) + 1);
      }
    }
    return [...grouped.entries()].sort((a, b) => {
      if (a[1] === b[1]) return a[0].localeCompare(b[0], undefined, { sensitivity: 'base' });
      return b[1] - a[1];
    }) as [string, number][];
  }, [listVisibleRoutes, routeEndpointTypesByRouteId]);

  const routeBrandIconCandidates = useMemo(() => {
    const byIcon = new Map<string, BrandInfo>();

    for (const route of visibleRouteRows) {
      const brand = resolveRouteBrand(route);
      if (brand) byIcon.set(brand.icon, brand);
    }

    for (const modelName of Object.keys(modelCandidates || {})) {
      const brand = getBrand(modelName);
      if (brand) byIcon.set(brand.icon, brand);
    }

    return Array.from(byIcon.values())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }, [visibleRouteRows, modelCandidates]);

  const routeIconSelectOptions = useMemo<RouteIconOption[]>(() => ([
    ...ROUTE_ICON_OPTIONS,
    ...routeBrandIconCandidates.map((brand) => ({
      value: toBrandIconValue(brand.icon),
      label: brand.name,
      description: `${brand.name} 品牌图标`,
      iconNode: <BrandGlyph brand={brand} size={14} fallbackText={brand.name} />,
    })),
  ]), [routeBrandIconCandidates]);

  const groupRouteList = useMemo<GroupRouteItem[]>(() => (
    listVisibleRoutes
      .filter((route) => !isRouteExactModel(route))
      .map((route) => ({
        id: route.id,
        title: resolveRouteTitle(route),
        icon: resolveRouteIcon(route),
        brand: routeBrandById.get(route.id) || null,
        modelPattern: route.modelPattern,
        channelCount: route.channelCount,
        sourceRouteCount: Array.isArray(route.sourceRouteIds) ? route.sourceRouteIds.length : 0,
      }))
      .sort((a, b) => {
        if (a.channelCount === b.channelCount) return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
        return b.channelCount - a.channelCount;
      })
  ), [listVisibleRoutes, routeBrandById]);

  const activeGroupRoute = useMemo(() => {
    if (typeof activeGroupFilter !== 'number') return null;
    return listVisibleRoutes.find((route) => route.id === activeGroupFilter) || null;
  }, [activeGroupFilter, listVisibleRoutes]);

  const sortedRoutes = useMemo(() => (
    [...listVisibleRoutes].sort((a, b) => {
      if (sortBy === 'channelCount') {
        const countCmp = a.channelCount - b.channelCount;
        if (countCmp !== 0) return sortDir === 'asc' ? countCmp : -countCmp;
      }

      const nameCmp = a.modelPattern.localeCompare(b.modelPattern, undefined, { sensitivity: 'base' });
      return sortDir === 'asc' ? nameCmp : -nameCmp;
    })
  ), [listVisibleRoutes, sortBy, sortDir]);

  const filteredRoutes = useMemo(() => {
    let list = sortedRoutes;

    if (showOnlyManualRoutes) {
      list = list.filter((route) => isManualGovernedRoute(route));
    }

    if (activeGroupFilter === '__all__') {
      list = list.filter((route) => !isRouteExactModel(route));
    } else if (typeof activeGroupFilter === 'number') {
      list = list.filter((route) => route.id === activeGroupFilter);
    }

    if (activeBrand) {
      if (activeBrand === '__other__') {
        list = list.filter((route) => !(routeBrandById.get(route.id) || null));
      } else {
        list = list.filter((route) => (routeBrandById.get(route.id)?.name || '') === activeBrand);
      }
    }

    if (activeSite) {
      list = list.filter((route) =>
        route.siteNames?.includes(activeSite),
      );
    }

    if (activeEndpointType) {
      list = list.filter((route) =>
        (routeEndpointTypesByRouteId[route.id] || new Set<string>()).has(activeEndpointType),
      );
    }

    if (deferredSearch) {
      const q = deferredSearch.toLowerCase();
      list = list.filter((route) => {
        const modelPattern = route.modelPattern.toLowerCase();
        const displayName = (route.displayName || '').toLowerCase();
        const title = resolveRouteTitle(route).toLowerCase();
        return modelPattern.includes(q) || displayName.includes(q) || title.includes(q);
      });
    }

    return list;
  }, [
    sortedRoutes,
    activeGroupFilter,
    activeBrand,
    activeSite,
    activeEndpointType,
    showOnlyManualRoutes,
    deferredSearch,
    routeBrandById,
    routeEndpointTypesByRouteId,
  ]);

  useEffect(() => {
    setVisibleRouteCount(getInitialVisibleCount(filteredRoutes.length, ROUTE_RENDER_CHUNK));
  }, [filteredRoutes.length]);

  const handleLoadMoreRoutes = useCallback(() => {
    setVisibleRouteCount((current) => getNextVisibleCount(current, filteredRoutes.length, ROUTE_RENDER_CHUNK));
  }, [filteredRoutes.length]);

  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = loadMoreSentinelRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0]?.isIntersecting) handleLoadMoreRoutes(); },
      { rootMargin: '200px' },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [handleLoadMoreRoutes]);

  const visibleRoutes = useMemo(
    () => filteredRoutes.slice(0, visibleRouteCount),
    [filteredRoutes, visibleRouteCount],
  );

  const routeModelCandidateIndex = useMemo(
    () => buildRouteModelCandidatesIndex(routePatterns, modelCandidates, matchesModelPattern),
    [routePatterns, modelCandidates],
  );

  const routeMissingTokenIndex = useMemo(
    () => buildRouteMissingTokenIndex(routePatterns, missingTokenModelsByName, matchesModelPattern),
    [routePatterns, missingTokenModelsByName],
  );
  const routeMissingTokenGroupIndex = useMemo(
    () => buildRouteMissingTokenIndex(routePatterns, missingTokenGroupModelsByName, matchesModelPattern),
    [routePatterns, missingTokenGroupModelsByName],
  );

  const explicitGroupSourceHealthByRouteId = useMemo<Record<number, ExplicitGroupSourceHealthSummary>>(() => {
    const result: Record<number, ExplicitGroupSourceHealthSummary> = {};
    for (const route of filteredRoutes) {
      if (!isExplicitGroupRoute(route)) continue;
      const summary = buildExplicitGroupSaveFeedback(route.sourceRouteIds || [], routeSummaries, {
        models: modelCandidates,
        modelsWithoutToken: missingTokenModelsByName,
        modelsMissingTokenGroups: missingTokenGroupModelsByName,
        endpointTypesByModel,
      });
      if (summary) {
        result[route.id] = summary;
      }
    }
    return result;
  }, [endpointTypesByModel, filteredRoutes, missingTokenGroupModelsByName, missingTokenModelsByName, modelCandidates, routeSummaries]);

  const routeFaultOverview = useMemo(() => {
    const nowIso = new Date().toISOString();
    let routesWithDecisions = 0;
    let cooldownChannels = 0;
    let avoidedChannels = 0;
    let modelCircuitChannels = 0;
    let siteRuntimeChannels = 0;
    let zeroChannelRoutes = 0;
    let sourceIssueRoutes = 0;

    for (const route of filteredRoutes) {
      if ((route.channelCount || 0) === 0 || route.kind === 'zero_channel' || route.readOnly === true || route.isVirtual === true) {
        zeroChannelRoutes += 1;
      }

      if (isExplicitGroupRoute(route)) {
        const sourceHealth = explicitGroupSourceHealthByRouteId[route.id];
        if (
          sourceHealth
          && (
            sourceHealth.zeroChannelRoutes.length > 0
            || sourceHealth.missingTokenRoutes.length > 0
            || sourceHealth.missingGroupRoutes.length > 0
          )
        ) {
          sourceIssueRoutes += 1;
        }
      }

      const decision = decisionByRoute[route.id];
      const candidates = decision?.candidates || [];
      if (candidates.length === 0) continue;
      routesWithDecisions += 1;
      for (const candidate of candidates) {
        if (hasActiveCooldown(candidate, nowIso)) cooldownChannels += 1;
        if (candidate.avoidedByRecentFailure) avoidedChannels += 1;
        if (hasModelCircuitIssue(candidate)) modelCircuitChannels += 1;
        if (hasSiteRuntimeIssue(candidate)) siteRuntimeChannels += 1;
      }
    }

    return {
      totalRoutes: filteredRoutes.length,
      routesWithDecisions,
      cooldownChannels,
      avoidedChannels,
      modelCircuitChannels,
      siteRuntimeChannels,
      zeroChannelRoutes,
      sourceIssueRoutes,
    };
  }, [decisionByRoute, explicitGroupSourceHealthByRouteId, filteredRoutes]);

  const routeDiagnosticsHighlights = useMemo(() => {
    const diagnostics = routeDiagnostics;
    if (!diagnostics) {
      return {
        generatedAtLabel: '未加载',
        endpointRuntimeBlocked: 0,
        modelCircuitOpen: 0,
        runtimeBreakerOpen: 0,
        unavailableBlocking: 0,
        checkinAttention: 0,
        checkinSiteBackoffBlocked: 0,
      };
    }
    const generatedAtLabel = diagnostics.generatedAt
      ? new Date(diagnostics.generatedAt).toLocaleString()
      : '未知';
    return {
      generatedAtLabel,
      endpointRuntimeBlocked: diagnostics.endpointRuntimeMemory.items
        .reduce((sum, item) => sum + (Array.isArray(item.activeBlocks) ? item.activeBlocks.length : 0), 0),
      modelCircuitOpen: diagnostics.modelCircuits.openCount || 0,
      runtimeBreakerOpen: diagnostics.siteRuntimeHealth.breakerOpenCount || 0,
      unavailableBlocking: diagnostics.unavailableModels.blockingCount || 0,
      checkinAttention: diagnostics.checkinTodo.attentionCount || 0,
      checkinSiteBackoffBlocked: diagnostics.checkinSiteRuntime.blockedCount || 0,
    };
  }, [routeDiagnostics]);

  const governanceReasonLabels = useMemo<Record<string, string>>(() => ({
    auth: '鉴权失效',
    rate_limit: '限流中',
    balance_exhausted: '余额不足',
    quota_exhausted: '额度不足',
    model_unsupported: '模型不可用',
    manual_recheck_needed: '待复测',
  }), []);

  const governanceOverview = useMemo(() => {
    const overview = routeOverview?.governance;
    if (!overview) {
      return {
        total: 0,
        suppressed: 0,
        probing: 0,
        byReasonEntries: [] as Array<{ code: string; label: string; count: number }>,
      };
    }
    const byReasonEntries = Object.entries(overview.byReason || {})
      .map(([code, count]) => ({
        code,
        label: governanceReasonLabels[code] || code,
        count: Number(count || 0),
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    return {
      total: overview.total || 0,
      suppressed: overview.suppressed || 0,
      probing: overview.probing || 0,
      byReasonEntries,
    };
  }, [governanceReasonLabels, routeOverview]);

  const handleRunGovernanceRecoveryPass = async () => {
    try {
      setRunningGovernanceRecovery(true);
      const res = await governanceApi.runRouteGovernanceRecoveryPass({ limit: 50, includeProbing: true });
      toast.success(
        `到期治理已处理（扫描 ${res.scanned} 条，转入主动复测 ${res.promotedToProbing} 条，被动恢复 ${res.restored} 条）`,
      );
      await Promise.all([
        loadRouteOverview(),
        refreshGovernanceSubjects(),
      ]);
    } catch (error: any) {
      toast.error(error?.message || '执行恢复轮转失败');
    } finally {
      setRunningGovernanceRecovery(false);
    }
  };

  const getRouteCandidateView = (routeId: number): RouteCandidateView => {
    return routeModelCandidateIndex[routeId] || EMPTY_ROUTE_CANDIDATE_VIEW;
  };

  const routeById = useMemo(
    () => new Map(visibleRouteRows.map((route) => [route.id, route])),
    [visibleRouteRows],
  );

  const handleCreateTokenForMissingAccount = (accountId: number, modelName: string) => {
    if (!Number.isFinite(accountId) || accountId <= 0) return;
    const params = new URLSearchParams();
    params.set('create', '1');
    params.set('accountId', String(accountId));
    params.set('model', modelName);
    params.set('from', 'routes');
    navigate(`/tokens?${params.toString()}`);
  };

  const navigateToCredentialDiagnostics = (targetType: 'site' | 'account' | 'token', targetId: number) => {
    if (!Number.isFinite(targetId) || targetId <= 0) return;
    navigate(buildDiagnosticPath(targetType, targetId));
  };

  const handleDeleteChannel = async (channelId: number, routeId: number) => {
    try {
      await api.deleteChannel(channelId);
      toast.success('通道已移除');
      // Reload channels for this route
      await loadChannels(routeId, true);
      // Update channel count in summary
      setRouteSummaries((prev) =>
        prev.map((r) => r.id === routeId ? { ...r, channelCount: Math.max(0, r.channelCount - 1) } : r),
      );
    } catch (e: any) {
      toast.error(e.message || '移除通道失败');
    }
  };

  const handleChannelTokenSave = async (routeId: number, channelId: number, accountId: number) => {
    const tokenId = channelTokenDraft[channelId];
    const tokenOptions = getRouteCandidateView(routeId).tokenOptionsByAccountId[accountId] || [];

    if (tokenId && tokenOptions.length > 0 && !tokenOptions.some((token) => token.id === tokenId)) {
      toast.error('该令牌不支持当前模型');
      return;
    }

    setUpdatingChannel((prev) => ({ ...prev, [channelId]: true }));
    try {
      await api.updateChannel(channelId, { tokenId: tokenId || null });
      toast.success('通道令牌已更新');
      await loadChannels(routeId, true);
    } catch (e: any) {
      toast.error(e.message || '更新令牌失败');
    } finally {
      setUpdatingChannel((prev) => ({ ...prev, [channelId]: false }));
    }
  };

  const handleChannelDragEnd = async (routeId: number, event: DragEndEvent) => {
    if (savingPriorityByRoute[routeId]) return;

    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const channels = channelsByRouteId[routeId] || [];
    const oldIndex = channels.findIndex((channel) => channel.id === Number(active.id));
    const newIndex = channels.findIndex((channel) => channel.id === Number(over.id));

    if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return;

    const previousChannels = [...channels];
    const reordered = arrayMove(channels, oldIndex, newIndex).map((channel, index) => ({
      ...channel,
      priority: index,
    }));

    setChannels(routeId, reordered);
    setSavingPriorityByRoute((prev) => ({ ...prev, [routeId]: true }));

    try {
      await api.batchUpdateChannels(
        reordered.map((channel) => ({
          id: channel.id,
          priority: channel.priority,
        })),
      );

      const route = routeSummaries.find((r) => r.id === routeId);
      if (route && isRouteExactModel(route)) {
        try {
          const res = await api.getRouteDecision(route.modelPattern);
          setDecisionByRoute((prev) => ({
            ...prev,
            [routeId]: (res?.decision || null) as RouteDecision | null,
          }));
        } catch {
          // ignore route decision refresh failures after reorder
        }
      }
    } catch (e: any) {
      setChannels(routeId, previousChannels);
      toast.error(e.message || '保存通道优先级失败，已回滚');
    } finally {
      setSavingPriorityByRoute((prev) => ({ ...prev, [routeId]: false }));
    }
  };

  const handleProbeRouteChannels = async (route: RouteSummaryRow) => {
    if (route.kind === 'zero_channel' || route.readOnly === true || route.isVirtual === true) {
      toast.error('当前路由不支持批量探测通道');
      return;
    }
    setProbingRouteId(route.id);
    try {
      const result = await api.probeRouteChannels(route.id, {
        limit: 80,
        autoGovernance: true,
      }) as RouteProbeResponse;
      setRouteProbeSummaryByRouteId((prev) => ({ ...prev, [route.id]: result }));
      await Promise.all([
        loadRouteOverview(),
        refreshGovernanceSubjects(),
      ]);
      const availableItems = result.items.filter((item) => item.available);
      const reallyUnavailable = result.items.filter((item) => !item.available && item.detectionMethod !== 'unknown');
      const skippedItems = result.items.filter((item) => !item.available && item.detectionMethod === 'unknown');
      const suppressedCount = result.items.filter((item) => item.governanceAction === 'suppressed').length;
      const availablePreview = availableItems.slice(0, 5)
        .map((item) => item.siteName)
        .join('、');
      const unavailablePreview = reallyUnavailable.slice(0, 3)
        .map((item) => `${item.siteName}${item.tokenName ? `/${item.tokenName}` : ''}`)
        .join('、');
      let msg = `探测完成：${availableItems.length} 可用`
        + (skippedItems.length > 0 ? `，${reallyUnavailable.length} 不可用，${skippedItems.length} 跳过` : `，${reallyUnavailable.length} 不可用`);
      msg += `（共 ${result.total} 个通道）`;
      if (availablePreview) {
        msg += `\n可用：${availablePreview}${availableItems.length > 5 ? ' ...' : ''}`;
      }
      if (unavailablePreview) {
        msg += `\n不可用：${unavailablePreview}${reallyUnavailable.length > 3 ? ' ...' : ''}`;
      }
      if (suppressedCount > 0) {
        msg += `\n已隔离 ${suppressedCount} 个`;
      }
      if (availableItems.length > 0) {
        toast.success(msg);
      } else {
        toast.error(msg);
      }
    } catch (error: any) {
      toast.error(error?.message || '批量探测通道失败');
    } finally {
      setProbingRouteId(null);
    }
  };

  const toggleExpand = async (routeId: number) => {
    const isCurrentlyExpanded = expandedRouteIds.includes(routeId);
    if (isCurrentlyExpanded) {
      setExpandedRouteIds((prev) => prev.filter((id) => id !== routeId));
    } else {
      ensureRouteCandidatesLoaded();
      setExpandedRouteIds((prev) => [...prev, routeId]);
      // Load channels on demand
      const route = routeById.get(routeId) || null;
      const isReadOnlyRoute = route?.kind === 'zero_channel' || route?.readOnly === true || route?.isVirtual === true;
      if (!channelsByRouteId[routeId] && !isReadOnlyRoute) {
        try {
          await loadChannels(routeId);
        } catch {
          toast.error('加载通道失败');
        }
      }
    }
  };

  const missingTokenSiteItemsByRouteId = useMemo(() => {
    const result: Record<number, MissingTokenRouteSiteActionItem[]> = {};
    for (const routeId of Object.keys(routeMissingTokenIndex).map(Number)) {
      const missingTokenHints = routeMissingTokenIndex[routeId] || [];
      const siteMap = new Map<string, MissingTokenRouteSiteActionItem>();
      for (const hint of missingTokenHints) {
        for (const account of hint.accounts) {
          if (!Number.isFinite(account.accountId) || account.accountId <= 0) continue;
          const siteName = (account.siteName || '').trim() || `site-${account.siteId || 'unknown'}`;
          const key = `${account.siteId || 0}::${siteName.toLowerCase()}`;
          const accountLabel = account.username || `account-${account.accountId}`;
          const existing = siteMap.get(key);
          if (!existing) {
            siteMap.set(key, { key, siteName, accountId: account.accountId, accountLabel });
            continue;
          }
          if (account.accountId < existing.accountId) {
            existing.accountId = account.accountId;
            existing.accountLabel = accountLabel;
          }
        }
      }
      result[routeId] = Array.from(siteMap.values()).sort((a, b) => (
        a.siteName.localeCompare(b.siteName, undefined, { sensitivity: 'base' })
      ));
    }
    return result;
  }, [routeMissingTokenIndex]);

  const missingTokenGroupItemsByRouteId = useMemo(() => {
    const result: Record<number, MissingTokenGroupRouteSiteActionItem[]> = {};
    for (const routeId of Object.keys(routeMissingTokenGroupIndex).map(Number)) {
      const missingGroupHints = routeMissingTokenGroupIndex[routeId] || [];
      const siteMap = new Map<string, MissingTokenGroupRouteSiteActionItem>();
      for (const hint of missingGroupHints) {
        for (const account of hint.accounts) {
          if (!Number.isFinite(account.accountId) || account.accountId <= 0) continue;
          const siteName = (account.siteName || '').trim() || `site-${account.siteId || 'unknown'}`;
          const key = `${account.siteId || 0}::${siteName.toLowerCase()}`;
          const accountLabel = account.username || `account-${account.accountId}`;
          const missingGroups = Array.isArray(account.missingGroups) ? account.missingGroups : [];
          const requiredGroups = Array.isArray(account.requiredGroups) ? account.requiredGroups : [];
          const availableGroups = Array.isArray(account.availableGroups) ? account.availableGroups : [];
          const existing = siteMap.get(key);
          if (!existing) {
            siteMap.set(key, {
              key,
              siteName,
              accountId: account.accountId,
              accountLabel,
              missingGroups: [...missingGroups],
              requiredGroups: [...requiredGroups],
              availableGroups: [...availableGroups],
              ...(account.groupCoverageUncertain === true ? { groupCoverageUncertain: true } : {}),
            });
            continue;
          }
          if (account.accountId < existing.accountId) {
            existing.accountId = account.accountId;
            existing.accountLabel = accountLabel;
          }
          existing.missingGroups = Array.from(new Set([...existing.missingGroups, ...missingGroups]))
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
          existing.requiredGroups = Array.from(new Set([...existing.requiredGroups, ...requiredGroups]))
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
          existing.availableGroups = Array.from(new Set([...existing.availableGroups, ...availableGroups]))
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
          if (account.groupCoverageUncertain === true) {
            existing.groupCoverageUncertain = true;
          }
        }
      }
      result[routeId] = Array.from(siteMap.values()).sort((a, b) => (
        a.siteName.localeCompare(b.siteName, undefined, { sensitivity: 'base' })
      ));
    }
    return result;
  }, [routeMissingTokenGroupIndex]);

  // Stable callbacks for RouteCard memo (use refs to avoid dependency on closure variables)
  const toggleExpandRef = useRef(toggleExpand);
  toggleExpandRef.current = toggleExpand;
  const stableToggleExpand = useCallback((routeId: number) => toggleExpandRef.current(routeId), []);
  const handleEditRouteRef = useRef(handleEditRoute);
  handleEditRouteRef.current = handleEditRoute;
  const stableEditRoute = useCallback((route: RouteSummaryRow) => handleEditRouteRef.current(route), []);
  const handleDeleteRouteRef = useRef(handleDeleteRoute);
  handleDeleteRouteRef.current = handleDeleteRoute;
  const stableDeleteRoute = useCallback((routeId: number) => { handleDeleteRouteRef.current(routeId); }, []);
  const handleToggleEnabledRef = useRef(handleToggleRouteEnabled);
  handleToggleEnabledRef.current = handleToggleRouteEnabled;
  const stableToggleEnabled = useCallback((route: RouteSummaryRow) => { handleToggleEnabledRef.current(route); }, []);
  const handleRoutingStrategyChangeRef = useRef(handleRoutingStrategyChange);
  handleRoutingStrategyChangeRef.current = handleRoutingStrategyChange;
  const stableRoutingStrategyChange = useCallback(
    (route: RouteSummaryRow, strategy: RouteRoutingStrategy) => handleRoutingStrategyChangeRef.current(route, strategy),
    [],
  );
  const stableTokenDraftChange = useCallback(
    (channelId: number, tokenId: number) => setChannelTokenDraft((prev) => ({ ...prev, [channelId]: tokenId })),
    [],
  );
  const stableAddChannel = useCallback((routeId: number) => setAddChannelModalRouteId(routeId), []);
  const handleProbeRouteChannelsRef = useRef(handleProbeRouteChannels);
  handleProbeRouteChannelsRef.current = handleProbeRouteChannels;
  const stableProbeRouteChannels = useCallback((route: RouteSummaryRow) => handleProbeRouteChannelsRef.current(route), []);
  const stableToggleSourceGroup = useCallback(
    (groupKey: string) => setExpandedSourceGroupMap((prev) => ({ ...prev, [groupKey]: !prev[groupKey] })),
    [],
  );
  const handleChannelTokenSaveRef = useRef(handleChannelTokenSave);
  handleChannelTokenSaveRef.current = handleChannelTokenSave;
  const stableChannelTokenSave = useCallback(
    (routeId: number, channelId: number, accountId: number) => handleChannelTokenSaveRef.current(routeId, channelId, accountId),
    [],
  );
  const handleDeleteChannelRef = useRef(handleDeleteChannel);
  handleDeleteChannelRef.current = handleDeleteChannel;
  const stableDeleteChannel = useCallback(
    (channelId: number, routeId: number) => handleDeleteChannelRef.current(channelId, routeId),
    [],
  );
  const handleChannelDragEndRef = useRef(handleChannelDragEnd);
  handleChannelDragEndRef.current = handleChannelDragEnd;
  const stableChannelDragEnd = useCallback(
    (routeId: number, event: DragEndEvent) => handleChannelDragEndRef.current(routeId, event),
    [],
  );
  const handleCreateTokenRef = useRef(handleCreateTokenForMissingAccount);
  handleCreateTokenRef.current = handleCreateTokenForMissingAccount;
  const stableCreateTokenForMissing = useCallback(
    (accountId: number, modelName: string) => handleCreateTokenRef.current(accountId, modelName),
    [],
  );

  const addChannelModalRoute = addChannelModalRouteId
    ? routeSummaries.find((r) => r.id === addChannelModalRouteId) || null
    : null;

  const handleAddChannelSuccess = async () => {
    if (!addChannelModalRouteId) return;
    // Reload channels for this route
    await loadChannels(addChannelModalRouteId, true);
    // Refresh summary to update channel count
    await Promise.all([
      load({ includeCandidates: routeCandidatesLoaded }),
      loadRouteOverview(),
      refreshGovernanceSubjects(),
    ]);
  };

  return (
    <div className="page-shell animate-fade-in" style={{ minHeight: 400 }}>
      <div className="page-hero">
        <div className="page-kicker">Routing Control</div>
        <div className="page-header" style={{ marginBottom: 0 }}>
          <div>
            <h2 className="page-title">{tr('模型路由')}</h2>
            <p className="page-subtitle">
              查看模型到通道的映射、治理状态、故障避让与来源模型补建情况。这个页面的信息密度高，所以优先把搜索、排序和运行时治理操作集中到顶部。
            </p>
          </div>
          <div className="page-actions">
            <span className="badge badge-info" style={{ fontSize: 12, fontWeight: 500 }}>
              {tr('共')} {filteredRoutes.length} {tr('条路由')}
            </span>
          </div>
        </div>
      </div>

      {/* Toolbar: search + sort + actions */}
      <div className="card surface-card" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap', padding: 12 }}>
        <div className="toolbar-search" style={{ minWidth: 220, flex: 1, maxWidth: 360 }}>
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
            />
          </svg>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={tr('搜索模型路由...')}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ minWidth: 128 }}>
            <ModernSelect
              size="sm"
              value={sortBy}
              onChange={(nextValue) => {
                const nextSortBy = nextValue as RouteSortBy;
                setSortBy(nextSortBy);
                setSortDir(nextSortBy === 'modelPattern' ? 'asc' : 'desc');
              }}
              options={[
                { value: 'modelPattern', label: tr('模型名称') },
                { value: 'channelCount', label: tr('通道数量') },
              ]}
              placeholder={tr('排序字段')}
            />
          </div>
          <button
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 12px', fontSize: 12 }}
            onClick={() => setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
            data-tooltip={tr('切换排序方向')}
            aria-label={tr('切换排序方向')}
          >
            {sortDir === 'asc' ? tr('升序 ↑') : tr('降序 ↓')}
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, borderLeft: isMobile ? 'none' : '1px solid var(--color-border)', paddingLeft: isMobile ? 0 : 8, flexWrap: 'wrap' }}>
          <button
            onClick={handleRefreshRouteDecisions}
            disabled={loadingDecision}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {loadingDecision ? (
              <><span className="spinner spinner-sm" /> {tr('刷新中...')}</>
            ) : (
              tr('刷新路由决策')
            )}
          </button>

          <button
            onClick={handleResetRoutingRuntime}
            disabled={resettingRoutingRuntime}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {resettingRoutingRuntime ? (
              <><span className="spinner spinner-sm" /> {tr('清理中...')}</>
            ) : (
              tr('清理运行时故障')
            )}
          </button>

          <button
            onClick={() => {
              resetRouteForm();
              ensureRouteCandidatesLoaded();
              setShowManual(true);
            }}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {tr('新建群组')}
          </button>

          <button
            type="button"
            aria-pressed={showZeroChannelRoutes}
            onClick={() => setShowZeroChannelRoutes((prev) => !prev)}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {showZeroChannelRoutes ? tr('隐藏 0 通道路由') : tr('显示 0 通道路由')}
          </button>

          <button
            type="button"
            disabled={probingBatch}
            onClick={async () => {
              setProbingBatch(true);
              try {
                // 只探测用户手动创建的路由（probePolicy === 'manual' 或 explicit_group）
                const manualRouteIds = routeSummaries
                  .filter((r) => isManualGovernedRoute(r) && r.enabled !== false)
                  .map((r) => r.id)
                  .filter((id): id is number => typeof id === 'number' && id > 0);
                if (manualRouteIds.length === 0) {
                  toast.error('没有可探测的手动路由');
                  return;
                }
                const result = await api.probeBatchRoutes({ routeIds: manualRouteIds, autoGovernance: true, earlyStopOnAvailable: true });
                const totalAvailable = result.results.reduce((s, r) => s + r.availableCount, 0);
                const totalUnavailable = result.results.reduce((s, r) => s + r.unavailableCount, 0);
                const totalSkipped = result.results.reduce((s, r) => s + (r.skippedCount ?? 0), 0);
                const totalFailed = result.results.reduce((s, r) => s + r.failedCount, 0);
                const availableSites = result.results
                  .flatMap((r) => r.items.filter((i) => i.available).slice(0, 3).map((i) => `${r.routeModelPattern}@${i.siteName}`))
                  .slice(0, 8)
                  .join('、');
                await Promise.all([
                  loadRouteOverview(),
                  loadRouteDecisions(routeSummaries, { force: true }),
                ]);
                let batchMsg = `批量探测完成：${result.results.length} 条路由，${totalAvailable} 可用`;
                if (totalSkipped > 0) {
                  batchMsg += `，${totalUnavailable} 不可用，${totalSkipped} 跳过`;
                } else {
                  batchMsg += `，${totalUnavailable} 不可用`;
                }
                if (totalFailed > 0) batchMsg += `，${totalFailed} 探测失败`;
                if (availableSites) batchMsg += `\n可用站点：${availableSites}`;
                if (totalAvailable > 0) {
                  toast.success(batchMsg);
                } else {
                  toast.error(batchMsg);
                }
              } catch (error: any) {
                toast.error(error?.message || '批量探测失败');
              } finally {
                setProbingBatch(false);
              }
            }}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {probingBatch ? (
              <><span className="spinner spinner-sm" /> {tr('探测中...')}</>
            ) : (
              tr('批量探测')
            )}
          </button>
        </div>
      </div>

      {showOnlyManualRoutes ? (
        <div className="info-tip surface-card" style={{ marginBottom: 12 }}>
          {tr('当前仅显示手工治理路由；如需排查系统自动生成或系统治理路由，请到筛选面板切换为"显示全部路由"。')}
        </div>
      ) : null}


      {/* Collapsible filter panel */}
      {isMobile ? (
        <>
          <button
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px', marginBottom: 12 }}
            onClick={() => setShowFilters(true)}
          >
            {tr('筛选')}
          </button>
          <MobileFilterSheet open={showFilters} onClose={() => setShowFilters(false)} title={tr('筛选路由')}>
            <RouteFilterBar
              totalRouteCount={listVisibleRoutes.length}
              showOnlyManualRoutes={showOnlyManualRoutes}
              setShowOnlyManualRoutes={setShowOnlyManualRoutes}
              activeBrand={activeBrand}
              setActiveBrand={setActiveBrand}
              activeSite={activeSite}
              setActiveSite={setActiveSite}
              activeEndpointType={activeEndpointType}
              setActiveEndpointType={setActiveEndpointType}
              activeGroupFilter={activeGroupFilter}
              setActiveGroupFilter={setActiveGroupFilter}
              brandList={brandList}
              siteList={siteList}
              endpointTypeList={endpointTypeList}
              groupRouteList={groupRouteList}
              collapsed={false}
              onToggle={() => setShowFilters(false)}
            />
          </MobileFilterSheet>
        </>
      ) : (
        <RouteFilterBar
          totalRouteCount={listVisibleRoutes.length}
          showOnlyManualRoutes={showOnlyManualRoutes}
          setShowOnlyManualRoutes={setShowOnlyManualRoutes}
          activeBrand={activeBrand}
          setActiveBrand={setActiveBrand}
          activeSite={activeSite}
          setActiveSite={setActiveSite}
          activeEndpointType={activeEndpointType}
          setActiveEndpointType={setActiveEndpointType}
          activeGroupFilter={activeGroupFilter}
          setActiveGroupFilter={setActiveGroupFilter}
          brandList={brandList}
          siteList={siteList}
          endpointTypeList={endpointTypeList}
          groupRouteList={groupRouteList}
          collapsed={filterCollapsed}
          onToggle={() => setFilterCollapsed((prev) => !prev)}
        />
      )}

      {/* Manual route panel */}
      <ManualRoutePanel
        show={showManual}
        editingRouteId={editingRouteId}
        form={form}
        setForm={setForm}
        saving={saving}
        canSave={canSaveRoute}
        routeIconSelectOptions={routeIconSelectOptions}
        previewModelSamples={previewModelSamples}
        sourceRouteOptions={sourceRouteOptions}
        sourceEndpointTypesBySourceKey={sourceEndpointTypesBySourceKey}
        routeCandidatesLoading={routeCandidatesLoading}
        routeCandidatesLoaded={routeCandidatesLoaded}
        modelCandidates={modelCandidates}
        missingTokenModelsByName={missingTokenModelsByName}
        missingTokenGroupModelsByName={missingTokenGroupModelsByName}
        onSave={handleAddRoute}
        onCancel={handleCancelEditRoute}
      />

      {/* Route card grid */}
      <div className={isMobile ? 'mobile-card-list' : 'route-card-grid'}>
        {visibleRoutes.map((route) => {
          const isExpanded = expandedRouteIds.includes(route.id);
          const isReadOnlyRoute = route.kind === 'zero_channel' || route.readOnly === true || route.isVirtual === true;
          const exactRoute = isRouteExactModel(route);
          const explicitGroupRoute = isExplicitGroupRoute(route);
          const channelManagementDisabled = explicitGroupRoute;

          if (isMobile) {
            return (
              <div key={route.id} style={{ display: 'grid', gap: 8 }}>
                <MobileCard
                  title={resolveRouteTitle(route)}
                  headerActions={(
                    <span className={`badge ${isReadOnlyRoute ? 'badge-muted' : (route.enabled ? 'badge-success' : 'badge-muted')}`} style={{ fontSize: 10 }}>
                      {isReadOnlyRoute ? tr('未生成') : (route.enabled ? tr('启用') : tr('禁用'))}
                    </span>
                  )}
                  footerActions={(
                    <>
                      <button
                        type="button"
                        className="btn btn-link"
                        onClick={() => toggleExpand(route.id)}
                      >
                        {isExpanded ? tr('收起') : tr('详情')}
                      </button>
                      {!isReadOnlyRoute && (
                        <button
                          type="button"
                          className="btn btn-link"
                          onClick={() => handleEditRoute(route)}
                        >
                          {tr('编辑')}
                        </button>
                      )}
                      {!isReadOnlyRoute && (
                        <button
                          type="button"
                          className="btn btn-link"
                          onClick={() => handleToggleRouteEnabled(route)}
                        >
                          {route.enabled ? tr('禁用') : tr('启用')}
                        </button>
                      )}
                      {!isReadOnlyRoute && !channelManagementDisabled && (
                        <button
                          type="button"
                          className="btn btn-link"
                          onClick={() => setAddChannelModalRouteId(route.id)}
                        >
                          {tr('添加通道')}
                        </button>
                      )}
                    </>
                  )}
                >
                  <MobileField label="模型" value={route.modelPattern} stacked />
                  <MobileField label="通道" value={route.channelCount} />
                  <MobileField label="策略" value={isReadOnlyRoute ? tr('未生成') : getRouteRoutingStrategyLabel(route.routingStrategy)} />
                  <MobileField label="状态" value={isReadOnlyRoute ? tr('未生成') : (route.enabled ? tr('启用') : tr('禁用'))} />
                  {explicitGroupRoute && (
                    <MobileField label="模式" value={tr('群组聚合')} />
                  )}
                  {!exactRoute && !explicitGroupRoute && (
                    <MobileField label="模式" value={tr('通配符路由')} />
                  )}
                </MobileCard>
                {isExpanded && (
                  <RouteCard
                    route={route}
                    brand={routeBrandById.get(route.id) || null}
                    expanded
                    compact
                    onToggleExpand={stableToggleExpand}
                    onEdit={stableEditRoute}
                    onDelete={stableDeleteRoute}
                    onToggleEnabled={stableToggleEnabled}
                    onRoutingStrategyChange={stableRoutingStrategyChange}
                    updatingRoutingStrategy={!!updatingRoutingStrategyByRoute[route.id]}
                    channels={channelsByRouteId[route.id]}
                    loadingChannels={!!loadingChannelsByRouteId[route.id]}
                    routeDecision={decisionByRoute[route.id] || null}
                    loadingDecision={loadingDecision}
                    candidateView={getRouteCandidateView(route.id)}
                    channelTokenDraft={channelTokenDraft}
                    updatingChannel={updatingChannel}
                    savingPriority={!!savingPriorityByRoute[route.id]}
                    onTokenDraftChange={stableTokenDraftChange}
                    onSaveToken={stableChannelTokenSave}
                    onDeleteChannel={stableDeleteChannel}
                    onChannelDragEnd={stableChannelDragEnd}
                    missingTokenSiteItems={missingTokenSiteItemsByRouteId[route.id] || EMPTY_MISSING_ITEMS}
                    missingTokenGroupItems={missingTokenGroupItemsByRouteId[route.id] || EMPTY_MISSING_GROUP_ITEMS}
                    explicitGroupSourceHealth={explicitGroupSourceHealthByRouteId[route.id] || null}
                    onCreateTokenForMissing={stableCreateTokenForMissing}
                    onAddChannel={stableAddChannel}
                    onProbeChannels={stableProbeRouteChannels}
                    onOpenDiagnostics={navigateToCredentialDiagnostics}
                    probingChannels={probingRouteId === route.id}
                    routeProbeSummary={routeProbeSummaryByRouteId[route.id] || null}
                    expandedSourceGroupMap={expandedSourceGroupMap}
                    onToggleSourceGroup={stableToggleSourceGroup}
                  />
                )}
              </div>
            );
          }

          return (
            <RouteCard
              key={route.id}
              route={route}
              brand={routeBrandById.get(route.id) || null}
              expanded={isExpanded}
              onToggleExpand={stableToggleExpand}
              onEdit={stableEditRoute}
              onDelete={stableDeleteRoute}
              onToggleEnabled={stableToggleEnabled}
              onRoutingStrategyChange={stableRoutingStrategyChange}
              updatingRoutingStrategy={!!updatingRoutingStrategyByRoute[route.id]}
              channels={channelsByRouteId[route.id]}
              loadingChannels={!!loadingChannelsByRouteId[route.id]}
              routeDecision={decisionByRoute[route.id] || null}
              loadingDecision={loadingDecision}
              candidateView={getRouteCandidateView(route.id)}
              channelTokenDraft={channelTokenDraft}
              updatingChannel={updatingChannel}
              savingPriority={!!savingPriorityByRoute[route.id]}
              onTokenDraftChange={stableTokenDraftChange}
              onSaveToken={stableChannelTokenSave}
              onDeleteChannel={stableDeleteChannel}
              onChannelDragEnd={stableChannelDragEnd}
              missingTokenSiteItems={missingTokenSiteItemsByRouteId[route.id] || EMPTY_MISSING_ITEMS}
              missingTokenGroupItems={missingTokenGroupItemsByRouteId[route.id] || EMPTY_MISSING_GROUP_ITEMS}
              explicitGroupSourceHealth={explicitGroupSourceHealthByRouteId[route.id] || null}
              onCreateTokenForMissing={stableCreateTokenForMissing}
              onAddChannel={stableAddChannel}
              onProbeChannels={stableProbeRouteChannels}
              onOpenDiagnostics={navigateToCredentialDiagnostics}
              probingChannels={probingRouteId === route.id}
              routeProbeSummary={routeProbeSummaryByRouteId[route.id] || null}
              expandedSourceGroupMap={expandedSourceGroupMap}
              onToggleSourceGroup={stableToggleSourceGroup}
            />
          );
        })}
      </div>

      {filteredRoutes.length > 0 && visibleRouteCount < filteredRoutes.length && (
        <div
          ref={loadMoreSentinelRef}
          style={{ textAlign: 'center', padding: '12px 0', fontSize: 12, color: 'var(--color-text-muted)' }}
        >
          {tr('当前已加载路由')} {visibleRouteCount} / {filteredRoutes.length}
        </div>
      )}

      {filteredRoutes.length === 0 && (
        <div className="card">
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4"
              />
            </svg>
            <div className="empty-state-title">
              {routeSummaries.length === 0
                ? '暂无路由'
                : (showOnlyManualRoutes ? '当前没有手工治理路由' : '没有匹配的路由')}
            </div>
            <div className="empty-state-desc">
              {routeSummaries.length === 0
                ? '请先同步模型或补齐连接配置；系统精确路由会按当前模型可用性自动生成。'
                : (showOnlyManualRoutes
                  ? '当前视图仅显示手工治理路由；切换到"显示全部路由"可查看系统自动生成或系统治理路由。'
                  : '请调整品牌筛选、搜索词或排序条件。')}
            </div>
          </div>
        </div>
      )}

      {/* Add channel modal */}
      {addChannelModalRoute && (
        <AddChannelModal
          open={!!addChannelModalRouteId}
          onClose={() => setAddChannelModalRouteId(null)}
          routeId={addChannelModalRoute.id}
          routeTitle={resolveRouteTitle(addChannelModalRoute)}
          candidateView={getRouteCandidateView(addChannelModalRoute.id)}
          onSuccess={handleAddChannelSuccess}
          missingTokenHints={routeMissingTokenIndex[addChannelModalRoute.id] || []}
          onCreateTokenForMissing={handleCreateTokenForMissingAccount}
          existingChannelAccountIds={new Set((channelsByRouteId[addChannelModalRoute.id] || []).map((c) => c.accountId))}
        />
      )}
    </div>
  );
}
