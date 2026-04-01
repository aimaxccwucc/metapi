import {
  failureActionOf,
  isTerminalFailure,
  shouldFailover,
  shouldRefreshAuth,
  shouldRetrySameChannel,
} from './retryPolicy.js';
import type { ExecuteInput, ExecuteResult, ProxyConductorDependencies, SelectedChannelLike } from './types.js';
import { recordFailedAttempt, recordSuccessfulAttempt } from './usageHooks.js';

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
          excludeSiteIds.add(Math.trunc(failoverSiteId));
        }
        if (attempts >= maxAttempts) {
          break;
        }
        const next = await this.deps.selectNextChannel(
          input.requestedModel,
          excludeChannelIds,
          input.downstreamPolicy,
          excludeSiteIds,
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
