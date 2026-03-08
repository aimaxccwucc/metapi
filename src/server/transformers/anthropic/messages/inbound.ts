import { parseDownstreamChatRequest, type ParsedDownstreamChatRequest } from '../../shared/normalized.js';
import { validateAnthropicMessagesBody } from './conversion.js';

export const anthropicMessagesInbound = {
  parse(body: unknown): { value?: ParsedDownstreamChatRequest; error?: { statusCode: number; payload: unknown } } {
    const parsed = parseDownstreamChatRequest(body, 'claude');
    if (parsed.error || !parsed.value) return parsed;

    const originalBody = parsed.value.claudeOriginalBody;
    if (originalBody) {
      const validation = validateAnthropicMessagesBody(originalBody);
      if (validation.error) {
        return { error: validation.error };
      }
      if (validation.sanitizedBody) {
        parsed.value.claudeOriginalBody = validation.sanitizedBody;
      }
    }

    return parsed;
  },
};
