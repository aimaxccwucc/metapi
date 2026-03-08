import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { and, eq, sql } from 'drizzle-orm';
import { detectSite } from '../../services/siteDetector.js';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import { executeCleanupUnreachableSites, executeRefreshSiteReachability } from '../../services/siteHealthService.js';
import { invalidateSiteProxyCache, parseSiteProxyUrlInput } from '../../services/siteProxy.js';

function normalizeSiteStatus(input: unknown): 'active' | 'disabled' | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') return null;
  const status = input.trim().toLowerCase();
  if (status === 'active' || status === 'disabled') return status;
  return null;
}

function normalizePinnedFlag(input: unknown): boolean | null {
  if (input === undefined || input === null) return null;
  if (typeof input === 'boolean') return input;
  if (typeof input === 'number') return input !== 0;
  if (typeof input === 'string') {
    const normalized = input.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return null;
}

function normalizeSortOrder(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  const parsed = Number.parseInt(String(input), 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, parsed);
}

function normalizeGlobalWeight(input: unknown): number | null {
  if (input === undefined || input === null || input === '') return null;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.max(0.01, Math.min(100, Number(parsed.toFixed(3))));
}

function normalizeSiteBaseUrl(input: unknown): string {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return trimmed.replace(/\/+$/, '');
  }
}

function normalizeOptionalExternalCheckinUrl(input: unknown): {
  valid: boolean;
  present: boolean;
  url: string | null;
} {
  if (input === undefined) {
    return { valid: true, present: false, url: null };
  }
  if (input === null) {
    return { valid: true, present: true, url: null };
  }
  if (typeof input !== 'string') {
    return { valid: false, present: true, url: null };
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: true, present: true, url: null };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, present: true, url: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, present: true, url: null };
  }
  return { valid: true, present: true, url: parsed.toString().replace(/\/+$/, '') };
}

