import { BLOCK_TYPES, CHART_KINDS } from './constants.js';
import { createEditor } from './editor.js';
import { InputIssue, check, plainCopy, type Schema } from './input-check.js';
import { createBlockId, reservedIds, runs } from './builders.js';
import { diffDocuments, summarizeRevision } from './diff.js';
import { withHints } from './issues.js';
import { fromMarkdown, toHTML, toMarkdown, toPlainText } from './markdown.js';
import { ancestorsOf, blockText, childrenOf, descendantsOf, findBlocks, getBlock, getOutline, type BlockSelector, type OutlineItem } from './query.js';
import { transactionSchema } from './schemas.js';
import { createReportService, type ReportService } from './service.js';
import { stats, type DocumentStats } from './stats.js';
import { TEMPLATE_KINDS, createTemplate, listTemplates, templateTitle, type TemplateInfo, type TemplateKind } from './templates.js';
import type { Actor, Block, BlockContent, BlockInput, BlockType, ChartSpec, EditorIssue, Operation, ResearchDocument, Transaction } from './types.js';
import { LIMITS, validateTransaction } from './validation.js';

/**
 * Agent actions: the semantic operations every transport shares. MCP tools, HTTP routes and CLI commands are thin
 * wrappers over this table, so a host can also build its own tool surface from `AGENT_ACTIONS` + `runAgentAction`.
 * Each action validates its own input against `inputSchema`, turns it into one guarded Core transaction and
 * returns a compact result (ids and versions, never the whole document).
 */

/** Limits that transports enforce on top of the Core `LIMITS`. Documented in docs/API.md. */
export const TRANSPORT_LIMITS = Object.freeze({
  /** Default HTTP request body size in bytes. */
  requestBytes: 1_048_576,
  /** Largest markdown string accepted by import and insert actions. */
  markdownChars: 1_000_000,
  findDefault: 50, findMax: 200,
  revisionsDefault: 20, revisionsMax: 200,
  /** Blocks per insert call (Core: blocksPerOperation). */
  blocksPerCall: LIMITS.blocksPerOperation,
  /** Characters of block text in a summary. */
  textPreviewChars: 160,
  /** Touched blocks listed in a write result. */
  resultBlocks: 100,
  /** Largest single JSON-RPC line on stdio, in bytes. */
  stdioMessageBytes: 4 * 1_048_576,
  /** Largest document or input file the CLI and the stdio server read, in bytes. */
  fileBytes: 32 * 1_048_576,
});

export type AgentFailure = { ok: false; issues: EditorIssue[]; currentRevision: number };
export type BlockBrief = { id: string; type: BlockType; version: number; parentId: string | null; text: string; citationIds?: string[]; children?: number };
export type TouchedBlock = { id: string; type: BlockType; version: number };
/** Result of every action that changes the document. `revision` is the new revision, or the unchanged one with `dryRun`. */
export type AgentWriteSuccess = {
  ok: true; revision: number; summary: string;
  added: string[]; removed: string[]; changed: string[]; moved: string[];
  blocks: TouchedBlock[]; truncated?: true; duplicate?: true; dryRun?: true; revisionAfter?: number;
  [extra: string]: unknown;
};
/** Controls every write action accepts. */
export type WriteControls = { transactionId?: string; expectedRevision?: number; dryRun?: boolean };
type BlockRef = { blockId: string; expectedVersion: number };
type BlockDraft = { id: string; parentId?: string | null; content: BlockContent; citationIds?: string[] };
/** Input of every action, for typed callers (the HTTP client uses it). The JSON Schemas in `AGENT_ACTIONS` are the runtime authority. */
export type AgentActionInputs = {
  get_outline: { maxDepth?: number };
  find_blocks: { type?: BlockType | BlockType[]; text?: string; parentId?: string | null; within?: string; ids?: string[]; citationId?: string; limit?: number; offset?: number; include?: 'summary' | 'content' };
  get_block: { blockId: string };
  document_stats: Record<string, never>;
  export_markdown: { blockId?: string };
  export_html: { blockId?: string; standalone?: boolean };
  export_text: { blockId?: string };
  list_revisions: { limit?: number; offset?: number };
  list_templates: Record<string, never>;
  validate_transaction: { transaction: Transaction };
  insert_blocks: WriteControls & { afterId?: string | null; parentId?: string | null; idPrefix?: string } & ({ markdown: string; blocks?: never } | { blocks: BlockDraft[]; markdown?: never });
  update_block_text: WriteControls & { blockId: string; expectedVersion: number; text: string; format?: 'markdown' | 'plain'; conflictPolicy?: 'reject' | 'rebase-safe' };
  update_block: WriteControls & { blockId: string; expectedVersion: number; content: BlockContent; citationIds?: string[]; conflictPolicy?: 'reject' | 'rebase-safe' };
  replace_text: WriteControls & { find: string; replace: string; blockId?: string; expectedVersion?: number; within?: string; all?: boolean; caseSensitive?: boolean; conflictPolicy?: 'reject' | 'rebase-safe' };
  move_blocks: WriteControls & { blocks: BlockRef[]; parentId: string | null; afterId?: string | null };
  delete_blocks: WriteControls & { blocks: BlockRef[] };
  add_chart: WriteControls & { spec: ChartSpec; afterId?: string | null; parentId?: string | null; id?: string; citationIds?: string[] };
  add_citation: WriteControls & { title: string; url: string; id?: string; accessedAt?: string; publishedAt?: string; blockId?: string; expectedVersion?: number; marker?: boolean };
  set_title: WriteControls & { title: string };
  insert_template: WriteControls & { kind: TemplateKind; subject?: string; idPrefix?: string; afterId?: string | null; parentId?: string | null; setTitle?: boolean };
  import_markdown: WriteControls & { markdown: string; mode?: 'append' | 'replace'; setTitle?: boolean; afterId?: string | null; parentId?: string | null; idPrefix?: string };
};
export type AgentActionName = keyof AgentActionInputs;
type TextExport = { ok: true; revision: number; format: 'markdown' | 'html' | 'text'; characters: number; text: string };
/** Successful result of every action; a failure is always `AgentFailure`. */
export type AgentActionOutputs = {
  get_outline: { ok: true; revision: number; title: string; blockCount: number; outline: OutlineItem[] };
  find_blocks: { ok: true; revision: number; total: number; offset: number; count: number; truncated?: true; blocks: BlockBrief[] | Block[] };
  get_block: { ok: true; revision: number; block: Block; ancestors: BlockBrief[]; children: string[]; descendantCount: number };
  document_stats: { ok: true; revision: number; title: string; updatedAt: string } & DocumentStats;
  export_markdown: TextExport; export_html: TextExport; export_text: TextExport;
  list_revisions: { ok: true; revision: number; total: number; offset: number; count: number; revisions: { number: number; at: string; actor: Actor; kind: 'apply' | 'undo' | 'redo'; transactionId: string; rebasedFrom?: number; summary: string }[] };
  list_templates: { ok: true; revision: number; templates: TemplateInfo[] };
  validate_transaction: { ok: true; valid: true; revision: number; revisionAfter: number; added: string[]; removed: string[]; changed: string[]; moved: string[] };
  insert_blocks: AgentWriteSuccess; update_block_text: AgentWriteSuccess; update_block: AgentWriteSuccess; move_blocks: AgentWriteSuccess; delete_blocks: AgentWriteSuccess; set_title: AgentWriteSuccess;
  replace_text: AgentWriteSuccess & { matchedBlocks?: number };
  add_chart: AgentWriteSuccess & { blockId: string };
  add_citation: AgentWriteSuccess & { citationId: string };
  insert_template: AgentWriteSuccess & { idPrefix: string; rootIds: string[] };
  import_markdown: AgentWriteSuccess & { mode: 'append' | 'replace' };
};
export type AgentActionResult = AgentFailure | ({ ok: true } & Record<string, unknown>);
export type AgentActionContext = {
  /** Provenance recorded on every revision the action creates. Default `{ id: 'agent', kind: 'agent' }`. */
  actor?: Actor;
  /** Clock for timestamps the action creates itself (citation `accessedAt`). */
  now?: () => string;
};
export type AgentAction = {
  /** snake_case; also the MCP tool name and the HTTP path segment under /actions. */
  name: string;
  title: string;
  /** Written for a model: what it does, when to use it, what it returns. */
  description: string;
  access: 'read' | 'write';
  /** True when the action can delete or overwrite existing content. */
  destructive: boolean;
  /** True when repeating the same call leaves the document unchanged. */
  idempotent: boolean;
  inputSchema: Schema;
  /** When set, this field of the result holds raw text (markdown, HTML) that transports may return as-is. */
  textField?: 'text';
  run(service: ReportService, input: unknown, context?: AgentActionContext): AgentActionResult;
};

