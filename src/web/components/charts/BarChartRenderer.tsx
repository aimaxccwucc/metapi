import type { CSSProperties } from 'react';
import { BarChart } from '@visactor/react-vchart/esm/charts/BarChart';
import type { IBarChartSpec } from '@visactor/vchart';

export default function BarChartRenderer({
  spec,
  style,
}: {
  spec: Partial<IBarChartSpec>;
  style?: CSSProperties;
}) {
  return <BarChart {...spec} style={style} />;
}
