import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useToast } from '../components/Toast.js';
import { formatDateTimeLocal } from './helpers/checkinLogTime.js';
import ModernSelect from '../components/ModernSelect.js';
import { tr } from '../i18n.js';

type ProgramEvent = {
  id: number;
  type: string;
  title: string;
  message?: string | null;
  level: 'info' | 'warning' | 'error';
  read: boolean;
  relatedId?: number | null;
  relatedType?: string | null;
  createdAt?: string | null;
};

type BackgroundTask = {
  id: string;
  type: string;
  title: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  message?: string | null;
  error?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

const PAGE_SIZE = 80;
const TASK_POLL_INTERVAL_MS = 5000;

const TYPE_OPTIONS = [
  { value: '', label: '全部类型' },
  { value: 'checkin', label: '签到' },
  { value: 'balance', label: '余额' },
  { value: 'token', label: '令牌' },
  { value: 'proxy', label: '代理' },
  { value: 'status', label: '状态' },
];

function levelLabel(level: string) {
  if (level === 'error') return { label: '错误', cls: 'badge-error' };
  if (level === 'warning') return { label: '警告', cls: 'badge-warning' };
  return { label: '信息', cls: 'badge-info' };
}

function eventStatusLabel(row: ProgramEvent) {
  const text = `${row.title || ''} ${row.message || ''}`.toLowerCase();

  if (text.includes('失败') || text.includes('failed') || text.includes('error')) {
    return { label: '失败', cls: 'badge-error' };
  }
  if (text.includes('跳过') || text.includes('skipped')) {
    return { label: '跳过', cls: 'badge-warning' };
  }
  if (text.includes('进行中') || text.includes('已开始') || text.includes('running') || text.includes('pending')) {
    return { label: '进行中', cls: 'badge-info' };
  }
  if (text.includes('成功') || text.includes('已完成') || text.includes('completed') || text.includes('finished')) {
    return { label: '成功', cls: 'badge-success' };
  }

  if (row.level === 'error') return { label: '异常', cls: 'badge-error' };
  if (row.level === 'warning') return { label: '警告', cls: 'badge-warning' };
  return { label: '信息', cls: 'badge-info' };
}

function taskStatusLabel(status: BackgroundTask['status']) {
  if (status === 'failed') return { label: '失败', cls: 'badge-error' };
  if (status === 'succeeded') return { label: '成功', cls: 'badge-success' };
  if (status === 'running') return { label: '进行中', cls: 'badge-info' };
  return { label: '排队中', cls: 'badge-warning' };
}

export default function ProgramLogs() {
  const [events, setEvents] = useState<ProgramEvent[]>([]);
  const [tasks, setTasks] = useState<BackgroundTask[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [tasksRefreshing, setTasksRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filterType, setFilterType] = useState('');
  const [onlyUnread, setOnlyUnread] = useState(false);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [rowLoading, setRowLoading] = useState<Record<number, boolean>>({});
  const [taskRetryLoading, setTaskRetryLoading] = useState<Record<string, boolean>>({});
  const toast = useToast();

  const loadTasks = async (silent = false) => {
    if (silent) setTasksRefreshing(true);
    else setTasksLoading(true);
    try {
      const result = await api.getTasks(60);
      const rows = Array.isArray(result?.tasks) ? result.tasks : [];
      setTasks(rows);
    } catch (e: any) {
      if (!silent) toast.error(e.message || '加载任务中心失败');
    } finally {
      setTasksLoading(false);
      setTasksRefreshing(false);
    }
  };

  const load = async (silent = false, append = false) => {
    if (append) setLoadingMore(true);
    else if (silent) setRefreshing(true);
    else setLoading(true);

    try {
      const nextOffset = append ? offset : 0;
      const params = new URLSearchParams();
      params.set('limit', String(PAGE_SIZE));
      params.set('offset', String(nextOffset));
      if (filterType) params.set('type', filterType);
      if (onlyUnread) params.set('read', 'false');
      const rows = await api.getEvents(params.toString());
      const safeRows = Array.isArray(rows) ? rows : [];
      setEvents((prev) => (append ? [...prev, ...safeRows] : safeRows));
      const loaded = append ? nextOffset + safeRows.length : safeRows.length;
      setOffset(loaded);
      setHasMore(safeRows.length >= PAGE_SIZE);
    } catch (e: any) {
      toast.error(e.message || '加载程序日志失败');
    } finally {
      setLoading(false);
      setLoadingMore(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
  }, [filterType, onlyUnread]);

  useEffect(() => {
    loadTasks();
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      void loadTasks(true);
    }, TASK_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const visibleRows = useMemo(() => events, [events]);
  const taskSummary = useMemo(() => ({
    total: tasks.length,
    pending: tasks.filter((item) => item.status === 'pending').length,
    running: tasks.filter((item) => item.status === 'running').length,
    succeeded: tasks.filter((item) => item.status === 'succeeded').length,
    failed: tasks.filter((item) => item.status === 'failed').length,
  }), [tasks]);

  const withRowLoading = async (id: number, fn: () => Promise<void>) => {
    setRowLoading((prev) => ({ ...prev, [id]: true }));
    try {
      await fn();
    } finally {
      setRowLoading((prev) => ({ ...prev, [id]: false }));
    }
  };

  const retryTask = async (task: BackgroundTask) => {
    const taskId = task.id;
    setTaskRetryLoading((prev) => ({ ...prev, [taskId]: true }));
    try {
      if (task.type === 'checkin') {
        await api.triggerCheckinAll();
      } else if (task.type === 'token' && (task.title || '').includes('Key 一键修复')) {
        await api.repairAccountKeys();
      } else if (task.type === 'status' && (task.title || '').includes('运行健康状态')) {
        await api.refreshAccountHealth();
      } else if (task.type === 'status' && (task.title || '').includes('站点存活')) {
        await api.refreshSiteHealth();
      } else if (task.type === 'status' && (task.title || '').includes('失活站点')) {
        const dryRun = (task.title || '').includes('预检');
        await api.cleanupUnreachableSites(dryRun ? { dryRun: true } : {});
      } else {
        toast.info('该任务类型暂不支持一键重试，请到对应页面手动重试。');
        return;
      }
      toast.success('已提交重试任务');
      await loadTasks(true);
    } catch (e: any) {
      toast.error(e.message || '重试任务失败');
    } finally {
      setTaskRetryLoading((prev) => ({ ...prev, [taskId]: false }));
    }
  };

  const markOneRead = async (id: number) => {
    await withRowLoading(id, async () => {
      await api.markEventRead(id);
      setEvents((prev) => {
        if (onlyUnread) return prev.filter((item) => item.id !== id);
        return prev.map((item) => (item.id === id ? { ...item, read: true } : item));
      });
    });
  };

  const markAllRead = async () => {
    setMarkingAll(true);
    try {
      await api.markAllEventsRead();
      if (onlyUnread) setEvents([]);
      else setEvents((prev) => prev.map((item) => ({ ...item, read: true })));
      toast.success('已标记全部为已读');
    } catch (e: any) {
      toast.error(e.message || '标记失败');
    } finally {
      setMarkingAll(false);
    }
  };

  const clearAll = async () => {
    setClearing(true);
    try {
      await api.clearEvents();
      setEvents([]);
      setOffset(0);
      setHasMore(false);
      toast.success('日志已清空');
    } catch (e: any) {
      toast.error(e.message || '清空失败');
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="animate-fade-in">
      <div className="page-header">
        <h2 className="page-title">{tr('程序日志')}</h2>
        <div className="page-actions">
          <button
            onClick={() => loadTasks(true)}
            disabled={tasksRefreshing}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {tasksRefreshing ? <><span className="spinner spinner-sm" /> 任务刷新中...</> : '刷新任务中心'}
          </button>
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {refreshing ? <><span className="spinner spinner-sm" /> 刷新中...</> : '刷新'}
          </button>
          <button
            onClick={markAllRead}
            disabled={markingAll}
            className="btn btn-ghost"
            style={{ border: '1px solid var(--color-border)', padding: '8px 14px' }}
          >
            {markingAll ? <><span className="spinner spinner-sm" /> 标记中...</> : '全部已读'}
          </button>
          <button
            onClick={clearAll}
            disabled={clearing}
            className="btn btn-link btn-link-danger"
          >
            {clearing ? <><span className="spinner spinner-sm" /> 清空中...</> : '清空日志'}
          </button>
        </div>
      </div>

      <div className="card" style={{ overflowX: 'auto', marginBottom: 12 }}>
        <div style={{ padding: '12px 14px', borderBottom: '1px solid var(--color-border-light)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700 }}>任务中心</div>
          <span className="badge badge-muted" style={{ fontSize: 11 }}>自动轮询 {TASK_POLL_INTERVAL_MS / 1000}s</span>
          <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-muted)' }}>
            总计 {taskSummary.total} · 排队 {taskSummary.pending} · 进行中 {taskSummary.running} · 成功 {taskSummary.succeeded} · 失败 {taskSummary.failed}
          </div>
        </div>
        {tasksLoading ? (
          <div style={{ padding: 14 }}>
            <div className="skeleton" style={{ width: '100%', height: 34, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: '100%', height: 34 }} />
          </div>
        ) : tasks.length > 0 ? (
          <table className="data-table program-logs-table">
            <colgroup>
              <col style={{ width: 170 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: 120 }} />
              <col style={{ width: 280 }} />
              <col />
              <col style={{ width: 120 }} />
            </colgroup>
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>状态</th>
                <th>任务</th>
                <th>详情</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((task) => {
                const status = taskStatusLabel(task.status);
                return (
                  <tr key={task.id}>
                    <td style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                      {formatDateTimeLocal(task.updatedAt || task.createdAt)}
                    </td>
                    <td>
                      <span className="badge badge-muted" style={{ fontSize: 11 }}>
                        {task.type || '-'}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${status.cls}`} style={{ fontSize: 11 }}>
                        {status.label}
                      </span>
                    </td>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{task.title || '-'}</div>
                      <div style={{ fontSize: 11, color: 'var(--color-text-muted)' }}>{task.id}</div>
                    </td>
                    <td>
                      <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{task.message || '-'}</div>
                      {task.error ? (
                        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--color-danger)' }}>
                          错误：{task.error}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      {task.status === 'failed' ? (
                        <button
                          className="btn btn-link btn-link-primary"
                          onClick={() => retryTask(task)}
                          disabled={!!taskRetryLoading[task.id]}
                        >
                          {taskRetryLoading[task.id] ? <span className="spinner spinner-sm" /> : '重试'}
                        </button>
                      ) : (
                        <span className="badge badge-muted" style={{ fontSize: 11 }}>-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty-state" style={{ padding: '24px 12px' }}>
            <div className="empty-state-title">暂无后台任务</div>
            <div className="empty-state-desc">触发同步 Token、签到或模型刷新后会显示执行状态。</div>
          </div>
        )}
      </div>

      <div className="card" style={{ padding: 14, marginBottom: 12, display: 'flex', gap: 10, alignItems: 'center' }}>
        <div style={{ minWidth: 170 }}>
          <ModernSelect
            size="sm"
            value={filterType}
            onChange={(nextValue) => setFilterType(nextValue)}
            options={TYPE_OPTIONS.map((item) => ({
              value: item.value,
              label: item.label,
            }))}
            placeholder="全部类型"
          />
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--color-text-secondary)' }}>
          <input
            type="checkbox"
            checked={onlyUnread}
            onChange={(e) => {
              setOffset(0);
              setHasMore(true);
              setOnlyUnread(e.target.checked);
            }}
          />
          仅看未读
        </label>

        <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--color-text-muted)' }}>
          共 {visibleRows.length} 条
        </div>
      </div>

      <div className="card" style={{ overflowX: 'auto' }}>
        {loading ? (
          <div style={{ padding: 20 }}>
            <div className="skeleton" style={{ width: '100%', height: 34, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: '100%', height: 34, marginBottom: 8 }} />
            <div className="skeleton" style={{ width: '100%', height: 34 }} />
          </div>
        ) : visibleRows.length > 0 ? (
          <table className="data-table program-logs-table">
            <colgroup>
              <col style={{ width: 170 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: 90 }} />
              <col style={{ width: 260 }} />
              <col />
              <col style={{ width: 110 }} />
              <col style={{ width: 140 }} />
            </colgroup>
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>级别</th>
                <th>标题</th>
                <th>内容</th>
                <th>状态</th>
                <th style={{ textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row, idx) => {
                const level = levelLabel(row.level || 'info');
                const eventStatus = eventStatusLabel(row);
                return (
                  <tr key={row.id} className={`animate-slide-up stagger-${Math.min(idx + 1, 5)}`}>
                    <td style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                      {formatDateTimeLocal(row.createdAt)}
                    </td>
                    <td>
                      <span className="badge badge-muted" style={{ fontSize: 11 }}>
                        {row.type || '-'}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${level.cls}`} style={{ fontSize: 11 }}>
                        {level.label}
                      </span>
                    </td>
                    <td className="program-logs-title-cell">
                      {row.title || '-'}
                    </td>
                    <td className="program-logs-content-cell">
                      {row.message || '-'}
                    </td>
                    <td>
                      <span className={`badge ${eventStatus.cls}`} style={{ fontSize: 11 }}>
                        {eventStatus.label}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
                        {row.read ? (
                          <span className="badge badge-muted" style={{ fontSize: 11 }}>已读</span>
                        ) : (
                          <span className="badge badge-warning" style={{ fontSize: 11 }}>未读</span>
                        )}
                        {!row.read && (
                          <button
                            onClick={() => markOneRead(row.id)}
                            disabled={!!rowLoading[row.id]}
                            className="btn btn-link btn-link-primary"
                          >
                            {rowLoading[row.id] ? <span className="spinner spinner-sm" /> : '标记已读'}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">
            <svg className="empty-state-icon" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <div className="empty-state-title">暂无日志</div>
            <div className="empty-state-desc">当前筛选条件下没有程序日志。</div>
          </div>
        )}
      </div>

      {!loading && visibleRows.length > 0 && hasMore && (
        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'center' }}>
          <button
            className="btn btn-ghost"
            onClick={() => load(false, true)}
            disabled={loadingMore}
            style={{ border: '1px solid var(--color-border)', padding: '8px 16px' }}
          >
            {loadingMore ? <><span className="spinner spinner-sm" /> 加载中...</> : '加载更多'}
          </button>
        </div>
      )}
    </div>
  );
}
