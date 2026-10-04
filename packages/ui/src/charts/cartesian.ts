import { describeChart } from './table.js';
import { bandScale, linearScale, pointScale, type LinearScale } from './scale.js';
import { circle, line, linePath, path, polyline, rect, type SceneNode } from './scene.js';
import {
  annotationLayer, axisTitles, categoryAxisX, categoryAxisY, defaultYTitle, emptyLayout, isFiniteNumbers, maxLabelWidth, rowValue, safeRange,
  seriesLegend, valueAxisX, valueAxisY, visibleSeries, yDomain, type AnnotationPoint, type VisibleSeries,
} from './shared.js';
import type { ChartContext, ChartLayout, Hit, LegendItem, Rect, TooltipRow } from './types.js';

export type WaterfallStep = { start: number; end: number; delta: number; running: number; role: 'up' | 'down' | 'total' };
const TOTAL_LABEL = /^(?:total|subtotal|net|end|ending|final|result|sum|balance|closing)\b/i;
const START_LABEL = /^(?:start|starting|begin|beginning|open|opening|initial|base|baseline)\b/i;

/**
 * Waterfall steps. A step is a "total" bar (drawn from zero) when its label names a total or its value equals the
 * running total so far; every other bar is a signed change from the running total.
 */
export function waterfallSteps(labels: readonly string[], values: readonly number[]): WaterfallStep[] {
  const steps: WaterfallStep[] = [];
  let running = 0;
  values.forEach((value, index) => {
    const same = Math.abs(value - running) <= 1e-9 * Math.max(1, Math.abs(running));
    const total = index === 0 ? START_LABEL.test(labels[0] ?? '') : TOTAL_LABEL.test(labels[index] ?? '') || (same && index === values.length - 1);
    if (total) { steps.push({ start: 0, end: value, delta: value - running, running: value, role: 'total' }); running = value; return; }
    const start = running; running += value;
    steps.push({ start, end: running, delta: value, running, role: value >= 0 ? 'up' : 'down' });
  });
  return steps;
}

function height(ctx: ChartContext, fallback: number): number { return ctx.height || fallback; }
const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));
const sign = (ctx: ChartContext, value: number): string => `${value > 0 ? '+' : ''}${rowValue(ctx, value)}`;

export function layoutCartesian(ctx: ChartContext): ChartLayout {
  const { spec } = ctx;
  const kind = spec.kind === 'trend' ? 'line' : spec.kind;
  const count = spec.labels.length;
  if (!count || !spec.series.length) return emptyLayout(ctx, ctx.labels.noData);
  if (spec.series.some((series) => series.values.length !== count || !isFiniteNumbers(series.values))) return emptyLayout(ctx, ctx.labels.invalidData);
  const waterfall = kind === 'waterfall';
  const legend: LegendItem[] = waterfall
    ? [{ key: 'up', label: ctx.labels.increase, color: ctx.paint.token('up'), hidden: false, toggle: false }, { key: 'down', label: ctx.labels.decrease, color: ctx.paint.token('down'), hidden: false, toggle: false }, { key: 'total', label: ctx.labels.total, color: ctx.paint.token('neutral'), hidden: false, toggle: false }]
    : kind === 'histogram' ? [] : seriesLegend(ctx);
  const series = waterfall ? visibleSeries({ ...ctx, hidden: new Set() }).slice(0, 1) : visibleSeries(ctx);
  const description = describeChart(spec, ctx.labels);
  if (!series.length) return emptyLayout(ctx, ctx.labels.allHidden, { legend, description });
  if (kind === 'bar' && spec.horizontal) return horizontalBars(ctx, series, legend, description);
  return vertical(ctx, kind, series, legend, description);
}

function domainFor(ctx: ChartContext, kind: string, series: readonly VisibleSeries[], count: number, steps: WaterfallStep[] | null): [number, number] {
  const stacked = (kind === 'bar' || kind === 'area') && ctx.spec.stacked === true;
  if (steps) return safeRange([0, ...steps.flatMap((step) => [step.start, step.end])]);
  if (stacked) {
    let lo = 0, hi = 0;
    for (let index = 0; index < count; index++) {
      let positive = 0, negative = 0;
      for (const item of series) { const value = item.values[index] ?? 0; if (value >= 0) positive += value; else negative += value; }
      hi = Math.max(hi, positive); lo = Math.min(lo, negative);
    }
    return [lo, hi];
  }
  const [min, max] = safeRange(series.flatMap((item) => item.values));
  if (kind === 'line') {
    // Prices and indices should not be dragged down to zero; counts and percentages usually should.
    return min >= 0 && max > 0 && min / max < .25 ? [0, max] : [min, max];
  }
  return [Math.min(0, min), Math.max(0, max)];
}

