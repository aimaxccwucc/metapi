import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import Fastify from 'fastify';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type DbModule = typeof import('../../db/index.js');

describe('stats proxy video tasks api', () => {
  let app: FastifyInstance;
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let dataDir = '';

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-stats-proxy-videos-'));
    process.env.DATA_DIR = dataDir;
    await import('../../db/migrate.js');
    const dbModule = await import('../../db/index.js');
    const routesModule = await import('./stats.js');
    db = dbModule.db;
    schema = dbModule.schema;
    app = Fastify();
    await app.register(routesModule.statsRoutes);
  });

  beforeEach(async () => {
    await db.delete(schema.proxyVideoTasks).run();
    await db.delete(schema.accounts).run();
    await db.delete(schema.sites).run();
  });

  afterAll(async () => {
    await app.close();
    delete process.env.DATA_DIR;
  });

  it('returns proxy video tasks with parsed snapshots and site/account labels', async () => {
    const site = await db.insert(schema.sites).values({
      name: 'video-site',
      url: 'https://video.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    const account = await db.insert(schema.accounts).values({
      siteId: site.id,
      username: 'video-user',
      accessToken: 'access',
      status: 'active',
    }).returning().get();

    await db.insert(schema.proxyVideoTasks).values({
      publicId: 'vid_local_1',
      upstreamVideoId: 'vid_upstream_1',
      siteUrl: site.url,
      tokenValue: 'sk-video',
      requestedModel: 'sora_video2',
      actualModel: 'sora_video2',
      accountId: account.id,
      channelId: 99,
      statusSnapshot: JSON.stringify({ status: 'queued', progress: 0 }),
      upstreamResponseMeta: JSON.stringify({ contentType: 'application/json' }),
      lastUpstreamStatus: 200,
      createdAt: '2026-03-08 12:00:00',
      updatedAt: '2026-03-08 12:00:00',
    }).run();

    const response = await app.inject({ method: 'GET', url: '/api/stats/proxy-video-tasks?limit=10' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([
      expect.objectContaining({
        publicId: 'vid_local_1',
        requestedModel: 'sora_video2',
        username: 'video-user',
        siteName: 'video-site',
        statusSnapshot: expect.objectContaining({ status: 'queued', progress: 0 }),
        upstreamResponseMeta: expect.objectContaining({ contentType: 'application/json' }),
      }),
    ]);
  });
});
