import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { formatDateTimeLocal } from '../pages/helpers/checkinLogTime.js';
import { buildAccountFocusPath, buildSiteFocusPath } from '../pages/helpers/navigationFocus.js';
import { tr } from '../i18n.js';
import { useToast } from './Toast.js';
import { useAnimatedVisibility } from './useAnimatedVisibility.js';

export type BackgroundTaskDetail = {
  id: string;
  type: string;
  title: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  message?: string | null;
  error?: string | null;
  result?: unknown;
  createdAt?: string | null;
  updatedAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
};

type TaskDetailModalProps = {
  open: boolean;
  task: BackgroundTaskDetail | null;
  loading?: boolean;
  error?: string;
  onClose: () => void;
};

type DetailBadge = {
  label: string;
  cls: string;
  rank: number;
};

type TaskResultRow = {
  subject: string;
  detail: string;
  badge: DetailBadge;
  accountId: number | null;
  siteId: number | null;
  accountLabel: string;
  siteLabel: string;
};

const SUMMARY_LABELS: Record<string, string> = {
  total: '总计',
  success: '成功',
  skipped: '跳过',
  failed: '失败',
  synced: '同步成功',
  repaired: '已修复',
  created: '已创建',
  alreadyOk: '已正常',
  eligible: '可处理',
  healthy: '健康',
  unhealthy: '异常',
  degraded: '降级',
  disabled: '禁用',
  unknown: '未知',
  alive: '可达',
  unreachable: '不可达',
  checkedSites: '检测站点',
  removedSites: '移除站点',
  removedAccounts: '移除账号',
  accountCountOnUnreachableSites: '不可达站点账号数',
  attempt: '重试轮次',
  dryRun: '预检模式',
};

function stringifyTaskResult(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pickFirstText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function parsePositiveId(value: unknown): number | null {
  const normalized = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return normalized;
}

function formatSummaryValue(value: unknown) {
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'string') return value || '-';
  if (Array.isArray(value)) return `${value.length} 项`;
  if (value && typeof value === 'object') return '对象';
  return '-';
}

function getTaskBadge(status: BackgroundTaskDetail['status'] | string | undefined): DetailBadge {
  if (status === 'failed') return { label: '失败', cls: 'badge-error', rank: 0 };
  if (status === 'succeeded') return { label: '成功', cls: 'badge-success', rank: 3 };
  if (status === 'running') return { label: '进行中', cls: 'badge-info', rank: 2 };
  return { label: '排队中', cls: 'badge-warning', rank: 1 };
}

function getResultBadge(item: any): DetailBadge {
  if (item?.alive === false) return { label: '不可达', cls: 'badge-error', rank: 0 };
  if (item?.alive === true) return { label: '可达', cls: 'badge-success', rank: 3 };

  const nestedStatus = pickFirstText(item?.result?.status);
  const directStatus = pickFirstText(item?.status, item?.state);
  const rawStatus = directStatus || nestedStatus;

  if (item?.result?.skipped || rawStatus === 'skipped') return { label: '跳过', cls: 'badge-warning', rank: 1 };

  const mapped: Record<string, DetailBadge> = {
    failed: { label: '失败', cls: 'badge-error', rank: 0 },
    unhealthy: { label: '异常', cls: 'badge-error', rank: 0 },
    success: { label: '成功', cls: 'badge-success', rank: 3 },
    succeeded: { label: '成功', cls: 'badge-success', rank: 3 },
    synced: { label: '同步成功', cls: 'badge-success', rank: 3 },
    repaired: { label: '已修复', cls: 'badge-success', rank: 3 },
    created: { label: '已创建', cls: 'badge-success', rank: 3 },
    already_ok: { label: '已正常', cls: 'badge-success', rank: 3 },
    healthy: { label: '健康', cls: 'badge-success', rank: 3 },
    degraded: { label: '降级', cls: 'badge-warning', rank: 1 },
    disabled: { label: '禁用', cls: 'badge-warning', rank: 1 },
    pending: { label: '排队中', cls: 'badge-warning', rank: 1 },
    running: { label: '进行中', cls: 'badge-info', rank: 2 },
  };

  if (rawStatus && mapped[rawStatus]) return mapped[rawStatus];
  if (item?.result?.success === false) return { label: '失败', cls: 'badge-error', rank: 0 };
  if (item?.result?.success === true) return { label: '成功', cls: 'badge-success', rank: 3 };
  return { label: '未知', cls: 'badge-muted', rank: 4 };
}