// ---------------------------------------------------------------------------------------------------- schemas
const definitions = transactionSchema.$defs as Record<string, Schema>;
const ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]*$';
const idS: Schema = { type: 'string', minLength: 1, maxLength: 128, pattern: ID_PATTERN, description: 'Letters, digits and . _ : - ; starts with a letter or digit.' };
// A type list instead of anyOf: some clients (the Claude API among them) reject combinators in a tool's input schema.
const nullableId: Schema = { ...idS, type: ['string', 'null'] };
const versionS: Schema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: 'The block version you last read (from get_block or find_blocks).' };
const object = (properties: Record<string, Schema>, required: string[] = [], description?: string): Schema =>
  ({ type: 'object', properties, required, additionalProperties: false, ...(description ? { description } : {}) });
const text = (max: number, description?: string): Schema => ({ type: 'string', maxLength: max, ...(description ? { description } : {}) });
const blockRefs: Schema = { type: 'array', minItems: 1, maxItems: LIMITS.blocksPerOperation, items: object({ blockId: idS, expectedVersion: versionS }, ['blockId', 'expectedVersion']) };
const CONTENT_SHEET = 'Content shapes: paragraph{runs:[{text,bold?,italic?,code?,href?,strike?,underline?,highlight?,citationId?}]}, heading{level:1-3,text}, list{ordered,items:[text],style?:bullet|number|todo,checked?:[bool],indent?:[0-3]}, table{columns:[text],rows:[[text]],align?,caption?}, quote{runs,attribution?}, callout{tone:info|success|warning|danger|note,title?,runs}, code{language,text}, image{url(https),alt,caption?}, metrics{items:[{label,value,change?,tone?}]}, chart{spec}, embed{provider:"superchart",url(https),title}, section{title}, toggle{title,open}, divider, toc, pageBreak. Full schema: the transaction schema.';
const contentS: Schema = { type: 'object', required: ['type'], properties: { type: { enum: [...BLOCK_TYPES] } }, additionalProperties: true, description: 'Block content, for example {"type":"paragraph","runs":[{"text":"Hello"}]}. Shapes are listed in the tool description.' };
const blockInputS: Schema = { type: 'object', required: ['id', 'content'], additionalProperties: false, properties: { id: idS, parentId: nullableId, content: contentS, citationIds: { type: 'array', maxItems: LIMITS.citations, items: idS } } };
const write: Record<string, Schema> = {
  transactionId: { ...idS, description: 'Idempotency key for safe retries: the identical call (same expectedRevision) returns the first result.' },
  expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Conflict unless the document is at this revision.' },
  dryRun: { type: 'boolean', description: 'Preview without saving.' },
};
const afterIdS: Schema = { ...nullableId, description: 'Insert after this sibling block ID. null inserts first; omit to append at the end of the parent.' };
const parentIdS = (description: string): Schema => ({ ...nullableId, description });
const conflictPolicyS: Schema = { enum: ['reject', 'rebase-safe'], description: 'Default "reject". "rebase-safe" applies the edit when the document moved on but this block did not change.' };
const scoped = (schema: Schema, ...defs: string[]): Schema => defs.length ? { ...schema, $defs: Object.fromEntries(defs.map(name => [name, definitions[name]!])) } : schema;

// ---------------------------------------------------------------------------------------------------- helpers
type Ctx = { service: ReportService; actor: Actor; now: () => string; input: Record<string, unknown>; doc: ResearchDocument; name: string };
function reject(code: EditorIssue['code'], message: string, hint?: string, extra: Partial<EditorIssue> = {}): never { throw new InputIssue({ code, message, ...(hint ? { hint } : {}), ...extra }); }
const str = (ctx: Ctx, key: string): string | undefined => typeof ctx.input[key] === 'string' ? ctx.input[key] as string : undefined;
const int = (ctx: Ctx, key: string): number | undefined => typeof ctx.input[key] === 'number' ? ctx.input[key] as number : undefined;
const bool = (ctx: Ctx, key: string): boolean | undefined => typeof ctx.input[key] === 'boolean' ? ctx.input[key] as boolean : undefined;
const has = (ctx: Ctx, key: string): boolean => Object.hasOwn(ctx.input, key);
const list = <T>(ctx: Ctx, key: string): T[] | undefined => Array.isArray(ctx.input[key]) ? ctx.input[key] as T[] : undefined;

