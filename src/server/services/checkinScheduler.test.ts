import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cronStopMock = vi.fn();
const scheduleMock = vi.fn(() => ({
  stop: cronStopMock,
}));
const validateMock = vi.fn(() => true);
const allMock = vi.fn();
const dbSelectAllMock = vi.fn();
const executeRefreshSiteReachabilityMock = vi.fn();

vi.mock('node-cron', () => ({
  default: {
    schedule: (...args: unknown[]) => scheduleMock(...args),
    validate: (...args: unknown[]) => validateMock(...args),
  },
}));

vi.mock('../db/index.js', () => {
  const queryChain = {
    where: () => queryChain,
    get: () => undefined,
    all: () => dbSelectAllMock(),
    from: () => queryChain,
    innerJoin: () => queryChain,
  };

  return {
    db: {
      select: () => queryChain,
    },
    schema: {
      settings: { key: 'key' },
      accounts: { checkinEnabled: 'checkinEnabled', status: 'status' },
      sites: { id: 'id' },
    },
  };
});

vi.mock('./checkinService.js', () => ({
  checkinAll: (...args: unknown[]) => allMock(...args),
  isSchedulableCheckinAccountStatus: (status?: string | null) => status === 'active' || status === 'expired',
}));

vi.mock('./siteHealthService.js', () => ({
  executeRefreshSiteReachability: (...args: unknown[]) => executeRefreshSiteReachabilityMock(...args),
}));

describe('checkinScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    cronStopMock.mockReset();
    scheduleMock.mockClear();
    validateMock.mockClear();
    allMock.mockReset();
    dbSelectAllMock.mockReset();
    executeRefreshSiteReachabilityMock.mockReset();
  });

  afterEach(async () => {
    const scheduler = await import('./checkinScheduler.js');
    scheduler.__resetCheckinSchedulerForTests();
    vi.useRealTimers();
  });

  it('switches from cron mode to interval mode and back', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '0 8 * * *',
      intervalHours: 6,
    });
    expect(scheduleMock).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'interval',
      intervalHours: 6,
    });
    expect(cronStopMock).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    scheduler.updateCheckinSchedule({
      mode: 'cron',
      cronExpr: '5 9 * * *',
      intervalHours: 6,
    });
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledTimes(2);
  });

  it('selects due accounts from the last successful checkin time', async () => {
    const scheduler = await import('./checkinScheduler.js');
    const now = new Date('2026-03-20T12:00:00.000Z');

    expect(scheduler.selectDueIntervalCheckinAccountIds([
      { id: 1, lastCheckinAt: null },
      { id: 2, lastCheckinAt: '2026-03-20T05:59:59.000Z' },
      { id: 3, lastCheckinAt: '2026-03-20T06:30:00.000Z' },
    ], 6, now)).toEqual([1, 2]);
  });

  it('reschedules site health refresh cron and validates cron expression', async () => {
    const scheduler = await import('./checkinScheduler.js');

    scheduler.updateSiteHealthRefreshCron('*/15 * * * *');
    expect(scheduleMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenNthCalledWith(1, '*/15 * * * *', expect.any(Function));

    scheduler.updateSiteHealthRefreshCron('*/30 * * * *');
    expect(cronStopMock).toHaveBeenCalledTimes(1);
    expect(scheduleMock).toHaveBeenCalledTimes(2);
    expect(scheduleMock).toHaveBeenNthCalledWith(2, '*/30 * * * *', expect.any(Function));

    validateMock.mockReturnValueOnce(false);
    expect(() => scheduler.updateSiteHealthRefreshCron('invalid-cron')).toThrow('Invalid cron: invalid-cron');
  });

  it('retries failed interval accounts but suppresses recently skipped ones', async () => {
    const scheduler = await import('./checkinScheduler.js');
    dbSelectAllMock.mockReturnValue([
      {
        accounts: { id: 1, checkinEnabled: true, status: 'active', lastCheckinAt: null },
        sites: { status: 'active' },
      },
      {
        accounts: { id: 2, checkinEnabled: true, status: 'active', lastCheckinAt: null },
        sites: { status: 'active' },
      },
    ]);
    allMock
      .mockResolvedValueOnce([
        { accountId: 1, result: { success: false, status: 'failed' } },
        { accountId: 2, result: { success: true, status: 'skipped', skipped: true } },
      ])
      .mockResolvedValueOnce([
        { accountId: 1, result: { success: false, status: 'failed' } },
      ]);

    scheduler.updateCheckinSchedule({
      mode: 'interval',
      intervalHours: 6,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(allMock).toHaveBeenCalledTimes(2);
    expect(allMock).toHaveBeenNthCalledWith(1, {
      accountIds: [1, 2],
      scheduleMode: 'interval',
    });
    expect(allMock).toHaveBeenNthCalledWith(2, {
      accountIds: [1],
      scheduleMode: 'interval',
    });
  });

  it('prevents interval reentry while the previous pass is still running', async () => {
    const scheduler = await import('./checkinScheduler.js');
    dbSelectAllMock.mockReturnValue([
      {
        accounts: { id: 1, checkinEnabled: true, status: 'active', lastCheckinAt: null },
        sites: { status: 'active' },
      },
    ]);

    let resolvePending: ((value: Array<{ accountId: number; result: { success: boolean; status: string } }>) => void) | null = null;
    allMock.mockImplementation(() => new Promise((resolve) => {
      resolvePending = resolve;
    }));

    scheduler.updateCheckinSchedule({
      mode: 'interval',
      intervalHours: 6,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(allMock).toHaveBeenCalledTimes(1);

    resolvePending?.([{ accountId: 1, result: { success: true, status: 'success' } }]);
    await vi.runAllTicks();
  });
});
