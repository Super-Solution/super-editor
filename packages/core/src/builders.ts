import { runs as parseRuns } from './inline.js';
import { descendantsOf, findBlocks } from './query.js';
import { replaceInContent } from './text.js';
import type { Actor, ApplyResult, BlockContent, BlockInput, ChartSpec, Citation, DocumentFormat, Editor, EditorIssue, InlineRun, Operation, ResearchDocument, Transaction } from './types.js';

export { runs, plainRuns } from './inline.js';

/** Where a block goes and what it cites. Every `b.*` builder accepts these as its last argument. */
export type BlockOptions = { parentId?: string | null; citationIds?: readonly string[] };
/** A string is parsed as inline markdown-lite (see `runs`); pass runs, or `plainRuns(text)`, to control formatting exactly. */
export type TextInput = string | readonly InlineRun[];
export type Cell = string | number | boolean | null | undefined;

const toRuns = (text: TextInput): InlineRun[] => typeof text === 'string' ? parseRuns(text) : text.map(run => ({ ...run }));
const toCell = (cell: Cell): string => cell === null || cell === undefined ? '' : String(cell);
function make(id: string, content: BlockContent, options?: BlockOptions): BlockInput {
  return { id, parentId: options?.parentId ?? null, content, citationIds: [...(options?.citationIds ?? [])] };
}
type Defined<T> = { [K in keyof T]?: Exclude<T[K], undefined> };
/** Drops undefined entries, which `exactOptionalPropertyTypes` does not allow as optional values. */
function defined<T extends object>(value: T): Defined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Defined<T>;
}

/** One builder per block type. They return plain `BlockInput` values; validation happens when the editor applies them. */
export const b = {
  section: (id: string, title: string, options?: BlockOptions): BlockInput => make(id, { type: 'section', title }, options),
  heading: (id: string, level: 1 | 2 | 3, text: string, options?: BlockOptions): BlockInput => make(id, { type: 'heading', level, text }, options),
  paragraph: (id: string, text: TextInput, options?: BlockOptions): BlockInput => make(id, { type: 'paragraph', runs: toRuns(text) }, options),
  /** `style` wins over `ordered`. `checked` implies `style: 'todo'`. */
  list: (id: string, items: readonly string[], options?: BlockOptions & { ordered?: boolean; style?: 'bullet' | 'number' | 'todo'; checked?: readonly boolean[]; indent?: readonly number[] }): BlockInput => {
    const style = options?.style ?? (options?.checked ? 'todo' : undefined);
    return make(id, { type: 'list', ordered: style ? style === 'number' : options?.ordered ?? false, items: [...items],
      ...(style ? { style } : {}), ...(options?.checked ? { checked: [...options.checked] } : {}), ...(options?.indent ? { indent: [...options.indent] } : {}) }, options);
  },
  /** Numbers and booleans in `rows` are converted with `String`; null and undefined become empty cells. */
  table: (id: string, columns: readonly string[], rows: readonly (readonly Cell[])[], options?: BlockOptions & { align?: readonly ('left' | 'center' | 'right')[]; caption?: string; headerColumn?: boolean }): BlockInput =>
    make(id, { type: 'table', columns: [...columns], rows: rows.map(row => row.map(toCell)), ...(options?.align ? { align: [...options.align] } : {}),
      ...defined({ caption: options?.caption, headerColumn: options?.headerColumn }) }, options),
  chart: (id: string, spec: ChartSpec, options?: BlockOptions): BlockInput => make(id, { type: 'chart', spec }, options),
  embed: (id: string, url: string, title: string, options?: BlockOptions & { height?: number }): BlockInput => make(id, { type: 'embed', provider: 'superchart', url, title, ...defined({ height: options?.height }) }, options),
  timestamp: (id: string, at: string, label: string, options?: BlockOptions): BlockInput => make(id, { type: 'timestamp', at, label }, options),
  quote: (id: string, text: TextInput, options?: BlockOptions & { attribution?: string }): BlockInput => make(id, { type: 'quote', runs: toRuns(text), ...defined({ attribution: options?.attribution }) }, options),
  callout: (id: string, tone: 'info' | 'success' | 'warning' | 'danger' | 'note', text: TextInput, options?: BlockOptions & { title?: string }): BlockInput => make(id, { type: 'callout', tone, ...defined({ title: options?.title }), runs: toRuns(text) }, options),
  code: (id: string, language: string, text: string, options?: BlockOptions): BlockInput => make(id, { type: 'code', language, text }, options),
  divider: (id: string, options?: BlockOptions): BlockInput => make(id, { type: 'divider' }, options),
  image: (id: string, url: string, alt: string, options?: BlockOptions & { caption?: string; width?: 'narrow' | 'normal' | 'wide' | 'full' }): BlockInput => make(id, { type: 'image', url, alt, ...defined({ caption: options?.caption, width: options?.width }) }, options),
  toggle: (id: string, title: string, options?: BlockOptions & { open?: boolean }): BlockInput => make(id, { type: 'toggle', title, open: options?.open ?? false }, options),
  /** `change` is a percentage change; renderers and exports show it as such (for example +1.5%). */
  metrics: (id: string, items: readonly { label: string; value: string; change?: number; tone?: 'up' | 'down' | 'neutral'; hint?: string }[], options?: BlockOptions): BlockInput => make(id, { type: 'metrics', items: items.map(item => ({ ...item })) }, options),
  toc: (id: string, options?: BlockOptions): BlockInput => make(id, { type: 'toc' }, options),
  pageBreak: (id: string, options?: BlockOptions): BlockInput => make(id, { type: 'pageBreak' }, options),
};