function need(doc: ResearchDocument, id: string, label = 'Block'): Block {
  return getBlock(doc, id) ?? reject('not-found', `${label} "${id}" does not exist.`, 'Use get_outline or find_blocks to list current block IDs. Deleted IDs no longer exist.', { blockId: id });
}
function preview(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > TRANSPORT_LIMITS.textPreviewChars ? `${flat.slice(0, TRANSPORT_LIMITS.textPreviewChars - 1)}…` : flat;
}
function childCounts(doc: ResearchDocument): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of doc.blocks) if (block.parentId !== null) counts.set(block.parentId, (counts.get(block.parentId) ?? 0) + 1);
  return counts;
}
function brief(block: Block, counts: Map<string, number>): BlockBrief {
  const children = counts.get(block.id);
  return { id: block.id, type: block.content.type, version: block.version, parentId: block.parentId, text: preview(blockText(block)),
    ...(block.citationIds.length ? { citationIds: block.citationIds } : {}), ...(children ? { children } : {}) };
}
let sequence = 0;
function transactionId(ctx: Ctx): string {
  const given = str(ctx, 'transactionId');
  if (given !== undefined) return given;
  const random = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 16) : `${Date.now().toString(36)}${(++sequence).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${ctx.name}-${random}`;
}
function remapPath(path: string | undefined, extra?: (path: string) => string): string | undefined {
  if (path === undefined) return undefined;
  const mapped = path.replace(/^transaction\.operations\[\d+\]/, 'input');
  return extra ? extra(mapped) : mapped;
}

type CommitOptions = { conflictPolicy?: 'reject' | 'rebase-safe'; path?: (path: string) => string; extra?: Record<string, unknown>; verb?: string };
/** Builds one Core transaction from `operations`, applies it and reports a compact result. */
function commit(ctx: Ctx, operations: Operation[], options: CommitOptions = {}): AgentActionResult {
  const before = ctx.doc;
  const conflictPolicy = options.conflictPolicy ?? (ctx.input.conflictPolicy === 'rebase-safe' ? 'rebase-safe' : undefined);
  const transaction: Transaction = {
    id: transactionId(ctx), actor: ctx.actor, baseRevision: int(ctx, 'expectedRevision') ?? before.revision,
    ...(conflictPolicy ? { conflictPolicy } : {}), operations,
  };
  const result = ctx.service.apply(transaction);
  if (!result.ok) {
    return { ok: false, issues: withHints(result.issues.map(issue => { const path = remapPath(issue.path, options.path); return { ...issue, ...(path === undefined ? {} : { path }) }; })), currentRevision: result.currentRevision };
  }
  const after = result.document;
  if (result.duplicate) return { ok: true, revision: after.revision, summary: 'Already applied (same transactionId); nothing changed.', added: [], removed: [], changed: [], moved: [], blocks: [], duplicate: true, ...options.extra };
  const diff = diffDocuments(before, after);
  const touched = new Set([...diff.added, ...diff.changed, ...diff.moved]);
  const blocks = after.blocks.filter(block => touched.has(block.id)).map(block => ({ id: block.id, type: block.content.type, version: block.version }));
  const parts = [
    diff.added.length ? `${options.verb ?? 'added'} ${diff.added.length} block(s)` : '', diff.changed.length ? `changed ${diff.changed.length}` : '',
    diff.moved.length ? `moved ${diff.moved.length}` : '', diff.removed.length ? `removed ${diff.removed.length}` : '',
    diff.titleChanged ? 'renamed the document' : '', diff.citations.added.length ? `added ${diff.citations.added.length} citation(s)` : '',
    diff.citations.removed.length ? `removed ${diff.citations.removed.length} citation(s)` : '',
  ].filter(Boolean);
  return {
    ok: true, revision: after.revision, summary: parts.length ? `${parts.join(', ')}.` : 'Document metadata updated.',
    added: diff.added, removed: diff.removed, changed: diff.changed, moved: diff.moved,
    ...(diff.titleChanged ? { titleChanged: true } : {}), ...(diff.citations.added.length || diff.citations.removed.length || diff.citations.changed.length ? { citations: diff.citations } : {}),
    blocks: blocks.slice(0, TRANSPORT_LIMITS.resultBlocks), ...(blocks.length > TRANSPORT_LIMITS.resultBlocks ? { truncated: true as const } : {}),
    ...options.extra,
  };
}

function insertOperations(blocks: BlockInput[], afterId: string | null | undefined): Operation[] {
  const operations: Operation[] = [];
  const lastByParent = new Map<string | null, string>();
  for (let start = 0; start < blocks.length; start += TRANSPORT_LIMITS.blocksPerCall) {
    const chunk = blocks.slice(start, start + TRANSPORT_LIMITS.blocksPerCall);
    // The first chunk follows afterId. A later chunk continues after the previous sibling with the same parent, or appends.
    const anchor = start === 0 ? afterId : lastByParent.get(chunk[0]!.parentId);
    operations.push({ type: 'insertBlocks', blocks: chunk, ...(anchor === undefined ? {} : { afterId: anchor }) });
    for (const block of chunk) lastByParent.set(block.parentId, block.id);
  }
  return operations;
}
function normalizeBlock(entry: unknown): BlockInput {
  const value = entry as { id: string; parentId?: string | null; content: BlockContent; citationIds?: string[] };
  return { id: value.id, parentId: value.parentId ?? null, content: value.content, citationIds: value.citationIds ?? [] };
}
function markdownBlocks(ctx: Ctx, markdown: string, parentId: string | null, idPrefix: string | undefined): BlockInput[] {
  if (markdown.length > TRANSPORT_LIMITS.markdownChars) reject('validation', `Markdown is ${markdown.length} characters; the limit is ${TRANSPORT_LIMITS.markdownChars}.`, 'Split it into several calls.', { path: 'input.markdown' });
  const reserved = reservedIds(ctx.doc);
  for (let attempt = 0; attempt < 50; attempt++) {
    const prefix = idPrefix ?? `i${ctx.doc.revision + 1}${attempt ? `x${attempt}` : ''}`;
    const blocks = fromMarkdown(markdown, { idPrefix: prefix, parentId });
    if (blocks.length === 0) reject('validation', 'The markdown contains no blocks.', 'Provide at least one paragraph, heading, list or table.', { path: 'input.markdown' });
    const clash = blocks.find(block => reserved.has(block.id));
    if (!clash) return blocks;
    if (idPrefix !== undefined) reject('duplicate', `Block ID "${clash.id}" is already used or reserved.`, 'Choose a different idPrefix, or omit it to get a fresh one.', { path: 'input.idPrefix', blockId: clash.id });
  }
  return reject('duplicate', 'Could not find a free ID prefix for the imported blocks.', 'Pass an explicit idPrefix.', { path: 'input.idPrefix' });
}
function generatedPath(blocks: BlockInput[]): (path: string) => string {
  return path => path.replace(/\.blocks\[(\d+)\].*$/, (_match, index: string) => `.markdown (generated block "${blocks[Number(index)]?.id ?? index}")`);
}

