import { describe, expect, it, vi } from 'vitest';
import { act, create } from 'react-test-renderer';
import type { ReactNode } from 'react';
import ManualRoutePanel from './token-routes/ManualRoutePanel.js';
import { ToastProvider } from '../components/Toast.js';

vi.mock('react-dom', () => ({
  createPortal: (node: unknown) => node,
}));

type RouteEditorForm = {
  routeMode: 'explicit_group';
  probePolicy: 'manual';
  displayName: string;
  displayIcon: string;
  modelPattern: string;
  sourceRouteKeys: string[];
  advancedOpen: boolean;
};

const baseForm: RouteEditorForm = {
  routeMode: 'explicit_group',
  probePolicy: 'manual',
  displayName: '',
  displayIcon: '',
  modelPattern: '',
  sourceRouteKeys: [],
  advancedOpen: false,
};

describe('ManualRoutePanel source picker loading state', () => {
  it('shows loading copy instead of incomplete candidate list while route candidates are still loading', async () => {
    let root: ReturnType<typeof create> | null = null;
    const setForm = vi.fn();

    try {
      await act(async () => {
        root = create(
          <ToastProvider>
            <ManualRoutePanel
              show
              editingRouteId={null}
              form={baseForm}
              setForm={setForm}
              saving={false}
              canSave={false}
              routeIconSelectOptions={[]}
              previewModelSamples={[]}
              sourceRouteOptions={[
                {
                  id: 101,
                  modelPattern: 'claude-opus-4-5',
                  displayName: null,
                  displayIcon: null,
                  routeMode: 'pattern',
                  probePolicy: 'manual',
                  sourceRouteIds: [],
                  modelMapping: null,
                  routingStrategy: 'weighted',
                  enabled: true,
                  channelCount: 1,
                  enabledChannelCount: 1,
                  siteNames: ['ccll'],
                  decisionSnapshot: null,
                  decisionRefreshedAt: null,
                  sourceKey: 'route:101',
                  backingRouteId: 101,
                },
              ]}
              sourceEndpointTypesBySourceKey={{}}
              routeCandidatesLoading
              routeCandidatesLoaded={false}
              modelCandidates={{}}
              missingTokenModelsByName={{}}
              missingTokenGroupModelsByName={{}}
              onSave={() => {}}
              onCancel={() => {}}
            />
          </ToastProvider>,
        );
      });

      const pickerButton = root.root.find((node) => (
        node.type === 'button'
        && typeof node.props.onClick === 'function'
        && node.children.some((child: ReactNode) => child === '选择来源模型')
      ));

      await act(async () => {
        pickerButton.props.onClick();
      });

      const text = root.root.findAll(() => true)
        .flatMap((instance) => instance.children)
        .filter((child): child is string => typeof child === 'string')
        .join('');

      expect(text).toContain('正在同步来源模型候选');
      expect(text).not.toContain('候选 0 / 1');
      expect(text).not.toContain('claude-opus-4-5');
    } finally {
      if (root) {
        await act(async () => {
          root.unmount();
        });
      }
    }
  });
});
