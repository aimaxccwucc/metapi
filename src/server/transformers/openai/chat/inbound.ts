import { parseDownstreamChatRequest } from '../../shared/normalized.js';
import { extractChatRequestMetadata } from './helpers.js';
import type { OpenAiChatParsedRequest } from './model.js';

export const openAiChatInbound = {
  parse(body: unknown): { value?: OpenAiChatParsedRequest; error?: { statusCode: number; payload: unknown } } {
    const parsed = parseDownstreamChatRequest(body, 'openai') as {
      value?: OpenAiChatParsedRequest;
      error?: { statusCode: number; payload: unknown };
    };
    if (!parsed.value) return parsed;

    parsed.value = {
      ...parsed.value,
      requestMetadata: extractChatRequestMetadata(body),
    };
    return parsed;
  },
};