function rewriteText(block: Block, value: string, plain: boolean): BlockContent {
  const content = block.content;
  const inline = (): ReturnType<typeof runs> => value === '' ? [] : plain ? [{ text: value }] : runs(value);
  switch (content.type) {
    case 'paragraph': return { type: 'paragraph', runs: inline() };
    case 'quote': return { ...content, runs: inline() };
    case 'callout': return { ...content, runs: inline() };
    case 'heading': return { ...content, text: value.replace(/\s*\n\s*/g, ' ').trim() };
    case 'code': return { ...content, text: value };
    case 'section': case 'toggle': return { ...content, title: value.replace(/\s*\n\s*/g, ' ').trim() };
    case 'list': {
      const items = value.split('\n').map(line => line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '').trim()).filter(line => line.length > 0);
      if (items.length === 0) return reject('validation', 'A list needs at least one non-empty line.', 'Use delete_blocks to remove the list.', { path: 'input.text', blockId: block.id });
      return { ...content, items, ...(content.checked ? { checked: items.map((_item, index) => content.checked?.[index] ?? false) } : {}), ...(content.indent ? { indent: items.map((_item, index) => content.indent?.[index] ?? 0) } : {}) };
    }
    default:
      return reject('validation', `A ${content.type} block has no single text to replace.`, 'update_block_text edits paragraph, heading, quote, callout, code, list, section and toggle blocks. Use replace_text to change a phrase (it also reaches captions, titles and table cells) or update_block to send the full content.', { path: 'input.blockId', blockId: block.id });
  }
}

function hasText(block: Block, find: string, caseSensitive: boolean): boolean {
  const body = blockText(block);
  return caseSensitive ? body.includes(find) : body.toLowerCase().includes(find.toLowerCase());
}

/** A scratch editor for previews. Its clock never runs behind the document, so a host with a custom clock still previews correctly. */
function scratchService(doc: ResearchDocument): ReportService {
  const floor = Date.parse(doc.updatedAt);
  return createReportService(createEditor(doc, { now: () => new Date(Math.max(Date.now(), floor)).toISOString() }));
}

function subDocument(doc: ResearchDocument, blockId: string | undefined): ResearchDocument {
  if (blockId === undefined) return doc;
  const root = need(doc, blockId);
  return { ...doc, blocks: [{ ...root, parentId: null }, ...descendantsOf(doc, blockId)] };
}
function exportAction(name: string, title: string, format: 'markdown' | 'html' | 'text', render: (doc: ResearchDocument, includeTitle: boolean, standalone: boolean) => string, extra: string, extraProperties: Record<string, Schema> = {}): AgentAction {
  return define({
    name, title, access: 'read', destructive: false, idempotent: true, textField: 'text',
    description: `Export the document (or one section) as ${extra}. Read-only. Returns { text, format, characters }.`,
    inputSchema: object({ blockId: { ...idS, description: 'Export only this block and its descendants.' }, ...extraProperties }),
    handler: ctx => {
      const blockId = str(ctx, 'blockId');
      const body = render(subDocument(ctx.doc, blockId), blockId === undefined, bool(ctx, 'standalone') === true);
      return { ok: true, revision: ctx.doc.revision, format, characters: body.length, text: body };
    },
  });
}

type Definition = Omit<AgentAction, 'run'> & { handler: (ctx: Ctx) => AgentActionResult };
const failure = (service: ReportService, issues: EditorIssue[]): AgentFailure => ({ ok: false, issues: withHints(issues), currentRevision: service.read().revision });

function define(definition: Definition): AgentAction {
  const { handler, ...meta } = definition;
  return Object.freeze({
    ...meta,
    run(service: ReportService, input: unknown, context: AgentActionContext = {}): AgentActionResult {
      let target = service;
      try {
        const copy = plainCopy(input ?? {}, 'input');
        if (copy === null || typeof copy !== 'object' || Array.isArray(copy)) reject('validation', 'Input must be a JSON object.', 'Send the arguments as an object.', { path: 'input' });
        check(meta.inputSchema, copy, 'input');
        const dryRun = meta.access === 'write' && (copy as Record<string, unknown>).dryRun === true;
        // A dry run executes against a throwaway editor seeded with the current snapshot; nothing reaches the real service.
        if (dryRun) target = scratchService(service.read());
        const ctx: Ctx = { service: target, actor: context.actor ?? { id: 'agent', kind: 'agent' }, now: context.now ?? (() => new Date().toISOString()), input: copy as Record<string, unknown>, doc: target.read(), name: meta.name };
        const result = handler(ctx);
        if (dryRun && result.ok) {
          const { revision, ...rest } = result;
          return { ...rest, ok: true, revision: service.read().revision, revisionAfter: revision, dryRun: true };
        }
        return result;
      } catch (error) {
        if (error instanceof InputIssue) return failure(service, [error.issue]);
        return failure(service, [{ code: 'validation', message: 'The action could not be completed safely.', hint: 'Check the input against the action schema and retry.' }]);
      }
    },
  });
}

// ---------------------------------------------------------------------------------------------------- reads
const getOutlineAction = define({
  name: 'get_outline', title: 'Get document outline', access: 'read', destructive: false, idempotent: true,
  description: 'Return the document structure as a nested tree of sections, toggles and headings (id, type, title, level, children) with the title and revision. The cheapest way to learn the layout before reading or editing. Read-only.',
  inputSchema: object({ maxDepth: { type: 'integer', minimum: 1, maximum: LIMITS.depth, description: 'Trim the tree below this depth.' } }),
  handler: ctx => {
    const maxDepth = int(ctx, 'maxDepth');
    const trim = (nodes: OutlineItem[], depth: number): OutlineItem[] => nodes.map(node => ({ ...node, children: maxDepth !== undefined && depth >= maxDepth ? [] : trim(node.children, depth + 1) }));
    return { ok: true, revision: ctx.doc.revision, title: ctx.doc.title, blockCount: ctx.doc.blocks.length, outline: trim(getOutline(ctx.doc), 1) };
  },
});