function buildResultRow(item: any): TaskResultRow {
  const accountLabel = pickFirstText(item?.accountName, item?.username);
  const siteLabel = pickFirstText(item?.siteName, item?.site);
  const accountId = parsePositiveId(item?.accountId);
  const siteId = parsePositiveId(item?.siteId);

  const parts: string[] = [];
  const message = pickFirstText(item?.message, item?.result?.message);
  const reason = pickFirstText(item?.reason);
  const reward = pickFirstText(item?.result?.reward, item?.reward);
  const checkedUrl = pickFirstText(item?.checkedUrl);

  if (message) parts.push(message);
  if (reason) parts.push(`原因：${reason}`);
  if (reward) parts.push(`奖励：${reward}`);
  if (
    typeof item?.created === 'number'
    || typeof item?.updated === 'number'
    || typeof item?.total === 'number'
  ) {
    parts.push(`新建 ${item.created ?? 0}，更新 ${item.updated ?? 0}，总计 ${item.total ?? 0}`);
  }
  if (checkedUrl) parts.push(`检测地址：${checkedUrl}`);
  if (typeof item?.statusCode === 'number') parts.push(`HTTP ${item.statusCode}`);

  let subject = '未命名项';
  if (accountLabel && siteLabel) subject = `${accountLabel} @ ${siteLabel}`;
  else if (accountLabel) subject = accountLabel;
  else if (siteLabel) subject = siteLabel;
  else if (accountId) subject = `账号 #${accountId}`;
  else if (siteId) subject = `站点 #${siteId}`;
  else if (item?.id !== undefined && item?.id !== null) subject = `记录 #${item.id}`;

  return {
    subject,
    detail: parts.join(' · ') || '-',
    badge: getResultBadge(item),
    accountId,
    siteId,
    accountLabel,
    siteLabel,
  };
}

function extractTaskRows(result: unknown): TaskResultRow[] {
  const rows = Array.isArray((result as any)?.results) ? (result as any).results : [];
  return rows
    .map((item: any, index: number) => ({
      ...buildResultRow(item),
      index,
    }))
    .sort((left, right) => left.badge.rank - right.badge.rank || left.index - right.index)
    .map(({ index: _index, ...item }) => item);
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  if (typeof document === 'undefined') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  return copied;
}

