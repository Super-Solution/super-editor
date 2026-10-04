import type { ChartSpec } from '@super-solution/editor-core';
import { formatTick, formatValue, type FormatOptions } from './format.js';
import { resolveChartLabels } from './labels.js';
import { createPaint, type Paint } from './palette.js';
import { MAGNITUDE_CAP, niceTicks, textWidth, truncate, type LinearScale, type Ticks } from './scale.js';
import { circle, line, text, type SceneNode } from './scene.js';
import type { ChartContext, ChartLayout, ChartLayoutOptions, LegendItem, Rect } from './types.js';

export const FONT = 11;
export const DEFAULT_WIDTH = 640;
export const MIN_WIDTH = 160;

export function makeContext(spec: ChartSpec, options: ChartLayoutOptions = {}): ChartContext {
  const width = Math.max(MIN_WIDTH, Math.min(4000, Math.round(options.width ?? DEFAULT_WIDTH)));
  const locale = options.locale ?? 'en-US';
  const labels = resolveChartLabels(options.labels);
  const format: FormatOptions = { format: spec.yAxis?.format, currency: spec.yAxis?.currency, unit: spec.unit, locale };
  return { spec, width, height: options.height ?? 0, paint: options.paint ?? createPaint(), locale, labels, hidden: options.hidden ?? new Set(), format, compact: width < 420 };
}

export type VisibleSeries = { name: string; values: number[]; index: number; key: string; color: string };
export function allSeries(ctx: ChartContext): VisibleSeries[] {
  return ctx.spec.series.map((series, index) => ({ name: series.name, values: series.values, index, key: String(index), color: ctx.paint.series(index, series.color) }));
}
export function visibleSeries(ctx: ChartContext): VisibleSeries[] { return allSeries(ctx).filter((series) => !ctx.hidden.has(series.key)); }
export function seriesLegend(ctx: ChartContext): LegendItem[] {
  if (ctx.spec.series.length < 2) return [];
  return allSeries(ctx).map((series) => ({ key: series.key, label: series.name, color: series.color, hidden: ctx.hidden.has(series.key), toggle: true }));
}

export function isFiniteNumbers(values: readonly number[]): boolean { return values.every((value) => Number.isFinite(value)); }

export function emptyLayout(ctx: ChartContext, message: string, extra: Partial<ChartLayout> = {}): ChartLayout {
  return { kind: ctx.spec.kind, supported: extra.supported ?? true, message, width: ctx.width, height: ctx.height || 120, scene: [], legend: [], hits: [], plot: { x: 0, y: 0, width: ctx.width, height: ctx.height || 120 }, description: '', ...extra };
}

export const textStyle = (ctx: ChartContext, extra: Record<string, string | number> = {}): Record<string, string | number> => ({ 'font-size': FONT, fill: ctx.paint.token('muted'), ...extra });
export const haloStyle = (ctx: ChartContext): Record<string, string | number> => ({ stroke: ctx.paint.token('surface'), 'stroke-width': 3, 'stroke-linejoin': 'round', 'paint-order': 'stroke' });

export function tickTarget(length: number, compact: boolean): number { return Math.max(2, Math.min(compact ? 5 : 8, Math.round(length / 48))); }

export function yDomain(ctx: ChartContext, lo: number, hi: number, length: number): { ticks: Ticks; domain: [number, number]; labels: string[] } {
  const { yAxis } = ctx.spec;
  const base = niceFor(lo, hi, length, ctx.compact);
  const min = yAxis?.min ?? base.min, max = yAxis?.max ?? base.max;
  const domain: [number, number] = min < max ? [min, max] : [base.min, base.max];
  const ticks: Ticks = { ...base, ticks: base.ticks.filter((tick) => tick >= domain[0] - base.step * 1e-6 && tick <= domain[1] + base.step * 1e-6) };
  if (!ticks.ticks.length) ticks.ticks = [domain[0], domain[1]];
  return { ticks, domain, labels: ticks.ticks.map((tick) => formatTick(tick, base.step, ctx.format)) };
}
function niceFor(lo: number, hi: number, length: number, compact: boolean): Ticks { return niceTicks(lo, hi, tickTarget(length, compact)); }

export function maxLabelWidth(labels: readonly string[], size = FONT): number {
  let widest = 0;
  for (const label of labels) widest = Math.max(widest, textWidth(label, size));
  return widest;
}

