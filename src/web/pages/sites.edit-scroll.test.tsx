import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import ModernSelect from '../components/ModernSelect.js';
import { ToastProvider } from '../components/Toast.js';
import Sites from './Sites.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getSiteDisabledModels: vi.fn().mockResolvedValue({ models: [] }),
    probeSiteProtocol: vi.fn(),
    updateSite: vi.fn(),
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

describe('Sites edit behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('scrolls to page top when entering edit mode', async () => {
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'Demo Site',
        url: 'https://example.com',
        platform: 'new-api',
        status: 'active',
      },
    ]);

    const scrollToMock = vi.fn();
    Object.defineProperty(globalThis, 'scrollTo', {
      configurable: true,
      writable: true,
      value: scrollToMock,
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const editButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '编辑'
      ));

      await act(async () => {
        editButton.props.onClick();
      });
      await flushMicrotasks();

      expect(scrollToMock).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    } finally {
      root?.unmount();
    }
  });

  it('restores header add button label after closing add modal', async () => {
    apiMock.getSites.mockResolvedValue([]);

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const openAddButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && typeof node.props.className === 'string'
        && node.props.className.includes('btn btn-primary')
        && collectText(node).includes('添加站点')
      ));

      await act(async () => {
        openAddButton.props.onClick();
      });
      await flushMicrotasks();

      const closeModalButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && typeof node.props.className === 'string'
        && node.props.className.includes('btn btn-ghost')
        && collectText(node).trim() === '取消'
      ));

      await act(async () => {
        closeModalButton.props.onClick();
      });
      await flushMicrotasks();

      const headerAddButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.className === 'string'
        && node.props.className.includes('btn btn-primary')
        && collectText(node).includes('添加站点')
      ));

      expect(collectText(headerAddButton)).toContain('添加站点');
    } finally {
      root?.unmount();
    }
  });

  it('shows protocol summary in edit mode and submits manual protocol config', async () => {
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'Demo Site',
        url: 'https://example.com',
        platform: 'new-api',
        status: 'active',
        protocolConfig: {
          mode: 'manual',
          supportedEndpoints: ['responses', 'chat'],
          preferredEndpoint: 'responses',
        },
      },
    ]);
    apiMock.updateSite.mockResolvedValue({
      id: 1,
      name: 'Demo Site',
      url: 'https://example.com',
      platform: 'new-api',
      status: 'active',
      protocolConfig: {
        mode: 'manual',
        supportedEndpoints: ['responses', 'chat'],
        preferredEndpoint: 'responses',
      },
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(JSON.stringify(root.toJSON())).toContain('responses / chat · 首选 responses');

      const editButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '编辑'
      ));

      await act(async () => {
        editButton.props.onClick();
      });
      await flushMicrotasks();

      const modeSelect = root.root.find((node) => (
        node.type === ModernSelect
        && node.props.placeholder === '协议模式'
      ));
      const preferredSelect = root.root.find((node) => (
        node.type === ModernSelect
        && node.props.placeholder === '首选协议'
      ));
      const chatCheckbox = root.root.find((node) => (
        node.type === 'input'
        && node.props['data-testid'] === 'site-protocol-endpoint-chat'
      ));
      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('保存修改')
      ));

      await act(async () => {
        modeSelect.props.onChange('manual');
        chatCheckbox.props.onChange({ target: { checked: false } });
        preferredSelect.props.onChange('responses');
      });

      await act(async () => {
        await saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateSite).toHaveBeenCalledWith(1, expect.objectContaining({
        protocolConfig: {
          mode: 'manual',
          supportedEndpoints: ['responses'],
          preferredEndpoint: 'responses',
        },
      }));
    } finally {
      root?.unmount();
    }
  });

  it('fills protocol config from automatic probe before saving', async () => {
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'Demo Site',
        url: 'https://example.com',
        platform: 'new-api',
        status: 'active',
      },
    ]);
    apiMock.probeSiteProtocol.mockResolvedValue({
      success: true,
      siteId: 1,
      modelName: 'gpt-4.1',
      preferredEndpoint: 'responses',
      supportedEndpoints: ['responses'],
      protocolConfig: {
        mode: 'manual',
        supportedEndpoints: ['responses'],
        preferredEndpoint: 'responses',
      },
    });
    apiMock.updateSite.mockResolvedValue({
      id: 1,
      name: 'Demo Site',
      url: 'https://example.com',
      platform: 'new-api',
      status: 'active',
      protocolConfig: {
        mode: 'manual',
        supportedEndpoints: ['responses'],
        preferredEndpoint: 'responses',
      },
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const editButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '编辑'
      ));

      await act(async () => {
        editButton.props.onClick();
      });
      await flushMicrotasks();

      const probeButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('自动探测协议')
      ));
      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('保存修改')
      ));

      await act(async () => {
        await probeButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.probeSiteProtocol).toHaveBeenCalledWith(1);

      await act(async () => {
        await saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateSite).toHaveBeenCalledWith(1, expect.objectContaining({
        protocolConfig: {
          mode: 'manual',
          supportedEndpoints: ['responses'],
          preferredEndpoint: 'responses',
        },
      }));
    } finally {
      root?.unmount();
    }
  });

  it('filters unsupported protocol options after switching platform', async () => {
    apiMock.getSites.mockResolvedValue([
      {
        id: 1,
        name: 'Demo Site',
        url: 'https://example.com',
        platform: 'new-api',
        status: 'active',
        protocolConfig: {
          mode: 'manual',
          supportedEndpoints: ['responses', 'chat'],
          preferredEndpoint: 'responses',
        },
      },
    ]);
    apiMock.updateSite.mockResolvedValue({
      id: 1,
      name: 'Demo Site',
      url: 'https://example.com',
      platform: 'codex',
      status: 'active',
      protocolConfig: {
        mode: 'manual',
        supportedEndpoints: ['responses'],
        preferredEndpoint: 'responses',
      },
    });

    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/sites']}>
            <ToastProvider>
              <Sites />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      const editButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).trim() === '编辑'
      ));

      await act(async () => {
        editButton.props.onClick();
      });
      await flushMicrotasks();

      const platformSelect = root.root.find((node) => (
        node.type === ModernSelect
        && node.props.placeholder === '平台类型（可自动检测）'
      ));
      const saveButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && collectText(node).includes('保存修改')
      ));

      await act(async () => {
        platformSelect.props.onChange('codex');
      });
      await flushMicrotasks();

      await act(async () => {
        await saveButton.props.onClick();
      });
      await flushMicrotasks();

      expect(apiMock.updateSite).toHaveBeenCalledWith(1, expect.objectContaining({
        platform: 'codex',
        protocolConfig: {
          mode: 'manual',
          supportedEndpoints: ['responses'],
          preferredEndpoint: 'responses',
        },
      }));
    } finally {
      root?.unmount();
    }
  });
});
