import { FastifyInstance } from 'fastify';
import { db, schema } from '../../db/index.js';
import { config } from '../../config.js';
import { eq } from 'drizzle-orm';
import { formatUtcSqlDateTime } from '../../services/localTimeService.js';
import { createRateLimitGuard } from '../../middleware/requestRateLimit.js';
import { buildAdminSessionClearCookie, buildAdminSessionCookie } from '../../middleware/auth.js';

const limitAdminTokenChange = createRateLimitGuard({
  bucket: 'auth-change',
  max: 3,
  windowMs: 60_000,
});

const limitAdminSessionLogin = createRateLimitGuard({
  bucket: 'auth-login',
  max: 10,
  windowMs: 60_000,
});

function readAdminSessionCookie(rawCookieHeader: string): string {
  for (const part of rawCookieHeader.split(';')) {
    const entry = part.trim();
    if (!entry.startsWith('metapi_admin_session=')) continue;
    return decodeURIComponent(entry.slice('metapi_admin_session='.length).trim());
  }
  return '';
}

export async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: { token?: string } }>(
    '/api/auth/session',
    { preHandler: [limitAdminSessionLogin] },
    async (request, reply) => {
      const token = String(request.body?.token || '').trim();
      if (!token) {
        return reply.code(400).send({ success: false, message: '请填写管理员令牌' });
      }
      if (token !== config.authToken) {
        return reply.code(403).send({ success: false, message: '管理员令牌无效' });
      }
      reply.header('Set-Cookie', buildAdminSessionCookie(token));
      return { success: true };
    },
  );

  app.get('/api/auth/session', async (request, reply) => {
    const auth = typeof request.headers.authorization === 'string'
      ? request.headers.authorization.replace(/^Bearer\s+/i, '').trim()
      : '';
    const cookieHeader = typeof request.headers.cookie === 'string' ? request.headers.cookie : '';
    const cookieToken = readAdminSessionCookie(cookieHeader);
    const active = auth === config.authToken || cookieToken === config.authToken;
    if (!active) {
      return reply.code(401).send({ success: false, active: false });
    }
    return { success: true, active: true };
  });

  app.delete('/api/auth/session', async (_, reply) => {
    reply.header('Set-Cookie', buildAdminSessionClearCookie());
    return { success: true };
  });

  // Change admin auth token (requires old token verification)
  app.post<{ Body: { oldToken: string; newToken: string } }>(
    '/api/settings/auth/change',
    { preHandler: [limitAdminTokenChange] },
    async (request, reply) => {
    const { oldToken, newToken } = request.body;

    if (!oldToken || !newToken) {
      return reply.code(400).send({ success: false, message: '请填写所有字段' });
    }

    if (newToken.length < 6) {
      return reply.code(400).send({ success: false, message: '新 Token 至少 6 个字符' });
    }

    if (oldToken !== config.authToken) {
      return reply.code(403).send({ success: false, message: '旧 Token 验证失败' });
    }

    // Save to settings table
    const existing = await db.select().from(schema.settings).where(eq(schema.settings.key, 'auth_token')).get();
    if (existing) {
      await db.update(schema.settings).set({ value: JSON.stringify(newToken) }).where(eq(schema.settings.key, 'auth_token')).run();
    } else {
      await db.insert(schema.settings).values({ key: 'auth_token', value: JSON.stringify(newToken) }).run();
    }

    // Update runtime config
    config.authToken = newToken;
    reply.header('Set-Cookie', buildAdminSessionCookie(newToken));

    try {
      const createdAt = formatUtcSqlDateTime(new Date());
      await db.insert(schema.events).values({
        type: 'token',
        title: '管理员登录令牌已更新',
        message: '管理员登录 Token 已被修改，请使用新 Token 登录。',
        level: 'warning',
        relatedType: 'settings',
        createdAt,
      }).run();
    } catch {}

    return { success: true, message: 'Token 已更新' };
    },
  );

  // Get masked current token (for display)
  app.get('/api/settings/auth/info', async () => {
    const token = config.authToken;
    const masked = token.length > 8
      ? token.slice(0, 4) + '****' + token.slice(-4)
      : '****';
    return { masked, authMode: 'session-cookie' };
  });
}
