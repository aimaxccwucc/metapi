import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
const startBackgroundTaskMock = vi.fn((_options, runner: () => Promise<unknown>) => {
  void runner();
  return { task: { id: 'task-1' }, reused: false };
});

vi.mock('undici', () => ({
  fetch: (...args: unknown[]) => fetchMock(...args),
}));

vi.mock('./backgroundTaskService.js', () => ({
  startBackgroundTask: (...args: unknown[]) => startBackgroundTaskMock(...args),
}));

describe('startupCacheWarmup', () => {
  const originalPort = process.env.PORT;
  const originalListenHost = process.env.LISTEN_HOST;
  const originalAuthToken = process.env.AUTH_TOKEN;

  beforeEach(() => {
    vi.resetModules();
    fetchMock.mockReset();
    startBackgroundTaskMock.mockClear();
    process.env.PORT = '4123';
    process.env.LISTEN_HOST = '0.0.0.0';
    process.env.AUTH_TOKEN = 'warmup-admin-token';
    fetchMock.mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
  });

  afterEach(() => {
    if (originalPort === undefined) delete process.env.PORT;
    else process.env.PORT = originalPort;
    if (originalListenHost === undefined) delete process.env.LISTEN_HOST;
    else process.env.LISTEN_HOST = originalListenHost;
    if (originalAuthToken === undefined) delete process.env.AUTH_TOKEN;
    else process.env.AUTH_TOKEN = originalAuthToken;
  });

  it('warms marketplace and token candidates through localhost with admin auth', async () => {
    const { queueStartupCacheWarmup } = await import('./startupCacheWarmup.js');

    queueStartupCacheWarmup();
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    expect(startBackgroundTaskMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'http://127.0.0.1:4123/api/models/marketplace?includePricing=true',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer warmup-admin-token',
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'http://127.0.0.1:4123/api/models/token-candidates',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer warmup-admin-token',
        }),
      }),
    );
  });
});
