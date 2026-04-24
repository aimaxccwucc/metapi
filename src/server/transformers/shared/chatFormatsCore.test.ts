import { describe, expect, it } from 'vitest';

import { createStreamTransformContext, normalizeUpstreamStreamEvent } from './chatFormatsCore.js';

describe('chatFormatsCore inline think parsing', () => {
  it('tracks split think tags across stream chunks', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      id: 'chatcmpl-split-think',
      model: 'gpt-test',
      choices: [{
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null,
      }],
    }, context, 'gpt-test')).toMatchObject({
      role: 'assistant',
    });

    const openingFragment = normalizeUpstreamStreamEvent({
      id: 'chatcmpl-split-think',
      model: 'gpt-test',
      choices: [{
        index: 0,
        delta: { content: '<thin' },
        finish_reason: null,
      }],
    }, context, 'gpt-test');
    expect(openingFragment.contentDelta).toBeUndefined();
    expect(openingFragment.reasoningDelta).toBeUndefined();

    expect(normalizeUpstreamStreamEvent({
      id: 'chatcmpl-split-think',
      model: 'gpt-test',
      choices: [{
        index: 0,
        delta: { content: 'k>plan ' },
        finish_reason: null,
      }],
    }, context, 'gpt-test')).toMatchObject({
      reasoningDelta: 'plan ',
    });

    expect(normalizeUpstreamStreamEvent({
      id: 'chatcmpl-split-think',
      model: 'gpt-test',
      choices: [{
        index: 0,
        delta: { content: 'quietly</th' },
        finish_reason: null,
      }],
    }, context, 'gpt-test')).toMatchObject({
      reasoningDelta: 'quietly',
    });

    expect(normalizeUpstreamStreamEvent({
      id: 'chatcmpl-split-think',
      model: 'gpt-test',
      choices: [{
        index: 0,
        delta: { content: 'ink>visible answer' },
        finish_reason: null,
      }],
    }, context, 'gpt-test')).toMatchObject({
      contentDelta: 'visible answer',
    });
  });

  it('does not duplicate responses text when done events replay the full message content', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_text.delta',
      output_index: 0,
      delta: 'hello',
    }, context, 'gpt-test')).toMatchObject({
      contentDelta: 'hello',
    });

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_text.done',
      output_index: 0,
      text: 'hello',
    }, context, 'gpt-test')).toEqual({});

    expect(normalizeUpstreamStreamEvent({
      type: 'response.content_part.done',
      output_index: 0,
      part: {
        type: 'output_text',
        text: 'hello',
      },
    }, context, 'gpt-test')).toEqual({});

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        type: 'message',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    }, context, 'gpt-test')).toEqual({});
  });

  it('keeps only the missing suffix when responses done events include the full accumulated text', () => {
    const context = createStreamTransformContext('gpt-test');

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_text.delta',
      output_index: 0,
      delta: 'hel',
    }, context, 'gpt-test')).toMatchObject({
      contentDelta: 'hel',
    });

    expect(normalizeUpstreamStreamEvent({
      type: 'response.output_text.done',
      output_index: 0,
      text: 'hello',
    }, context, 'gpt-test')).toMatchObject({
      contentDelta: 'lo',
    });
  });
});
