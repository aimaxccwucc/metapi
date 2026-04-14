import {
  failureActionOf,
  isTerminalFailure,
  shouldFailover,
  shouldRefreshAuth,
  shouldRetrySameChannel,
} from './retryPolicy.js';
import { classifyProxyFailureCategory } from '../../services/proxyRetryPolicy.js';
import type { ExecuteInput, ExecuteResult, ProxyConductorDependencies, SelectedChannelLike } from './types.js';
import { recordFailedAttempt, recordSuccessfulAttempt } from './usageHooks.js';

const STREAM_TERMINAL_CATEGORIES = new Set(['auth', 'model_unsupported', 'payload_too_large', 'bad_request']);

function shouldDelaySiteExclusion(
  failure: {
    status?: number;
    rawErrorText?: string;
  },
): boolean {
  const status = typeof failure.status === 'number' && Number.isFinite(failure.status)
    ? Math.trunc(failure.status)
    : 0;
  const text = (failure.rawErrorText || '').trim();
  if (/no\s+available\s+channel\s+for\s+model|no\s+available\s+providers|under\s+group\s+.+\(distributor\)|分组\s*.+\s*无可用渠道|无可用渠道（distributor）|billing\s+service\s+temporarily\s+unavailable|偷偷倒闭/i.test(text)) {
    return false;
  }
  if (/blocked_invalid_request/i.test(text)) {
    return false;
  }
  if (/empty\s+content/i.test(text)) {
    return false;
  }
  if (/upstream\s+timeout\s+after\s+4000ms/i.test(text)) {
    return false;
  }
  if (/auth_unavailable|no\s+auth\s+available/i.test(text)) {
    return false;
  }
  if (/cloudflare\s+502|bad\s+gateway|service\s+temporarily\s+unavailable|system\s+disk\s+overloaded/i.test(text)) {
    return false;
  }
  if (/model_cooldown|cooling\s+down|all\s+credentials\s+for\s+model/i.test(text)) {
    return false;
  }
  const normalizedText = text.toLowerCase();
  if (status >= 500) return true;
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  return /timeout|timed?\s*out|connection\s+reset|connection\s+refused|econnreset|econnrefused|rate\s+limit|too\s+many\s+requests|quota/i
    .test(normalizedText);
}

export class DefaultProxyConductor {
  constructor(private readonly deps: ProxyConductorDependencies) {}

  async previewSelectedChannel(requestedModel: string, downstreamPolicy?: unknown): Promise<SelectedChannelLike | null> {
    if (this.deps.previewSelectedChannel) {
      return this.deps.previewSelectedChannel(requestedModel, downstreamPolicy);
    }
    return null;
  }

