import type { CSSProperties } from 'react';
import { LineChart } from '@visactor/react-vchart/esm/charts/LineChart';
import type { ILineChartSpec } from '@visactor/vchart';

export default function LineChartRenderer({
  spec,
  style,
}: {
  spec: Partial<ILineChartSpec>;
  style?: CSSProperties;
}) {
  return <LineChart {...spec} style={style} />;
}