function vertical(ctx: ChartContext, kind: string, series: VisibleSeries[], legend: LegendItem[], description: string): ChartLayout {
  const { spec, paint } = ctx;
  const count = spec.labels.length, width = ctx.width;
  const annotated = (spec.annotations ?? []).filter((note) => spec.labels.includes(note.at));
  const h = height(ctx, clamp(Math.round(width * (ctx.compact ? .66 : .5)), 220, 400));
  const top = 14 + (annotated.length ? 26 : 0), yTitle = defaultYTitle(ctx), xTitle = spec.xLabel;
  const bottom = 24 + (xTitle ? 18 : 0);
  const waterfall = kind === 'waterfall';
  const steps = waterfall ? waterfallSteps(spec.labels, series[0]!.values) : null;
  const [lo, hi] = domainFor(ctx, kind, series, count, steps);
  const plotHeight = Math.max(40, h - top - bottom);
  const axis = yDomain(ctx, lo, hi, plotHeight);
  const left = Math.max(30, Math.ceil(maxLabelWidth(axis.labels)) + 14 + (yTitle ? 16 : 0)), right = ctx.compact ? 10 : 16;
  const plot: Rect = { x: left, y: top, width: Math.max(40, width - left - right), height: plotHeight };
  const y: LinearScale = linearScale(axis.domain, [plot.y + plot.height, plot.y]);
  const yc = (value: number): number => y(clamp(value, axis.domain[0], axis.domain[1]));
  const barLike = kind === 'bar' || kind === 'histogram' || waterfall;
  const band = bandScale(count, [plot.x, plot.x + plot.width], kind === 'histogram' ? .04 : count > 60 ? .1 : .3, kind === 'histogram' ? 0 : .15);
  const points = pointScale(count, [plot.x, plot.x + plot.width], count === 1 ? 0 : Math.min(24, plot.width / (2 * count)));
  const center = (index: number): number => barLike ? band.center(index) : points(index);
  const step = barLike ? band.step : count === 1 ? plot.width : points.step;
  const stacked = (kind === 'bar' || kind === 'area') && spec.stacked === true;

  const scene: SceneNode[] = [...valueAxisY(ctx, plot, axis.ticks, axis.labels, y, true)];
  const shapes: SceneNode[] = [];
  const stackTop = new Map<number, number[]>();
  const positive = new Array<number>(count).fill(0), negative = new Array<number>(count).fill(0);
  if (kind === 'bar' || kind === 'histogram') {
    const groups = stacked ? 1 : series.length;
    series.forEach((item, seriesIndex) => {
      item.values.forEach((value, index) => {
        let from = 0, to = value;
        if (stacked) { if (value >= 0) { from = positive[index]!; positive[index]! += value; to = positive[index]!; } else { from = negative[index]!; negative[index]! += value; to = negative[index]!; } }
        const sliceWidth = band.bandwidth / groups;
        const x = band(index) + (stacked ? 0 : seriesIndex * sliceWidth);
        const y1 = yc(from), y2 = yc(to);
        shapes.push(rect(x, Math.min(y1, y2), Math.max(.5, sliceWidth - (groups > 1 && sliceWidth > 4 ? 1 : 0)), Math.max(Math.abs(y1 - y2), value === 0 ? 0 : .5), { fill: item.color, ...(kind === 'histogram' ? { stroke: paint.token('surface'), 'stroke-width': 1 } : {}), rx: sliceWidth > 8 ? 2 : 0, 'data-series': item.index }));
      });
    });
  } else if (waterfall && steps) {
    const color = (role: WaterfallStep['role']): string => paint.token(role === 'total' ? 'neutral' : role);
    steps.forEach((entry, index) => {
      const y1 = yc(entry.start), y2 = yc(entry.end);
      shapes.push(rect(band(index), Math.min(y1, y2), Math.max(.5, band.bandwidth), Math.max(Math.abs(y1 - y2), .75), { fill: color(entry.role), rx: band.bandwidth > 8 ? 2 : 0 }));
      const next = steps[index + 1];
      if (next) shapes.push(line(band(index) + band.bandwidth, yc(entry.end), band(index + 1), yc(entry.end), { stroke: paint.token('axis'), 'stroke-width': 1, 'stroke-dasharray': '2 2' }));
    });
  } else {
    const accumulated = new Array<number>(count).fill(0);
    const drawn = kind === 'area' ? [...series].reverse() : series;
    const bases = new Map<number, number[]>(), tops = new Map<number, number[]>();
    if (stacked) {
      series.forEach((item) => { const low = [...accumulated]; item.values.forEach((value, index) => { accumulated[index]! += value; }); bases.set(item.index, low); tops.set(item.index, [...accumulated]); });
    }
    for (const item of drawn) {
      const upper = tops.get(item.index) ?? item.values, lower = bases.get(item.index);
      const coordinates = upper.map((value, index) => [center(index), yc(value)] as const);
      if (kind === 'area') {
        const baseline = yc(Math.max(axis.domain[0], Math.min(0, axis.domain[1])));
        const back = lower ? lower.map((value, index) => [center(index), yc(value)] as const).reverse() : [[center(count - 1), baseline], [center(0), baseline]] as const;
        shapes.push(path(`${linePath(coordinates)} ${back.map(([px, py]) => `L${px.toFixed(2)} ${py.toFixed(2)}`).join(' ')} Z`, { fill: item.color, 'fill-opacity': stacked ? .55 : .18, stroke: 'none' }));
      }
      shapes.push(count === 1 ? circle(coordinates[0]![0], coordinates[0]![1], 4, { fill: item.color }) : polyline(coordinates, { fill: 'none', stroke: item.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'data-series': item.index }));
      if (count <= (ctx.compact ? 20 : 40) && count > 1) coordinates.forEach(([px, py]) => shapes.push(circle(px, py, 3, { fill: item.color, stroke: paint.token('surface'), 'stroke-width': 1 })));
      stackTop.set(item.index, upper);
    }
  }
  scene.push(...shapes);

  if (annotated.length) {
    const marks: AnnotationPoint[] = annotated.map((note) => {
      const index = spec.labels.indexOf(note.at);
      return { x: center(index), label: note.label, ...(note.value !== undefined ? { y: yc(note.value) } : {}) };
    });
    scene.push(...annotationLayer(ctx, plot, marks));
  }
  const xLabels = categoryAxisX(ctx, plot, spec.labels, center, step);
  scene.push(...xLabels, ...axisTitles(ctx, plot, xTitle, yTitle));

  // Hover: one band per category.
  const hits: Hit[] = [];
  for (let index = 0; index < count; index++) {
    const cx = center(index);
    const x0 = clamp(cx - step / 2, plot.x, plot.x + plot.width), x1 = clamp(cx + step / 2, plot.x, plot.x + plot.width);
    const rows: TooltipRow[] = [];
    let anchorY = plot.y + plot.height;
    if (steps) {
      const entry = steps[index]!;
      rows.push({ color: paint.token(entry.role === 'total' ? 'neutral' : entry.role), label: entry.role === 'total' ? ctx.labels.total : ctx.labels.change, value: entry.role === 'total' ? rowValue(ctx, entry.end) : sign(ctx, entry.delta) });
      if (entry.role !== 'total') rows.push({ color: paint.token('neutral'), label: ctx.labels.runningTotal, value: rowValue(ctx, entry.running) });
      anchorY = Math.min(yc(entry.start), yc(entry.end));
    } else {
      series.forEach((item) => { rows.push({ color: item.color, label: item.name, value: rowValue(ctx, item.values[index]!) }); anchorY = Math.min(anchorY, yc(item.values[index]!)); });
      if (stacked) anchorY = yc(kind === 'area' ? Math.max(...series.map((item) => stackTop.get(item.index)?.[index] ?? 0)) : positive[index]!);
      if (stacked && series.length > 1) rows.push({ color: paint.token('muted'), label: ctx.labels.total, value: rowValue(ctx, series.reduce((sum, item) => sum + item.values[index]!, 0)) });
    }
    const markers = !barLike ? series.map((item) => ({ cx, cy: yc(stackTop.get(item.index)?.[index] ?? item.values[index]!), r: 4.5, color: item.color })) : undefined;
    hits.push({
      id: String(index), shape: { type: 'rect', x: x0, y: plot.y, width: Math.max(1, x1 - x0), height: plot.height }, anchor: { x: cx, y: anchorY },
      title: spec.labels[index]!, rows,
      ...(barLike ? { highlight: [rect(x0, plot.y, Math.max(1, x1 - x0), plot.height, { fill: paint.token('band') })] } : { crosshair: { x1: cx, y1: plot.y, x2: cx, y2: plot.y + plot.height } }),
      ...(markers ? { markers } : {}),
    });
  }
  return { kind: spec.kind, supported: true, width, height: h, scene, legend, hits, plot, description };
}

