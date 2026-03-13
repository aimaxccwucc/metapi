import { useMemo } from 'react';
import { BrandGlyph } from '../../components/BrandIcon.js';
import ModernSelect from '../../components/ModernSelect.js';
import { useAnimatedVisibility } from '../../components/useAnimatedVisibility.js';
import { tr } from '../../i18n.js';
import type { RouteIconOption } from './types.js';
import { getModelPatternError, matchesModelPattern, normalizeRouteDisplayIconValue } from './utils.js';

type ManualRoutePanelProps = {
  show: boolean;
  editingRouteId: number | null;
  form: { modelPattern: string; displayName: string; displayIcon: string };
  setForm: (updater: (f: { modelPattern: string; displayName: string; displayIcon: string }) => { modelPattern: string; displayName: string; displayIcon: string }) => void;
  saving: boolean;
  canSave: boolean;
  routeIconSelectOptions: RouteIconOption[];
  previewModelSamples: string[];
  onSave: () => void;
  onCancel: () => void;
};

export default function ManualRoutePanel({
  show,
  editingRouteId,
  form,
  setForm,
  saving,
  canSave,
  routeIconSelectOptions,
  previewModelSamples,
  onSave,
  onCancel,
}: ManualRoutePanelProps) {
  const presence = useAnimatedVisibility(show, 220);

  const modelPatternError = useMemo(
    () => getModelPatternError(form.modelPattern),
    [form.modelPattern],
  );

  const routeIconOptionValues = useMemo(
    () => new Set(routeIconSelectOptions.map((option) => option.value)),
    [routeIconSelectOptions],
  );

  const routeIconSelectValue = routeIconOptionValues.has(normalizeRouteDisplayIconValue(form.displayIcon))
    ? normalizeRouteDisplayIconValue(form.displayIcon)
    : '';

  const previewMatchedModels = useMemo(() => {
    const normalizedPattern = form.modelPattern.trim();
    if (!normalizedPattern || modelPatternError) return [] as string[];
    return previewModelSamples.filter((modelName) => matchesModelPattern(modelName, normalizedPattern));
  }, [form.modelPattern, modelPatternError, previewModelSamples]);

  if (!presence.shouldRender) return null;

  return (
    <div className={`card panel-presence ${presence.isVisible ? '' : 'is-closing'}`.trim()} style={{ padding: 20, marginBottom: 16 }}>
      <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginBottom: 10 }}>
        {editingRouteId
          ? tr('编辑群组路由名称、图标和模型匹配规则；若修改正则，将按当前可用模型重新匹配自动通道。')
          : tr('用于创建群组路由（聚合多个上游模型为一个下游模型名，即模型重定向）；自动路由仍会保持开启。')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 180px', gap: 10 }}>
          <input
            placeholder={tr('群组显示名（可选，例如 claude-opus-4-6）')}
            value={form.displayName}
            onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
            style={{
              width: '100%',
              padding: '10px 14px',
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 13,
              outline: 'none',
              background: 'var(--color-bg)',
              color: 'var(--color-text-primary)',
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <ModernSelect
              value={routeIconSelectValue}
              onChange={(nextValue) => setForm((f) => ({ ...f, displayIcon: nextValue }))}
              options={routeIconSelectOptions}
              placeholder={tr('图标（可选，选择品牌图标）')}
              emptyLabel={tr('暂无可选品牌图标')}
            />
          </div>
        </div>
        <input
          placeholder={tr('模型匹配（如 gpt-4o、claude-*、re:^claude-.*$）')}
          value={form.modelPattern}
          onChange={(e) => setForm((f) => ({ ...f, modelPattern: e.target.value }))}
          style={{
            width: '100%',
            padding: '10px 14px',
            border: `1px solid ${modelPatternError ? 'var(--color-danger)' : 'var(--color-border)'}`,
            borderRadius: 'var(--radius-sm)',
            fontSize: 13,
            outline: 'none',
            background: 'var(--color-bg)',
            color: 'var(--color-text-primary)',
            fontFamily: 'var(--font-mono)',
          }}
        />
        <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: -4 }}>
          {tr('正则请使用 re: 前缀；例如 re:^claude-(opus|sonnet)-4-6$')}
        </div>
        {modelPatternError && (
          <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: -4 }}>
            {modelPatternError}
          </div>
        )}
        {form.modelPattern.trim() && !modelPatternError && (
          <div
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              padding: '10px 12px',
              background: 'var(--color-bg)',
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--color-text-secondary)', marginBottom: 8 }}>
              {tr('规则预览：命中样本')} {previewMatchedModels.length} / {previewModelSamples.length}
            </div>

            {previewModelSamples.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                {tr('当前暂无可预览模型，请先同步模型。')}
              </div>
            ) : previewMatchedModels.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)' }}>
                {tr('当前规则未命中任何样本模型。')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {previewMatchedModels.slice(0, 12).map((modelName) => (
                  <code
                    key={modelName}
                    style={{
                      fontSize: 11,
                      padding: '2px 6px',
                      borderRadius: 6,
                      border: '1px solid var(--color-border)',
                      background: 'var(--color-bg-card)',
                    }}
                  >
                    {modelName}
                  </code>
                ))}
              </div>
            )}

            {previewMatchedModels.length > 12 && (
              <div style={{ fontSize: 12, color: 'var(--color-text-muted)', marginTop: 8 }}>
                {tr('仅展示前 12 个命中样本。')}
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            onClick={onSave}
            disabled={!canSave}
            className="btn btn-success"
            style={{ alignSelf: 'flex-start' }}
          >
            {saving ? (
              <>
                <span
                  className="spinner spinner-sm"
                  style={{ borderTopColor: 'white', borderColor: 'rgba(255,255,255,0.3)' }}
                />{' '}
                {tr('保存中...')}
              </>
            ) : (
              tr(editingRouteId ? '保存群组' : '创建群组')
            )}
          </button>
          {editingRouteId ? (
            <button
              onClick={onCancel}
              className="btn btn-ghost"
              style={{ alignSelf: 'flex-start', border: '1px solid var(--color-border)' }}
            >
              {tr('取消编辑')}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
