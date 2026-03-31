import { describe, expect, it, vi } from 'vitest';

import { listModelsSurface } from './modelsSurface.js';

describe('listModelsSurface', () => {
  it('returns OpenAI list shape for allowed public models', async () => {
    const result = await listModelsSurface({
      downstreamPolicy: { type: 'all' },
      responseFormat: 'openai',
      tokenRouter: {
        getAvailableModels: vi.fn().mockResolvedValue(['routable-model', 'orphan-model']),
      },
      refreshModelsAndRebuildRoutes: vi.fn(),
      isModelAllowed: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      now: () => new Date('2026-03-19T00:00:00.000Z'),
    });

    expect(result).toEqual({
      object: 'list',
      data: [
        {
          id: 'orphan-model',
          object: 'model',
          created: 1773878400,
          owned_by: 'metapi',
        },
      ],
    });
  });

  it('returns Claude list shape when requested', async () => {
    const result = await listModelsSurface({
      downstreamPolicy: { type: 'all' },
      responseFormat: 'claude',
      tokenRouter: {
        getAvailableModels: vi.fn().mockResolvedValue(['claude-opus-4-6']),
      },
      refreshModelsAndRebuildRoutes: vi.fn(),
      isModelAllowed: vi.fn().mockResolvedValue(true),
      now: () => new Date('2026-03-19T00:00:00.000Z'),
    });

    expect(result).toEqual({
      data: [
        {
          id: 'claude-opus-4-6',
          type: 'model',
          display_name: 'claude-opus-4-6',
          created_at: '2026-03-19T00:00:00.000Z',
        },
      ],
      first_id: 'claude-opus-4-6',
      last_id: 'claude-opus-4-6',
      has_more: false,
    });
  });

  it('refreshes only when public models are absent and skips refresh when policy filtering alone makes the list empty', async () => {
    const getAvailableModels = vi.fn()
      .mockResolvedValueOnce(['blocked-model'])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['allowed-model']);
    const refreshModelsAndRebuildRoutes = vi.fn().mockResolvedValue(undefined);
    const isModelAllowed = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const first = await listModelsSurface({
      downstreamPolicy: { type: 'whitelist' },
      responseFormat: 'openai',
      tokenRouter: {
        getAvailableModels,
      },
      refreshModelsAndRebuildRoutes,
      isModelAllowed,
      now: () => new Date('2026-03-19T00:00:00.000Z'),
    });

    expect(first).toEqual({
      object: 'list',
      data: [],
    });
    expect(refreshModelsAndRebuildRoutes).not.toHaveBeenCalled();

    const second = await listModelsSurface({
      downstreamPolicy: { type: 'whitelist' },
      responseFormat: 'openai',
      tokenRouter: {
        getAvailableModels,
      },
      refreshModelsAndRebuildRoutes,
      isModelAllowed,
      now: () => new Date('2026-03-19T00:00:00.000Z'),
    });

    expect(refreshModelsAndRebuildRoutes).toHaveBeenCalledTimes(1);
    expect(second).toEqual({
      object: 'list',
      data: [
        {
          id: 'allowed-model',
          object: 'model',
          created: 1773878400,
          owned_by: 'metapi',
        },
      ],
    });
  });

  it('can skip refresh when the caller needs a fast read-only model listing', async () => {
    const refreshModelsAndRebuildRoutes = vi.fn().mockResolvedValue(undefined);

    const result = await listModelsSurface({
      downstreamPolicy: { type: 'public-surface-only' },
      responseFormat: 'openai',
      tokenRouter: {
        getAvailableModels: vi.fn().mockResolvedValue([]),
      },
      refreshModelsAndRebuildRoutes,
      isModelAllowed: vi.fn(),
      allowRefreshOnEmpty: false,
      now: () => new Date('2026-03-19T00:00:00.000Z'),
    });

    expect(refreshModelsAndRebuildRoutes).not.toHaveBeenCalled();
    expect(result).toEqual({
      object: 'list',
      data: [],
    });
  });
});
