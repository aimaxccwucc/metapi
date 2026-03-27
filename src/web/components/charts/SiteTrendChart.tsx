import React, { Suspense, lazy, startTransition, useMemo, useState } from 'react';
import type { ILineChartSpec } from '@visactor/vchart';

const LineChartRenderer = lazy(() => import('./LineChartRenderer.js'));

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface SiteTrendData {
  date: string;
  sites: Record<string, { spend: number; calls: number }>;
}

interface SiteTrendChartProps {
  data: SiteTrendData[];
  loading?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

type Metric = 'spend' | 'calls';

const METRIC_OPTIONS: { key: Metric; label: string }[] = [
  { key: 'spend', label: '消耗趋势' },
  { key: 'calls', label: '调用趋势' },
];

const COLOR_PALETTE = [
  '#4f46e5',
  '#06b6d4',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
];

function getDatumRecord(datum: unknown): Record<string, unknown> {
  return datum && typeof datum === 'object' ? datum as Record<string, unknown> : {};
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function SiteTrendChart({ data, loading }: SiteTrendChartProps) {
  const [metric, setMetric] = useState<Metric>('spend');

  const handleMetricChange = (nextMetric: Metric) => {
    if (nextMetric === metric) return;
    startTransition(() => {
      setMetric(nextMetric);
    });
  };

  /* ---------- data transform ---------- */

  const flatData = useMemo(() => {
    if (!data || data.length === 0) return [];
    return data.flatMap((d) =>
      Object.entries(d.sites).map(([site, v]) => ({
        date: d.date,
        site,
        value: metric === 'spend' ? v.spend : v.calls,
      })),
    );
  }, [data, metric]);

  /* ---------- loading state ---------- */

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <div className="skeleton" style={{ width: 200, height: 32, borderRadius: 'var(--radius-sm)' }} />
        </div>
        <div className="skeleton" style={{ width: '100%', height: 300, borderRadius: 'var(--radius-sm)' }} />
      </div>
    );
  }

  /* ---------- empty state ---------- */

  if (!data || data.length === 0 || flatData.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <MetricToggle metric={metric} onChange={handleMetricChange} />
        </div>
        <div className="empty-state" style={{ padding: 48 }}>
          <div className="empty-state-title">暂无趋势数据</div>
          <div className="empty-state-desc">数据加载后将自动展示趋势图表</div>
        </div>
      </div>
    );
  }

  /* ---------- vchart spec ---------- */

  const spec: Partial<ILineChartSpec> = {
    type: 'line' as const,
    data: [{ id: 'data', values: flatData }],
    xField: 'date',
    yField: 'value',
    seriesField: 'site',
    point: {
      visible: flatData.length <= 60,
      style: { size: 6 },
    },
    line: {
      style: { lineWidth: 2, curveType: 'monotone' },
    },
    legends: {
      visible: true,
      orient: 'bottom',
      padding: { top: 12 },
      item: {
        shape: { style: { symbolType: 'circle' } },
        label: { style: { fontSize: 12 } },
      },
    },
    tooltip: {
      mark: {
        title: { value: (datum?: unknown) => String(getDatumRecord(datum).date ?? '') },
        content: [
          {
            key: (datum?: unknown) => String(getDatumRecord(datum).site ?? ''),
            value: (datum?: unknown) => {
              const row = getDatumRecord(datum);
              const v = Number(row.value ?? 0);
              return metric === 'spend' ? `$${v.toFixed(4)}` : String(v);
            },
          },
        ],
      },
      dimension: {
        title: { value: (datum?: unknown) => String(getDatumRecord(datum).date ?? '') },
        content: [
          {
            key: (datum?: unknown) => String(getDatumRecord(datum).site ?? ''),
            value: (datum?: unknown) => {
              const row = getDatumRecord(datum);
              const v = Number(row.value ?? 0);
              return metric === 'spend' ? `$${v.toFixed(4)}` : String(v);
            },
          },
        ],
      },
    },
    animation: false,
    axes: [
      {
        orient: 'bottom',
        label: { style: { fontSize: 11, fill: 'var(--color-text-muted)' } },
        domainLine: { style: { stroke: 'var(--color-border-light)' } },
        tick: { style: { stroke: 'var(--color-border-light)' } },
      },
      {
        orient: 'left',
        label: {
          style: { fontSize: 11, fill: 'var(--color-text-muted)' },
        },
        grid: { style: { stroke: 'var(--color-border-light)', lineDash: [4, 4] } },
        domainLine: { visible: false },
      },
    ],
    color: COLOR_PALETTE,
    background: 'transparent',
    padding: { left: 8, right: 16, top: 8, bottom: 8 },
  };

  /* ---------- render ---------- */

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <MetricToggle metric={metric} onChange={handleMetricChange} />
      </div>
      <div style={{ width: '100%', height: 320 }}>
        <Suspense fallback={<div className="skeleton" style={{ width: '100%', height: '100%', borderRadius: 'var(--radius-sm)' }} />}>
          <LineChartRenderer spec={spec} style={{ width: '100%', height: '100%' }} />
        </Suspense>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function MetricToggle({
  metric,
  onChange,
}: {
  metric: Metric;
  onChange: (m: Metric) => void;
}) {
  return (
    <div style={toggleGroupStyle}>
      {METRIC_OPTIONS.map((opt) => (
        <button
          key={opt.key}
          onClick={() => onChange(opt.key)}
          style={{
            ...toggleBtnBase,
            ...(metric === opt.key ? toggleBtnActive : toggleBtnInactive),
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Styles (inline, consistent with project conventions)               */
/* ------------------------------------------------------------------ */

const containerStyle: React.CSSProperties = {
  background: 'var(--color-bg-card)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-border-light)',
  boxShadow: 'var(--shadow-card)',
  padding: 20,
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 16,
};

const toggleGroupStyle: React.CSSProperties = {
  display: 'inline-flex',
  gap: 0,
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border)',
  overflow: 'hidden',
};

const toggleBtnBase: React.CSSProperties = {
  padding: '6px 16px',
  fontSize: 13,
  fontWeight: 500,
  cursor: 'pointer',
  border: 'none',
  transition: 'background-color 0.2s ease, color 0.2s ease',
  fontFamily: 'inherit',
};

const toggleBtnActive: React.CSSProperties = {
  background: 'var(--color-primary)',
  color: '#ffffff',
};

const toggleBtnInactive: React.CSSProperties = {
  background: 'var(--color-bg-card)',
  color: 'var(--color-text-secondary)',
};
