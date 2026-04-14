import { fetch } from 'undici';
import { config } from '../config.js';
import { startBackgroundTask } from './backgroundTaskService.js';

function resolveWarmupBaseUrl(): string {
  const rawHost = String(config.listenHost || '').trim();
  const host = !rawHost || rawHost === '0.0.0.0' || rawHost === '::' || rawHost === '::1'
    ? '127.0.0.1'
    : rawHost;
  return `http://${host}:${config.port}`;
}

async function warmEndpoint(pathname: string): Promise<void> {
  const response = await fetch(`${resolveWarmupBaseUrl()}${pathname}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${config.authToken}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${pathname} warmup failed: HTTP ${response.status}${text ? ` ${text}` : ''}`);
  }
  await response.arrayBuffer();
}

export function queueStartupCacheWarmup(): void {
  startBackgroundTask(
    {
      type: 'system',
      title: '预热模型与路由候选缓存',
      dedupeKey: 'startup-cache-warmup',
      keepMs: 10 * 60_000,
      notifyOnFailure: false,
      successMessage: () => '模型与路由候选缓存预热完成',
      failureMessage: (task) => `模型与路由候选缓存预热失败：${task.error || 'unknown error'}`,
    },
    async () => {
      await warmEndpoint('/api/models/marketplace?includePricing=true');
      await warmEndpoint('/api/models/token-candidates');
      return { success: true };
    },
  );
}
