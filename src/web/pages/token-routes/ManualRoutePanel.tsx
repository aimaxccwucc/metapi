import { useEffect, useMemo, useState } from 'react';
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
  modelHintsByName?: ModelHintMap;
  onSave: () => void;
  onCancel: () => void;
};

export type ModelHintMap = Record<string, { missingToken?: boolean; missingGroup?: boolean }>;

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseExactModelSetPattern(pattern: string): Set<string> {
  const trimmed = pattern.trim();
  if (!trimmed) return new Set<string>();
  if (/^[^*?[\\|^$(){}+]+$/.test(trimmed)) return new Set([trimmed]);

  const reMatch = trimmed.match(/^re:\^\((.*)\)\$$/);
  if (!reMatch) return new Set<string>();

  const body = reMatch[1];
  const parts: string[] = [];
  let current = '';

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) {
      current += ch + body[i + 1];
      i += 1;
      continue;
    }
    if (ch === '|') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current);

  const decoded = parts
    .map((part) => part.replace(/\\([.*+?^${}()|[\]\\])/g, '$1').trim())
    .filter(Boolean);

  if (decoded.some((item, index) => escapeRegexLiteral(item) !== parts[index])) {
    return new Set<string>();
  }

  return new Set(decoded);
}

function buildExactModelSetPattern(models: Iterable<string>): string {
  const values = Array.from(new Set(Array.from(models).map((item) => item.trim()).filter(Boolean))).sort();
  if (values.length === 0) return '';
  if (values.length === 1) return values[0];
  return `re:^(${values.map(escapeRegexLiteral).join('|')})$`;
}

export default function ManualRoutePanel({
  show,
  editingRouteId,
  form,
  setForm,
  saving,
  canSave,
  routeIconSelectOptions,
  previewModelSamples,
  modelHintsByName,
  onSave,
  onCancel,
}: ManualRoutePanelProps) {
  const presence = useAnimatedVisibility(show, 220);
  const [modelSearch, setModelSearch] = useState('');
  const [showOnlyAvailable, setShowOnlyAvailable] = useState(false);

  useEffect(() => {
    if (!show) {
      setModelSearch('');
      setShowOnlyAvailable(false);
    }
  }, [show]);

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

  const selectedModels = useMemo(() => {
    return parseExactModelSetPattern(form.modelPattern);
  }, [form.modelPattern]);

  const filteredModelList = useMemo(() => {
    const q = modelSearch.trim().toLowerCase();
    let list = previewModelSamples;
    if (q) {
      list = list.filter((m) => m.toLowerCase().includes(q));
    }
    if (showOnlyAvailable) {
      list = list.filter((modelName) => {
        const hint = modelHintsByName?.[modelName];
        return !hint?.missingToken && !hint?.missingGroup;
      });
    }
    return list;
  }, [previewModelSamples, modelSearch, showOnlyAvailable, modelHintsByName]);

  const visibleModelList = useMemo(() => {
    if (modelSearch.trim()) return filteredModelList;
    return filteredModelList.slice(0, 200);
  }, [filteredModelList, modelSearch]);

  const handleToggleModel = (modelName: string) => {
    const next = new Set(selectedModels);
    if (next.has(modelName)) {
      next.delete(modelName);
    } else {
      next.add(modelName);
    }
    const arr = Array.from(next).sort();
    const pattern = buildExactModelSetPattern(arr);
    setForm((f) => ({ ...f, modelPattern: pattern }));
  };

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
        {previewModelSamples.length > 0 && (
          <div
            style={{
              border: '1px solid var(--color-border)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--color-bg)',
              overflow: 'hidden',
            }}
          >
            <div style={{ padding: '8px 10px', borderBottom: '1px solid var(--color-border)', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--color-text-secondary)', flexShrink: 0 }}>
                {tr('勾选模型')}（{selectedModels.size > 0 ? `${selectedModels.size} ${tr('已选')}` : tr('可选')}）
              </span>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--color-text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={showOnlyAvailable}
                  onChange={(e) => setShowOnlyAvailable(e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                {tr('仅可用')}
              </label>
              <input
                placeholder={tr('搜索模型...')}
                value={modelSearch}
                onChange={(e) => setModelSearch(e.target.value)}
                style={{
                  flex: 1,
                  padding: '3px 8px',
                  fontSize: 12,
                  border: '1px solid var(--color-border)',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--color-bg-card)',
                  color: 'var(--color-text-primary)',
                  outline: 'none',
                  fontFamily: 'var(--font-mono)',
                }}
              />
            </div>
            <div style={{ maxHeight: 180, overflowY: 'auto', padding: '4px 0' }}>
              {filteredModelList.length === 0 ? (
                <div style={{ padding: '8px 12px', fontSize: 12, color: 'var(--color-text-muted)' }}>{tr('无匹配模型')}</div>
              ) : (
                visibleModelList.map((modelName) => {
                  const hint = modelHintsByName?.[modelName];
                  const badges: string[] = [];
                  if (hint?.missingToken) badges.push(tr('缺令牌'));
                  if (hint?.missingGroup) badges.push(tr('缺分组'));

                  return (
                    <div
                      key={modelName}
                      onClick={() => handleToggleModel(modelName)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                        padding: '4px 12px',
                        cursor: 'pointer',
                        background: selectedModels.has(modelName) ? 'var(--color-bg-hover)' : 'transparent',
                      }}
                    >
                      <input
                        type="checkbox"
                        readOnly
                        checked={selectedModels.has(modelName)}
                        style={{ cursor: 'pointer', flexShrink: 0 }}
                      />
                      <code style={{ fontSize: 12, color: 'var(--color-text-primary)' }}>{modelName}</code>
                      {badges.length > 0 && (
                        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                          {badges.map((text) => (
                            <span
                              key={text}
                              style={{
                                fontSize: 10,
                                padding: '1px 6px',
                                borderRadius: 999,
                                border: '1px solid var(--color-border)',
                                color: 'var(--color-text-muted)',
                                background: 'var(--color-bg-card)',
                              }}
                            >
                              {text}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            {!modelSearch.trim() && filteredModelList.length > visibleModelList.length && (
              <div style={{ padding: '6px 12px 10px', fontSize: 11, color: 'var(--color-text-muted)', borderTop: '1px solid var(--color-border)' }}>
                {tr('默认仅显示前 200 个模型；可使用搜索查看其他模型。')}
              </div>
            )}
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
          <button
            onClick={onCancel}
            className="btn btn-ghost"
            style={{ alignSelf: 'flex-start', border: '1px solid var(--color-border)' }}
          >
            {tr(editingRouteId ? '取消编辑' : '取消创建')}
          </button>
        </div>
      </div>
    </div>
  );
}
