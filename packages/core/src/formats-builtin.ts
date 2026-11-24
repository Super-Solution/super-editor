// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { createDocument, createEditor } from './editor.js';
import { chartRowsWarning, checkDocument, lossWarnings, unknownOptionIssues, type ExportResult, type FidelityTable, type FormatCapability, type FormatWarning, type ImportBaseOptions, type ImportResult, type SyncExporter, type SyncImporter } from './formats.js';
import { inlineToPlain, runs as parseRuns } from './inline.js';
import { fromMarkdown, toHTML, toMarkdown, toPlainText, type HtmlOptions, type MarkdownOptions, type PlainTextOptions } from './markdown.js';
import { withHints } from './issues.js';
import type { EditorIssue, ResearchDocument } from './types.js';
import { LIMITS, safeUrl } from './validation.js';

/**
 * Markdown, HTML and plain text as `Exporter`s, and Markdown as an `Importer`. They stay in core because `toMarkdown`, `toHTML`,
 * `toPlainText` and `fromMarkdown` are pinned by `conformance/render.v1.json` and ported to Go and Python; moving them would
 * split one reference implementation in two. What the objects add is the contract: a stable id and mime type, the honest table of
 * what each format cannot carry, and the warnings that follow from it.
 */

const issue = (path: string, message: string, hint: string): EditorIssue => ({ code: 'validation', path, message, hint });
function booleanOption(options: Record<string, unknown>, name: string): EditorIssue[] {
  return name in options && typeof options[name] !== 'boolean' ? [issue(`options.${name}`, `Expected true or false.`, `Pass a boolean for "${name}" or omit it.`)] : [];
}
function chartRowsOption(options: Record<string, unknown>): EditorIssue[] {
  const value = options.chartRows;
  return 'chartRows' in options && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > LIMITS.chartPoints)
    ? [issue('options.chartRows', `Expected a whole number from 0 to ${LIMITS.chartPoints}.`, 'Use how many data rows of a chart to show; the rest become "more rows omitted".')] : [];
}

/** Builds a text exporter. Every built-in one is the same shape: check options, check the document, render, then add the loss report. */
function textExporter<Options extends { chartRows?: number }>(info: { id: string; label: string; mime: string; ext: string; capabilities: readonly FormatCapability[]; fidelity: FidelityTable }, allowed: readonly string[], check: (options: Record<string, unknown>) => EditorIssue[], render: (document: ResearchDocument, options: Options) => string, defaultChartRows: number): SyncExporter<Options> {
  return {
    ...info,
    export(document, options): ExportResult {
      const issues = unknownOptionIssues(options, allowed);
      if (!issues.length && options !== undefined) issues.push(...check(options as Record<string, unknown>));
      if (issues.length) return { ok: false, issues: withHints(issues) };
      const checked = checkDocument(document);
      if (!checked.ok) return checked;
      const rows = options?.chartRows ?? defaultChartRows, cut = chartRowsWarning(checked.document, rows);
      return { ok: true, data: render(checked.document, options ?? ({} as Options)), mime: info.mime, ext: info.ext, warnings: [...lossWarnings(checked.document, info.fidelity), ...(cut ? [cut] : [])] };
    },
  };
}

