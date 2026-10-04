import { formatNumber, formatValue } from './format.js';
import { template } from './labels.js';
import { arcPath, circle, path, text, type SceneNode } from './scene.js';
import { describeChart } from './table.js';
import { FONT, emptyLayout, haloStyle } from './shared.js';
import type { ChartContext, ChartLayout, Hit, LegendItem } from './types.js';

/** Pie and donut. Uses the first series; legend items are the slices and can be toggled. */
export function layoutRadial(ctx: ChartContext): ChartLayout {
  const { spec, paint } = ctx;
  const donut = spec.kind === 'donut';
  const first = spec.series[0];
  if (!spec.labels.length || !first) return emptyLayout(ctx, ctx.labels.noData);
  const values = first.values;
  if (values.length !== spec.labels.length || spec.series.some((series) => series.values.length !== spec.labels.length || series.values.some((value) => !Number.isFinite(value)))) return emptyLayout(ctx, ctx.labels.invalidData);
  const total = values.reduce((sum, value) => sum + value, 0);
  if (values.some((value) => value < 0) || total <= 0 || !Number.isFinite(total)) return emptyLayout(ctx, ctx.labels.pieInvalid);

  const colors = spec.labels.map((_, index) => paint.series(index));
  const legend: LegendItem[] = spec.labels.map((label, index) => ({ key: String(index), label, color: colors[index]!, hidden: ctx.hidden.has(String(index)), toggle: true }));
  const shown = values.map((value, index) => ctx.hidden.has(String(index)) ? 0 : value);
  const shownTotal = shown.reduce((sum, value) => sum + value, 0);
  const note = spec.series.length > 1 ? template(ctx.labels.pieExtraSeries, { name: first.name }) : undefined;
  const width = ctx.width, size = ctx.height || Math.round(Math.max(200, Math.min(width * (ctx.compact ? .8 : .55), 340)));
  const plot = { x: 0, y: 0, width, height: size };
  const description = describeChart(spec, ctx.labels);
  if (shownTotal <= 0) return emptyLayout(ctx, ctx.labels.allHidden, { legend, description, height: size, plot });

  const cx = width / 2, cy = size / 2, outer = Math.max(20, Math.min(width, size) / 2 - 10), inner = donut ? outer * .6 : 0;
  const scene: SceneNode[] = [];
  const hits: Hit[] = [];
  let angle = -Math.PI / 2;
  shown.forEach((value, index) => {
    if (value <= 0) return;
    const sweep = value / shownTotal * Math.PI * 2, end = angle + sweep, mid = angle + sweep / 2;
    const share = value / shownTotal;
    const stroke = { stroke: paint.token('surface'), 'stroke-width': 1.5, 'stroke-linejoin': 'round' };
    scene.push(path(arcPath(cx, cy, inner, outer, angle, end), { fill: colors[index]!, ...stroke, 'data-slice': index }));
    if (share >= .06) {
      const radius = donut ? (inner + outer) / 2 : outer * .65;
      scene.push(text(cx + radius * Math.cos(mid), cy + radius * Math.sin(mid) + 4, `${formatNumber(share * 100, ctx.locale, share * 100 < 10 ? 1 : 0)}%`, { 'font-size': FONT + 1, 'font-weight': 600, fill: '#ffffff', 'text-anchor': 'middle', stroke: 'rgba(0,0,0,.45)', 'stroke-width': 2.5, 'paint-order': 'stroke', 'stroke-linejoin': 'round' }));
    }
    const pull = 6;
    hits.push({
      id: String(index), shape: { type: 'arc', cx, cy, inner, outer, start: angle, end },
      anchor: { x: cx + (outer * .8) * Math.cos(mid), y: cy + (outer * .8) * Math.sin(mid) },
      title: spec.labels[index]!,
      rows: [{ color: colors[index]!, label: first.name, value: formatValue(values[index]!, ctx.format) }, { color: paint.token('muted'), label: ctx.labels.share, value: `${formatNumber(share * 100, ctx.locale, 1)}%` }],
      highlight: [path(arcPath(cx, cy, inner, outer + pull, angle, end), { fill: colors[index]!, stroke: paint.token('surface'), 'stroke-width': 1.5, opacity: .95 })],
    });
    angle = end;
  });
  if (donut) {
    scene.push(circle(cx, cy, inner - 1, { fill: 'none' }));
    scene.push(text(cx, cy + 2, formatValue(shownTotal, ctx.format), { 'font-size': 18, 'font-weight': 700, fill: paint.token('text'), 'text-anchor': 'middle' }));
    scene.push(text(cx, cy + 20, ctx.labels.total, { 'font-size': FONT, fill: paint.token('muted'), 'text-anchor': 'middle', ...haloStyle(ctx) }));
  }
  return { kind: spec.kind, supported: true, ...(note ? { note } : {}), width, height: size, scene, legend, hits, plot, description };
}
