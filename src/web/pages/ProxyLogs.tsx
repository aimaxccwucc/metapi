import React, { useEffect, useState, useCallback, useMemo } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { ModelBadge } from '../components/BrandIcon.js';
import { formatDateTimeLocal } from './helpers/checkinLogTime.js';
import ModernSelect from '../components/ModernSelect.js';
import { parseProxyLogPathMeta } from './helpers/proxyLogPathMeta.js';
import { tr } from '../i18n.js';

type StatusFilter = 'all' | 'success' | 'failed';
type LogView = 'proxy' | 'videos';
type VideoStatusFilter = 'all' | 'queued' | 'running' | 'succeeded' | 'failed';

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
  billingDetails?: {
    quotaType: number;
    usage: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      billablePromptTokens: number;
      promptTokensIncludeCache: boolean | null;
    };
    pricing: {
      modelRatio: number;
      completionRatio: number;
      cacheRatio: number;
      cacheCreationRatio: number;
      groupRatio: number;
    };
    breakdown: {
      inputPerMillion: number;
      outputPerMillion: number;
      cacheReadPerMillion: number;
      cacheCreationPerMillion: number;
      inputCost: number;
      outputCost: number;
      cacheReadCost: number;
      cacheCreationCost: number;
      totalCost: number;
    };
  } | null;
}