export async function sitesRoutes(app: FastifyInstance) {
  // List all sites
  app.get('/api/sites', async () => {
    const siteRows = await db.select().from(schema.sites).all();
    const accountBalanceRows = await db.select({
      siteId: schema.accounts.siteId,
      totalBalance: sql<number>`coalesce(sum(${schema.accounts.balance}), 0)`,
    }).from(schema.accounts)
      .groupBy(schema.accounts.siteId)
      .all();

    const totalBalanceBySiteId: Record<number, number> = {};
    for (const row of accountBalanceRows) {
      totalBalanceBySiteId[row.siteId] = Number(row.totalBalance || 0);
    }

    return siteRows.map((site) => ({
      ...site,
      totalBalance: Math.round((totalBalanceBySiteId[site.id] || 0) * 1_000_000) / 1_000_000,
    }));
  });

  // Add a site
  app.post<{ Body: {
    name: string;
    url: string;
    platform?: string;
    apiKey?: string;
    proxyUrl?: string | null;
    externalCheckinUrl?: string | null;
    status?: string;
    isPinned?: boolean;
    sortOrder?: number;
    globalWeight?: number;
  } }>('/api/sites', async (request, reply) => {
    const { name, url, platform, apiKey, proxyUrl, externalCheckinUrl, status, isPinned, sortOrder, globalWeight } = request.body;
    const normalizedSiteUrl = normalizeSiteBaseUrl(url);
    const normalizedStatus = normalizeSiteStatus(status);
    if (status !== undefined && !normalizedStatus) {
      return reply.code(400).send({ error: 'Invalid site status. Expected active or disabled.' });
    }
    const parsedProxyUrl = parseSiteProxyUrlInput(proxyUrl);
    if (!parsedProxyUrl.valid) {
      return reply.code(400).send({ error: 'Invalid proxyUrl. Expected a valid http(s)/socks proxy URL.' });
    }
    const normalizedExternalCheckinUrl = normalizeOptionalExternalCheckinUrl(externalCheckinUrl);
    if (!normalizedExternalCheckinUrl.valid) {
      return reply.code(400).send({ error: 'Invalid externalCheckinUrl. Expected a valid http(s) URL.' });
    }
    const normalizedPinned = normalizePinnedFlag(isPinned);
    if (isPinned !== undefined && normalizedPinned === null) {
      return reply.code(400).send({ error: 'Invalid isPinned value. Expected boolean.' });
    }
    const normalizedSortOrder = normalizeSortOrder(sortOrder);
    if (sortOrder !== undefined && normalizedSortOrder === null) {
      return reply.code(400).send({ error: 'Invalid sortOrder value. Expected non-negative integer.' });
    }
    const normalizedGlobalWeight = normalizeGlobalWeight(globalWeight);
    if (globalWeight !== undefined && normalizedGlobalWeight === null) {
      return reply.code(400).send({ error: 'Invalid globalWeight value. Expected a positive number.' });
    }

    const existingSites = await db.select().from(schema.sites).all();
    const maxSortOrder = existingSites.reduce((max, site) => Math.max(max, site.sortOrder || 0), -1);

    let detectedPlatform = platform;
    if (!detectedPlatform) {
      const detected = await detectSite(normalizedSiteUrl);
      detectedPlatform = detected?.platform;
    }
    if (!detectedPlatform) {
      return { error: 'Could not detect platform. Please specify manually.' };
    }
    const inserted = await db.insert(schema.sites).values({
      name,
      url: normalizedSiteUrl,
      platform: detectedPlatform,
      apiKey,
      proxyUrl: parsedProxyUrl.proxyUrl,
      externalCheckinUrl: normalizedExternalCheckinUrl.url,
      status: normalizedStatus ?? 'active',
      isPinned: normalizedPinned ?? false,
      sortOrder: normalizedSortOrder ?? (maxSortOrder + 1),
      globalWeight: normalizedGlobalWeight ?? 1,
    }).run();
    const siteId = Number(inserted.lastInsertRowid || 0);
    if (siteId <= 0) {
      return reply.code(500).send({ error: 'Create site failed' });
    }
    const result = await db.select().from(schema.sites).where(eq(schema.sites.id, siteId)).get();
    if (!result) {
      return reply.code(500).send({ error: 'Create site failed' });
    }
    invalidateSiteProxyCache();
    return result;
  });

  // Update a site
  app.put<{ Params: { id: string }; Body: {
    name?: string;
    url?: string;
    platform?: string;
    apiKey?: string;
    proxyUrl?: string | null;
    externalCheckinUrl?: string | null;
    status?: string;
    isPinned?: boolean;
    sortOrder?: number;
    globalWeight?: number;
  } }>('/api/sites/:id', async (request, reply) => {
    const id = parseInt(request.params.id);
    if (Number.isNaN(id)) {
      return reply.code(400).send({ error: 'Invalid site id' });
    }

    const existingSite = await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
    if (!existingSite) {
      return reply.code(404).send({ error: 'Site not found' });
    }

    const updates: any = {};
    const body = request.body;
    const normalizedStatus = normalizeSiteStatus(body.status);
    if (body.status !== undefined && !normalizedStatus) {
      return reply.code(400).send({ error: 'Invalid site status. Expected active or disabled.' });
    }
    const parsedProxyUrl = parseSiteProxyUrlInput(body.proxyUrl);
    if (!parsedProxyUrl.valid) {
      return reply.code(400).send({ error: 'Invalid proxyUrl. Expected a valid http(s)/socks proxy URL.' });
    }
    const normalizedExternalCheckinUrl = normalizeOptionalExternalCheckinUrl(body.externalCheckinUrl);
    if (!normalizedExternalCheckinUrl.valid) {
      return reply.code(400).send({ error: 'Invalid externalCheckinUrl. Expected a valid http(s) URL.' });
    }
    const normalizedPinned = normalizePinnedFlag(body.isPinned);
    if (body.isPinned !== undefined && normalizedPinned === null) {
      return reply.code(400).send({ error: 'Invalid isPinned value. Expected boolean.' });
    }
    const normalizedSortOrder = normalizeSortOrder(body.sortOrder);
    if (body.sortOrder !== undefined && normalizedSortOrder === null) {
      return reply.code(400).send({ error: 'Invalid sortOrder value. Expected non-negative integer.' });
    }
    const normalizedGlobalWeight = normalizeGlobalWeight(body.globalWeight);
    if (body.globalWeight !== undefined && normalizedGlobalWeight === null) {
      return reply.code(400).send({ error: 'Invalid globalWeight value. Expected a positive number.' });
    }

    if (body.name !== undefined) updates.name = body.name;
    if (body.url !== undefined) updates.url = normalizeSiteBaseUrl(body.url);
    if (body.platform !== undefined) updates.platform = body.platform;
    if (body.apiKey !== undefined) updates.apiKey = body.apiKey;
    if (parsedProxyUrl.present) updates.proxyUrl = parsedProxyUrl.proxyUrl;
    if (normalizedExternalCheckinUrl.present) updates.externalCheckinUrl = normalizedExternalCheckinUrl.url;
    if (body.status !== undefined) updates.status = normalizedStatus;
    if (body.isPinned !== undefined) updates.isPinned = normalizedPinned;
    if (body.sortOrder !== undefined) updates.sortOrder = normalizedSortOrder;
    if (body.globalWeight !== undefined) updates.globalWeight = normalizedGlobalWeight;
    updates.updatedAt = new Date().toISOString();
    await db.update(schema.sites).set(updates).where(eq(schema.sites.id, id)).run();
    invalidateSiteProxyCache();

    if (body.status !== undefined && normalizedStatus) {
      const now = new Date().toISOString();
      if (normalizedStatus === 'disabled') {
        await db.update(schema.accounts)
          .set({ status: 'disabled', updatedAt: now })
          .where(eq(schema.accounts.siteId, id))
          .run();

        try {
          await db.insert(schema.events).values({
            type: 'status',
            title: '站点已禁用',
            message: `${existingSite.name} 已禁用，关联账号已全部置为禁用`,
            level: 'warning',
            relatedId: id,
            relatedType: 'site',
            createdAt: new Date().toISOString(),
          }).run();
        } catch {}
      } else {
        await db.update(schema.accounts)
          .set({ status: 'active', updatedAt: now })
          .where(and(eq(schema.accounts.siteId, id), eq(schema.accounts.status, 'disabled')))
          .run();

        try {
          await db.insert(schema.events).values({
            type: 'status',
            title: '站点已启用',
            message: `${existingSite.name} 已启用，关联禁用账号已恢复为活跃`,
            level: 'info',
            relatedId: id,
            relatedType: 'site',
            createdAt: new Date().toISOString(),
          }).run();
        } catch {}
      }
    }

    return await db.select().from(schema.sites).where(eq(schema.sites.id, id)).get();
  });

  // Delete a site
  app.delete<{ Params: { id: string } }>('/api/sites/:id', async (request) => {
    const id = parseInt(request.params.id);
    await db.delete(schema.sites).where(eq(schema.sites.id, id)).run();
    invalidateSiteProxyCache();
    return { success: true };
  });

  // Detect platform for a URL
  app.post<{ Body: { url: string } }>('/api/sites/detect', async (request) => {
    const result = await detectSite(request.body.url);
    return result || { error: 'Could not detect platform' };
  });

  app.post<{ Body?: { wait?: boolean } }>('/api/sites/health/refresh', async (request) => {
    if (request.body?.wait) {
      const result = await executeRefreshSiteReachability();
      return { success: true, ...result };
    }

    const { task, reused } = startBackgroundTask(
      {
        type: 'status',
        title: '检测站点存活状态',
        dedupeKey: 'refresh-all-site-reachability',
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const summary = (currentTask.result as { summary?: { alive: number; unreachable: number } })?.summary;
          if (!summary) return '站点存活检测已完成';
          return `站点存活检测完成：可达 ${summary.alive}，不可达 ${summary.unreachable}`;
        },
        failureMessage: (currentTask) => `站点存活检测失败：${currentTask.error || 'unknown error'}`,
      },
      async () => executeRefreshSiteReachability(),
    );

    return {
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused ? '站点存活检测进行中，请稍后查看任务中心' : '已开始检测站点存活状态，请稍后查看任务中心',
    };
  });

  app.post<{ Body?: { wait?: boolean; dryRun?: boolean } }>('/api/sites/cleanup-unreachable', async (request) => {
    const dryRun = request.body?.dryRun === true;
    if (request.body?.wait) {
      const result = await executeCleanupUnreachableSites(dryRun);
      return { success: true, ...result };
    }

    const dedupeKey = dryRun ? 'cleanup-unreachable-sites-dryrun' : 'cleanup-unreachable-sites';
    const title = dryRun ? '预检失活站点（不删除）' : '移除失活站点及账号';

    const { task, reused } = startBackgroundTask(
      {
        type: 'status',
        title,
        dedupeKey,
        notifyOnFailure: true,
        successMessage: (currentTask) => {
          const summary = (currentTask.result as { summary?: { unreachableSites: number; removedSites: number; removedAccounts: number; dryRun: boolean } })?.summary;
          if (!summary) return `${title}已完成`;
          if (summary.dryRun) return `预检完成：不可达站点 ${summary.unreachableSites}`;
          return `移除完成：站点 ${summary.removedSites}，账号 ${summary.removedAccounts}`;
        },
        failureMessage: (currentTask) => `${title}失败：${currentTask.error || 'unknown error'}`,
      },
      async () => executeCleanupUnreachableSites(dryRun),
    );

    return {
      success: true,
      queued: true,
      reused,
      jobId: task.id,
      status: task.status,
      message: reused ? `${title}进行中，请稍后查看任务中心` : `已开始${title}，请稍后查看任务中心`,
    };
  });
}
