// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { LIMITS, type EditorIssue } from '@supersolutions/super-editor-core';
import type { ResolveImage } from './images.js';

export type HeaderFooter = string | { text: string; align?: 'left' | 'center' | 'right' };
export type DocxLabels = {
  /** Heading of the list of sources at the end, and the lead-in of a block's own sources. Default "Sources". */
  sources: string;
  accessed: string;
  published: string;
  /** In `[Image: alt text]`. Default "Image". */
  image: string;
  /** Column headings of a metrics table. */
  metric: string; value: string; change: string; note: string;
  /** Under a chart table that was cut. `{count}` is the number of rows left out. */
  moreRows: string;
};
export type DocxOptions = {
  /** Start with the document title in the Title style. Default true. */
  title?: boolean;
  /** Stored as the file's author. Omitted when not given; nothing is guessed. */
  author?: string;
  /** Language of the text (BCP 47, for example `en-US`, `zh-TW`). Default `en-US`. Word uses it for spell checking and line breaking. */
  language?: string;
  /** Language for East Asian text, when it differs. Omitted by default. */
  eastAsiaLanguage?: string;
  /** Font names for the document's `font` setting (`sans`, `serif`, `mono`), and an East Asian font. Defaults: Calibri, Times New Roman, Consolas; no East Asian font (Word picks one for the language). */
  fonts?: { sans?: string; serif?: string; mono?: string; eastAsia?: string };
  /** Paper. Defaults to the document's own `format.page` (A4 or letter); a `screen` document, which has no paper size, is written on A4. */
  page?: { size?: 'A4' | 'letter' | { widthMm: number; heightMm: number }; orientation?: 'portrait' | 'landscape'; marginsMm?: { top?: number; right?: number; bottom?: number; left?: number } };
  /** Text above or below every page. `{page}`, `{pages}` and `{title}` are replaced (by the page number, the page count, the document title). */
  header?: HeaderFooter;
  footer?: HeaderFooter;
  labels?: Partial<DocxLabels>;
  /** Data rows of a chart's table before "more rows omitted". Default 100. */
  chartRows?: number;
  /** Deflate the parts. Default true. */
  compress?: boolean;
  /**
   * Turns an image block's address into PNG, JPEG or GIF bytes so the picture is embedded in the file. Without it an image is written as
   * "[Image: alt text]" and a link. The package never fetches the address itself; see `ResolveImage` for what a resolver must guard. A
   * function cannot travel as JSON, so over HTTP, MCP and the CLI the host sets it by registering a configured exporter.
   */
  resolveImage?: ResolveImage;
};

export const DEFAULT_LABELS: DocxLabels = { sources: 'Sources', accessed: 'accessed', published: 'published', image: 'Image', metric: 'Metric', value: 'Value', change: 'Change', note: 'Note', moreRows: '… {count} more rows omitted' };
export const DEFAULT_FONTS = { sans: 'Calibri', serif: 'Times New Roman', mono: 'Consolas' } as const;
export const DEFAULT_MARGIN_MM = 25.4;
const TOP = ['title', 'author', 'language', 'eastAsiaLanguage', 'fonts', 'page', 'header', 'footer', 'labels', 'chartRows', 'compress', 'resolveImage'];
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

const issue = (path: string, message: string, hint: string): EditorIssue => ({ code: 'validation', path, message, hint });
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function names(value: unknown, path: string, allowed: readonly string[], out: EditorIssue[]): value is Record<string, unknown> {
  if (!isObject(value)) { out.push(issue(path, 'Expected an object.', `Valid fields: ${allowed.join(', ')}.`)); return false; }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) out.push(issue(`${path}.${key}`, `Unknown option "${key}".`, `Valid fields: ${allowed.join(', ')}.`));
  return true;
}
function text(value: unknown, path: string, max: number, out: EditorIssue[], pattern?: RegExp): void {
  if (typeof value !== 'string' || value === '' || value.length > max || (pattern && !pattern.test(value))) out.push(issue(path, `Expected a nonempty string of at most ${max} characters${pattern ? ' in the right form' : ''}.`, pattern === LANGUAGE ? 'Use a BCP 47 language tag such as "en-US" or "zh-TW".' : 'Pass a short string or omit the option.'));
}
function millimetres(value: unknown, path: string, min: number, max: number, out: EditorIssue[]): void {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) out.push(issue(path, `Expected a number of millimetres from ${min} to ${max}.`, 'Use millimetres, for example 25.4 for one inch.'));
}
function headerFooter(value: unknown, path: string, out: EditorIssue[]): void {
  if (typeof value === 'string') { text(value, path, 500, out); return; }
  if (!names(value, path, ['text', 'align'], out)) return;
  text(value.text, `${path}.text`, 500, out);
  if ('align' in value && !['left', 'center', 'right'].includes(value.align as string)) out.push(issue(`${path}.align`, 'Expected left, center or right.', 'Omit it for the default.'));
}

