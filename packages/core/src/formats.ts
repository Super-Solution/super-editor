// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { withHints } from './issues.js';
import { chartFallback } from './markdown.js';
import { runsOf } from './text.js';
import type { BlockContent, EditorIssue, ResearchDocument } from './types.js';
import { validateDocument } from './validation.js';

/**
 * The contract for document formats (Markdown, HTML, DOCX, PDF, …). Core only defines the shapes, the loss report and a small
 * registry; every format is its own implementation (built into core when a cross-language conformance file already pins it,
 * otherwise a separate package) and can be used without the registry. Nothing here touches the DOM, the network or the filesystem.
 *
 * The one rule behind the loss report: a conversion that cannot carry something says so. Each format declares a `FidelityTable`
 * (what it degrades or drops), `lossWarnings` compares the table with what the document really uses, and the result lists every
 * affected feature with the blocks it touches. Nothing is dropped silently.
 */

// ---- what a document uses ------------------------------------------------------------------------------------------

/** The features a format may not be able to carry. Plain paragraphs, headings, sections, lists, tables and code are not listed: every format has them. */
export const DOCUMENT_FEATURES = [
  'underline', 'highlight', 'strike', 'inline-code', 'hyperlink', 'citations',
  'toggle', 'todo-list', 'nested-list', 'table-alignment', 'table-header-column',
  'chart', 'card', 'embed', 'image', 'callout', 'metrics', 'timestamp', 'toc', 'page-break', 'page-format',
] as const;
export type DocumentFeature = typeof DOCUMENT_FEATURES[number];

export type FeatureUse = {
  feature: DocumentFeature;
  /** Blocks (or inline runs) that use it. Inline features count runs, the others count blocks. */
  count: number;
  /** IDs of the blocks that use it, in document order. Empty for `page-format`. */
  blockIds: string[];
  /** Validator-style path of the first use, for example `document.blocks[3]`. */
  path: string;
};

const DEFAULT_FORMAT = { page: 'screen', font: 'sans', fontSize: 16, lineHeight: 1.6 } as const;
const blockFeatures = (content: BlockContent): DocumentFeature[] => {
  switch (content.type) {
    case 'toggle': return ['toggle'];
    case 'list': return [...(content.style === 'todo' ? ['todo-list' as const] : []), ...(content.indent?.some(level => level > 0) ? ['nested-list' as const] : [])];
    case 'table': return [...(content.align?.some(align => align !== 'left') ? ['table-alignment' as const] : []), ...(content.headerColumn ? ['table-header-column' as const] : [])];
    case 'chart': case 'card': case 'embed': case 'image': case 'callout': case 'metrics': case 'timestamp': case 'toc': return [content.type];
    case 'pageBreak': return ['page-break'];
    default: return [];
  }
};

/** Every feature the document uses, with where. Feature order follows `DOCUMENT_FEATURES`. */
export function scanFeatures(document: ResearchDocument): FeatureUse[] {
  const uses = new Map<DocumentFeature, FeatureUse>();
  const note = (feature: DocumentFeature, blockId: string | undefined, path: string, runs = 1): void => {
    const entry = uses.get(feature) ?? { feature, count: 0, blockIds: [], path };
    entry.count += runs;
    if (blockId !== undefined && entry.blockIds[entry.blockIds.length - 1] !== blockId) entry.blockIds.push(blockId);
    uses.set(feature, entry);
  };
  document.blocks.forEach((block, index) => {
    const path = `document.blocks[${index}]`;
    for (const feature of blockFeatures(block.content)) note(feature, block.id, path);
    let inlineCitation = false;
    for (const run of runsOf(block.content) ?? []) {
      if (run.underline) note('underline', block.id, path);
      if (run.highlight) note('highlight', block.id, path);
      if (run.strike) note('strike', block.id, path);
      if (run.code) note('inline-code', block.id, path);
      if (run.href) note('hyperlink', block.id, path);
      if (run.citationId !== undefined) { note('citations', block.id, path); inlineCitation = true; }
    }
    // A block-level source counts once for the block, unless the block already marks its sources inline.
    if (block.citationIds.length && !inlineCitation) note('citations', block.id, path);
  });
  const format = document.format;
  if (format.page !== DEFAULT_FORMAT.page || format.font !== DEFAULT_FORMAT.font || format.fontSize !== DEFAULT_FORMAT.fontSize || format.lineHeight !== DEFAULT_FORMAT.lineHeight) note('page-format', undefined, 'document.format');
  return DOCUMENT_FEATURES.flatMap(feature => uses.get(feature) ?? []);
}