export const MARKDOWN_FIDELITY: FidelityTable = {
  underline: { level: 'dropped', note: 'Markdown has no underline. Use bold or italic where the emphasis matters.' },
  highlight: { level: 'dropped', note: 'Markdown has no highlight. Use bold where the emphasis matters.' },
  toggle: { level: 'degraded', note: 'A toggle becomes a bold title with its content below it; whether it was open is lost.' },
  chart: { level: 'degraded', note: 'A chart becomes its data table. Export to a format that can draw it (or attach the picture) if the picture matters.' },
  card: { level: 'degraded', note: 'A card becomes its alt text. Write an alt text that says what the card shows.' },
  embed: { level: 'degraded', note: 'An embed becomes a link.' },
  callout: { level: 'degraded', note: 'A callout is written as a GitHub alert (> [!NOTE]); other Markdown renderers show a plain block quote.' },
  metrics: { level: 'degraded', note: 'Metrics become a table.' },
  timestamp: { level: 'degraded', note: 'A timestamp becomes the text "label: time".' },
  toc: { level: 'degraded', note: 'A table of contents becomes a fixed outline list; it does not update when headings change.' },
  'table-header-column': { level: 'dropped', note: 'Markdown tables have a header row only; the header column is shown as a normal column.' },
  'page-format': { level: 'dropped', note: 'Page size, font, font size and line height are not part of Markdown.' },
};
export const HTML_FIDELITY: FidelityTable = {
  chart: { level: 'degraded', note: 'A chart becomes its data table in a figure. Add a chart renderer on the page, or export a format that can draw it.' },
  card: { level: 'degraded', note: 'A card becomes its alt text in a figure.' },
  embed: { level: 'degraded', note: 'An embed becomes a link; the HTML has no iframes by design.' },
  'page-format': { level: 'dropped', note: 'Page size, font, font size and line height are not written; style the HTML with your own CSS (or use standalone for a neutral sheet).' },
};
export const TEXT_FIDELITY: FidelityTable = {
  underline: { level: 'dropped', note: 'Plain text has no text styling.' },
  highlight: { level: 'dropped', note: 'Plain text has no text styling.' },
  strike: { level: 'dropped', note: 'Plain text has no text styling.' },
  'inline-code': { level: 'dropped', note: 'Plain text has no text styling.' },
  hyperlink: { level: 'dropped', note: 'Only the link text is written, not its target. Use Markdown or HTML to keep links.' },
  toggle: { level: 'degraded', note: 'A toggle becomes its title line.' },
  'table-alignment': { level: 'dropped', note: 'Columns are tab-separated; alignment is lost.' },
  'table-header-column': { level: 'dropped', note: 'The header column is shown as a normal column.' },
  chart: { level: 'degraded', note: 'A chart becomes a short data listing.' },
  card: { level: 'degraded', note: 'A card becomes its alt text.' },
  embed: { level: 'degraded', note: 'An embed becomes "title (url)".' },
  image: { level: 'degraded', note: 'An image becomes "[Image: alt text]".' },
  callout: { level: 'degraded', note: 'A callout becomes its tone and title followed by its text.' },
  metrics: { level: 'degraded', note: 'Metrics become one line each.' },
  toc: { level: 'degraded', note: 'A table of contents becomes an indented list of headings.' },
  'page-break': { level: 'degraded', note: 'A page break is written as a rule, the same as a divider.' },
  'page-format': { level: 'dropped', note: 'Page size, font, font size and line height are not part of plain text.' },
};

export const markdownExporter: SyncExporter<MarkdownOptions> = textExporter<MarkdownOptions>(
  { id: 'markdown', label: 'Markdown', mime: 'text/markdown; charset=utf-8', ext: 'md', capabilities: ['tables', 'numbering'], fidelity: MARKDOWN_FIDELITY },
  ['title', 'chartRows'], options => [...booleanOption(options, 'title'), ...chartRowsOption(options)], toMarkdown, 100);
export const htmlExporter: SyncExporter<HtmlOptions> = textExporter<HtmlOptions>(
  { id: 'html', label: 'HTML', mime: 'text/html; charset=utf-8', ext: 'html', capabilities: ['tables', 'numbering'], fidelity: HTML_FIDELITY },
  ['title', 'standalone', 'chartRows'], options => [...booleanOption(options, 'title'), ...booleanOption(options, 'standalone'), ...chartRowsOption(options)], toHTML, 100);
export const textFormatExporter: SyncExporter<PlainTextOptions> = textExporter<PlainTextOptions>(
  { id: 'text', label: 'Plain text', mime: 'text/plain; charset=utf-8', ext: 'txt', capabilities: ['tables', 'numbering'], fidelity: TEXT_FIDELITY },
  ['title', 'chartRows'], options => [...booleanOption(options, 'title'), ...chartRowsOption(options)], toPlainText, 20);

// ---- Markdown importer ---------------------------------------------------------------------------------------------

