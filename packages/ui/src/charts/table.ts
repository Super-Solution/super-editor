import type { ChartSpec } from '@super-solution/editor-core';
import { defaultChartLabels, template, type ChartLabels } from './labels.js';

/** The accessible data-table fallback. Every kind has one, whether or not a renderer exists for it. */
export type ChartTable = {
  caption: string;
  headers: string[];
  /** Each row; the first cell is a row header. */
  rows: string[][];
};

const raw = (value: number | undefined): string => value === undefined ? '' : String(value);

export function chartDataTable(spec: ChartSpec, labels: ChartLabels = defaultChartLabels): ChartTable {
  const caption = `${spec.title}${spec.unit ? ` (${spec.unit})` : ''} — ${labels.dataSuffix}`;
  if (spec.kind === 'scatter' && spec.points?.length) {
    return { caption, headers: [labels.series, labels.x, labels.y], rows: spec.points.map((point) => [point.series, String(point.x), String(point.y)]) };
  }
  if (spec.kind === 'candlestick' && spec.ohlc?.length) {
    const volume = spec.ohlc.some((candle) => candle.v !== undefined);
    return {
      caption, headers: [labels.time, labels.open, labels.high, labels.low, labels.close, ...(volume ? [labels.volume] : [])],
      rows: spec.ohlc.map((candle) => [candle.t, String(candle.o), String(candle.h), String(candle.l), String(candle.c), ...(volume ? [raw(candle.v)] : [])]),
    };
  }
  if (spec.kind === 'heatmap' && spec.matrix) {
    const { rows, columns, values } = spec.matrix;
    return { caption, headers: [labels.row, ...columns], rows: rows.map((row, index) => [row, ...columns.map((_, column) => raw(values[index]?.[column]))]) };
  }
  return {
    caption, headers: [labels.label, ...spec.series.map((series) => series.name)],
    rows: spec.labels.map((label, index) => [label, ...spec.series.map((series) => raw(series.values[index]))]),
  };
}

/** One sentence describing what the chart shows, for aria-label and screen readers. */
export function describeChart(spec: ChartSpec, labels: ChartLabels = defaultChartLabels): string {
  const kind = labels.kindNames[spec.kind] ?? spec.kind;
  const count = spec.kind === 'scatter' && spec.points ? spec.points.length : spec.kind === 'candlestick' && spec.ohlc ? spec.ohlc.length : spec.kind === 'heatmap' && spec.matrix ? spec.matrix.rows.length * spec.matrix.columns.length : spec.labels.length;
  const noun = spec.kind === 'heatmap' ? 'cell' : spec.kind === 'candlestick' ? 'candle' : 'point';
  const seriesText = `${spec.series.length} series`;
  const pointsText = `${count} ${noun}${count === 1 ? '' : 's'}`;
  let sentence = `${spec.title}. ${template(labels.describe, { kind, series: seriesText, points: pointsText })}`;
  const first = spec.series[0];
  if (first && first.values.length && spec.kind !== 'heatmap' && spec.kind !== 'scatter' && spec.kind !== 'candlestick') {
    let min = Infinity, max = -Infinity;
    for (const value of first.values) { if (Number.isFinite(value)) { min = Math.min(min, value); max = Math.max(max, value); } }
    if (min <= max) sentence += ` ${template(labels.describeRange, { name: first.name, min, max })}`;
  }
  return sentence;
}
