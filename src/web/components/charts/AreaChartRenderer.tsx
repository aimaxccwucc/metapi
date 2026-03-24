import type { CSSProperties } from 'react';
import { AreaChart } from '@visactor/react-vchart/esm/charts/AreaChart';
import type { IAreaChartSpec } from '@visactor/vchart';

export default function AreaChartRenderer({
  spec,
  style,
}: {
  spec: Partial<IAreaChartSpec>;
  style?: CSSProperties;
}) {
  return <AreaChart {...spec} style={style} />;
}
