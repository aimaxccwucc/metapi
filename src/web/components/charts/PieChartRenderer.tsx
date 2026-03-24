import type { CSSProperties } from 'react';
import { PieChart } from '@visactor/react-vchart/esm/charts/PieChart';
import type { IPieChartSpec } from '@visactor/vchart';

export default function PieChartRenderer({
  spec,
  style,
}: {
  spec: Partial<IPieChartSpec>;
  style?: CSSProperties;
}) {
  return <PieChart {...spec} style={style} />;
}
