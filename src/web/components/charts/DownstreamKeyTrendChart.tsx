import React, { Suspense, lazy, startTransition, useMemo, useState } from 'react';
import type { IAreaChartSpec } from '@visactor/vchart';

const AreaChartRenderer = lazy(() => import('./AreaChartRenderer.js'));

type Metric = 'tokens' | 'requests' | 'cost';

const METRIC_OPTIONS: Array<{ key: Metric; label: string }> = [
  { key: 'tokens', label: 'Tokens' },
  { key: 'requests', label: '请求数' },
  { key: 'cost', label: '成本' },
];

function getDatumRecord(datum: unknown): Record<string, unknown> {
  return datum && typeof datum === 'object' ? datum as Record<string, unknown> : {};
}

export type DownstreamKeyTrendBucket = {
  startUtc: string | null;
  totalRequests: number;
  totalTokens: number;
  totalCost: number;
  successRate: number | null;
};

export default function DownstreamKeyTrendChart({
  buckets,
  loading,
  height = 260,
}: {
  buckets: DownstreamKeyTrendBucket[];
  loading?: boolean;
  height?: number;
}) {
  const [metric, setMetric] = useState<Metric>('tokens');

  const handleMetricChange = (nextMetric: Metric) => {
    if (nextMetric === metric) return;
    startTransition(() => {
      setMetric(nextMetric);
    });
  };

  const flatData = useMemo(() => {
    if (!Array.isArray(buckets) || buckets.length === 0) return [];
    return buckets
      .map((bucket) => {
        const date = bucket.startUtc || '';
        const value = metric === 'tokens'
          ? Number(bucket.totalTokens || 0)
          : (metric === 'requests'
            ? Number(bucket.totalRequests || 0)
            : Number(bucket.totalCost || 0));
        return { date, value };
      })
      .filter((row) => row.date.length > 0);
  }, [buckets, metric]);

  if (loading) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <div className="skeleton" style={{ width: 160, height: 30, borderRadius: 'var(--radius-sm)' }} />
        </div>
        <div className="skeleton" style={{ width: '100%', height, borderRadius: 'var(--radius-sm)' }} />
      </div>
    );
  }

  if (!flatData || flatData.length === 0) {
    return (
      <div style={containerStyle}>
        <div style={headerStyle}>
          <MetricToggle metric={metric} onChange={handleMetricChange} />
        </div>
        <div className="empty-state" style={{ padding: 32 }}>
          <div className="empty-state-title">暂无趋势数据</div>
          <div className="empty-state-desc">该 Key 在所选时间范围内没有可用的 tokens 记录</div>
        </div>
      </div>
    );
  }

  const spec: Partial<IAreaChartSpec> = {
    type: 'area' as const,
    data: [{ id: 'data', values: flatData }],
    xField: 'date',
    yField: 'value',
    area: {
      style: {
        curveType: 'monotone',
        fillOpacity: 0.2,
      },
    },
    line: {
      style: {
        curveType: 'monotone',
        lineWidth: 2,
      },
    },
    point: { visible: false },
    axes: [
      {
        orient: 'bottom',
        label: { style: { fontSize: 11, fill: 'var(--color-text-muted)' } },
        domainLine: { style: { stroke: 'var(--color-border-light)' } },
        tick: { style: { stroke: 'var(--color-border-light)' } },
      },
      {
        orient: 'left',
        label: { style: { fontSize: 11, fill: 'var(--color-text-muted)' } },
        grid: { style: { stroke: 'var(--color-border-light)', lineDash: [4, 4] } },
        domainLine: { visible: false },
      },
    ],
    tooltip: {
      dimension: {
        title: { value: (datum?: unknown) => String(getDatumRecord(datum).date || '') },
        content: [
          {
            key: () => METRIC_OPTIONS.find((opt) => opt.key === metric)?.label || 'Value',
            value: (datum?: unknown) => {
              const value = Number(getDatumRecord(datum).value ?? 0);
              if (metric === 'cost') return `$${value.toFixed(6)}`;
              return value.toLocaleString();
            },
          },
        ],
      },
    },
    color: ['var(--color-primary)'],
    background: 'transparent',
    animation: false,
    padding: { left: 8, right: 16, top: 8, bottom: 8 },
  };

  return (
    <div style={containerStyle}>
      <div style={headerStyle}>
        <MetricToggle metric={metric} onChange={handleMetricChange} />
      </div>
      <div style={{ width: '100%', height }}>
        <Suspense fallback={<div className="skeleton" style={{ width: '100%', height: '100%', borderRadius: 'var(--radius-sm)' }} />}>
          <AreaChartRenderer spec={spec} style={{ width: '100%', height: '100%' }} />
        </Suspense>
      </div>
    </div>
  );
}

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

const containerStyle: React.CSSProperties = {
  background: 'var(--color-bg-card)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-border-light)',
  boxShadow: 'var(--shadow-card)',
  padding: 16,
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: 10,
};

const toggleGroupStyle: React.CSSProperties = {
  display: 'inline-flex',
  gap: 0,
  borderRadius: 'var(--radius-sm)',
  border: '1px solid var(--color-border)',
  overflow: 'hidden',
};

const toggleBtnBase: React.CSSProperties = {
  padding: '6px 12px',
  fontSize: 12,
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
