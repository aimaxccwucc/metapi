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
      await recordFailedAttempt(this.deps, selected.channel.id, {
        status: result.status,
        rawErrorText: result.rawErrorText,
      });

      if (isTerminalFailure(action)) {
        await input.onTerminalFailure?.(selected, {
          status: result.status,
          rawErrorText: result.rawErrorText,
        });
        return {
          ok: false,
          reason: 'terminal',
          selected,
          status: result.status,
          rawErrorText: result.rawErrorText,
          attempts,
        };
      }

      if (shouldRetrySameChannel(action) && attempts < maxAttempts) {
        continue;
      }

      if (shouldRefreshAuth(action) && this.deps.refreshAuth) {
        const refreshed = await this.deps.refreshAuth(selected, {
          status: result.status,
          rawErrorText: result.rawErrorText,
        });
        if (refreshed && attempts < maxAttempts) {
          selected = refreshed;
          continue;
        }
      }

      if (shouldFailover(action)) {
        excludeChannelIds.push(selected.channel.id);
        const failoverSiteId = input.getFailoverSiteId?.(selected, {
          status: result.status,
          rawErrorText: result.rawErrorText,
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
        attempts,
      };
    }

    return {
      ok: false,
      reason: 'failed',
      selected,
      attempts,
    };
  }
}
