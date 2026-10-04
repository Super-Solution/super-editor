import type { Highlight, InlineRun } from '@super-solution/editor-core';

/** Pure inline-run algebra. Offsets are UTF-16 offsets into the concatenated run text; citation markers occupy no offset. */
export type Mark = 'bold' | 'italic' | 'underline' | 'strike' | 'code';
export type MarkState = 'none' | 'some' | 'all';
export const MARKS: readonly Mark[] = ['bold', 'italic', 'underline', 'strike', 'code'];

export function runsLength(runs: readonly InlineRun[]): number { let total = 0; for (const run of runs) total += run.text.length; return total; }
export function runsPlainText(runs: readonly InlineRun[]): string { return runs.map((run) => run.text).join(''); }
function formatOf(run: InlineRun): Omit<InlineRun, 'text' | 'citationId'> { const { text: _text, citationId: _citation, ...format } = run; return format; }
function sameFormat(a: InlineRun, b: InlineRun): boolean {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code && !!a.strike === !!b.strike && !!a.underline === !!b.underline && a.highlight === b.highlight && a.href === b.href;
}
/** Drops empty runs (except citation markers) and merges neighbours with equal formatting. A marker stays at the end of its run. */
export function normalizeRuns(runs: readonly InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const run of runs) {
    if (run.text === '' && run.citationId === undefined) continue;
    const last = out[out.length - 1];
    if (last && last.citationId === undefined && run.text !== '' && last.text !== '' && sameFormat(last, run)) {
      const merged: InlineRun = { ...last, text: last.text + run.text };
      if (run.citationId !== undefined) merged.citationId = run.citationId;
      out[out.length - 1] = merged;
    } else out.push({ ...run });
  }
  return out;
}
/** Splits at `offset`. Runs ending exactly at the offset, with their markers, stay on the left. */
export function splitRuns(runs: readonly InlineRun[], offset: number): [InlineRun[], InlineRun[]] {
  const left: InlineRun[] = [], right: InlineRun[] = [];
  let position = 0;
  for (const run of runs) {
    const start = position, end = position + run.text.length;
    position = end;
    if (end <= offset) left.push({ ...run });
    else if (start >= offset) right.push({ ...run });
    else {
      const cut = offset - start;
      const head: InlineRun = { ...run, text: run.text.slice(0, cut) };
      delete head.citationId;
      left.push(head);
      right.push({ ...run, text: run.text.slice(cut) });
    }
  }
  return [normalizeRuns(left), normalizeRuns(right)];
}
export function sliceRuns(runs: readonly InlineRun[], start: number, end: number): InlineRun[] {
  const [, rest] = splitRuns(runs, start);
  return splitRuns(rest, Math.max(0, end - start))[0];
}
export function concatRuns(a: readonly InlineRun[], b: readonly InlineRun[]): InlineRun[] { return normalizeRuns([...a, ...b]); }
/** Applies `change` to the portion of the runs inside [start, end). */
function mapRange(runs: readonly InlineRun[], start: number, end: number, change: (run: InlineRun) => InlineRun): InlineRun[] {
  const [before, rest] = splitRuns(runs, start);
  const [middle, after] = splitRuns(rest, Math.max(0, end - start));
  return normalizeRuns([...before, ...middle.map((run) => run.text === '' ? run : change(run)), ...after]);
}
export function markState(runs: readonly InlineRun[], start: number, end: number, mark: Mark): MarkState {
  let covered = 0, marked = 0, position = 0;
  for (const run of runs) {
    const from = Math.max(start, position), to = Math.min(end, position + run.text.length);
    position += run.text.length;
    if (to <= from) continue;
    covered += to - from;
    if (run[mark]) marked += to - from;
  }
  return covered === 0 || marked === 0 ? 'none' : marked === covered ? 'all' : 'some';
}
/** Docs semantics: if the whole range already has the mark it is removed, otherwise it is added everywhere. */
export function toggleMark(runs: readonly InlineRun[], start: number, end: number, mark: Mark, force?: boolean): InlineRun[] {
  if (end <= start) return [...runs];
  const on = force ?? markState(runs, start, end, mark) !== 'all';
  return mapRange(runs, start, end, (run) => {
    const next = { ...run };
    if (on) next[mark] = true; else delete next[mark];
    return next;
  });
}
export function highlightState(runs: readonly InlineRun[], start: number, end: number): Highlight | 'mixed' | null {
  let found: Highlight | undefined, any = false, position = 0, plain = false;
  for (const run of runs) {
    const from = Math.max(start, position), to = Math.min(end, position + run.text.length);
    position += run.text.length;
    if (to <= from) continue;
    any = true;
    if (run.highlight === undefined) plain = true; else if (found === undefined) found = run.highlight; else if (found !== run.highlight) return 'mixed';
  }
  if (!any || found === undefined) return null;
  return plain ? 'mixed' : found;
}
export function setHighlight(runs: readonly InlineRun[], start: number, end: number, highlight: Highlight | null): InlineRun[] {
  if (end <= start) return [...runs];
  return mapRange(runs, start, end, (run) => { const next = { ...run }; if (highlight) next.highlight = highlight; else delete next.highlight; return next; });
}
export function setLink(runs: readonly InlineRun[], start: number, end: number, href: string | null): InlineRun[] {
  if (end <= start) return [...runs];
  return mapRange(runs, start, end, (run) => { const next = { ...run }; if (href) next.href = href; else delete next.href; return next; });
}
/** Extent of the link containing `offset` (touching a link edge counts as inside it). */
export function linkAt(runs: readonly InlineRun[], offset: number): { href: string; start: number; end: number } | null {
  let position = 0;
  const spans: { href: string; start: number; end: number }[] = [];
  for (const run of runs) {
    const start = position, end = position + run.text.length;
    position = end;
    if (!run.href || run.text === '') continue;
    const last = spans[spans.length - 1];
    if (last && last.end === start && last.href === run.href) last.end = end; else spans.push({ href: run.href, start, end });
  }
  return spans.find((span) => offset >= span.start && offset <= span.end) ?? null;
}
export function deleteRange(runs: readonly InlineRun[], start: number, end: number): InlineRun[] {
  if (end <= start) return [...runs];
  const [before, rest] = splitRuns(runs, start);
  const [, after] = splitRuns(rest, end - start);
  return normalizeRuns([...before, ...after]);
}
/** Inserted text inherits the character formatting at the caret but never a link or citation marker. */
export function insertText(runs: readonly InlineRun[], offset: number, text: string): InlineRun[] {
  if (text === '') return [...runs];
  const [before, after] = splitRuns(runs, offset);
  const neighbour = [...before].reverse().find((run) => run.text !== '') ?? after.find((run) => run.text !== '');
  const inherited: Omit<InlineRun, 'text' | 'citationId'> = neighbour ? formatOf(neighbour) : {};
  delete inherited.href;
  return normalizeRuns([...before, { ...inherited, text }, ...after]);
}
export function replaceRange(runs: readonly InlineRun[], start: number, end: number, text: string): InlineRun[] {
  const from = Math.min(start, end), to = Math.max(start, end);
  return insertText(deleteRange(runs, from, to), from, text);
}
/** Word under or touching `offset`, as a [start, end) pair, or null when the caret sits between separators. */
export function wordRangeAt(text: string, offset: number): { start: number; end: number } | null {
  const word = /[\p{L}\p{N}_'’-]/u;
  let start = offset, end = offset;
  while (start > 0 && word.test(text[start - 1]!)) start--;
  while (end < text.length && word.test(text[end]!)) end++;
  return end > start ? { start, end } : null;
}
export function runsEqual(a: readonly InlineRun[], b: readonly InlineRun[]): boolean { return JSON.stringify(normalizeRuns(a)) === JSON.stringify(normalizeRuns(b)); }
export function runsFromText(text: string): InlineRun[] { return text === '' ? [] : [{ text }]; }
