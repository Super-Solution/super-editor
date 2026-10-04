import { formatNumber } from './format.js';
import { linearScale, textWidth } from './scale.js';
import { circle, type SceneNode } from './scene.js';
import { describeChart } from './table.js';
import { axisTitles, defaultYTitle, emptyLayout, maxLabelWidth, rowValue, valueAxisX, valueAxisY, yDomain, safeRange } from './shared.js';
import type { ChartContext, ChartLayout, Hit, LegendItem, Rect } from './types.js';

export function layoutScatter(ctx: ChartContext): ChartLayout {
  const { spec, paint } = ctx;
  const points = (spec.points ?? []).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!points.length) return emptyLayout(ctx, ctx.labels.noPoints, { description: describeChart(spec, ctx.labels) });
  const names = [...new Set(points.map((point) => point.series))];
  const colors = names.map((name, index) => {
    const declared = spec.series.find((series) => series.name === name);
    return paint.series(index, declared?.color);
  });
  const legend: LegendItem[] = names.length > 1 ? names.map((name, index) => ({ key: String(index), label: name, color: colors[index]!, hidden: ctx.hidden.has(String(index)), toggle: true })) : [];
  const visible = points.filter((point) => !ctx.hidden.has(String(names.indexOf(point.series))));
  const description = describeChart(spec, ctx.labels);
  if (!visible.length) return emptyLayout(ctx, ctx.labels.allHidden, { legend, description });

  const width = ctx.width, h = ctx.height || Math.round(Math.max(220, Math.min(width * (ctx.compact ? .75 : .6), 440)));
  const xTitle = spec.xLabel, yTitle = defaultYTitle(ctx);
  const top = 14, bottom = 24 + (xTitle ? 18 : 0);
  // Pad the data range a little so points on the extremes are not clipped by the plot edge.
  const padded = (range: [number, number]): [number, number] => { const gap = (range[1] - range[0]) * .06 || Math.abs(range[0]) * .06 || 1; return [range[0] - gap, range[1] + gap]; };
  const [yLo, yHi] = padded(safeRange(visible.map((point) => point.y))), [xLo, xHi] = padded(safeRange(visible.map((point) => point.x)));
  const yAxis = yDomain(ctx, yLo, yHi, h - top - bottom);
  const { yAxis: _yAxis, ...withoutAxis } = spec; void _yAxis;
  const xAxis = yDomain({ ...ctx, spec: withoutAxis, format: { locale: ctx.locale } }, xLo, xHi, width * .8);
  const left = Math.max(30, Math.ceil(maxLabelWidth(yAxis.labels)) + 14 + (yTitle ? 16 : 0)), right = Math.max(16, Math.ceil(textWidth(xAxis.labels.at(-1) ?? '', 11) / 2) + 6);
  const plot: Rect = { x: left, y: top, width: Math.max(40, width - left - right), height: Math.max(40, h - top - bottom) };
  const y = linearScale(yAxis.domain, [plot.y + plot.height, plot.y]), x = linearScale(xAxis.domain, [plot.x, plot.x + plot.width]);
  const scene: SceneNode[] = [...valueAxisY(ctx, plot, yAxis.ticks, yAxis.labels, y, true), ...valueAxisX(ctx, plot, xAxis.ticks, xAxis.labels, x, true)];
  const radius = visible.length > 500 ? 2.5 : visible.length > 150 ? 3.5 : 4.5;
  const hits: Hit[] = [];
  const xName = spec.xLabel ?? ctx.labels.x, yName = spec.yAxis?.label ?? ctx.labels.y;
  visible.forEach((point, index) => {
    const color = colors[names.indexOf(point.series)]!;
    const cx = x(point.x), cy = y(point.y);
    scene.push(circle(cx, cy, radius, { fill: color, 'fill-opacity': .75, stroke: color, 'stroke-width': 1 }));
    hits.push({
      id: String(index), shape: { type: 'circle', cx, cy, r: Math.max(radius + 6, 12) }, anchor: { x: cx, y: cy }, title: point.series,
      rows: [{ color, label: xName, value: formatNumber(point.x, ctx.locale) }, { color, label: yName, value: rowValue(ctx, point.y) }],
      markers: [{ cx, cy, r: radius + 3, color }],
    });
  });
  scene.push(...axisTitles(ctx, plot, xTitle, yTitle));
  return { kind: spec.kind, supported: true, width, height: h, scene, legend, hits, plot, description };
}
