import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { and, like, desc, eq } from 'drizzle-orm';

export async function searchRoutes(app: FastifyInstance) {
  app.post<{ Body: { query: string; limit?: number } }>('/api/search', async (request) => {
    const { query, limit = 20 } = request.body;
    if (!query || query.trim().length === 0) {
      return { accounts: [], sites: [], checkinLogs: [], proxyLogs: [], models: [] };
    }

    const q = `%${query.trim()}%`;
    const perCategory = Math.min(Math.ceil(limit / 5), 10);

    // Search sites
    const sites = (await db.select().from(schema.sites)
      .where(like(schema.sites.name, q))
      .limit(perCategory).all())
      .concat(
        await db.select().from(schema.sites)
          .where(like(schema.sites.url, q))
          .limit(perCategory).all()
      );
    // Deduplicate by id
    const uniqueSites = [...new Map(sites.map(s => [s.id, s])).values()].slice(0, perCategory);

    // Search accounts (join with sites for site name)
    const accountResults = await db.select().from(schema.accounts)
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(like(schema.accounts.username, q))
      .limit(perCategory).all();
    const accounts = accountResults.map(r => ({ ...r.accounts, site: r.sites }));

    // Search checkin logs (by message)
    const checkinLogs = (await db.select().from(schema.checkinLogs)
      .innerJoin(schema.accounts, eq(schema.checkinLogs.accountId, schema.accounts.id))
      .where(like(schema.checkinLogs.message, q))
      .orderBy(desc(schema.checkinLogs.createdAt))
      .limit(perCategory).all())
      .map(r => ({ ...r.checkin_logs, account: r.accounts }));

    // Search proxy logs (by model name)
    const proxyLogs = await db.select().from(schema.proxyLogs)
      .where(like(schema.proxyLogs.modelRequested, q))
      .orderBy(desc(schema.proxyLogs.createdAt))
      .limit(perCategory).all();

    // Search models (only keep routable items)
    const modelRows = await db.select({
      modelName: schema.tokenModelAvailability.modelName,
      tokenId: schema.accountTokens.id,
      accountId: schema.accounts.id,
      siteId: schema.sites.id,
    })
      .from(schema.tokenModelAvailability)
      .innerJoin(schema.accountTokens, eq(schema.tokenModelAvailability.tokenId, schema.accountTokens.id))
      .innerJoin(schema.accounts, eq(schema.accountTokens.accountId, schema.accounts.id))
      .innerJoin(schema.sites, eq(schema.accounts.siteId, schema.sites.id))
      .where(
        and(
          like(schema.tokenModelAvailability.modelName, q),
          eq(schema.tokenModelAvailability.available, true),
          eq(schema.accountTokens.enabled, true),
          eq(schema.accounts.status, 'active'),
        ),
      )
      .limit(perCategory * 20)
      .all();

    const modelAgg = new Map<string, { tokenIds: Set<number>; accountIds: Set<number>; siteIds: Set<number> }>();
    for (const row of modelRows) {
      const key = row.modelName;
      if (!modelAgg.has(key)) {
        modelAgg.set(key, { tokenIds: new Set(), accountIds: new Set(), siteIds: new Set() });
      }
      const agg = modelAgg.get(key)!;
      agg.tokenIds.add(row.tokenId);
      agg.accountIds.add(row.accountId);
      agg.siteIds.add(row.siteId);
    }

    const models = Array.from(modelAgg.entries())
      .map(([name, agg]) => ({
        name,
        accountCount: agg.accountIds.size,
        tokenCount: agg.tokenIds.size,
        siteCount: agg.siteIds.size,
      }))
      .sort((a, b) => {
        if (b.accountCount !== a.accountCount) return b.accountCount - a.accountCount;
        if (b.tokenCount !== a.tokenCount) return b.tokenCount - a.tokenCount;
        return a.name.localeCompare(b.name);
      })
      .slice(0, perCategory);

    return { accounts, sites: uniqueSites, checkinLogs, proxyLogs, models };
  });
}
