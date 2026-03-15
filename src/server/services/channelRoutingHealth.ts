import type { RetryFailureCategory } from './proxyRetryPolicy.js';

export type ChannelHealthSnapshot = {
  successCount?: number | null;
  failCount?: number | null;
  totalLatencyMs?: number | null;
  lastFailAt?: string | null;
  consecutiveFailCount?: number | null;
  cooldownLevel?: number | null;
};

export type ChannelHealthScore = {
  multiplier: number;
  summary: string;
  reliabilityFactor: number;
  recencyFactor: number;
  consecutiveFactor: number;
  cooldownFactor: number;
  latencyFactor: number;
  recoveryBonus: number;
};

const RECENT_FAILURE_WINDOW_MS = 10 * 60 * 1000;
const WEIGHTED_BASE_COOLDOWN_MS = [15_000, 15_000, 30_000, 45_000, 75_000, 120_000, 180_000, 300_000];
const MAX_WEIGHTED_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const ROUND_ROBIN_COOLDOWN_MS = [10 * 60 * 1000, 60 * 60 * 1000, 24 * 60 * 60 * 1000];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveLatencyFactor(avgLatencyMs: number | null): number {
  if (!avgLatencyMs || !Number.isFinite(avgLatencyMs) || avgLatencyMs <= 0) return 1;
  if (avgLatencyMs <= 2_000) return 1;
  if (avgLatencyMs <= 5_000) return 0.96;
  if (avgLatencyMs <= 10_000) return 0.9;
  if (avgLatencyMs <= 20_000) return 0.82;
  return 0.72;
}

export function calculateChannelHealthScore(
  channel: ChannelHealthSnapshot,
  nowMs = Date.now(),
): ChannelHealthScore {
  const successCount = Math.max(0, channel.successCount ?? 0);
  const failCount = Math.max(0, channel.failCount ?? 0);
  const totalCount = successCount + failCount;
  const successRatio = totalCount > 0 ? successCount / totalCount : 1;
  const reliabilityFactor = totalCount >= 3
    ? clamp(0.45 + successRatio * 0.7, 0.45, 1.05)
    : 1;

  let recencyFactor = 1;
  if (channel.lastFailAt) {
    const lastFailMs = Date.parse(channel.lastFailAt);
    if (!Number.isNaN(lastFailMs)) {
      const ageMs = Math.max(0, nowMs - lastFailMs);
      if (ageMs < RECENT_FAILURE_WINDOW_MS) {
        recencyFactor = clamp(0.55 + (ageMs / RECENT_FAILURE_WINDOW_MS) * 0.45, 0.55, 1);
      }
    }
  }

  const consecutiveFailCount = Math.max(0, channel.consecutiveFailCount ?? 0);
  const consecutiveFactor = clamp(1 - consecutiveFailCount * 0.18, 0.35, 1);

  const cooldownLevel = Math.max(0, channel.cooldownLevel ?? 0);
  const cooldownFactor = [1, 0.88, 0.68, 0.48][Math.min(cooldownLevel, 3)] ?? 0.48;

  const avgLatencyMs = successCount > 0
    ? Math.max(0, channel.totalLatencyMs ?? 0) / successCount
    : null;
  const latencyFactor = resolveLatencyFactor(avgLatencyMs);

  let recoveryBonus = 1;
  if (successCount >= 5 && failCount === 0) recoveryBonus = 1.05;
  if (successCount >= 20 && failCount <= 1) recoveryBonus = 1.08;

  const multiplier = clamp(
    reliabilityFactor * recencyFactor * consecutiveFactor * cooldownFactor * latencyFactor * recoveryBonus,
    0.08,
    1.1,
  );

  return {
    multiplier,
    summary: `健康=${(multiplier * 100).toFixed(0)}%（成功率=${(successRatio * 100).toFixed(0)}%，近期失败=${(recencyFactor * 100).toFixed(0)}%，连续失败=${(consecutiveFactor * 100).toFixed(0)}%，冷却等级=${(cooldownFactor * 100).toFixed(0)}%，延迟=${(latencyFactor * 100).toFixed(0)}%）`,
    reliabilityFactor,
    recencyFactor,
    consecutiveFactor,
    cooldownFactor,
    latencyFactor,
    recoveryBonus,
  };
}

export function resolveWeightedFailureCooldownMs(
  consecutiveFailCount: number,
  category: RetryFailureCategory,
): number {
  const normalizedConsecutive = Math.max(1, Math.trunc(consecutiveFailCount || 1));
  const base = WEIGHTED_BASE_COOLDOWN_MS[Math.min(normalizedConsecutive - 1, WEIGHTED_BASE_COOLDOWN_MS.length - 1)] || 30_000;

  let cooldownMs = base;
  switch (category) {
    case 'network':
      cooldownMs = base;
      break;
    case 'server':
      cooldownMs = Math.max(Math.round(base * 1.25), 30_000);
      break;
    case 'rate_limit':
      cooldownMs = Math.max(Math.round(base * 2), 90_000);
      break;
    case 'payload_too_large':
      cooldownMs = Math.max(Math.round(base * 2.5), 2 * 60 * 1000);
      break;
    case 'model_unsupported':
      cooldownMs = Math.max(Math.round(base * 3), 15 * 60 * 1000);
      break;
    case 'auth':
      cooldownMs = Math.max(Math.round(base * 4), 30 * 60 * 1000);
      break;
    case 'bad_request':
      cooldownMs = Math.max(Math.round(base * 1.5), 60_000);
      break;
    default:
      cooldownMs = base;
      break;
  }

  return Math.min(cooldownMs, MAX_WEIGHTED_COOLDOWN_MS);
}

export function resolveWeightedFailureCooldownLevel(
  consecutiveFailCount: number,
  category: RetryFailureCategory,
): number {
  if (category === 'auth') return 3;
  if (category === 'model_unsupported') return 2;
  if (category === 'payload_too_large' || category === 'rate_limit') return 1;
  if (consecutiveFailCount >= 6) return 3;
  if (consecutiveFailCount >= 4) return 2;
  if (consecutiveFailCount >= 2) return 1;
  return 0;
}

export function resolveRoundRobinCooldownMs(nextCooldownLevel: number): number {
  const level = clamp(Math.trunc(nextCooldownLevel || 1), 1, ROUND_ROBIN_COOLDOWN_MS.length);
  return ROUND_ROBIN_COOLDOWN_MS[level - 1] || ROUND_ROBIN_COOLDOWN_MS[ROUND_ROBIN_COOLDOWN_MS.length - 1];
}
