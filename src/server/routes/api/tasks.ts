import { FastifyInstance } from 'fastify';
import { inArray, eq } from 'drizzle-orm';
import { db, schema } from '../../db/index.js';
import { getBackgroundTask, listBackgroundTasks, type BackgroundTask } from '../../services/backgroundTaskService.js';

type TaskResultRow = Record<string, unknown>;

type AccountMeta = {
  accountId: number;
  username: string | null;
  siteId: number;
  siteName: string;
};

function parsePositiveId(value: unknown): number | null {
  const normalized = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  return normalized;
}

function pickFirstText(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

async function buildAccountMetaMap(rows: TaskResultRow[]) {
  const accountIds = Array.from(new Set(rows.map((item) => parsePositiveId(item.accountId)).filter((item): item is number => !!item)));
  if (accountIds.length === 0) return new Map<number, AccountMeta>();

  const accountRows = await db.select({
    accountId: schema.accounts.id,
    username: schema.accounts.username,
    siteId: schema.sites.id,
    siteName: schema.sites.name,
  })
    .from(schema.accounts)
    .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
    .where(inArray(schema.accounts.id, accountIds))
    .all();

  return new Map<number, AccountMeta>(
    accountRows.map((item) => [item.accountId, item]),
  );
}

async function enrichTask(task: BackgroundTask): Promise<BackgroundTask> {
  const result = task.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return task;

  const resultRecord = result as Record<string, unknown>;
  const rows = Array.isArray(resultRecord.results) ? (resultRecord.results as TaskResultRow[]) : null;
  if (!rows || rows.length === 0) return task;

  const accountMetaById = await buildAccountMetaMap(rows);
  const enrichedRows = rows.map((item) => {
    const accountId = parsePositiveId(item.accountId);
    const accountMeta = accountId ? accountMetaById.get(accountId) : undefined;
    const siteId = parsePositiveId(item.siteId) ?? accountMeta?.siteId ?? null;
    const siteName = pickFirstText(item.siteName, item.site, accountMeta?.siteName) || null;
    const accountName = pickFirstText(item.accountName, item.username, accountMeta?.username) || null;

    return {
      ...item,
      ...(accountId ? { accountId } : {}),
      ...(siteId ? { siteId } : {}),
      ...(siteName ? { siteName, site: siteName } : {}),
      ...(accountName ? { accountName, username: accountName } : {}),
    };
  });

  return {
    ...task,
    result: {
      ...resultRecord,
      results: enrichedRows,
    },
  };
}

export async function taskRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { limit?: string } }>('/api/tasks', async (request) => {
    const limit = Number.parseInt(request.query.limit || '50', 10);
    const rows = await listBackgroundTasks(limit);
    const tasks = await Promise.all(rows.map((task) => enrichTask(task)));
    return { tasks };
  });

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const task = await getBackgroundTask(request.params.id);
    if (!task) {
      return reply.code(404).send({ success: false, message: 'task not found' });
    }
    return {
      success: true,
      task: await enrichTask(task),
    };
  });
}
