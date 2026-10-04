import { fromMarkdown, runs as parseInline, safeUrl, toMarkdown } from '@super-solution/editor-core';
import type { Block, BlockContent, BlockInput, InlineRun, ResearchDocument } from '@super-solution/editor-core';
import { plainRuns } from '@super-solution/editor-core';
import type { IdFactory } from './plan.js';
import { descendantsOf, rootsOf, treeOf } from './tree.js';

/** Copy and paste for blocks. Copy writes markdown (readable anywhere) plus a lossless JSON flavour for pasting back into a Super Editor. */
export const CLIPBOARD_MIME = 'application/x-super-editor+json';
const MAX_PAYLOAD = 2_000_000;
export type ClipboardPayload = { text: string; json: string };

function citationsFor(doc: ResearchDocument, blocks: readonly Block[]) {
  const used = new Set<string>();
  for (const block of blocks) {
    block.citationIds.forEach((id) => used.add(id));
    const runs = 'runs' in block.content ? block.content.runs : [];
    for (const run of runs) if (run.citationId) used.add(run.citationId);
  }
  return doc.citations.filter((citation) => used.has(citation.id));
}
/** The selected blocks (and everything inside them) as a clipboard payload. Null when nothing is selected. */
export function serializeBlocks(doc: ResearchDocument, ids: readonly string[]): ClipboardPayload | null {
  const roots = rootsOf(doc, ids);
  if (!roots.length) return null;
  const tree = treeOf(doc), rootSet = new Set(roots), subset: Block[] = [];
  for (const id of roots) subset.push(tree.byId.get(id)!, ...descendantsOf(doc, id));
  const standalone = subset.map((block) => rootSet.has(block.id) ? { ...block, parentId: null } : block);
  const text = toMarkdown({ ...doc, blocks: standalone, citations: citationsFor(doc, subset) }, { title: false }).trimEnd();
  const json = JSON.stringify({ v: 1, blocks: subset.map((block) => ({ id: block.id, parentId: rootSet.has(block.id) ? null : block.parentId, content: block.content, citationIds: block.citationIds })) });
  return { text, json };
}

/** Pasted JSON is untrusted: shape-check it, give every block a fresh id and drop references the target document does not have. */
export function parseBlocksPayload(json: string | undefined, doc: ResearchDocument, createId: IdFactory): BlockInput[] | null {
  if (!json || json.length > MAX_PAYLOAD) return null;
  let data: unknown;
  try { data = JSON.parse(json); } catch { return null; }
  const list = (data as { v?: unknown; blocks?: unknown } | null);
  if (!list || list.v !== 1 || !Array.isArray(list.blocks) || list.blocks.length === 0 || list.blocks.length > 500) return null;
  const known = new Set(doc.citations.map((citation) => citation.id)), ids = new Map<string, string>();
  const entries = list.blocks as { id?: unknown; parentId?: unknown; content?: unknown; citationIds?: unknown }[];
  for (const entry of entries) { if (typeof entry?.id !== 'string' || typeof entry.content !== 'object' || entry.content === null) return null; ids.set(entry.id, createId('block')); }
  const out: BlockInput[] = [];
  for (const entry of entries) {
    const parentId = typeof entry.parentId === 'string' ? ids.get(entry.parentId) ?? null : null;
    const content = JSON.parse(JSON.stringify(entry.content)) as BlockContent;
    if ('runs' in content && Array.isArray(content.runs)) for (const run of content.runs) if (run.citationId && !known.has(run.citationId)) delete run.citationId;
    const citationIds = Array.isArray(entry.citationIds) ? (entry.citationIds as unknown[]).filter((id): id is string => typeof id === 'string' && known.has(id)) : [];
    out.push({ id: ids.get(entry.id as string)!, parentId, content, citationIds });
  }
  return out;
}

export type PasteContext = { hasSelection: boolean; inRichField: boolean; linkSchemes?: 'https' | 'http-https' };
export type PastePlan =
  | { kind: 'inline'; runs: InlineRun[]; text: string }
  | { kind: 'link'; href: string }
  | { kind: 'blocks'; blocks: BlockInput[] };
const BLOCK_SYNTAX = /^( {0,3}(#{1,6}\s|>\s?|[-*+]\s|\d{1,9}[.)]\s|(`{3,}|~{3,})|---+\s*$|\*\*\*+\s*$)|\s*\|.*\|\s*$)/m;
const INLINE_SYNTAX = /(\*\*[^*]+\*\*|~~[^~]+~~|`[^`]+`|\]\(https?:\/\/|(?:^|\s)_[^_\s][^_]*_(?:\s|$)|(?:^|\s)\*[^*\s][^*]*\*(?:\s|$))/;
export function isSingleUrl(text: string): boolean { return !/\s/.test(text) && safeUrl(text) !== null; }

/** Decides what a paste means. Text is never interpreted as HTML. */
export function planPaste(text: string, context: PasteContext, createId: IdFactory): PastePlan | null {
  const normalized = text.replace(/\r\n?/g, '\n');
  const trimmed = normalized.trim();
  if (!trimmed) return null;
  if (!trimmed.includes('\n')) {
    const href = isSingleUrl(trimmed) ? safeUrl(trimmed) : null;
    if (href && context.hasSelection && context.inRichField && (context.linkSchemes === 'http-https' || href.startsWith('https:'))) return { kind: 'link', href };
    // A single line stays inline inside the paragraph being edited; markdown-lite markup in it becomes formatting.
    if (!BLOCK_SYNTAX.test(trimmed) || !context.inRichField) return { kind: 'inline', runs: context.inRichField && INLINE_SYNTAX.test(trimmed) ? parseInline(trimmed) : plainRuns(trimmed), text: trimmed };
  }
  const blocks = BLOCK_SYNTAX.test(normalized)
    ? fromMarkdown(normalized, { idPrefix: 'paste', citationMarkers: false })
    : trimmed.split(/\n+/).map((line, index): BlockInput => ({ id: `paste-${index + 1}`, parentId: null, citationIds: [], content: { type: 'paragraph', runs: INLINE_SYNTAX.test(line) ? parseInline(line.trim()) : plainRuns(line.trim()) } })).filter((block) => block.content.type !== 'paragraph' || block.content.runs.length > 0);
  if (!blocks.length) return null;
  const ids = new Map<string, string>();
  for (const block of blocks) ids.set(block.id, createId('block'));
  return { kind: 'blocks', blocks: blocks.map((block) => ({ ...block, id: ids.get(block.id)!, parentId: block.parentId === null ? null : ids.get(block.parentId) ?? null })) };
}