  async execute(input: ExecuteInput): Promise<ExecuteResult> {
    const excludeChannelIds: number[] = [];
    const excludeSiteIds = new Set<number>();
    const failoverSiteAttempts = new Map<number, number>();
    const maxAttempts = Math.max(1, Math.trunc(input.maxAttempts ?? 1));
    let attempts = 0;
    let lastFailure: {
      status?: number;
      rawErrorText?: string;
      retryAfterHeader?: string | null;
      retryAfterMs?: number | null;
    } | null = null;

    await input.onBeforeInitialSelect?.();
    let selected = await this.deps.selectChannel(input.requestedModel, input.downstreamPolicy);
    if (!selected && input.refreshSelection) {
      selected = await input.refreshSelection();
    }
    if (!selected) {
      await input.onNoChannel?.({ attempts });
      return {
        ok: false,
        reason: 'no_channel',
        attempts,
      };
    }

    while (selected && attempts < maxAttempts) {
      const result = await input.attempt({
        selected,
        attemptIndex: attempts,
        excludeChannelIds: [...excludeChannelIds],
        excludeSiteIds: [...excludeSiteIds],
        maxAttempts,
      });
      attempts += 1;

      if (result.ok) {
        await recordSuccessfulAttempt(this.deps, selected.channel.id, {
          latencyMs: result.latencyMs ?? null,
          cost: result.cost ?? null,
        });
        return {
          ok: true,
          selected,
          response: result.response,
          attempts,
        };
      }

      const action = failureActionOf(result);
      lastFailure = {
        status: result.status,
        rawErrorText: result.rawErrorText,
        retryAfterHeader: result.retryAfterHeader ?? null,
        retryAfterMs: result.retryAfterMs ?? null,
      };
      await recordFailedAttempt(this.deps, selected.channel.id, {
        ...lastFailure,
      });

      if (isTerminalFailure(action)) {
        await input.onTerminalFailure?.(selected, {
          ...lastFailure,
        });
        return {
          ok: false,
          reason: 'terminal',
          selected,
          status: result.status,
          rawErrorText: result.rawErrorText,
          ...(result.retryAfterHeader != null ? { retryAfterHeader: result.retryAfterHeader } : {}),
          ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
          attempts,
        };
      }

      if (result.hasStreamedCompletionTokens) {
        const category = classifyProxyFailureCategory(result.status, result.rawErrorText);
        if (STREAM_TERMINAL_CATEGORIES.has(category)) {
          await input.onTerminalFailure?.(selected, {
            ...lastFailure,
          });
          return {
            ok: false,
            reason: 'terminal',
            selected,
            status: result.status,
            rawErrorText: result.rawErrorText,
            ...(result.retryAfterHeader != null ? { retryAfterHeader: result.retryAfterHeader } : {}),
            ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
            attempts,
          };
        }
      }

      if (shouldRetrySameChannel(action) && attempts < maxAttempts) {
        continue;
      }

      if (shouldRefreshAuth(action) && this.deps.refreshAuth) {
        const refreshed = await this.deps.refreshAuth(selected, {
          ...lastFailure,
        });
        if (refreshed && attempts < maxAttempts) {
          selected = refreshed;
          continue;
        }
      }

      if (shouldFailover(action)) {
        excludeChannelIds.push(selected.channel.id);
        const failoverSiteId = input.getFailoverSiteId?.(selected, {
          ...lastFailure,
        });
        if (typeof failoverSiteId === 'number' && Number.isFinite(failoverSiteId)) {
          const normalizedSiteId = Math.trunc(failoverSiteId);
          const nextSiteAttempts = (failoverSiteAttempts.get(normalizedSiteId) ?? 0) + 1;
          failoverSiteAttempts.set(normalizedSiteId, nextSiteAttempts);
          const delaySiteExclusion = shouldDelaySiteExclusion(lastFailure);
          if (!delaySiteExclusion || nextSiteAttempts >= 2) {
            excludeSiteIds.add(normalizedSiteId);
          }
        }
        if (attempts >= maxAttempts) {
          break;
        }
        const next = await this.deps.selectNextChannel(
          input.requestedModel,
          [...excludeChannelIds],
          input.downstreamPolicy,
          new Set(excludeSiteIds),
        );
        if (!next) {
          await input.onNoChannel?.({ attempts });
          return {
            ok: false,
            reason: 'failed',
            selected,
            status: result.status,
            rawErrorText: result.rawErrorText,
            ...(result.retryAfterHeader != null ? { retryAfterHeader: result.retryAfterHeader } : {}),
            ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
            attempts,
          };
        }
        selected = next;
        continue;
      }

      return {
        ok: false,
        reason: 'failed',
        selected,
        status: result.status,
        rawErrorText: result.rawErrorText,
        ...(result.retryAfterHeader != null ? { retryAfterHeader: result.retryAfterHeader } : {}),
        ...(result.retryAfterMs != null ? { retryAfterMs: result.retryAfterMs } : {}),
        attempts,
      };
    }

    return {
      ok: false,
      reason: 'failed',
      selected,
      status: lastFailure?.status,
      rawErrorText: lastFailure?.rawErrorText,
      ...(lastFailure?.retryAfterHeader != null ? { retryAfterHeader: lastFailure.retryAfterHeader } : {}),
      ...(lastFailure?.retryAfterMs != null ? { retryAfterMs: lastFailure.retryAfterMs } : {}),
      attempts,
    };
  }
}