export type MarkdownImportOptions = ImportBaseOptions & {
  /** Block IDs are `<idPrefix>-1`, `<idPrefix>-2`, … Default `md`. */
  idPrefix?: string;
};
export const MARKDOWN_LOSSES = {
  'markdown-html-kept-as-text': 'Lines that start with an HTML tag or comment are kept as literal text, tags included. Convert them to Markdown first, or remove them.',
  'markdown-setext-heading-kept-as-text': 'A heading underlined with === or --- is not read as a heading. Write it with # instead.',
  'markdown-heading-level-clamped': 'Headings deeper than level 3 are imported as level 3, because the document has three heading levels.',
  'markdown-footnotes-kept-as-text': 'Footnote definitions become paragraphs and [^n] markers stay in the text; no citations are created, because a citation needs a title, a URL and an access date. Add citations with addCitation and mark them in the text.',
  'markdown-inline-formatting-flattened': 'Bold, italic, code, strikethrough and links inside list items and table cells are flattened to plain text (link targets are kept in parentheses), because those cells hold plain strings.',
  'markdown-image-kept-as-text': 'Only https images are imported; the others stay as text. Host the image on https.',
} as const;
type MarkdownLossCode = keyof typeof MARKDOWN_LOSSES;

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
const HTML_LINE = /^ {0,3}(?:<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>|<!--)/;
const BLOCK_START = /^ {0,3}(?:#{1,6}(?:\s|$)|>|[-*+]\s|\d{1,9}[.)]\s|\||`{3,}|~{3,}|<)/;
const LIST_ITEM = /^ *(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const IMAGE_LINE = /^ {0,3}!\[[^\]]*\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)\s*$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const formatted = (text: string): boolean => parseRuns(text).some(run => run.bold || run.italic || run.code || run.strike || run.href !== undefined);

/** Marks the lines that are inside (or are) a fenced code block, using the same opening and closing rule as `fromMarkdown`. */
function fencedLines(lines: readonly string[]): boolean[] {
  const flags: boolean[] = []; let fence: string | undefined;
  for (const text of lines) {
    const mark = FENCE_LINE.exec(text);
    if (fence === undefined) { flags.push(mark !== null); if (mark) fence = mark[1]!; continue; }
    flags.push(true);
    if (mark && mark[1]![0] === fence[0] && mark[1]!.length >= fence.length && /^ {0,3}[`~]+\s*$/.test(text)) fence = undefined;
  }
  return flags;
}

/** What in the source the importer cannot hold. Detection reads the lines outside code fences and reports every kind it finds, with the count and the first line (`path: "line N"`). */
function markdownLosses(source: string, lineOffset: number): FormatWarning[] {
  const found = new Map<MarkdownLossCode, { count: number; first: number }>();
  const note = (code: MarkdownLossCode, line: number, count = 1): void => { const entry = found.get(code); if (entry) entry.count += count; else found.set(code, { count, first: line }); };
  const lines = source.replace(/\r\n?/g, '\n').split('\n'), fenced = fencedLines(lines);
  const isTableHead = (index: number): boolean => !fenced[index] && lines[index]!.includes('|') && TABLE_RULE.test(lines[index + 1] ?? '') && (lines[index + 1] ?? '').includes('|');
  let tableEnd = -1;
  lines.forEach((text, index) => {
    if (fenced[index]) return;
    const line = index + 1 + lineOffset, previous = lines[index - 1];
    if (isTableHead(index)) { tableEnd = index + 1; while (tableEnd + 1 < lines.length && lines[tableEnd + 1]!.trim() && lines[tableEnd + 1]!.includes('|')) tableEnd++; }
    const tableRow = index <= tableEnd && !(index > 0 && isTableHead(index - 1));
    if (HTML_LINE.test(text)) note('markdown-html-kept-as-text', line);
    if (previous?.trim() && !fenced[index - 1] && !BLOCK_START.test(previous) && !TABLE_RULE.test(previous) && (/^ {0,3}=+\s*$/.test(text) || /^ {0,3}-{2,}\s*$/.test(text))) note('markdown-setext-heading-kept-as-text', line);
    if (/^ {0,3}#{4,6}(?:\s|$)/.test(text)) note('markdown-heading-level-clamped', line);
    if (/^\[\^[^\]]+\]:\s/.test(text)) note('markdown-footnotes-kept-as-text', line);
    else { const markers = text.match(/\[\^[^\]\s]+\]/g)?.length ?? 0; if (markers) note('markdown-footnotes-kept-as-text', line, markers); }
    const image = IMAGE_LINE.exec(text);
    if (image && !safeUrl(image[1], { httpsOnly: true })) note('markdown-image-kept-as-text', line);
    const item = LIST_ITEM.exec(text);
    if (!image && ((item && formatted(item[1]!)) || (tableRow && formatted(text)))) note('markdown-inline-formatting-flattened', line);
  });
  return [...found].map(([code, { count, first }]) => ({ code, message: `${count} ${count === 1 ? 'place' : 'places'} in the source cannot be imported as written (first at line ${first}).`, hint: MARKDOWN_LOSSES[code], count, path: `line ${first}` }));
}

const decodeUtf8 = (bytes: Uint8Array): string | null => {
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/^﻿/, ''); } catch { return null; }
};

/**
 * Block-level Markdown to a new document (the same reading as `fromMarkdown`) with a report of what the source holds that the
 * editor cannot (`MARKDOWN_LOSSES`). The title is `options.title`, else the first line when it is a level-1 `#` heading (which then
 * is not repeated as a block); with neither the import is refused, never given a made-up title. Bytes must be valid UTF-8.
 */
export const markdownImporter: SyncImporter<MarkdownImportOptions> = {
  id: 'markdown', label: 'Markdown', mime: 'text/markdown; charset=utf-8', extensions: ['md', 'markdown'], losses: MARKDOWN_LOSSES,
  import(input, options): ImportResult {
    const bad = (issues: EditorIssue[]): ImportResult => ({ ok: false, issues: withHints(issues) });
    const unknown = unknownOptionIssues(options, ['id', 'title', 'now', 'idPrefix']);
    if (unknown.length) return bad(unknown);
    if (typeof options?.id !== 'string') return bad([issue('options.id', 'A document id is required.', 'Pass { id: "…", title: "…" }.')]);
    const source = typeof input === 'string' ? input.replace(/^﻿/, '') : decodeUtf8(input);
    if (source === null) return bad([issue('input', 'The bytes are not valid UTF-8.', 'Convert the file to UTF-8 before importing. Nothing was guessed or replaced.')]);
    let body = source, title = options.title;
    if (title === undefined) {
      const first = /^(?:[ \t]*\r?\n)*( {0,3}#[ \t]+([^\r\n]*?)(?:[ \t]+#+)?[ \t]*)(?:\r?\n|$)/.exec(source);
      const text = first ? inlineToPlain(first[2]!).trim() : '';
      if (text) { title = text; body = source.slice(first![0].length); }
    }
    if (title === undefined || title.trim() === '') return bad([issue('options.title', 'The Markdown has no level-1 heading on its first line and no title was given.', 'Pass options.title, or start the Markdown with "# Title".')]);
    const idPrefix = options.idPrefix ?? 'md';
    let blocks;
    try { blocks = fromMarkdown(body, { idPrefix, citationMarkers: false }); } catch (error) { return bad([issue('options.idPrefix', error instanceof Error ? error.message : String(error), 'Use letters, digits, ".", "_", ":" or "-" and start with a letter or digit.')]); }
    try {
      const editorOptions = options.now ? { now: options.now } : {};
      const editor = createEditor(createDocument({ id: options.id, title }, editorOptions), editorOptions);
      if (blocks.length) {
        const applied = editor.apply({ id: 'import-markdown', actor: { id: 'import:markdown', kind: 'system' }, baseRevision: 0, operations: [{ type: 'insertBlocks', blocks }] });
        if (!applied.ok) return bad(applied.issues);
      }
      return { ok: true, document: editor.getSnapshot(), warnings: markdownLosses(body, source.length - body.length ? source.slice(0, source.length - body.length).split('\n').length - 1 : 0) };
    } catch (error) {
      return bad([issue('options', error instanceof Error ? error.message : String(error), 'Check the document id and title.')]);
    }
  },
};
