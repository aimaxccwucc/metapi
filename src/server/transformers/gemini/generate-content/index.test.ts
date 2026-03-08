import { describe, expect, it } from 'vitest';

import {
  geminiGenerateContentTransformer,
  reasoningEffortToGeminiThinkingConfig,
  geminiThinkingConfigToReasoning,
} from './index.js';
import { extractGeminiUsage } from './usage.js';
import { serializeGeminiAggregateResponse, extractResponseMetadata } from './outbound.js';

describe('geminiGenerateContentTransformer.inbound', () => {
  it('preserves native Gemini request fields through normalization', () => {
    const body = geminiGenerateContentTransformer.inbound.normalizeRequest({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'hello' }],
        },
      ],
      systemInstruction: {
        role: 'system',
        parts: [{ text: 'system prompt' }],
      },
      cachedContent: 'cached/abc',
      generationConfig: {
        responseModalities: ['TEXT'],
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
          },
        },
        thinkingConfig: {
          thinkingBudget: 512,
        },
        imageConfig: {
          aspectRatio: '1:1',
        },
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'lookup',
              description: 'find facts',
            },
          ],
        },
        { googleSearch: {} },
        { urlContext: {} },
        { codeExecution: {} },
      ],
    });

    expect(body).toEqual({
      contents: [
        {
          role: 'user',
          parts: [{ text: 'hello' }],
        },
      ],
      systemInstruction: {
        role: 'system',
        parts: [{ text: 'system prompt' }],
      },
      cachedContent: 'cached/abc',
      generationConfig: {
        responseModalities: ['TEXT'],
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
          },
        },
        thinkingConfig: {
          thinkingBudget: 512,
        },
        imageConfig: {
          aspectRatio: '1:1',
        },
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'lookup',
              description: 'find facts',
            },
          ],
        },
        { googleSearch: {} },
        { urlContext: {} },
        { codeExecution: {} },
      ],
    });
  });
});

