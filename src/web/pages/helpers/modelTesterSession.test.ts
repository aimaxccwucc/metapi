import { describe, expect, it } from 'vitest';
import {
  DEBUG_TABS,
  DEFAULT_INPUTS,
  DEFAULT_MODE_STATE,
  DEFAULT_PARAMETER_ENABLED,
  MODEL_TESTER_SESSION_VERSION,
  MESSAGE_STATUS,
  buildApiPayload,
  buildEmbeddingsRequestEnvelope,
  buildRawProxyRequestEnvelope,
  buildSearchRequestEnvelope,
  collectModelTesterModelNames,
  countConversationTurns,
  filterModelTesterModelNames,
  parseCustomRequestBody,
  parseModelTesterSession,
  serializeModelTesterSession,
  syncMessagesToCustomRequestBody,
  toApiMessages,
  type ModelTesterSessionState,
} from './modelTesterSession.js';

describe('modelTesterSession', () => {
  it('counts only user messages as turns', () => {
    const turns = countConversationTurns([
      { id: '1', role: 'user', content: 'hello', createAt: 1 },
      { id: '2', role: 'assistant', content: 'hi', createAt: 2 },
      { id: '3', role: 'system', content: 'meta', createAt: 3 },
      { id: '4', role: 'user', content: 'again', createAt: 4 },
    ]);
    expect(turns).toBe(2);
  });

  it('serializes and parses full playground session state', () => {
    const state: ModelTesterSessionState = {
      version: MODEL_TESTER_SESSION_VERSION,
      input: 'draft',
      inputs: {
        ...DEFAULT_INPUTS,
        mode: 'search',
        protocol: 'gemini',
        targetFormat: 'gemini',
        model: 'gemini-2.5-pro',
        systemPrompt: 'be concise',
        temperature: 0.6,
        top_p: 0.9,
        max_tokens: 2048,
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        seed: 12,
        stream: true,
        searchMaxResults: 7,
      },
      parameterEnabled: {
        ...DEFAULT_PARAMETER_ENABLED,
        max_tokens: true,
        seed: true,
      },
      messages: [
        { id: 'm1', role: 'user', content: 'hello', createAt: 1 },
        { id: 'm2', role: 'assistant', content: 'hi', createAt: 2, status: MESSAGE_STATUS.COMPLETE },
      ],
      pendingPayload: {
        method: 'POST',
        path: '/v1/search',
        requestKind: 'json',
        stream: false,
        jobMode: false,
        rawMode: false,
        jsonBody: { model: '__search', query: 'hello', max_results: 7 },
      },
      pendingJobId: 'job-1',
      customRequestMode: true,
      customRequestBody: '{"model":"gemini-2.5-pro","contents":[]}',
      showDebugPanel: true,
      activeDebugTab: DEBUG_TABS.REQUEST,
      modeState: {
        ...DEFAULT_MODE_STATE,
        searchQuery: 'hello',
        searchAllowedDomains: 'openai.com, google.com',
      },
    };

    const serialized = serializeModelTesterSession(state);
    const restored = parseModelTesterSession(serialized);

    expect(restored).toEqual(state);
  });

  it('supports parsing legacy session format into conversation/openai defaults', () => {
    const restored = parseModelTesterSession(JSON.stringify({
      model: 'gpt-4o',
      temperature: 0.5,
      input: 'legacy',
      messages: [{ role: 'user', content: 'hello' }],
      pendingPayload: null,
    }));

    expect(restored?.inputs.model).toBe('gpt-4o');
    expect(restored?.inputs.protocol).toBe('openai');
    expect(restored?.inputs.mode).toBe('conversation');
    expect(restored?.inputs.temperature).toBe(0.5);
    expect(restored?.parameterEnabled).toEqual(DEFAULT_PARAMETER_ENABLED);
  });

  it('returns null for malformed or missing session payload', () => {
    expect(parseModelTesterSession(null)).toBeNull();
    expect(parseModelTesterSession('not-json')).toBeNull();
    expect(parseModelTesterSession(JSON.stringify({ messages: [] }))).toBeNull();
  });

  it('drops loading assistant placeholders when building API payload messages', () => {
    const payloadMessages = toApiMessages([
      { id: '1', role: 'user', content: 'hello', createAt: 1 },
      { id: '2', role: 'assistant', content: '', createAt: 2, status: MESSAGE_STATUS.LOADING },
      { id: '3', role: 'assistant', content: 'done', createAt: 3, status: MESSAGE_STATUS.COMPLETE },
    ]);

    expect(payloadMessages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
    ]);
  });

  it('builds conversation payload as generic proxy envelope', () => {
    const payload = buildApiPayload(
      [{ id: 'u1', role: 'user', content: 'hello', createAt: 1 }],
      {
        ...DEFAULT_INPUTS,
        model: 'gpt-4o-mini',
        protocol: 'openai',
        systemPrompt: 'You are helpful.',
        temperature: 0.5,
        top_p: 0.8,
        max_tokens: 200,
        frequency_penalty: 0.2,
        presence_penalty: 0.3,
        seed: 42,
        stream: true,
      },
      {
        temperature: true,
        top_p: false,
        max_tokens: true,
        frequency_penalty: true,
        presence_penalty: false,
        seed: true,
      },
    );

    expect(payload).toEqual({
      method: 'POST',
      path: '/v1/chat/completions',
      requestKind: 'json',
      stream: true,
      jobMode: false,
      rawMode: false,
      jsonBody: {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'hello' },
        ],
        stream: true,
        temperature: 0.5,
        max_tokens: 200,
        frequency_penalty: 0.2,
        seed: 42,
      },
    });
  });

  it('builds gemini conversation envelope with generationConfig', () => {
    const payload = buildApiPayload(
      [{ id: 'u1', role: 'user', content: 'hello', createAt: 1 }],
      {
        ...DEFAULT_INPUTS,
        model: 'gemini-2.5-pro',
        protocol: 'gemini',
        systemPrompt: 'system text',
        temperature: 0.2,
        max_tokens: 300,
      },
      {
        ...DEFAULT_PARAMETER_ENABLED,
        max_tokens: true,
      },
    );

    expect(payload.path).toBe('/v1beta/models/gemini-2.5-pro:generateContent');
    expect(payload.jsonBody).toEqual({
      systemInstruction: { parts: [{ text: 'system text' }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 300 },
    });
  });

  it('builds embeddings and search envelopes', () => {
    expect(buildEmbeddingsRequestEnvelope('hello', { ...DEFAULT_INPUTS, model: 'text-embedding-3-large' })).toEqual({
      method: 'POST',
      path: '/v1/embeddings',
      requestKind: 'json',
      stream: false,
      jobMode: false,
      rawMode: false,
      jsonBody: {
        model: 'text-embedding-3-large',
        input: 'hello',
      },
    });

    expect(buildSearchRequestEnvelope(
      { ...DEFAULT_INPUTS, model: '__search', searchMaxResults: 3 },
      { ...DEFAULT_MODE_STATE, searchQuery: 'what is ai', searchAllowedDomains: 'openai.com', searchBlockedDomains: 'example.com' },
    )).toEqual({
      method: 'POST',
      path: '/v1/search',
      requestKind: 'json',
      stream: false,
      jobMode: false,
      rawMode: false,
      jsonBody: {
        model: '__search',
        query: 'what is ai',
        max_results: 3,
        allowed_domains: ['openai.com'],
        blocked_domains: ['example.com'],
      },
    });
  });

  it('parses raw custom body without dropping unknown fields', () => {
    const parsed = parseCustomRequestBody('{"model":"gpt-5","include":["foo"],"reasoning":{"effort":"high"}}');
    expect(parsed).toEqual({
      model: 'gpt-5',
      include: ['foo'],
      reasoning: { effort: 'high' },
    });
  });

  it('syncs messages into custom request body while preserving unknown fields', () => {
    const synced = syncMessagesToCustomRequestBody(
      '{"model":"legacy","metadata":{"trace":"keep"}}',
      [{ id: '1', role: 'user', content: 'new', createAt: 1 }],
      { ...DEFAULT_INPUTS, model: 'gpt-4o', protocol: 'responses', systemPrompt: 'system' },
    );

    expect(JSON.parse(synced)).toEqual({
      model: 'gpt-4o',
      metadata: { trace: 'keep' },
      input: 'new',
      instructions: 'system',
      stream: false,
      temperature: 0.7,
    });
  });

  it('builds raw proxy envelope for passthrough mode', () => {
    expect(buildRawProxyRequestEnvelope('POST', '/v1/responses', 'json', '{"foo":1}', { stream: true })).toEqual({
      method: 'POST',
      path: '/v1/responses',
      requestKind: 'json',
      stream: true,
      jobMode: false,
      rawMode: true,
      rawJsonText: '{"foo":1}',
    });
  });

  it('merges marketplace models with exact enabled route models for tester options', () => {
    const modelNames = collectModelTesterModelNames(
      {
        models: [
          { name: 'gpt-4o-mini' },
          { name: 'bge-large-en-v1.5' },
        ],
      },
      [
        { modelPattern: 'BAAI/bge-large-en-v1.5', enabled: true },
        { modelPattern: 'claude-*', enabled: true },
        { modelPattern: 'gemini-2.5-pro', enabled: false },
      ],
    );

    expect(modelNames).toEqual([
      'gpt-4o-mini',
      'bge-large-en-v1.5',
      'BAAI/bge-large-en-v1.5',
    ]);
  });

  it('filters models by keyword and keeps best matches first', () => {
    const filtered = filterModelTesterModelNames(
      [
        'BAAI/bge-large-en-v1.5',
        'text-embedding-3-large',
        'bge-m3',
      ],
      'bge',
    );

    expect(filtered).toEqual([
      'bge-m3',
      'BAAI/bge-large-en-v1.5',
    ]);
  });
});