// ---- chart specs ---------------------------------------------------------------------------------------------------

type Spec = ChartSpec;
type ChartCommon = { title: string; unit?: string; asOf?: string; caption?: string; source?: string; xLabel?: string; yAxis?: Spec['yAxis']; annotations?: Spec['annotations']; stacked?: boolean; horizontal?: boolean };
export type SeriesInput = { name: string; values: readonly number[]; color?: string };
/** One shared category axis. Give `series` for several series, or `values` (+ optional `name`) for one. */
export type CategoryChartInput = ChartCommon & { labels: readonly string[] } & ({ series: readonly SeriesInput[] } | { values: readonly number[]; name?: string });

function common(input: ChartCommon): Defined<ChartCommon> {
  return defined({ unit: input.unit, asOf: input.asOf, stacked: input.stacked, horizontal: input.horizontal, yAxis: input.yAxis, xLabel: input.xLabel, caption: input.caption, source: input.source, annotations: input.annotations });
}
function category(kind: string, fallbackName: string, input: CategoryChartInput): Spec {
  const series = 'series' in input ? input.series.map(item => ({ name: item.name, values: [...item.values], ...defined({ color: item.color }) })) : [{ name: input.name ?? fallbackName, values: [...input.values] }];
  return { kind, title: input.title, labels: [...input.labels], series, ...common(input) };
}
/** Chart specs for the known kinds. Scatter, candlestick and heatmap fill the labels/series fallback table for you. */
export const chart = {
  pie: (input: CategoryChartInput): Spec => category('pie', 'Share', input),
  donut: (input: CategoryChartInput): Spec => category('donut', 'Share', input),
  bar: (input: CategoryChartInput): Spec => category('bar', 'Value', input),
  trend: (input: CategoryChartInput): Spec => category('trend', 'Value', input),
  line: (input: CategoryChartInput): Spec => category('line', 'Value', input),
  area: (input: CategoryChartInput): Spec => category('area', 'Value', input),
  histogram: (input: CategoryChartInput): Spec => category('histogram', 'Count', input),
  waterfall: (input: CategoryChartInput): Spec => category('waterfall', 'Change', input),
  scatter: (input: ChartCommon & { points: readonly { series: string; x: number; y: number }[] }): Spec => ({
    kind: 'scatter', title: input.title, labels: input.points.map(point => `${point.series}: ${point.x}`),
    series: [{ name: input.yAxis?.label ?? 'y', values: input.points.map(point => point.y) }], ...common(input), points: input.points.map(point => ({ ...point })) }),
  candlestick: (input: ChartCommon & { ohlc: readonly { t: string; o: number; h: number; l: number; c: number; v?: number }[] }): Spec => ({
    kind: 'candlestick', title: input.title, labels: input.ohlc.map(candle => candle.t), series: [{ name: 'Close', values: input.ohlc.map(candle => candle.c) }], ...common(input), ohlc: input.ohlc.map(candle => ({ ...candle })) }),
  heatmap: (input: ChartCommon & { rows: readonly string[]; columns: readonly string[]; values: readonly (readonly number[])[] }): Spec => ({
    kind: 'heatmap', title: input.title, labels: [...input.columns], series: input.rows.map((name, row) => ({ name, values: [...(input.values[row] ?? [])] })), ...common(input),
    matrix: { rows: [...input.rows], columns: [...input.columns], values: input.values.map(row => [...row]) } }),
};