function horizontalBars(ctx: ChartContext, series: VisibleSeries[], legend: LegendItem[], description: string): ChartLayout {
  const { spec, paint } = ctx;
  const count = spec.labels.length, width = ctx.width;
  const stacked = spec.stacked === true, groups = stacked ? 1 : series.length;
  const h = height(ctx, clamp(count * (groups * 14 + 12) + 64, 180, 900));
  const valueTitle = defaultYTitle(ctx), categoryTitle = spec.xLabel;
  const top = 8, bottom = 24 + (valueTitle ? 18 : 0);
  const plotHeight = Math.max(40, h - top - bottom);
  const [lo, hi] = domainFor(ctx, 'bar', series, count, null);
  const axis = yDomain(ctx, lo, hi, width * .6);
  const categoryWidth = Math.min(Math.max(40, width * .32), Math.ceil(maxLabelWidth(spec.labels)) + 2);
  const left = Math.ceil(categoryWidth) + 12 + (categoryTitle ? 16 : 0), right = ctx.compact ? 14 : 24;
  const plot: Rect = { x: left, y: top, width: Math.max(40, width - left - right), height: plotHeight };
  const x = linearScale(axis.domain, [plot.x, plot.x + plot.width]);
  const xc = (value: number): number => x(clamp(value, axis.domain[0], axis.domain[1]));
  const band = bandScale(count, [plot.y, plot.y + plot.height], .3, .15);
  const scene: SceneNode[] = [...valueAxisX(ctx, plot, axis.ticks, axis.labels, x, true)];
  const positive = new Array<number>(count).fill(0), negative = new Array<number>(count).fill(0);
  series.forEach((item, seriesIndex) => {
    item.values.forEach((value, index) => {
      let from = 0, to = value;
      if (stacked) { if (value >= 0) { from = positive[index]!; positive[index]! += value; to = positive[index]!; } else { from = negative[index]!; negative[index]! += value; to = negative[index]!; } }
      const thickness = band.bandwidth / groups;
      const x1 = xc(from), x2 = xc(to);
      scene.push(rect(Math.min(x1, x2), band(index) + (stacked ? 0 : seriesIndex * thickness), Math.max(Math.abs(x1 - x2), value === 0 ? 0 : .5), Math.max(.5, thickness - (groups > 1 && thickness > 4 ? 1 : 0)), { fill: item.color, rx: thickness > 8 ? 2 : 0, 'data-series': item.index }));
    });
  });
  const annotated = (spec.annotations ?? []).filter((note) => spec.labels.includes(note.at));
  if (annotated.length) scene.push(...annotationLayer(ctx, plot, annotated.map((note) => ({ x: band.center(spec.labels.indexOf(note.at)), label: note.label })), 'horizontal'));
  scene.push(...categoryAxisY(ctx, plot, spec.labels, (index) => band.center(index), categoryWidth));
  scene.push(...axisTitles(ctx, plot, valueTitle, categoryTitle));
  const hits: Hit[] = spec.labels.map((label, index) => {
    const y0 = band(index) - (band.step - band.bandwidth) / 2;
    const rows = series.map((item) => ({ color: item.color, label: item.name, value: rowValue(ctx, item.values[index]!) }));
    if (stacked && series.length > 1) rows.push({ color: paint.token('muted'), label: ctx.labels.total, value: rowValue(ctx, series.reduce((sum, item) => sum + item.values[index]!, 0)) });
    const furthest = Math.max(...series.map((item) => xc(stacked ? positive[index]! : item.values[index]!)), plot.x);
    return { id: String(index), shape: { type: 'rect' as const, x: plot.x, y: y0, width: plot.width, height: Math.max(1, band.step) }, anchor: { x: furthest, y: band.center(index) }, title: label, rows, highlight: [rect(plot.x, y0, plot.width, Math.max(1, band.step), { fill: paint.token('band') })] };
  });
  return { kind: spec.kind, supported: true, width, height: h, scene, legend, hits, plot, description };
}
