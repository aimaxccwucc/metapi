import { type StreamTransformContext } from '../../shared/normalized.js';
import {
  convertOpenAiBodyToResponsesBody,
  convertResponsesBodyToOpenAiBody,
  normalizeResponsesInputForCompatibility,
  normalizeResponsesMessageContent,
  sanitizeResponsesBodyForProxy,
} from './conversion.js';
import { normalizeResponsesMessageItem } from './compatibility.js';
import {
  type OpenAiResponsesAggregateState,
  completeResponsesStream,
  createOpenAiResponsesAggregateState,
  failResponsesStream,
  serializeConvertedResponsesEvents,
} from './aggregator.js';
import { openAiResponsesOutbound } from './outbound.js';
import { openAiResponsesStream } from './stream.js';
import { openAiResponsesUsage } from './usage.js';

export const openAiResponsesTransformer = {
  protocol: 'openai/responses' as const,
  inbound: {
    normalizeInput: normalizeResponsesInputForCompatibility,
    normalizeMessage: normalizeResponsesMessageItem,
    normalizeContent: normalizeResponsesMessageContent,
    sanitizeProxyBody: sanitizeResponsesBodyForProxy,
    fromOpenAiBody: convertOpenAiBodyToResponsesBody,
    toOpenAiBody: convertResponsesBodyToOpenAiBody,
  },
  outbound: openAiResponsesOutbound,
  stream: openAiResponsesStream,
  usage: openAiResponsesUsage,
  aggregator: {
    createState: createOpenAiResponsesAggregateState,
    serialize: serializeConvertedResponsesEvents,
    complete: completeResponsesStream,
    fail: failResponsesStream,
  },
  transformRequest(body: unknown) {
    return body;
  },
  createStreamContext(modelName: string): StreamTransformContext {
    return openAiResponsesStream.createContext(modelName);
  },
  transformFinalResponse(payload: unknown, modelName: string, fallbackText = '') {
    return openAiResponsesOutbound.normalizeFinal(payload, modelName, fallbackText);
  },
  transformStreamEvent(payload: unknown, context: StreamTransformContext, modelName: string) {
    return openAiResponsesStream.normalizeEvent(payload, context, modelName);
  },
  pullSseEvents(buffer: string) {
    return openAiResponsesStream.pullSseEvents(buffer);
  },
};

export type OpenAiResponsesTransformer = typeof openAiResponsesTransformer;
export type OpenAiResponsesAggregate = OpenAiResponsesAggregateState;
export {
  convertOpenAiBodyToResponsesBody,
  convertResponsesBodyToOpenAiBody,
  normalizeResponsesInputForCompatibility,
  normalizeResponsesMessageContent,
  normalizeResponsesMessageItem,
  sanitizeResponsesBodyForProxy,
};
