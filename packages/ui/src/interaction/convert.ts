import type { BlockContent, CalloutTone, InlineRun } from '@super-solution/editor-core';
import { runsFromText, runsPlainText } from './inline.js';

/** "Turn into": changes a block's type while keeping its text (and inline marks where both sides carry them). */
export type TurnIntoTarget = 'paragraph' | 'heading1' | 'heading2' | 'heading3' | 'bullet' | 'number' | 'todo' | 'quote' | 'callout' | 'code' | 'toggle' | 'section';
export type TurnIntoEntry = { id: TurnIntoTarget; label: string; icon: string };
export const TURN_INTO_TARGETS: readonly TurnIntoEntry[] = [
  { id: 'paragraph', label: 'Text', icon: 'T' }, { id: 'heading1', label: 'Heading 1', icon: 'H1' }, { id: 'heading2', label: 'Heading 2', icon: 'H2' }, { id: 'heading3', label: 'Heading 3', icon: 'H3' },
  { id: 'bullet', label: 'Bulleted list', icon: '•' }, { id: 'number', label: 'Numbered list', icon: '1.' }, { id: 'todo', label: 'To-do list', icon: '☐' },
  { id: 'quote', label: 'Quote', icon: '“' }, { id: 'callout', label: 'Callout', icon: 'i' }, { id: 'code', label: 'Code', icon: '</>' },
  { id: 'toggle', label: 'Toggle', icon: '▸' }, { id: 'section', label: 'Section', icon: '§' },
];
/** The target a content already is, so menus can mark it current and skip no-op conversions. */
export function targetOf(content: BlockContent): TurnIntoTarget | null {
  switch (content.type) {
    case 'paragraph': return 'paragraph';
    case 'heading': return content.level === 1 ? 'heading1' : content.level === 2 ? 'heading2' : 'heading3';
    case 'list': return content.style === 'todo' ? 'todo' : content.ordered ? 'number' : 'bullet';
    case 'quote': return 'quote';
    case 'callout': return 'callout';
    case 'code': return 'code';
    case 'toggle': return 'toggle';
    case 'section': return 'section';
    default: return null;
  }
}
type Source = { runs: InlineRun[] | null; lines: string[]; perLine: boolean };
function sourceOf(content: BlockContent): Source | null {
  switch (content.type) {
    case 'paragraph': case 'quote': case 'callout': return { runs: content.runs, lines: runsPlainText(content.runs).split('\n'), perLine: false };
    case 'heading': return { runs: null, lines: [content.text], perLine: false };
    case 'section': case 'toggle': return { runs: null, lines: [content.title], perLine: false };
    case 'code': return { runs: null, lines: content.text.split('\n'), perLine: false };
    case 'list': return { runs: null, lines: content.items.length ? content.items : [''], perLine: true };
    default: return null;
  }
}
export function isConvertible(content: BlockContent): boolean { return sourceOf(content) !== null; }
/** Containers keep their children, so they can only become another container. */
export function canTurnInto(content: BlockContent, target: TurnIntoTarget, hasChildren = false): boolean {
  if (!isConvertible(content) || targetOf(content) === target) return false;
  return !(hasChildren && target !== 'toggle' && target !== 'section');
}
const clamp = (text: string, max: number): string => text.length > max ? text.slice(0, max) : text;
export function blankContent(target: TurnIntoTarget, tone: CalloutTone = 'info'): BlockContent {
  switch (target) {
    case 'paragraph': return { type: 'paragraph', runs: [] };
    case 'heading1': return { type: 'heading', level: 1, text: '' };
    case 'heading2': return { type: 'heading', level: 2, text: '' };
    case 'heading3': return { type: 'heading', level: 3, text: '' };
    case 'bullet': return { type: 'list', ordered: false, style: 'bullet', items: [''] };
    case 'number': return { type: 'list', ordered: true, style: 'number', items: [''] };
    case 'todo': return { type: 'list', ordered: false, style: 'todo', items: [''], checked: [false] };
    case 'quote': return { type: 'quote', runs: [] };
    case 'callout': return { type: 'callout', tone, runs: [] };
    case 'code': return { type: 'code', language: '', text: '' };
    case 'toggle': return { type: 'toggle', title: '', open: true };
    case 'section': return { type: 'section', title: '' };
  }
}
const single = (target: TurnIntoTarget, runs: InlineRun[] | null, text: string, tone?: CalloutTone): BlockContent => {
  const flat = text.replace(/\n/g, ' ');
  switch (target) {
    case 'paragraph': return { type: 'paragraph', runs: runs ?? runsFromText(text) };
    case 'heading1': case 'heading2': case 'heading3': return { type: 'heading', level: target === 'heading1' ? 1 : target === 'heading2' ? 2 : 3, text: flat };
    case 'quote': return { type: 'quote', runs: runs ?? runsFromText(text) };
    case 'callout': return { type: 'callout', tone: tone ?? 'info', runs: runs ?? runsFromText(text) };
    case 'code': return { type: 'code', language: '', text };
    case 'toggle': return { type: 'toggle', title: clamp(flat, 1_000), open: true };
    case 'section': return { type: 'section', title: clamp(flat, 1_000) };
    default: return blankContent(target);
  }
};
/**
 * Returns the converted content plus `extra` blocks to insert right after it (a multi-item list turned into text yields one block per item).
 * Marks survive text-to-text conversions between paragraph, quote and callout; headings, lists and code hold plain text.
 */
export function convertContent(content: BlockContent, target: TurnIntoTarget, tone?: CalloutTone): { content: BlockContent; extra: BlockContent[] } | null {
  const source = sourceOf(content);
  if (!source || targetOf(content) === target) return null;
  if (target === 'bullet' || target === 'number' || target === 'todo') {
    const items = source.lines.map((line) => clamp(line, 10_000));
    const indent = content.type === 'list' && content.indent ? { indent: [...content.indent] } : {};
    if (target === 'todo') return { content: { type: 'list', ordered: false, style: 'todo', items, checked: items.map(() => false), ...indent }, extra: [] };
    return { content: { type: 'list', ordered: target === 'number', style: target === 'number' ? 'number' : 'bullet', items, ...indent }, extra: [] };
  }
  if (source.perLine && source.lines.length > 1) {
    const [first, ...rest] = source.lines;
    return { content: single(target, null, first ?? '', tone), extra: rest.map((line) => single(target, null, line, tone)) };
  }
  const text = source.runs ? runsPlainText(source.runs) : source.lines.join('\n');
  return { content: single(target, target === 'paragraph' || target === 'quote' || target === 'callout' ? source.runs : null, text, tone), extra: [] };
}
