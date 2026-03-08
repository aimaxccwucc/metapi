import { type NormalizedFinalResponse, type NormalizedStreamEvent, type ParsedDownstreamChatRequest, type StreamTransformContext } from '../../shared/normalized.js';
import { openAiChatInbound } from './inbound.js';
import { openAiChatOutbound } from './outbound.js';
import { openAiChatStream } from './stream.js';
import { openAiChatUsage } from './usage.js';
import { createOpenAiChatAggregateState, applyOpenAiChatStreamEvent, finalizeOpenAiChatAggregate } from './aggregator.js';

export const openAiChatTransformer = {
  protocol: 'openai/chat' as const,
  inbound: openAiChatInbound,
  outbound: openAiChatOutbound,
  stream: openAiChatStream,
  usage: openAiChatUsage,
  aggregator: {
    createState: createOpenAiChatAggregateState,
    applyEvent: applyOpenAiChatStreamEvent,
    finalize: finalizeOpenAiChatAggregate,
  },
  transformRequest(body: unknown): ReturnType<typeof openAiChatInbound.parse> {
    return openAiChatInbound.parse(body);
  },
  createStreamContext(modelName: string): StreamTransformContext {
    return openAiChatStream.createContext(modelName);
  },
  transformFinalResponse(payload: unknown, modelName: string, fallbackText = ''): NormalizedFinalResponse {
    return openAiChatOutbound.normalizeFinal(payload, modelName, fallbackText);
  },
  transformStreamEvent(payload: unknown, context: StreamTransformContext, modelName: string): NormalizedStreamEvent {
    return openAiChatStream.normalizeEvent(payload, context, modelName);
  },
  serializeStreamEvent(
    event: NormalizedStreamEvent,
    context: StreamTransformContext,
    claudeContext: Parameters<typeof openAiChatStream.serializeEvent>[2],
  ): string[] {
    return openAiChatStream.serializeEvent(event, context, claudeContext);
  },
  serializeDone(
    context: StreamTransformContext,
    claudeContext: Parameters<typeof openAiChatStream.serializeDone>[1],
  ): string[] {
    return openAiChatStream.serializeDone(context, claudeContext);
  },
  serializeFinalResponse(
    normalized: NormalizedFinalResponse,
    usage: Parameters<typeof openAiChatOutbound.serializeFinal>[1],
  ) {
    return openAiChatOutbound.serializeFinal(normalized, usage);
  },
  buildSyntheticChunks(normalized: NormalizedFinalResponse) {
    return openAiChatOutbound.buildSyntheticChunks(normalized);
  },
  pullSseEvents(buffer: string) {
    return openAiChatStream.pullSseEvents(buffer);
  },
};

export type OpenAiChatTransformer = typeof openAiChatTransformer;
export type OpenAiChatParsedRequest = ParsedDownstreamChatRequest;
