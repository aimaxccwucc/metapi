import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import { authRoutes } from './auth.js';

describe('authRoutes session endpoints', () => {
  let app: FastifyInstance;
  let originalAuthToken: string;

  beforeAll(async () => {
    originalAuthToken = config.authToken;
    app = Fastify();
    await app.register(authRoutes);
  });

  beforeEach(() => {
    config.authToken = 'admin-token-test';
  });

  afterAll(async () => {
    config.authToken = originalAuthToken;
    await app.close();
  });

  it('creates an admin session cookie for a valid token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/session',
      payload: { token: 'admin-token-test' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(response.headers['set-cookie']).toContain('metapi_admin_session=admin-token-test');
    expect(response.headers['set-cookie']).toContain('HttpOnly');
  });

  it('reports active session when authenticated by cookie or bearer', async () => {
    const cookieResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: {
        cookie: 'metapi_admin_session=admin-token-test',
      },
    });
    expect(cookieResponse.statusCode).toBe(200);
    expect(cookieResponse.json()).toEqual({ success: true, active: true });

    const bearerResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: {
        authorization: 'Bearer admin-token-test',
      },
    });
    expect(bearerResponse.statusCode).toBe(200);
    expect(bearerResponse.json()).toEqual({ success: true, active: true });
  });

  it('clears session cookie on logout', async () => {
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/auth/session',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ success: true });
    expect(response.headers['set-cookie']).toContain('metapi_admin_session=');
    expect(response.headers['set-cookie']).toContain('Max-Age=0');
  });

  it('returns 401 when session is missing or invalid', async () => {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
    });
    expect(missing.statusCode).toBe(401);
    expect(missing.json()).toEqual({ success: false, active: false });

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: {
        cookie: 'metapi_admin_session=wrong-token',
      },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json()).toEqual({ success: false, active: false });
  });
});
