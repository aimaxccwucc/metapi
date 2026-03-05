import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import { useAnimatedVisibility } from '../components/useAnimatedVisibility.js';
import { getAccountsAddPanelStyle } from './helpers/accountsPanelStyle.js';
import { clearFocusParams, readFocusAccountIntent } from './helpers/navigationFocus.js';
import { tr } from '../i18n.js';
import { buildCustomReorderUpdates, sortItemsForDisplay, type SortMode } from './helpers/listSorting.js';
import { SITE_DOCS_URL } from '../docsLink.js';

type VerifiedSnapshot = {
  siteId: number;
  accessToken: string;
  platformUserId?: number;
  credentialMode: 'auto' | 'session' | 'apikey';
  tokenType: 'session' | 'apikey';
  username?: string;
  apiToken?: string;
};

export default function Accounts() {
  const location = useLocation();
  const navigate = useNavigate();
  const [accounts, setAccounts] = useState<any[]>([]);
  const [sites, setSites] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>('custom');
  const [highlightAccountId, setHighlightAccountId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<'token' | 'login'>('token');
  const [loginForm, setLoginForm] = useState({ siteId: 0, username: '', password: '' });
  const [tokenForm, setTokenForm] = useState({
    siteId: 0,
    username: '',
    accessToken: '',
    platformUserId: '',
    refreshToken: '',
    tokenExpiresAt: '',
    credentialMode: 'auto' as 'auto' | 'session' | 'apikey',
  });
  const [verifyResult, setVerifyResult] = useState<any>(null);
  const [verifiedSnapshot, setVerifiedSnapshot] = useState<VerifiedSnapshot | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [rebindTarget, setRebindTarget] = useState<any | null>(null);
  const [rebindForm, setRebindForm] = useState({ accessToken: '', platformUserId: '' });
  const [rebindVerifyResult, setRebindVerifyResult] = useState<any>(null);
  const [rebindVerifying, setRebindVerifying] = useState(false);
  const [rebindSaving, setRebindSaving] = useState(false);
  const [highlightRebindPanel, setHighlightRebindPanel] = useState(false);
  const [rebindFocusTrigger, setRebindFocusTrigger] = useState(0);
  const [editTarget, setEditTarget] = useState<any | null>(null);
  const [editForm, setEditForm] = useState({
    username: '',
    apiToken: '',
    accessToken: '',
    platformUserId: '',
    refreshToken: '',
    tokenExpiresAt: '',
  });
  const [editSaving, setEditSaving] = useState(false);
  const addPanelPresence = useAnimatedVisibility(showAdd, 220);
  const rebindPanelPresence = useAnimatedVisibility(Boolean(rebindTarget), 220);
  const rowRefs = useRef<Map<number, HTMLTableRowElement>>(new Map());
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rebindPanelRef = useRef<HTMLDivElement | null>(null);
  const rebindPanelTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRebindTargetRef = useRef<any | null>(null);
  const toast = useToast();
  if (rebindTarget) lastRebindTargetRef.current = rebindTarget;
  const activeRebindTarget = rebindTarget || lastRebindTargetRef.current;

  const load = async () => {
    const [accountsResult, sitesResult] = await Promise.allSettled([
      api.getAccounts(),
      api.getSites(),
    ]);
    if (accountsResult.status === 'fulfilled') {
      setAccounts(accountsResult.value || []);
    } else {
      toast.error('加载账号列表失败');
    }
    if (sitesResult.status === 'fulfilled') {
      setSites(sitesResult.value || []);
    }
    setLoaded(true);
  };
  useEffect(() => { void load(); }, []);

  const selectedTokenSite = useMemo(
    () => sites.find((item) => item.id === tokenForm.siteId) || null,
    [sites, tokenForm.siteId],
  );
  const isSub2ApiSelected = (selectedTokenSite?.platform || '').toLowerCase() === 'sub2api';

  const sortedAccounts = useMemo(
    () => sortItemsForDisplay(accounts, sortMode, (account) => account.balance || 0),
    [accounts, sortMode],
  );

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) {
        clearTimeout(highlightTimerRef.current);
      }
      if (rebindPanelTimerRef.current) {
        clearTimeout(rebindPanelTimerRef.current);
      }
    };
  }, []);

  const handleLoginAdd = async () => {
    if (!loginForm.siteId || !loginForm.username || !loginForm.password) return;
    setSaving(true);
    try {
      const result = await api.loginAccount(loginForm);
      if (result.success) {
        setShowAdd(false);
        setLoginForm({ siteId: 0, username: '', password: '' });
        const msg = result.apiTokenFound
          ? `账号 "${loginForm.username}" 已添加，API Key 已自动获取`
          : `账号 "${loginForm.username}" 已添加（未找到 API Key，请手动设置）`;
        toast.success(msg);
        load();
      } else {
        toast.error(result.message || '登录失败');
      }
    } catch (e: any) {
      toast.error(e.message || '登录请求失败');
    } finally {
      setSaving(false);
    }
  };

  const handleVerifyToken = async () => {
    if (!tokenForm.siteId || !tokenForm.accessToken) return;
    setVerifying(true);
    setVerifyResult(null);
    setVerifiedSnapshot(null);
    const normalizedPlatformUserId = tokenForm.platformUserId ? parseInt(tokenForm.platformUserId, 10) : undefined;
    try {
      const result = await api.verifyToken({
        siteId: tokenForm.siteId,
        accessToken: tokenForm.accessToken,
        platformUserId: normalizedPlatformUserId,
        credentialMode: tokenForm.credentialMode,
      });
      setVerifyResult(result);
      if (result.success) {
        setVerifiedSnapshot({
          siteId: tokenForm.siteId,
          accessToken: tokenForm.accessToken,
          platformUserId: normalizedPlatformUserId,
          credentialMode: tokenForm.credentialMode,
          tokenType: result.tokenType,
          username: result.userInfo?.username,
          apiToken: result.apiToken,
        });
        if (result.tokenType === 'apikey') {
          toast.success(`API Key 验证成功（可用模型 ${result.modelCount || 0} 个）`);
        } else {
          toast.success(`Session 验证成功: ${result.userInfo?.username || '未知用户'}`);
        }
      } else {
        toast.error(result.message || 'Token 无效');
      }
    } catch (e: any) {
      toast.error(e.message || '验证失败');
      setVerifiedSnapshot(null);
      setVerifyResult({ success: false, message: e.message });
    } finally {
      setVerifying(false);
    }
  };

  const canForceAddUnverified = !!verifyResult && !verifyResult.success && verifyResult.shieldBlocked;

  const handleTokenAdd = async (allowUnverified = false) => {
    if (!tokenForm.siteId || !tokenForm.accessToken) return;
    if (!verifyResult?.success && !(allowUnverified && verifyResult?.shieldBlocked)) {
      toast.error('请先验证 Token 成功后再添加账号');
      return;
    }
    setSaving(true);
    const normalizedPlatformUserId = tokenForm.platformUserId ? parseInt(tokenForm.platformUserId, 10) : undefined;
    const payload: any = {
      siteId: tokenForm.siteId,
      username: tokenForm.username.trim() || undefined,
      accessToken: tokenForm.accessToken,
      platformUserId: normalizedPlatformUserId,
      refreshToken: isSub2ApiSelected && tokenForm.refreshToken.trim()
        ? tokenForm.refreshToken.trim()
        : undefined,
      tokenExpiresAt: isSub2ApiSelected && tokenForm.tokenExpiresAt.trim()
        ? Number.parseInt(tokenForm.tokenExpiresAt.trim(), 10)
        : undefined,
      credentialMode: tokenForm.credentialMode,
    };
    if (allowUnverified && verifyResult?.shieldBlocked) {
      payload.allowUnverified = true;
    }
    const snapshotMatchesCurrentForm = !!verifiedSnapshot
      && verifiedSnapshot.siteId === tokenForm.siteId
      && verifiedSnapshot.accessToken === tokenForm.accessToken
      && (verifiedSnapshot.platformUserId || undefined) === (normalizedPlatformUserId || undefined)
      && verifiedSnapshot.credentialMode === tokenForm.credentialMode;
    if (snapshotMatchesCurrentForm) {
      payload.preverified = {
        tokenType: verifiedSnapshot.tokenType,
        username: verifiedSnapshot.username,
        apiToken: verifiedSnapshot.apiToken,
      };
    }
    try {
      const result = await api.addAccount(payload);
      setShowAdd(false);
      setTokenForm({
        siteId: 0,
        username: '',
        accessToken: '',
        platformUserId: '',
        refreshToken: '',
        tokenExpiresAt: '',
        credentialMode: 'auto',
      });
      setVerifyResult(null);
      setVerifiedSnapshot(null);
      if (result.tokenType === 'apikey') {
        toast.success('已添加为 API Key 账号（可用于代理转发）');
      } else if (result.unverified) {
        toast.info('账号已保存（未完成验证），请先手动签到/确认后再使用自动任务');
      } else {
        const parts: string[] = [];
        if (result.usernameDetected) parts.push('用户名已自动识别');
        if (result.apiTokenFound) parts.push('API Key 已自动获取');
        const extra = parts.length ? `（${parts.join('，')}）` : '';
        toast.success(`账号已添加${extra}`);
      }
      if (result.queued) {
        toast.info('账号初始化任务已在后台执行，余额/模型会稍后自动刷新');
      }
      load();
    } catch (e: any) {
      toast.error(e.message || '添加失败');
    } finally {
      setSaving(false);
    }
  };

  const withLoading = async (key: string, fn: () => Promise<any>, successMsg?: string) => {
    setActionLoading(s => ({ ...s, [key]: true }));
    try { await fn(); if (successMsg) toast.success(successMsg); }
    catch (e: any) { toast.error(e.message || '操作失败'); }
    finally {
      setActionLoading(s => ({ ...s, [key]: false }));
      void load();
    }
  };

  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px', border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)', fontSize: 13, outline: 'none',
    background: 'var(--color-bg)', color: 'var(--color-text-primary)',
  };

  const runtimeHealthMap: Record<string, {
    label: string;
    cls: string;
    dotClass: string;
    pulse: boolean;
  }> = {
    healthy: { label: '健康', cls: 'badge-success', dotClass: 'status-dot-success', pulse: true },
    unhealthy: { label: '异常', cls: 'badge-error', dotClass: 'status-dot-error', pulse: true },
    degraded: { label: '降级', cls: 'badge-warning', dotClass: 'status-dot-pending', pulse: true },
    disabled: { label: '已禁用', cls: 'badge-muted', dotClass: 'status-dot-muted', pulse: false },
    unknown: { label: '未知', cls: 'badge-muted', dotClass: 'status-dot-pending', pulse: false },
  };

  const resolveRuntimeHealth = (account: any) => {
    const fallbackState = account.status === 'disabled' || account.site?.status === 'disabled'
      ? 'disabled'
      : (account.status === 'expired' ? 'unhealthy' : 'unknown');
    const state = account.runtimeHealth?.state || fallbackState;
    const cfg = runtimeHealthMap[state] || runtimeHealthMap.unknown;
    const reason = account.runtimeHealth?.reason
      || (state === 'disabled'
        ? '账号或站点已禁用'
        : (state === 'unhealthy' ? '最近健康检查失败' : '尚未获取运行健康信息'));
    return { state, reason, ...cfg };
  };

  const resolveAccountCapabilities = (account: any) => {
    const fromServer = account?.capabilities;
    if (fromServer && typeof fromServer === 'object') {
      return {
        canCheckin: !!fromServer.canCheckin,
        canRefreshBalance: !!fromServer.canRefreshBalance,
        proxyOnly: !!fromServer.proxyOnly,
      };
    }
    const hasSession = typeof account?.accessToken === 'string' && account.accessToken.trim().length > 0;
    return {
      canCheckin: hasSession,
      canRefreshBalance: hasSession,
      proxyOnly: !hasSession,
    };
  };

  const handleRefreshRuntimeHealth = async () => {
    setActionLoading((s) => ({ ...s, 'health-refresh': true }));
    try {
      const res = await api.refreshAccountHealth();
      if (res?.queued) {
        toast.info(res.message || '账号状态刷新任务已提交，完成后会自动更新。');
      } else {
        toast.success(res?.message || '账号状态已刷新');
      }
      load();
    } catch (e: any) {
      toast.error(e.message || '刷新账号状态失败');
    } finally {
      setActionLoading((s) => ({ ...s, 'health-refresh': false }));
    }
  };

  const handleRepairAccountKeys = async () => {
    setActionLoading((s) => ({ ...s, 'keys-repair': true }));
    try {
      const res = await api.repairAccountKeys();
      if (res?.queued) {
        toast.info(res.message || '账号 Key 修复任务已提交，完成后会自动更新。');
      } else {
        toast.success(res?.message || '账号 Key 修复已完成');
      }
      load();
    } catch (e: any) {
      toast.error(e.message || '账号 Key 修复失败');
    } finally {
      setActionLoading((s) => ({ ...s, 'keys-repair': false }));
    }
  };

  const handleToggleCheckin = async (account: any) => {
    const key = `checkin-toggle-${account.id}`;
    const nextEnabled = !account.checkinEnabled;
    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await api.updateAccount(account.id, { checkinEnabled: nextEnabled });
      toast.success(nextEnabled ? '已开启签到' : '已关闭签到（全部签到会忽略此账号）');
      load();
    } catch (e: any) {
      toast.error(e.message || '切换签到状态失败');
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const handleTogglePin = async (account: any) => {
    const key = `pin-toggle-${account.id}`;
    const nextPinned = !account.isPinned;
    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await api.updateAccount(account.id, { isPinned: nextPinned });
      toast.success(nextPinned ? '账号已置顶' : '账号已取消置顶');
      load();
    } catch (e: any) {
      toast.error(e.message || '切换账号置顶失败');
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const handleMoveCustomOrder = async (account: any, direction: 'up' | 'down') => {
    const key = `reorder-${account.id}`;
    const updates = buildCustomReorderUpdates(accounts, account.id, direction);
    if (updates.length === 0) return;

    setActionLoading((s) => ({ ...s, [key]: true }));
    try {
      await Promise.all(updates.map((update) => api.updateAccount(update.id, { sortOrder: update.sortOrder })));
      load();
    } catch (e: any) {
      toast.error(e.message || '更新账号排序失败');
    } finally {
      setActionLoading((s) => ({ ...s, [key]: false }));
    }
  };

  const extractPlatformUserId = (account: any): string => {
    try {
      const parsed = JSON.parse(account?.extraConfig || '{}');
      const raw = parsed?.platformUserId;
      const value = Number.parseInt(String(raw ?? ''), 10);
      if (Number.isFinite(value) && value > 0) return String(value);
    } catch { }
    const guessed = Number.parseInt(String(account?.username || '').match(/(\d{3,8})$/)?.[1] || '', 10);
    return Number.isFinite(guessed) && guessed > 0 ? String(guessed) : '';
  };

  const extractManagedSub2ApiAuth = (account: any): { refreshToken: string; tokenExpiresAt: string } => {
    try {
      const parsed = JSON.parse(account?.extraConfig || '{}');
      const auth = parsed?.sub2apiAuth;
      if (!auth || typeof auth !== 'object') return { refreshToken: '', tokenExpiresAt: '' };
      const refreshToken = typeof auth.refreshToken === 'string' ? auth.refreshToken : '';
      const tokenExpiresAt = Number.isFinite(auth.tokenExpiresAt) ? String(Math.trunc(auth.tokenExpiresAt)) : '';
      return { refreshToken, tokenExpiresAt };
    } catch {
      return { refreshToken: '', tokenExpiresAt: '' };
    }
  };

  const openEditPanel = (account: any) => {
    const managedAuth = extractManagedSub2ApiAuth(account);
    setEditTarget(account);
    setEditForm({
      username: account?.username || '',
      apiToken: account?.apiToken || '',
      accessToken: account?.accessToken || '',
      platformUserId: extractPlatformUserId(account),
      refreshToken: managedAuth.refreshToken,
      tokenExpiresAt: managedAuth.tokenExpiresAt,
    });
  };

  const closeEditPanel = () => {
    setEditTarget(null);
    setEditForm({
      username: '',
      apiToken: '',
      accessToken: '',
      platformUserId: '',
      refreshToken: '',
      tokenExpiresAt: '',
    });
    setEditSaving(false);
  };

  const handleSubmitEdit = async () => {
    if (!editTarget) return;
    setEditSaving(true);
    try {
      const normalizedPlatformUserId = editForm.platformUserId.trim()
        ? Number.parseInt(editForm.platformUserId.trim(), 10)
        : undefined;
      const baseExtraConfig = (() => {
        try {
          const parsed = JSON.parse(editTarget?.extraConfig || '{}');
          return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          return {};
        }
      })();
      if (Number.isFinite(normalizedPlatformUserId as number) && (normalizedPlatformUserId as number) > 0) {
        (baseExtraConfig as Record<string, unknown>).platformUserId = normalizedPlatformUserId;
      }

      const payload: Record<string, unknown> = {
        username: editForm.username.trim() || null,
        apiToken: editForm.apiToken.trim() || null,
        accessToken: editForm.accessToken.trim() || '',
        extraConfig: JSON.stringify(baseExtraConfig),
      };

      const isSub2Api = (editTarget?.site?.platform || '').toLowerCase() === 'sub2api';
      if (isSub2Api) {
        payload.refreshToken = editForm.refreshToken.trim();
        payload.tokenExpiresAt = editForm.tokenExpiresAt.trim();
      }

      await api.updateAccount(editTarget.id, payload);
      toast.success('账号已更新');
      closeEditPanel();
      await load();
    } catch (e: any) {
      toast.error(e.message || '更新账号失败');
    } finally {
      setEditSaving(false);
    }
  };

  const openRebindPanel = (account: any) => {
    setRebindTarget(account);
    setRebindForm({
      accessToken: '',
      platformUserId: extractPlatformUserId(account),
    });
    setRebindVerifyResult(null);
    setRebindFocusTrigger((value) => value + 1);
  };

  const closeRebindPanel = () => {
    setRebindTarget(null);
    setRebindForm({ accessToken: '', platformUserId: '' });
    setRebindVerifyResult(null);
    setRebindVerifying(false);
    setRebindSaving(false);
    setHighlightRebindPanel(false);
  };

  useEffect(() => {
    if (!rebindTarget || rebindFocusTrigger <= 0) return;

    setHighlightRebindPanel(true);
    rebindPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    if (rebindPanelTimerRef.current) {
      clearTimeout(rebindPanelTimerRef.current);
    }
    rebindPanelTimerRef.current = setTimeout(() => {
      setHighlightRebindPanel(false);
    }, 2200);
  }, [rebindFocusTrigger, rebindTarget]);

  const handleVerifyRebindToken = async () => {
    if (!rebindTarget || !rebindForm.accessToken.trim()) return;
    setRebindVerifying(true);
    setRebindVerifyResult(null);
    try {
      const result = await api.verifyToken({
        siteId: rebindTarget.siteId,
        accessToken: rebindForm.accessToken.trim(),
        platformUserId: rebindForm.platformUserId ? Number.parseInt(rebindForm.platformUserId, 10) : undefined,
        credentialMode: 'session',
      });
      setRebindVerifyResult(result);
      if (result.success && result.tokenType === 'session') {
        toast.success('Session Token 验证成功，可以重新绑定');
      } else if (result.success && result.tokenType !== 'session') {
        toast.error('当前是 API Key，不是 Session Token');
      } else {
        toast.error(result.message || 'Token 无效');
      }
    } catch (e: any) {
      toast.error(e.message || '验证失败');
      setRebindVerifyResult({ success: false, message: e.message });
    } finally {
      setRebindVerifying(false);
    }
  };

  const handleSubmitRebind = async () => {
    if (!rebindTarget || !rebindForm.accessToken.trim()) return;
    if (!(rebindVerifyResult?.success && rebindVerifyResult?.tokenType === 'session')) {
      toast.error('请先验证新的 Session Token 成功');
      return;
    }
    setRebindSaving(true);
    try {
      await api.rebindAccountSession(rebindTarget.id, {
        accessToken: rebindForm.accessToken.trim(),
        platformUserId: rebindForm.platformUserId ? Number.parseInt(rebindForm.platformUserId, 10) : undefined,
      });
      toast.success('账号重新绑定成功，状态已恢复');
      closeRebindPanel();
      load();
    } catch (e: any) {
      toast.error(e.message || '重新绑定失败');
    } finally {
      setRebindSaving(false);
    }
  };

  useEffect(() => {
    const { accountId, openRebind } = readFocusAccountIntent(location.search);
    if (!accountId || !loaded) return;

    const target = sortedAccounts.find((account) => account.id === accountId);
    const row = rowRefs.current.get(accountId);
    const cleanedSearch = clearFocusParams(location.search);
    if (!target || !row) {
      navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
      return;
    }

    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightAccountId(accountId);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => {
      setHighlightAccountId((current) => (current === accountId ? null : current));
    }, 2200);

    if (openRebind && target.status === 'expired') {
      setShowAdd(false);
      if (!rebindTarget || rebindTarget.id !== target.id) {
        openRebindPanel(target);
      }
    }

    navigate({ pathname: location.pathname, search: cleanedSearch }, { replace: true });
  }, [loaded, location.pathname, location.search, navigate, openRebindPanel, rebindTarget, sortedAccounts]);

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h2 className="page-title">{tr('账号管理')}</h2>
        <div className="page-actions accounts-page-actions">
          <div className="accounts-sort-select" style={{ minWidth: 156, position: 'relative', zIndex: 20 }}>
            <ModernSelect
              size="sm"
              value={sortMode}
              onChange={(nextValue) => setSortMode(nextValue as SortMode)}
              options={[
                { value: 'custom', label: '自定义排序' },
                { value: 'balance-desc', label: '余额高到低' },
                { value: 'balance-asc', label: '余额低到高' },
              ]}
              placeholder="自定义排序"
            />
          </div>
          <button onClick={() => withLoading('checkin-all', () => api.triggerCheckinAll(), '已触发全部签到')} disabled={actionLoading['checkin-all']}
            className="btn btn-soft-primary">
            {actionLoading['checkin-all'] ? <><span className="spinner spinner-sm" />{tr('签到中...')}</> : tr('全部签到')}
          </button>
          <button
            onClick={handleRefreshRuntimeHealth}
            disabled={actionLoading['health-refresh']}
            className="btn btn-soft-primary"
          >
            {actionLoading['health-refresh'] ? <><span className="spinner spinner-sm" />{tr('刷新状态中...')}</> : tr('刷新账户状态')}
          </button>
          <button
            onClick={handleRepairAccountKeys}
            disabled={actionLoading['keys-repair']}
            className="btn btn-soft-primary"
          >
            {actionLoading['keys-repair'] ? <><span className="spinner spinner-sm" />{tr('修复中...')}</> : tr('一键修复Key')}
          </button>
          <button onClick={() => { setShowAdd(!showAdd); setAddMode('token'); setVerifyResult(null); }} className="btn btn-primary">
            {showAdd ? tr('取消') : tr('+ 添加账号')}
          </button>
        </div>
      </div>

      {/* Add Panel */}
      {addPanelPresence.shouldRender && (
        <div className={`card panel-presence ${addPanelPresence.isVisible ? '' : 'is-closing'}`.trim()} style={getAccountsAddPanelStyle()}>
          {/* Mode tabs */}
          <div style={{ display: 'flex', gap: 0, background: 'var(--color-bg)', borderRadius: 'var(--radius-sm)', padding: 3, marginBottom: 16 }}>
            <button onClick={() => { setAddMode('token'); setVerifyResult(null); }}
              style={{
                flex: 1, padding: '8px 0', borderRadius: 6, fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer', transition: 'all 0.2s',
                background: addMode === 'token' ? 'var(--color-bg-card)' : 'transparent',
                color: addMode === 'token' ? 'var(--color-primary)' : 'var(--color-text-muted)',
                boxShadow: addMode === 'token' ? 'var(--shadow-sm)' : 'none'
              }}>
              Cookie / Token 导入
            </button>
            <button onClick={() => { setAddMode('login'); setVerifyResult(null); }}
              style={{
                flex: 1, padding: '8px 0', borderRadius: 6, fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer', transition: 'all 0.2s',
                background: addMode === 'login' ? 'var(--color-bg-card)' : 'transparent',
                color: addMode === 'login' ? 'var(--color-primary)' : 'var(--color-text-muted)',
                boxShadow: addMode === 'login' ? 'var(--shadow-sm)' : 'none'
              }}>
              账号密码登录
            </button>
          </div>

          {addMode === 'token' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="info-tip">
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>凭证模式：Session / API Key（可切换，默认自动识别）</div>
                  <div><strong>API Key</strong>（在站点「令牌」页面生成）→ 仅代理转发</div>
                  <div><strong>Session 模式</strong>支持两种凭证：<strong>系统访问令牌（Access Token，推荐）</strong> 或 <strong>浏览器 Cookie</strong></div>
                  <div style={{ marginTop: 2 }}>以 NewAPI 为例：控制台 → 个人设置 → 安全设置 → 生成「系统访问令牌」</div>
                  <div style={{ opacity: 0.7, borderTop: '1px solid rgba(0,0,0,0.1)', paddingTop: 6, marginTop: 6 }}>
                    推荐优先使用 Access Token（更稳定、可多账号）；Cookie 仅用于兼容场景。获取 Cookie: <kbd style={{ padding: '1px 5px', background: 'var(--color-bg-card)', border: '1px solid var(--color-border)', borderRadius: 3, fontSize: 11 }}>F12</kbd> → Application → Cookie</div>
                  <div style={{ marginTop: 6 }}>
                    <a
                      href={SITE_DOCS_URL}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ fontSize: 12, color: 'var(--color-primary)', textDecoration: 'underline' }}
                    >
                      查看认证方式与特殊站点说明文档
                    </a>
                  </div>
                </div>
              </div>
              <ModernSelect
                value={String(tokenForm.siteId || 0)}
                onChange={(nextValue) => {
                  const nextSiteId = Number.parseInt(nextValue, 10) || 0;
                  setTokenForm((f) => ({ ...f, siteId: nextSiteId }));
                  setVerifyResult(null);
                  setVerifiedSnapshot(null);
                }}
                options={[
                  { value: '0', label: '选择站点' },
                  ...sites.map((s: any) => ({
                    value: String(s.id),
                    label: `${s.name} (${s.platform})`,
                  })),
                ]}
                placeholder="选择站点"
              />
              <input
                placeholder="账号名称（可选，API Key 模式建议填写）"
                value={tokenForm.username}
                onChange={(e) => {
                  setTokenForm((f) => ({ ...f, username: e.target.value }));
                  setVerifiedSnapshot(null);
                }}
                style={inputStyle}
              />
              <ModernSelect
                value={tokenForm.credentialMode}
                onChange={(nextValue) => {
                  const nextMode = (nextValue as 'auto' | 'session' | 'apikey') || 'auto';
                  setTokenForm((f) => ({ ...f, credentialMode: nextMode }));
                  setVerifyResult(null);
                  setVerifiedSnapshot(null);
                }}
                options={[
                  { value: 'auto', label: '自动识别（推荐）' },
                  { value: 'session', label: 'Session 模式（Access Token / Cookie）' },
                  { value: 'apikey', label: 'API Key 模式' },
                ]}
                placeholder="选择凭证模式"
              />
              <textarea placeholder={
                tokenForm.credentialMode === 'session'
                  ? '粘贴系统访问令牌（Access Token）或 Session Cookie'
                  : (tokenForm.credentialMode === 'apikey'
                    ? '粘贴 API Key'
                    : '粘贴 Access Token / Session Cookie / API Key（自动识别）')
              }
                value={tokenForm.accessToken}
                onChange={e => {
                  setTokenForm(f => ({ ...f, accessToken: e.target.value.trim() }));
                  setVerifyResult(null);
                  setVerifiedSnapshot(null);
                }}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)', height: 72, resize: 'none' as const }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <input
                  placeholder="用户 ID（可选）"
                  value={tokenForm.platformUserId}
                  onChange={e => {
                    setTokenForm(f => ({ ...f, platformUserId: e.target.value.replace(/\D/g, '') }));
                    setVerifyResult(null);
                    setVerifiedSnapshot(null);
                  }}
                  style={inputStyle}
                />
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  若站点要求 New-Api-User / User-ID，请在这里提前填写。
                </div>
              </div>
              {isSub2ApiSelected && (
                <>
                  <input
                    placeholder="Sub2API refresh_token（可选，用于托管自动续期）"
                    value={tokenForm.refreshToken}
                    onChange={(e) => {
                      setTokenForm((f) => ({ ...f, refreshToken: e.target.value.trim() }));
                      setVerifiedSnapshot(null);
                    }}
                    style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <input
                      placeholder="token_expires_at（可选，毫秒时间戳）"
                      value={tokenForm.tokenExpiresAt}
                      onChange={(e) => {
                        setTokenForm((f) => ({ ...f, tokenExpiresAt: e.target.value.replace(/\D/g, '') }));
                        setVerifiedSnapshot(null);
                      }}
                      style={inputStyle}
                    />
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                      配置 refresh_token 后，metapi 会在 JWT 临近过期或 401 时自动续期并回写新 token。
                    </div>
                  </div>
                </>
              )}

              {/* Verify results */}
              {verifyResult && verifyResult.success && verifyResult.tokenType === 'session' && (
                <div className="alert alert-success animate-scale-in">
                  <div className="alert-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    Session 凭证有效（Access Token / Cookie）
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                    <div>用户名: <strong>{verifyResult.userInfo?.username || '未知'}</strong></div>
                    {verifyResult.balance && <div>余额: <strong>${(verifyResult.balance.balance || 0).toFixed(2)}</strong></div>}
                    <div>API Key: <span style={{ fontWeight: 500, color: verifyResult.apiToken ? 'var(--color-success)' : 'var(--color-text-muted)' }}>
                      {verifyResult.apiToken ? '已找到 (' + verifyResult.apiToken.substring(0, 8) + '...)' : '未找到'}
                    </span></div>
                  </div>
                </div>
              )}
              {verifyResult && verifyResult.success && verifyResult.tokenType === 'apikey' && (
                <div className="alert alert-info animate-scale-in">
                  <div className="alert-title" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" /></svg>
                    识别为 API Key
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                    <div>可用模型: <strong>{verifyResult.modelCount} 个</strong></div>
                    {verifyResult.models && <div style={{ color: 'var(--color-text-muted)' }}>包含: {verifyResult.models.join(', ')}{verifyResult.modelCount > 10 ? ' ...' : ''}</div>}
                  </div>
                </div>
              )}
              {verifyResult && !verifyResult.success && verifyResult.needsUserId && (
                <div className="alert alert-warning animate-scale-in">
                  <div className="alert-title">
                    此站点要求用户 ID，请补充后重新验证
                  </div>
                </div>
              )}
              {verifyResult && !verifyResult.success && !verifyResult.needsUserId && (
                <div className="alert alert-error animate-scale-in">
                  <div className="alert-title">
                    {verifyResult.message || 'Token 无效或已过期'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>请检查 Token 是否正确</div>
                  {verifyResult.shieldBlocked && (
                    <div style={{ fontSize: 12, color: 'var(--color-warning)', marginTop: 6 }}>
                      站点开启了反爬挑战。可先“保存账号（未验证）”，后续先手动签到，再回来重绑/更新凭证。
                    </div>
                  )}
                </div>
              )}

              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={handleVerifyToken} disabled={verifying || !tokenForm.siteId || !tokenForm.accessToken}
                  className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}>
                  {verifying ? <><span className="spinner spinner-sm" />验证中...</> : '验证 Token'}
                </button>
                <button onClick={() => handleTokenAdd(false)} disabled={saving || !tokenForm.siteId || !tokenForm.accessToken || !verifyResult?.success}
                  className="btn btn-success">
                  {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />添加中...</> : '添加账号'}
                </button>
                {canForceAddUnverified && (
                  <button
                    onClick={() => handleTokenAdd(true)}
                    disabled={saving || !tokenForm.siteId || !tokenForm.accessToken}
                    className="btn btn-link btn-link-warning"
                  >
                    {saving ? '保存中...' : '保存账号（未验证）'}
                  </button>
                )}
              </div>
              {!verifyResult?.success && !canForceAddUnverified && (
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                  请先点击“验证 Token”，验证成功后才能添加账号
                </div>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div className="info-tip">
                输入目标站点的账号密码，将自动登录并获取访问令牌和 API Key
              </div>
              <ModernSelect
                value={String(loginForm.siteId || 0)}
                onChange={(nextValue) => {
                  const nextSiteId = Number.parseInt(nextValue, 10) || 0;
                  setLoginForm((f) => ({ ...f, siteId: nextSiteId }));
                }}
                options={[
                  { value: '0', label: '选择站点' },
                  ...sites.map((s: any) => ({
                    value: String(s.id),
                    label: `${s.name} (${s.platform})`,
                  })),
                ]}
                placeholder="选择站点"
              />
              <input placeholder="用户名" value={loginForm.username} onChange={e => setLoginForm(f => ({ ...f, username: e.target.value }))} style={inputStyle} />
              <input type="password" placeholder="密码" value={loginForm.password} onChange={e => setLoginForm(f => ({ ...f, password: e.target.value }))} onKeyDown={e => e.key === 'Enter' && handleLoginAdd()} style={inputStyle} />
              <button onClick={handleLoginAdd} disabled={saving || !loginForm.siteId || !loginForm.username || !loginForm.password}
                className="btn btn-success" style={{ alignSelf: 'flex-start' }}>
                {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />登录并添加...</> : '登录并添加'}
              </button>
            </div>
          )}
        </div>
      )}

      {rebindPanelPresence.shouldRender && activeRebindTarget && (
        <div
          ref={rebindPanelRef}
          className={`card panel-presence rebind-panel ${rebindPanelPresence.isVisible ? '' : 'is-closing'} ${highlightRebindPanel ? 'rebind-panel-highlight' : ''}`.trim()}
          style={{ marginBottom: 16, padding: 16 }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text-primary)' }}>
              重新绑定 Session Token
            </div>
            <button className="btn btn-ghost" onClick={closeRebindPanel}>关闭</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            账号: {activeRebindTarget.username || '未命名'} @ {activeRebindTarget.site?.name || '-'}。请粘贴新的 Session Token，验证成功后再绑定。
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', gap: 10, marginBottom: 10 }}>
            <textarea
              placeholder="粘贴新的 Session Token"
              value={rebindForm.accessToken}
              onChange={(e) => {
                setRebindForm((prev) => ({ ...prev, accessToken: e.target.value.trim() }));
                setRebindVerifyResult(null);
              }}
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)', height: 74, resize: 'none' as const }}
            />
            <input
              placeholder="用户 ID（可选）"
              value={rebindForm.platformUserId}
              onChange={(e) => {
                setRebindForm((prev) => ({ ...prev, platformUserId: e.target.value.replace(/\D/g, '') }));
                setRebindVerifyResult(null);
              }}
              style={inputStyle}
            />
          </div>

          {rebindVerifyResult && rebindVerifyResult.success && rebindVerifyResult.tokenType === 'session' && (
            <div className="alert alert-success animate-scale-in" style={{ marginBottom: 10 }}>
              <div className="alert-title">Session Token 有效</div>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                用户: {rebindVerifyResult.userInfo?.username || '未知'}
                {rebindVerifyResult.apiToken ? `，已识别 API Key (${String(rebindVerifyResult.apiToken).slice(0, 8)}...)` : ''}
              </div>
            </div>
          )}
          {rebindVerifyResult && (!rebindVerifyResult.success || rebindVerifyResult.tokenType !== 'session') && (
            <div className="alert alert-error animate-scale-in" style={{ marginBottom: 10 }}>
              <div className="alert-title">
                {rebindVerifyResult.message || 'Token 无效或类型不正确'}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={handleVerifyRebindToken}
              disabled={rebindVerifying || !rebindForm.accessToken.trim()}
              className="btn btn-ghost"
              style={{ border: '1px solid var(--color-border)' }}
            >
              {rebindVerifying ? <><span className="spinner spinner-sm" />验证中...</> : '验证 Token'}
            </button>
            <button
              onClick={handleSubmitRebind}
              disabled={rebindSaving || !(rebindVerifyResult?.success && rebindVerifyResult?.tokenType === 'session')}
              className="btn btn-success"
            >
              {rebindSaving
                ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />绑定中...</>
                : '确认重新绑定'}
            </button>
          </div>
        </div>
      )}

      {editTarget && (
        <div className="card" style={{ marginBottom: 16, padding: 16 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: 'var(--color-text-primary)' }}>
              编辑账号
            </div>
            <button className="btn btn-ghost" onClick={closeEditPanel}>关闭</button>
          </div>
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
            账号: {editTarget.username || '未命名'} @ {editTarget.site?.name || '-'}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginBottom: 10 }}>
            <input
              placeholder="用户名"
              value={editForm.username}
              onChange={(e) => setEditForm((prev) => ({ ...prev, username: e.target.value }))}
              style={inputStyle}
            />
            <input
              placeholder="用户 ID（可选）"
              value={editForm.platformUserId}
              onChange={(e) => setEditForm((prev) => ({ ...prev, platformUserId: e.target.value.replace(/\D/g, '') }))}
              style={inputStyle}
            />
            <input
              placeholder="API Key（可选）"
              value={editForm.apiToken}
              onChange={(e) => setEditForm((prev) => ({ ...prev, apiToken: e.target.value.trim() }))}
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
            />
          </div>

          <textarea
            placeholder="Session Token / Cookie（可选，留空表示清空）"
            value={editForm.accessToken}
            onChange={(e) => setEditForm((prev) => ({ ...prev, accessToken: e.target.value.trim() }))}
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)', height: 74, resize: 'none' as const, marginBottom: 10 }}
          />

          {(editTarget?.site?.platform || '').toLowerCase() === 'sub2api' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 10, marginBottom: 10 }}>
              <input
                placeholder="Sub2API refresh_token（可选）"
                value={editForm.refreshToken}
                onChange={(e) => setEditForm((prev) => ({ ...prev, refreshToken: e.target.value.trim() }))}
                style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
              />
              <input
                placeholder="token_expires_at（可选，毫秒时间戳）"
                value={editForm.tokenExpiresAt}
                onChange={(e) => setEditForm((prev) => ({ ...prev, tokenExpiresAt: e.target.value.replace(/\D/g, '') }))}
                style={inputStyle}
              />
            </div>
          )}

          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleSubmitEdit} disabled={editSaving} className="btn btn-success">
              {editSaving
                ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />保存中...</>
                : '保存修改'}
            </button>
          </div>
        </div>
      )}

      {/* Accounts Table */}
      <div className="card" style={{ overflowX: 'auto' }}>
        {accounts.length > 0 ? (
          <table className="data-table accounts-table">
            <thead>
              <tr>
                <th>用户名</th>
                <th>站点</th>
                <th>运行健康状态</th>
                <th>余额</th>
                <th>已用</th>
                <th>签到</th>
                <th className="accounts-actions-col" style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {sortedAccounts.map((a: any, i: number) => {
                const capabilities = resolveAccountCapabilities(a);
                return (
                  <tr
                    key={a.id}
                    ref={(node) => {
                      if (node) rowRefs.current.set(a.id, node);
                      else rowRefs.current.delete(a.id);
                    }}
                    className={`animate-slide-up stagger-${Math.min(i + 1, 5)} ${highlightAccountId === a.id ? 'row-focus-highlight' : ''}`}
                  >
                    <td style={{ color: 'var(--color-text-primary)' }}>
                      <div style={{ fontWeight: 600 }}>{a.username || '未命名'}</div>
                      <div style={{ display: 'flex', gap: 4, marginTop: 4 }}>
                        {capabilities.proxyOnly && (
                          <span className="badge badge-muted" style={{ fontSize: 10 }}>仅代理</span>
                        )}
                      </div>
                    </td>
                    <td>
                      {a.site?.url ? (
                        <a
                          href={a.site.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="badge-link"
                        >
                          <span className="badge badge-muted" style={{ fontSize: 11 }}>
                            {a.site?.name || '-'}
                          </span>
                        </a>
                      ) : (
                        <span className="badge badge-muted" style={{ fontSize: 11 }}>
                          {a.site?.name || '-'}
                        </span>
                      )}
                    </td>
                    <td>
                      {(() => {
                        const health = resolveRuntimeHealth(a);
                        return (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                            <span className={`badge ${health.cls}`} style={{ fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4, width: 'fit-content' }}>
                              <span className={`status-dot ${health.dotClass} ${health.pulse ? 'animate-pulse-dot' : ''}`} style={{ marginRight: 0 }} />
                              {health.label}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                color: 'var(--color-text-muted)',
                                maxWidth: 200,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              data-tooltip={health.reason}
                            >
                              {health.reason}
                            </span>
                          </div>
                        );
                      })()}
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                      <div style={{ fontWeight: 600, color: 'var(--color-text-primary)' }}>${(a.balance || 0).toFixed(2)}</div>
                      <div style={{ fontSize: 11, color: (a.todayReward || 0) > 0 ? 'var(--color-success)' : 'var(--color-text-muted)', fontWeight: 500 }}>
                        +{(a.todayReward || 0).toFixed(2)}
                      </div>
                    </td>
                    <td style={{ fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>
                      <div>${(a.balanceUsed || 0).toFixed(2)}</div>
                      <div style={{ fontSize: 11, color: (a.todaySpend || 0) > 0 ? 'var(--color-danger)' : 'var(--color-text-muted)', fontWeight: 500 }}>
                        -{(a.todaySpend || 0).toFixed(2)}
                      </div>
                    </td>
                    <td>
                      {capabilities.canCheckin ? (
                        <button
                          type="button"
                          className={`checkin-toggle-badge ${a.checkinEnabled ? 'is-on' : 'is-off'}`}
                          onClick={() => handleToggleCheckin(a)}
                          disabled={!!actionLoading[`checkin-toggle-${a.id}`]}
                          data-tooltip={a.checkinEnabled ? '点击关闭签到，全部签到会忽略此账号' : '点击开启签到'}
                          aria-label={a.checkinEnabled ? '点击关闭签到，全部签到会忽略此账号' : '点击开启签到'}
                        >
                          {actionLoading[`checkin-toggle-${a.id}`]
                            ? <span className="spinner spinner-sm" />
                            : (a.checkinEnabled ? '开启' : '关闭')}
                        </button>
                      ) : (
                        <span className="badge badge-muted" style={{ fontSize: 11 }}>
                          不支持
                        </span>
                      )}
                    </td>
                    <td className="accounts-actions-cell" style={{ textAlign: 'right' }}>
                      <div className="accounts-row-actions">
                        <button
                          onClick={() => handleTogglePin(a)}
                          disabled={!!actionLoading[`pin-toggle-${a.id}`]}
                          className={`btn btn-link ${a.isPinned ? 'btn-link-warning' : 'btn-link-primary'}`}
                        >
                          {actionLoading[`pin-toggle-${a.id}`] ? <span className="spinner spinner-sm" /> : (a.isPinned ? '取消置顶' : '置顶')}
                        </button>
                        {sortMode === 'custom' && (
                          <>
                            <button
                              onClick={() => handleMoveCustomOrder(a, 'up')}
                              disabled={!!actionLoading[`reorder-${a.id}`]}
                              className="btn btn-link btn-link-muted"
                            >
                              ↑
                            </button>
                            <button
                              onClick={() => handleMoveCustomOrder(a, 'down')}
                              disabled={!!actionLoading[`reorder-${a.id}`]}
                              className="btn btn-link btn-link-muted"
                            >
                              ↓
                            </button>
                          </>
                        )}
                        {capabilities.canRefreshBalance && (
                          <button onClick={() => withLoading(`refresh-${a.id}`, () => api.refreshBalance(a.id), '余额已刷新')} disabled={actionLoading[`refresh-${a.id}`]}
                            className="btn btn-link btn-link-primary">
                            {actionLoading[`refresh-${a.id}`] ? <span className="spinner spinner-sm" /> : '刷新'}
                          </button>
                        )}
                        <button onClick={() => withLoading(`models-${a.id}`, () => api.checkModels(a.id), '模型已更新')} disabled={actionLoading[`models-${a.id}`]}
                          className="btn btn-link btn-link-info">
                          {actionLoading[`models-${a.id}`] ? <span className="spinner spinner-sm" /> : '模型'}
                        </button>
                        {capabilities.canCheckin && (
                          <button onClick={() => withLoading(`checkin-${a.id}`, () => api.triggerCheckin(a.id), '签到完成')} disabled={actionLoading[`checkin-${a.id}`]}
                            className="btn btn-link btn-link-warning">
                            {actionLoading[`checkin-${a.id}`] ? <span className="spinner spinner-sm" /> : '签到'}
                          </button>
                        )}
                        {a.status === 'expired' && (
                          <button
                            onClick={() => openRebindPanel(a)}
                            className="btn btn-link btn-link-warning"
                          >
                            重新绑定
                          </button>
                        )}
                        <button
                          onClick={() => openEditPanel(a)}
                          className="btn btn-link btn-link-info"
                        >
                          编辑
                        </button>
                        <button onClick={() => withLoading(`delete-${a.id}`, () => api.deleteAccount(a.id), '已删除')} disabled={actionLoading[`delete-${a.id}`]}
                          className="btn btn-link btn-link-danger">
                          {actionLoading[`delete-${a.id}`] ? <span className="spinner spinner-sm" /> : '删除'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
            <div className="empty-state-title">暂无账号</div>
            <div className="empty-state-desc">请先添加站点，然后添加账号</div>
          </div>
        )}
      </div>
    </div>
  );
}