// ---- operations ----------------------------------------------------------------------------------------------------

const withAfter = (afterId: string | null | undefined): { afterId?: string | null } => afterId === undefined ? {} : { afterId };
/** One builder per operation. Guards (`expectedVersion`) are explicit here; use `transaction()` to fill them from a snapshot. */
export const op = {
  insertBlock: (block: BlockInput, afterId?: string | null): Operation => ({ type: 'insertBlock', block, ...withAfter(afterId) }),
  updateBlock: (blockId: string, expectedVersion: number, content: BlockContent, citationIds?: readonly string[]): Operation => ({ type: 'updateBlock', blockId, expectedVersion, content, ...(citationIds ? { citationIds: [...citationIds] } : {}) }),
  moveBlock: (blockId: string, expectedVersion: number, parentId: string | null, afterId?: string | null): Operation => ({ type: 'moveBlock', blockId, expectedVersion, parentId, ...withAfter(afterId) }),
  deleteBlock: (blockId: string, expectedVersion: number): Operation => ({ type: 'deleteBlock', blockId, expectedVersion }),
  setTitle: (title: string): Operation => ({ type: 'setTitle', title }),
  setFormat: (format: DocumentFormat): Operation => ({ type: 'setFormat', format }),
  addCitation: (citation: Citation): Operation => ({ type: 'addCitation', citation }),
  insertBlocks: (blocks: readonly BlockInput[], afterId?: string | null): Operation => ({ type: 'insertBlocks', blocks: [...blocks], ...withAfter(afterId) }),
  duplicateBlock: (blockId: string, expectedVersion: number, newIds: Record<string, string>, afterId?: string | null): Operation => ({ type: 'duplicateBlock', blockId, expectedVersion, newIds, ...withAfter(afterId) }),
  replaceText: (blockId: string, expectedVersion: number, find: string, replace: string, options?: { all?: boolean; caseSensitive?: boolean }): Operation => ({ type: 'replaceText', blockId, expectedVersion, find, replace, ...defined({ all: options?.all, caseSensitive: options?.caseSensitive }) }),
  deleteBlocks: (blocks: readonly { blockId: string; expectedVersion: number }[]): Operation => ({ type: 'deleteBlocks', blocks: blocks.map(block => ({ ...block })) }),
  moveBlocks: (blocks: readonly { blockId: string; expectedVersion: number }[], parentId: string | null, afterId?: string | null): Operation => ({ type: 'moveBlocks', blocks: blocks.map(block => ({ ...block })), parentId, ...withAfter(afterId) }),
  updateCitation: (citation: Citation): Operation => ({ type: 'updateCitation', citation }),
  removeCitation: (citationId: string): Operation => ({ type: 'removeCitation', citationId }),
};

// ---- ids -----------------------------------------------------------------------------------------------------------

/** Every ID that can no longer be used for a new block: live blocks plus retired ones. */
export function reservedIds(document: Pick<ResearchDocument, 'blocks' | 'retiredBlockIds'>): Set<string> {
  return new Set([...document.retiredBlockIds, ...document.blocks.map(block => block.id)]);
}
const isDocument = (value: unknown): value is ResearchDocument => typeof value === 'object' && value !== null && !Array.isArray(value) && 'blocks' in value && 'retiredBlockIds' in value;
/**
 * The first free `<prefix>-<n>`. `reserved` may be a document or any collection of IDs. A `Set` is updated with the new ID,
 * so reuse one Set (see `reservedIds`) to mint several distinct IDs; other inputs are only read.
 */
