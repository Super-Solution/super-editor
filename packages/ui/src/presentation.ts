import type { Block, BlockContent, ChartSpec } from '@super-solution/editor-core';

export const chartColors = ['var(--se-chart-1, #282828)', 'var(--se-chart-2, #686868)', 'var(--se-chart-3, #9b9b9b)', 'var(--se-chart-4, #c6c6c6)', 'var(--se-chart-5, #484848)', 'var(--se-chart-6, #dedede)'];
export type ChartShape = {
  tag: 'rect' | 'path' | 'polyline' | 'circle' | 'line';
  attributes: Record<string, string | number>;
};
export type ChartModel = { shapes: ChartShape[]; message?: string };

/** Presentation only: every data value remains available in the accompanying table. */
export function getChartModel(spec: ChartSpec): ChartModel {
  const count = spec.labels.length;
  if (!count || !spec.series.length) return { shapes: [], message: 'No chart data.' };
  if (!['pie', 'bar', 'trend'].includes(spec.kind)) return { shapes: [], message: `No renderer registered for “${spec.kind}”.` };
  const values = spec.series.flatMap((series) => series.values);
  if (values.some((value) => !Number.isFinite(value)) || spec.series.some((series) => series.values.length !== count)) {
    return { shapes: [], message: 'Chart data is invalid.' };
  }
  if (spec.kind === 'pie') {
    const pieValues = spec.series[0]!.values;
    const total = pieValues.reduce((sum, value) => sum + value, 0);
    if (pieValues.some((value) => value < 0) || total <= 0 || !Number.isFinite(total)) return { shapes: [], message: 'Pie charts require nonnegative values with a finite positive total.' };
    let angle = -Math.PI / 2;
    const shapes: ChartShape[] = [];
    pieValues.forEach((value, index) => {
      if (!value) return;
      const next = angle + value / total * Math.PI * 2;
      const color = chartColors[index % chartColors.length]!;
      if (value === total) shapes.push({ tag: 'circle', attributes: { cx: 320, cy: 140, r: 110, fill: color } });
      else {
        const startX = 320 + 110 * Math.cos(angle), startY = 140 + 110 * Math.sin(angle);
        const endX = 320 + 110 * Math.cos(next), endY = 140 + 110 * Math.sin(next);
        shapes.push({ tag: 'path', attributes: { d: `M 320 140 L ${startX.toFixed(3)} ${startY.toFixed(3)} A 110 110 0 ${next - angle > Math.PI ? 1 : 0} 1 ${endX.toFixed(3)} ${endY.toFixed(3)} Z`, fill: color, stroke: 'white', 'stroke-width': 1 } });
      }
      angle = next;
    });
    return { shapes };
  }
  // Normalize first so a valid finite positive/negative range cannot overflow.
  const scale = values.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 1);
  let minimum = 0, maximum = 0;
  for (const value of values) { minimum = Math.min(minimum, value / scale); maximum = Math.max(maximum, value / scale); }
  if (maximum === minimum) { minimum -= 1; maximum += 1; }
  const y = (value: number) => 250 - (value / scale - minimum) / (maximum - minimum) * 220;
  const zero = y(0);
  const shapes: ChartShape[] = [{ tag: 'line', attributes: { x1: 35, x2: 620, y1: zero, y2: zero, stroke: 'var(--se-chart-axis, #999)', 'stroke-width': 1 } }];
  spec.series.forEach((series, seriesIndex) => {
    const color = chartColors[seriesIndex % chartColors.length]!;
    if (spec.kind === 'bar') {
      const slot = 570 / count, width = slot * .75 / spec.series.length;
      series.values.forEach((value, index) => {
        shapes.push({ tag: 'rect', attributes: { x: 42 + index * slot + seriesIndex * width, y: Math.min(zero, y(value)), width: Math.max(.5, width - 2), height: Math.max(.5, Math.abs(y(value) - zero)), fill: color } });
      });
    } else {
      const x = (index: number) => count === 1 ? 327 : 42 + index / (count - 1) * 570;
      shapes.push({ tag: 'polyline', attributes: { points: series.values.map((value, index) => `${x(index).toFixed(3)},${y(value).toFixed(3)}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2.5 } });
      series.values.forEach((value, index) => shapes.push({ tag: 'circle', attributes: { cx: x(index), cy: y(value), r: 3, fill: color } }));
    }
  });
  return { shapes };
}

export function editableText(block: Block): string | null {
  switch (block.content.type) {
    case 'paragraph': return block.content.runs.map((run) => run.text).join('');
    case 'heading': return block.content.text;
    case 'section': return block.content.title;
    default: return null;
  }
}

export function contentWithText(block: Block, text: string): BlockContent {
  if (editableText(block) === text) return block.content;
  switch (block.content.type) {
    case 'paragraph': return { type: 'paragraph', runs: [{ text }] };
    case 'heading': return { ...block.content, text };
    case 'section': return { type: 'section', title: text };
    default: throw new Error('This block is not editable as plain text.');
  }
}

let nextLocalId = 0;
export function localId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++nextLocalId}`}`;
}
