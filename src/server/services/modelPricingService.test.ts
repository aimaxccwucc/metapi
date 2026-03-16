import { describe, expect, it } from 'vitest';
import {
  calculateModelUsageBreakdown,
  calculateModelUsageCost,
  fallbackTokenCost,
  selectPreferredTokenGroup,
  type PricingModel,
} from './modelPricingService.js';

describe('modelPricingService', () => {
  it('calculates token-based cost from model ratio and completion ratio', () => {
    const model: PricingModel = {
      modelName: 'gpt-4o',
      quotaType: 0,
      modelRatio: 2,
      completionRatio: 1.5,
      modelPrice: null,
      enableGroups: ['vip'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 1000,
        completionTokens: 500,
        totalTokens: 1500,
      },
      { default: 1, vip: 2 },
    );

    expect(cost).toBe(0.014);
  });

  it('falls back to total tokens when split token usage is missing', () => {
    const model: PricingModel = {
      modelName: 'claude-sonnet',
      quotaType: 0,
      modelRatio: 1,
      completionRatio: 2,
      modelPrice: null,
      enableGroups: ['default'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 2000,
      },
      { default: 1 },
    );

    expect(cost).toBe(0.004);
  });

  it('calculates per-call cost when quota type is call-based', () => {
    const model: PricingModel = {
      modelName: 'gpt-image-1',
      quotaType: 1,
      modelRatio: 1,
      completionRatio: 1,
      modelPrice: 0.3,
      enableGroups: ['vip'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      { default: 1, vip: 1.5 },
    );

    expect(cost).toBe(0.45);
  });

  it('calculates times-based per-call cost from input ratio only', () => {
    const model: PricingModel = {
      modelName: 'flux-kontext-pro',
      quotaType: 1,
      modelRatio: 1,
      completionRatio: 1,
      modelPrice: { input: 1, output: 3 },
      enableGroups: ['vip'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      },
      { default: 1, vip: 2 },
    );

    expect(cost).toBe(0.004);
  });

  it('splits cache read and cache creation costs from prompt cost', () => {
    const model: PricingModel = {
      modelName: 'gpt-4o',
      quotaType: 0,
      modelRatio: 2.5,
      completionRatio: 5,
      cacheRatio: 0.1,
      cacheCreationRatio: 1.25,
      modelPrice: null,
      enableGroups: ['default'],
    };

    const detail = calculateModelUsageBreakdown(
      model,
      {
        promptTokens: 146638,
        completionTokens: 172,
        totalTokens: 146810,
        cacheReadTokens: 145692,
        cacheCreationTokens: 945,
        promptTokensIncludeCache: true,
      },
      { default: 1 },
    );

    expect(detail).toMatchObject({
      usage: {
        billablePromptTokens: 1,
        cacheReadTokens: 145692,
        cacheCreationTokens: 945,
      },
      pricing: {
        modelRatio: 2.5,
        completionRatio: 5,
        cacheRatio: 0.1,
        cacheCreationRatio: 1.25,
        groupRatio: 1,
      },
      breakdown: {
        inputPerMillion: 5,
        outputPerMillion: 25,
        cacheReadPerMillion: 0.5,
        cacheCreationPerMillion: 6.25,
        inputCost: 0.000005,
        outputCost: 0.0043,
        cacheReadCost: 0.072846,
        cacheCreationCost: 0.005906,
        totalCost: 0.083057,
      },
    });
  });

  it('keeps prompt tokens intact when upstream reports cache tokens separately', () => {
    const model: PricingModel = {
      modelName: 'claude-sonnet',
      quotaType: 0,
      modelRatio: 3,
      completionRatio: 5,
      cacheRatio: 0.3,
      cacheCreationRatio: 1.25,
      modelPrice: null,
      enableGroups: ['default'],
    };

    const cost = calculateModelUsageCost(
      model,
      {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        cacheReadTokens: 1000,
        cacheCreationTokens: 40,
        promptTokensIncludeCache: false,
      },
      { default: 1 },
    );

    expect(cost).toBe(0.00372);
  });

  it('uses platform-specific fallback token divisor', () => {
    expect(fallbackTokenCost(1500, 'new-api')).toBe(0.003);
    expect(fallbackTokenCost(1500, 'veloera')).toBe(0.0015);
  });

  it('prefers the lowest-ratio group that covers all requested models', () => {
    const resolution = selectPreferredTokenGroup({
      availableGroups: ['default', 'vip', 'cheap'],
      modelNames: ['gpt-4o', 'gpt-4.1'],
      catalog: {
        groupRatio: { default: 1, vip: 3, cheap: 0.4 },
        models: [
          {
            modelName: 'gpt-4o',
            quotaType: 0,
            modelDescription: null,
            tags: [],
            supportedEndpointTypes: [],
            ownerBy: null,
            enableGroups: ['default', 'vip', 'cheap'],
            groupPricing: {
              default: { quotaType: 0, inputPerMillion: 2, outputPerMillion: 4 },
              vip: { quotaType: 0, inputPerMillion: 6, outputPerMillion: 12 },
              cheap: { quotaType: 0, inputPerMillion: 0.8, outputPerMillion: 1.6 },
            },
          },
          {
            modelName: 'gpt-4.1',
            quotaType: 0,
            modelDescription: null,
            tags: [],
            supportedEndpointTypes: [],
            ownerBy: null,
            enableGroups: ['default', 'cheap'],
            groupPricing: {
              default: { quotaType: 0, inputPerMillion: 2, outputPerMillion: 4 },
              cheap: { quotaType: 0, inputPerMillion: 0.8, outputPerMillion: 1.6 },
            },
          },
        ],
      },
    });

    expect(resolution.candidateGroups).toEqual(['default', 'cheap']);
    expect(resolution.group).toBe('cheap');
    expect(resolution.groupRatios).toMatchObject({ default: 1, vip: 3, cheap: 0.4 });
  });

  it('falls back to the lowest-ratio available group when model coverage is unknown', () => {
    const resolution = selectPreferredTokenGroup({
      availableGroups: ['vip', 'default', 'cheap'],
      modelNames: ['unknown-model'],
      catalog: {
        groupRatio: { default: 1, vip: 2, cheap: 0.5 },
        models: [],
      },
    });

    expect(resolution.candidateGroups).toEqual(['vip', 'default', 'cheap']);
    expect(resolution.group).toBe('cheap');
  });
});
