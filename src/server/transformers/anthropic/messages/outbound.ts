import { normalizeUpstreamFinalResponse, serializeFinalResponse, type NormalizedFinalResponse } from '../../shared/normalized.js';

export const anthropicMessagesOutbound = {
  normalizeFinal(payload: unknown, modelName: string, fallbackText = ''): NormalizedFinalResponse {
    return normalizeUpstreamFinalResponse(payload, modelName, fallbackText);
  },
  serializeFinal(normalized: NormalizedFinalResponse, usage?: unknown) {
    return serializeFinalResponse('claude', normalized, usage as any);
  },
};
