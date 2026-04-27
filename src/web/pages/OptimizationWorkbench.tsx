import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type OperationalOptimizationOverview } from '../api.js';
import { useToast } from '../components/Toast.js';

function scoreTone(score: number): string {
  if (score >= 80) return 'badge-success';
  if (score >= 60) return 'badge-warning';
  return 'badge-error';
}

function statusBadge(status: string): string {
  if (status === 'ready') return 'badge-success';
  if (status === 'attention') return 'badge-warning';
  return 'badge-error';
}

function severityBadge(severity: string): string {
  if (severity === 'error') return 'badge-error';
  if (severity === 'warning') return 'badge-warning';
  return 'badge-info';
}

function formatMs(value: number): string {
  if (!Number.isFinite(value)) return '-';
  if (value >= 60_000) return `${Math.round(value / 60_000)} 分钟`;
  return `${Math.round(value / 1000)} 秒`;
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  return false;
}

export default function OptimizationWorkbench() {
  const [overview, setOverview] = useState<OperationalOptimizationOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const toast = useToast();

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api.getOptimizationOverview();
      setOverview(data);
    } catch (err: any) {
      setError(err?.message || '加载优化工作台失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const itemSummary = useMemo(() => {
    const items = overview?.optimizationItems || [];
    return {
      ready: items.filter((item) => item.status === 'ready').length,
      attention: items.filter((item) => item.status === 'attention').length,
      missing: items.filter((item) => item.status === 'missing').length,
    };
  }, [overview]);

  const syncProfiles = async () => {
    setActionLoading('sync');
    try {
      const result = await api.syncOptimizationProfiles();
      toast.success(result.reused ? '画像同步任务已在执行' : '画像同步任务已开始');
      await load();
    } catch (err: any) {
      toast.error(err?.message || '画像同步失败');
    } finally {
      setActionLoading(null);
    }
  };

  const runRecovery = async () => {
    setActionLoading('recovery');
    try {
      const result = await api.runOptimizationRecoveryPass({ limit: 30, includeProbing: true });
      toast.success(`恢复轮转完成：扫描 ${result.scanned}，转入复测 ${result.promotedToProbing}`);
      await load();
    } catch (err: any) {
      toast.error(err?.message || '恢复轮转失败');
    } finally {
      setActionLoading(null);
    }
  };

  const copyDiagnostics = async () => {
    setActionLoading('copy');
    try {
      const result = await api.getOptimizationDiagnosticsText();
      await copyText(result.text);
      toast.success('诊断摘要已复制');
    } catch (err: any) {
      toast.error(err?.message || '复制诊断摘要失败');
    } finally {
      setActionLoading(null);
    }
  };

  const toggleResponseCache = async () => {
    if (!overview) return;
    setActionLoading('cache');
    try {
      await api.updateOptimizationPolicies({
        responseCache: { enabled: !overview.policies.responseCache.enabled },
      });
      toast.success('响应缓存策略已保存');
      await load();
    } catch (err: any) {
      toast.error(err?.message || '保存缓存策略失败');
    } finally {
      setActionLoading(null);
    }
  };

  if (loading && !overview) {
    return (
      <div className="animate-fade-in" style={{ padding: 16 }}>
        <div className="skeleton" style={{ width: 220, height: 24, marginBottom: 16 }} />
        <div className="skeleton" style={{ width: '100%', height: 160 }} />
      </div>
    );
  }

  if (error && !overview) {
    return <div className="alert alert-error">{error}</div>;
  }

  if (!overview) return null;

  const scoreCards = [
    { label: '总分', value: overview.scores.overall },
    { label: '好用', value: overview.scores.usability },
    { label: '稳定', value: overview.scores.stability },
    { label: '快', value: overview.scores.speed },
    { label: '省 token', value: overview.scores.tokenSavings },
  ];

  return (
    <div className="page-shell animate-fade-in">
      <div className="page-header">
        <div>
          <h1>优化工作台</h1>
          <p>站点、签到、账号、模型、路由和网关的统一运营视图。</p>
        </div>
        <div className="page-actions" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-ghost" type="button" onClick={() => void load()} disabled={loading}>刷新</button>
          <button className="btn btn-ghost" type="button" onClick={copyDiagnostics} disabled={actionLoading === 'copy'}>复制诊断</button>
          <button className="btn btn-secondary" type="button" onClick={syncProfiles} disabled={actionLoading === 'sync'}>同步画像</button>
          <button className="btn btn-primary" type="button" onClick={runRecovery} disabled={actionLoading === 'recovery'}>恢复轮转</button>
        </div>
      </div>

      <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
        {scoreCards.map((card) => (
          <div key={card.label} className="stat-card">
            <div className="stat-label">{card.label}</div>
            <div className="stat-value">{card.value}</div>
            <span className={`badge ${scoreTone(card.value)}`}>{card.value >= 80 ? '良好' : card.value >= 60 ? '关注' : '风险'}</span>
          </div>
        ))}
      </div>

      <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(320px, 0.8fr)', gap: 16, alignItems: 'start' }}>
        <section className="panel">
          <div className="panel-header">
            <h2>16 项闭环状态</h2>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span className="badge badge-success">就绪 {itemSummary.ready}</span>
              <span className="badge badge-warning">关注 {itemSummary.attention}</span>
              <span className="badge badge-error">缺失 {itemSummary.missing}</span>
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>项目</th>
                  <th>区域</th>
                  <th>状态</th>
                  <th>证据</th>
                  <th>动作</th>
                </tr>
              </thead>
              <tbody>
                {overview.optimizationItems.map((item) => (
                  <tr key={item.id}>
                    <td>{item.title}</td>
                    <td>{item.area}</td>
                    <td><span className={`badge ${statusBadge(item.status)}`}>{item.status}</span></td>
                    <td>{item.evidence}</td>
                    <td>{item.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>关键指标</h2>
          </div>
          <div className="metric-list">
            <div><span>站点</span><strong>{overview.counts.activeSites}/{overview.counts.sites}</strong></div>
            <div><span>账号</span><strong>{overview.counts.activeAccounts}/{overview.counts.accounts}</strong></div>
            <div><span>签到待处理</span><strong>{overview.counts.checkinAttention}</strong></div>
            <div><span>系统隔离</span><strong>{overview.counts.governanceSuppressed}</strong></div>
            <div><span>复测中</span><strong>{overview.counts.governanceProbing}</strong></div>
            <div><span>模型能力</span><strong>{overview.counts.modelCapabilities}</strong></div>
            <div><span>缓存命中</span><strong>{overview.counts.responseCacheHits}</strong></div>
            <div><span>缓存未命中</span><strong>{overview.counts.responseCacheMisses}</strong></div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Link className="btn btn-ghost" to="/routes">路由治理</Link>
            <Link className="btn btn-ghost" to="/models">模型广场</Link>
            <Link className="btn btn-ghost" to="/events">任务中心</Link>
          </div>
        </section>
      </div>

      <div className="grid" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 16, alignItems: 'start' }}>
        <section className="panel">
          <div className="panel-header">
            <h2>低分站点</h2>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>站点</th>
                  <th>分数</th>
                  <th>账号</th>
                  <th>签到</th>
                  <th>治理</th>
                  <th>协议</th>
                </tr>
              </thead>
              <tbody>
                {overview.topSites.map((site) => (
                  <tr key={site.siteId}>
                    <td><Link to={`/sites?focusSiteId=${site.siteId}`}>{site.name}</Link><div className="muted-text">{site.platform}</div></td>
                    <td><span className={`badge ${scoreTone(site.operationalScore)}`}>{site.operationalScore}</span></td>
                    <td>{site.activeAccountCount}/{site.accountCount}</td>
                    <td>{site.checkinAttention}</td>
                    <td>{site.routeGovernanceCount}</td>
                    <td>{site.protocolPreferredEndpoint || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>待处理事项</h2>
          </div>
          <div style={{ display: 'grid', gap: 10 }}>
            {overview.attention.length === 0 && <div className="empty-state">当前没有高优先级待处理项。</div>}
            {overview.attention.map((item, index) => (
              <div key={`${item.title}-${index}`} className="info-row" style={{ border: '1px solid var(--color-border)', borderRadius: 8, padding: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <strong>{item.title}</strong>
                  <span className={`badge ${severityBadge(item.severity)}`}>{item.severity}</span>
                </div>
                <div className="muted-text" style={{ marginTop: 6 }}>{item.detail}</div>
                <div style={{ marginTop: 8 }}>{item.action}</div>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="panel">
        <div className="panel-header">
          <h2>网关策略</h2>
        </div>
        <div className="stats-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
          <div className="stat-card">
            <div className="stat-label">响应缓存</div>
            <div className="stat-value">{overview.policies.responseCache.enabled ? '启用' : '关闭'}</div>
            <div className="muted-text">TTL {formatMs(overview.policies.responseCache.ttlMs)} · 最大 {overview.policies.responseCache.maxRows} 行</div>
            <button className="btn btn-ghost" type="button" onClick={toggleResponseCache} disabled={actionLoading === 'cache'} style={{ marginTop: 10 }}>
              {overview.policies.responseCache.enabled ? '关闭缓存' : '启用缓存'}
            </button>
          </div>
          <div className="stat-card">
            <div className="stat-label">重试预算</div>
            <div className="stat-value">{formatMs(overview.policies.retryBudget.requestBudgetMs)}</div>
            <div className="muted-text">最大重试 {overview.policies.retryBudget.maxRetries} · 通道尝试 {overview.policies.retryBudget.maxChannelAttempts}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">已省 Token</div>
            <div className="stat-value">{overview.metrics.responseCache.savedTokens}</div>
            <div className="muted-text">估算成本 ${overview.metrics.responseCache.savedCost}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">退避等待</div>
            <div className="stat-value">{formatMs(overview.metrics.retryBackoff.totalMs)}</div>
            <div className="muted-text">Retry-After {overview.metrics.retryBackoff.retryAfterHonoredCount} · 预算耗尽 {overview.metrics.retryBackoff.budgetExhaustedCount}</div>
          </div>
        </div>
      </section>
    </div>
  );
}