describe('geminiGenerateContentTransformer.aggregator', () => {
  it('collects grounding metadata, citations, thought signatures, and usage from streamed chunks', () => {
    const state = geminiGenerateContentTransformer.aggregator.createState();

    geminiGenerateContentTransformer.aggregator.apply(state, [
      {
        candidates: [
          {
            groundingMetadata: { webSearchQueries: ['cat'] },
            citationMetadata: { citations: [{ uri: 'https://example.com' }] },
            content: {
              parts: [
                { text: 'hello', thoughtSignature: 'sig-1' },
              ],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 4,
          totalTokenCount: 14,
          cachedContentTokenCount: 3,
          thoughtsTokenCount: 2,
        },
      },
    ]);

    expect(state.groundingMetadata).toEqual([{ webSearchQueries: ['cat'] }]);
    expect(state.citations).toEqual([{ citations: [{ uri: 'https://example.com' }] }]);
    expect(state.thoughtSignatures).toEqual(['sig-1']);
    expect(state.usage).toEqual({
      promptTokenCount: 10,
      candidatesTokenCount: 4,
      totalTokenCount: 14,
      cachedContentTokenCount: 3,
      thoughtsTokenCount: 2,
    });
  });

  it('serializes aggregate state back into Gemini response semantics', () => {
    const state = geminiGenerateContentTransformer.aggregator.createState();
    geminiGenerateContentTransformer.aggregator.apply(state, {
      responseId: 'resp-1',
      modelVersion: 'gemini-2.5-pro',
      candidates: [
        {
          groundingMetadata: { webSearchQueries: ['cat'] },
          citationMetadata: { citations: [{ uri: 'https://example.com' }] },
          content: {
            parts: [
              { text: 'thinking', thought: true, thoughtSignature: 'sig-1' },
              { text: 'answer' },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
        cachedContentTokenCount: 3,
        thoughtsTokenCount: 2,
      },
    });

    const response = serializeGeminiAggregateResponse(state);
    expect(response).toEqual({
      responseId: 'resp-1',
      modelVersion: 'gemini-2.5-pro',
      candidates: [
        {
          index: 0,
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [
              { text: 'thinking', thought: true, thoughtSignature: 'sig-1' },
              { text: 'answer' },
            ],
          },
          groundingMetadata: { webSearchQueries: ['cat'] },
          citationMetadata: { citations: [{ uri: 'https://example.com' }] },
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
        cachedContentTokenCount: 3,
        thoughtsTokenCount: 2,
      },
    });

    expect(extractResponseMetadata(state)).toEqual({
      citations: [{ citations: [{ uri: 'https://example.com' }] }],
      groundingMetadata: [{ webSearchQueries: ['cat'] }],
      thoughtSignature: 'sig-1',
      thoughtSignatures: ['sig-1'],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        totalTokenCount: 14,
        cachedContentTokenCount: 3,
        thoughtsTokenCount: 2,
      },
    });
  });

  it('preserves multiple candidate streams instead of collapsing them into one candidate', () => {
    const state = geminiGenerateContentTransformer.aggregator.createState();
    geminiGenerateContentTransformer.aggregator.apply(state, {
      responseId: 'resp-multi',
      modelVersion: 'gemini-2.5-pro',
      candidates: [
        {
          index: 0,
          content: {
            parts: [{ text: 'candidate-a' }],
          },
          finishReason: 'STOP',
          groundingMetadata: { webSearchQueries: ['a'] },
          citationMetadata: { citations: [{ uri: 'https://a.example.com' }] },
        },
        {
          index: 1,
          content: {
            parts: [{ text: 'candidate-b' }],
          },
          finishReason: 'MAX_TOKENS',
          groundingMetadata: { webSearchQueries: ['b'] },
          citationMetadata: { citations: [{ uri: 'https://b.example.com' }] },
        },
      ],
    });

    expect(serializeGeminiAggregateResponse(state)).toEqual({
      responseId: 'resp-multi',
      modelVersion: 'gemini-2.5-pro',
      candidates: [
        {
          index: 0,
          finishReason: 'STOP',
          content: {
            role: 'model',
            parts: [{ text: 'candidate-a' }],
          },
          groundingMetadata: { webSearchQueries: ['a'] },
          citationMetadata: { citations: [{ uri: 'https://a.example.com' }] },
        },
        {
          index: 1,
          finishReason: 'MAX_TOKENS',
          content: {
            role: 'model',
            parts: [{ text: 'candidate-b' }],
          },
          groundingMetadata: { webSearchQueries: ['b'] },
          citationMetadata: { citations: [{ uri: 'https://b.example.com' }] },
        },
      ],
    });
  });

  it('merges preserved request semantics into extracted metadata when provided', () => {
    const metadata = extractResponseMetadata(
      {
        candidates: [
          {
            groundingMetadata: { webSearchQueries: ['cat'] },
            citationMetadata: { citations: [{ uri: 'https://example.com' }] },
            content: {
              parts: [{ text: 'answer', thoughtSignature: 'sig-1' }],
            },
          },
        ],
      },
      {
        systemInstruction: { role: 'system', parts: [{ text: 'system prompt' }] },
        cachedContent: 'cached/abc',
        generationConfig: {
          responseModalities: ['TEXT'],
          responseSchema: { type: 'object' },
          responseMimeType: 'application/json',
        },
        tools: [
          { googleSearch: {} },
          { urlContext: {} },
          { codeExecution: {} },
        ],
      },
    );

    expect(metadata.systemInstruction).toEqual({ role: 'system', parts: [{ text: 'system prompt' }] });
    expect(metadata.cachedContent).toBe('cached/abc');
    expect(metadata.responseModalities).toEqual(['TEXT']);
    expect(metadata.responseSchema).toEqual({ type: 'object' });
    expect(metadata.responseMimeType).toBe('application/json');
    expect(metadata.tools).toEqual([
      { googleSearch: {} },
      { urlContext: {} },
      { codeExecution: {} },
    ]);
  });
});

describe('extractGeminiUsage', () => {
  it('maps cached and thought token counts into normalized usage', () => {
    expect(extractGeminiUsage({
      usageMetadata: {
        promptTokenCount: 11,
        candidatesTokenCount: 7,
        totalTokenCount: 18,
        cachedContentTokenCount: 5,
        thoughtsTokenCount: 3,
      },
    })).toEqual({
      promptTokens: 11,
      completionTokens: 10,
      totalTokens: 18,
      cachedTokens: 5,
      reasoningTokens: 3,
    });
  });
});

describe('Gemini reasoning mapping', () => {
  it('supports explicit none reasoning effort and maps it back from thinking config', () => {
    expect(reasoningEffortToGeminiThinkingConfig('gemini-3-5m', 'none')).toEqual({
      thinkingLevel: 'none',
    });

    expect(geminiThinkingConfigToReasoning({
      thinkingLevel: 'none',
    })).toEqual({
      reasoningEffort: 'none',
      reasoningBudget: 0,
    });
  });

  it('uses thinkingLevel for Gemini 3 models when reasoning effort is provided', () => {
    expect(reasoningEffortToGeminiThinkingConfig('gemini-3-5m', 'high')).toEqual({
      thinkingLevel: 'high',
    });
  });

  it('uses thinkingBudget for non-Gemini 3 models when reasoning effort is provided', () => {
    expect(reasoningEffortToGeminiThinkingConfig('gemini-2.5-flash', 'medium')).toEqual({
      thinkingBudget: 8192,
    });
  });

  it('maps Gemini thinking config back to normalized reasoning hints', () => {
    expect(geminiThinkingConfigToReasoning({
      thinkingLevel: 'medium',
    })).toEqual({
      reasoningEffort: 'medium',
      reasoningBudget: 8192,
    });

    expect(geminiThinkingConfigToReasoning({
      thinkingBudget: 512,
    })).toEqual({
      reasoningEffort: 'low',
      reasoningBudget: 512,
    });
  });
});

describe('geminiGenerateContentTransformer.stream', () => {
  it('aggregates SSE payloads and JSON-array payloads to the same final semantics', () => {
    const chunks = [
      {
        responseId: 'resp-1',
        modelVersion: 'gemini-2.5-pro',
        candidates: [
          {
            groundingMetadata: { webSearchQueries: ['cat'] },
            citationMetadata: { citations: [{ uri: 'https://example.com' }] },
            content: {
              parts: [
                { text: 'thinking', thought: true, thoughtSignature: 'sig-1' },
              ],
            },
            finishReason: '',
          },
        ],
      },
      {
        responseId: 'resp-1',
        modelVersion: 'gemini-2.5-pro',
        candidates: [
          {
            groundingMetadata: { webSearchQueries: ['cat'] },
            citationMetadata: { citations: [{ uri: 'https://example.com' }] },
            content: {
              parts: [
                { text: 'answer' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 4,
          totalTokenCount: 14,
          cachedContentTokenCount: 3,
          thoughtsTokenCount: 2,
        },
      },
    ];

    const ssePayload = chunks
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join('');

    const sseParsed = geminiGenerateContentTransformer.stream.parseSsePayloads(ssePayload);
    const sseState = geminiGenerateContentTransformer.aggregator.createState();
    for (const payload of sseParsed.events) {
      geminiGenerateContentTransformer.aggregator.apply(sseState, payload);
    }

    const jsonState = geminiGenerateContentTransformer.aggregator.createState();
    for (const payload of geminiGenerateContentTransformer.stream.parseJsonArrayPayload(chunks)) {
      geminiGenerateContentTransformer.aggregator.apply(jsonState, payload);
    }

    expect(serializeGeminiAggregateResponse(sseState)).toEqual(
      serializeGeminiAggregateResponse(jsonState),
    );
    expect(extractResponseMetadata(sseState)).toEqual(
      extractResponseMetadata(jsonState),
    );
    expect(extractGeminiUsage(sseState)).toEqual(
      extractGeminiUsage(jsonState),
    );
  });
});
