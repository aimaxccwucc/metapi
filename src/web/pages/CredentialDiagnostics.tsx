import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, type CredentialBenchmarkResponse, type CredentialDiagnosticResponse } from '../api.js';
import { useToast } from '../components/Toast.js';
import ModernSelect from '../components/ModernSelect.js';
import SiteBadgeLink from '../components/SiteBadgeLink.js';
import { tr } from '../i18n.js';

type TargetType = 'site' | 'account' | 'token';

type SiteOption = {
  value: string;
  label: string;
  platform: string;
  status: string;
};

type AccountOption = {
  value: string;
  label: string;
  siteName: string;
  status: string | null;
};

type TokenOption = {
  value: string;
  label: string;
  accountName: string;
  siteName: string;
  enabled: boolean;
};

function formatDateTime(value: string | null | undefined): string {
  const raw = (value || '').trim();
  if (!raw) return '--';
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatLatency(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return `${Math.round(value)}ms`;
}

function pickInitialTargetId(input: { sites: any[]; accounts: any[]; tokens: any[] }, targetType: TargetType): number {
  if (targetType === 'site') return Number(input.sites[0]?.id || 0);
  if (targetType === 'account') return Number(input.accounts[0]?.id || 0);
  return Number(input.tokens[0]?.id || 0);
}

function collectBenchmarkModelNames(diagnostic: CredentialDiagnosticResponse | null): string[] {
  if (!diagnostic) return [];
  return diagnostic.models.items
    .filter((item) => !item.disabled)
    .map((item) => item.name)
    .slice(0, 8);
}

export default function CredentialDiagnostics() {
  const toast = useToast();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTargetType = (() => {
    const raw = searchParams.get('targetType');
    return raw === 'site' || raw === 'account' || raw === 'token' ? raw : 'account';
  })();
  const initialTargetId = Number.parseInt(searchParams.get('targetId') || '', 10) || 0;
  const [targetType, setTargetType] = useState<TargetType>(initialTargetType);
  const [targetId, setTargetId] = useState(initialTargetId);
  const [sites, setSites] = useState<any[]>([]);
  const [accounts, setAccounts] = useState<any[]>([]);
  const [tokens, setTokens] = useState<any[]>([]);
  const [loadingTargets, setLoadingTargets] = useState(true);
  const [loadingDiagnostic, setLoadingDiagnostic] = useState(false);
  const [diagnostic, setDiagnostic] = useState<CredentialDiagnosticResponse | null>(null);
  const [benchmark, setBenchmark] = useState<CredentialBenchmarkResponse | null>(null);
  const [benchmarking, setBenchmarking] = useState(false);
  const [rounds, setRounds] = useState<1 | 3>(1);

  useEffect(() => {
    let cancelled = false;
    setLoadingTargets(true);
    Promise.all([
      api.getSites(),
      api.getAccounts(),
      api.getAccountTokens(),
    ])
      .then(([siteRows, accountRows, tokenRows]) => {
        if (cancelled) return;
        setSites(Array.isArray(siteRows) ? siteRows : []);
        setAccounts(Array.isArray(accountRows) ? accountRows : []);
        setTokens(Array.isArray(tokenRows) ? tokenRows : []);
        const routeTargetType = searchParams.get('targetType');
        const routeTargetId = Number.parseInt(searchParams.get('targetId') || '', 10) || 0;
        const nextTargetId = pickInitialTargetId({
          sites: Array.isArray(siteRows) ? siteRows : [],
          accounts: Array.isArray(accountRows) ? accountRows : [],
          tokens: Array.isArray(tokenRows) ? tokenRows : [],
        }, targetType);
        const preferredTargetId = (
          (routeTargetType === targetType && routeTargetId > 0) ? routeTargetId : 0
        ) || nextTargetId;
        setTargetId((current) => current || preferredTargetId);
      })
      .catch((error: any) => {
        if (cancelled) return;
        toast.error(error?.message || '加载诊断对象失败');
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingTargets(false);
      });
    return () => {
      cancelled = true;
    };
  }, [searchParams, targetType, toast]);

  useEffect(() => {
    const routeTargetType = searchParams.get('targetType');
    const routeTargetId = Number.parseInt(searchParams.get('targetId') || '', 10) || 0;
    if (
      (routeTargetType === 'site' || routeTargetType === 'account' || routeTargetType === 'token')
      && routeTargetType !== targetType
    ) {
      setTargetType(routeTargetType);
      if (routeTargetId > 0) setTargetId(routeTargetId);
      return;
    }
    if (routeTargetId > 0 && routeTargetId !== targetId) {
      setTargetId(routeTargetId);
    }
  }, [searchParams, targetId, targetType]);

  useEffect(() => {
    if (!targetId) {
      setDiagnostic(null);
      setBenchmark(null);
      return;
    }
    let cancelled = false;
    setLoadingDiagnostic(true);
    setBenchmark(null);
    api.getCredentialDiagnostic({ targetType, targetId })
      .then((response) => {
        if (cancelled) return;
        setDiagnostic(response);
      })
      .catch((error: any) => {
        if (cancelled) return;
        setDiagnostic(null);
        toast.error(error?.message || '加载诊断结果失败');
      })
      .finally(() => {
        if (cancelled) return;
        setLoadingDiagnostic(false);
      });
    return () => {
      cancelled = true;
    };
  }, [targetType, targetId, toast]);

  const siteOptions = useMemo<SiteOption[]>(() => (
    sites.map((site) => ({
      value: String(site.id),
      label: `${site.name} · ${site.platform}`,
      platform: site.platform,
      status: site.status,
    }))
  ), [sites]);

  const accountOptions = useMemo<AccountOption[]>(() => (
    accounts.map((account) => ({
      value: String(account.id),
      label: `${account.username || '未命名'} · ${account.site?.name || '未知站点'}`,
      siteName: account.site?.name || '未知站点',
      status: account.status || null,
    }))
  ), [accounts]);

  const tokenOptions = useMemo<TokenOption[]>(() => (
    tokens.map((token) => ({
      value: String(token.id),
      label: `${token.name || '未命名令牌'} · ${token.accountName || token.account?.username || '未知账号'}`,
      accountName: token.accountName || token.account?.username || '未知账号',
      siteName: token.siteName || token.site?.name || '未知站点',
      enabled: !!token.enabled,
    }))
  ), [tokens]);

  const currentOptions = targetType === 'site'
    ? siteOptions
    : (targetType === 'account' ? accountOptions : tokenOptions);

  const benchmarkCandidates = useMemo(
    () => collectBenchmarkModelNames(diagnostic),
    [diagnostic],
  );

  const updateRouteTarget = (nextType: TargetType, nextId: number) => {
    const params = new URLSearchParams(searchParams);
    params.set('targetType', nextType);
    params.set('targetId', String(nextId));
    setSearchParams(params, { replace: true });
  };

  const runBenchmark = async () => {
    if (!diagnostic || !targetId) return;
    setBenchmarking(true);
    try {
      const response = await api.benchmarkCredentialModels({
        targetType,
        targetId,
        modelNames: benchmarkCandidates,
        rounds,
      });
      setBenchmark(response);
      if (response.recommended?.modelName) {
        toast.success(`推荐模型：${response.recommended.modelName}`);
      } else {
        toast.success('测速完成');
      }
    } catch (error: any) {
      toast.error(error?.message || '模型测速失败');
    } finally {
      setBenchmarking(false);
    }
  };

  return (
    <div className="page-enter">
      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h2 className="page-title" style={{ marginBottom: 6 }}>{tr('接入诊断')}</h2>
            <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>
              围绕单个站点、账号或令牌查看连通性、协议、模型、最小请求与路由影响。
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => navigate('/playground')}>
              打开模型测试器
            </button>
            <button className="btn btn-ghost" style={{ border: '1px solid var(--color-border)' }} onClick={() => navigate('/downstream-keys')}>
              前往下游密钥
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ padding: 18, marginBottom: 16 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '180px minmax(0,1fr) 120px', gap: 12, alignItems: 'end' }}>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>对象类型</div>
            <ModernSelect
              value={targetType}
              options={[
                { value: 'site', label: '站点' },
                { value: 'account', label: '账号' },
                { value: 'token', label: '令牌' },
              ]}
              onChange={(value) => {
                const nextType = value as TargetType;
                const nextId = pickInitialTargetId({ sites, accounts, tokens }, nextType);
                setTargetType(nextType);
                setTargetId(nextId);
                if (nextId > 0) updateRouteTarget(nextType, nextId);
              }}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>诊断对象</div>
            <ModernSelect
              value={targetId ? String(targetId) : ''}
              options={currentOptions}
              onChange={(value) => {
                const nextId = Number.parseInt(String(value), 10) || 0;
                setTargetId(nextId);
                if (nextId > 0) updateRouteTarget(targetType, nextId);
              }}
            />
          </div>
          <div>
            <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>状态</div>
            <div style={{ minHeight: 40, display: 'flex', alignItems: 'center', fontSize: 13, color: 'var(--color-text-secondary)' }}>
              {loadingTargets ? '加载中...' : `${currentOptions.length} 个可选`}
            </div>
          </div>
        </div>
      </div>

      {loadingDiagnostic ? (
        <div className="card" style={{ padding: 18 }}>加载诊断结果中...</div>
      ) : !diagnostic ? (
        <div className="card" style={{ padding: 18 }}>请选择一个可诊断对象。</div>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: 16, marginBottom: 16 }}>
            <div className="card" style={{ padding: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>基础对象</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13 }}>
                <div>
                  <div style={{ color: 'var(--color-text-muted)', marginBottom: 4 }}>站点</div>
                  <div style={{ fontWeight: 600 }}>{diagnostic.target.site.name}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--color-text-muted)', marginBottom: 4 }}>平台</div>
                  <div style={{ fontWeight: 600 }}>{diagnostic.target.site.platform}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--color-text-muted)', marginBottom: 4 }}>账号</div>
                  <div style={{ fontWeight: 600 }}>{diagnostic.target.account?.username || '--'}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--color-text-muted)', marginBottom: 4 }}>令牌</div>
                  <div style={{ fontWeight: 600 }}>{diagnostic.target.token?.name || '--'}</div>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <div style={{ color: 'var(--color-text-muted)', marginBottom: 4 }}>URL</div>
                  <div style={{ fontWeight: 600, wordBreak: 'break-all' }}>{diagnostic.target.site.url}</div>
                </div>
              </div>
            </div>

            <div className="card" style={{ padding: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>连通性</div>
              <div style={{ display: 'grid', gap: 10, fontSize: 13 }}>
                <div>健康状态：<strong>{diagnostic.connectivity.status}</strong></div>
                <div>凭证来源：<strong>{diagnostic.connectivity.credentialSource}</strong></div>
                <div>探测结果：<strong>{diagnostic.connectivity.probe.reachable === null ? '--' : (diagnostic.connectivity.probe.reachable ? '可达' : '失败')}</strong></div>
                <div>HTTP 状态：<strong>{diagnostic.connectivity.probe.statusCode ?? '--'}</strong></div>
                <div>耗时：<strong>{formatLatency(diagnostic.connectivity.probe.latencyMs)}</strong></div>
                <div style={{ color: 'var(--color-text-secondary)' }}>{diagnostic.connectivity.probe.detail || diagnostic.connectivity.message || '--'}</div>
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div className="card" style={{ padding: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>协议探测</div>
              <div style={{ display: 'grid', gap: 10, fontSize: 13 }}>
                <div>状态：<strong>{diagnostic.protocol.ok ? '成功' : '失败'}</strong></div>
                <div>协议：<strong>{diagnostic.protocol.protocol || '--'}</strong></div>
                <div>首选端点：<strong>{diagnostic.protocol.preferredEndpoint || '--'}</strong></div>
                <div>支持端点：<strong>{diagnostic.protocol.supportedEndpoints.join(', ') || '--'}</strong></div>
                <div>来源：<strong>{diagnostic.protocol.probeSource}</strong></div>
                <div style={{ color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap' }}>
                  {(diagnostic.protocol.attemptSummary || []).join('\n') || diagnostic.protocol.error || '--'}
                </div>
              </div>
            </div>

            <div className="card" style={{ padding: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>最小请求</div>
              <div style={{ display: 'grid', gap: 10, fontSize: 13 }}>
                <div>测试模型：<strong>{diagnostic.debug.modelName || '--'}</strong></div>
                <div>请求路径：<strong>{diagnostic.debug.requestPath || '--'}</strong></div>
                <div>请求格式：<strong>{diagnostic.debug.requestFormat || '--'}</strong></div>
                <div>结果：<strong>{diagnostic.debug.ok ? '成功' : '失败'}</strong></div>
                <div style={{ color: 'var(--color-text-secondary)', whiteSpace: 'pre-wrap' }}>
                  {diagnostic.debug.errorSummary || diagnostic.debug.rawPreview || '--'}
                </div>
              </div>
            </div>
          </div>

          <div className="card" style={{ padding: 18, marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700 }}>模型与轻量测速</div>
                <div style={{ color: 'var(--color-text-muted)', fontSize: 12, marginTop: 4 }}>
                  已识别 {diagnostic.models.total} 个模型，推荐基础模型：{diagnostic.models.recommendedBaseModel || '--'}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ModernSelect
                  value={String(rounds)}
                  options={[
                    { value: '1', label: '1 轮' },
                    { value: '3', label: '3 轮' },
                  ]}
                  onChange={(value) => setRounds(Number.parseInt(String(value), 10) === 3 ? 3 : 1)}
                />
                <button className="btn btn-primary" disabled={benchmarking || benchmarkCandidates.length === 0 || !diagnostic.capability.canBenchmark} onClick={runBenchmark}>
                  {benchmarking ? '测速中...' : '开始测速'}
                </button>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10, marginBottom: 12 }}>
              {diagnostic.models.items.slice(0, 12).map((item) => (
                <div key={item.name} style={{ border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', padding: 12 }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>{item.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                    延迟：{formatLatency(item.latencyMs)} · {item.disabled ? '站点禁用' : '可用'} · {item.isManual ? '手工模型' : '自动发现'}
                  </div>
                </div>
              ))}
            </div>

            {benchmark ? (
              <div style={{ borderTop: '1px solid var(--color-border-light)', paddingTop: 12 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
                  推荐模型：{benchmark.recommended?.modelName || '--'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 10 }}>
                  {benchmark.recommended?.reason || '当前没有足够成功样本生成推荐。'}
                </div>
                <div style={{ display: 'grid', gap: 8 }}>
                  {benchmark.items.map((item) => (
                    <div key={item.modelName} style={{ border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', padding: 10 }}>
                      <div style={{ fontWeight: 700 }}>{item.modelName}</div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        成功率 {formatPercent(item.successRate)} · 中位耗时 {formatLatency(item.medianLatencyMs)} · 平均耗时 {formatLatency(item.avgLatencyMs)} · 首字中位 {formatLatency(item.medianFirstTokenMs)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div className="card" style={{ padding: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>路由影响</div>
              {diagnostic.routing.referencedRoutes.length === 0 ? (
                <div style={{ color: 'var(--color-text-muted)', fontSize: 13 }}>当前未发现引用该对象的路由。</div>
              ) : (
                <div style={{ display: 'grid', gap: 10 }}>
                  {diagnostic.routing.referencedRoutes.map((route) => (
                    <div key={route.id} style={{ border: '1px solid var(--color-border-light)', borderRadius: 'var(--radius-sm)', padding: 10 }}>
                      <div style={{ fontWeight: 700 }}>{route.displayName || route.modelPattern}</div>
                      <div style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        决策模型：{route.decisionModelName || '--'} · 刷新时间：{formatDateTime(route.decisionRefreshedAt)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="card" style={{ padding: 18 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>治理与下游影响</div>
              <div style={{ display: 'grid', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>治理状态</div>
                  {diagnostic.routing.governance.length === 0 ? (
                    <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>当前无治理记录</div>
                  ) : diagnostic.routing.governance.map((item) => (
                    <div key={item.id} style={{ fontSize: 13, marginBottom: 6 }}>
                      {item.subjectType} #{item.subjectId} · {item.state} · {item.reasonCode} {item.modelName ? `· ${item.modelName}` : ''}
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 6 }}>相关下游密钥</div>
                  {diagnostic.routing.downstreamKeys.length === 0 ? (
                    <div style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>当前无直接绑定的下游密钥</div>
                  ) : diagnostic.routing.downstreamKeys.map((item) => (
                    <div key={item.id} style={{ fontSize: 13, marginBottom: 6 }}>
                      {item.name}{item.groupName ? ` · ${item.groupName}` : ''}
                    </div>
                  ))}
                </div>
                {diagnostic.target.site.id ? (
                  <div style={{ paddingTop: 8 }}>
                    <SiteBadgeLink siteId={diagnostic.target.site.id} siteName={`前往站点：${diagnostic.target.site.name}`} />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