export function createBlockId(prefix: string, reserved: Iterable<string> | ResearchDocument = []): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(prefix)) throw new TypeError('Block ID prefix must start with a letter or digit, use only letters, digits, ".", "_", ":" or "-", and be at most 100 characters.');
  const taken = reserved instanceof Set ? reserved as Set<string> : new Set(isDocument(reserved) ? reservedIds(reserved) : reserved);
  for (let index = 1; ; index++) {
    const candidate = `${prefix}-${index}`;
    if (!taken.has(candidate)) { if (reserved instanceof Set) taken.add(candidate); return candidate; }
  }
}

// ---- fluent transactions -------------------------------------------------------------------------------------------

export type TransactionOptions = { id?: string; conflictPolicy?: 'reject' | 'rebase-safe' };
export interface TransactionBuilder {
  readonly operations: readonly Operation[];
  /** One block becomes `insertBlock`, an array becomes the ordered, all-or-nothing `insertBlocks`. */
  insert(block: BlockInput | readonly BlockInput[], afterId?: string | null): TransactionBuilder;
  /** Replaces a block's content. A function receives the current content, including earlier changes in this builder. */
  update(blockId: string, change: BlockContent | ((current: BlockContent) => BlockContent), citationIds?: readonly string[]): TransactionBuilder;
  replaceText(blockId: string, find: string, replace: string, options?: { all?: boolean; caseSensitive?: boolean }): TransactionBuilder;
  move(blockIds: string | readonly string[], parentId: string | null, afterId?: string | null): TransactionBuilder;
  remove(...blockIds: string[]): TransactionBuilder;
  /** `newIds` maps the block and every descendant, or give `{ idPrefix }` to mint them. */
  duplicate(blockId: string, newIds: Record<string, string> | { idPrefix: string }, afterId?: string | null): TransactionBuilder;
  setTitle(title: string): TransactionBuilder;
  setFormat(format: DocumentFormat): TransactionBuilder;
  addCitation(citation: Citation): TransactionBuilder;
  updateCitation(citation: Citation): TransactionBuilder;
  removeCitation(citationId: string): TransactionBuilder;
  /** The transaction, ready for `editor.apply`. Throws when a block id could not be resolved; `commit()` reports that as a result instead. */
  build(): Transaction;
  commit(): ApplyResult;
}

let sequence = 0;
function transactionId(actor: Actor): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
  return `${actor.id.slice(0, 40)}-${random}`.replace(/[^A-Za-z0-9._:-]/g, '-').replace(/^[^A-Za-z0-9]+/, 'tx-');
}

/**
 * Collects operations and fills `baseRevision` and every `expectedVersion` from the editor's snapshot at the moment the builder is
 * created. If someone else edits first, `commit()` fails with a conflict instead of overwriting. Blocks inserted or changed earlier in
 * the same builder are tracked, so you can insert a block and update it in one batch.
 */