const findBlocksAction = define({
  name: 'find_blocks', title: 'Find blocks', access: 'read', destructive: false, idempotent: true,
  description: `Search blocks by type, text, parent, container, citation or ID. Returns compact summaries (id, type, version, parentId, text preview) in document order; the version is what update, move and delete calls need. Use include "content" for full blocks. Read-only. At most ${TRANSPORT_LIMITS.findMax} results per call (default ${TRANSPORT_LIMITS.findDefault}); page with offset.`,
  inputSchema: object({
    type: { type: ['string', 'array'], items: { enum: [...BLOCK_TYPES] }, maxItems: BLOCK_TYPES.length, description: `One block type or a list of types: ${BLOCK_TYPES.join(', ')}.` },
    text: text(LIMITS.searchText, 'Case-insensitive text the block must contain.'),
    parentId: parentIdS('Only direct children of this block; null for top-level blocks.'),
    within: { ...idS, description: 'Only descendants (any depth) of this section or toggle.' },
    ids: { type: 'array', maxItems: TRANSPORT_LIMITS.findMax, items: idS, description: 'Only these block IDs.' },
    citationId: { ...idS, description: 'Only blocks that cite this citation.' },
    limit: { type: 'integer', minimum: 1, maximum: TRANSPORT_LIMITS.findMax }, offset: { type: 'integer', minimum: 0 },
    include: { enum: ['summary', 'content'], description: 'summary (default) or the full block.' },
  }),
  handler: ctx => {
    const selector: BlockSelector = {};
    const textFilter = str(ctx, 'text');
    if (textFilter !== undefined) selector.text = textFilter;
    if (has(ctx, 'parentId')) selector.parentId = ctx.input.parentId as string | null;
    const within = str(ctx, 'within');
    if (within !== undefined) { need(ctx.doc, within, 'Container'); selector.within = within; }
    const ids = list<string>(ctx, 'ids');
    if (ids !== undefined) selector.ids = ids;
    const citationId = str(ctx, 'citationId');
    if (citationId !== undefined) selector.citationId = citationId;
    if (ctx.input.type !== undefined) {
      const wanted = typeof ctx.input.type === 'string' ? [ctx.input.type] : ctx.input.type as string[];
      const unknown = wanted.find(entry => !(BLOCK_TYPES as readonly string[]).includes(entry));
      if (unknown !== undefined) reject('validation', `Unknown block type "${unknown}".`, `Use one of: ${BLOCK_TYPES.join(', ')}.`, { path: 'input.type' });
      selector.type = wanted as BlockType[];
    }
    const all = findBlocks(ctx.doc, selector);
    const limit = int(ctx, 'limit') ?? TRANSPORT_LIMITS.findDefault;
    const offset = int(ctx, 'offset') ?? 0;
    const page = all.slice(offset, offset + limit);
    const counts = childCounts(ctx.doc);
    return {
      ok: true, revision: ctx.doc.revision, total: all.length, offset, count: page.length,
      ...(offset + page.length < all.length ? { truncated: true } : {}),
      blocks: ctx.input.include === 'content' ? page : page.map(block => brief(block, counts)),
    };
  },
});

const getBlockAction = define({
  name: 'get_block', title: 'Get block', access: 'read', destructive: false, idempotent: true,
  description: 'Return one block in full (content, version, parent, citations) with its ancestors and the IDs of its children. Read the version here before updating, moving or deleting the block. Read-only.',
  inputSchema: object({ blockId: idS }, ['blockId']),
  handler: ctx => {
    const block = need(ctx.doc, str(ctx, 'blockId')!);
    const counts = childCounts(ctx.doc);
    return {
      ok: true, revision: ctx.doc.revision, block,
      ancestors: ancestorsOf(ctx.doc, block.id).map(entry => brief(entry, counts)),
      children: childrenOf(ctx.doc, block.id).map(entry => entry.id).slice(0, TRANSPORT_LIMITS.findMax),
      descendantCount: descendantsOf(ctx.doc, block.id).length,
    };
  },
});

const documentStatsAction = define({
  name: 'document_stats', title: 'Document statistics', access: 'read', destructive: false, idempotent: true,
  description: 'Word and character counts, reading time (minutes), block counts by type and the number of charts, tables, images and citations. Read-only.',
  inputSchema: object({}),
  handler: ctx => ({ ok: true, revision: ctx.doc.revision, title: ctx.doc.title, updatedAt: ctx.doc.updatedAt, ...stats(ctx.doc) }),
});

const exportMarkdownAction = exportAction('export_markdown', 'Export markdown', 'markdown', (doc, title) => toMarkdown(doc, { title }), 'Markdown (charts become data tables, callouts GitHub alerts, citations footnotes)');
const exportHtmlAction = exportAction('export_html', 'Export HTML', 'html', (doc, title, standalone) => toHTML(doc, { title, standalone }), 'escaped static HTML (no scripts, iframes or raw HTML pass-through)', { standalone: { type: 'boolean', description: 'Return a complete page with a small stylesheet instead of an <article> fragment.' } });
const exportTextAction = exportAction('export_text', 'Export plain text', 'text', (doc, title) => toPlainText(doc, { title }), 'plain text');

const listRevisionsAction = define({
  name: 'list_revisions', title: 'List revisions', access: 'read', destructive: false, idempotent: true,
  description: 'List recent revisions of this editing session, newest first: number, time, actor, kind and a one-line summary. History is session-scoped unless the host keeps durable revisions. Read-only.',
  inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: TRANSPORT_LIMITS.revisionsMax }, offset: { type: 'integer', minimum: 0 } }),
  handler: ctx => {
    const all = [...(ctx.service.revisions?.() ?? [])].reverse();
    const offset = int(ctx, 'offset') ?? 0, limit = int(ctx, 'limit') ?? TRANSPORT_LIMITS.revisionsDefault;
    const page = all.slice(offset, offset + limit);
    return {
      ok: true, revision: ctx.doc.revision, total: all.length, offset, count: page.length,
      revisions: page.map(item => ({ number: item.number, at: item.at, actor: item.actor, kind: item.kind, transactionId: item.transactionId, ...(item.rebasedFrom === undefined ? {} : { rebasedFrom: item.rebasedFrom }), summary: summarizeRevision(item) })),
    };
  },
});

const listTemplatesAction = define({
  name: 'list_templates', title: 'List report templates', access: 'read', destructive: false, idempotent: true,
  description: 'List the report templates (equity, macro, portfolio, strategy, arbitrage, comparison, blank) with their section titles. Use insert_template to add one. Read-only.',
  inputSchema: object({}),
  handler: ctx => ({ ok: true, revision: ctx.doc.revision, templates: listTemplates() }),
});

