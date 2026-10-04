import type { BlockContent, InlineRun } from './types.js';

/** Inline runs of the blocks that carry them (paragraph, quote, callout). */
export function runsOf(content: BlockContent): InlineRun[] | undefined {
  return content.type === 'paragraph' || content.type === 'quote' || content.type === 'callout' ? content.runs : undefined;
}
export function runsText(runs: readonly InlineRun[]): string { return runs.map(run => run.text).join(''); }

/**
 * The human-visible, replaceable text of a block, one string per text field in document order.
 * replaceText, blockText and search all read exactly these fields. Chart data, URLs and timestamps are excluded.
 */
export function textParts(content: BlockContent): string[] {
  switch (content.type) {
    case 'section': case 'toggle': return [content.title];
    case 'heading': case 'code': return [content.text];
    case 'paragraph': return [runsText(content.runs)];
    case 'quote': return [runsText(content.runs), ...(content.attribution === undefined ? [] : [content.attribution])];
    case 'callout': return [...(content.title === undefined ? [] : [content.title]), runsText(content.runs)];
    case 'list': return [...content.items];
    case 'table': return [...(content.caption === undefined ? [] : [content.caption]), content.columns.join('\t'), ...content.rows.map(row => row.join('\t'))];
    case 'chart': return [content.spec.title, ...(content.spec.caption === undefined ? [] : [content.spec.caption])];
    case 'embed': return [content.title];
    case 'image': return [content.alt, ...(content.caption === undefined ? [] : [content.caption])];
    case 'metrics': return content.items.flatMap(item => [item.label, item.value, ...(item.hint === undefined ? [] : [item.hint])]);
    case 'timestamp': return [content.label];
    case 'divider': case 'toc': case 'pageBreak': return [];
  }
}
export function contentText(content: BlockContent): string { return textParts(content).join('\n'); }

function matcher(find: string, caseSensitive: boolean): RegExp {
  return new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseSensitive ? 'gu' : 'giu');
}
function replaceString(text: string, pattern: RegExp, replace: string, budget: number): { text: string; count: number } {
  let out = '', last = 0, count = 0;
  for (const match of text.matchAll(pattern)) {
    if (count >= budget) break;
    out += text.slice(last, match.index) + replace; last = match.index + match[0].length; count++;
  }
  return { text: out + text.slice(last), count };
}
/** Matches may span runs. The replacement takes the formatting of the run where the match starts. */
function replaceRuns(runs: readonly InlineRun[], pattern: RegExp, replace: string, budget: number): { runs: InlineRun[]; count: number } {
  const full = runsText(runs);
  const found: { start: number; end: number }[] = [];
  for (const match of full.matchAll(pattern)) { if (found.length >= budget) break; found.push({ start: match.index, end: match.index + match[0].length }); }
  if (!found.length) return { runs: [...runs], count: 0 };
  const out: InlineRun[] = [];
  let offset = 0;
  for (const run of runs) {
    const runStart = offset, runEnd = offset + run.text.length; offset = runEnd;
    let text = '', cursor = runStart;
    for (const match of found) {
      if (match.end <= cursor) continue;
      if (match.start >= runEnd) break;
      if (match.start > cursor) { text += full.slice(cursor, match.start); cursor = match.start; }
      if (match.start >= runStart) text += replace;
      cursor = Math.min(match.end, runEnd);
    }
    text += full.slice(cursor, runEnd);
    // Runs emptied by the replacement disappear, except citation markers, which carry meaning without text.
    if (text.length > 0 || run.text.length === 0 || run.citationId !== undefined) out.push({ ...run, text });
  }
  return { runs: out, count: found.length };
}

export type ReplaceTextOptions = { find: string; replace: string; all?: boolean; caseSensitive?: boolean };
/** Returns null when the block type has no text. `count` is 0 when nothing matched. */
export function replaceInContent(content: BlockContent, options: ReplaceTextOptions): { content: BlockContent; count: number } | null {
  const pattern = matcher(options.find, options.caseSensitive ?? false);
  let budget = options.all ? Number.POSITIVE_INFINITY : 1, count = 0;
  const str = (text: string): string => {
    if (budget <= 0) return text;
    const result = replaceString(text, pattern, options.replace, budget); budget -= result.count; count += result.count; return result.text;
  };
  const optional = (text: string | undefined): string | undefined => text === undefined ? undefined : str(text);
  const runs = (value: InlineRun[]): InlineRun[] => {
    if (budget <= 0) return value;
    const result = replaceRuns(value, pattern, options.replace, budget); budget -= result.count; count += result.count; return result.runs;
  };
  let next: BlockContent;
  switch (content.type) {
    case 'section': case 'toggle': next = { ...content, title: str(content.title) }; break;
    case 'heading': case 'code': next = { ...content, text: str(content.text) }; break;
    case 'paragraph': next = { ...content, runs: runs(content.runs) }; break;
    case 'quote': { const replaced = runs(content.runs), attribution = optional(content.attribution); next = { ...content, runs: replaced, ...(attribution === undefined ? {} : { attribution }) }; break; }
    case 'callout': { const title = optional(content.title); next = { ...content, ...(title === undefined ? {} : { title }), runs: runs(content.runs) }; break; }
    case 'list': next = { ...content, items: content.items.map(str) }; break;
    case 'table': { const caption = optional(content.caption); next = { ...content, ...(caption === undefined ? {} : { caption }), columns: content.columns.map(str), rows: content.rows.map(row => row.map(str)) }; break; }
    case 'chart': { const caption = optional(content.spec.caption); next = { ...content, spec: { ...content.spec, title: str(content.spec.title), ...(caption === undefined ? {} : { caption }) } }; break; }
    case 'embed': next = { ...content, title: str(content.title) }; break;
    case 'image': { const caption = optional(content.caption); next = { ...content, alt: str(content.alt), ...(caption === undefined ? {} : { caption }) }; break; }
    case 'metrics': next = { ...content, items: content.items.map(item => { const label = str(item.label), value = str(item.value), hint = optional(item.hint); return { ...item, label, value, ...(hint === undefined ? {} : { hint }) }; }) }; break;
    case 'timestamp': next = { ...content, label: str(content.label) }; break;
    case 'divider': case 'toc': case 'pageBreak': return null;
  }
  return { content: next, count };
}
