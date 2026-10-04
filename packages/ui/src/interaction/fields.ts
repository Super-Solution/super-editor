import type { BlockContent, InlineRun } from '@super-solution/editor-core';
import type { FieldKey } from './types.js';
import { runsFromText, runsPlainText } from './inline.js';

/** Text fields of each block type, addressed by FieldKey. Only paragraph, quote and callout bodies carry inline marks. */
export const itemField = (index: number): FieldKey => `item:${index}`;
export const cellField = (row: number, col: number): FieldKey => `cell:${row}:${col}`;
export type ParsedField = { kind: 'main' } | { kind: 'item'; index: number } | { kind: 'cell'; row: number; col: number };
export function parseField(key: FieldKey): ParsedField {
  if (key === 'main') return { kind: 'main' };
  const parts = key.split(':');
  if (parts[0] === 'item') return { kind: 'item', index: Number(parts[1]) };
  return { kind: 'cell', row: Number(parts[1]), col: Number(parts[2]) };
}
export function fieldKeys(content: BlockContent): FieldKey[] {
  switch (content.type) {
    case 'list': return content.items.map((_item, index) => itemField(index));
    case 'table': return [...content.columns.map((_c, col) => cellField(-1, col)), ...content.rows.flatMap((row, r) => row.map((_c, col) => cellField(r, col)))];
    case 'section': case 'toggle': case 'heading': case 'code': case 'paragraph': case 'quote': case 'callout': return ['main'];
    default: return [];
  }
}
export function hasRichField(content: BlockContent, key: FieldKey): boolean { return key === 'main' && (content.type === 'paragraph' || content.type === 'quote' || content.type === 'callout'); }
export function fieldRuns(content: BlockContent, key: FieldKey): InlineRun[] | null {
  return hasRichField(content, key) ? [...(content as Extract<BlockContent, { runs: InlineRun[] }>).runs] : null;
}
export function fieldText(content: BlockContent, key: FieldKey): string {
  const field = parseField(key);
  switch (content.type) {
    case 'section': case 'toggle': return field.kind === 'main' ? content.title : '';
    case 'heading': case 'code': return field.kind === 'main' ? content.text : '';
    case 'paragraph': case 'quote': case 'callout': return field.kind === 'main' ? runsPlainText(content.runs) : '';
    case 'list': return field.kind === 'item' ? content.items[field.index] ?? '' : '';
    case 'table': return field.kind === 'cell' ? (field.row < 0 ? content.columns[field.col] : content.rows[field.row]?.[field.col]) ?? '' : '';
    default: return '';
  }
}
/** Replaces one field's text. Rich fields lose their marks; use withFieldRuns to keep them. Returns the same content when nothing exists at `key`. */
export function withFieldText(content: BlockContent, key: FieldKey, text: string): BlockContent {
  const field = parseField(key);
  switch (content.type) {
    case 'section': case 'toggle': return field.kind === 'main' ? { ...content, title: text } : content;
    case 'heading': case 'code': return field.kind === 'main' ? { ...content, text } : content;
    case 'paragraph': case 'quote': case 'callout': return field.kind === 'main' ? { ...content, runs: runsFromText(text) } : content;
    case 'list': return field.kind === 'item' && field.index < content.items.length ? { ...content, items: content.items.map((item, index) => index === field.index ? text : item) } : content;
    case 'table': {
      if (field.kind !== 'cell') return content;
      if (field.row < 0) return field.col < content.columns.length ? { ...content, columns: content.columns.map((column, col) => col === field.col ? text : column) } : content;
      return content.rows[field.row]?.[field.col] === undefined ? content : { ...content, rows: content.rows.map((row, r) => r === field.row ? row.map((cell, col) => col === field.col ? text : cell) : row) };
    }
    default: return content;
  }
}
export function withFieldRuns(content: BlockContent, key: FieldKey, runs: InlineRun[]): BlockContent {
  return hasRichField(content, key) ? { ...content, runs } as BlockContent : withFieldText(content, key, runsPlainText(runs));
}
export function isTextBlock(type: BlockContent['type']): boolean { return type === 'paragraph' || type === 'quote' || type === 'callout'; }
/** Block types the interaction layer can edit in place. */
export const EDITABLE_TYPES: readonly BlockContent['type'][] = ['paragraph', 'heading', 'quote', 'callout', 'code', 'section', 'toggle', 'list', 'table'];
export function isEditableType(type: BlockContent['type']): boolean { return EDITABLE_TYPES.includes(type); }
export function plainTextOf(content: BlockContent): string {
  switch (content.type) {
    case 'list': return content.items.join('\n');
    case 'table': return [content.columns.join('\t'), ...content.rows.map((row) => row.join('\t'))].join('\n');
    case 'chart': return content.spec.title;
    case 'embed': return content.title;
    case 'image': return content.alt;
    case 'timestamp': return content.label;
    case 'metrics': return content.items.map((item) => `${item.label}: ${item.value}`).join('\n');
    case 'divider': case 'toc': case 'pageBreak': return '';
    default: return fieldText(content, 'main');
  }
}
export function isEmptyContent(content: BlockContent): boolean {
  switch (content.type) {
    case 'paragraph': case 'quote': case 'callout': return runsPlainText(content.runs) === '' && !content.runs.some((run) => run.citationId !== undefined);
    case 'heading': case 'code': return content.text === '';
    case 'section': case 'toggle': return content.title === '';
    case 'list': return content.items.every((item) => item === '');
    default: return false;
  }
}
