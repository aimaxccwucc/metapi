import React, { Suspense, lazy, memo, startTransition, useState, useEffect, useRef } from 'react';
import { Routes, Route, NavLink, Navigate, useLocation } from 'react-router-dom';
import { ToastProvider, useToast } from './components/Toast.js';
import { api } from './api.js';
import type { RuntimeOverview } from './api.js';
import { clearAuthSession, hasValidAuthSession, persistAuthSession } from './authSession.js';
import {
  APP_INSTALL_BANNER_DISMISSED_KEY,
  APP_INSTALL_IOS_HINT_DISMISSED_KEY,
  FIRST_USE_DOC_REMINDER_KEY,
  LEGACY_THEME_STORAGE_KEY,
  THEME_MODE_STORAGE_KEY,
  USER_PROFILE_STORAGE_KEY,
} from './appLocalState.js';
import { I18nProvider, useI18n } from './i18n.js';
import { resolveLoginErrorMessage } from './loginError.js';
import { SITE_DOCS_URL, SITE_GITHUB_URL } from './docsLink.js';
import { useAnimatedVisibility } from './components/useAnimatedVisibility.js';
import { useIsMobile } from './components/useIsMobile.js';
import {
  APP_VERSION_RELOAD_STORAGE_KEY,
  extractEntryAssetPathFromHtml,
  findCurrentEntryAssetPath,
} from './appVersion.js';
import {
  isIosDevice,
  isStandaloneDisplayMode,
  type DeferredInstallPromptEvent,
} from './pwa.js';
import CenteredModal from './components/CenteredModal.js';
import RouteErrorBoundary from './components/RouteErrorBoundary.js';
const SearchModal = lazy(() => import('./components/SearchModal.js'));
const NotificationPanel = lazy(() => import('./components/NotificationPanel.js'));
const TooltipLayer = lazy(() => import('./components/TooltipLayer.js'));
const MobileDrawer = lazy(() => import('./components/MobileDrawer.js').then((module) => ({ default: module.MobileDrawer })));
const Dashboard = lazy(() => import('./pages/Dashboard.js'));
const Sites = lazy(() => import('./pages/Sites.js'));
const Accounts = lazy(() => import('./pages/Accounts.js'));
const Tokens = lazy(() => import('./pages/Tokens.js'));
const CheckinLog = lazy(() => import('./pages/CheckinLog.js'));
const TokenRoutes = lazy(() => import('./pages/TokenRoutes.js'));
const ProxyLogs = lazy(() => import('./pages/ProxyLogs.js'));
const Settings = lazy(() => import('./pages/Settings.js'));
const DownstreamKeys = lazy(() => import('./pages/DownstreamKeys.js'));
const ImportExport = lazy(() => import('./pages/ImportExport.js'));
const NotificationSettings = lazy(() => import('./pages/NotificationSettings.js'));
const ProgramLogs = lazy(() => import('./pages/ProgramLogs.js'));
const Models = lazy(() => import('./pages/Models.js'));
const About = lazy(() => import('./pages/About.js'));
const ModelTester = lazy(() => import('./pages/ModelTester.js'));
const Monitors = lazy(() => import('./pages/Monitors.js'));
const OAuthManagement = lazy(() => import('./pages/OAuthManagement.js'));
const SiteAnnouncements = lazy(() => import('./pages/SiteAnnouncements.js'));
const CredentialDiagnostics = lazy(() => import('./pages/CredentialDiagnostics.js'));
const OptimizationWorkbench = lazy(() => import('./pages/OptimizationWorkbench.js'));

const routePreloaders = {
  '/': () => import('./pages/Dashboard.js'),
  '/sites': () => import('./pages/Sites.js'),
  '/site-announcements': () => import('./pages/SiteAnnouncements.js'),
  '/accounts': () => import('./pages/Accounts.js'),
  '/oauth': () => import('./pages/OAuthManagement.js'),
  '/tokens': () => import('./pages/Tokens.js'),
  '/checkin': () => import('./pages/CheckinLog.js'),
  '/routes': () => import('./pages/TokenRoutes.js'),
  '/token-routes': () => import('./pages/TokenRoutes.js'),
  '/logs': () => import('./pages/ProxyLogs.js'),
  '/monitor': () => import('./pages/Monitors.js'),
  '/monitors': () => import('./pages/Monitors.js'),
  '/diagnostics': () => import('./pages/CredentialDiagnostics.js'),
  '/credential-diagnostics': () => import('./pages/CredentialDiagnostics.js'),
  '/optimization': () => import('./pages/OptimizationWorkbench.js'),
  '/settings': () => import('./pages/Settings.js'),
  '/downstream-keys': () => import('./pages/DownstreamKeys.js'),
  '/events': () => import('./pages/ProgramLogs.js'),
  '/program-logs': () => import('./pages/ProgramLogs.js'),
  '/settings/import-export': () => import('./pages/ImportExport.js'),
  '/import-export': () => import('./pages/ImportExport.js'),
  '/settings/notify': () => import('./pages/NotificationSettings.js'),
  '/notifications': () => import('./pages/NotificationSettings.js'),
  '/models': () => import('./pages/Models.js'),
  '/playground': () => import('./pages/ModelTester.js'),
  '/about': () => import('./pages/About.js'),
} as const;

const preloadedRouteSet = new Set<string>();

const RUNTIME_OVERVIEW_POLL_MS = 60_000;
const HIGH_PROXY_FAILURE_COUNT_THRESHOLD = 20;
const EXTREME_PROXY_FAILURE_COUNT_THRESHOLD = 50;
const HIGH_PROXY_FAILURE_RATE_THRESHOLD = 0.12;
const APP_VERSION_CHECK_INTERVAL_MS = 60_000;

