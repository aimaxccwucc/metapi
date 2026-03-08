import { describe, expect, it } from 'vitest';

import {
  createOpenAiResponsesAggregateState,
  serializeConvertedResponsesEvents,
  type OpenAiResponsesAggregateState,
  completeResponsesStream,
} from './aggregator.js';
import { openAiResponsesStream } from './stream.js';

function collectSerializedEvents(input: string[]): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = [];
  for (const chunk of input) {
    const blocks = chunk.split('\n\n').filter((item) => item.trim().length > 0);
    for (const block of blocks) {
      const lines = block.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!dataLine) continue;
      const rawData = dataLine.slice('data: '.length);
      if (rawData === '[DONE]') {
        events.push({ event: eventLine?.slice('event: '.length) || 'done', data: '[DONE]' });
        continue;
      }
      events.push({
        event: eventLine?.slice('event: '.length) || '',
        data: JSON.parse(rawData),
      });
    }
  }
  return events;
}

function feedResponsesEvent(
  state: OpenAiResponsesAggregateState,
  payload: Record<string, unknown>,
): Array<{ event: string; data: any }> {
  const context = openAiResponsesStream.createContext('gpt-5');
  const normalizedEvent = openAiResponsesStream.normalizeEvent(payload, context, 'gpt-5');
  return collectSerializedEvents(
    serializeConvertedResponsesEvents({
      state,
      streamContext: context,
      event: normalizedEvent,
      usage: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
    }),
  );
}