const validateTransactionAction = define({
  name: 'validate_transaction', title: 'Validate a transaction', access: 'read', destructive: false, idempotent: true,
  description: 'Check a Core transaction (the same object apply_transaction takes) without saving it: structure, guards and the resulting document are all validated. Returns what would change, or the issues. Read-only.',
  inputSchema: object({ transaction: { type: 'object', description: 'A transaction: { id, actor, baseRevision, operations[] }.' } }, ['transaction']),
  handler: ctx => {
    const parsed = validateTransaction(ctx.input.transaction);
    if (!parsed.ok) return { ok: false, issues: withHints(parsed.issues), currentRevision: ctx.doc.revision };
    const result = scratchService(ctx.doc).apply(parsed.value);
    if (!result.ok) return { ok: false, issues: withHints(result.issues), currentRevision: ctx.doc.revision };
    const diff = diffDocuments(ctx.doc, result.document);
    return { ok: true, valid: true, revision: ctx.doc.revision, revisionAfter: result.document.revision, added: diff.added, removed: diff.removed, changed: diff.changed, moved: diff.moved };
  },
});

// ---------------------------------------------------------------------------------------------------- writes
const insertBlocksAction = define({
  name: 'insert_blocks', title: 'Insert blocks', access: 'write', destructive: false, idempotent: false,
  description: `Insert new blocks, all or none. Send markdown (headings, paragraphs with **bold**, _italic_, \`code\` and [links](https://...), lists, tables, quotes, code fences, dividers) or an array of blocks. Position with afterId and parentId; the default is the end of the document. Returns the new block IDs and versions. ${CONTENT_SHEET}`,
  inputSchema: object({
    markdown: text(TRANSPORT_LIMITS.markdownChars, 'Markdown to convert into blocks. Use this or blocks.'),
    blocks: { type: 'array', minItems: 1, maxItems: LIMITS.blocks, items: blockInputS, description: 'Ready-made blocks, parents before children. Use this or markdown.' },
    afterId: afterIdS, parentId: parentIdS('Container (section or toggle) for markdown blocks; null for the document root. Blocks you send carry their own parentId.'),
    idPrefix: { ...idS, description: 'Markdown only: prefix for the generated block IDs. Default: a fresh unique prefix.' }, ...write,
  }),
  handler: ctx => {
    const markdown = str(ctx, 'markdown'), given = list<unknown>(ctx, 'blocks');
    if ((markdown === undefined) === (given === undefined)) reject('validation', 'Provide exactly one of markdown or blocks.', 'Send either a markdown string or an array of blocks, not both.', { path: 'input' });
    const afterId = has(ctx, 'afterId') ? ctx.input.afterId as string | null : undefined;
    if (markdown !== undefined) {
      const blocks = markdownBlocks(ctx, markdown, has(ctx, 'parentId') ? ctx.input.parentId as string | null : null, str(ctx, 'idPrefix'));
      return commit(ctx, insertOperations(blocks, afterId), { path: generatedPath(blocks), verb: 'inserted' });
    }
    return commit(ctx, insertOperations(given!.map(normalizeBlock), afterId), { verb: 'inserted' });
  },
});

const updateBlockTextAction = define({
  name: 'update_block_text', title: 'Replace a block\'s text', access: 'write', destructive: true, idempotent: true,
  description: 'Replace all text in one block. Works on paragraph, heading, quote, callout, code, list (one item per line), section and toggle. Paragraph, quote and callout text is inline markdown (**bold**, _italic_, `code`, [link](https://...)) unless format is "plain"; other formatting in the block is replaced. Requires the version you last read. To change a phrase and keep the rest, use replace_text.',
  inputSchema: object({
    blockId: idS, expectedVersion: versionS, text: text(LIMITS.text, 'The new text.'),
    format: { enum: ['markdown', 'plain'], description: 'markdown (default) parses inline marks; plain keeps the text literally.' },
    conflictPolicy: conflictPolicyS, ...write,
  }, ['blockId', 'expectedVersion', 'text']),
  handler: ctx => {
    const block = need(ctx.doc, str(ctx, 'blockId')!);
    const content = rewriteText(block, str(ctx, 'text')!, ctx.input.format === 'plain');
    return commit(ctx, [{ type: 'updateBlock', blockId: block.id, expectedVersion: int(ctx, 'expectedVersion')!, content }], { path: () => 'input.text' });
  },
});

const updateBlockAction = define({
  name: 'update_block', title: 'Replace a block\'s content', access: 'write', destructive: true, idempotent: true,
  description: `Replace the whole content of one block (for example a table, list, chart or callout) keeping its ID and place. The block type may change within the same parent rules. Requires the version you last read. ${CONTENT_SHEET}`,
  inputSchema: object({
    blockId: idS, expectedVersion: versionS, content: contentS,
    citationIds: { type: 'array', maxItems: LIMITS.citations, items: idS, description: 'Replace the block-level citations. Omit to keep them.' },
    conflictPolicy: conflictPolicyS, ...write,
  }, ['blockId', 'expectedVersion', 'content']),
  handler: ctx => commit(ctx, [{ type: 'updateBlock', blockId: str(ctx, 'blockId')!, expectedVersion: int(ctx, 'expectedVersion')!, content: ctx.input.content as BlockContent, ...(has(ctx, 'citationIds') ? { citationIds: list<string>(ctx, 'citationIds')! } : {}) }]),
});

const replaceTextAction = define({
  name: 'replace_text', title: 'Replace text', access: 'write', destructive: true, idempotent: false,
  description: 'Find and replace text while keeping formatting (matches may span inline runs; the replacement takes the formatting where the match starts). With blockId it edits one block and needs the version you last read. Without blockId it edits every block that contains the text, using the current versions, optionally limited to a container with within. Case-insensitive unless caseSensitive. Replaces every occurrence unless all is false. Fails with not-found when nothing matches.',
  inputSchema: object({
    find: { type: 'string', minLength: 1, maxLength: LIMITS.searchText }, replace: text(LIMITS.text, 'May be empty to delete the text.'),
    blockId: idS, expectedVersion: versionS, within: { ...idS, description: 'Without blockId: only blocks inside this container.' },
    all: { type: 'boolean', description: 'Default true.' }, caseSensitive: { type: 'boolean', description: 'Default false.' }, conflictPolicy: conflictPolicyS, ...write,
  }, ['find', 'replace']),
  handler: ctx => {
    const find = str(ctx, 'find')!, replace = str(ctx, 'replace')!;
    const options = { all: bool(ctx, 'all') ?? true, ...(bool(ctx, 'caseSensitive') === undefined ? {} : { caseSensitive: bool(ctx, 'caseSensitive')! }) };
    const blockId = str(ctx, 'blockId');
    if (blockId !== undefined) {
      if (int(ctx, 'expectedVersion') === undefined) reject('validation', 'expectedVersion is required when blockId is given.', 'Read the block with get_block and send its version.', { path: 'input.expectedVersion', blockId });
      need(ctx.doc, blockId);
      return commit(ctx, [{ type: 'replaceText', blockId, expectedVersion: int(ctx, 'expectedVersion')!, find, replace, ...options }]);
    }
    if (has(ctx, 'expectedVersion')) reject('validation', 'expectedVersion only applies together with blockId.', 'Remove expectedVersion, or add blockId to edit a single block.', { path: 'input.expectedVersion' });
    const within = str(ctx, 'within');
    if (within !== undefined) need(ctx.doc, within, 'Container');
    const candidates = (within === undefined ? ctx.doc.blocks : descendantsOf(ctx.doc, within)).filter(block => hasText(block, find, options.caseSensitive ?? false));
    if (candidates.length === 0) reject('not-found', `No block contains "${preview(find)}".`, `Matching ${options.caseSensitive ? 'is' : 'is not'} case-sensitive. Use find_blocks with text to locate the wording first.`, { path: 'input.find' });
    if (candidates.length > LIMITS.operations) reject('validation', `${candidates.length} blocks match; one call can edit at most ${LIMITS.operations}.`, 'Narrow the search with within or blockId.', { path: 'input.find' });
    return commit(ctx, candidates.map(block => ({ type: 'replaceText' as const, blockId: block.id, expectedVersion: block.version, find, replace, ...options })), { extra: { matchedBlocks: candidates.length } });
  },
});

