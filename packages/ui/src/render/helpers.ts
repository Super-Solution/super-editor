import { getOutline, type OutlineItem, type ResearchDocument } from '@super-solution/editor-core';

/** Sections and headings flattened in reading order. `depth` is the nesting level for display (0 is the top). */
export type OutlineEntry = { id: string; title: string; level: number; type: 'heading' | 'section'; depth: number };
export function outlineEntries(report: ResearchDocument): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const walk = (items: readonly OutlineItem[], depth: number): void => {
    for (const item of items) { out.push({ id: item.id, title: item.title, level: item.level, type: item.type, depth }); walk(item.children, depth + 1); }
  };
  walk(getOutline(report), 0);
  return out;
}