// ---- loss report ---------------------------------------------------------------------------------------------------

/** What a format does with a feature it cannot carry as is. Features that are absent from a table are carried. */
export type Fidelity = {
  /** `degraded`: still present in another form (a chart as its data table). `dropped`: gone from the output. */
  level: 'degraded' | 'dropped';
  /** One sentence for a person or an agent: what happens and what to do about it. */
  note: string;
};
export type FidelityTable = Readonly<Partial<Record<DocumentFeature, Fidelity>>>;

/**
 * Stable machine codes. `feature-degraded` and `feature-dropped` come from a `FidelityTable`; the others are raised by one format
 * for a specific situation. Match on `code`, show `message` and `hint`.
 */
export type FormatWarning = {
  code: string;
  message: string;
  /** Always the same words for the same cause, so an agent can fix every instance at once. */
  hint: string;
  feature?: DocumentFeature;
  /** How many uses (blocks or runs) are affected. */
  count?: number;
  /** The first affected blocks, in document order (at most `WARNING_BLOCKS`). `count` says how many there are in all. */
  blockIds?: string[];
  path?: string;
};
export const WARNING_BLOCKS = 20;

/** One warning per affected feature (not one per block), so a long document does not bury the short list of causes. */
export function lossWarnings(document: ResearchDocument, fidelity: FidelityTable): FormatWarning[] {
  const warnings: FormatWarning[] = [];
  for (const use of scanFeatures(document)) {
    const entry = fidelity[use.feature];
    if (!entry) continue;
    warnings.push({
      code: entry.level === 'dropped' ? 'feature-dropped' : 'feature-degraded', feature: use.feature, count: use.count,
      message: `${use.feature} ${entry.level === 'dropped' ? 'is not carried' : 'is carried in a reduced form'} (${use.count} ${use.count === 1 ? 'use' : 'uses'}).`,
      hint: entry.note, ...(use.blockIds.length ? { blockIds: use.blockIds.slice(0, WARNING_BLOCKS) } : {}), path: use.path,
    });
  }
  return warnings;
}

/** The warning for charts whose data table was cut to `maxRows` rows, or undefined when none was. Every format that writes a chart as a table should add it. */
export function chartRowsWarning(document: ResearchDocument, maxRows: number): FormatWarning | undefined {
  const cut: { id: string; path: string; omitted: number }[] = [];
  document.blocks.forEach((block, index) => { if (block.content.type === 'chart') { const omitted = chartFallback(block.content.spec, maxRows).omitted; if (omitted > 0) cut.push({ id: block.id, path: `document.blocks[${index}]`, omitted }); } });
  if (!cut.length) return undefined;
  return {
    code: 'chart-rows-omitted', feature: 'chart', count: cut.length, blockIds: cut.slice(0, WARNING_BLOCKS).map(entry => entry.id), path: cut[0]!.path,
    message: `${cut.length} ${cut.length === 1 ? 'chart was' : 'charts were'} cut to ${maxRows} data rows (${cut.reduce((sum, entry) => sum + entry.omitted, 0)} rows left out).`,
    hint: 'Raise the chartRows option to keep more rows, or export a format that can draw the chart.',
  };
}

// ---- exporters and importers ---------------------------------------------------------------------------------------

/** What a format can express beyond running text. A format lists only what it carries in full. */
export type FormatCapability = 'tracked-changes' | 'comments' | 'cards' | 'tables' | 'numbering' | 'page-layout';