interface ProxyVideoTask {
  id: number;
  publicId: string;
  upstreamVideoId: string;
  requestedModel?: string | null;
  actualModel?: string | null;
  lastUpstreamStatus?: number | null;
  lastPolledAt?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  username?: string | null;
  siteName?: string | null;
  siteUrl?: string | null;
  statusSnapshot?: {
    status?: string;
    error?: unknown;
    [key: string]: unknown;
  } | null;
  upstreamResponseMeta?: {
    contentType?: string;
    [key: string]: unknown;
  } | null;
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

function formatCompactNumber(value: number, digits = 6) {
  if (!Number.isFinite(value)) return '0';
  const formatted = value.toFixed(digits).replace(/\.?0+$/, '');
  return formatted || '0';
}

function formatPerMillionPrice(value: number) {
  return `$${formatCompactNumber(value)} / 1M tokens`;
}

function formatBillingDetailSummary(log: ProxyLog) {
  const detail = log.billingDetails;
  if (!detail) return null;
  return `模型倍率 ${formatCompactNumber(detail.pricing.modelRatio)}，输出倍率 ${formatCompactNumber(detail.pricing.completionRatio)}，缓存倍率 ${formatCompactNumber(detail.pricing.cacheRatio)}，缓存创建倍率 ${formatCompactNumber(detail.pricing.cacheCreationRatio)}，分组倍率 ${formatCompactNumber(detail.pricing.groupRatio)}`;
}

function isMediaProxyPath(path?: string | null) {
  const normalized = String(path || '').trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('/images') || normalized.includes('/image') || normalized.includes('/videos') || normalized.includes('/video');
}

function isUnestimatedMediaLog(log: ProxyLog, pathMeta?: ReturnType<typeof parseProxyLogPathMeta>) {
  const totalTokens = Number(log.totalTokens || 0);
  const promptTokens = Number(log.promptTokens || 0);
  const completionTokens = Number(log.completionTokens || 0);
  const estimatedCost = typeof log.estimatedCost === 'number' ? log.estimatedCost : null;
  const mediaByPath = isMediaProxyPath(pathMeta?.downstreamPath) || isMediaProxyPath(pathMeta?.upstreamPath);
  const mediaByModel = /(?:image|images|video|videos|flux|kling|veo|wanx|seedream|gpt-image|gemini-.*image)/i.test(`${log.modelRequested} ${log.modelActual}`);
  return (mediaByPath || mediaByModel)
    && totalTokens === 0
    && promptTokens === 0
    && completionTokens === 0
    && estimatedCost !== null
    && estimatedCost <= 0;
}

function formatEstimatedCost(log: ProxyLog, pathMeta?: ReturnType<typeof parseProxyLogPathMeta>) {
  if (isUnestimatedMediaLog(log, pathMeta)) return '暂不可估算';
  if (typeof log.estimatedCost !== 'number') return '-';
  return `$${log.estimatedCost.toFixed(6)}`;
}

function buildBillingProcessLines(log: ProxyLog) {
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

function getVideoTaskStatus(task: ProxyVideoTask): string {
  return String(task.statusSnapshot?.status || 'unknown').trim().toLowerCase() || 'unknown';
}

function renderVideoStatusBadge(status: string) {
  const normalized = status.trim().toLowerCase();
  const isSuccess = normalized === 'succeeded' || normalized === 'completed';
  const isQueued = normalized === 'queued' || normalized === 'submitted';
  const isRunning = normalized === 'running' || normalized === 'processing' || normalized === 'in_progress';
  const isFailed = normalized === 'failed' || normalized === 'error' || normalized === 'cancelled';
  const label = isSuccess
    ? '成功'
    : isQueued
      ? '排队中'
      : isRunning
        ? '处理中'
        : isFailed
          ? '失败'
          : normalized || '未知';
  const badgeClass = isSuccess
    ? 'badge-success'
    : isFailed
      ? 'badge-error'
      : 'badge-warning';
  const dotColor = isSuccess
    ? 'var(--color-success)'
    : isFailed
      ? 'var(--color-danger)'
      : 'var(--color-warning)';

  return (
    <span className={`badge ${badgeClass}`} style={{ fontSize: 11, fontWeight: 600 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor }} />
      {label}
    </span>
  );
}

function renderProxyLogTable(
  paged: ProxyLog[],
  expanded: number | null,
  setExpanded: React.Dispatch<React.SetStateAction<number | null>>,
) {
  return (
    <table className="data-table" style={{ width: '100%' }}>
      <thead>
        <tr>
          <th style={{ width: 28 }} />
          <th>时间</th>
          <th>模型</th>
          <th>{tr('状态')}</th>
          <th style={{ textAlign: 'center' }}>用时</th>
          <th style={{ textAlign: 'right' }}>输入</th>
          <th style={{ textAlign: 'right' }}>输出</th>
          <th style={{ textAlign: 'right' }}>花费</th>
          <th style={{ textAlign: 'center' }}>重试</th>
        </tr>
      </thead>
      <tbody>
        {paged.map((log) => {
          const pathMeta = parseProxyLogPathMeta(log.errorMessage);
          const billingDetailSummary = formatBillingDetailSummary(log);
          const billingProcessLines = buildBillingProcessLines(log);
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
                <td>{renderVideoStatusBadge(log.status === 'success' ? 'succeeded' : 'failed')}</td>
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
                  {formatEstimatedCost(log, pathMeta)}
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
                          <div style={{ display: 'flex', gap: 6 }}>
                            <span style={{ fontWeight: 600, color: 'var(--color-warning)', flexShrink: 0 }}>日志详情</span>
                            <div>
                              <div>
                                请求模型: <strong style={{ color: 'var(--color-text-primary)' }}>{log.modelRequested}</strong>
                                {log.modelActual && log.modelActual !== log.modelRequested && (
                                  <>{' -> '}实际模型: <strong style={{ color: 'var(--color-text-primary)' }}>{log.modelActual}</strong></>
                                )}
                                ，状态: <strong style={{ color: log.status === 'success' ? 'var(--color-success)' : 'var(--color-danger)' }}>{log.status === 'success' ? '成功' : '失败'}</strong>
                                ，用时: <strong style={{ color: latencyColor(log.latencyMs) }}>{formatLatency(log.latencyMs)}</strong>
                                ，站点: <strong style={{ color: 'var(--color-text-primary)' }}>{log.siteName || '未知站点'}</strong>
                                ，账号: <strong style={{ color: 'var(--color-text-primary)' }}>{log.username || '未知账号'}</strong>
                              </div>
                              {billingDetailSummary && (
                                <div style={{ color: 'var(--color-text-muted)' }}>{billingDetailSummary}</div>
                              )}
                            </div>
                          </div>

                          {log.billingDetails && log.billingDetails.usage.cacheReadTokens > 0 && (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <span style={{ fontWeight: 600, color: 'var(--color-warning)', flexShrink: 0 }}>缓存 Tokens</span>
                              <span>{log.billingDetails.usage.cacheReadTokens.toLocaleString()}</span>
                            </div>
                          )}

                          {log.billingDetails && log.billingDetails.usage.cacheCreationTokens > 0 && (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <span style={{ fontWeight: 600, color: 'var(--color-warning)', flexShrink: 0 }}>缓存创建 Tokens</span>
                              <span>{log.billingDetails.usage.cacheCreationTokens.toLocaleString()}</span>
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
                                输入 {log.promptTokens?.toLocaleString() || 0} tokens
                                {' + '}输出 {log.completionTokens?.toLocaleString() || 0} tokens
                                {' = '}总计 {log.totalTokens?.toLocaleString() || 0} tokens
                                {formatEstimatedCost(log, pathMeta) !== '-' && (
                                  <>，预估费用 <strong style={{ color: 'var(--color-text-primary)' }}>{formatEstimatedCost(log, pathMeta)}</strong></>
                                )}
                              </span>
                            )}
                          </div>

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
          );
        })}
      </tbody>
    </table>
  );
}

function renderVideoTaskTable(
  paged: ProxyVideoTask[],
  expandedVideo: number | null,
  setExpandedVideo: React.Dispatch<React.SetStateAction<number | null>>,
) {
  return (
    <table className="data-table" style={{ width: '100%' }}>
      <thead>
        <tr>
          <th style={{ width: 28 }} />
          <th>时间</th>
          <th>模型</th>
          <th>{tr('状态')}</th>
          <th>任务 ID</th>
          <th style={{ textAlign: 'center' }}>上游状态</th>
          <th>站点 / 账号</th>
        </tr>
      </thead>
      <tbody>
        {paged.map((task) => {
          const upstreamStatus = getVideoTaskStatus(task);
          const isExpanded = expandedVideo === task.id;
          return (
            <React.Fragment key={task.id}>
              <tr
                onClick={() => setExpandedVideo(isExpanded ? null : task.id)}
                style={{
                  cursor: 'pointer',
                  background: isExpanded ? 'var(--color-primary-light)' : undefined,
                  transition: 'background 0.15s',
                }}
              >
                <td style={{ padding: '8px 4px 8px 12px' }}>
                  <svg width="10" height="10" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{
                    transform: isExpanded ? 'rotate(90deg)' : 'none',
                    transition: 'transform 0.2s',
                    color: 'var(--color-text-muted)',
                  }}>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                  </svg>
                </td>
                <td style={{ fontSize: 12, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: 'var(--color-text-secondary)' }}>
                  {formatDateTimeLocal(task.createdAt)}
                </td>
                <td>
                  <ModelBadge model={task.requestedModel || task.actualModel || 'video'} />
                </td>
                <td>{renderVideoStatusBadge(upstreamStatus)}</td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{task.publicId}</td>
                <td style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>{task.lastUpstreamStatus ?? '-'}</td>
                <td style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
                  {task.siteName || '未知站点'} / {task.username || '未知账号'}
                </td>
              </tr>
              {isExpanded && (
                <tr style={{ background: 'var(--color-bg)' }}>
                  <td colSpan={7} style={{ padding: 0 }}>
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
                            <span style={{ fontWeight: 600, color: 'var(--color-warning)', flexShrink: 0 }}>任务详情</span>
                            <div>
                              <div>
                                请求模型: <strong style={{ color: 'var(--color-text-primary)' }}>{task.requestedModel || '-'}</strong>
                                {task.actualModel && task.actualModel !== task.requestedModel && (
                                  <>{' -> '}实际模型: <strong style={{ color: 'var(--color-text-primary)' }}>{task.actualModel}</strong></>
                                )}
                              </div>
                              <div>
                                本地任务 ID: <strong style={{ color: 'var(--color-text-primary)' }}>{task.publicId}</strong>
                                {'，'}上游任务 ID: <strong style={{ color: 'var(--color-text-primary)' }}>{task.upstreamVideoId}</strong>
                              </div>
                              <div>
                                任务状态: <strong style={{ color: 'var(--color-text-primary)' }}>{upstreamStatus || 'unknown'}</strong>
                                {'，'}上游 HTTP: <strong style={{ color: 'var(--color-text-primary)' }}>{task.lastUpstreamStatus ?? '-'}</strong>
                              </div>
                              <div>
                                站点: <strong style={{ color: 'var(--color-text-primary)' }}>{task.siteName || '未知站点'}</strong>
                                {'，'}账号: <strong style={{ color: 'var(--color-text-primary)' }}>{task.username || '未知账号'}</strong>
                              </div>
                              {task.lastPolledAt && (
                                <div>
                                  最近轮询: <strong style={{ color: 'var(--color-text-primary)' }}>{formatDateTimeLocal(task.lastPolledAt)}</strong>
                                </div>
                              )}
                            </div>
                          </div>
                          <div style={{ display: 'flex', gap: 6 }}>
                            <span style={{ fontWeight: 600, color: 'var(--color-info)', flexShrink: 0 }}>说明</span>
                            <span>视频任务为异步流程，`/logs` 里的文本调用日志不等于最终生成结果，请以这里的任务状态为准。</span>
                          </div>
                          {task.statusSnapshot && (
                            <div style={{ display: 'flex', gap: 6 }}>
                              <span style={{ fontWeight: 600, color: 'var(--color-primary)', flexShrink: 0 }}>状态快照</span>
                              <pre style={{
                                margin: 0,
                                whiteSpace: 'pre-wrap',
                                wordBreak: 'break-word',
                                background: 'var(--color-bg-card)',
                                border: '1px solid var(--color-border-light)',
                                borderRadius: 6,
                                padding: 10,
                                flex: 1,
                              }}>
                                {JSON.stringify(task.statusSnapshot, null, 2)}
                              </pre>
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
  );
}

export default function ProxyLogs() {
  const [view, setView] = useState<LogView>('proxy');
  const [logs, setLogs] = useState<ProxyLog[]>([]);
  const [videoTasks, setVideoTasks] = useState<ProxyVideoTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [videoStatusFilter, setVideoStatusFilter] = useState<VideoStatusFilter>('all');
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<number | null>(null);
  const [expandedVideo, setExpandedVideo] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const toast = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [proxyData, videoData] = await Promise.all([
        api.getProxyLogs('limit=500'),
        api.getProxyVideoTasks('limit=500'),
      ]);
      setLogs(Array.isArray(proxyData) ? proxyData : []);
      setVideoTasks(Array.isArray(videoData) ? videoData : []);
    } catch (e: any) {
      toast.error(e.message || '加载日志失败');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const filteredLogs = useMemo(() => logs.filter((log) => {
    if (statusFilter === 'success' && log.status !== 'success') return false;
    if (statusFilter === 'failed' && log.status === 'success') return false;
    if (search) {
      const q = search.toLowerCase();
      return (log.modelRequested || '').toLowerCase().includes(q)
        || (log.modelActual || '').toLowerCase().includes(q)
        || (log.username || '').toLowerCase().includes(q)
        || (log.siteName || '').toLowerCase().includes(q);
    }
    return true;
  }), [logs, search, statusFilter]);

  const filteredVideoTasks = useMemo(() => videoTasks.filter((task) => {
    const status = getVideoTaskStatus(task);
    if (videoStatusFilter !== 'all' && status !== videoStatusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (task.requestedModel || '').toLowerCase().includes(q)
        || (task.actualModel || '').toLowerCase().includes(q)
        || (task.publicId || '').toLowerCase().includes(q)
        || (task.upstreamVideoId || '').toLowerCase().includes(q)
        || (task.username || '').toLowerCase().includes(q)
        || (task.siteName || '').toLowerCase().includes(q);
    }
    return true;
  }), [search, videoStatusFilter, videoTasks]);

  const activeRows = view === 'proxy' ? filteredLogs : filteredVideoTasks;
  const totalPages = Math.max(1, Math.ceil(activeRows.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedProxyLogs = useMemo(
    () => filteredLogs.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredLogs, pageSize, safePage],
  );
  const pagedVideoTasks = useMemo(
    () => filteredVideoTasks.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredVideoTasks, pageSize, safePage],
  );

  useEffect(() => {
    setPage(1);
    setExpanded(null);
    setExpandedVideo(null);
  }, [view, search, statusFilter, videoStatusFilter, pageSize]);

  const proxySummary = useMemo(() => {
    let successCount = 0;
    let totalCost = 0;
    let totalTokensAll = 0;
    let estimatedCostCount = 0;
    for (const log of logs) {
      if (log.status === 'success') successCount += 1;
      const pathMeta = parseProxyLogPathMeta(log.errorMessage);
      if (!isUnestimatedMediaLog(log, pathMeta) && typeof log.estimatedCost === 'number') {
        totalCost += log.estimatedCost;
        estimatedCostCount += 1;
      }
      totalTokensAll += log.totalTokens || 0;
    }
    const totalCount = logs.length;
    return {
      totalCount,
      successCount,
      failedCount: totalCount - successCount,
      totalCost,
      totalTokensAll,
      estimatedCostCount,
    };
  }, [logs]);

  const videoSummary = useMemo(() => {
    let queuedCount = 0;
    let runningCount = 0;
    let successCount = 0;
    let failedCount = 0;
    for (const task of videoTasks) {
      const status = getVideoTaskStatus(task);
      if (status === 'queued' || status === 'submitted') queuedCount += 1;
      else if (status === 'running' || status === 'processing' || status === 'in_progress') runningCount += 1;
      else if (status === 'succeeded' || status === 'completed') successCount += 1;
      else if (status === 'failed' || status === 'error' || status === 'cancelled') failedCount += 1;
    }
    return {
      totalCount: videoTasks.length,
      queuedCount,
      runningCount,
      successCount,
      failedCount,
    };
  }, [videoTasks]);

  return (
    <div className="animate-fade-in">
      <div className="page-header" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 className="page-title">{tr('使用日志')}</h2>
          {view === 'proxy' ? (
            <>
              <span className="kpi-chip kpi-chip-success">
                消耗总额 {proxySummary.estimatedCostCount > 0 ? `$${proxySummary.totalCost.toFixed(4)}` : '暂不可估算'}
              </span>
              <span className="kpi-chip kpi-chip-warning">{proxySummary.totalTokensAll.toLocaleString()} tokens</span>
            </>
          ) : (
            <>
              <span className="kpi-chip kpi-chip-warning">排队 {videoSummary.queuedCount}</span>
              <span className="kpi-chip kpi-chip-primary">处理中 {videoSummary.runningCount}</span>
              <span className="kpi-chip kpi-chip-success">成功 {videoSummary.successCount}</span>
              <span className="kpi-chip kpi-chip-danger">失败 {videoSummary.failedCount}</span>
            </>
          )}
        </div>
        <button onClick={load} disabled={loading} className="btn btn-ghost" style={{ border: '1px solid var(--color-border)', padding: '6px 14px' }}>
          <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }}>
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
          {loading ? '加载中...' : '刷新'}
        </button>
      </div>

      <div className="toolbar" style={{ marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div className="pill-tabs">
            {[
              { key: 'proxy' as LogView, label: '文本日志', count: proxySummary.totalCount },
              { key: 'videos' as LogView, label: '视频任务', count: videoSummary.totalCount },
            ].map((tab) => (
              <button
                key={tab.key}
                className={`pill-tab ${view === tab.key ? 'active' : ''}`}
                onClick={() => setView(tab.key)}
              >
                {tab.label} <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>{tab.count}</span>
              </button>
            ))}
          </div>
          <div className="toolbar-search" style={{ maxWidth: 320 }}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={view === 'proxy' ? '搜索模型 / 站点 / 账号...' : '搜索任务 / 模型 / 站点...'} />
          </div>
        </div>

        <div className="pill-tabs">
          {view === 'proxy'
            ? ([
              { key: 'all' as StatusFilter, label: '全部', count: proxySummary.totalCount },
              { key: 'success' as StatusFilter, label: '成功', count: proxySummary.successCount },
              { key: 'failed' as StatusFilter, label: '失败', count: proxySummary.failedCount },
            ]).map((tab) => (
              <button
                key={tab.key}
                className={`pill-tab ${statusFilter === tab.key ? 'active' : ''}`}
                onClick={() => setStatusFilter(tab.key)}
              >
                {tab.label} <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>{tab.count}</span>
              </button>
            ))
            : ([
              { key: 'all' as VideoStatusFilter, label: '全部', count: videoSummary.totalCount },
              { key: 'queued' as VideoStatusFilter, label: '排队中', count: videoSummary.queuedCount },
              { key: 'running' as VideoStatusFilter, label: '处理中', count: videoSummary.runningCount },
              { key: 'succeeded' as VideoStatusFilter, label: '成功', count: videoSummary.successCount },
              { key: 'failed' as VideoStatusFilter, label: '失败', count: videoSummary.failedCount },
            ]).map((tab) => (
              <button
                key={tab.key}
                className={`pill-tab ${videoStatusFilter === tab.key ? 'active' : ''}`}
                onClick={() => setVideoStatusFilter(tab.key)}
              >
                {tab.label} <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.7 }}>{tab.count}</span>
              </button>
            ))}
        </div>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        {loading ? (
          <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[...Array(8)].map((_, index) => (
              <div key={index} style={{ display: 'flex', gap: 16 }}>
                <div className="skeleton" style={{ width: 140, height: 16 }} />
                <div className="skeleton" style={{ width: 200, height: 16 }} />
                <div className="skeleton" style={{ width: 50, height: 16 }} />
                <div className="skeleton" style={{ width: 50, height: 16 }} />
                <div className="skeleton" style={{ width: 50, height: 16 }} />
                <div className="skeleton" style={{ width: 70, height: 16 }} />
              </div>
            ))}
          </div>
        ) : view === 'proxy' ? renderProxyLogTable(pagedProxyLogs, expanded, setExpanded) : renderVideoTaskTable(pagedVideoTasks, expandedVideo, setExpandedVideo)}

        {!loading && activeRows.length === 0 && (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
            <div className="empty-state-title">{view === 'proxy' ? tr('暂无使用日志') : '暂无视频任务'}</div>
            <div className="empty-state-desc">{view === 'proxy' ? '当请求通过代理时，日志将显示在这里' : '视频创建后会在这里显示异步任务状态'}</div>
          </div>
        )}
      </div>

      {activeRows.length > 0 && (
        <div className="pagination">
          <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginRight: 'auto' }}>
            显示第 {(safePage - 1) * pageSize + 1} - {Math.min(safePage * pageSize, activeRows.length)} 条，共 {activeRows.length} 条
          </div>
          <button className="pagination-btn" disabled={safePage <= 1} onClick={() => setPage((value) => value - 1)}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
          </button>
          {Array.from({ length: Math.min(totalPages, 7) }, (_, index) => {
            let num: number;
            if (totalPages <= 7) num = index + 1;
            else if (safePage <= 4) num = index + 1;
            else if (safePage >= totalPages - 3) num = totalPages - 6 + index;
            else num = safePage - 3 + index;
            return (
              <button key={num} className={`pagination-btn ${safePage === num ? 'active' : ''}`} onClick={() => setPage(num)}>
                {num}
              </button>
            );
          })}
          <button className="pagination-btn" disabled={safePage >= totalPages} onClick={() => setPage((value) => value + 1)}>
            <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
          <div className="pagination-size">
            每页条数:
            <div style={{ minWidth: 86 }}>
              <ModernSelect
                size="sm"
                value={String(pageSize)}
                onChange={(nextValue) => setPageSize(Number(nextValue))}
                options={PAGE_SIZES.map((size) => ({ value: String(size), label: String(size) }))}
                placeholder={String(pageSize)}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