export function transaction(editor: Editor, actor: Actor, options: TransactionOptions = {}): TransactionBuilder {
  const snapshot = editor.getSnapshot();
  const id = options.id ?? transactionId(actor);
  const versions = new Map(snapshot.blocks.map(block => [block.id, block.version]));
  const contents = new Map<string, BlockContent>(snapshot.blocks.map(block => [block.id, block.content]));
  const reserved = reservedIds(snapshot);
  const operations: Operation[] = [];
  const problems: EditorIssue[] = [];
  const unknown = (blockId: string): number | undefined => {
    const found = versions.get(blockId);
    if (found === undefined) problems.push({ code: 'not-found', message: 'Block does not exist in the snapshot this transaction was built from.', blockId, hint: `Check the id with findBlocks or getOutline. Known blocks: ${snapshot.blocks.slice(0, 8).map(block => block.id).join(', ')}${snapshot.blocks.length > 8 ? ', ...' : ''}.` });
    return found;
  };
  const tick = (blockId: string): void => { versions.set(blockId, (versions.get(blockId) ?? 0) + 1); };
  const subtree = (blockId: string): string[] => [blockId, ...descendantsOf({ blocks: snapshot.blocks.filter(block => versions.has(block.id)) }, blockId).map(block => block.id)];
  const self: TransactionBuilder = {
    get operations() { return operations; },
    insert(block, afterId) {
      const list = 'id' in block ? [block] : [...block];
      for (const entry of list) { versions.set(entry.id, 1); contents.set(entry.id, entry.content); reserved.add(entry.id); }
      operations.push('id' in block ? op.insertBlock(block, afterId) : op.insertBlocks(list, afterId)); return self;
    },
    update(blockId, change, citationIds) {
      const version = unknown(blockId); if (version === undefined) return self;
      const content = typeof change === 'function' ? change(contents.get(blockId)!) : change;
      operations.push(op.updateBlock(blockId, version, content, citationIds)); contents.set(blockId, content); tick(blockId); return self;
    },
    replaceText(blockId, find, replace, replaceOptions) {
      const version = unknown(blockId); if (version === undefined) return self;
      operations.push(op.replaceText(blockId, version, find, replace, replaceOptions));
      const result = replaceInContent(contents.get(blockId)!, { find, replace, ...defined({ all: replaceOptions?.all, caseSensitive: replaceOptions?.caseSensitive }) });
      if (result) contents.set(blockId, result.content);
      tick(blockId); return self;
    },
    move(blockIds, parentId, afterId) {
      const list = typeof blockIds === 'string' ? [blockIds] : [...blockIds], refs: { blockId: string; expectedVersion: number }[] = [];
      for (const blockId of list) { const version = unknown(blockId); if (version !== undefined) refs.push({ blockId, expectedVersion: version }); }
      if (refs.length !== list.length) return self;
      operations.push(typeof blockIds === 'string' ? op.moveBlock(blockIds, refs[0]!.expectedVersion, parentId, afterId) : op.moveBlocks(refs, parentId, afterId));
      for (const blockId of list) tick(blockId); return self;
    },
    remove(...blockIds) {
      const refs: { blockId: string; expectedVersion: number }[] = [];
      for (const blockId of blockIds) { const version = unknown(blockId); if (version !== undefined) refs.push({ blockId, expectedVersion: version }); }
      if (refs.length !== blockIds.length || !refs.length) return self;
      operations.push(refs.length === 1 ? op.deleteBlock(refs[0]!.blockId, refs[0]!.expectedVersion) : op.deleteBlocks(refs));
      for (const blockId of blockIds) for (const gone of subtree(blockId)) { versions.delete(gone); contents.delete(gone); } return self;
    },
    duplicate(blockId, newIds, afterId) {
      const version = unknown(blockId); if (version === undefined) return self;
      const ids = 'idPrefix' in newIds ? Object.fromEntries(subtree(blockId).map(old => [old, createBlockId(newIds.idPrefix, reserved)])) : newIds;
      operations.push(op.duplicateBlock(blockId, version, ids, afterId));
      for (const [old, fresh] of Object.entries(ids)) { versions.set(fresh, 1); const content = contents.get(old); if (content) contents.set(fresh, content); reserved.add(fresh); } return self;
    },
    setTitle(title) { operations.push(op.setTitle(title)); return self; },
    setFormat(format) { operations.push(op.setFormat(format)); return self; },
    addCitation(citation) { operations.push(op.addCitation(citation)); return self; },
    updateCitation(citation) { operations.push(op.updateCitation(citation)); return self; },
    removeCitation(citationId) {
      operations.push(op.removeCitation(citationId));
      for (const block of findBlocks(snapshot, { citationId })) if (versions.has(block.id)) tick(block.id); return self;
    },
    build() {
      if (problems.length) throw new Error(problems.map(problem => `${problem.message} (${problem.blockId ?? 'transaction'})`).join(' '));
      return { id, actor: { ...actor }, baseRevision: snapshot.revision, ...(options.conflictPolicy ? { conflictPolicy: options.conflictPolicy } : {}), operations: [...operations] };
    },
    commit() {
      if (problems.length) return { ok: false, issues: [...problems], currentRevision: editor.getSnapshot().revision };
      if (!operations.length) return { ok: false, issues: [{ code: 'validation', message: 'The transaction has no operations.', hint: 'Call insert, update, replaceText, move, remove or another builder method before commit().' }], currentRevision: editor.getSnapshot().revision };
      return editor.apply(self.build());
    },
  };
  return self;
}

