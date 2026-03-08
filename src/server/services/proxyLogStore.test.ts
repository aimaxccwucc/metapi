import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  hasProxyLogBillingDetailsColumnMock,
  dbInsertMock,
  dbInsertValuesMock,
  dbInsertRunMock,
  proxyLogsSchema,
} = vi.hoisted(() => ({
  hasProxyLogBillingDetailsColumnMock: vi.fn(),
  dbInsertMock: vi.fn(),
  dbInsertValuesMock: vi.fn(),
  dbInsertRunMock: vi.fn(),
  proxyLogsSchema: {
    id: 'id',
    routeId: 'route_id',
    channelId: 'channel_id',
    accountId: 'account_id',
    modelRequested: 'model_requested',
    modelActual: 'model_actual',
    status: 'status',
    httpStatus: 'http_status',
    latencyMs: 'latency_ms',
    promptTokens: 'prompt_tokens',
    completionTokens: 'completion_tokens',
    totalTokens: 'total_tokens',
    estimatedCost: 'estimated_cost',
    billingDetails: 'billing_details',
    errorMessage: 'error_message',
    retryCount: 'retry_count',
    createdAt: 'created_at',
  },
}));

vi.mock('../db/index.js', () => ({
  db: {
    insert: (...args: unknown[]) => dbInsertMock(...args),
  },
  schema: {
    proxyLogs: proxyLogsSchema,
  },
  hasProxyLogBillingDetailsColumn: (...args: unknown[]) => hasProxyLogBillingDetailsColumnMock(...args),
}));

import { insertProxyLog, withProxyLogSelectFields } from './proxyLogStore.js';

describe('proxyLogStore', () => {
  beforeEach(() => {
    hasProxyLogBillingDetailsColumnMock.mockReset();
    dbInsertMock.mockReset();
    dbInsertValuesMock.mockReset();
    dbInsertRunMock.mockReset();

    dbInsertMock.mockReturnValue({
      values: (...args: unknown[]) => dbInsertValuesMock(...args),
    });
    dbInsertValuesMock.mockReturnValue({
      run: (...args: unknown[]) => dbInsertRunMock(...args),
    });
  });

  it('retries proxy log selects without billing details when the column is missing', async () => {
    hasProxyLogBillingDetailsColumnMock.mockResolvedValue(true);
    const runner = vi.fn()
      .mockRejectedValueOnce(new Error('column proxy_logs.billing_details does not exist'))
      .mockResolvedValueOnce([{ id: 1 }]);

    await expect(withProxyLogSelectFields(runner, { includeBillingDetails: true })).resolves.toEqual([{ id: 1 }]);

    expect(runner).toHaveBeenCalledTimes(2);
    expect(runner.mock.calls[0][0].includeBillingDetails).toBe(true);
    expect(runner.mock.calls[0][0].fields.billingDetails).toBe('billing_details');
    expect(runner.mock.calls[1][0].includeBillingDetails).toBe(false);
    expect(runner.mock.calls[1][0].fields.billingDetails).toBeUndefined();
  });

  it('retries proxy log inserts without billing details when the column is missing', async () => {
    hasProxyLogBillingDetailsColumnMock.mockResolvedValue(true);
    dbInsertRunMock
      .mockRejectedValueOnce(new Error('column proxy_logs.billing_details does not exist'))
      .mockResolvedValueOnce(undefined);

    await insertProxyLog({
      modelRequested: 'gpt-5',
      billingDetails: { total: 1 },
    });

    expect(dbInsertValuesMock).toHaveBeenCalledTimes(2);
    expect(dbInsertValuesMock.mock.calls[0][0]).toMatchObject({
      modelRequested: 'gpt-5',
      billingDetails: JSON.stringify({ total: 1 }),
    });
    expect(dbInsertValuesMock.mock.calls[1][0]).toMatchObject({
      modelRequested: 'gpt-5',
    });
    expect(dbInsertValuesMock.mock.calls[1][0].billingDetails).toBeUndefined();
  });
});
