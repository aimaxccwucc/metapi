import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, create, type ReactTestInstance } from 'react-test-renderer';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from '../components/Toast.js';
import CredentialDiagnostics from './CredentialDiagnostics.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getSites: vi.fn(),
    getAccounts: vi.fn(),
    getAccountTokens: vi.fn(),
    getCredentialDiagnostic: vi.fn(),
    benchmarkCredentialModels: vi.fn(),
  },
}));

vi.mock('../api.js', () => ({ api: apiMock }));

vi.mock('../components/ModernSelect.js', () => ({
  default: ({ value, onChange, options }: { value: string; onChange: (value: string) => void; options: Array<{ value: string; label: string }> }) => (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}));

vi.mock('../components/site-badge-link.js', () => ({
  default: ({ siteName }: { siteName: string }) => <div>{siteName}</div>,
}));

function collectText(node: ReactTestInstance): string {
  return (node.children || []).map((child) => {
    if (typeof child === 'string') return child;
    return collectText(child);
  }).join('');
}

async function flushMicrotasks() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('CredentialDiagnostics page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.getSites.mockResolvedValue([
      { id: 11, name: '站点 A', url: 'https://site-a.example.com', platform: 'openai', status: 'active' },
    ]);
    apiMock.getAccounts.mockResolvedValue([
      { id: 22, username: 'account-a', status: 'active', site: { id: 11, name: '站点 A' } },
    ]);
    apiMock.getAccountTokens.mockResolvedValue([
      { id: 33, name: 'token-a', enabled: true, accountName: 'account-a', siteName: '站点 A', account: { username: 'account-a' }, site: { name: '站点 A' } },
    ]);
    apiMock.getCredentialDiagnostic.mockResolvedValue({
      success: true,
      target: {
        type: 'token',
        site: { id: 11, name: '站点 A', url: 'https://site-a.example.com', platform: 'openai', status: 'active' },
        account: { id: 22, username: 'account-a', status: 'active' },
        token: { id: 33, name: 'token-a', enabled: true },
      },
      connectivity: {
        normalizedUrl: 'https://site-a.example.com',
        reachable: true,
        status: 'alive',
        message: null,
        checkedAt: '2026-04-03T10:00:00.000Z',
        credentialPresent: true,
        credentialSource: 'managed_token',
        probe: { reachable: true, statusCode: 200, latencyMs: 123, detail: 'HTTP 200' },
      },
      protocol: {
        ok: true,
        protocol: 'chat-completions',
        preferredEndpoint: 'chat',
        supportedEndpoints: ['chat'],
        probeSource: 'live',
        latencyMs: 80,
        attemptSummary: ['chat ok'],
        accountId: 22,
        accountName: 'account-a',
      },
      models: {
        source: 'token_availability',
        total: 1,
        recommendedBaseModel: 'gpt-4o-mini',
        items: [{ name: 'gpt-4o-mini', latencyMs: 90, disabled: false, isManual: false }],
      },
      debug: {
        ok: true,
        modelName: 'gpt-4o-mini',
        requestPath: '/v1/chat/completions',
        requestFormat: 'chat',
        errorSummary: null,
        rawPreview: 'ok',
      },
      routing: {
        referencedRoutes: [],
        governance: [],
        downstreamKeys: [],
      },
      capability: {
        hasAdapter: true,
        canReadModels: true,
        canBenchmark: true,
      },
    });
    apiMock.benchmarkCredentialModels.mockResolvedValue({
      success: true,
      rounds: 1,
      target: { type: 'token', siteId: 11, accountId: 22, tokenId: 33 },
      recommended: null,
      items: [],
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads the diagnostic target from URL search params', async () => {
    let root: ReturnType<typeof create> | null = null;
    try {
      await act(async () => {
        root = create(
          <MemoryRouter initialEntries={['/diagnostics?targetType=token&targetId=33']}>
            <ToastProvider>
              <CredentialDiagnostics />
            </ToastProvider>
          </MemoryRouter>,
        );
      });
      await flushMicrotasks();

      expect(apiMock.getCredentialDiagnostic).toHaveBeenCalledWith({ targetType: 'token', targetId: 33 });
      const text = collectText(root!.root);
      expect(text).toContain('接入诊断');
      expect(text).toContain('token-a');
      expect(text).toContain('gpt-4o-mini');
      expect(text).toContain('managed_token');
    } finally {
      root?.unmount();
    }
  });
});