export type ExportResult =
  /** `data` is a string for text formats and bytes otherwise. A text format is UTF-8 on the wire. */
  | { ok: true; data: string | Uint8Array; mime: string; ext: string; warnings: FormatWarning[] }
  | { ok: false; issues: EditorIssue[] };
export type ImportResult =
  | { ok: true; document: ResearchDocument; warnings: FormatWarning[] }
  | { ok: false; issues: EditorIssue[] };

export type FormatInfo = {
  id: string;
  /** Human-readable name, for example "Word document". */
  label: string;
  mime: string;
  ext: string;
  capabilities: readonly FormatCapability[];
  fidelity: FidelityTable;
};

/**
 * A way out of the editor. `export` takes a document that is already valid (`FormatRegistry.export` checks it; when you call an
 * exporter directly, it checks for itself), never mutates it, never throws on bad input (it returns `issues`) and lists every loss
 * in `warnings`. Options are an object of the exporter's own; unknown option names are refused, not ignored.
 */
export interface Exporter<Options extends object = Record<string, never>> extends FormatInfo {
  export(document: ResearchDocument, options?: Options): ExportResult | Promise<ExportResult>;
}

/** An exporter whose `export` never waits (the built-in text formats): the result can be used without `await`. Still an `Exporter`. */
export type SyncExporter<Options extends object = Record<string, never>> = Omit<Exporter<Options>, 'export'> & { export(document: ResearchDocument, options?: Options): ExportResult };

/** What every importer needs: the identity of the document it creates. Everything else is the importer's own. */
export type ImportBaseOptions = {
  /** Document id, same rules as `createDocument`. */
  id: string;
  /** Document title. Omit it and an importer that can find one uses it; otherwise the import is refused, not given a made-up title. */
  title?: string;
  /** Source of `createdAt` and `updatedAt`, as in `EditorOptions`. */
  now?: () => string;
};
export interface Importer<Options extends ImportBaseOptions = ImportBaseOptions> {
  id: string;
  label: string;
  mime: string;
  /** File extensions without a dot, most common first. */
  extensions: readonly string[];
  /**
   * Every warning code the importer can return, with the hint it carries: what the format has that the editor cannot hold, and
   * what the person can do about it. Lets a host show the limits before an import, not only after.
   */
  losses: Readonly<Record<string, string>>;
  /** Bytes must be valid for the format (a text format must be valid UTF-8); anything else is returned as `issues`. */
  import(input: string | Uint8Array, options: Options): ImportResult | Promise<ImportResult>;
}

/** An importer whose `import` never waits. Still an `Importer`. */
export type SyncImporter<Options extends ImportBaseOptions = ImportBaseOptions> = Omit<Importer<Options>, 'import'> & { import(input: string | Uint8Array, options: Options): ImportResult };

/** Refuses option names the exporter does not know, with the list of valid ones. Returns no issues for `undefined`. */
export function unknownOptionIssues(options: unknown, allowed: readonly string[]): EditorIssue[] {
  if (options === undefined) return [];
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return withHints([{ code: 'validation', path: 'options', message: 'Options must be an object.', hint: `Pass an object, for example { ${allowed[0] ?? 'title'}: … }, or omit it.` }]);
  return Object.keys(options).filter(key => !allowed.includes(key)).map((key): EditorIssue => ({
    code: 'validation', path: `options.${key}`, message: `Unknown option "${key}".`,
    hint: allowed.length ? `Valid options: ${allowed.join(', ')}.` : 'This format takes no options.',
  }));
}

/** The document check every exporter runs first. Returns the issues, or the valid document. */
export function checkDocument(document: unknown): { ok: true; document: ResearchDocument } | { ok: false; issues: EditorIssue[] } {
  const checked = validateDocument(document);
  return checked.ok ? { ok: true, document: checked.value } : { ok: false, issues: withHints(checked.issues) };
}

// ---- registry ------------------------------------------------------------------------------------------------------

