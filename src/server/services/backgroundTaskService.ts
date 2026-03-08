import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
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

const TASK_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TASK_CLEANUP_INTERVAL_MS = 60 * 1000;
const TASK_STORAGE_KEY = 'background_tasks_v1';
const TASK_STORAGE_LIMIT = 80;
const TASK_INTERRUPTED_MESSAGE = '任务在服务重启后未继续执行，已标记为失败。';

const tasks = new Map<string, BackgroundTask>();
const dedupeTaskIds = new Map<string, string>();
let tasksHydrated = false;
let tasksHydrationPromise: Promise<void> | null = null;

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

function normalizeTaskStatus(value: unknown): BackgroundTaskStatus {
  if (value === 'pending' || value === 'running' || value === 'succeeded' || value === 'failed') {
    return value;
  }
  return 'failed';
}

function normalizeTask(raw: unknown): BackgroundTask | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id.trim() : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const type = typeof record.type === 'string' ? record.type.trim() : '';
  if (!id || !title || !type) return null;

  const createdAt = typeof record.createdAt === 'string' && record.createdAt.trim()
    ? record.createdAt
    : nowIso();
  const updatedAt = typeof record.updatedAt === 'string' && record.updatedAt.trim()
    ? record.updatedAt
    : createdAt;
  const parsedExpiresAtMs = Number.parseInt(String(record.expiresAtMs ?? ''), 10);
  const fallbackExpiresAtMs = Date.parse(updatedAt || createdAt) + TASK_TTL_MS;
  const expiresAtMs = Number.isFinite(parsedExpiresAtMs) && parsedExpiresAtMs > 0
    ? parsedExpiresAtMs
    : fallbackExpiresAtMs;

  const status = normalizeTaskStatus(record.status);
  const normalizedTask: BackgroundTask = {
    id,
    type,
    title,
    status,
    message: typeof record.message === 'string' ? record.message : '',
    error: typeof record.error === 'string' && record.error.trim() ? record.error : null,
    result: record.result ?? null,
    dedupeKey: typeof record.dedupeKey === 'string' && record.dedupeKey.trim() ? record.dedupeKey : null,
    createdAt,
    updatedAt,
    startedAt: typeof record.startedAt === 'string' && record.startedAt.trim() ? record.startedAt : null,
    finishedAt: typeof record.finishedAt === 'string' && record.finishedAt.trim() ? record.finishedAt : null,
    expiresAtMs,
  };

  if (normalizedTask.status === 'pending' || normalizedTask.status === 'running') {
    return {
      ...normalizedTask,
      status: 'failed',
      error: normalizedTask.error || TASK_INTERRUPTED_MESSAGE,
      message: normalizedTask.message || `${normalizedTask.title} ${TASK_INTERRUPTED_MESSAGE}`,
      finishedAt: normalizedTask.finishedAt || nowIso(),
      updatedAt: nowIso(),
    };
  }

  return normalizedTask;
}

function buildTaskSnapshot(limit = TASK_STORAGE_LIMIT): BackgroundTask[] {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.trunc(limit))) : TASK_STORAGE_LIMIT;
  const now = Date.now();
  return Array.from(tasks.values())
    .filter((task) => Number.isFinite(task.expiresAtMs) && task.expiresAtMs > now)
    .map((task) => ({
      ...task,
      result: toSerializableTaskValue(task.result),
    }))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, safeLimit);
}

function toSerializableTaskValue(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (value === null) return null;

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') return value;
  if (valueType === 'bigint') return String(value);
  if (valueType === 'undefined' || valueType === 'function' || valueType === 'symbol') return undefined;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (depth >= 8) return '[max-depth]';

  if (Array.isArray(value)) {
    return value.map((item) => {
      const serialized = toSerializableTaskValue(item, seen, depth + 1);
      return serialized === undefined ? null : serialized;
    });
  }

  if (valueType === 'object') {
    if (seen.has(value as object)) return '[circular]';
    seen.add(value as object);

    const entries = Object.entries(value as Record<string, unknown>);
    const serializedObject = Object.fromEntries(
      entries
        .map(([key, item]) => [key, toSerializableTaskValue(item, seen, depth + 1)] as const)
        .filter(([, item]) => item !== undefined),
    );

    seen.delete(value as object);
    return serializedObject;
  }

  return String(value);
}

