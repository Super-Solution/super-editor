import { formatNumber, formatTick } from './format.js';
import { mixHex, pickInk, tokenFallbacks, type TokenName } from './palette.js';
import { truncate } from './scale.js';
import { rect, text, type SceneNode } from './scene.js';
import { describeChart } from './table.js';
import { FONT, emptyLayout, maxLabelWidth, textStyle } from './shared.js';
import type { ChartContext, ChartLayout, Hit, Rect } from './types.js';

/**
 * Fill of a heat cell for `value` in `min..max` (sequential, or diverging when the range crosses zero), and the label ink for it.
 * The ink is whichever of the dark and light ink tokens has the higher WCAG contrast on the cell, and the first of them to reach
 * 4.5:1 when only one does. The cell is judged by the colors the tokens really have (`paint.value`): exact in a static export,
 * and the live page values in the browser (see `readTokenColors`), so a dark theme or a host palette gets readable labels too.
 */
export function heatColor(ctx: ChartContext, value: number, min: number, max: number): { fill: string; ink: string; printInk?: 'dark' | 'light' } {
  const { paint } = ctx;
  const diverging = min < 0 && max > 0;
  const limit = Math.max(Math.abs(min), Math.abs(max)) || 1;
  const t = diverging ? Math.abs(value) / limit : (max === min ? .5 : (value - min) / (max - min));
  const end: TokenName = diverging && value < 0 ? 'heatNeg' : 'heatPos';
  const fill = paint.mix('heatMid', end, t);
  const background = mixHex(paint.value('heatMid'), paint.value(end), t);
  const dark = paint.value('inkDark'), light = paint.value('inkLight');
  const ink = pickInk(background, { color: dark, value: paint.token('inkDark') }, { color: light, value: paint.token('inkLight') });
  if (paint.mode === 'static') return { fill, ink };
  // Printing swaps in the light palette whatever the screen theme (print.css), so the page also needs the ink that suits those cells.
  const paper = mixHex(tokenFallbacks.heatMid.light, tokenFallbacks[end].light, t);
  return { fill, ink, printInk: pickInk<'dark' | 'light'>(paper, { color: dark, value: 'dark' }, { color: light, value: 'light' }) };
}

export function layoutHeatmap(ctx: ChartContext): ChartLayout {
  const { spec, paint } = ctx;
  const matrix = spec.matrix;
  const description = describeChart(spec, ctx.labels);
  if (!matrix || !matrix.rows.length || !matrix.columns.length) return emptyLayout(ctx, ctx.labels.noData, { description });
  const { rows, columns, values } = matrix;
  const cells = values.flat();
  if (cells.some((cell) => !Number.isFinite(cell))) return emptyLayout(ctx, ctx.labels.invalidData, { description });
  const width = ctx.width;
  const rowLabelWidth = Math.min(Math.max(30, width * .28), Math.ceil(maxLabelWidth(rows)) + 4);
  const legendWidth = ctx.compact ? 0 : 56;
  const left = Math.ceil(rowLabelWidth) + 10, right = legendWidth + 12, top = 8;
  const plotWidth = Math.max(40, width - left - right);
  const cellWidth = plotWidth / columns.length;
  const cellHeight = Math.max(16, Math.min(44, cellWidth * .8, 28 + (ctx.compact ? 0 : 6)));
  const bottom = 26 + (spec.xLabel ? 18 : 0) + (ctx.compact ? 40 : 0);
  const plot: Rect = { x: left, y: top, width: plotWidth, height: rows.length * cellHeight };
  const h = ctx.height || Math.ceil(top + plot.height + bottom);
  let min = Infinity, max = -Infinity;
  for (const cell of cells) { min = Math.min(min, cell); max = Math.max(max, cell); }
  const showValues = cellWidth >= 34 && cellHeight >= 16;
  const decimals = cells.every((cell) => Number.isInteger(cell)) ? 0 : max - min > 100 ? 0 : 2;
  const scene: SceneNode[] = [];
  const hits: Hit[] = [];
  const fontSize = Math.min(FONT, cellHeight - 5);
  rows.forEach((row, r) => {
    const label = truncate(row, rowLabelWidth, FONT);
    const node = text(plot.x - 6, plot.y + r * cellHeight + cellHeight / 2 + 3.5, label, textStyle(ctx, { 'text-anchor': 'end' }));
    if (label !== row) node.children = [{ tag: 'title', attrs: {}, text: row }];
    scene.push(node);
    columns.forEach((column, c) => {
      const value = values[r]![c]!;
      const { fill, ink, printInk } = heatColor(ctx, value, min, max);
      const x = plot.x + c * cellWidth, y = plot.y + r * cellHeight;
      scene.push(rect(x, y, Math.max(0, cellWidth - 1), Math.max(0, cellHeight - 1), { fill, rx: 2 }));
      if (showValues) scene.push(text(x + cellWidth / 2, y + cellHeight / 2 + fontSize / 2.8, formatNumber(value, ctx.locale, decimals), { 'font-size': fontSize, fill: ink, 'text-anchor': 'middle', ...(printInk ? { 'data-print-ink': printInk } : {}) }));
      hits.push({
        id: `${r}:${c}`, shape: { type: 'rect', x, y, width: cellWidth, height: cellHeight }, anchor: { x: x + cellWidth / 2, y },
        title: `${row} × ${column}`, rows: [{ color: fill, label: ctx.labels.value, value: formatNumber(value, ctx.locale) }],
        highlight: [rect(x, y, Math.max(0, cellWidth - 1), Math.max(0, cellHeight - 1), { fill: 'none', stroke: paint.token('text'), 'stroke-width': 2, rx: 2 })],
      });
    });
  });
  const stride = Math.max(1, Math.ceil((Math.min(maxLabelWidth(columns), 90) + 6) / cellWidth));
  columns.forEach((column, c) => {
    if (c % stride !== 0) return;
    const label = truncate(column, Math.max(24, cellWidth * stride - 4), FONT);
    scene.push(text(plot.x + c * cellWidth + cellWidth / 2, plot.y + plot.height + 15, label, textStyle(ctx, { 'text-anchor': 'middle' })));
  });
  if (spec.xLabel) scene.push(text(plot.x + plot.width / 2, plot.y + plot.height + 34, spec.xLabel, textStyle(ctx, { 'text-anchor': 'middle', 'font-weight': 600 })));
  // Color bar.
  const barX = plot.x + plot.width + 14, steps = 24, barHeight = Math.min(plot.height, 140), barY = plot.y;
  if (legendWidth) {
    for (let step = 0; step < steps; step++) {
      const value = max - (max - min) * (step / (steps - 1));
      scene.push(rect(barX, barY + step * (barHeight / steps), 12, barHeight / steps + .5, { fill: heatColor(ctx, value, min, max).fill }));
    }
    const step = (max - min) / 4 || 1;
    scene.push(text(barX + 17, barY + 9, formatTick(max, step, { locale: ctx.locale }), textStyle(ctx)), text(barX + 17, barY + barHeight, formatTick(min, step, { locale: ctx.locale }), textStyle(ctx)));
  }
  return { kind: spec.kind, supported: true, width, height: h, scene, legend: [], hits, plot, description };
}
