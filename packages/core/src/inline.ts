import { runsText } from './text.js';
import type { InlineRun } from './types.js';
import { safeUrl } from './validation.js';

/** Inline markdown-lite: **bold**, *italic* / _italic_, ~~strike~~, `code`, [label](https://url) and [^citation-id]. Backslash escapes the markers. */
type Marks = { bold?: true; italic?: true; strike?: true; code?: true; href?: string };
const MAX_DEPTH = 6;
/** Pathological input (thousands of unmatched markers) must not turn parsing quadratic: past the budget markers stay literal. */
type Context = { budget: number };
/** ASCII punctuation, as in CommonMark: a backslash before any of these yields the character itself. */
const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const isWord = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);
const isSpace = (char: string | undefined): boolean => char === undefined || /\s/u.test(char);

export function plainRuns(text: string): InlineRun[] { return text === '' ? [] : [{ text }]; }

function sameFormat(a: InlineRun, b: InlineRun): boolean {
  return a.bold === b.bold && a.italic === b.italic && a.code === b.code && a.href === b.href && a.strike === b.strike && a.underline === b.underline && a.highlight === b.highlight && a.citationId === undefined && b.citationId === undefined;
}
/** Merges neighbours with identical formatting and drops empty runs (citation markers excepted). */
export function normalizeRuns(runs: readonly InlineRun[]): InlineRun[] {
  const result: InlineRun[] = [];
  for (const run of runs) {
    if (run.text === '' && run.citationId === undefined) continue;
    const last = result[result.length - 1];
    if (last && sameFormat(last, run)) last.text += run.text; else result.push({ ...run });
  }
  return result;
}

function backtickRun(source: string, index: number): number { let count = 0; while (source[index + count] === '`') count++; return count; }
function findBackticks(source: string, from: number, count: number, ctx: Context): number {
  for (let index = from; index < source.length; index++) {
    if (--ctx.budget < 0) return -1;
    if (source[index] !== '`') continue;
    const length = backtickRun(source, index);
    if (length === count) return index;
    index += length - 1;
  }
  return -1;
}
function canOpen(source: string, index: number, delimiter: string): boolean {
  if (isSpace(source[index + delimiter.length])) return false;
  return delimiter !== '_' || !isWord(source[index - 1]);
}
function canClose(source: string, index: number, delimiter: string): boolean {
  if (isSpace(source[index - 1])) return false;
  return delimiter !== '_' || !isWord(source[index + 1]);
}
function findClose(source: string, from: number, delimiter: string, ctx: Context): number {
  for (let index = from; index < source.length; index++) {
    if (--ctx.budget < 0) return -1;
    const char = source[index];
    if (char === '\\') { index++; continue; }
    if (char === '`') {
      const length = backtickRun(source, index), close = findBackticks(source, index + length, length, ctx);
      index = close >= 0 ? close + length - 1 : index + length - 1; continue;
    }
    if (!source.startsWith(delimiter, index)) continue;
    if (delimiter.length === 1 && source[index + 1] === delimiter) { index++; continue; }
    if (canClose(source, index, delimiter)) return index;
  }
  return -1;
}
function matchBracket(source: string, open: number, ctx: Context): number {
  let depth = 0;
  for (let index = open; index < source.length && index < open + 2_000; index++) {
    if (--ctx.budget < 0) return -1;
    const char = source[index];
    if (char === '\\') { index++; continue; }
    if (char === '[') depth++;
    else if (char === ']' && --depth === 0) return index;
  }
  return -1;
}
const DELIMITERS: { token: string; marks: Marks }[] = [
  { token: '***', marks: { bold: true, italic: true } }, { token: '**', marks: { bold: true } }, { token: '~~', marks: { strike: true } },
  { token: '*', marks: { italic: true } }, { token: '_', marks: { italic: true } },
];

