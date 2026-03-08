import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function readWorkspaceFile(relativePath: string): string {
  return readFileSync(path.resolve(process.cwd(), relativePath), 'utf8');
}

describe('final transformer hard-cut architecture', () => {
  it('keeps shared normalized helpers independent from route chatFormats', () => {
    const sharedNormalized = readWorkspaceFile('src/server/transformers/shared/normalized.ts');

    expect(sharedNormalized).not.toContain("../../routes/proxy/chatFormats.js");
    expect(sharedNormalized).not.toContain("from '../../routes/proxy/chatFormats.js'");
  });

  it('removes normalizeContentText from upstream endpoint compatibility path', () => {
    const upstreamEndpoint = readWorkspaceFile('src/server/routes/proxy/upstreamEndpoint.ts');

    expect(upstreamEndpoint).not.toContain('function normalizeContentText(');
    expect(upstreamEndpoint).not.toContain('normalizeContentText(');
  });

  it('keeps responses protocol shaping out of route-local helpers', () => {
    const responsesRoute = readWorkspaceFile('src/server/routes/proxy/responses.ts');

    expect(responsesRoute).not.toContain('function toResponsesPayload(');
    expect(responsesRoute).not.toContain('function createResponsesStreamState(');
  });

  it('replaces gemini passthrough placeholders with protocol-aware helpers', () => {
    const geminiInbound = readWorkspaceFile('src/server/transformers/gemini/generate-content/inbound.ts');
    const geminiStream = readWorkspaceFile('src/server/transformers/gemini/generate-content/stream.ts');
    const geminiAggregator = readWorkspaceFile('src/server/transformers/gemini/generate-content/aggregator.ts');

    expect(geminiInbound).not.toContain('passthrough');
    expect(geminiStream).not.toContain('passthrough');
    expect(geminiAggregator).not.toContain('parts: unknown[]');
  });
});