const moveBlocksAction = define({
  name: 'move_blocks', title: 'Move blocks', access: 'write', destructive: false, idempotent: true,
  description: 'Move one or more blocks (with their children) under a parent, in the order given. parentId is required: a section or toggle ID, or null for the document root. Position with afterId (a sibling in the destination; null for first; omit for last). Each block needs the version you last read.',
  inputSchema: object({ blocks: blockRefs, parentId: parentIdS('Destination container, or null for the document root.'), afterId: afterIdS, ...write }, ['blocks', 'parentId']),
  handler: ctx => commit(ctx, [{ type: 'moveBlocks', blocks: list<{ blockId: string; expectedVersion: number }>(ctx, 'blocks')!, parentId: ctx.input.parentId as string | null, ...(has(ctx, 'afterId') ? { afterId: ctx.input.afterId as string | null } : {}) }]),
});

const deleteBlocksAction = define({
  name: 'delete_blocks', title: 'Delete blocks', access: 'write', destructive: true, idempotent: false,
  description: 'Delete blocks. Deleting a section or toggle also deletes everything inside it. Each block needs the version you last read. Deleted IDs stay reserved and cannot be reused. Undo is available in the same session.',
  inputSchema: object({ blocks: blockRefs, ...write }, ['blocks']),
  handler: ctx => commit(ctx, [{ type: 'deleteBlocks', blocks: list<{ blockId: string; expectedVersion: number }>(ctx, 'blocks')! }]),
});

const addChartAction = define({
  name: 'add_chart', title: 'Add a chart', access: 'write', destructive: false, idempotent: false,
  description: `Insert a chart block. spec needs kind, title, labels and series (one value per label). Kinds: ${CHART_KINDS.join(', ')}. scatter also needs points, candlestick needs ohlc, heatmap needs matrix (labels and series stay as the data-table fallback). Optional: unit, asOf, stacked, horizontal, yAxis, xLabel, caption, source, annotations. Put the data source in spec.source. Returns the new block ID.`,
  inputSchema: scoped(object({
    spec: { $ref: '#/$defs/chart' }, afterId: afterIdS, parentId: parentIdS('Container for the chart; null for the document root.'),
    id: { ...idS, description: 'Optional ID for the new block. Default: chart-N.' },
    citationIds: { type: 'array', maxItems: LIMITS.citations, items: idS, description: 'Citations that support this chart (they must exist).' }, ...write,
  }, ['spec']), 'chart'),
  handler: ctx => {
    const id = str(ctx, 'id') ?? createBlockId('chart', reservedIds(ctx.doc));
    const block: BlockInput = { id, parentId: has(ctx, 'parentId') ? ctx.input.parentId as string | null : null, content: { type: 'chart', spec: ctx.input.spec as never }, citationIds: list<string>(ctx, 'citationIds') ?? [] };
    return commit(ctx, insertOperations([block], has(ctx, 'afterId') ? ctx.input.afterId as string | null : undefined), { verb: 'inserted', path: path => path.replace(/^input\.blocks\[0\]\.content\.spec/, 'input.spec'), extra: { blockId: id } });
  },
});

const addCitationAction = define({
  name: 'add_citation', title: 'Add a citation', access: 'write', destructive: false, idempotent: false,
  description: 'Add a source to the document. With blockId (and its version) the block also cites it; with marker true a superscript marker is appended to paragraph, quote or callout text. Returns the citation ID. accessedAt defaults to now.',
  inputSchema: object({
    title: { type: 'string', minLength: 1, maxLength: LIMITS.title }, url: { type: 'string', minLength: 1, maxLength: 4096, description: 'http(s) URL of the source.' },
    id: { ...idS, description: 'Optional citation ID. Default: src-N.' },
    accessedAt: { type: 'string', maxLength: 30, description: 'ISO UTC time, for example 2026-10-05T12:00:00Z. Default: now.' },
    publishedAt: { type: 'string', maxLength: 30, description: 'ISO UTC publication time, if known.' },
    blockId: { ...idS, description: 'Block that cites this source.' }, expectedVersion: versionS,
    marker: { type: 'boolean', description: 'Also append an inline citation marker to the block text.' }, ...write,
  }, ['title', 'url']),
  handler: ctx => {
    const id = str(ctx, 'id') ?? createBlockId('src', new Set(ctx.doc.citations.map(entry => entry.id)));
    const operations: Operation[] = [{ type: 'addCitation', citation: { id, title: str(ctx, 'title')!, url: str(ctx, 'url')!, accessedAt: str(ctx, 'accessedAt') ?? ctx.now(), ...(has(ctx, 'publishedAt') ? { publishedAt: str(ctx, 'publishedAt')! } : {}) } }];
    const blockId = str(ctx, 'blockId');
    if (blockId !== undefined) {
      if (int(ctx, 'expectedVersion') === undefined) reject('validation', 'expectedVersion is required when blockId is given.', 'Read the block with get_block and send its version.', { path: 'input.expectedVersion', blockId });
      const block = need(ctx.doc, blockId);
      let content = block.content;
      if (bool(ctx, 'marker') === true) {
        if (content.type !== 'paragraph' && content.type !== 'quote' && content.type !== 'callout') reject('validation', `A ${content.type} block has no inline text for a citation marker.`, 'Remove marker, or target a paragraph, quote or callout.', { path: 'input.marker', blockId });
        content = { ...content, runs: [...content.runs, { text: '', citationId: id }] } as BlockContent;
      }
      operations.push({ type: 'updateBlock', blockId, expectedVersion: int(ctx, 'expectedVersion')!, content, citationIds: [...new Set([...block.citationIds, id])] });
    }
    return commit(ctx, operations, { extra: { citationId: id } });
  },
});

