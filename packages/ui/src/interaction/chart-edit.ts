import { CHART_KINDS } from '@super-solution/editor-core';
import type { ChartSpec } from '@super-solution/editor-core';

/** Quick edits for a chart block: title, kind, caption, source and bar layout. Data stays untouched. */
export type ChartPatch = {
  title?: string; kind?: string; caption?: string; source?: string; unit?: string; xLabel?: string; yAxisLabel?: string;
  stacked?: boolean; horizontal?: boolean;
};
/** Kinds the chart's current data can be drawn as without losing or inventing data. The current kind is always included. */
export function compatibleChartKinds(spec: ChartSpec): string[] {
  const single = spec.series.length === 1, values = spec.series[0]?.values ?? [];
  const nonNegative = single && values.every((value) => value >= 0);
  const kinds = CHART_KINDS.filter((kind) => {
    switch (kind) {
      case 'bar': case 'line': case 'area': case 'trend': return true;
      case 'pie': case 'donut': return nonNegative && values.some((value) => value > 0);
      case 'histogram': return nonNegative;
      case 'waterfall': return single;
      case 'scatter': return !!spec.points?.length;
      case 'candlestick': return !!spec.ohlc?.length;
      case 'heatmap': return !!spec.matrix;
    }
  }) as string[];
  return kinds.includes(spec.kind) ? kinds : [spec.kind, ...kinds];
}
const optional = (value: string): string | undefined => value.trim() === '' ? undefined : value;
export function patchChartSpec(spec: ChartSpec, patch: ChartPatch): ChartSpec {
  const next: ChartSpec = { ...spec };
  const set = <K extends 'caption' | 'source' | 'unit' | 'xLabel'>(key: K, value: string | undefined): void => {
    if (value === undefined) return;
    const text = optional(value);
    if (text === undefined) delete next[key]; else next[key] = text;
  };
  if (patch.title !== undefined) next.title = patch.title;
  if (patch.kind !== undefined) next.kind = patch.kind;
  set('caption', patch.caption); set('source', patch.source); set('unit', patch.unit); set('xLabel', patch.xLabel);
  if (patch.yAxisLabel !== undefined) {
    const label = optional(patch.yAxisLabel), { label: _previous, ...axis } = spec.yAxis ?? {};
    if (label !== undefined) next.yAxis = { ...axis, label }; else if (Object.keys(axis).length) next.yAxis = axis; else delete next.yAxis;
  }
  for (const key of ['stacked', 'horizontal'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value) next[key] = true; else delete next[key];
  }
  return next;
}
