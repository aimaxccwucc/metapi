import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Settings downstream selector performance guards', () => {
  it('keeps the legacy selector modal on progressive rendering instead of full list rendering', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/web/pages/Settings.tsx'), 'utf8');

    expect(source).toContain('const SETTINGS_SELECTOR_RENDER_CHUNK = 80');
    expect(source).toContain('const [visibleSelectorModelCount, setVisibleSelectorModelCount] = useState(SETTINGS_SELECTOR_RENDER_CHUNK)');
    expect(source).toContain('const [visibleSelectorGroupCount, setVisibleSelectorGroupCount] = useState(SETTINGS_SELECTOR_RENDER_CHUNK)');
    expect(source).toContain('const selectedDownstreamModelSet = useMemo(');
    expect(source).toContain('const selectedDownstreamGroupRouteIdSet = useMemo(');
    expect(source).toContain('setVisibleSelectorModelCount(getInitialVisibleCount(filteredExactModelOptions.length, SETTINGS_SELECTOR_RENDER_CHUNK))');
    expect(source).toContain('setVisibleSelectorGroupCount(getInitialVisibleCount(filteredGroupRouteOptions.length, SETTINGS_SELECTOR_RENDER_CHUNK))');
    expect(source).toContain('const visibleExactModelOptions = useMemo(');
    expect(source).toContain('const visibleGroupRouteOptions = useMemo(');
    expect(source).toContain('visibleExactModelOptions.map((modelName) => {');
    expect(source).not.toContain('filteredExactModelOptions.map((modelName) => {');
    expect(source).toContain('visibleGroupRouteOptions.map((route) => {');
    expect(source).not.toContain('filteredGroupRouteOptions.map((route) => {');
    expect(source).toContain('const checked = selectedDownstreamModelSet.has(modelName);');
    expect(source).toContain('const checked = selectedDownstreamGroupRouteIdSet.has(route.id);');
    expect(source).toContain('加载更多 (${visibleSelectorModelCount}/${filteredExactModelOptions.length})');
    expect(source).toContain('加载更多 (${visibleSelectorGroupCount}/${filteredGroupRouteOptions.length})');
  });
});
