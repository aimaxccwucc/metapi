import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import ProgramLogs from './ProgramLogs.js';

const { apiMock, navigateMock, writeTextMock } = vi.hoisted(() => ({
  apiMock: {
    getEvents: vi.fn(),
    getTasks: vi.fn(),
    getTask: vi.fn(),
    markEventRead: vi.fn(),
    markAllEventsRead: vi.fn(),
    clearEvents: vi.fn(),
  },
  navigateMock: vi.fn(),
  writeTextMock: vi.fn(),
}));

vi.mock('react-dom', async () => {
  const actual = await vi.importActual<typeof import('react-dom')>('react-dom');
  return {
    ...actual,
    createPortal: ((node: unknown) => node) as typeof actual.createPortal,
  };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return {
    ...actual,
    useNavigate: () => navigateMock,
  };
});

vi.mock('../api.js', () => ({
  api: apiMock,
}));

function collectText(node: ReactTestInstance): string {
  const children = node.children || [];
  return children.map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

function findButtonByText(root: ReactTestRenderer, text: string) {
  return root.root.find((node) => node.type === 'button' && collectText(node) === text);
}

function findRowByText(root: ReactTestRenderer, text: string) {
  return root.root.find((node) => node.type === 'tr' && collectText(node).includes(text));
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function renderPage() {
  let root: ReactTestRenderer | null = null;
  await act(async () => {
    root = create(
      <MemoryRouter initialEntries={['/events']}>
        <ToastProvider>
          <ProgramLogs />
        </ToastProvider>
      </MemoryRouter>,
    );
  });
  await flushMicrotasks();
  return root!;
}

describe('ProgramLogs status label', () => {
  let root: ReactTestRenderer | null = null;
  let originalNavigator: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getEvents.mockResolvedValue([]);
    apiMock.getTasks.mockResolvedValue({ tasks: [] });
    apiMock.getTask.mockResolvedValue({ success: true, task: null });
    writeTextMock.mockResolvedValue(undefined);
    originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText: writeTextMock } },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    vi.clearAllMocks();
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
      delete (globalThis as any).navigator;
    }
  });

  it('treats summary with failed=0 as success', async () => {
    apiMock.getEvents.mockResolvedValue([
      {
        id: 1,
        type: 'status',
        title: '同步全部账号令牌已完成（成功31/跳过0/失败0）',
        message: '全部账号令牌同步完成：成功 31，跳过 0，失败 0',
        level: 'info',
        read: false,
        createdAt: '2026-03-04T06:43:03.000Z',
      },
    ]);

    root = await renderPage();

    const rows = root.root.findAll((node) => node.type === 'tr');
    const targetRow = rows.find((row) => collectText(row).includes('同步全部账号令牌已完成'));
    expect(targetRow).toBeTruthy();

    const tds = targetRow!.findAll((node) => node.type === 'td');
    const statusCell = tds[5];
    expect(collectText(statusCell).trim()).toBe('成功');
    const statusBadge = statusCell.find((node) => node.type === 'span');
    expect(String(statusBadge.props.className || '')).toContain('badge-success');
  });

  it('treats parenthesized counts with failed=0 as success', async () => {
    apiMock.getEvents.mockResolvedValue([
      {
        id: 2,
        type: 'status',
        title: '同步全部账号令牌已完成',
        message: '成功(15): a, b\n跳过(1): c\n失败(0): -',
        level: 'info',
        read: false,
        createdAt: '2026-03-04T06:43:03.000Z',
      },
    ]);

    root = await renderPage();

    const rows = root.root.findAll((node) => node.type === 'tr');
    const targetRow = rows.find((row) => collectText(row).includes('同步全部账号令牌已完成'));
    expect(targetRow).toBeTruthy();

    const tds = targetRow!.findAll((node) => node.type === 'td');
    const statusCell = tds[5];
    expect(collectText(statusCell).trim()).toBe('成功');
    const statusBadge = statusCell.find((node) => node.type === 'span');
    expect(String(statusBadge.props.className || '')).toContain('badge-success');
  });


  it('shows detail action for matched program log rows', async () => {
    apiMock.getEvents.mockResolvedValue([
      {
        id: 11,
        type: 'checkin',
        title: '每日签到主任务 (2026-03-07) 已完成（成功1/跳过0/失败1）',
        message: '每日签到主任务完成：成功 1，跳过 0，失败 1',
        level: 'info',
        read: false,
        createdAt: '2026-03-07T01:03:19.000Z',
      },
    ]);
    apiMock.getTasks.mockResolvedValue({
      tasks: [
        {
          id: '13b469fe-6514-48cd-b573-35bdc90432ad',
          type: 'checkin',
          title: '每日签到主任务 (2026-03-07)',
          status: 'succeeded',
          message: '每日签到主任务完成：成功 1，跳过 0，失败 1',
          createdAt: '2026-03-07T01:01:19.000Z',
          updatedAt: '2026-03-07T01:02:19.000Z',
        },
      ],
    });
    apiMock.getTask.mockResolvedValue({
      success: true,
      task: {
        id: '13b469fe-6514-48cd-b573-35bdc90432ad',
        type: 'checkin',
        title: '每日签到主任务 (2026-03-07)',
        status: 'succeeded',
        message: '每日签到主任务完成：成功 1，跳过 0，失败 1',
        createdAt: '2026-03-07T01:01:19.000Z',
        updatedAt: '2026-03-07T01:02:19.000Z',
        result: {
          summary: {
            total: 2,
            success: 1,
            skipped: 0,
            failed: 1,
          },
          results: [
            {
              accountId: 102,
              username: 'bob',
              site: 'Beta',
              siteId: 202,
              result: {
                success: false,
                status: 'failed',
                message: 'token expired',
              },
            },
          ],
        },
      },
    });

    root = await renderPage();

    const eventRows = root.root.findAll((node) => node.type === 'tr' && collectText(node).includes('每日签到主任务完成：成功 1，跳过 0，失败 1'));
    const eventRow = eventRows.find((node) => collectText(node).includes('标记已读')) || eventRows[eventRows.length - 1];
    const detailButton = eventRow.find((node) => node.type === 'button' && collectText(node) === '详情');

    await act(async () => {
      detailButton.props.onClick();
    });
    await flushMicrotasks();

    expect(apiMock.getTask).toHaveBeenCalledWith('13b469fe-6514-48cd-b573-35bdc90432ad');
    expect(collectText(root.root)).toContain('执行明细');
    expect(collectText(root.root)).toContain('bob');
    expect(collectText(root.root)).toContain('Beta');
    expect(collectText(root.root)).toContain('token expired');
  });


  it('shows detail action for direct task events even when task list is empty', async () => {
    apiMock.getEvents.mockResolvedValue([
      {
        id: 21,
        type: 'status',
        title: '检测站点存活状态 已完成',
        message: '站点存活检测完成：可达 85，不可达 7',
        level: 'info',
        read: false,
        relatedType: 'task:direct-task-1',
        createdAt: '2026-03-07T05:03:04.558Z',
      },
    ]);
    apiMock.getTasks.mockResolvedValue({ tasks: [] });
    apiMock.getTask.mockRejectedValue(new Error('task not found'));

    root = await renderPage();

    const eventRow = findRowByText(root, '站点存活检测完成：可达 85，不可达 7');
    const detailButton = eventRow.find((node) => node.type === 'button' && collectText(node) === '详情');

    await act(async () => {
      detailButton.props.onClick();
    });
    await flushMicrotasks();

    expect(apiMock.getTask).toHaveBeenCalledWith('direct-task-1');
    expect(collectText(root.root)).toContain('task not found');
  });

  it('shows fallback detail for legacy task events without task id', async () => {
    apiMock.getEvents.mockResolvedValue([
      {
        id: 22,
        type: 'status',
        title: '历史任务已完成',
        message: '这是一次旧格式任务日志',
        level: 'info',
        read: false,
        relatedType: 'task',
        createdAt: '2026-03-07T05:03:04.558Z',
      },
    ]);
    apiMock.getTasks.mockResolvedValue({ tasks: [] });

    root = await renderPage();

    const eventRow = findRowByText(root, '这是一次旧格式任务日志');
    const detailButton = eventRow.find((node) => node.type === 'button' && collectText(node) === '详情');

    await act(async () => {
      detailButton.props.onClick();
    });
    await flushMicrotasks();

    expect(apiMock.getTask).not.toHaveBeenCalled();
    expect(collectText(root.root)).toContain('这是一次旧格式任务日志');
    expect(collectText(root.root)).toContain('该历史日志未保存可追溯的任务 ID');
  });

  it('opens task detail modal and shows per-account results', async () => {
    apiMock.getTasks.mockResolvedValue({
      tasks: [
        {
          id: '13b469fe-6514-48cd-b573-35bdc90432ad',
          type: 'checkin',
          title: '每日签到主任务 (2026-03-07)',
          status: 'succeeded',
          message: '每日签到主任务完成：成功 1，跳过 0，失败 1',
          createdAt: '2026-03-07T01:01:19.000Z',
          updatedAt: '2026-03-07T01:02:19.000Z',
        },
      ],
    });
    apiMock.getTask.mockResolvedValue({
      success: true,
      task: {
        id: '13b469fe-6514-48cd-b573-35bdc90432ad',
        type: 'checkin',
        title: '每日签到主任务 (2026-03-07)',
        status: 'succeeded',
        message: '每日签到主任务完成：成功 1，跳过 0，失败 1',
        createdAt: '2026-03-07T01:01:19.000Z',
        updatedAt: '2026-03-07T01:02:19.000Z',
        startedAt: '2026-03-07T01:01:20.000Z',
        finishedAt: '2026-03-07T01:02:19.000Z',
        result: {
          summary: {
            total: 2,
            success: 1,
            skipped: 0,
            failed: 1,
          },
          results: [
            {
              accountId: 101,
              username: 'alice',
              site: 'Alpha',
              siteId: 201,
              result: {
                success: true,
                status: 'success',
                message: '签到成功',
                reward: '2 points',
              },
            },
            {
              accountId: 102,
              username: 'bob',
              site: 'Beta',
              siteId: 202,
              result: {
                success: false,
                status: 'failed',
                message: 'token expired',
              },
            },
          ],
        },
      },
    });

    root = await renderPage();

    const detailButton = findButtonByText(root, '详情');
    await act(async () => {
      detailButton.props.onClick();
    });
    await flushMicrotasks();

    expect(apiMock.getTask).toHaveBeenCalledWith('13b469fe-6514-48cd-b573-35bdc90432ad');
    expect(collectText(root.root)).toContain('执行明细');
    expect(collectText(root.root)).toContain('alice');
    expect(collectText(root.root)).toContain('Alpha');
    expect(collectText(root.root)).toContain('bob');
    expect(collectText(root.root)).toContain('Beta');
    expect(collectText(root.root)).toContain('token expired');
  });

  it('filters failed rows, copies failures, and navigates to site', async () => {
    apiMock.getTasks.mockResolvedValue({
      tasks: [
        {
          id: 'task-1',
          type: 'checkin',
          title: '每日签到主任务 (2026-03-07)',
          status: 'succeeded',
          message: '每日签到主任务完成：成功 1，跳过 0，失败 1',
          createdAt: '2026-03-07T01:01:19.000Z',
          updatedAt: '2026-03-07T01:02:19.000Z',
        },
      ],
    });
    apiMock.getTask.mockResolvedValue({
      success: true,
      task: {
        id: 'task-1',
        type: 'checkin',
        title: '每日签到主任务 (2026-03-07)',
        status: 'succeeded',
        message: '每日签到主任务完成：成功 1，跳过 0，失败 1',
        createdAt: '2026-03-07T01:01:19.000Z',
        updatedAt: '2026-03-07T01:02:19.000Z',
        startedAt: '2026-03-07T01:01:20.000Z',
        finishedAt: '2026-03-07T01:02:19.000Z',
        result: {
          summary: {
            total: 2,
            success: 1,
            skipped: 0,
            failed: 1,
          },
          results: [
            {
              accountId: 101,
              username: 'alice',
              site: 'Alpha',
              siteId: 201,
              result: {
                success: true,
                status: 'success',
                message: '签到成功',
              },
            },
            {
              accountId: 102,
              username: 'bob',
              site: 'Beta',
              siteId: 202,
              result: {
                success: false,
                status: 'failed',
                message: 'token expired',
              },
            },
          ],
        },
      },
    });

    root = await renderPage();

    await act(async () => {
      findButtonByText(root!, '详情').props.onClick();
    });
    await flushMicrotasks();

    await act(async () => {
      findButtonByText(root!, '仅看失败').props.onClick();
    });
    await flushMicrotasks();

    const detailRows = root.root.findAll((node) => node.type === 'tr').filter((row) => {
      const text = collectText(row);
      return text.includes('token expired') || text.includes('签到成功');
    });
    expect(detailRows).toHaveLength(1);
    expect(collectText(detailRows[0])).toContain('bob');
    expect(collectText(detailRows[0])).toContain('Beta');
    expect(collectText(detailRows[0])).not.toContain('alice');
    expect(collectText(detailRows[0])).not.toContain('Alpha');

    await act(async () => {
      findButtonByText(root!, '复制失败项').props.onClick();
    });
    await flushMicrotasks();
    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(String(writeTextMock.mock.calls[0][0])).toContain('bob @ Beta');
    expect(String(writeTextMock.mock.calls[0][0])).toContain('token expired');

    const siteButton = root.root.find((node) => node.type === 'button' && collectText(node) === 'Beta');
    await act(async () => {
      siteButton.props.onClick();
    });
    await flushMicrotasks();
    expect(navigateMock).toHaveBeenCalledWith('/sites?focusSiteId=202');
  });
});