function preloadRoute(path: string) {
  if (preloadedRouteSet.has(path)) return;
  const loader = routePreloaders[path as keyof typeof routePreloaders];
  if (!loader) return;
  preloadedRouteSet.add(path);
  void loader();
}

function summarizeRecentProxyFailures(overview: RuntimeOverview): {
  tone: 'info' | 'warning' | 'error';
  failures: number;
  requests: number;
  rate: number;
} | null {
  const failures = Math.max(0, overview.recentActivity.proxyFailures24h || 0);
  const requests = Math.max(
    failures,
    Math.max(0, overview.recentActivity.proxyRequests24h || 0),
  );
  if (failures <= 0 || requests <= 0) return null;

  const rate = failures / requests;
  const isElevated = failures >= HIGH_PROXY_FAILURE_COUNT_THRESHOLD && rate >= HIGH_PROXY_FAILURE_RATE_THRESHOLD;
  const isSevere = failures >= EXTREME_PROXY_FAILURE_COUNT_THRESHOLD || (failures >= 30 && rate >= 0.2);

  if (!isElevated && !isSevere) return null;

  return {
    tone: isSevere ? 'error' : 'warning',
    failures,
    requests,
    rate,
  };
}

function formatPercent(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

type InstallBannerState = {
  mode: 'native' | 'ios_hint';
  visible: boolean;
};

type ThemeMode = 'system' | 'light' | 'dark';

type UserProfile = {
  name: string;
  avatarSeed: string;
  avatarStyle: string;
};
const DICEBEAR_STYLES = [
  'pixel-art',
  'pixel-art-neutral',
  'bottts',
  'bottts-neutral',
  'identicon',
  'initials',
  'avataaars',
  'avataaars-neutral',
  'personas',
  'lorelei',
  'lorelei-neutral',
  'fun-emoji',
] as const;

type DicebearStyle = typeof DICEBEAR_STYLES[number];

function resolveStoredThemeMode(): ThemeMode {
  const saved = localStorage.getItem(THEME_MODE_STORAGE_KEY);
  if (saved === 'system' || saved === 'light' || saved === 'dark') return saved;
  const legacy = localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  if (legacy === 'light' || legacy === 'dark') return legacy;
  return 'system';
}

function createRandomAvatarSeed(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `seed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function hashString(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash);
}

function pickDicebearStyle(seed: string): DicebearStyle {
  const index = hashString(seed || 'default') % DICEBEAR_STYLES.length;
  return DICEBEAR_STYLES[index];
}

function buildDicebearAvatarUrl(style: string, seed: string): string {
  const safeStyle = DICEBEAR_STYLES.includes(style as DicebearStyle)
    ? style
    : pickDicebearStyle(seed);
  const safeSeed = (seed || 'default').trim() || 'default';
  return `https://api.dicebear.com/9.x/${safeStyle}/svg?seed=${encodeURIComponent(safeSeed)}`;
}

function resolveStoredProfile(): UserProfile {
  try {
    const raw = localStorage.getItem(USER_PROFILE_STORAGE_KEY);
    if (!raw) {
      const avatarSeed = createRandomAvatarSeed();
      return { name: '管理员', avatarSeed, avatarStyle: pickDicebearStyle(avatarSeed) };
    }
    const parsed = JSON.parse(raw) as Partial<UserProfile> & { avatar?: string };
    const name = typeof parsed?.name === 'string' ? parsed.name.trim() : '';
    const avatarSeed = typeof parsed?.avatarSeed === 'string'
      ? parsed.avatarSeed.trim()
      : (typeof parsed?.avatar === 'string' ? parsed.avatar.trim() : '');
    const resolvedSeed = avatarSeed || createRandomAvatarSeed();
    const avatarStyle = typeof parsed?.avatarStyle === 'string'
      ? parsed.avatarStyle.trim()
      : '';
    return {
      name: name || '管理员',
      avatarSeed: resolvedSeed,
      avatarStyle: DICEBEAR_STYLES.includes(avatarStyle as DicebearStyle)
        ? avatarStyle
        : pickDicebearStyle(resolvedSeed),
    };
  } catch {
    const avatarSeed = createRandomAvatarSeed();
    return { name: '管理员', avatarSeed, avatarStyle: pickDicebearStyle(avatarSeed) };
  }
}

export function Login({ onLogin, t }: { onLogin: () => void; t: (text: string) => string }) {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const capabilityRows = [
    {
      title: t('统一代理网关'),
      description: t('一个 Key、一个入口，兼容 OpenAI / Claude 下游格式'),
    },
    {
      title: t('自动模型发现'),
      description: t('上游新增模型自动出现在模型列表，零配置路由生成'),
    },
    {
      title: t('智能路由引擎'),
      description: t('按成本、延迟、成功率自动选择最优通道，故障自动转移'),
    },
  ];

  const handleLogin = async () => {
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/auth/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) {
        onLogin();
      } else {
        let reason = '';
        try {
          const text = await res.text();
          if (text) {
            try {
              const parsed = JSON.parse(text) as { message?: unknown; error?: unknown };
              if (typeof parsed.message === 'string') reason = parsed.message;
              else if (typeof parsed.error === 'string') reason = parsed.error;
              else reason = text;
            } catch {
              reason = text;
            }
          }
        } catch { }
        setError(t(resolveLoginErrorMessage(res.status, reason)));
        setLoading(false);
      }
    } catch {
      setError(t('无法连接到服务器'));
      setLoading(false);
    }
  };

  return (
    <div className="login-shell">
      <div className="login-surface animate-scale-in">
        <section className="login-brand-panel login-brand-panel-light">
          <div className="login-brand-header">
            <div className="brand-mark-frame brand-mark-frame-hero">
              <div className="brand-mark-canvas">
                <img src="/logo.png" alt="Metapi" className="login-brand-logo" />
              </div>
            </div>
            <div className="login-brand-summary">
              <div className="login-brand-name">Metapi</div>
              <div className="login-brand-kicker">{t('中转站的中转站')}</div>
            </div>
          </div>
          <div className="login-brand-copy-block">
            <p className="login-brand-copy">
              {t('把分散的 New API / One API / OneHub 等站点聚合成统一网关，自动发现模型、智能路由、成本更优。')}
            </p>
          </div>
          <div className="login-compat-line">{t('兼容 New API / One API / OneHub / DoneHub / Veloera / AnyRouter / Sub2API')}</div>
          <div className="login-capability-list">
            {capabilityRows.map((feature, index) => (
              <div key={feature.title} className="login-capability-row">
                <div className="login-capability-index">{String(index + 1).padStart(2, '0')}</div>
                <div className="login-capability-content">
                  <div className="login-capability-title">{feature.title}</div>
                  <p className="login-capability-desc">{feature.description}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="login-brand-footer">
            <a
              href={SITE_GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="login-icon-link"
              aria-label="GitHub"
              title="GitHub"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="login-icon-link-svg">
                <path
                  fill="currentColor"
                  d="M12 2C6.48 2 2 6.59 2 12.25c0 4.53 2.87 8.38 6.84 9.73.5.1.68-.22.68-.49 0-.24-.01-1.04-.01-1.88-2.78.62-3.37-1.22-3.37-1.22-.45-1.2-1.11-1.52-1.11-1.52-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.35 1.12 2.92.85.09-.67.35-1.12.64-1.38-2.22-.26-4.55-1.15-4.55-5.13 0-1.13.39-2.05 1.03-2.77-.1-.26-.45-1.31.1-2.73 0 0 .84-.28 2.75 1.06A9.3 9.3 0 0 1 12 6.91c.85 0 1.71.12 2.51.35 1.91-1.34 2.75-1.06 2.75-1.06.55 1.42.2 2.47.1 2.73.64.72 1.03 1.64 1.03 2.77 0 3.99-2.34 4.86-4.57 5.12.36.33.68.97.68 1.96 0 1.42-.01 2.56-.01 2.91 0 .27.18.59.69.49A10.27 10.27 0 0 0 22 12.25C22 6.59 17.52 2 12 2Z"
                />
              </svg>
            </a>
            <a
              href={SITE_DOCS_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="login-doc-link"
            >
              {t('部署文档')}
            </a>
          </div>
        </section>

        <section className="login-auth-stage">
          <div className="login-auth-panel">
            <div className="login-auth-eyebrow">{t('管理员入口')}</div>
            <h2 className="login-auth-title">{t('登录')}</h2>
            <p className="login-auth-copy">{t('请输入管理员令牌后继续。')}</p>
            <label className="login-auth-label" htmlFor="admin-token-input">{t('管理员令牌')}</label>
            <input
              id="admin-token-input"
              type="password"
              placeholder={t('管理员令牌')}
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setError('');
              }}
              onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
              className="login-auth-input"
            />
            {error && (
              <div className="alert alert-error animate-shake" style={{ marginBottom: 12 }}>
                {error}
              </div>
            )}
            <button
              onClick={handleLogin}
              disabled={loading || !token}
              className="btn btn-primary login-auth-submit"
            >
              {loading ? <><span className="spinner spinner-sm" style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }} />{t('验证中...')}</> : t('登录')}
            </button>
            <div className="login-auth-note">{t('仅校验本地服务访问权限，不会把令牌发送到第三方。')}</div>
            <div className="login-auth-footer">
              <span>{t('管理员登录后继续。')}</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function UserProfileModal({
  open,
  profile,
  onClose,
  onSave,
  t,
}: {
  open: boolean;
  profile: UserProfile;
  onClose: () => void;
  onSave: (nextProfile: UserProfile) => void;
  t: (text: string) => string;
}) {
  const [name, setName] = useState(profile.name);
  const [avatarSeed, setAvatarSeed] = useState(profile.avatarSeed);
  const [avatarStyle, setAvatarStyle] = useState(profile.avatarStyle);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(profile.name);
    setAvatarSeed(profile.avatarSeed);
    setAvatarStyle(profile.avatarStyle);
    setError('');
  }, [open, profile]);

  const avatarUrl = buildDicebearAvatarUrl(avatarStyle, avatarSeed);

  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: '10px 14px',
    border: '1px solid var(--color-border)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13,
    outline: 'none',
    background: 'var(--color-bg)',
    color: 'var(--color-text-primary)',
  };

  const handleRandomAvatar = () => {
    const nextSeed = createRandomAvatarSeed();
    setAvatarSeed(nextSeed);
    setAvatarStyle(pickDicebearStyle(nextSeed));
  };

  const handleSubmit = () => {
    const normalizedName = name.trim();
    if (!normalizedName) {
      setError(t('用户名不能为空'));
      return;
    }
    if (Array.from(normalizedName).length > 24) {
      setError(t('用户名最多 24 个字符'));
      return;
    }
    onSave({
      name: normalizedName,
      avatarSeed: avatarSeed.trim() || createRandomAvatarSeed(),
      avatarStyle: DICEBEAR_STYLES.includes(avatarStyle as DicebearStyle)
        ? avatarStyle
        : pickDicebearStyle(avatarSeed),
    });
  };

  return (
    <CenteredModal
      open={open}
      onClose={onClose}
      title={t('个人信息')}
      maxWidth={440}
      closeOnBackdrop
      closeOnEscape
      bodyStyle={{ display: 'flex', flexDirection: 'column', gap: 12 }}
      footer={(
        <>
          <button onClick={onClose} className="btn btn-ghost">{t('取消')}</button>
          <button onClick={handleSubmit} className="btn btn-primary">{t('保存')}</button>
        </>
      )}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 2 }}>
        <div className="topbar-avatar" style={{ width: 40, height: 40, fontSize: 14 }}>
          <img
            src={avatarUrl}
            alt={name.trim() || 'avatar'}
            style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
          />
        </div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{t('右上角头像实时预览')}</div>
      </div>

      <div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>{t('用户名')}</div>
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError('');
          }}
          placeholder={t('例如：小王')}
          style={inputStyle}
        />
      </div>

      <div>
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>
          {t('头像（Dicebear 随机） · 风格：')}{avatarStyle}
        </div>
        <button type="button" className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={handleRandomAvatar}>
          {t('换一个随机头像')}
        </button>
      </div>

      {error && (
        <div className="alert alert-error">
          {error}
        </div>
      )}
    </CenteredModal>
  );
}

