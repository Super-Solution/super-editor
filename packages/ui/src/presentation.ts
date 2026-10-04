import type { Block, BlockContent, ChartSpec } from '@super-solution/editor-core';
import { layoutChart } from './charts/layout.js';
import { flatten } from './charts/scene.js';

export type ChartShape = {
  tag: 'rect' | 'path' | 'polyline' | 'circle' | 'line' | 'text';
  attributes: Record<string, string | number>;
  /** Present on `text` shapes. */
  text?: string;
};
export type ChartModel = { shapes: ChartShape[]; message?: string };

/**
 * Flat geometry for a chart at the default width, kept for hosts that draw charts themselves.
 * For the full layout (legend, hover targets, accessible description) use `layoutChart`.
 */
export function getChartModel(spec: ChartSpec): ChartModel {
  const layout = layoutChart(spec);
  const shapes = flatten(layout.scene).flatMap((node): ChartShape[] =>
    node.tag === 'rect' || node.tag === 'path' || node.tag === 'polyline' || node.tag === 'circle' || node.tag === 'line' || node.tag === 'text'
      ? [{ tag: node.tag, attributes: node.attrs, ...(node.text === undefined ? {} : { text: node.text }) }] : []);
  return { shapes, ...(layout.message ? { message: layout.message } : {}) };
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
