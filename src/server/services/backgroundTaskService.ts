import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { upsertSetting } from '../db/upsertSetting.js';
import { sendNotification } from './notifyService.js';

export type BackgroundTaskStatus = 'pending' | 'running' | 'succeeded' | 'failed';

export type BackgroundTask = {
  id: string;
  type: string;
  title: string;
  status: BackgroundTaskStatus;
  message: string;
  error: string | null;
  result: unknown;
  dedupeKey: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAtMs: number;
};

type TaskMessageTemplate = string | ((task: BackgroundTask) => string);

type BackgroundTaskStartOptions = {
  type: string;
  title: string;
  dedupeKey?: string;
  keepMs?: number;
  notifyOnSuccess?: boolean;
  notifyOnFailure?: boolean;
  successTitle?: TaskMessageTemplate;
  failureTitle?: TaskMessageTemplate;
  successMessage?: TaskMessageTemplate;
  failureMessage?: TaskMessageTemplate;
};

const TASK_TTL_MS = 6 * 60 * 60 * 1000;
const TASK_CLEANUP_INTERVAL_MS = 60 * 1000;
const TASK_PERSIST_DEBOUNCE_MS = 200;
const TASK_SNAPSHOT_LIMIT = 200;
const TASK_SNAPSHOT_SETTING_KEY = 'background_tasks_snapshot_v1';

const tasks = new Map<string, BackgroundTask>();
const dedupeTaskIds = new Map<string, string>();
let snapshotLoaded = false;
let snapshotLoadPromise: Promise<void> | null = null;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistInFlight: Promise<void> | null = null;
let snapshotContextTag: string | null = null;

function nowIso() {
  return new Date().toISOString();
}

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  if (error && typeof error === 'object') {
    try {
      return JSON.stringify(error);
    } catch {
      return 'unknown error';
    }
  }
  return 'unknown error';
}

function resolveTaskMessage(template: TaskMessageTemplate | undefined, task: BackgroundTask, fallback: string): string {
  if (typeof template === 'function') {
    try {
      const value = template(task);
      if (typeof value === 'string' && value.trim()) return value.trim();
    } catch {}
    return fallback;
  }
  if (typeof template === 'string' && template.trim()) return template.trim();
  return fallback;
}

function getCurrentContextTag(): string | null {
  const dataDir = (process.env.DATA_DIR || '').trim();
  return dataDir || null;
}

function refreshContext(): void {
  const next = getCurrentContextTag();
  if (next === snapshotContextTag) return;
  tasks.clear();
  dedupeTaskIds.clear();
  snapshotLoaded = false;
  snapshotLoadPromise = null;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistInFlight = null;
  snapshotContextTag = next;
}

function cloneTask(task: BackgroundTask): BackgroundTask {
  return {
    ...task,
    result: task.result ?? null,
  };
}

function isTaskStatus(value: unknown): value is BackgroundTaskStatus {
  return value === 'pending' || value === 'running' || value === 'succeeded' || value === 'failed';
}

function normalizeTask(raw: unknown): BackgroundTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const task = raw as Record<string, unknown>;
  const id = typeof task.id === 'string' ? task.id.trim() : '';
  const type = typeof task.type === 'string' ? task.type.trim() : '';
  const title = typeof task.title === 'string' ? task.title.trim() : '';
  if (!id || !type || !title || !isTaskStatus(task.status)) return null;

  const expiresAtMs = Number(task.expiresAtMs);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) return null;

  return {
    id,
    type,
    title,
    status: task.status,
    message: typeof task.message === 'string' ? task.message : `${title} 已开始执行`,
    error: typeof task.error === 'string' ? task.error : null,
    result: 'result' in task ? task.result : null,
    dedupeKey: typeof task.dedupeKey === 'string' && task.dedupeKey.trim() ? task.dedupeKey.trim() : null,
    createdAt: typeof task.createdAt === 'string' ? task.createdAt : nowIso(),
    updatedAt: typeof task.updatedAt === 'string' ? task.updatedAt : nowIso(),
    startedAt: typeof task.startedAt === 'string' ? task.startedAt : null,
    finishedAt: typeof task.finishedAt === 'string' ? task.finishedAt : null,
    expiresAtMs,
  };
}