describe('openAiResponsesStream / aggregator', () => {
  it('keeps reasoning separate from assistant text for normalized events and merges usage details', () => {
    const state = createOpenAiResponsesAggregateState('gpt-5');
    const context = openAiResponsesStream.createContext('gpt-5');

    const contentEvent = {
      role: 'assistant',
      contentDelta: 'hello',
    };
    const reasoningEvent = {
      reasoningDelta: 'plan first',
      responsesPayload: {
        usage: {
          input_tokens: 5,
          output_tokens: 3,
          total_tokens: 8,
          output_tokens_details: { reasoning_tokens: 2 },
        },
      },
    };

    collectSerializedEvents(
      serializeConvertedResponsesEvents({
        state,
        streamContext: context,
        event: contentEvent as any,
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      }),
    );

    const reasoningEmitted = collectSerializedEvents(
      serializeConvertedResponsesEvents({
        state,
        streamContext: context,
        event: reasoningEvent as any,
        usage: { promptTokens: 5, completionTokens: 3, totalTokens: 8 },
      }),
    );

    expect(reasoningEmitted.some((item) => item.event === 'response.reasoning_summary_part.added')).toBe(true);
    expect(reasoningEmitted.some((item) => item.event === 'response.reasoning_summary_text.delta')).toBe(true);

    const completed = collectSerializedEvents(
      completeResponsesStream(state, context, { promptTokens: 5, completionTokens: 3, totalTokens: 8 }),
    ).find((item) => item.event === 'response.completed');

    expect(completed?.data.response.output).toEqual([
      {
        id: expect.any(String),
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'hello',
          },
        ],
      },
      {
        id: expect.any(String),
        type: 'reasoning',
        status: 'completed',
        summary: [
          {
            type: 'summary_text',
            text: 'plan first',
          },
        ],
      },
    ]);
    expect(completed?.data.response.usage).toMatchObject({
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 8,
      output_tokens_details: { reasoning_tokens: 2 },
    });
  });

  it('tracks reasoning summary events into completed response output', () => {
    const state = createOpenAiResponsesAggregateState('gpt-5');

    const emitted = [
      ...feedResponsesEvent(state, {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'rs_1',
          type: 'reasoning',
          status: 'in_progress',
          summary: [],
        },
      }),
      ...feedResponsesEvent(state, {
        type: 'response.reasoning_summary_part.added',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        part: {
          type: 'summary_text',
          text: '',
        },
      }),
      ...feedResponsesEvent(state, {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'Plan',
      }),
      ...feedResponsesEvent(state, {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        text: 'Plan it out',
      }),
      ...feedResponsesEvent(state, {
        type: 'response.reasoning_summary_part.done',
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        part: {
          type: 'summary_text',
          text: 'Plan it out',
        },
      }),
      ...feedResponsesEvent(state, {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'rs_1',
          type: 'reasoning',
          status: 'completed',
          summary: [],
        },
      }),
      ...feedResponsesEvent(state, {
        type: 'response.completed',
        response: {
          id: 'resp_reasoning',
          object: 'response',
          created_at: 1700000000,
          status: 'completed',
          model: 'gpt-5',
          output: [],
        },
      }),
    ];

    expect(emitted.some((item) => item.event === 'response.reasoning_summary_part.added')).toBe(true);
    expect(emitted.some((item) => item.event === 'response.reasoning_summary_text.done')).toBe(true);

    const completed = emitted.find((item) => item.event === 'response.completed');
    expect(completed?.data.response.output).toEqual([
      {
        id: 'rs_1',
        type: 'reasoning',
        status: 'completed',
        summary: [
          {
            type: 'summary_text',
            text: 'Plan it out',
          },
        ],
      },
    ]);
  });

  it('tracks custom tool input and image generation results', () => {
    const state = createOpenAiResponsesAggregateState('gpt-5');

    const emitted = [
      ...feedResponsesEvent(state, {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'ct_1',
          type: 'custom_tool_call',
          status: 'in_progress',
          call_id: 'ct_1',
          name: 'browser',
          input: '',
        },
      }),
      ...feedResponsesEvent(state, {
        type: 'response.custom_tool_call_input.delta',
        item_id: 'ct_1',
        output_index: 0,
        delta: 'open ',
      }),
      ...feedResponsesEvent(state, {
        type: 'response.custom_tool_call_input.done',
        item_id: 'ct_1',
        output_index: 0,
        input: 'open example.com',
      }),
      ...feedResponsesEvent(state, {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'ct_1',
          type: 'custom_tool_call',
          status: 'completed',
          call_id: 'ct_1',
          name: 'browser',
          input: 'open example.com',
        },
      }),
      ...feedResponsesEvent(state, {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          id: 'img_1',
          type: 'image_generation_call',
          status: 'in_progress',
          result: null,
        },
      }),
      ...feedResponsesEvent(state, {
        type: 'response.image_generation_call.partial_image',
        item_id: 'img_1',
        output_index: 1,
        partial_image_index: 0,
        partial_image_b64: 'abc123',
      }),
      ...feedResponsesEvent(state, {
        type: 'response.image_generation_call.completed',
        item_id: 'img_1',
        output_index: 1,
        result: 'data:image/png;base64,final',
      }),
      ...feedResponsesEvent(state, {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          id: 'img_1',
          type: 'image_generation_call',
          status: 'completed',
          result: 'data:image/png;base64,final',
        },
      }),
      ...feedResponsesEvent(state, {
        type: 'response.completed',
        response: {
          id: 'resp_tools',
          object: 'response',
          created_at: 1700000001,
          status: 'completed',
          model: 'gpt-5',
          output: [],
        },
      }),
    ];

    expect(emitted.some((item) => item.event === 'response.custom_tool_call_input.done')).toBe(true);
    expect(emitted.some((item) => item.event === 'response.image_generation_call.completed')).toBe(true);

    const completed = emitted.find((item) => item.event === 'response.completed');
    expect(completed?.data.response.output).toEqual([
      {
        id: 'ct_1',
        type: 'custom_tool_call',
        status: 'completed',
        call_id: 'ct_1',
        name: 'browser',
        input: 'open example.com',
      },
      {
        id: 'img_1',
        type: 'image_generation_call',
        status: 'completed',
        result: 'data:image/png;base64,final',
        partial_images: [
          {
            partial_image_index: 0,
            partial_image_b64: 'abc123',
          },
        ],
      },
    ]);
  });
});