/** Horizontal grid lines + tick labels for a vertical value axis. */
export function valueAxisY(ctx: ChartContext, plot: Rect, ticks: Ticks, labels: readonly string[], y: LinearScale, zero: boolean): SceneNode[] {
  const nodes: SceneNode[] = [];
  ticks.ticks.forEach((tick, index) => {
    const position = y(tick);
    nodes.push(line(plot.x, position, plot.x + plot.width, position, { stroke: ctx.paint.token('grid'), 'stroke-width': 1 }));
    nodes.push(text(plot.x - 6, position + 3.5, labels[index] ?? '', textStyle(ctx, { 'text-anchor': 'end' })));
  });
  const base = zero && y.domain[0] <= 0 && y.domain[1] >= 0 ? y(0) : plot.y + plot.height;
  nodes.push(line(plot.x, base, plot.x + plot.width, base, { stroke: ctx.paint.token('axis'), 'stroke-width': 1 }));
  return nodes;
}
/** Vertical grid lines + tick labels for a horizontal value axis (horizontal bars, scatter x). */
export function valueAxisX(ctx: ChartContext, plot: Rect, ticks: Ticks, labels: readonly string[], x: LinearScale, zero: boolean): SceneNode[] {
  const nodes: SceneNode[] = [];
  ticks.ticks.forEach((tick, index) => {
    const position = x(tick);
    nodes.push(line(position, plot.y, position, plot.y + plot.height, { stroke: ctx.paint.token('grid'), 'stroke-width': 1 }));
    nodes.push(text(position, plot.y + plot.height + 15, labels[index] ?? '', textStyle(ctx, { 'text-anchor': 'middle' })));
  });
  const base = zero && x.domain[0] <= 0 && x.domain[1] >= 0 ? x(0) : plot.x;
  nodes.push(line(base, plot.y, base, plot.y + plot.height, { stroke: ctx.paint.token('axis'), 'stroke-width': 1 }));
  return nodes;
}
/** Category labels along the bottom axis; thins them out so they never collide. */
export function categoryAxisX(ctx: ChartContext, plot: Rect, labels: readonly string[], centers: (index: number) => number, step: number): SceneNode[] {
  const widest = Math.min(maxLabelWidth(labels), 140);
  const stride = Math.max(1, Math.ceil((widest + 8) / Math.max(1, step)));
  const nodes: SceneNode[] = [];
  const max = Math.max(24, step * stride - 6);
  labels.forEach((label, index) => {
    if (index % stride !== 0) return;
    const content = truncate(label, max, FONT);
    const node = text(centers(index), plot.y + plot.height + 15, content, textStyle(ctx, { 'text-anchor': 'middle' }));
    if (content !== label) node.children = [{ tag: 'title', attrs: {}, text: label }];
    nodes.push(node);
  });
  return nodes;
}
export function categoryAxisY(ctx: ChartContext, plot: Rect, labels: readonly string[], centers: (index: number) => number, maxWidth: number): SceneNode[] {
  return labels.map((label, index) => {
    const content = truncate(label, maxWidth, FONT);
    const node = text(plot.x - 6, centers(index) + 3.5, content, textStyle(ctx, { 'text-anchor': 'end' }));
    if (content !== label) node.children = [{ tag: 'title', attrs: {}, text: label }];
    return node;
  });
}
export function axisTitles(ctx: ChartContext, plot: Rect, xTitle: string | undefined, yTitle: string | undefined): SceneNode[] {
  const nodes: SceneNode[] = [];
  if (xTitle) nodes.push(text(plot.x + plot.width / 2, plot.y + plot.height + (ctx.compact ? 32 : 34), xTitle, textStyle(ctx, { 'text-anchor': 'middle', 'font-weight': 600 })));
  if (yTitle) { const cx = 12, cy = plot.y + plot.height / 2; nodes.push(text(cx, cy, yTitle, textStyle(ctx, { 'text-anchor': 'middle', 'font-weight': 600, transform: `rotate(-90 ${cx} ${cy})` }))); }
  return nodes;
}
export function defaultYTitle(ctx: ChartContext): string | undefined {
  const { yAxis, unit } = ctx.spec;
  return yAxis?.label ?? (unit && unit !== '%' && yAxis?.format !== 'currency' ? unit : undefined);
}

export type AnnotationPoint = { x: number; y?: number; label: string };
/** Dashed markers with halo-ed labels, stacked into lanes so neighbours do not overprint. */
export function annotationLayer(ctx: ChartContext, plot: Rect, points: readonly AnnotationPoint[], orientation: 'vertical' | 'horizontal' = 'vertical'): SceneNode[] {
  const nodes: SceneNode[] = [];
  const ink = ctx.paint.token('text');
  const ends: number[] = [];
  [...points].sort((a, b) => a.x - b.x).forEach((point) => {
    if (orientation === 'vertical') {
      const width = textWidth(point.label, FONT) + 8;
      let lane = ends.findIndex((end) => end + 6 <= point.x - 4);
      if (lane < 0) lane = ends.length < 2 ? ends.length : ends.indexOf(Math.min(...ends));
      ends[lane] = point.x - 4 + width;
      const anchorRight = point.x - 4 + width > plot.x + plot.width + 10;
      nodes.push(line(point.x, plot.y, point.x, plot.y + plot.height, { stroke: ink, 'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: .7 }));
      nodes.push(text(anchorRight ? point.x + 4 : point.x - 4 + 8, plot.y - 6 - lane * 12, point.label, { 'font-size': FONT, fill: ink, 'font-weight': 600, 'text-anchor': anchorRight ? 'end' : 'start', ...haloStyle(ctx) }));
      if (point.y !== undefined) nodes.push(circle(point.x, point.y, 4.5, { fill: ctx.paint.token('surface'), stroke: ink, 'stroke-width': 2 }));
    } else {
      nodes.push(line(plot.x, point.x, plot.x + plot.width, point.x, { stroke: ink, 'stroke-width': 1, 'stroke-dasharray': '4 3', opacity: .7 }));
      nodes.push(text(plot.x + plot.width - 4, point.x - 4, point.label, { 'font-size': FONT, fill: ink, 'font-weight': 600, 'text-anchor': 'end', ...haloStyle(ctx) }));
    }
  });
  return nodes;
}

export function rowValue(ctx: ChartContext, value: number): string { return formatValue(value, ctx.format); }
export function safeRange(values: readonly number[]): [number, number] {
  let lo = Infinity, hi = -Infinity;
  for (const value of values) { if (!Number.isFinite(value)) continue; const v = Math.max(-MAGNITUDE_CAP, Math.min(MAGNITUDE_CAP, value)); if (v < lo) lo = v; if (v > hi) hi = v; }
  return lo > hi ? [0, 1] : [lo, hi];
}
export type { Paint };