export const sidebarGroups = [
  {
    label: '控制台',
    items: [
      { to: '/', label: '仪表盘', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 5a1 1 0 011-1h4a1 1 0 011 1v5a1 1 0 01-1 1H5a1 1 0 01-1-1V5zM14 5a1 1 0 011-1h4a1 1 0 011 1v2a1 1 0 01-1 1h-4a1 1 0 01-1-1V5zM4 15a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1H5a1 1 0 01-1-1v-4zM14 12a1 1 0 011-1h4a1 1 0 011 1v7a1 1 0 01-1 1h-4a1 1 0 01-1-1v-7z" /></svg> },
      { to: '/sites', label: '站点管理', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M21 12a9 9 0 01-9 9m9-9a9 9 0 00-9-9m9 9H3m9 9a9 9 0 01-9-9m9 9c1.657 0 3-4.03 3-9s-1.343-9-3-9m0 18c-1.657 0-3-4.03-3-9s1.343-9 3-9m-9 9a9 9 0 019-9" /></svg> },
      { to: '/site-announcements', label: '站点公告', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M7 8h10M7 12h10M7 16h6M5 4h14a2 2 0 012 2v12a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z" /></svg> },
      { to: '/accounts', label: '连接管理', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg> },
      { to: '/diagnostics', label: '接入诊断', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 17v-2a4 4 0 018 0v2m-4-6a3 3 0 100-6 3 3 0 000 6zm8 3h-2m-14 0H3m15.364-6.364l-1.414 1.414M7.05 15.95l-1.414 1.414m0-10.728l1.414 1.414m10.9 10.9l1.414 1.414" /></svg> },
      { to: '/optimization', label: '优化工作台', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 13a8 8 0 0116 0m-8-8v4m4.95-1.95l-2.829 2.829M19 13h-4m-6 0H5m4.879-3.121L7.05 7.05M12 13l3 3m-7 3h8" /></svg> },
      { to: '/oauth', label: 'OAuth 管理', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 7a3 3 0 106 0 3 3 0 00-6 0zM3 17a3 3 0 106 0 3 3 0 00-6 0zM15 17a3 3 0 106 0 3 3 0 00-6 0zM6 14V10m0 0a3 3 0 113-3m-3 3a3 3 0 003 3h6" /></svg> },
      { to: '/downstream-keys', label: '下游密钥', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 7a4 4 0 11-8 0 4 4 0 018 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M7 21a6 6 0 0110.8-3.6M15.5 18.5l2-2m0 0l2 2m-2-2V21" /></svg> },
      { to: '/checkin', label: '签到记录', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg> },
      { to: '/routes', label: '路由', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" /></svg> },
      { to: '/logs', label: '使用日志', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg> },
      { to: '/monitor', label: '可用性监控', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M3 5a2 2 0 012-2h14a2 2 0 012 2v11a2 2 0 01-2 2h-5l-2.5 3-2.5-3H5a2 2 0 01-2-2V5z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M7 10h3l1.5-2.5L14 13l1.5-3H17" /></svg> },
    ],
  },
  {
    label: '系统',
    items: [
      { to: '/settings', label: '设置', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg> },
      { to: '/events', label: '程序日志', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg> },
      { to: '/settings/import-export', label: '导入/导出', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M7 7h10M7 12h6m-6 5h10M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z" /></svg> },
      { to: '/settings/notify', label: '通知设置', icon: <svg className="sidebar-item-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg> },
    ],
  },
];

const topNavItems = [
  { label: '控制台', to: '/' },
  { label: '模型广场', to: '/models' },
  { label: '模型操练场', to: '/playground' },
  { label: '关于', to: '/about' },
];

function PageTransition({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  return <div key={location.pathname} className="page-enter">{children}</div>;
}

function RouteLoadingFallback() {
  return (
    <div className="animate-fade-in" style={{ padding: 16 }}>
      <div className="skeleton" style={{ width: 220, height: 24, marginBottom: 16 }} />
      <div className="skeleton" style={{ width: '100%', height: 120, borderRadius: 12 }} />
    </div>
  );
}

function OverlayFallback() {
  return null;
}

function AppInstallBanner({
  state,
  onInstall,
  onDismiss,
  t,
}: {
  state: InstallBannerState;
  onInstall: () => void;
  onDismiss: () => void;
  t: (text: string) => string;
}) {
  const title = state.mode === 'native'
    ? t('将 Metapi 安装到设备')
    : t('添加到主屏后可像 App 一样使用');
  const detail = state.mode === 'native'
    ? t('支持在 PC 和手机上直接安装 Web 应用，保留独立窗口、快捷入口和离线壳层。')
    : t('iPhone / iPad 可在浏览器分享菜单中选择“添加到主屏幕”，获得更接近原生应用的入口体验。');
  const actionLabel = state.mode === 'native' ? t('立即安装') : t('知道了');

  return (
    <div className="app-install-banner-wrap" data-testid="app-install-banner">
      <div className="app-install-banner">
        <div className="app-install-banner-mark" aria-hidden="true" />
        <div className="app-install-banner-copy">
          <div className="app-install-banner-title">{title}</div>
          <div className="app-install-banner-detail">{detail}</div>
          <div className="app-install-banner-tags">
            <span className="app-install-banner-tag">{t('PC 可安装')}</span>
            <span className="app-install-banner-tag">{t('手机可加桌面')}</span>
            <span className="app-install-banner-tag">{t('不依赖 Windows 安装包')}</span>
          </div>
        </div>
        <div className="app-install-banner-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={onInstall}
          >
            {actionLabel}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onDismiss}
          >
            {t('稍后再说')}
          </button>
        </div>
      </div>
    </div>
  );
}

const AppMainContent = memo(function AppMainContent({
  displayName,
}: {
  displayName: string;
}) {
  const location = useLocation();
  const { t } = useI18n();

  return (
    <main className="main-content">
      <PageTransition>
        <RouteErrorBoundary resetKey={location.pathname} t={t}>
          <Suspense fallback={<RouteLoadingFallback />}>
            <Routes>
              <Route path="/" element={<Dashboard adminName={displayName} />} />
              <Route path="/sites" element={<Sites />} />
              <Route path="/site-announcements" element={<SiteAnnouncements />} />
              <Route path="/accounts" element={<Accounts />} />
              <Route path="/diagnostics" element={<CredentialDiagnostics />} />
              <Route path="/optimization" element={<OptimizationWorkbench />} />
              <Route path="/oauth" element={<OAuthManagement />} />
              <Route path="/tokens" element={<Tokens />} />
              <Route path="/checkin" element={<CheckinLog />} />
              <Route path="/routes" element={<TokenRoutes />} />
              <Route path="/token-routes" element={<Navigate to="/routes" replace />} />
              <Route path="/logs" element={<ProxyLogs />} />
              <Route path="/monitor" element={<Monitors />} />
              <Route path="/monitors" element={<Navigate to="/monitor" replace />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="/downstream-keys" element={<DownstreamKeys />} />
              <Route path="/events" element={<ProgramLogs />} />
              <Route path="/program-logs" element={<Navigate to="/events" replace />} />
              <Route path="/credential-diagnostics" element={<Navigate to="/diagnostics" replace />} />
              <Route path="/settings/import-export" element={<ImportExport />} />
              <Route path="/import-export" element={<Navigate to="/settings/import-export" replace />} />
              <Route path="/settings/notify" element={<NotificationSettings />} />
              <Route path="/notifications" element={<Navigate to="/settings/notify" replace />} />
              <Route path="/models" element={<Models />} />
              <Route path="/playground" element={<ModelTester />} />
              <Route path="/about" element={<About />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
          </Suspense>
        </RouteErrorBoundary>
      </PageTransition>
    </main>
  );
});

function navLinkPreloadProps(path: string) {
  return {
    onMouseEnter: () => preloadRoute(path),
    onFocus: () => preloadRoute(path),
    onTouchStart: () => preloadRoute(path),
  };
}

function AppShell() {
  const { language, toggleLanguage, t } = useI18n();
  const [authed, setAuthed] = useState(() => hasValidAuthSession(localStorage));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [showThemeMenu, setShowThemeMenu] = useState(false);
  const themeMenuRef = useRef<HTMLDivElement>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => resolveStoredThemeMode());
  const [systemPrefersDark, setSystemPrefersDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [userProfile, setUserProfile] = useState<UserProfile>(() => resolveStoredProfile());
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const themeMenuPresence = useAnimatedVisibility(showThemeMenu, 160);
  const userMenuPresence = useAnimatedVisibility(showUserMenu, 160);
  const [unreadCount, setUnreadCount] = useState(0);
  const [runtimeOverview, setRuntimeOverview] = useState<RuntimeOverview | null>(null);
  const notifBtnRef = useRef<HTMLButtonElement>(null);
  const latestTaskEventIdRef = useRef(0);
  const toast = useToast();
  const isMobile = useIsMobile();
  const resolvedTheme: 'light' | 'dark' = themeMode === 'system'
    ? (systemPrefersDark ? 'dark' : 'light')
    : themeMode;
  const rawDisplayName = (userProfile.name || '').trim();
  const displayName = rawDisplayName ? (rawDisplayName === '管理员' ? t('管理员') : rawDisplayName) : t('管理员');
  const resolvedThemeLabel = resolvedTheme === 'dark' ? t('深色') : t('浅色');
  const avatarUrl = buildDicebearAvatarUrl(userProfile.avatarStyle, userProfile.avatarSeed);
  const appVersionMismatchToastShownRef = useRef(false);
  const installPromptRef = useRef<DeferredInstallPromptEvent | null>(null);
  const [installBanner, setInstallBanner] = useState<InstallBannerState>({ mode: 'native', visible: false });

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let idleId: number | null = null;
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      idleId = window.requestIdleCallback(() => {
        preloadRoute('/accounts');
        preloadRoute('/routes');
        preloadRoute('/models');
      }, { timeout: 2000 });
    } else {
      timeoutId = setTimeout(() => {
        preloadRoute('/accounts');
        preloadRoute('/routes');
        preloadRoute('/models');
      }, 1500);
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (idleId != null && typeof window !== 'undefined' && 'cancelIdleCallback' in window) {
        window.cancelIdleCallback(idleId);
      }
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => setSystemPrefersDark(media.matches);
    sync();

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', sync);
      return () => media.removeEventListener('change', sync);
    }

    media.addListener(sync);
    return () => media.removeListener(sync);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolvedTheme);
    localStorage.setItem(THEME_MODE_STORAGE_KEY, themeMode);
    if (themeMode === 'system') {
      localStorage.removeItem('theme');
    } else {
      localStorage.setItem('theme', themeMode);
    }
  }, [resolvedTheme, themeMode]);

  useEffect(() => {
    document.documentElement.setAttribute('data-layout', isMobile ? 'mobile' : 'desktop');
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile && drawerOpen) {
      setDrawerOpen(false);
    }
  }, [drawerOpen, isMobile]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setShowSearch(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    let initialPollTimer: ReturnType<typeof setTimeout> | null = null;

    const pollEvents = async () => {
      try {
        const recentEvents = await api.getEvents('limit=30');

        if (cancelled) return;
        const rows = Array.isArray(recentEvents) ? recentEvents : [];
        const unread = rows.filter((r: any) => !r.read).length;
        startTransition(() => {
          setUnreadCount(unread);
        });
        const maxId = rows.reduce((acc: number, row: any) => Math.max(acc, Number(row?.id) || 0), 0);

        if (latestTaskEventIdRef.current === 0) {
          latestTaskEventIdRef.current = maxId;
          return;
        }

        const newTaskEvents = rows
          .filter((row: any) => (
            (Number(row?.id) || 0) > latestTaskEventIdRef.current
            && String(row?.relatedType || '').toLowerCase().startsWith('task')
            && !String(row?.title || '').includes('已开始')
          ))
          .sort((a: any, b: any) => (a.id || 0) - (b.id || 0))
          .slice(-3);

        for (const event of newTaskEvents) {
          const message = event?.message || event?.title || t('任务状态已更新');
          if (event?.level === 'error') {
            toast.error(message);
          } else if (event?.level === 'warning') {
            toast.info(message);
          } else {
            toast.success(message);
          }
        }

        if (maxId > latestTaskEventIdRef.current) {
          latestTaskEventIdRef.current = maxId;
        }
      } catch {
        // ignore polling errors
      }
    };

    initialPollTimer = setTimeout(() => { void pollEvents(); }, 1200);
    const timer = setInterval(() => { void pollEvents(); }, 15000);
    return () => {
      cancelled = true;
      if (initialPollTimer) clearTimeout(initialPollTimer);
      clearInterval(timer);
    };
  }, [authed, toast]);

  useEffect(() => {
    if (!authed) return;

    const check = () => {
      if (hasValidAuthSession(localStorage)) return;
      setAuthed(false);
      toast.info(t('会话已过期，请重新登录'));
    };

    check();
    const timer = setInterval(check, 60_000);
    return () => clearInterval(timer);
  }, [authed, toast]);

  useEffect(() => {
    if (!authed) return;
    if (localStorage.getItem(FIRST_USE_DOC_REMINDER_KEY)) return;
    localStorage.setItem(FIRST_USE_DOC_REMINDER_KEY, '1');
    toast.info(`${t('首次使用建议先阅读站点文档：')}${SITE_DOCS_URL}`);
  }, [authed, t, toast]);

  useEffect(() => {
    if (!authed) {
      installPromptRef.current = null;
      setInstallBanner((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      return;
    }

    if (isStandaloneDisplayMode()) {
      setInstallBanner((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      return;
    }

    const nativeDismissed = localStorage.getItem(APP_INSTALL_BANNER_DISMISSED_KEY) === '1';
    const iosDismissed = localStorage.getItem(APP_INSTALL_IOS_HINT_DISMISSED_KEY) === '1';
    const iosDevice = isIosDevice();

    if (iosDevice && !iosDismissed) {
      setInstallBanner((prev) => (prev.visible && prev.mode === 'ios_hint' ? prev : { mode: 'ios_hint', visible: true }));
    }

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      installPromptRef.current = event as DeferredInstallPromptEvent;
      if (!nativeDismissed) {
        setInstallBanner({ mode: 'native', visible: true });
      }
    };

    const handleInstalled = () => {
      installPromptRef.current = null;
      localStorage.removeItem(APP_INSTALL_BANNER_DISMISSED_KEY);
      localStorage.removeItem(APP_INSTALL_IOS_HINT_DISMISSED_KEY);
      setInstallBanner((prev) => (prev.visible ? { ...prev, visible: false } : prev));
      toast.success(t('Metapi 已添加到设备，可从桌面或应用列表直接打开。'));
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleInstalled);

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleInstalled);
    };
  }, [authed, t, toast]);

  useEffect(() => {
    let cancelled = false;

    const checkAppVersion = async () => {
      try {
        const currentEntryAssetPath = findCurrentEntryAssetPath(document);
        if (!currentEntryAssetPath) return;

        const response = await fetch(window.location.pathname, {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!response.ok) return;

        const html = await response.text();
        if (cancelled) return;

        const latestEntryAssetPath = extractEntryAssetPathFromHtml(html, window.location.href);
        if (!latestEntryAssetPath) return;

        if (currentEntryAssetPath === latestEntryAssetPath) {
          localStorage.removeItem(APP_VERSION_RELOAD_STORAGE_KEY);
          appVersionMismatchToastShownRef.current = false;
          return;
        }

        if (!appVersionMismatchToastShownRef.current) {
          appVersionMismatchToastShownRef.current = true;
          toast.info(t('检测到后台已更新，建议刷新页面以加载最新版本。'));
        }
      } catch {
        // Ignore version probe failures to avoid interrupting normal usage.
      }
    };

    void checkAppVersion();
    const timer = setInterval(() => {
      void checkAppVersion();
    }, APP_VERSION_CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [t, toast]);

  useEffect(() => {
    if (!authed) {
      setRuntimeOverview(null);
      return;
    }

    let cancelled = false;

    const pollRuntimeOverview = async () => {
      try {
        const overview = await api.getRuntimeOverview();
        if (cancelled) return;
        startTransition(() => {
          setRuntimeOverview(overview);
        });
      } catch {
        if (cancelled) return;
      }
    };

    void pollRuntimeOverview();
    const timer = setInterval(() => {
      void pollRuntimeOverview();
    }, RUNTIME_OVERVIEW_POLL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [authed]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setShowUserMenu(false);
      }
      if (themeMenuRef.current && !themeMenuRef.current.contains(e.target as Node)) {
        setShowThemeMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleSelectThemeMode = (nextMode: ThemeMode) => {
    setThemeMode(nextMode);
    setShowThemeMenu(false);
  };

  const handleSaveProfile = (nextProfile: UserProfile) => {
    const normalizedSeed = nextProfile.avatarSeed.trim() || createRandomAvatarSeed();
    const normalized = {
      name: nextProfile.name.trim() || t('管理员'),
      avatarSeed: normalizedSeed,
      avatarStyle: DICEBEAR_STYLES.includes(nextProfile.avatarStyle as DicebearStyle)
        ? nextProfile.avatarStyle
        : pickDicebearStyle(normalizedSeed),
    };
    setUserProfile(normalized);
    localStorage.setItem(USER_PROFILE_STORAGE_KEY, JSON.stringify(normalized));
    setShowProfileModal(false);
    toast.success(t('个人信息已保存'));
  };

  const handleDismissInstallBanner = () => {
    if (installBanner.mode === 'ios_hint') {
      localStorage.setItem(APP_INSTALL_IOS_HINT_DISMISSED_KEY, '1');
    } else {
      localStorage.setItem(APP_INSTALL_BANNER_DISMISSED_KEY, '1');
    }
    setInstallBanner((prev) => ({ ...prev, visible: false }));
  };

  const handleInstallApp = async () => {
    if (installBanner.mode === 'ios_hint') {
      localStorage.setItem(APP_INSTALL_IOS_HINT_DISMISSED_KEY, '1');
      setInstallBanner((prev) => ({ ...prev, visible: false }));
      toast.info(t('请在 Safari 或系统浏览器中打开分享菜单，然后选择“添加到主屏幕”。'));
      return;
    }

    const promptEvent = installPromptRef.current;
    if (!promptEvent) {
      localStorage.setItem(APP_INSTALL_BANNER_DISMISSED_KEY, '1');
      setInstallBanner((prev) => ({ ...prev, visible: false }));
      toast.info(t('当前浏览器暂未提供安装入口，可在地址栏或浏览器菜单中查找“安装应用”或“添加到主屏幕”。'));
      return;
    }

    await promptEvent.prompt();
    const choice = await promptEvent.userChoice.catch(() => null);
    installPromptRef.current = null;
    if (choice?.outcome === 'accepted') {
      setInstallBanner((prev) => ({ ...prev, visible: false }));
      localStorage.removeItem(APP_INSTALL_BANNER_DISMISSED_KEY);
      return;
    }
    localStorage.setItem(APP_INSTALL_BANNER_DISMISSED_KEY, '1');
    setInstallBanner((prev) => ({ ...prev, visible: false }));
  };

  if (!authed) {
    return <Login t={t} onLogin={() => {
      persistAuthSession(localStorage, 'cookie-session');
      setAuthed(true);
    }} />;
  }

  return (
    <>
      <header className="topbar">
        {isMobile && (
          <button
            className="topbar-icon-btn"
            aria-label={t('打开导航')}
            onClick={() => setDrawerOpen(true)}
            type="button"
          >
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}
        <div className="topbar-logo">
          <img src="/logo.png" alt="Metapi" style={{ width: 28, height: 28, borderRadius: 6 }} />
          <span className="topbar-logo-text">Metapi</span>
        </div>
        <nav className="topbar-nav">
          {topNavItems.map((item) => (
            <NavLink key={item.to} to={item.to} end className={({ isActive }) => `topbar-nav-item ${isActive ? 'active' : ''}`} {...navLinkPreloadProps(item.to)}>
              {t(item.label)}
            </NavLink>
          ))}
        </nav>
        <div className="topbar-right">
          <button
            className="topbar-icon-btn"
            aria-label={language === 'zh' ? 'Switch to English' : '切换到中文'}
            onClick={toggleLanguage}
            style={{ minWidth: 36, fontSize: 12, fontWeight: 700 }}
          >
            {language === 'zh' ? 'EN' : '中'}
          </button>
          <button className="topbar-search-trigger" aria-label={t('搜索 (Ctrl+K)')} onClick={() => setShowSearch(true)}>
            <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            <span className="topbar-search-label">{t('搜索')}</span>
            <kbd className="topbar-search-kbd">Ctrl K</kbd>
          </button>
          <div style={{ position: 'relative' }}>
            <button ref={notifBtnRef} className="topbar-icon-btn" aria-label={t('通知')} onClick={() => setShowNotifications(!showNotifications)}>
              <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
              {unreadCount > 0 && (
                <span className="topbar-badge">
                  {unreadCount > 99 ? '99+' : unreadCount}
                </span>
              )}
            </button>
            <Suspense fallback={<OverlayFallback />}>
              {showNotifications ? <NotificationPanel open={showNotifications} onClose={() => setShowNotifications(false)} anchorRef={notifBtnRef} onUnreadCountChange={setUnreadCount} /> : null}
            </Suspense>
          </div>
          <div ref={themeMenuRef} style={{ position: 'relative' }}>
            <button
              className="topbar-icon-btn"
              aria-label={themeMode === 'system'
                ? `${t('跟随系统')} (${resolvedThemeLabel})`
                : (themeMode === 'light' ? t('浅色模式') : t('深色模式'))}
              onClick={() => {
                setShowThemeMenu((prev) => !prev);
                setShowUserMenu(false);
              }}
            >
              {themeMode === 'system' ? (
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 5h16v10H4V5zm6 12h4m-7 2h10" /></svg>
              ) : themeMode === 'light' ? (
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" /></svg>
              ) : (
                <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" /></svg>
              )}
            </button>
            {themeMenuPresence.shouldRender && (
              <div className={`user-dropdown ${themeMenuPresence.isVisible ? '' : 'is-closing'}`.trim()} style={{ right: 0, left: 'auto', minWidth: 168 }}>
                <button
                  className="user-dropdown-item"
                  onClick={() => handleSelectThemeMode('system')}
                  style={themeMode === 'system' ? { background: 'var(--color-primary-light)', color: 'var(--color-primary)' } : undefined}
                >
                  {t('跟随系统')}（{resolvedThemeLabel}）
                </button>
                <button
                  className="user-dropdown-item"
                  onClick={() => handleSelectThemeMode('light')}
                  style={themeMode === 'light' ? { background: 'var(--color-primary-light)', color: 'var(--color-primary)' } : undefined}
                >
                  {t('浅色模式')}
                </button>
                <button
                  className="user-dropdown-item"
                  onClick={() => handleSelectThemeMode('dark')}
                  style={themeMode === 'dark' ? { background: 'var(--color-primary-light)', color: 'var(--color-primary)' } : undefined}
                >
                  {t('深色模式')}
                </button>
              </div>
            )}
          </div>
          <div ref={userMenuRef} style={{ position: 'relative' }}>
            <button
              type="button"
              className="topbar-avatar"
              aria-label={displayName}
              aria-haspopup="menu"
              aria-expanded={showUserMenu}
              onClick={() => {
                setShowUserMenu(!showUserMenu);
                setShowThemeMenu(false);
              }}
            >
              <img
                src={avatarUrl}
                alt={displayName}
                style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }}
              />
            </button>
            {userMenuPresence.shouldRender && (
              <div className={`user-dropdown ${userMenuPresence.isVisible ? '' : 'is-closing'}`.trim()}>
                <button
                  className="user-dropdown-item"
                  onClick={() => {
                    setShowProfileModal(true);
                    setShowUserMenu(false);
                  }}
                >
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                  {t('个人信息')}
                </button>
                <button onClick={() => {
                  clearAuthSession(localStorage);
                  void fetch('/api/auth/session', { method: 'DELETE', credentials: 'same-origin' });
                  setAuthed(false);
                }} className="user-dropdown-item danger">
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                  {t('退出登录')}
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {installBanner.visible ? (
        <AppInstallBanner
          state={installBanner}
          onInstall={() => { void handleInstallApp(); }}
          onDismiss={handleDismissInstallBanner}
          t={t}
        />
      ) : null}

      <div className="app-layout">
        {isMobile ? (
          <Suspense fallback={<OverlayFallback />}>
            {drawerOpen ? (
              <MobileDrawer
                open={drawerOpen}
                onClose={() => setDrawerOpen(false)}
                title={t('导航菜单')}
                closeLabel={t('关闭导航')}
              >
                <div className="mobile-drawer-header">
                  <img src="/logo.png" alt="Metapi" />
                  <span>Metapi</span>
                </div>
                <nav className="mobile-nav">
                  {sidebarGroups.map((group) => (
                    <div key={group.label} className="mobile-nav-group">
                      <div className="mobile-nav-label">{t(group.label)}</div>
                      {group.items.map((item) => (
                        <NavLink
                          key={item.to}
                          to={item.to}
                          end={item.to === '/' || item.to === '/settings'}
                          className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}
                          onClick={() => setDrawerOpen(false)}
                          {...navLinkPreloadProps(item.to)}
                        >
                          {item.icon}
                          <span>{t(item.label)}</span>
                        </NavLink>
                      ))}
                    </div>
                  ))}
                  <div className="mobile-nav-group">
                    <div className="mobile-nav-label">{t('更多')}</div>
                    {topNavItems.filter((n) => n.to !== '/').map((item) => (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className={({ isActive }) => `mobile-nav-item ${isActive ? 'active' : ''}`}
                        onClick={() => setDrawerOpen(false)}
                        {...navLinkPreloadProps(item.to)}
                      >
                        <span>{t(item.label)}</span>
                      </NavLink>
                    ))}
                  </div>
                </nav>
              </MobileDrawer>
            ) : null}
          </Suspense>
        ) : (
          <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`}>
            {sidebarGroups.map((group) => (
              <div key={group.label} className="sidebar-group">
                {!sidebarCollapsed && <div className="sidebar-group-label">{t(group.label)}</div>}
                {group.items.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/' || item.to === '/settings'}
                      className={({ isActive }) => `sidebar-item ${isActive ? 'active' : ''}`}
                      data-tooltip={sidebarCollapsed ? t(item.label) : undefined}
                      aria-label={sidebarCollapsed ? t(item.label) : undefined}
                      {...navLinkPreloadProps(item.to)}
                    >
                    {item.icon}
                    {!sidebarCollapsed && <span>{t(item.label)}</span>}
                  </NavLink>
                ))}
              </div>
            ))}
            <button className="sidebar-collapse-btn" onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
              <svg width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ transform: sidebarCollapsed ? 'rotate(180deg)' : 'none', transition: 'transform 0.3s ease', flexShrink: 0 }}>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
              </svg>
              {!sidebarCollapsed && <span>{t('收起侧边栏')}</span>}
            </button>
          </aside>
        )}

        <AppMainContent displayName={displayName} />
      </div>

      <UserProfileModal
        open={showProfileModal}
        profile={userProfile}
        onClose={() => setShowProfileModal(false)}
        onSave={handleSaveProfile}
        t={t}
      />
      <Suspense fallback={<OverlayFallback />}>
        {showSearch ? <SearchModal open={showSearch} onClose={() => setShowSearch(false)} /> : null}
      </Suspense>
    </>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <AppShell />
        <Suspense fallback={<OverlayFallback />}>
          <TooltipLayer />
        </Suspense>
      </ToastProvider>
    </I18nProvider>
  );
}