const setTitleAction = define({
  name: 'set_title', title: 'Set the document title', access: 'write', destructive: true, idempotent: true,
  description: 'Set the document title shown in the header, exports and revision history. Returns the new revision.',
  inputSchema: object({ title: { type: 'string', minLength: 1, maxLength: LIMITS.title }, ...write }, ['title']),
  handler: ctx => commit(ctx, [{ type: 'setTitle', title: str(ctx, 'title')! }]),
});

const insertTemplateAction = define({
  name: 'insert_template', title: 'Insert a report template', access: 'write', destructive: false, idempotent: false,
  description: `Insert a report skeleton: ${TEMPLATE_KINDS.join(', ')}. Sections, tables, metric placeholders and guidance notes with a "Data and methodology" section and an analysis-only note; fill them with update_block_text, replace_text and add_chart. Returns the new block IDs.`,
  inputSchema: object({
    kind: { enum: [...TEMPLATE_KINDS] }, subject: text(200, 'What the report is about, for example a ticker or theme.'),
    idPrefix: { ...idS, maxLength: 60, description: 'Prefix for the block IDs. Default: the kind, made unique.' },
    afterId: afterIdS, parentId: parentIdS('Container for the template; null for the document root.'),
    setTitle: { type: 'boolean', description: 'Also set the document title from the template and subject.' }, ...write,
  }, ['kind']),
  handler: ctx => {
    const kind = str(ctx, 'kind') as TemplateKind;
    const reserved = reservedIds(ctx.doc);
    let prefix = str(ctx, 'idPrefix');
    if (prefix === undefined) { prefix = kind; for (let n = 2; [...reserved].some(id => id.startsWith(`${prefix}-`)); n++) prefix = `${kind}${n}`; }
    let blocks: BlockInput[];
    try { blocks = createTemplate(kind, { idPrefix: prefix, ...(has(ctx, 'subject') ? { subject: str(ctx, 'subject')! } : {}), parentId: has(ctx, 'parentId') ? ctx.input.parentId as string | null : null }); }
    catch (error) { return reject('validation', error instanceof Error ? error.message : 'Invalid template options.', undefined, { path: 'input' }); }
    const operations: Operation[] = [];
    if (bool(ctx, 'setTitle') === true) operations.push({ type: 'setTitle', title: templateTitle(kind, str(ctx, 'subject')) });
    operations.push(...insertOperations(blocks, has(ctx, 'afterId') ? ctx.input.afterId as string | null : undefined));
    return commit(ctx, operations, { verb: 'inserted', extra: { idPrefix: prefix, rootIds: blocks.filter(block => block.parentId === (has(ctx, 'parentId') ? ctx.input.parentId : null)).map(block => block.id) } });
  },
});

const importMarkdownAction = define({
  name: 'import_markdown', title: 'Import markdown', access: 'write', destructive: true, idempotent: false,
  description: 'Import a markdown document. mode "append" (default) adds the blocks after afterId or at the end; mode "replace" first deletes every existing block (an undoable edit; IDs are not reused) and imports the markdown as the new body. setTitle takes the title from a leading "# Title" line. Use dryRun to preview a replace.',
  inputSchema: object({
    markdown: text(TRANSPORT_LIMITS.markdownChars), mode: { enum: ['append', 'replace'] }, setTitle: { type: 'boolean' },
    afterId: afterIdS, parentId: parentIdS('Append mode: container for the blocks; null for the root.'),
    idPrefix: { ...idS, description: 'Prefix for the generated block IDs. Default: a fresh unique prefix.' }, ...write,
  }, ['markdown']),
  handler: ctx => {
    const replace = ctx.input.mode === 'replace';
    if (replace && (has(ctx, 'afterId') || has(ctx, 'parentId'))) reject('validation', 'afterId and parentId only apply to mode "append".', 'Remove them, or use mode "append".', { path: 'input.mode' });
    const markdown = str(ctx, 'markdown')!;
    const blocks = markdownBlocks(ctx, markdown, has(ctx, 'parentId') ? ctx.input.parentId as string | null : null, str(ctx, 'idPrefix'));
    const operations: Operation[] = [];
    if (bool(ctx, 'setTitle') === true) {
      const heading = /^\s*#\s+(.+?)\s*#*\s*$/m.exec(markdown.split('\n').find(line => line.trim() !== '') ?? '');
      if (heading?.[1]) operations.push({ type: 'setTitle', title: heading[1].slice(0, LIMITS.title) });
    }
    if (replace) {
      const roots = ctx.doc.blocks.filter(block => block.parentId === null);
      for (let start = 0; start < roots.length; start += LIMITS.blocksPerOperation) operations.push({ type: 'deleteBlocks', blocks: roots.slice(start, start + LIMITS.blocksPerOperation).map(block => ({ blockId: block.id, expectedVersion: block.version })) });
    }
    operations.push(...insertOperations(blocks, replace ? undefined : has(ctx, 'afterId') ? ctx.input.afterId as string | null : undefined));
    return commit(ctx, operations, { path: generatedPath(blocks), verb: 'imported', extra: { mode: replace ? 'replace' : 'append' } });
  },
});

/** Every semantic action, reads first. Transports expose these next to the Core read/apply/undo/redo operations. */
export const AGENT_ACTIONS: readonly AgentAction[] = Object.freeze([
  getOutlineAction, findBlocksAction, getBlockAction, documentStatsAction, exportMarkdownAction, exportHtmlAction, exportTextAction,
  listRevisionsAction, listTemplatesAction, validateTransactionAction,
  insertBlocksAction, updateBlockTextAction, updateBlockAction, replaceTextAction, moveBlocksAction, deleteBlocksAction,
  addChartAction, addCitationAction, setTitleAction, insertTemplateAction, importMarkdownAction,
]);

const byName = new Map(AGENT_ACTIONS.map(action => [action.name, action]));
export function getAgentAction(name: string): AgentAction | undefined { return byName.get(name); }

/** Runs one action by name. Never throws: unknown names, bad input and Core rejections all return `{ ok: false, issues, currentRevision }`. */
export function runAgentAction(service: ReportService, name: string, input: unknown, context: AgentActionContext = {}): AgentActionResult {
  const action = byName.get(name);
  if (!action) return failure(service, [{ code: 'not-found', message: `Unknown action "${name}".`, hint: `Available actions: ${AGENT_ACTIONS.map(entry => entry.name).join(', ')}.` }]);
  return action.run(service, input, context);
}
