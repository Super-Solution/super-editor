import { safeUrl } from '@super-solution/editor-core';
import type { Block, BlockContent, CalloutTone, Citation, Highlight, InlineRun, ResearchDocument } from '@super-solution/editor-core';
import { outlineEntries, type OutlineEntry } from './helpers.js';

/* Pure view-models shared by the DOM and React renderers, so both emit the same structure. */

export type EmbedPolicy = { enabled: boolean; allowedOrigins: readonly string[] };
/** An embed is permitted only after an explicit exact HTTPS-origin allowlist match. */
export function allowedEmbedUrl(input: string, policy?: EmbedPolicy): string | null {
  if (!policy?.enabled) return null;
  const safe = safeUrl(input, { httpsOnly: true });
  if (!safe) return null;
  const origin = new URL(safe).origin;
  return policy.allowedOrigins.some((entry) => {
    const allowed = safeUrl(entry, { httpsOnly: true });
    if (!allowed) return false;
    const parsed = new URL(allowed);
    return parsed.origin === origin && parsed.pathname === '/' && !parsed.search && !parsed.hash;
  }) ? safe : null;
}
export const DEFAULT_EMBED_HEIGHT = 380;
export const embedHeight = (height: number | undefined): number => Math.max(200, Math.min(1200, Math.round(height ?? DEFAULT_EMBED_HEIGHT)));

/* ---- inline runs ---- */
export type RunSegment = {
  text: string; code: boolean; italic: boolean; bold: boolean; strike: boolean; underline: boolean;
  highlight?: Highlight; href?: string; unsafeHref: boolean;
  citation?: { id: string; number: number; citation: Citation | undefined };
};
/** 1-based number of a citation in the document's source list, or 0 when it is missing. */
export function citationNumber(citations: readonly Citation[], id: string): number { return citations.findIndex((citation) => citation.id === id) + 1; }
export function runSegments(runs: readonly InlineRun[], citations: readonly Citation[]): RunSegment[] {
  return runs.map((run) => {
    const href = run.href === undefined ? undefined : safeUrl(run.href) ?? undefined;
    return {
      text: run.text, code: run.code === true, italic: run.italic === true, bold: run.bold === true, strike: run.strike === true, underline: run.underline === true,
      ...(run.highlight ? { highlight: run.highlight } : {}), ...(href ? { href } : {}), unsafeHref: run.href !== undefined && !href,
      ...(run.citationId ? { citation: { id: run.citationId, number: citationNumber(citations, run.citationId), citation: citations.find((citation) => citation.id === run.citationId) } } : {}),
    };
  });
}

/* ---- lists ---- */
export type ListItemNode = { text: string; index: number; checked: boolean | undefined; children: ListItemNode[] };
export type ListModel = { style: 'bullet' | 'number' | 'todo'; items: ListItemNode[] };
export function listModel(content: Extract<BlockContent, { type: 'list' }>): ListModel {
  const style = content.style ?? (content.ordered ? 'number' : 'bullet');
  const root: ListItemNode[] = [];
  // path[d] is the most recent item at depth d; an item may nest at most one level below the previous one.
  let path: ListItemNode[] = [];
  content.items.forEach((text, index) => {
    const depth = Math.min(Math.max(0, Math.min(3, content.indent?.[index] ?? 0)), path.length);
    path = path.slice(0, depth);
    const node: ListItemNode = { text, index, checked: style === 'todo' ? content.checked?.[index] === true : undefined, children: [] };
    (depth === 0 ? root : path[depth - 1]!.children).push(node);
    path.push(node);
  });
  return { style, items: root };
}

/* ---- tables ---- */
export type Alignment = 'left' | 'center' | 'right';
export type TableModel = {
  caption: string | undefined; headerColumn: boolean;
  columns: { label: string; align: Alignment; numeric: boolean }[];
  rows: { cells: { text: string; header: boolean; align: Alignment; numeric: boolean }[] }[];
};
const NUMERIC = /^[\s(+\-−$€£¥₿]*\d[\d,.\s]*(?:%|[kKmMbBtT]|x|bps?|pp)?[)\s]*$/;
export function isNumericCell(text: string): boolean { return NUMERIC.test(text); }
export function tableModel(content: Extract<BlockContent, { type: 'table' }>): TableModel {
  const numeric = content.columns.map((_, column) => {
    const cells = content.rows.map((row) => row[column] ?? '').filter((cell) => cell.trim() !== '' && cell.trim() !== '—' && cell.trim() !== '-');
    return cells.length > 0 && cells.every(isNumericCell);
  });
  const align = (column: number): Alignment => content.align?.[column] ?? (numeric[column] ? 'right' : 'left');
  return {
    caption: content.caption, headerColumn: content.headerColumn === true,
    columns: content.columns.map((label, column) => ({ label, align: align(column), numeric: numeric[column] === true })),
    rows: content.rows.map((row) => ({ cells: content.columns.map((_, column) => ({ text: row[column] ?? '', header: content.headerColumn === true && column === 0, align: align(column), numeric: numeric[column] === true })) })),
  };
}

