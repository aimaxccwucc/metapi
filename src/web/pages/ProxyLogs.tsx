import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { ModelBadge } from '../components/BrandIcon.js';
import { formatDateTimeLocal } from './helpers/checkinLogTime.js';
import ModernSelect from '../components/ModernSelect.js';
import { parseProxyLogPathMeta } from './helpers/proxyLogPathMeta.js';
import { tr } from '../i18n.js';

type StatusFilter = 'all' | 'success' | 'failed';

interface ProxyLog {
  id: number;
  createdAt: string;
  modelRequested: string;
  modelActual: string;
  status: string;
  latencyMs: number;
  totalTokens: number | null;
  retryCount: number;
  accountId?: number;
  username?: string | null;
  siteName?: string | null;
  siteUrl?: string | null;
  errorMessage?: string;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCost?: number;
}

const PAGE_SIZES = [20, 50, 100];

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

export default function ProxyLogs() {
  const [logs, setLogs] = useState<ProxyLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getProxyLogs('limit=500');
      setLogs(data);
    } catch (e: any) {
      toast.error(e.message || '加载日志失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  /* ---- derived ---- */
  const filtered = useMemo(() => logs.filter(log => {
    if (statusFilter === 'success' && log.status !== 'success') return false;
    if (statusFilter === 'failed' && log.status === 'success') return false;
    if (search) {
      const q = search.toLowerCase();
      return (log.modelRequested || '').toLowerCase().includes(q) ||
        (log.modelActual || '').toLowerCase().includes(q);
    }
    return true;
  }), [logs, statusFilter, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filtered, safePage, pageSize],
  );

  useEffect(() => { setPage(1); }, [statusFilter, search, pageSize]);

  /* ---- stats ---- */
  const summary = useMemo(() => {
    let successCount = 0;
    let totalCost = 0;
    let totalTokensAll = 0;
    for (const log of logs) {
      if (log.status === 'success') successCount += 1;
      totalCost += log.estimatedCost || 0;
      totalTokensAll += log.totalTokens || 0;
    }
    const totalCount = logs.length;
    return {
      totalCount,
      successCount,
      failedCount: totalCount - successCount,
      totalCost,
      totalTokensAll,
    };
  }, [logs]);

  return (
    <div className="animate-fade-in">
      {/* Header + Stat Badges */}
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 className="page-title">{tr('使用日志')}</h2>
          <span className="kpi-chip kpi-chip-success">
            消耗总额 ${summary.totalCost.toFixed(4)}
          </span>
          <span className="kpi-chip kpi-chip-warning">
            {summary.totalTokensAll.toLocaleString()} tokens
          </span>
        </div>
        <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '6px 14px' }}>
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>

      {/* Toolbar: Filter + Search */}
      <div className="toolbar" style={{ marginBottom: 12 }}>
        <div className="pill-tabs">
          {([
            { key: 'all' as StatusFilter, label: '全部', count: summary.totalCount },
            { key: 'success' as StatusFilter, label: '成功', count: summary.successCount },
            { key: 'failed' as StatusFilter, label: '失败', count: summary.failedCount },
          ]).map(tab => (
            <button
              key={tab.key}
              className={`pill-tab ${statusFilter === tab.key ? 'active' : ''}`}
              onClick={() => setStatusFilter(tab.key)}
            >
              {tab.label} <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>{tab.count}</span>
            </button>
          ))}
        </div>
        <div className="toolbar-search" style={{ maxWidth: 280 }}>
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索模型名称..." />
        </div>
      </div>

      {/* Table */}
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
        ) : (
          <table className="data-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th style={{ width: 28 }} />
                <th>时间</th>
                <th>模型</th>
                <th>状态</th>
                <th style={{ textAlign: 'center' }}>用时</th>
                <th style={{ textAlign: 'right' }}>输入</th>
                <th style={{ textAlign: 'right' }}>输出</th>
                <th style={{ textAlign: 'right' }}>花费</th>
                <th style={{ textAlign: 'center' }}>重试</th>
              </tr>
            </thead>
            <tbody>
              {paged.map(log => {
                const pathMeta = parseProxyLogPathMeta(log.errorMessage);
                return (
                <React.Fragment key={log.id}>
                  <tr
                    onClick={() => setExpanded(expanded === log.id ? null : log.id)}
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
                      <ModelBadge model={log.modelRequested} />
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
                      {log.promptTokens?.toLocaleString() || '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)' }}>
                      {log.completionTokens?.toLocaleString() || '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontSize: 12, fontVariantNumeric: 'tabular-nums', fontWeight: 500 }}>
                      {typeof log.estimatedCost === 'number' ? `$${log.estimatedCost.toFixed(6)}` : '—'}
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
                    <td colSpan={9} style={{ padding: 0 }}>
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
                          {/* 日志详情 section */}
                          <div style={{ display: 'flex', gap: 6 }}>
                            <span style={{ fontWeight: 600, color: 'var(--color-warning)', flexShrink: 0 }}>日志详情</span>
                            <span>
                              请求模型: <strong style={{ color: 'var(--color-text-primary)' }}>{log.modelRequested}</strong>
                              {log.modelActual && log.modelActual !== log.modelRequested && (
                                <> → 实际模型: <strong style={{ color: 'var(--color-text-primary)' }}>{log.modelActual}</strong></>
                              )}
                              ，状态: <strong style={{ color: log.status === 'success' ? 'var(--color-success)' : 'var(--color-danger)' }}>{log.status === 'success' ? '成功' : '失败'}</strong>
                              ，用时 <strong style={{ color: latencyColor(log.latencyMs) }}>{formatLatency(log.latencyMs)}</strong>
                              ，站点: <strong style={{ color: 'var(--color-text-primary)' }}>{log.siteName || '未知站点'}</strong>
                              ，账号: <strong style={{ color: 'var(--color-text-primary)' }}>{log.username || '未知账号'}</strong>
                            </span>
                          </div>

                          {/* 计费过程 section */}
                          <div style={{ display: 'flex', gap: 6 }}>
                            <span style={{ fontWeight: 600, color: 'var(--color-info)', flexShrink: 0 }}>计费过程</span>
                            <span>
                              输入 {log.promptTokens?.toLocaleString() || 0} tokens
                              {' + '}输出 {log.completionTokens?.toLocaleString() || 0} tokens
                              {' = '}总计 {log.totalTokens?.toLocaleString() || 0} tokens
                              {typeof log.estimatedCost === 'number' && (
                                <>，预估费用 <strong style={{ color: 'var(--color-text-primary)' }}>${log.estimatedCost.toFixed(6)}</strong></>
                              )}
                            </span>
                          </div>

                          {/* 下游请求路径 */}
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span style={{ fontWeight: 600, color: 'var(--color-primary)', flexShrink: 0 }}>下游请求路径</span>
                            {pathMeta.downstreamPath ? (
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

                          {/* 上游请求路径 */}
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span style={{ fontWeight: 600, color: 'var(--color-primary)', flexShrink: 0 }}>上游请求路径</span>
                            {pathMeta.upstreamPath ? (
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

                          {/* 错误信息 */}
                          {pathMeta.errorMessage.trim().length > 0 && (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <span style={{ fontWeight: 600, color: 'var(--color-danger)', flexShrink: 0 }}>错误信息</span>
                              <span style={{ color: 'var(--color-danger)' }}>{pathMeta.errorMessage}</span>
                            </div>
                          )}
                          </div>
                        </div>
                      </div>
                    </td>
                  </tr>
                  )}
                </React.Fragment>
              )})}
            </tbody>
          </table>
        )}
        {!loading && filtered.length === 0 && (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
            <div className="empty-state-title">{tr('暂无使用日志')}</div>
            <div className="empty-state-desc">当请求通过代理时，日志将显示在这里</div>
          </div>
        )}
      </div>

      {/* Pagination */}
      {filtered.length > 0 && (
        <div className="pagination">
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginRight: 'auto' }}>
            显示第 {(safePage - 1) * pageSize + 1} - {Math.min(safePage * pageSize, filtered.length)} 条，共 {filtered.length} 条
          </div>
          <button className="pagination-btn" disabled={safePage <= 1} onClick={() => setPage(p => p - 1)}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
            let num: number;
            if (totalPages <= 7) num = i + 1;
            else if (safePage <= 4) num = i + 1;
            else if (safePage >= totalPages - 3) num = totalPages - 6 + i;
            else num = safePage - 3 + i;
            return (
              <button key={num} className={`pagination-btn ${safePage === num ? 'active' : ''}`} onClick={() => setPage(num)}>
                {num}
              </button>
            );
          })}
          <button className="pagination-btn" disabled={safePage >= totalPages} onClick={() => setPage(p => p + 1)}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
          <div className="pagination-size">
            每页条数:
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
  );
}