function parse(source: string, marks: Marks, depth: number, out: InlineRun[], ctx: Context): void {
  let buffer = '', index = 0;
  const flush = (): void => { if (buffer) out.push({ text: buffer, ...marks }); buffer = ''; };
  scan: while (index < source.length) {
    const char = source[index]!;
    if (char === '\\' && index + 1 < source.length && ESCAPABLE.includes(source[index + 1]!)) { buffer += source[index + 1]; index += 2; continue; }
    if (char === '`') {
      const length = backtickRun(source, index), close = findBackticks(source, index + length, length, ctx);
      if (close >= 0) {
        let code = source.slice(index + length, close);
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim()) code = code.slice(1, -1);
        flush(); out.push({ text: code, ...marks, code: true }); index = close + length; continue;
      }
      buffer += '`'.repeat(length); index += length; continue;
    }
    if (char === '[') {
      const marker = /^\[\^([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\]/.exec(source.slice(index, index + 134));
      if (marker) { flush(); out.push({ text: '', citationId: marker[1]! }); index += marker[0].length; continue; }
    }
    // An image has no inline form, so ![alt](url) becomes a link labelled with the alt text.
    const imageLink = char === '!' && source[index + 1] === '[';
    if ((char === '[' || imageLink) && depth < MAX_DEPTH) {
      const open = imageLink ? index + 1 : index, close = matchBracket(source, open, ctx);
      if (close > 0 && source[close + 1] === '(') {
        const end = source.slice(close + 2, close + 4_200).indexOf(')');
        if (end >= 0) {
          const target = source.slice(close + 2, close + 2 + end).trim().split(/\s+/u)[0]?.replace(/^<|>$/g, '') ?? '', href = safeUrl(target);
          if (href) { flush(); parse(source.slice(open + 1, close) || href, { ...marks, href }, depth + 1, out, ctx); index = close + 2 + end + 1; continue; }
        }
      }
    }
    if (depth < MAX_DEPTH) {
      for (const { token, marks: added } of DELIMITERS) {
        if (!source.startsWith(token, index) || !canOpen(source, index, token)) continue;
        const close = findClose(source, index + token.length, token, ctx);
        if (close <= index + token.length) continue;
        flush(); parse(source.slice(index + token.length, close), { ...marks, ...added }, depth + 1, out, ctx); index = close + token.length; continue scan;
      }
    }
    buffer += char; index++;
  }
  flush();
}

/**
 * Parses inline markdown-lite into runs. Unmatched markers stay literal text, so arbitrary prose is safe.
 * Use `plainRuns(text)` for text that must not be interpreted (data values such as `BTC_USDT`).
 */
export function runs(markdown: string): InlineRun[] {
  const out: InlineRun[] = [];
  parse(markdown, {}, 0, out, { budget: 2_000_000 });
  return normalizeRuns(out);
}

// ---- serialization -------------------------------------------------------------------------------------------------

/** Escapes inline markdown specials. Line-start constructs are escaped separately by `escapeLineStarts`. */
export function escapeInline(text: string): string {
  return text.replace(/[\\`*_~[\]<]/g, '\\$&').replace(/&(?=#?\w+;)/g, '\\&');
}
export function escapeLineStarts(text: string): string {
  return text.replace(/^( {0,3})(#{1,6}(?=\s|$)|>|[-+](?=\s|$))/gm, '$1\\$2').replace(/^( {0,3}\d+)([.)])(?=\s|$)/gm, '$1\\$2').replace(/^( {0,3})([=-])(?=[=-]*\s*$)/gm, '$1\\$2');
}
function codeSpan(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(entry => entry.length)), fence = '`'.repeat(longest + 1);
  return text.startsWith('`') || text.endsWith('`') ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}
/** Underline and highlight have no markdown form and are dropped. Block-level line breaks become hard breaks. */
export function runsToMarkdown(input: readonly InlineRun[]): string {
  let out = '';
  for (const run of normalizeRuns(input)) {
    if (run.text !== '') {
      const lead = /^\s*/u.exec(run.text)![0], trail = run.text.length > lead.length ? /\s*$/u.exec(run.text)![0] : '';
      const core = run.text.slice(lead.length, run.text.length - trail.length);
      let inner = run.code ? codeSpan(core) : escapeInline(core).replace(/\n/g, '  \n');
      if (core) {
        if (run.strike) inner = `~~${inner}~~`;
        if (run.bold && run.italic) inner = `***${inner}***`; else if (run.bold) inner = `**${inner}**`; else if (run.italic) inner = `*${inner}*`;
        if (run.href) inner = `[${inner}](${run.href.replace(/\(/g, '%28').replace(/\)/g, '%29')})`;
      }
      out += lead.replace(/\n/g, '  \n') + inner + trail.replace(/\n/g, '  \n');
    }
    if (run.citationId !== undefined) out += `[^${run.citationId}]`;
  }
  return out;
}

/** Plain text of a markdown-lite string, for list items and table cells that hold plain strings. Link targets are kept in parentheses. */
export function inlineToPlain(markdown: string): string {
  return runs(markdown).map(run => run.href && run.text !== run.href ? `${run.text} (${run.href})` : run.text).join('');
}