/* ---- metrics ---- */
export type MetricModel = { label: string; value: string; change: string | undefined; tone: 'up' | 'down' | 'neutral'; arrow: '▲' | '▼' | '–'; hint: string | undefined };
/** `change` is a percentage (as in core's markdown export): 1.5 prints as "+1.5%". */
export function metricModels(content: Extract<BlockContent, { type: 'metrics' }>): MetricModel[] {
  return content.items.map((item) => {
    const tone = item.tone ?? (item.change === undefined || item.change === 0 ? 'neutral' : item.change > 0 ? 'up' : 'down');
    return {
      label: item.label, value: item.value, hint: item.hint, tone, arrow: tone === 'up' ? '▲' : tone === 'down' ? '▼' : '–',
      change: item.change === undefined ? undefined : `${item.change > 0 ? '+' : ''}${item.change}%`,
    };
  });
}

/* ---- images, code, callouts ---- */
export type ImageModel = { src: string | null; alt: string; caption: string | undefined; width: 'narrow' | 'normal' | 'wide' | 'full' };
export function imageModel(content: Extract<BlockContent, { type: 'image' }>): ImageModel {
  return { src: safeUrl(content.url, { httpsOnly: true }), alt: content.alt, caption: content.caption, width: content.width ?? 'normal' };
}
export const TONE_ICONS: Record<CalloutTone, string> = {
  // 16x16 stroke icons (Feather-like). Paths are constants, never data.
  info: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM8 7.2v4M8 5v.01',
  success: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM5.2 8.2l2 2 3.6-4',
  warning: 'M7.1 2.6 1.5 12.2a1 1 0 0 0 .9 1.5h11.2a1 1 0 0 0 .9-1.5L8.9 2.6a1 1 0 0 0-1.8 0ZM8 6.4v3M8 11.6v.01',
  danger: 'M5.2 1.8h5.6l3.4 3.4v5.6l-3.4 3.4H5.2l-3.4-3.4V5.2l3.4-3.4ZM8 5.2v3.4M8 10.8v.01',
  note: 'M3.5 1.8h6.2l2.8 2.8v9.6h-9V1.8ZM9.5 1.8v3h3M5.7 8h4.6M5.7 10.4h4.6',
};

/* ---- structure ---- */
/** Children grouped by parent id, preserving the document's block order. */
export function childIndex(report: ResearchDocument): Map<string | null, Block[]> {
  const children = new Map<string | null, Block[]>();
  for (const block of report.blocks) { const list = children.get(block.parentId) ?? []; list.push(block); children.set(block.parentId, list); }
  return children;
}
/** Top-level render order: roots first (in order), then any block that is unreachable from a root. */
export function renderRoots(report: ResearchDocument): { roots: Block[]; children: Map<string | null, Block[]>; orphans: Block[] } {
  const children = childIndex(report);
  const rendered = new Set<string>();
  const visit = (block: Block): void => { if (rendered.has(block.id)) return; rendered.add(block.id); (children.get(block.id) ?? []).forEach(visit); };
  const roots = children.get(null) ?? [];
  roots.forEach(visit);
  return { roots, children, orphans: report.blocks.filter((block) => !rendered.has(block.id)) };
}
export function tocEntries(report: ResearchDocument): OutlineEntry[] { return outlineEntries(report); }

/** A signature of everything outside a block that changes how it renders (citation numbering, TOC contents). */
export function citationsKey(report: ResearchDocument): string { return report.citations.map((citation) => citation.id).join('|'); }
export function outlineKey(report: ResearchDocument): string { return outlineEntries(report).map((entry) => `${entry.id}:${entry.level}:${entry.title}`).join('|'); }
export function dependsOnDocument(block: Block): 'toc' | 'citations' | null {
  const { content } = block;
  if (content.type === 'toc') return 'toc';
  if (block.citationIds.length) return 'citations';
  if ((content.type === 'paragraph' || content.type === 'quote' || content.type === 'callout') && content.runs.some((run) => run.citationId)) return 'citations';
  return null;
}

export const VIRTUALIZE_THRESHOLD = 300;