/** Every problem with the options, at once, each with a path and a hint. Empty when the options are fine. */
export function optionIssues(options: unknown, extraNames: readonly string[] = []): EditorIssue[] {
  const out: EditorIssue[] = [];
  if (options === undefined) return out;
  if (!names(options, 'options', [...TOP, ...extraNames], out)) return out;
  if ('title' in options && typeof options.title !== 'boolean') out.push(issue('options.title', 'Expected true or false.', 'Pass a boolean or omit it.'));
  if ('compress' in options && typeof options.compress !== 'boolean') out.push(issue('options.compress', 'Expected true or false.', 'Pass a boolean or omit it.'));
  if ('resolveImage' in options && options.resolveImage !== undefined && typeof options.resolveImage !== 'function') out.push(issue('options.resolveImage', 'Expected a function that returns image bytes.', 'Pass resolveImage in code, or omit it. It cannot be sent as JSON.'));
  if ('author' in options) text(options.author, 'options.author', 200, out);
  if ('language' in options) text(options.language, 'options.language', 35, out, LANGUAGE);
  if ('eastAsiaLanguage' in options) text(options.eastAsiaLanguage, 'options.eastAsiaLanguage', 35, out, LANGUAGE);
  if ('chartRows' in options && (typeof options.chartRows !== 'number' || !Number.isSafeInteger(options.chartRows) || options.chartRows < 0 || options.chartRows > LIMITS.chartPoints)) out.push(issue('options.chartRows', `Expected a whole number from 0 to ${LIMITS.chartPoints}.`, 'Use how many data rows of a chart to show.'));
  if ('fonts' in options && names(options.fonts, 'options.fonts', ['sans', 'serif', 'mono', 'eastAsia'], out)) for (const [key, value] of Object.entries(options.fonts)) text(value, `options.fonts.${key}`, 100, out);
  if ('labels' in options && names(options.labels, 'options.labels', Object.keys(DEFAULT_LABELS), out)) for (const [key, value] of Object.entries(options.labels)) text(value, `options.labels.${key}`, 100, out);
  if ('header' in options) headerFooter(options.header, 'options.header', out);
  if ('footer' in options) headerFooter(options.footer, 'options.footer', out);
  if ('page' in options && names(options.page, 'options.page', ['size', 'orientation', 'marginsMm'], out)) {
    const page = options.page;
    if ('size' in page) {
      if (isObject(page.size)) { if (names(page.size, 'options.page.size', ['widthMm', 'heightMm'], out)) { millimetres(page.size.widthMm, 'options.page.size.widthMm', 50, 2_000, out); millimetres(page.size.heightMm, 'options.page.size.heightMm', 50, 2_000, out); } }
      else if (page.size !== 'A4' && page.size !== 'letter') out.push(issue('options.page.size', 'Expected "A4", "letter" or { widthMm, heightMm }.', 'Use a named size or give both dimensions in millimetres.'));
    }
    if ('orientation' in page && page.orientation !== 'portrait' && page.orientation !== 'landscape') out.push(issue('options.page.orientation', 'Expected portrait or landscape.', 'Omit it for portrait.'));
    if ('marginsMm' in page && names(page.marginsMm, 'options.page.marginsMm', ['top', 'right', 'bottom', 'left'], out)) for (const [key, value] of Object.entries(page.marginsMm)) millimetres(value, `options.page.marginsMm.${key}`, 0, 200, out);
  }
  return out;
}