function downloadText(filename: string, content: string) {
  if (typeof document === 'undefined') return;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function buildFailedRowsText(task: BackgroundTaskDetail | null, rows: TaskResultRow[]) {
  const header = [
    `${tr('任务详情')}：${task?.title || '-'}`,
    `ID：${task?.id || '-'}`,
    `${tr('失败')}：${rows.length}`,
  ];
  const body = rows.map((row, index) => `${index + 1}. ${row.subject}\n   [${row.badge.label}] ${row.detail}`);
  return [...header, '', ...body].join('\n');
}

export default function TaskDetailModal({ open, task, loading = false, error = '', onClose }: TaskDetailModalProps) {
  const presence = useAnimatedVisibility(open, 200);
  const navigate = useNavigate();
  const toast = useToast();
  const [failedOnly, setFailedOnly] = useState(false);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (open) setFailedOnly(false);
  }, [open, task?.id]);

  const summaryEntries = useMemo(() => {
    const summary = task?.result && typeof task.result === 'object' && !Array.isArray(task.result)
      ? (task.result as Record<string, unknown>).summary
      : undefined;
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return [];

    return Object.entries(summary)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => ({
        key,
        label: SUMMARY_LABELS[key] || key,
        value: formatSummaryValue(value),
      }));
  }, [task]);

  const detailRows = useMemo(() => extractTaskRows(task?.result), [task]);
  const failedRows = useMemo(() => detailRows.filter((item) => item.badge.rank === 0), [detailRows]);
  const visibleRows = useMemo(() => (failedOnly ? failedRows : detailRows), [detailRows, failedOnly, failedRows]);
  const taskBadge = getTaskBadge(task?.status);
  const rawResult = task?.result === undefined ? '' : stringifyTaskResult(task.result);

  const openSite = useCallback((siteId: number) => {
    onClose();
    navigate(buildSiteFocusPath(siteId));
  }, [navigate, onClose]);

  const openAccount = useCallback((accountId: number) => {
    onClose();
    navigate(buildAccountFocusPath(accountId));
  }, [navigate, onClose]);

  const copyFailedRows = useCallback(async () => {
    if (failedRows.length === 0) {
      toast.info(tr('当前没有失败项'));
      return;
    }
    try {
      const ok = await copyText(buildFailedRowsText(task, failedRows));
      if (!ok) throw new Error('copy failed');
      toast.success(tr('失败项已复制'));
    } catch {
      toast.error(tr('复制失败，请手动复制。'));
    }
  }, [failedRows, task, toast]);

  const exportFailedRows = useCallback(() => {
    if (failedRows.length === 0) {
      toast.info(tr('当前没有失败项'));
      return;
    }
    const filename = `task-failed-${task?.id || Date.now()}.txt`;
    downloadText(filename, buildFailedRowsText(task, failedRows));
    toast.success(tr('失败项已导出'));
  }, [failedRows, task, toast]);

  if (!presence.shouldRender) return null;

  const body = (
    <div className={`modal-backdrop ${presence.isVisible ? '' : 'is-closing'}`.trim()} onClick={onClose}>
      <div
        className={`modal-content ${presence.isVisible ? '' : 'is-closing'}`.trim()}
        onClick={(event) => event.stopPropagation()}
        style={{ maxWidth: 980, width: 'min(980px, calc(100vw - 32px))', maxHeight: 'calc(100vh - 48px)', padding: 0 }}
      >
        <div className="modal-header" style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
            <div style={{ fontSize: 16, fontWeight: 700, overflowWrap: 'anywhere' }}>{task?.title || tr('任务详情')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 12, color: 'var(--color-text-muted)' }}>
              <span className={`badge ${taskBadge.cls}`} style={{ fontSize: 11 }}>{taskBadge.label}</span>
              <span className="badge badge-muted" style={{ fontSize: 11 }}>{task?.type || '-'}</span>
              <span>{task?.id || '-'}</span>
            </div>
          </div>
          <button onClick={onClose} className="btn btn-ghost" style={{ padding: '8px 12px' }}>{tr('关闭')}</button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14, overflow: 'auto' }}>
          {loading ? (
            <div style={{ display: 'grid', gap: 10 }}>
              <div className="skeleton" style={{ width: '100%', height: 36 }} />
              <div className="skeleton" style={{ width: '100%', height: 160 }} />
            </div>
          ) : null}

          {error ? (
            <div className="alert alert-error">{error}</div>
          ) : null}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 10 }}>
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>{tr('创建时间')}</div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{formatDateTimeLocal(task?.createdAt)}</div>
            </div>
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>{tr('开始时间')}</div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{formatDateTimeLocal(task?.startedAt || task?.updatedAt)}</div>
            </div>
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>{tr('结束时间')}</div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{formatDateTimeLocal(task?.finishedAt || task?.updatedAt)}</div>
            </div>
          </div>

          {task?.message ? (
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8 }}>{tr('任务消息')}</div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.7 }}>{task.message}</div>
            </div>
          ) : null}

          {task?.error ? (
            <div className="card" style={{ padding: 12, borderColor: 'color-mix(in srgb, var(--color-danger) 28%, var(--color-border-light))' }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 8, color: 'var(--color-danger)' }}>{tr('错误信息')}</div>
              <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', lineHeight: 1.7, color: 'var(--color-danger)' }}>{task.error}</div>
            </div>
          ) : null}

          {summaryEntries.length > 0 ? (
            <div className="card" style={{ padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, marginBottom: 10 }}>{tr('汇总')}</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
                {summaryEntries.map((item) => (
                  <div key={item.key} style={{ padding: '10px 12px', borderRadius: 10, background: 'var(--color-bg)', border: '1px solid var(--color-border-light)' }}>
                    <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 4 }}>{item.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>{item.value}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {detailRows.length > 0 ? (
            <div className="card" style={{ padding: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ fontSize: 12, fontWeight: 700 }}>{tr('执行明细')}</div>
                  <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('共')} {visibleRows.length} / {detailRows.length} · {tr('失败')} {failedRows.length}</div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  {failedRows.length > 0 ? (
                    <button
                      className="btn btn-ghost"
                      style={{ border: '1px solid var(--color-border)', padding: '8px 12px' }}
                      onClick={() => setFailedOnly((prev) => !prev)}
                    >
                      {failedOnly ? tr('全部') : tr('仅看失败')}
                    </button>
                  ) : null}
                  <button
                    className="btn btn-ghost"
                    style={{ border: '1px solid var(--color-border)', padding: '8px 12px' }}
                    onClick={() => { void copyFailedRows(); }}
                  >
                    {tr('复制失败项')}
                  </button>
                  <button
                    className="btn btn-ghost"
                    style={{ border: '1px solid var(--color-border)', padding: '8px 12px' }}
                    onClick={exportFailedRows}
                  >
                    {tr('导出失败项')}
                  </button>
                </div>
              </div>
              <div style={{ overflow: 'auto', maxHeight: 360 }}>
                <table className="data-table" style={{ minWidth: 760, tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: '32%' }} />
                    <col style={{ width: 120 }} />
                    <col />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>{tr('对象')}</th>
                      <th>{tr('状态')}</th>
                      <th>{tr('详情')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((item, index) => (
                      <tr key={`${item.subject}-${index}`}>
                        <td style={{ fontWeight: 600, whiteSpace: 'normal', overflowWrap: 'anywhere' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            {item.accountLabel ? (
                              item.accountId ? (
                                <button className="btn btn-link btn-link-primary" onClick={() => openAccount(item.accountId!)}>
                                  {item.accountLabel}
                                </button>
                              ) : (
                                <span>{item.accountLabel}</span>
                              )
                            ) : null}
                            {item.accountLabel && item.siteLabel ? <span style={{ color: 'var(--color-text-muted)' }}>@</span> : null}
                            {item.siteLabel ? (
                              item.siteId ? (
                                <button className="btn btn-link btn-link-primary" onClick={() => openSite(item.siteId!)}>
                                  {item.siteLabel}
                                </button>
                              ) : (
                                <span>{item.siteLabel}</span>
                              )
                            ) : null}
                            {!item.accountLabel && !item.siteLabel ? <span>{item.subject}</span> : null}
                          </div>
                        </td>
                        <td>
                          <span className={`badge ${item.badge.cls}`} style={{ fontSize: 11 }}>{item.badge.label}</span>
                        </td>
                        <td style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', color: 'var(--color-text-secondary)' }}>{item.detail}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {rawResult ? (
            <details className="card" style={{ padding: 12 }}>
              <summary style={{ cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>{tr('原始结果')}</summary>
              <pre style={{ margin: '10px 0 0', padding: 12, borderRadius: 10, background: 'var(--color-bg)', color: 'var(--color-text-secondary)', overflow: 'auto', maxHeight: 300, fontSize: 12, lineHeight: 1.6 }}>
                {rawResult}
              </pre>
            </details>
          ) : null}
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(body, document.body) : body;
}