function buildTaskSnapshotPayload() {
  const now = Date.now();
  const items = Array.from(tasks.values())
    .filter((task) => task.expiresAtMs > now)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, TASK_SNAPSHOT_LIMIT)
    .map((task) => cloneTask(task));
  return {
    version: 1,
    savedAt: nowIso(),
    tasks: items,
  };
}

async function persistTaskSnapshot(): Promise<void> {
  refreshContext();
  if (persistInFlight) {
    await persistInFlight;
    return;
  }

  const persistTask = (async () => {
    try {
      await upsertSetting(TASK_SNAPSHOT_SETTING_KEY, buildTaskSnapshotPayload());
    } catch {}
  })();
  persistInFlight = persistTask.finally(() => {
    if (persistInFlight === persistTask) {
      persistInFlight = null;
    }
  });
  await persistInFlight;
}

function scheduleTaskSnapshotPersistence() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistTaskSnapshot();
  }, TASK_PERSIST_DEBOUNCE_MS);
}

async function loadTaskSnapshot(force = false): Promise<void> {
  refreshContext();
  if (!force && snapshotLoaded) return;
  if (snapshotLoadPromise && !force) {
    await snapshotLoadPromise;
    return;
  }

  const loadTask = (async () => {
    try {
      const row = await db.select({ value: schema.settings.value })
        .from(schema.settings)
        .where(eq(schema.settings.key, TASK_SNAPSHOT_SETTING_KEY))
        .get();
      const rawValue = row?.value ? JSON.parse(row.value) as Record<string, unknown> : null;
      const rawTasks = Array.isArray(rawValue?.tasks) ? rawValue.tasks : [];
      tasks.clear();
      dedupeTaskIds.clear();
      for (const rawTask of rawTasks) {
        const task = normalizeTask(rawTask);
        if (!task) continue;
        if (task.expiresAtMs <= Date.now()) continue;
        tasks.set(task.id, task);
        if (task.dedupeKey && (task.status === 'pending' || task.status === 'running')) {
          dedupeTaskIds.set(task.dedupeKey, task.id);
        }
      }
    } catch {
      tasks.clear();
      dedupeTaskIds.clear();
    } finally {
      snapshotLoaded = true;
    }
  })();

  snapshotLoadPromise = loadTask.finally(() => {
    if (snapshotLoadPromise === loadTask) {
      snapshotLoadPromise = null;
    }
  });
  await snapshotLoadPromise;
}

function setTaskStatus(task: BackgroundTask, patch: Partial<BackgroundTask>) {
  const next: BackgroundTask = {
    ...task,
    ...patch,
    updatedAt: nowIso(),
  };
  tasks.set(task.id, next);
  scheduleTaskSnapshotPersistence();
  return next;
}

async function appendTaskEvent(level: 'info' | 'warning' | 'error', title: string, message: string, taskId: string) {
  try {
    await db.insert(schema.events).values({
      type: 'status',
      title,
      message,
      level,
      relatedType: taskId ? `task:${taskId}` : 'task',
      createdAt: nowIso(),
    }).run();
  } catch {}
}

async function runTask(taskId: string, options: BackgroundTaskStartOptions, runner: () => Promise<unknown>) {
  const initialTask = tasks.get(taskId);
  if (!initialTask) return;

  let task = setTaskStatus(initialTask, {
    status: 'running',
    startedAt: nowIso(),
    message: `${initialTask.title} 正在执行`,
  });

  try {
    const result = await runner();
    task = setTaskStatus(task, {
      status: 'succeeded',
      finishedAt: nowIso(),
      result,
      error: null,
    });

    const eventTitle = resolveTaskMessage(options.successTitle, task, `${task.title} 已完成`);
    const eventMessage = resolveTaskMessage(options.successMessage, task, `${task.title} 已完成`);
    task = setTaskStatus(task, { message: eventMessage });
    appendTaskEvent('info', eventTitle, eventMessage, task.id);

    if (options.notifyOnSuccess) {
      await sendNotification(eventTitle, eventMessage, 'info');
    }
  } catch (error) {
    const errorText = summarizeError(error);
    task = setTaskStatus(task, {
      status: 'failed',
      finishedAt: nowIso(),
      error: errorText,
      message: `${task.title} 失败：${errorText}`,
    });

    const eventTitle = resolveTaskMessage(options.failureTitle, task, `${task.title} 失败`);
    const eventMessage = resolveTaskMessage(options.failureMessage, task, task.message);
    task = setTaskStatus(task, { message: eventMessage });
    appendTaskEvent('error', eventTitle, eventMessage, task.id);

    if (options.notifyOnFailure ?? true) {
      await sendNotification(eventTitle, eventMessage, 'error');
    }
  } finally {
    if (task.dedupeKey && dedupeTaskIds.get(task.dedupeKey) === task.id) {
      dedupeTaskIds.delete(task.dedupeKey);
    }
  }
}

