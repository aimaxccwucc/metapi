import React, { startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import CenteredModal from '../components/CenteredModal.js';
import ResponsiveFormGrid from '../components/ResponsiveFormGrid.js';
import { useToast } from '../components/Toast.js';
import { MobileCard, MobileField } from '../components/MobileCard.js';
import { useIsMobile } from '../components/useIsMobile.js';
import DeleteConfirmModal from '../components/DeleteConfirmModal.js';
import {
  buildAddAccountPrereqHint,
  buildVerifyFailureHint,
  normalizeVerifyFailureMessage,
} from './helpers/accountVerifyFeedback.js';
import {
  cachedParseExtraConfig,
  createLoginForm,
  createRebindForm,
  createTokenForm,
  copyText,
  extractManagedSub2ApiAuth,
  extractPlatformUserId,
  resolveAccountAutoCheckin,
  resolveAccountCapabilities,
  resolveAccountCredentialMode,
  resolveAccountDisplayName,
  resolveRuntimeHealth,
} from './helpers/accountHelpers.js';
import { getInitialVisibleCount } from './helpers/progressiveRender.js';

const ACCOUNT_MODEL_MODAL_RENDER_CHUNK = 80;

type AddMode = 'token' | 'login';
type SiteManagerTab = 'accounts' | 'models' | 'keys';

type ModelModalState = {
  open: boolean;
  account: any | null;
  models: any[];
  pendingDisabled: Set<string>;
  loading: boolean;
  saving: boolean;
  siteName: string;
  manualModelsInput: string;
  addingManualModels: boolean;
};

const emptyModelModal: ModelModalState = {
  open: false, account: null, models: [], pendingDisabled: new Set<string>(),
  loading: false, saving: false, siteName: '', manualModelsInput: '', addingManualModels: false,
};

type SiteAccountsModalProps = {
  open: boolean;
  onClose: () => void;
  siteId: number | null;
  siteName: string;
  onSiteBalanceChange: () => void;
};

type SiteDetailToken = {
  id: number;
  accountId: number;
  accountName: string;
  name: string;
  group: string;
  enabled: boolean;
  isDefault: boolean;
  source?: string | null;
  valueStatus?: string;
  tokenMasked?: string;
  modelCount: number;
  models: string[];
};

type SiteDetailModel = {
  name: string;
  accountCount: number;
  tokenCount: number;
  groups: Array<{
    group: string;
    accountCount: number;
    tokenCount: number;
    tokens: Array<{
      id: number;
      name: string;
      accountId: number;
      accountName: string;
      enabled: boolean;
      isDefault: boolean;
    }>;
  }>;
};

type SiteDetailGroup = {
  group: string;
  modelCount: number;
  accountCount: number;
  tokenCount: number;
  models: string[];
};

type SiteDetail = {
  summary: {
    accountCount: number;
    tokenCount: number;
    modelCount: number;
    groupCount: number;
  };
  tokens: SiteDetailToken[];
  models: SiteDetailModel[];
  groups: SiteDetailGroup[];
};

type KeyEditorState = {
  mode: 'create' | 'edit';
  tokenId?: number;
  accountId: string;
  name: string;
  group: string;
  token: string;
  enabled: boolean;
  isDefault: boolean;
};

function createEmptyKeyEditor(accountId = ''): KeyEditorState {
  return {
    mode: 'create',
    accountId,
    name: '',
    group: 'default',
    token: '',
    enabled: true,
    isDefault: false,
  };
}

function formatUsd(value?: number | null): string {
  return `$${(value || 0).toFixed(2)}`;
}

export default function SiteAccountsModal({ open, onClose, siteId, siteName, onSiteBalanceChange }: SiteAccountsModalProps) {
  const isMobile = useIsMobile();
  const toast = useToast();

  // ── Data ──
  const [accounts, setAccounts] = useState<any[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<SiteManagerTab>('accounts');
  const [siteDetail, setSiteDetail] = useState<SiteDetail | null>(null);
  const [siteDetailLoading, setSiteDetailLoading] = useState(false);
  const [siteDetailSearch, setSiteDetailSearch] = useState('');
  const deferredSiteDetailSearch = useDeferredValue(siteDetailSearch.trim().toLowerCase());

  // ── Add ──
  const [showAdd, setShowAdd] = useState(false);
  const [addMode, setAddMode] = useState<AddMode>('token');
  const [loginForm, setLoginForm] = useState(createLoginForm());
  const [tokenForm, setTokenForm] = useState(createTokenForm());
  const [verifyResult, setVerifyResult] = useState<any>(null);
  const [verifying, setVerifying] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── Edit ──
  const [editingAccount, setEditingAccount] = useState<any>(null);
  const [editForm, setEditForm] = useState({
    username: '', status: 'active', checkinEnabled: true, unitCost: '',
    accessToken: '', apiToken: '', isPinned: false,
    refreshToken: '', tokenExpiresAt: '', proxyUrl: '',
  });
  const [savingEdit, setSavingEdit] = useState(false);

  // ── Rebind ──
  const [rebindTarget, setRebindTarget] = useState<any>(null);
  const [rebindForm, setRebindForm] = useState(createRebindForm());
  const [rebindVerifyResult, setRebindVerifyResult] = useState<any>(null);
  const [rebindVerifying, setRebindVerifying] = useState(false);
  const [rebindSaving, setRebindSaving] = useState(false);

  // ── Model modal ──
  const [modelModal, setModelModal] = useState<ModelModalState>(emptyModelModal);
  const modelModalRequestSeqRef = useRef(0);
  const [visibleModelModalCount, setVisibleModelModalCount] = useState(ACCOUNT_MODEL_MODAL_RENDER_CHUNK);

  // ── Delete ──
  const [deleteConfirm, setDeleteConfirm] = useState<null | { mode: 'single'; accountId: number; accountName: string }>(null);

  // ── Action loading ──
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [keyEditor, setKeyEditor] = useState<KeyEditorState | null>(null);
  const [savingKey, setSavingKey] = useState(false);

  // ── Progressive render ──
  const [visibleAccountCount, setVisibleAccountCount] = useState(60);

  // ── Data loading ──
  const load = useCallback(async () => {
    try {
      const result = await api.getAccounts();
      startTransition(() => {
        setAccounts(result || []);
        setLoaded(true);
      });
    } catch (e: any) {
      toast.error(e?.message || '加载账号列表失败');
    }
  }, [toast]);

  const loadSiteDetail = useCallback(async () => {
    if (!siteId) return;
    setSiteDetailLoading(true);
    try {
      const detail = await api.getSiteDetail(siteId) as SiteDetail;
      setSiteDetail(detail);
    } catch (e: any) {
      toast.error(e?.message || '加载站点详情失败');
    } finally {
      setSiteDetailLoading(false);
    }
  }, [siteId, toast]);

  useEffect(() => {
    if (open && siteId !== null) {
      void load();
      // Reset add panel state when opening for a new site
      setShowAdd(false);
      setAddMode('token');
      setLoginForm({ ...createLoginForm(), siteId });
      setTokenForm({ ...createTokenForm('session'), siteId });
      setVerifyResult(null);
      setEditingAccount(null);
      setRebindTarget(null);
      setModelModal(emptyModelModal);
      setDeleteConfirm(null);
      setVisibleAccountCount(60);
      setActiveTab('accounts');
      setSiteDetail(null);
      setSiteDetailSearch('');
      setKeyEditor(null);
    }
  }, [open, siteId, load]);

  useEffect(() => {
    if (!open || !siteId) return;
    if (activeTab === 'models' || activeTab === 'keys') {
      void loadSiteDetail();
    }
  }, [activeTab, loadSiteDetail, open, siteId]);

  const siteAccounts = useMemo(() => {
    if (!siteId) return [];
    return accounts
      .filter(a => a.siteId === siteId)
      .sort((a, b) => {
        if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
        return (a.sortOrder || 0) - (b.sortOrder || 0);
      });
  }, [accounts, siteId]);

  const renderedAccounts = useMemo(
    () => siteAccounts.slice(0, visibleAccountCount),
    [siteAccounts, visibleAccountCount],
  );

  const hasMoreAccounts = visibleAccountCount < siteAccounts.length;

  const refreshAll = useCallback(() => {
    void load();
    if (activeTab === 'models' || activeTab === 'keys') {
      void loadSiteDetail();
    }
    onSiteBalanceChange();
  }, [activeTab, load, loadSiteDetail, onSiteBalanceChange]);

  // ── withLoading helper ──
  const withLoading = useCallback(async (key: string, fn: () => Promise<any>, successMsg?: string) => {
    setActionLoading(s => ({ ...s, [key]: true }));
    try { await fn(); if (successMsg) toast.success(successMsg); }
    catch (e: any) { toast.error(e.message || '操作失败'); }
    finally {
      setActionLoading(s => ({ ...s, [key]: false }));
      void refreshAll();
    }
  }, [toast, refreshAll]);

  // ── Add: login ──
  const handleLoginAdd = useCallback(async () => {
    if (!loginForm.siteId || !loginForm.username || !loginForm.password) return;
    setSaving(true);
    try {
      const result = await api.loginAccount(loginForm);
      if (result.success) {
        setShowAdd(false);
        const msg = result.apiTokenFound
          ? `账号 "${loginForm.username}" 已添加，API Key 已自动获取`
          : `账号 "${loginForm.username}" 已添加（未找到 API Key，请手动设置）`;
        toast.success(msg);
        setLoginForm({ ...createLoginForm(), siteId: siteId! });
        setVerifyResult(null);
        refreshAll();
      } else {
        toast.error(result.message || '登录失败');
      }
    } catch (e: any) {
      toast.error(e.message || '登录请求失败');
    } finally {
      setSaving(false);
    }
  }, [loginForm, toast, refreshAll]);

  // ── Add: verify token ──
  const handleVerifyToken = useCallback(async () => {
    if (!tokenForm.siteId || !tokenForm.accessToken) return;
    setVerifying(true);
    setVerifyResult(null);
    try {
      const result = await api.verifyToken({
        siteId: tokenForm.siteId,
        accessToken: tokenForm.accessToken.trim(),
        platformUserId: tokenForm.platformUserId ? Number.parseInt(tokenForm.platformUserId, 10) : undefined,
        credentialMode: tokenForm.credentialMode,
      });
      setVerifyResult(result);
      if (result.success && result.tokenType === 'session') {
        toast.success('Session Token 验证成功');
      } else if (result.success && result.tokenType === 'apikey') {
        toast.success('API Key 验证成功');
      } else {
        toast.error(normalizeVerifyFailureMessage(result.message || 'Token 无效'));
      }
    } catch (e: any) {
      toast.error(normalizeVerifyFailureMessage(e?.message));
      setVerifyResult({ success: false, message: e?.message });
    } finally {
      setVerifying(false);
    }
  }, [tokenForm, toast]);

  // ── Add: submit token ──
  const handleTokenAdd = useCallback(async () => {
    if (!tokenForm.siteId || !tokenForm.accessToken) return;
    setSaving(true);
    try {
      const result = await api.addAccount({
        siteId: tokenForm.siteId,
        accessToken: tokenForm.accessToken.trim(),
        username: tokenForm.username.trim() || undefined,
        platformUserId: tokenForm.platformUserId ? Number.parseInt(tokenForm.platformUserId, 10) : undefined,
        credentialMode: tokenForm.credentialMode,
        skipModelFetch: tokenForm.skipModelFetch,
      });
      if (result.batch) {
        toast.info(result.message || `批量创建完成：成功 ${result.successCount}，失败 ${result.failedCount}`);
        setTokenForm({ ...createTokenForm('session'), siteId: siteId! });
        setVerifyResult(null);
        refreshAll();
        return;
      }
      if (result.queued) {
        toast.info(result.message || '账号已添加，后台正在同步初始化信息。');
      } else if (result.tokenType === 'apikey') {
        toast.success('已添加为 API Key 账号');
      } else {
        const parts: string[] = [];
        if (result.usernameDetected) parts.push('用户名已自动识别');
        if (result.apiTokenFound) parts.push('API Key 已自动获取');
        const extra = parts.length ? `（${parts.join('，')}）` : '';
        toast.success(`账号已添加${extra}`);
      }
      setShowAdd(false);
      setTokenForm({ ...createTokenForm('session'), siteId: siteId! });
      setVerifyResult(null);
      refreshAll();
    } catch (e: any) {
      toast.error(e.message || '添加失败');
    } finally {
      setSaving(false);
    }
  }, [tokenForm, toast, refreshAll]);

  // ── Edit ──
  const openEditPanel = useCallback((account: any) => {
    const managedAuth = extractManagedSub2ApiAuth(account);
    const proxyUrl = cachedParseExtraConfig(account)?.proxyUrl || '';
    setRebindTarget(null);
    setEditingAccount(account);
    setEditForm({
      username: account?.username || '',
      status: account?.status || 'active',
      checkinEnabled: account?.checkinEnabled !== false,
      unitCost: account?.unitCost === null || account?.unitCost === undefined ? '' : String(account.unitCost),
      accessToken: account?.accessToken || '',
      apiToken: account?.apiToken || '',
      isPinned: !!account?.isPinned,
      refreshToken: managedAuth.refreshToken,
      tokenExpiresAt: managedAuth.tokenExpiresAt,
      proxyUrl,
    });
  }, []);

  const saveEditPanel = useCallback(async () => {
    if (!editingAccount) return;
    setSavingEdit(true);
    try {
      await api.updateAccount(editingAccount.id, {
        username: editForm.username.trim() || undefined,
        status: editForm.status,
        checkinEnabled: editForm.checkinEnabled,
        unitCost: editForm.unitCost.trim() ? Number(editForm.unitCost.trim()) : null,
        accessToken: editForm.accessToken.trim(),
        apiToken: editForm.apiToken.trim() || null,
        isPinned: editForm.isPinned,
        refreshToken: editForm.refreshToken.trim() || null,
        tokenExpiresAt: editForm.tokenExpiresAt.trim() ? Number.parseInt(editForm.tokenExpiresAt.trim(), 10) : null,
        proxyUrl: editForm.proxyUrl.trim() || null,
      });
      toast.success('账号已更新');
      setEditingAccount(null);
      refreshAll();
    } catch (e: any) {
      toast.error(e.message || '更新账号失败');
    } finally {
      setSavingEdit(false);
    }
  }, [editingAccount, editForm, toast, refreshAll]);

  // ── Delete ──
  const confirmDelete = useCallback(async () => {
    const target = deleteConfirm;
    if (!target) return;
    setDeleteConfirm(null);
    await withLoading(`delete-${target.accountId}`, () => api.deleteAccount(target.accountId), '已删除');
  }, [deleteConfirm, withLoading]);

  // ── Rebind ──
  const openRebindPanel = useCallback((account: any) => {
    setEditingAccount(null);
    setRebindTarget(account);
    setRebindForm(createRebindForm(extractPlatformUserId(account)));
    setRebindVerifyResult(null);
  }, []);

  const handleVerifyRebindToken = useCallback(async () => {
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
        toast.error(normalizeVerifyFailureMessage(result.message || 'Token 无效'));
      }
    } catch (e: any) {
      toast.error(normalizeVerifyFailureMessage(e?.message));
      setRebindVerifyResult({ success: false, message: e?.message });
    } finally {
      setRebindVerifying(false);
    }
  }, [rebindTarget, rebindForm, toast]);

  const handleSubmitRebind = useCallback(async () => {
    if (!rebindTarget || !rebindForm.accessToken.trim()) return;
    if (!(rebindVerifyResult?.success && rebindVerifyResult?.tokenType === 'session')) {
      toast.error('请先验证新的 Session Token 成功');
      return;
    }
    const isSub2Api = ((rebindTarget?.site?.platform || '').toLowerCase() === 'sub2api');
    setRebindSaving(true);
    try {
      await api.rebindAccountSession(rebindTarget.id, {
        accessToken: rebindForm.accessToken.trim(),
        platformUserId: rebindForm.platformUserId ? Number.parseInt(rebindForm.platformUserId, 10) : undefined,
        refreshToken: isSub2Api && rebindForm.refreshToken.trim() ? rebindForm.refreshToken.trim() : undefined,
        tokenExpiresAt: isSub2Api && rebindForm.tokenExpiresAt.trim() ? Number.parseInt(rebindForm.tokenExpiresAt, 10) : undefined,
      });
      toast.success('账号重新绑定成功');
      setRebindTarget(null);
      refreshAll();
    } catch (e: any) {
      toast.error(e.message || '重新绑定失败');
    } finally {
      setRebindSaving(false);
    }
  }, [rebindTarget, rebindForm, rebindVerifyResult, toast, refreshAll]);

  // ── Model modal ──
  const visibleModelModalModels = useMemo(
    () => modelModal.models.slice(0, visibleModelModalCount),
    [modelModal.models, visibleModelModalCount],
  );

  const applyLoadedModelModal = useCallback((account: any, result: any) => {
    const models = Array.isArray(result?.models) ? result.models : [];
    const disabledSet = new Set<string>(models.filter((m: any) => m.disabled).map((m: any) => m.name as string));
    startTransition(() => {
      setVisibleModelModalCount(getInitialVisibleCount(models.length, ACCOUNT_MODEL_MODAL_RENDER_CHUNK));
      setModelModal(s => ({
        ...s,
        loading: false,
        models,
        pendingDisabled: disabledSet,
        siteName: result?.siteName || account.site?.name || s.siteName,
      }));
    });
  }, []);

  const loadModelModalModels = useCallback(async (account: any, options: { refreshUpstream?: boolean; resetBeforeLoad?: boolean; closeOnError?: boolean; successMessage?: string | null; errorMessage?: string } = {}) => {
    const requestId = ++modelModalRequestSeqRef.current;
    setModelModal(s => ({
      ...s,
      open: true,
      account,
      loading: true,
      ...(options.resetBeforeLoad ? { models: [], pendingDisabled: new Set<string>(), siteName: '', manualModelsInput: '' } : {}),
    }));
    try {
      if (options.refreshUpstream) {
        await api.checkModels(account.id);
      }
      const result = await api.getAccountModels(account.id);
      if (modelModalRequestSeqRef.current !== requestId) return;
      applyLoadedModelModal(account, result);
      if (options.successMessage) toast.success(options.successMessage);
    } catch (e: any) {
      if (modelModalRequestSeqRef.current !== requestId) return;
      toast.error(e.message || options.errorMessage || '加载模型列表失败');
      setModelModal(s => (
        options.closeOnError
          ? { ...s, open: false, account: null, loading: false }
          : { ...s, loading: false }
      ));
    }
  }, [toast, applyLoadedModelModal]);

  const openModelModal = useCallback(async (account: any) => {
    await loadModelModalModels(account, { resetBeforeLoad: true, closeOnError: true, errorMessage: '加载模型列表失败' });
  }, [loadModelModalModels]);

  const closeModelModal = useCallback(() => {
    modelModalRequestSeqRef.current += 1;
    setVisibleModelModalCount(ACCOUNT_MODEL_MODAL_RENDER_CHUNK);
    setModelModal(s => ({ ...s, open: false, account: null, manualModelsInput: '', addingManualModels: false }));
  }, []);

  const toggleModelDisabled = useCallback((modelName: string) => {
    setModelModal(s => {
      const next = new Set(s.pendingDisabled);
      if (next.has(modelName)) next.delete(modelName);
      else next.add(modelName);
      return { ...s, pendingDisabled: next };
    });
  }, []);

  const saveModelDisabled = useCallback(async () => {
    if (!modelModal.account) return;
    const sId = modelModal.account.siteId;
    setModelModal(s => ({ ...s, saving: true }));
    try {
      await api.updateSiteDisabledModels(sId, Array.from(modelModal.pendingDisabled));
      try {
        await api.rebuildRoutes(false, false);
        toast.success('模型禁用设置已保存，路由已重建');
      } catch {
        toast.error('模型禁用设置已保存，但路由重建失败');
      }
      closeModelModal();
    } catch (e: any) {
      toast.error(e.message || '保存失败');
    } finally {
      setModelModal(s => ({ ...s, saving: false }));
    }
  }, [modelModal.account, modelModal.pendingDisabled, toast, closeModelModal]);

  const handleAddManualModels = useCallback(async () => {
    if (!modelModal.account || !modelModal.manualModelsInput.trim()) return;
    const modelsToAdd = modelModal.manualModelsInput.split(',').map(m => m.trim()).filter(Boolean);
    if (modelsToAdd.length === 0) return;
    setModelModal(s => ({ ...s, addingManualModels: true }));
    try {
      const res = await api.addAccountAvailableModels(modelModal.account.id, modelsToAdd);
      if (res.success) {
        toast.success('模型已手动添加');
        setModelModal(s => ({ ...s, manualModelsInput: '' }));
        await loadModelModalModels(modelModal.account, { refreshUpstream: false });
      } else {
        toast.error(res.message || '手动添加模型失败');
      }
    } catch (e: any) {
      toast.error(e.message || '手动添加模型失败');
    } finally {
      setModelModal(s => ({ ...s, addingManualModels: false }));
    }
  }, [modelModal.account, modelModal.manualModelsInput, toast, loadModelModalModels]);

  // ── Checkin ──
  const handleCheckin = useCallback(async (accountId: number) => {
    await withLoading(`checkin-${accountId}`, async () => {
      await api.triggerCheckin(accountId);
    }, '签到已触发');
  }, [withLoading]);

  // ── Verify result hints ──
  const verifyFailureHint = buildVerifyFailureHint(verifyResult);
  const addAccountPrereqHint = buildAddAccountPrereqHint(verifyResult);

  const canAddVerifiedConnection = verifyResult?.success;

  const groupOptions = useMemo(() => {
    const values = new Set<string>(['default']);
    siteDetail?.groups.forEach((group) => {
      if (group.group) values.add(group.group);
    });
    siteDetail?.tokens.forEach((token) => {
      if (token.group) values.add(token.group);
    });
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [siteDetail]);

  const keyAccountOptions = useMemo(() => siteAccounts
    .filter((account) => resolveAccountCredentialMode(account) !== 'apikey')
    .map((account) => ({
    value: String(account.id),
    label: resolveAccountDisplayName(account),
  })), [siteAccounts]);

  const filteredSiteModels = useMemo(() => {
    const rows = siteDetail?.models || [];
    if (!deferredSiteDetailSearch) return rows;
    return rows.filter((model) => {
      const haystack = [
        model.name,
        ...model.groups.map((group) => group.group),
        ...model.groups.flatMap((group) => group.tokens.map((token) => `${token.name} ${token.accountName}`)),
      ].join(' ').toLowerCase();
      return haystack.includes(deferredSiteDetailSearch);
    });
  }, [deferredSiteDetailSearch, siteDetail]);

  const filteredSiteGroups = useMemo(() => {
    const rows = siteDetail?.groups || [];
    if (!deferredSiteDetailSearch) return rows;
    return rows.filter((group) => {
      const haystack = [group.group, ...group.models].join(' ').toLowerCase();
      return haystack.includes(deferredSiteDetailSearch);
    });
  }, [deferredSiteDetailSearch, siteDetail]);

  const filteredSiteTokens = useMemo(() => {
    const rows = siteDetail?.tokens || [];
    if (!deferredSiteDetailSearch) return rows;
    return rows.filter((token) => {
      const haystack = [
        token.name,
        token.group,
        token.accountName,
        token.tokenMasked || '',
        ...token.models,
      ].join(' ').toLowerCase();
      return haystack.includes(deferredSiteDetailSearch);
    });
  }, [deferredSiteDetailSearch, siteDetail]);

  const openCreateKeyEditor = useCallback(() => {
    const firstAccountId = keyAccountOptions[0]?.value || '';
    setKeyEditor(createEmptyKeyEditor(firstAccountId));
  }, [keyAccountOptions]);

  const openEditKeyEditor = useCallback((token: SiteDetailToken) => {
    setKeyEditor({
      mode: 'edit',
      tokenId: token.id,
      accountId: String(token.accountId),
      name: token.name,
      group: token.group || 'default',
      token: '',
      enabled: token.enabled,
      isDefault: token.isDefault,
    });
  }, []);

  const saveKeyEditor = useCallback(async () => {
    if (!keyEditor) return;
    const accountId = Number.parseInt(keyEditor.accountId, 10);
    if (!Number.isFinite(accountId) || accountId <= 0) {
      toast.error('请选择账号');
      return;
    }
    if (keyEditor.mode === 'create' && !keyEditor.token.trim()) {
      toast.error('Key 不能为空');
      return;
    }

    setSavingKey(true);
    try {
      const payload = {
        accountId,
        name: keyEditor.name.trim() || undefined,
        group: keyEditor.group.trim() || 'default',
        token: keyEditor.token.trim() || undefined,
        enabled: keyEditor.enabled,
        isDefault: keyEditor.isDefault,
        source: 'manual',
      };
      if (keyEditor.mode === 'create') {
        await api.addAccountToken(payload);
        toast.success('Key 已创建');
      } else if (keyEditor.tokenId) {
        const { accountId: _accountId, ...updates } = payload;
        await api.updateAccountToken(keyEditor.tokenId, updates);
        toast.success('Key 已更新');
      }
      setKeyEditor(null);
      refreshAll();
    } catch (e: any) {
      toast.error(e?.message || '保存 Key 失败');
    } finally {
      setSavingKey(false);
    }
  }, [keyEditor, refreshAll, toast]);

  const copyKey = useCallback(async (token: SiteDetailToken) => {
    await withLoading(`key-copy-${token.id}`, async () => {
      const res = await api.getAccountTokenValue(token.id) as { token?: string };
      const value = String(res?.token || '').trim();
      if (!value) throw new Error('Key 为空');
      await copyText(value);
    }, 'Key 已复制');
  }, [withLoading]);

  const deleteKey = useCallback(async (token: SiteDetailToken) => {
    await withLoading(`key-delete-${token.id}`, () => api.deleteAccountToken(token.id), 'Key 已删除');
  }, [withLoading]);

  const toggleKeyEnabled = useCallback(async (token: SiteDetailToken) => {
    await withLoading(
      `key-toggle-${token.id}`,
      () => api.updateAccountToken(token.id, { enabled: !token.enabled }),
      token.enabled ? 'Key 已停用' : 'Key 已启用',
    );
  }, [withLoading]);

  const setDefaultKey = useCallback(async (token: SiteDetailToken) => {
    await withLoading(`key-default-${token.id}`, () => api.setDefaultAccountToken(token.id), '默认 Key 已更新');
  }, [withLoading]);

  const syncKeysForAccount = useCallback(async (accountId: number) => {
    await withLoading(`key-sync-${accountId}`, () => api.syncAccountTokens(accountId), 'Key 已同步');
  }, [withLoading]);

  const confirmAndDeleteKey = useCallback((token: SiteDetailToken) => {
    const confirmed = typeof window === 'undefined'
      ? true
      : window.confirm(`删除 Key ${token.name}？`);
    if (confirmed) void deleteKey(token);
  }, [deleteKey]);

  // ── Shared styles ──
  const inputStyle: React.CSSProperties = {
    width: '100%', padding: '10px 14px', border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)', fontSize: 13, outline: 'none',
    background: 'var(--color-bg)', color: 'var(--color-text-primary)',
  };

  const renderSiteDetailToolbar = () => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      <input
        value={siteDetailSearch}
        onChange={(event) => setSiteDetailSearch(event.target.value)}
        placeholder={activeTab === 'models' ? '搜索模型、分组、Key' : '搜索 Key、账号、分组、模型'}
        style={{ ...inputStyle, flex: '1 1 240px', minWidth: 180 }}
      />
      <button
        type="button"
        className="btn btn-ghost"
        style={{ border: '1px solid var(--color-border)', padding: '8px 12px' }}
        disabled={siteDetailLoading}
        onClick={() => { void loadSiteDetail(); }}
      >
        {siteDetailLoading ? <><span className="spinner spinner-sm" />刷新中...</> : '刷新详情'}
      </button>
    </div>
  );

  const renderSiteDetailSummary = () => {
    const summary = siteDetail?.summary;
    if (!summary) return null;
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 8, marginBottom: 12 }}>
        {[
          ['账号', summary.accountCount],
          ['Key', summary.tokenCount],
          ['模型', summary.modelCount],
          ['分组', summary.groupCount],
        ].map(([label, value]) => (
          <div key={label} className="card" style={{ padding: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
          </div>
        ))}
      </div>
    );
  };

  const renderModelsTab = () => {
    if (siteDetailLoading && !siteDetail) {
      return <div style={{ textAlign: 'center', padding: 40 }}><span className="spinner" /></div>;
    }
    return (
      <div>
        {renderSiteDetailToolbar()}
        {renderSiteDetailSummary()}
        <div style={{ display: 'grid', gap: 12 }}>
          <div className="card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <div style={{ fontWeight: 700 }}>模型到分组与 Key</div>
              <span className="badge badge-muted" style={{ fontSize: 11 }}>{filteredSiteModels.length} 个模型</span>
            </div>
            {filteredSiteModels.length === 0 ? (
              <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>暂无模型覆盖数据。</div>
            ) : (
              <div style={{ display: 'grid', gap: 8 }}>
                {filteredSiteModels.slice(0, 80).map((model) => (
                  <div key={model.name} style={{ border: '1px solid var(--color-border-light)', borderRadius: 8, padding: 10, display: 'grid', gap: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                      <code style={{ fontSize: 12, wordBreak: 'break-all' }}>{model.name}</code>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        <span className="badge badge-info" style={{ fontSize: 11 }}>{model.groups.length} 分组</span>
                        <span className="badge badge-muted" style={{ fontSize: 11 }}>{model.tokenCount} Key</span>
                      </div>
                    </div>
                    <div style={{ display: 'grid', gap: 6 }}>
                      {model.groups.map((group) => (
                        <div key={`${model.name}-${group.group}`} style={{ display: 'grid', gap: 4 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span className="badge badge-success" style={{ fontSize: 11 }}>{group.group}</span>
                            <span style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{group.accountCount} 账号 / {group.tokenCount} Key</span>
                          </div>
                          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                            {group.tokens.slice(0, 10).map((token) => (
                              <span key={token.id} className={`badge ${token.enabled ? 'badge-muted' : 'badge-error'}`} style={{ fontSize: 10 }}>
                                {token.accountName} / {token.name}{token.isDefault ? ' · 默认' : ''}
                              </span>
                            ))}
                            {group.tokens.length > 10 ? <span className="badge badge-muted" style={{ fontSize: 10 }}>+{group.tokens.length - 10}</span> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="card" style={{ padding: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 8 }}>
              <div style={{ fontWeight: 700 }}>分组到模型</div>
              <span className="badge badge-muted" style={{ fontSize: 11 }}>{filteredSiteGroups.length} 个分组</span>
            </div>
            <div style={{ display: 'grid', gap: 8 }}>
              {filteredSiteGroups.map((group) => (
                <div key={group.group} style={{ border: '1px solid var(--color-border-light)', borderRadius: 8, padding: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                    <span className="badge badge-success">{group.group}</span>
                    <span style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{group.modelCount} 模型 / {group.tokenCount} Key</span>
                  </div>
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {group.models.slice(0, 30).map((model) => (
                      <code key={model} style={{ fontSize: 11, padding: '2px 6px', border: '1px solid var(--color-border-light)', borderRadius: 6 }}>{model}</code>
                    ))}
                    {group.models.length > 30 ? <span className="badge badge-muted" style={{ fontSize: 11 }}>+{group.models.length - 30}</span> : null}
                  </div>
                </div>
              ))}
              {filteredSiteGroups.length === 0 ? (
                <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>暂无分组覆盖数据。</div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const renderKeysTab = () => {
    if (siteDetailLoading && !siteDetail) {
      return <div style={{ textAlign: 'center', padding: 40 }}><span className="spinner" /></div>;
    }
    return (
      <div>
        {renderSiteDetailToolbar()}
        {renderSiteDetailSummary()}
        {filteredSiteTokens.length === 0 ? (
          <div className="empty-state" style={{ padding: 32 }}>
            <div className="empty-state-title">暂无 Key</div>
            <div className="empty-state-desc">可以点击“新增 Key”，或先同步账号 Key。</div>
          </div>
        ) : isMobile ? (
          <div className="mobile-card-list">
            {filteredSiteTokens.map((token) => (
              <MobileCard
                key={token.id}
                title={`${token.accountName} / ${token.name}`}
                subtitle={`${token.group} · ${token.tokenMasked || '****'}`}
                footerActions={
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => { void copyKey(token); }}>复制</button>
                    <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => openEditKeyEditor(token)}>编辑</button>
                    <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }} onClick={() => { void toggleKeyEnabled(token); }}>{token.enabled ? '停用' : '启用'}</button>
                    <button className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px', color: 'var(--color-danger)' }} onClick={() => confirmAndDeleteKey(token)}>删除</button>
                  </div>
                }
              >
                <MobileField label="状态" value={`${token.enabled ? '启用' : '停用'}${token.isDefault ? ' / 默认' : ''}`} />
                <MobileField label="覆盖模型" value={`${token.modelCount}`} />
              </MobileCard>
            ))}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>账号</th>
                  <th>分组</th>
                  <th>状态</th>
                  <th>模型</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredSiteTokens.map((token) => (
                  <tr key={token.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{token.name}</div>
                      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--color-text-muted)' }}>{token.tokenMasked || '****'}</div>
                    </td>
                    <td>{token.accountName}</td>
                    <td><span className="badge badge-success" style={{ fontSize: 11 }}>{token.group}</span></td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <span className={`badge ${token.enabled ? 'badge-info' : 'badge-error'}`} style={{ fontSize: 11 }}>{token.enabled ? '启用' : '停用'}</span>
                        {token.isDefault ? <span className="badge badge-warning" style={{ fontSize: 11 }}>默认</span> : null}
                        {token.valueStatus === 'masked_pending' ? <span className="badge badge-error" style={{ fontSize: 11 }}>待补全</span> : null}
                      </div>
                    </td>
                    <td>
                      <div style={{ fontSize: 12 }}>{token.modelCount} 个</div>
                      <div style={{ color: 'var(--color-text-muted)', fontSize: 11, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {token.models.slice(0, 4).join(' / ') || '未记录'}
                      </div>
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        <button className="btn btn-link btn-link-primary" disabled={!!actionLoading[`key-copy-${token.id}`]} onClick={() => { void copyKey(token); }}>复制</button>
                        <button className="btn btn-link btn-link-primary" onClick={() => openEditKeyEditor(token)}>编辑</button>
                        <button className="btn btn-link btn-link-primary" disabled={!!actionLoading[`key-toggle-${token.id}`]} onClick={() => { void toggleKeyEnabled(token); }}>{token.enabled ? '停用' : '启用'}</button>
                        {!token.isDefault ? (
                          <button className="btn btn-link btn-link-primary" disabled={!!actionLoading[`key-default-${token.id}`]} onClick={() => { void setDefaultKey(token); }}>设默认</button>
                        ) : null}
                        <button className="btn btn-link btn-link-primary" disabled={!!actionLoading[`key-sync-${token.accountId}`]} onClick={() => { void syncKeysForAccount(token.accountId); }}>同步</button>
                        <button className="btn btn-link btn-link-danger" disabled={!!actionLoading[`key-delete-${token.id}`]} onClick={() => confirmAndDeleteKey(token)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
  };

  const renderAccountsTab = () => {
    if (!loaded) {
      return (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <span className="spinner" />
        </div>
      );
    }
    if (siteAccounts.length === 0 && !showAdd) {
      return (
        <div className="empty-state" style={{ padding: 40 }}>
          <div className="empty-state-title">暂无账号</div>
          <div className="empty-state-desc">点击"+ 添加账号"开始使用。</div>
        </div>
      );
    }
    if (isMobile) {
      return (
        <div className="mobile-card-list">
          {renderedAccounts.map(renderAccountCard)}
          {hasMoreAccounts && (
            <div style={{ textAlign: 'center', padding: '12px 0' }}>
              <button onClick={() => setVisibleAccountCount(c => c + 30)} className="btn btn-ghost">
                加载更多（{siteAccounts.length - visibleAccountCount} 条）
              </button>
            </div>
          )}
        </div>
      );
    }
    return (
      <div style={{ overflowX: 'auto' }}>
        <table className="data-table" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>连接名称</th>
              <th>运行健康</th>
              <th>余额</th>
              <th>签到</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {renderedAccounts.map(renderAccountRow)}
          </tbody>
        </table>
        {hasMoreAccounts && (
          <div style={{ textAlign: 'center', padding: '12px 0' }}>
            <button onClick={() => setVisibleAccountCount(c => c + 30)} className="btn btn-ghost">
              加载更多（{siteAccounts.length - visibleAccountCount} 条）
            </button>
          </div>
        )}
      </div>
    );
  };

  const renderActiveTab = () => {
    if (activeTab === 'models') return renderModelsTab();
    if (activeTab === 'keys') return renderKeysTab();
    return renderAccountsTab();
  };

  // ── Render: account row (desktop) ──
  const renderAccountRow = (a: any) => {
    const capabilities = resolveAccountCapabilities(a);
    const connectionMode = resolveAccountCredentialMode(a);
    const autoCheckin = resolveAccountAutoCheckin(a, capabilities);
    const health = resolveRuntimeHealth(a);
    const modeLabel = connectionMode === 'apikey' ? 'API Key' : 'Session';
    const modeCls = connectionMode === 'apikey' ? 'badge-warning' : 'badge-info';
    const hasProxy = !!cachedParseExtraConfig(a)?.proxyUrl;

    return (
      <tr key={a.id}>
        <td>
          <div style={{ fontWeight: 600 }}>{resolveAccountDisplayName(a)}</div>
          <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
            <span className={`badge ${modeCls}`} style={{ fontSize: 10 }}>{modeLabel}</span>
            {hasProxy && <span className="badge badge-info" style={{ fontSize: 10 }}>代理</span>}
          </div>
        </td>
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className={`status-dot ${health.dotClass}${health.pulse ? ' pulse' : ''}`} />
            <span className={`badge ${health.cls}`} style={{ fontSize: 11 }}>{health.label}</span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>{health.reason}</div>
        </td>
        <td style={{ whiteSpace: 'nowrap' }}>
          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{formatUsd(a.balance)}</span>
          {a.todayReward > 0 && (
            <div style={{ fontSize: 11, color: 'var(--color-success)' }}>+{formatUsd(a.todayReward)}</div>
          )}
        </td>
        <td>
          <span className={`badge ${autoCheckin.cls}`} style={{ fontSize: 11 }}>{autoCheckin.label}</span>
          <div style={{ fontSize: 11, color: 'var(--color-text-muted)', marginTop: 2 }}>{autoCheckin.reason}</div>
        </td>
        <td>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
            {capabilities.canRefreshBalance && (
              <button onClick={() => withLoading(`refresh-${a.id}`, () => api.refreshBalance(a.id), '余额已刷新')}
                disabled={actionLoading[`refresh-${a.id}`]} className="btn btn-link btn-link-primary">
                {actionLoading[`refresh-${a.id}`] ? <><span className="spinner spinner-sm" /></> : '刷新余额'}
              </button>
            )}
            <button onClick={() => openModelModal(a)} disabled={modelModal.loading} className="btn btn-link btn-link-primary">模型</button>
            {capabilities.canCheckin && (
              <button onClick={() => handleCheckin(a.id)} disabled={actionLoading[`checkin-${a.id}`]} className="btn btn-link btn-link-primary">
                {actionLoading[`checkin-${a.id}`] ? <><span className="spinner spinner-sm" /></> : '签到'}
              </button>
            )}
            {a.status === 'expired' && !capabilities.proxyOnly && (
              <button onClick={() => openRebindPanel(a)} className="btn btn-link btn-link-primary">重绑</button>
            )}
            <button onClick={() => openEditPanel(a)} className="btn btn-link btn-link-primary">编辑</button>
            <button onClick={() => setDeleteConfirm({ mode: 'single', accountId: a.id, accountName: resolveAccountDisplayName(a) })}
              disabled={actionLoading[`delete-${a.id}`]} className="btn btn-link btn-link-danger">
              删除
            </button>
          </div>
        </td>
      </tr>
    );
  };

  // ── Render: account card (mobile) ──
  const renderAccountCard = (a: any) => {
    const capabilities = resolveAccountCapabilities(a);
    const connectionMode = resolveAccountCredentialMode(a);
    const autoCheckin = resolveAccountAutoCheckin(a, capabilities);
    const health = resolveRuntimeHealth(a);
    const modeLabel = connectionMode === 'apikey' ? 'API Key' : 'Session';
    const modeCls = connectionMode === 'apikey' ? 'badge-warning' : 'badge-info';

    return (
      <MobileCard
        key={a.id}
        title={resolveAccountDisplayName(a)}
        subtitle={
          <div style={{ display: 'flex', gap: 4, marginTop: 2, flexWrap: 'wrap' }}>
            <span className={`badge ${modeCls}`} style={{ fontSize: 10 }}>{modeLabel}</span>
            <span className={`badge ${health.cls}`} style={{ fontSize: 10 }}>{health.label}</span>
          </div>
        }
        footerActions={
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {capabilities.canRefreshBalance && (
              <button onClick={() => withLoading(`refresh-${a.id}`, () => api.refreshBalance(a.id), '余额已刷新')}
                disabled={actionLoading[`refresh-${a.id}`]} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }}>
                刷新余额
              </button>
            )}
            <button onClick={() => openModelModal(a)} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }}>模型</button>
            {capabilities.canCheckin && (
              <button onClick={() => handleCheckin(a.id)} disabled={actionLoading[`checkin-${a.id}`]}
                className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }}>签到</button>
            )}
            {a.status === 'expired' && !capabilities.proxyOnly && (
              <button onClick={() => openRebindPanel(a)} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }}>重绑</button>
            )}
            <button onClick={() => openEditPanel(a)} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px' }}>编辑</button>
            <button onClick={() => setDeleteConfirm({ mode: 'single', accountId: a.id, accountName: resolveAccountDisplayName(a) })}
              disabled={actionLoading[`delete-${a.id}`]} className="btn btn-ghost" style={{ fontSize: 11, padding: '4px 8px', color: 'var(--color-danger)' }}>
              删除
            </button>
          </div>
        }
      >
        <MobileField label="余额" value={formatUsd(a.balance)} />
        <MobileField label="签到" value={`${autoCheckin.label} — ${autoCheckin.reason}`} />
        <MobileField label="健康" value={`${health.label} — ${health.reason}`} />
      </MobileCard>
    );
  };

  // ── Render ──
  return (
    <>
      <CenteredModal
        open={open}
        onClose={onClose}
        title={
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', paddingRight: 32 }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>{siteName} — 账号管理</span>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {activeTab === 'keys' ? (
                <button
                  type="button"
                  onClick={openCreateKeyEditor}
                  className="btn btn-primary"
                  style={{ fontSize: 12, padding: '4px 12px' }}
                >
                  + 新增 Key
                </button>
              ) : null}
              <button
                onClick={() => {
                  setShowAdd(true);
                  setAddMode('token');
                  setVerifyResult(null);
                  setTokenForm(prev => ({ ...prev, siteId: siteId! }));
                  setLoginForm(prev => ({ ...prev, siteId: siteId! }));
                }}
                className="btn btn-success"
                style={{ fontSize: 12, padding: '4px 12px' }}
              >
                + 添加账号
              </button>
            </div>
          </div>
        }
        maxWidth={1100}
        bodyStyle={{ maxHeight: '80vh', overflow: 'auto' }}
      >
        <div className="tabs" style={{ marginBottom: 14 }}>
          {[
            ['accounts', `账号（${siteAccounts.length}）`],
            ['models', '模型分组'],
            ['keys', 'Key 管理'],
          ].map(([tab, label]) => (
            <button
              key={tab}
              type="button"
              className={`tab ${activeTab === tab ? 'active' : ''}`}
              onClick={() => setActiveTab(tab as SiteManagerTab)}
            >
              {label}
            </button>
          ))}
        </div>
        {renderActiveTab()}
      </CenteredModal>

      {/* ── Add Account Modal ── */}
      <CenteredModal
        open={showAdd}
        onClose={() => setShowAdd(false)}
        title="添加账号"
        maxWidth={560}
      >
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <button
            onClick={() => setAddMode('token')}
            className={`btn ${addMode === 'token' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 12, padding: '6px 12px' }}
          >
            Token / Cookie
          </button>
          <button
            onClick={() => setAddMode('login')}
            className={`btn ${addMode === 'login' ? 'btn-primary' : 'btn-ghost'}`}
            style={{ fontSize: 12, padding: '6px 12px' }}
          >
            账号密码登录
          </button>
        </div>

        {addMode === 'login' ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <input placeholder="用户名" value={loginForm.username}
              onChange={(e) => setLoginForm(f => ({ ...f, username: e.target.value }))} style={inputStyle} />
            <input type="password" placeholder="密码" value={loginForm.password}
              onChange={(e) => setLoginForm(f => ({ ...f, password: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && handleLoginAdd()} style={inputStyle} />
            <button onClick={handleLoginAdd}
              disabled={saving || !loginForm.siteId || !loginForm.username || !loginForm.password}
              className="btn btn-success" style={{ alignSelf: 'flex-start' }}>
              {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />登录并添加...</> : '登录并添加'}
            </button>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="info-tip surface-card" style={{ fontSize: 12 }}>
              站点: <strong>{siteName}</strong>（固定）
            </div>
            <input placeholder="连接名称（可选）" value={tokenForm.username}
              onChange={(e) => setTokenForm(f => ({ ...f, username: e.target.value }))} style={inputStyle} />
            <textarea placeholder="粘贴 Session Token / Cookie"
              value={tokenForm.accessToken}
              onChange={(e) => { const v = e.target.value.trim(); setTokenForm(f => ({ ...f, accessToken: v, accessTokens: v })); setVerifyResult(null); }}
              style={{ ...inputStyle, fontFamily: 'var(--font-mono)', height: 72, resize: 'none' as const }} />
            <input placeholder="platformUserId（可选）" value={tokenForm.platformUserId}
              onChange={(e) => setTokenForm(f => ({ ...f, platformUserId: e.target.value.replace(/\D/g, '') }))} style={inputStyle} />

            {verifyResult && verifyResult.success && verifyResult.tokenType === 'session' && (
              <div className="alert alert-success animate-scale-in">
                <div className="alert-title">Session 凭证有效</div>
                <div style={{ fontSize: 12, lineHeight: 1.8 }}>
                  <div>用户名: <strong>{verifyResult.userInfo?.username || '未知'}</strong></div>
                  {verifyResult.balance && <div>余额: <strong>${(verifyResult.balance.balance || 0).toFixed(2)}</strong></div>}
                </div>
              </div>
            )}
            {verifyResult && !verifyResult.success && verifyResult.needsUserId && (
              <div className="alert alert-warning animate-scale-in">
                <div className="alert-title">此站点要求用户 ID，请补充后重新验证</div>
              </div>
            )}
            {verifyResult && !verifyResult.success && !verifyResult.needsUserId && (
              <div className="alert alert-error animate-scale-in">
                <div className="alert-title">{normalizeVerifyFailureMessage(verifyResult.message) || 'Token 无效或已过期'}</div>
                <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 4 }}>{verifyFailureHint || '请检查 Token 是否正确'}</div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleVerifyToken}
                disabled={verifying || !tokenForm.siteId || !tokenForm.accessToken}
                className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}>
                {verifying ? <><span className="spinner spinner-sm" />验证中...</> : '验证 Token'}
              </button>
              <button onClick={handleTokenAdd}
                disabled={saving || !tokenForm.siteId || !tokenForm.accessToken || !canAddVerifiedConnection}
                className="btn btn-success">
                {saving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />添加中...</> : '添加连接'}
              </button>
            </div>
            {!verifyResult?.success && <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{addAccountPrereqHint}</div>}
          </div>
        )}
      </CenteredModal>

      {/* ── Edit Account Modal ── */}
      <CenteredModal
        open={editingAccount !== null}
        onClose={() => setEditingAccount(null)}
        title={`编辑: ${resolveAccountDisplayName(editingAccount)}`}
        maxWidth={560}
      >
        <ResponsiveFormGrid>
          <div>
            <label className="form-label">用户名</label>
            <input value={editForm.username} onChange={(e) => setEditForm(f => ({ ...f, username: e.target.value }))} style={inputStyle} />
          </div>
          <div>
            <label className="form-label">状态</label>
            <select value={editForm.status} onChange={(e) => setEditForm(f => ({ ...f, status: e.target.value }))}
              style={{ ...inputStyle, appearance: 'auto' as any }}>
              <option value="active">启用</option>
              <option value="disabled">禁用</option>
              <option value="expired">过期</option>
            </select>
          </div>
          <div>
            <label className="form-label">签到</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={editForm.checkinEnabled} onChange={(e) => setEditForm(f => ({ ...f, checkinEnabled: e.target.checked }))} />
              参与批量签到
            </label>
          </div>
          <div>
            <label className="form-label">单位成本</label>
            <input value={editForm.unitCost} onChange={(e) => setEditForm(f => ({ ...f, unitCost: e.target.value }))} placeholder="留空则不设置" style={inputStyle} />
          </div>
          <div>
            <label className="form-label">Access Token</label>
            <input value={editForm.accessToken} onChange={(e) => setEditForm(f => ({ ...f, accessToken: e.target.value }))} style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 11 }} />
          </div>
          <div>
            <label className="form-label">API Token</label>
            <input value={editForm.apiToken} onChange={(e) => setEditForm(f => ({ ...f, apiToken: e.target.value }))} style={{ ...inputStyle, fontFamily: 'var(--font-mono)', fontSize: 11 }} />
          </div>
          <div>
            <label className="form-label">代理 URL</label>
            <input value={editForm.proxyUrl} onChange={(e) => setEditForm(f => ({ ...f, proxyUrl: e.target.value }))} placeholder="覆盖站点默认代理" style={inputStyle} />
          </div>
          <div>
            <label className="form-label">置顶</label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
              <input type="checkbox" checked={editForm.isPinned} onChange={(e) => setEditForm(f => ({ ...f, isPinned: e.target.checked }))} />
              置顶显示
            </label>
          </div>
        </ResponsiveFormGrid>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end' }}>
          <button onClick={() => setEditingAccount(null)} className="btn btn-ghost">取消</button>
          <button onClick={saveEditPanel} disabled={savingEdit} className="btn btn-primary">
            {savingEdit ? <><span className="spinner spinner-sm" />保存中...</> : '保存'}
          </button>
        </div>
      </CenteredModal>

      {/* ── Rebind Session Modal ── */}
      <CenteredModal
        open={rebindTarget !== null}
        onClose={() => { setRebindTarget(null); setRebindVerifyResult(null); setRebindVerifying(false); setRebindSaving(false); }}
        title={`重绑 Session: ${resolveAccountDisplayName(rebindTarget)}`}
        maxWidth={560}
      >
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 12 }}>
          连接: {resolveAccountDisplayName(rebindTarget)} @ {rebindTarget?.site?.name || '-'}。请粘贴新的 Session Token，验证成功后再绑定。
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea placeholder="粘贴新的 Session Token / Cookie"
            value={rebindForm.accessToken}
            onChange={(e) => setRebindForm(f => ({ ...f, accessToken: e.target.value }))}
            style={{ ...inputStyle, fontFamily: 'var(--font-mono)', height: 72, resize: 'none' as const }} />
          <input placeholder="platformUserId（可选）" value={rebindForm.platformUserId}
            onChange={(e) => setRebindForm(f => ({ ...f, platformUserId: e.target.value.replace(/\D/g, '') }))} style={inputStyle} />

          {rebindVerifyResult && rebindVerifyResult.success && rebindVerifyResult.tokenType === 'session' && (
            <div className="alert alert-success animate-scale-in">
              <div className="alert-title">Session Token 验证成功，可以重新绑定</div>
            </div>
          )}
          {rebindVerifyResult && !rebindVerifyResult.success && (
            <div className="alert alert-error animate-scale-in">
              <div className="alert-title">{normalizeVerifyFailureMessage(rebindVerifyResult.message) || 'Token 无效'}</div>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={handleVerifyRebindToken}
              disabled={rebindVerifying || !rebindForm.accessToken.trim()}
              className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}>
              {rebindVerifying ? <><span className="spinner spinner-sm" />验证中...</> : '验证 Token'}
            </button>
            <button onClick={handleSubmitRebind}
              disabled={rebindSaving || !(rebindVerifyResult?.success && rebindVerifyResult?.tokenType === 'session')}
              className="btn btn-success">
              {rebindSaving ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />绑定中...</> : '重新绑定'}
            </button>
          </div>
        </div>
      </CenteredModal>

      {/* ── Model Management Modal ── */}
      <CenteredModal
        open={modelModal.open}
        onClose={closeModelModal}
        title={`模型管理: ${modelModal.siteName || resolveAccountDisplayName(modelModal.account)}`}
        maxWidth={720}
        bodyStyle={{ maxHeight: '70vh', overflow: 'auto' }}
        footer={
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={closeModelModal} className="btn btn-ghost">取消</button>
            <button onClick={saveModelDisabled} disabled={modelModal.saving} className="btn btn-primary">
              {modelModal.saving ? <><span className="spinner spinner-sm" />保存中...</> : '保存禁用设置'}
            </button>
          </div>
        }
      >
        {modelModal.loading ? (
          <div style={{ textAlign: 'center', padding: 40 }}><span className="spinner" /></div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              <button onClick={() => { if (modelModal.account) loadModelModalModels(modelModal.account, { refreshUpstream: true, successMessage: '模型已刷新' }); }}
                disabled={modelModal.loading} className="btn btn-ghost" style={{ fontSize: 12 }}>
                刷新模型
              </button>
              <button onClick={() => setModelModal(s => ({ ...s, pendingDisabled: new Set<string>() }))} className="btn btn-ghost" style={{ fontSize: 12 }}>
                全部启用
              </button>
              <button onClick={() => setModelModal(s => ({ ...s, pendingDisabled: new Set(s.models.map((m: any) => m.name as string)) }))} className="btn btn-ghost" style={{ fontSize: 12 }}>
                全部禁用
              </button>
              <button onClick={() => {
                const inverted = new Set<string>();
                modelModal.models.forEach((m: any) => { if (!modelModal.pendingDisabled.has(m.name)) inverted.add(m.name); });
                setModelModal(s => ({ ...s, pendingDisabled: inverted }));
              }} className="btn btn-ghost" style={{ fontSize: 12 }}>
                反选
              </button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 8 }}>
              共 {modelModal.models.length} 个模型，已禁用 {modelModal.pendingDisabled.size} 个
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 300, overflow: 'auto' }}>
              {visibleModelModalModels.map((m: any) => (
                <label key={m.name} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, padding: '2px 0' }}>
                  <input type="checkbox" checked={!modelModal.pendingDisabled.has(m.name)}
                    onChange={() => toggleModelDisabled(m.name)} />
                  <span style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>{m.name}</span>
                </label>
              ))}
            </div>
            {visibleModelModalCount < modelModal.models.length && (
              <button onClick={() => setVisibleModelModalCount(c => c + ACCOUNT_MODEL_MODAL_RENDER_CHUNK)}
                className="btn btn-ghost" style={{ fontSize: 12, marginTop: 8 }}>
                加载更多模型（{modelModal.models.length - visibleModelModalCount} 个）
              </button>
            )}
            <div style={{ marginTop: 12, borderTop: '1px solid var(--color-border)', paddingTop: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>手动添加模型</div>
              <div style={{ display: 'flex', gap: 8 }}>
                <input placeholder="模型名，逗号分隔" value={modelModal.manualModelsInput}
                  onChange={(e) => setModelModal(s => ({ ...s, manualModelsInput: e.target.value }))}
                  style={{ ...inputStyle, flex: 1 }} />
                <button onClick={handleAddManualModels} disabled={modelModal.addingManualModels || !modelModal.manualModelsInput.trim()}
                  className="btn btn-ghost" style={{ whiteSpace: 'nowrap' }}>
                  {modelModal.addingManualModels ? <><span className="spinner spinner-sm" /></> : '添加'}
                </button>
              </div>
            </div>
          </>
        )}
      </CenteredModal>

      {/* ── Key Editor Modal ── */}
      <CenteredModal
        open={keyEditor !== null}
        onClose={() => setKeyEditor(null)}
        title={keyEditor?.mode === 'edit' ? '编辑 Key' : '新增 Key'}
        maxWidth={620}
      >
        {keyEditor ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {keyEditor.mode === 'create' && keyAccountOptions.length === 0 ? (
              <div className="alert alert-warning">
                <div className="alert-title">当前站点没有可创建 Key 的 Session 账号</div>
              </div>
            ) : null}
            <ResponsiveFormGrid>
              <div>
                <label className="form-label">账号</label>
                <select
                  value={keyEditor.accountId}
                  disabled={keyEditor.mode === 'edit'}
                  onChange={(event) => setKeyEditor((state) => state ? { ...state, accountId: event.target.value } : state)}
                  style={{ ...inputStyle, appearance: 'auto' as any }}
                >
                  <option value="">请选择账号</option>
                  {keyAccountOptions.map((account) => (
                    <option key={account.value} value={account.value}>{account.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="form-label">名称</label>
                <input
                  value={keyEditor.name}
                  onChange={(event) => setKeyEditor((state) => state ? { ...state, name: event.target.value } : state)}
                  placeholder="default / route-a"
                  style={inputStyle}
                />
              </div>
              <div>
                <label className="form-label">分组</label>
                <input
                  list={`site-key-groups-${siteId || 'new'}`}
                  value={keyEditor.group}
                  onChange={(event) => setKeyEditor((state) => state ? { ...state, group: event.target.value } : state)}
                  placeholder="default"
                  style={inputStyle}
                />
                <datalist id={`site-key-groups-${siteId || 'new'}`}>
                  {groupOptions.map((group) => <option key={group} value={group} />)}
                </datalist>
              </div>
              <div>
                <label className="form-label">状态</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 38, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={keyEditor.enabled}
                      onChange={(event) => setKeyEditor((state) => state ? { ...state, enabled: event.target.checked } : state)}
                    />
                    启用
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
                    <input
                      type="checkbox"
                      checked={keyEditor.isDefault}
                      onChange={(event) => setKeyEditor((state) => state ? { ...state, isDefault: event.target.checked } : state)}
                    />
                    默认
                  </label>
                </div>
              </div>
            </ResponsiveFormGrid>
            <div>
              <label className="form-label">Key</label>
              <textarea
                value={keyEditor.token}
                onChange={(event) => setKeyEditor((state) => state ? { ...state, token: event.target.value } : state)}
                placeholder={keyEditor.mode === 'edit' ? '留空则不修改明文 Key' : '粘贴完整 Key'}
                style={{ ...inputStyle, minHeight: 88, fontFamily: 'var(--font-mono)', fontSize: 12, resize: 'vertical' as const }}
              />
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button type="button" onClick={() => setKeyEditor(null)} className="btn btn-ghost">取消</button>
              <button
                type="button"
                onClick={() => { void saveKeyEditor(); }}
                disabled={savingKey || (keyEditor.mode === 'create' && (keyAccountOptions.length === 0 || !keyEditor.token.trim()))}
                className="btn btn-primary"
              >
                {savingKey ? <><span className="spinner spinner-sm" />保存中...</> : '保存 Key'}
              </button>
            </div>
          </div>
        ) : null}
      </CenteredModal>

      {/* ── Delete Confirm ── */}
      <DeleteConfirmModal
        open={Boolean(deleteConfirm)}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={confirmDelete}
        title="确认删除账号"
        confirmText="确认删除"
        loading={Boolean(actionLoading[`delete-${deleteConfirm?.accountId}`])}
        description={deleteConfirm ? (
          <>确定要删除账号 <strong>{deleteConfirm.accountName}</strong> 吗？</>
        ) : null}
      />
    </>
  );
}
