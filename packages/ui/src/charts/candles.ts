import { formatNumber } from './format.js';
import { bandScale, linearScale } from './scale.js';
import { line, rect, type SceneNode } from './scene.js';
import { describeChart } from './table.js';
import { annotationLayer, axisTitles, categoryAxisX, defaultYTitle, emptyLayout, maxLabelWidth, rowValue, safeRange, valueAxisY, yDomain, type AnnotationPoint } from './shared.js';
import type { ChartContext, ChartLayout, Hit, LegendItem, Rect } from './types.js';

const clamp = (value: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, value));

/** OHLC candles with wicks, optional volume bars and a hover band per candle. */
export function layoutCandles(ctx: ChartContext): ChartLayout {
  const { spec, paint } = ctx;
  const candles = (spec.ohlc ?? []).filter((candle) => [candle.o, candle.h, candle.l, candle.c].every(Number.isFinite));
  const description = describeChart(spec, ctx.labels);
  if (!candles.length) return emptyLayout(ctx, ctx.labels.noPoints, { description });
  const width = ctx.width, h = ctx.height || clamp(Math.round(width * (ctx.compact ? .7 : .55)), 240, 460);
  const volume = candles.some((candle) => candle.v !== undefined && Number.isFinite(candle.v));
  const annotated = (spec.annotations ?? []).filter((note) => candles.some((candle) => candle.t === note.at));
  const top = 14 + (annotated.length ? 26 : 0), xTitle = spec.xLabel, yTitle = defaultYTitle(ctx);
  const bottom = 24 + (xTitle ? 18 : 0);
  const totalHeight = Math.max(80, h - top - bottom);
  const volumeHeight = volume ? Math.round(totalHeight * .2) : 0;
  const priceHeight = totalHeight - volumeHeight - (volume ? 8 : 0);
  const [lo, hi] = safeRange(candles.flatMap((candle) => [candle.l, candle.h]));
  const axis = yDomain(ctx, lo, hi, priceHeight);
  const left = Math.max(34, Math.ceil(maxLabelWidth(axis.labels)) + 14 + (yTitle ? 16 : 0)), right = ctx.compact ? 10 : 16;
  const plot: Rect = { x: left, y: top, width: Math.max(40, width - left - right), height: totalHeight };
  const pricePlot: Rect = { ...plot, height: priceHeight };
  const y = linearScale(axis.domain, [pricePlot.y + pricePlot.height, pricePlot.y]);
  const yc = (value: number): number => y(clamp(value, axis.domain[0], axis.domain[1]));
  const band = bandScale(candles.length, [plot.x, plot.x + plot.width], .3, .15);
  const up = paint.token('up'), down = paint.token('down');
  const scene: SceneNode[] = [...valueAxisY(ctx, pricePlot, axis.ticks, axis.labels, y, false)];

  const vMax = volume ? Math.max(...candles.map((candle) => candle.v ?? 0), 1) : 0;
  const volumeY = linearScale([0, vMax], [plot.y + plot.height, plot.y + plot.height - volumeHeight]);
  candles.forEach((candle, index) => {
    const cx = band.center(index), rising = candle.c >= candle.o, color = rising ? up : down;
    scene.push(line(cx, yc(candle.h), cx, yc(candle.l), { stroke: color, 'stroke-width': 1.25 }));
    const y1 = yc(candle.o), y2 = yc(candle.c);
    scene.push(rect(band(index), Math.min(y1, y2), Math.max(1, band.bandwidth), Math.max(1, Math.abs(y1 - y2)), { fill: color, stroke: color, 'stroke-width': .5 }));
    if (volume && candle.v !== undefined) scene.push(rect(band(index), volumeY(candle.v), Math.max(1, band.bandwidth), Math.max(0, plot.y + plot.height - volumeY(candle.v)), { fill: color, 'fill-opacity': .38 }));
  });
  if (annotated.length) {
    const marks: AnnotationPoint[] = annotated.map((note) => { const index = candles.findIndex((candle) => candle.t === note.at); return { x: band.center(index), label: note.label, ...(note.value !== undefined ? { y: yc(note.value) } : {}) }; });
    scene.push(...annotationLayer(ctx, pricePlot, marks));
  }
  scene.push(...categoryAxisX(ctx, plot, candles.map((candle) => candle.t), (index) => band.center(index), band.step), ...axisTitles(ctx, plot, xTitle, yTitle));

  const hits: Hit[] = candles.map((candle, index) => {
    const cx = band.center(index), rising = candle.c >= candle.o, color = rising ? up : down;
    const change = candle.o === 0 ? undefined : (candle.c - candle.o) / Math.abs(candle.o) * 100;
    const x0 = band(index) - (band.step - band.bandwidth) / 2;
    return {
      id: String(index), shape: { type: 'rect', x: x0, y: plot.y, width: Math.max(1, band.step), height: plot.height }, anchor: { x: cx, y: yc(candle.h) }, title: candle.t,
      rows: [
        { color, label: ctx.labels.open, value: rowValue(ctx, candle.o) }, { color, label: ctx.labels.high, value: rowValue(ctx, candle.h) },
        { color, label: ctx.labels.low, value: rowValue(ctx, candle.l) }, { color, label: ctx.labels.close, value: rowValue(ctx, candle.c) },
        ...(change === undefined ? [] : [{ color, label: ctx.labels.change, value: `${change > 0 ? '+' : ''}${formatNumber(change, ctx.locale, 2)}%` }]),
        ...(candle.v !== undefined ? [{ color: paint.token('muted'), label: ctx.labels.volume, value: formatNumber(candle.v, ctx.locale) }] : []),
      ],
      crosshair: { x1: cx, y1: plot.y, x2: cx, y2: plot.y + plot.height },
      highlight: [rect(x0, plot.y, Math.max(1, band.step), plot.height, { fill: paint.token('band') })],
    };
  });
  const legend: LegendItem[] = [{ key: 'up', label: ctx.labels.up, color: up, hidden: false, toggle: false }, { key: 'down', label: ctx.labels.down, color: down, hidden: false, toggle: false }];
  return { kind: spec.kind, supported: true, width, height: h, scene, legend, hits, plot, description };
}
