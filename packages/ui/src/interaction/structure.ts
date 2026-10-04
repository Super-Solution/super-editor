import type { BlockContent } from '@super-solution/editor-core';
import { LIMITS } from '@super-solution/editor-core';

/** Pure edits of list and table content. Every function returns new content and never mutates its input. */
export type ListContent = Extract<BlockContent, { type: 'list' }>;
export type TableContent = Extract<BlockContent, { type: 'table' }>;
export const MAX_LIST_INDENT = LIMITS.listIndent;

export const listChecked = (list: ListContent): boolean[] => list.items.map((_item, index) => list.checked?.[index] ?? false);
export const listIndent = (list: ListContent): number[] => list.items.map((_item, index) => list.indent?.[index] ?? 0);
/** Rebuilds a list from parallel arrays, keeping the optional `checked`/`indent` arrays only when meaningful. */
export function makeList(base: ListContent, items: string[], checked: boolean[], indent: number[]): ListContent {
  const next: ListContent = { type: 'list', ordered: base.ordered, items };
  if (base.style) next.style = base.style;
  if (base.style === 'todo') next.checked = checked;
  if (indent.some((value) => value > 0)) next.indent = indent;
  return next;
}
export function listSplice(list: ListContent, start: number, remove: number, insert: { text: string; checked?: boolean; indent?: number }[]): ListContent {
  const items = [...list.items], checked = listChecked(list), indent = listIndent(list);
  items.splice(start, remove, ...insert.map((entry) => entry.text));
  checked.splice(start, remove, ...insert.map((entry) => entry.checked ?? false));
  indent.splice(start, remove, ...insert.map((entry) => entry.indent ?? 0));
  return makeList(list, items, checked, indent);
}
export function listSetText(list: ListContent, index: number, text: string): ListContent { return makeList(list, list.items.map((item, at) => at === index ? text : item), listChecked(list), listIndent(list)); }
export function listSetChecked(list: ListContent, index: number, value: boolean): ListContent { return makeList(list, [...list.items], listChecked(list).map((entry, at) => at === index ? value : entry), listIndent(list)); }
/** Indent is limited to 0..3 and, like most editors, an item cannot be indented deeper than one level past the item above it. */
export function listSetIndent(list: ListContent, index: number, delta: number): ListContent | null {
  const indent = listIndent(list), current = indent[index];
  if (current === undefined) return null;
  const ceiling = index === 0 ? 0 : Math.min(MAX_LIST_INDENT, (indent[index - 1] ?? 0) + 1);
  const next = Math.max(0, Math.min(ceiling, current + delta));
  if (next === current) return null;
  // Indenting an item carries its deeper followers along so the visual nesting stays intact.
  const shift = next - current;
  const updated = [...indent];
  updated[index] = next;
  for (let at = index + 1; at < indent.length && (indent[at] ?? 0) > current; at++) updated[at] = Math.max(0, Math.min(MAX_LIST_INDENT, (indent[at] ?? 0) + shift));
  return makeList(list, [...list.items], listChecked(list), updated);
}
/** Ordinal labels for a numbered list, restarting deeper levels after a shallower item. */
export function listNumbers(list: ListContent): number[] {
  const counters: number[] = [];
  return list.items.map((_item, index) => {
    const level = list.indent?.[index] ?? 0;
    counters.length = level + 1;
    for (let at = 0; at <= level; at++) counters[at] = counters[at] ?? 0;
    counters[level] = (counters[level] ?? 0) + 1;
    return counters[level]!;
  });
}

export function tableAddRow(table: TableContent, at: number = table.rows.length): TableContent | null {
  if (table.rows.length >= LIMITS.tableRows || (table.rows.length + 1) * table.columns.length > LIMITS.tableCells) return null;
  const rows = [...table.rows], index = Math.max(0, Math.min(rows.length, at));
  rows.splice(index, 0, table.columns.map(() => ''));
  return { ...table, rows };
}
export function tableAddColumn(table: TableContent, at: number = table.columns.length): TableContent | null {
  if (table.columns.length >= LIMITS.tableColumns || table.rows.length * (table.columns.length + 1) > LIMITS.tableCells) return null;
  const index = Math.max(0, Math.min(table.columns.length, at));
  const insert = <T,>(list: readonly T[], value: T): T[] => { const copy = [...list]; copy.splice(index, 0, value); return copy; };
  const next: TableContent = { ...table, columns: insert(table.columns, `Column ${table.columns.length + 1}`), rows: table.rows.map((row) => insert(row, '')) };
  if (table.align) next.align = insert(table.align, 'left');
  return next;
}
export function tableRemoveRow(table: TableContent, index: number): TableContent | null {
  return index >= 0 && index < table.rows.length ? { ...table, rows: table.rows.filter((_row, at) => at !== index) } : null;
}
export function tableRemoveColumn(table: TableContent, index: number): TableContent | null {
  if (table.columns.length <= 1 || index < 0 || index >= table.columns.length) return null;
  const drop = <T,>(list: readonly T[]): T[] => list.filter((_entry, at) => at !== index);
  const next: TableContent = { ...table, columns: drop(table.columns), rows: table.rows.map((row) => drop(row)) };
  if (table.align) next.align = drop(table.align);
  return next;
}
export function tableSetAlign(table: TableContent, column: number, align: 'left' | 'center' | 'right'): TableContent | null {
  if (column < 0 || column >= table.columns.length) return null;
  const current = table.columns.map((_c, index) => table.align?.[index] ?? 'left');
  current[column] = align;
  return { ...table, align: current };
}
