import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import ProgramLogs from './ProgramLogs.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getEvents: vi.fn(),
    getTasks: vi.fn(),
    markEventRead: vi.fn(),
    getTask: vi.fn(),
    markAllEventsRead: vi.fn(),
    clearEvents: vi.fn(),
  },
}));

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

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function switchToEventsTab(root: ReturnType<typeof create>) {
  const logTab = root.root.findAll((node) => (
    node.type === 'button' && collectText(node).includes('程序日志')
  ))[0];
  expect(logTab).toBeTruthy();
  await act(async () => {
    logTab.props.onClick();
  });
  await flushMicrotasks();
}

describe('ProgramLogs status label', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getTasks.mockResolvedValue({ tasks: [] });
    apiMock.getTask.mockResolvedValue({ success: true, task: null });
  });

  afterEach(() => {
    vi.clearAllMocks();
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

    let root: ReturnType<typeof create> | null = null;
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
    await switchToEventsTab(root!);

    const rows = root!.root.findAll((node) => node.type === 'tr');
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

    let root: ReturnType<typeof create> | null = null;
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
    await switchToEventsTab(root!);

    const rows = root!.root.findAll((node) => node.type === 'tr');
    const targetRow = rows.find((row) => collectText(row).includes('同步全部账号令牌已完成'));
    expect(targetRow).toBeTruthy();

    const tds = targetRow!.findAll((node) => node.type === 'td');
    const statusCell = tds[5];
    expect(collectText(statusCell).trim()).toBe('成功');
    const statusBadge = statusCell.find((node) => node.type === 'span');
    expect(String(statusBadge.props.className || '')).toContain('badge-success');
  });

  it('defaults to the task center tab and can switch to program logs', async () => {
    apiMock.getEvents.mockResolvedValue([
      {
        id: 3,
        type: 'status',
        title: '路由重建已完成',
        message: '新增 2 条通道',
        level: 'info',
        read: false,
        createdAt: '2026-03-04T06:43:03.000Z',
      },
    ]);
    apiMock.getTasks.mockResolvedValue({
      tasks: [{
        id: 'task-1',
        type: 'status',
        title: '刷新模型并重建路由',
        status: 'running',
        message: '正在执行',
        error: null,
        result: null,
        createdAt: '2026-03-04T06:43:03.000Z',
        updatedAt: '2026-03-04T06:43:03.000Z',
      }],
    });

    let root: ReturnType<typeof create> | null = null;
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

    expect(collectText(root!.root)).toContain('任务中心');
    expect(collectText(root!.root)).toContain('刷新模型并重建路由');
    expect(collectText(root!.root)).not.toContain('路由重建已完成');

    const logTab = root!.root.findAll((node) => (
      node.type === 'button' && collectText(node).includes('程序日志')
    ))[0];
    expect(logTab).toBeTruthy();

    await act(async () => {
      logTab.props.onClick();
    });
    await flushMicrotasks();

    expect(collectText(root!.root)).toContain('路由重建已完成');
  });
});