async function persistTaskSnapshot() {
  try {
    const snapshot = buildTaskSnapshot();
    await db.insert(schema.settings)
      .values({ key: TASK_STORAGE_KEY, value: JSON.stringify(snapshot) })
      .onConflictDoUpdate({
        target: schema.settings.key,
        set: { value: JSON.stringify(snapshot) },
      })
      .run();
  } catch {}
}

async function ensureTasksHydrated() {
  if (tasksHydrated) return;
  if (tasksHydrationPromise) return await tasksHydrationPromise;

  tasksHydrationPromise = (async () => {
    let changed = false;
    try {
      const row = await db.select().from(schema.settings).where(eq(schema.settings.key, TASK_STORAGE_KEY)).get();
      const parsed = row?.value ? JSON.parse(row.value) : [];
      const persistedTasks = Array.isArray(parsed) ? parsed : [];
      const now = Date.now();
      for (const item of persistedTasks) {
        const task = normalizeTask(item);
        if (!task) {
          changed = true;
          continue;
        }
        if (task.expiresAtMs <= now) {
          changed = true;
          continue;
        }
        if (!tasks.has(task.id)) {
          tasks.set(task.id, task);
        }
      }
      if (persistedTasks.length > TASK_STORAGE_LIMIT) {
        changed = true;
      }
    } catch {}
    tasksHydrated = true;
    tasksHydrationPromise = null;
    if (changed) {
      await persistTaskSnapshot();
    }
  })();

  await tasksHydrationPromise;
}

function scheduleTaskSnapshotPersist() {
  void ensureTasksHydrated().then(() => persistTaskSnapshot()).catch(() => {});
}

function setTaskStatus(task: BackgroundTask, patch: Partial<BackgroundTask>) {
  const next: BackgroundTask = {
    ...task,
    ...patch,
    updatedAt: nowIso(),
  };
  tasks.set(task.id, next);
  scheduleTaskSnapshotPersist();
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
  const now = Date.now();
  let removed = false;
  for (const [taskId, task] of tasks.entries()) {
    if (task.expiresAtMs <= now) {
      tasks.delete(taskId);
      removed = true;
      if (task.dedupeKey && dedupeTaskIds.get(task.dedupeKey) === taskId) {
        dedupeTaskIds.delete(task.dedupeKey);
      }
    }
  }
  if (removed) {
    scheduleTaskSnapshotPersist();
  }
}

const cleanupTimer = setInterval(cleanupExpiredTasks, TASK_CLEANUP_INTERVAL_MS);
cleanupTimer.unref?.();

export function startBackgroundTask(
  options: BackgroundTaskStartOptions,
  runner: () => Promise<unknown>,
): { task: BackgroundTask; reused: boolean } {
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
  scheduleTaskSnapshotPersist();

  appendTaskEvent('info', `${task.title}已开始`, `${task.title} 已开始执行`, task.id);
  void runTask(task.id, options, runner);
  return { task, reused: false };
}

export async function getBackgroundTask(taskId: string): Promise<BackgroundTask | null> {
  await ensureTasksHydrated();
  return tasks.get(taskId) || null;
}

export async function listBackgroundTasks(limit = 50): Promise<BackgroundTask[]> {
  await ensureTasksHydrated();
  return buildTaskSnapshot(limit);
}

export function getRunningTaskByDedupeKey(key: string): BackgroundTask | null {
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
  tasks.clear();
  dedupeTaskIds.clear();
  tasksHydrated = false;
  tasksHydrationPromise = null;
}

void ensureTasksHydrated();