// The registry stores exporters of any option type; callers pass options as `unknown` and the exporter validates them.
type AnyExporter = Exporter<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type AnyImporter = Importer<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const FORMAT_ID = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Formats by id. A host registers what it installed; every surface that offers "export as …" (a menu, an HTTP route, a tool) reads
 * the list from here instead of knowing the formats. Registering is explicit and refuses duplicates: two formats with one id would
 * make the same request mean different files on different machines.
 */
export interface FormatRegistry {
  addExporter(exporter: AnyExporter): void;
  addImporter(importer: AnyImporter): void;
  exporters(): FormatInfo[];
  importers(): Pick<Importer, 'id' | 'label' | 'mime' | 'extensions' | 'losses'>[];
  /** Validates the document, runs the exporter and always resolves (never rejects) with a result. */
  export(id: string, document: unknown, options?: unknown): Promise<ExportResult>;
  import(id: string, input: string | Uint8Array, options: ImportBaseOptions & Record<string, unknown>): Promise<ImportResult>;
  /** The importer for a file name's extension, or undefined. Case-insensitive. */
  importerForFile(fileName: string): Pick<Importer, 'id' | 'label' | 'extensions'> | undefined;
}

const notFound = (kind: 'exporter' | 'importer', id: string, known: string[]): { ok: false; issues: EditorIssue[] } => ({
  ok: false, issues: [{ code: 'not-found', path: 'format', message: `No ${kind} with id "${id}".`, hint: known.length ? `Registered ${kind}s: ${known.join(', ')}.` : `No ${kind}s are registered. Register one with add${kind === 'exporter' ? 'Exporter' : 'Importer'} first.` }],
});
const thrown = (id: string, error: unknown): { ok: false; issues: EditorIssue[] } => ({
  ok: false, issues: [{ code: 'validation', path: 'format', message: `Format "${id}" failed: ${error instanceof Error ? error.message : String(error)}`, hint: 'A format implementation threw instead of returning issues. Report it to the format package; the document was not changed.' }],
});

export function createFormatRegistry(): FormatRegistry {
  const exporters = new Map<string, AnyExporter>(), importers = new Map<string, AnyImporter>();
  const checkId = (id: unknown, kind: string): void => { if (typeof id !== 'string' || !FORMAT_ID.test(id)) throw new TypeError(`A ${kind} id is lowercase letters, digits and hyphens, starting with a letter (at most 40 characters).`); };
  return {
    addExporter(exporter) {
      checkId(exporter.id, 'format');
      if (exporters.has(exporter.id)) throw new TypeError(`An exporter with id "${exporter.id}" is already registered.`);
      exporters.set(exporter.id, exporter);
    },
    addImporter(importer) {
      checkId(importer.id, 'format');
      if (importers.has(importer.id)) throw new TypeError(`An importer with id "${importer.id}" is already registered.`);
      if (!importer.extensions.length) throw new TypeError(`Importer "${importer.id}" must list at least one file extension.`);
      importers.set(importer.id, importer);
    },
    exporters: () => [...exporters.values()].map(({ id, label, mime, ext, capabilities, fidelity }) => ({ id, label, mime, ext, capabilities, fidelity })),
    importers: () => [...importers.values()].map(({ id, label, mime, extensions, losses }) => ({ id, label, mime, extensions, losses })),
    async export(id, document, options) {
      const exporter = exporters.get(id);
      if (!exporter) return notFound('exporter', id, [...exporters.keys()]);
      const checked = checkDocument(document);
      if (!checked.ok) return checked;
      try { return await exporter.export(checked.document, options as never); } catch (error) { return thrown(id, error); }
    },
    async import(id, input, options) {
      const importer = importers.get(id);
      if (!importer) return notFound('importer', id, [...importers.keys()]);
      try { return await importer.import(input, options); } catch (error) { return thrown(id, error); }
    },
    importerForFile(fileName) {
      const dot = fileName.lastIndexOf('.');
      if (dot < 0) return undefined;
      const extension = fileName.slice(dot + 1).toLowerCase();
      for (const importer of importers.values()) if (importer.extensions.includes(extension)) return { id: importer.id, label: importer.label, extensions: importer.extensions };
      return undefined;
    },
  };
}