function cleanupExpiredTasks() {
  refreshContext();
  const now = Date.now();
  let changed = false;
  for (const [taskId, task] of tasks.entries()) {
    if (task.expiresAtMs <= now) {
      tasks.delete(taskId);
      changed = true;
      if (task.dedupeKey && dedupeTaskIds.get(task.dedupeKey) === taskId) {
        dedupeTaskIds.delete(task.dedupeKey);
      }
    }
  }
  if (changed) {
    scheduleTaskSnapshotPersistence();
  }
}

const cleanupTimer = setInterval(cleanupExpiredTasks, TASK_CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

export function startBackgroundTask(
  options: BackgroundTaskStartOptions,
  runner: () => Promise<unknown>,
): { task: BackgroundTask; reused: boolean } {
  refreshContext();
  const dedupeKey = options.dedupeKey?.trim() || '';
  if (dedupeKey) {
    const existingTaskId = dedupeTaskIds.get(dedupeKey);
    if (existingTaskId) {
      const existing = tasks.get(existingTaskId);
      if (existing && (existing.status === 'pending' || existing.status === 'running')) {
        return { task: existing, reused: true };
      }
      dedupeTaskIds.delete(dedupeKey);
    }
  }

  const createdAt = nowIso();
  const task: BackgroundTask = {
    id: randomUUID(),
    type: options.type,
    title: options.title,
    status: 'pending',
    message: `${options.title} 已开始执行`,
    error: null,
    result: null,
    dedupeKey: dedupeKey || null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    finishedAt: null,
    expiresAtMs: Date.now() + Math.max(60_000, options.keepMs ?? TASK_TTL_MS),
  };

  tasks.set(task.id, task);
  if (dedupeKey) dedupeTaskIds.set(dedupeKey, task.id);
  scheduleTaskSnapshotPersistence();

  appendTaskEvent('info', `${task.title}已开始`, `${task.title} 已开始执行`, task.id);
  void runTask(task.id, options, runner);
  return { task, reused: false };
}

export function getBackgroundTask(taskId: string): BackgroundTask | null {
  refreshContext();
  return tasks.get(taskId) || null;
}

export function listBackgroundTasks(limit = 50): BackgroundTask[] {
  refreshContext();
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : 50;
  return Array.from(tasks.values())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, safeLimit);
}

export function getRunningTaskByDedupeKey(key: string): BackgroundTask | null {
  refreshContext();
  const taskId = dedupeTaskIds.get(key.trim());
  if (!taskId) return null;
  const task = tasks.get(taskId);
  if (!task) return null;
  if (task.status !== 'pending' && task.status !== 'running') return null;
  return task;
}

export function summarizeCheckinResults(results: Array<{ result?: any }>): { total: number; success: number; skipped: number; failed: number } {
  const summary = { total: results.length, success: 0, skipped: 0, failed: 0 };
  for (const item of results) {
    const status = item?.result?.status;
    if (status === 'skipped' || item?.result?.skipped) {
      summary.skipped += 1;
      continue;
    }
    if (item?.result?.success) {
      summary.success += 1;
      continue;
    }
    summary.failed += 1;
  }
  return summary;
}

export function __resetBackgroundTasksForTests() {
  refreshContext();
  tasks.clear();
  dedupeTaskIds.clear();
  snapshotLoaded = true;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}

export async function __loadBackgroundTasksForTests() {
  await loadTaskSnapshot(true);
}

export async function __flushBackgroundTaskPersistenceForTests() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  await persistTaskSnapshot();
}

void loadTaskSnapshot().catch(() => {});
