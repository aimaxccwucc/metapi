import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('proxy route architecture boundaries', () => {
  it('keeps shared protocol helpers out of chat route', () => {
    const source = readSource('./chat.ts');
    expect(source).not.toContain("from './chatFormats.js'");
    expect(source).toContain("from '../../transformers/openai/chat/index.js'");
    expect(source).toContain("from '../../transformers/anthropic/messages/index.js'");
  });
  it('keeps anthropic-specific stream orchestration out of chat route', () => {
    const source = readSource('./chat.ts');
    expect(source).not.toContain('function syncClaudeStreamStateFromRawEvent(');
    expect(source).not.toContain('function serializeRawSseEvent(');
    expect(source).not.toContain('function isClaudeSseEventName(');
  });

  it('keeps responses protocol assembly out of responses route', () => {
    const source = readSource('./responses.ts');
    expect(source).not.toContain('function toResponsesPayload(');
    expect(source).not.toContain('function createResponsesStreamState(');
    expect(source).not.toContain('function convertResponsesBodyToOpenAiBody(');
  });

  it('removes normalizeContentText from upstream endpoint routing', () => {
    const source = readSource('./upstreamEndpoint.ts');
    expect(source).not.toContain('function normalizeContentText(');
    expect(source).not.toContain('normalizeContentText(');
  });

  it('keeps gemini runtime closure in transformer-owned helpers', () => {
    const source = readSource('./gemini.ts');
    expect(source).toContain('serializeAggregateResponse');
    expect(source).toContain('parseSsePayloads');
    expect(source).toContain('aggregator.apply(aggregateState, parsed)');
  });
});
