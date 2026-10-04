import { escapeInline, escapeLineStarts, inlineToPlain, normalizeRuns, plainRuns, runs as parseRuns, runsToMarkdown } from './inline.js';
import { getOutline, type OutlineItem } from './query.js';
import { runsOf } from './text.js';
import type { Block, BlockContent, BlockInput, ChartSpec, InlineRun, ResearchDocument } from './types.js';
import { safeUrl } from './validation.js';

type Content<T extends BlockContent['type']> = Extract<BlockContent, { type: T }>;
type Tree = { document: ResearchDocument; children: Map<string | null, Block[]>; numbers: Map<string, number> };
function tree(document: ResearchDocument): Tree {
  const children = new Map<string | null, Block[]>();
  for (const block of document.blocks) { const siblings = children.get(block.parentId); if (siblings) siblings.push(block); else children.set(block.parentId, [block]); }
  return { document, children, numbers: new Map(document.citations.map((citation, index) => [citation.id, index + 1])) };
}
const line = (text: string): string => text.replace(/\s*\r?\n\s*/g, ' ').trim();
/** Block-level citations that are not already marked inline inside the same block. */
function blockSources(block: Block): string[] { const inline = new Set(runsOf(block.content)?.map(run => run.citationId)); return block.citationIds.filter(id => !inline.has(id)); }
const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const percent = (value: number): string => `${value > 0 ? '+' : ''}${value}%`;

/** The data table every non-visual export shows for a chart: candles, points, a matrix or the labels/series fallback. */
export function chartTable(spec: ChartSpec, maxRows: number): { head: string[]; rows: string[][]; omitted: number } {
  let head: string[], rows: string[][];
  if (spec.kind === 'candlestick' && spec.ohlc?.length) {
    const volume = spec.ohlc.some(candle => candle.v !== undefined);
    head = ['Time', 'Open', 'High', 'Low', 'Close', ...(volume ? ['Volume'] : [])];
    rows = spec.ohlc.map(candle => [candle.t, String(candle.o), String(candle.h), String(candle.l), String(candle.c), ...(volume ? [candle.v === undefined ? '' : String(candle.v)] : [])]);
  } else if (spec.kind === 'scatter' && spec.points?.length) {
    head = ['Series', spec.xLabel ?? 'x', spec.yAxis?.label ?? 'y']; rows = spec.points.map(point => [point.series, String(point.x), String(point.y)]);
  } else if (spec.kind === 'heatmap' && spec.matrix) {
    head = ['', ...spec.matrix.columns]; rows = spec.matrix.rows.map((row, index) => [row, ...(spec.matrix!.values[index] ?? []).map(String)]);
  } else {
    head = [spec.xLabel ?? '', ...spec.series.map(series => series.name)]; rows = spec.labels.map((label, index) => [label, ...spec.series.map(series => String(series.values[index] ?? ''))]);
  }
  return { head, rows: rows.slice(0, maxRows), omitted: Math.max(0, rows.length - maxRows) };
}
const chartDescriptor = (spec: ChartSpec): string => `${spec.kind} chart${spec.unit ? `, ${spec.unit}` : ''}${spec.asOf ? `, as of ${spec.asOf}` : ''}`;
const sourceLine = (spec: ChartSpec): string | undefined => spec.source ? `Source: ${spec.source}` : undefined;
const annotationLine = (spec: ChartSpec): string | undefined => spec.annotations?.length ? `Notes: ${spec.annotations.map(note => `${note.label} (${note.at}${note.value === undefined ? '' : `, ${note.value}`})`).join('; ')}` : undefined;

// ---- toMarkdown ----------------------------------------------------------------------------------------------------

export type MarkdownOptions = {
  /** Start with `# <title>`. Default true. */
  title?: boolean;
  /** Rows of chart data shown per chart before "more rows omitted". Default 100. */
  chartRows?: number;
};
const ALERTS: Record<Content<'callout'>['tone'], string> = { info: 'NOTE', success: 'TIP', note: 'IMPORTANT', warning: 'WARNING', danger: 'CAUTION' };
const TONES: Record<string, Content<'callout'>['tone']> = { NOTE: 'info', TIP: 'success', IMPORTANT: 'note', WARNING: 'warning', CAUTION: 'danger', INFO: 'info', SUCCESS: 'success', DANGER: 'danger' };

function mdTable(head: string[], rows: string[][], align?: readonly string[]): string {
  const cell = (text: string): string => escapeInline(line(text)).replace(/\|/g, '\\|');
  const rule = head.map((_, index) => align?.[index] === 'left' ? ':---' : align?.[index] === 'right' ? '---:' : align?.[index] === 'center' ? ':---:' : '---');
  return [head, rule, ...rows].map((row, index) => `| ${(index === 1 ? row : row.map(cell)).join(' | ')} |`).join('\n');
}
function fence(text: string, language: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map(run => run.length)), marks = '`'.repeat(longest + 1);
  return `${marks}${language}\n${text}\n${marks}`;
}
function quoted(text: string): string { return text.split('\n').map(row => row ? `> ${row}` : '>').join('\n'); }

function listMarkdown(content: Content<'list'>): string {
  const ordered = content.style ? content.style === 'number' : content.ordered, pad = ordered ? '   ' : '  ', counters: number[] = [];
  return content.items.map((item, index) => {
    const level = content.indent?.[index] ?? 0;
    counters.length = level + 1; counters[level] = (counters[level] ?? 0) + 1;
    const marker = content.style === 'todo' ? `- [${content.checked?.[index] ? 'x' : ' '}] ` : ordered ? `${counters[level]}. ` : '- ';
    return `${pad.repeat(level)}${marker}${escapeLineStarts(escapeInline(line(item)))}`;
  }).join('\n');
}
function outlineMarkdown(items: OutlineItem[], depth = 0): string[] {
  return items.flatMap(item => [`${'  '.repeat(depth)}- ${escapeLineStarts(escapeInline(line(item.title)))}`, ...outlineMarkdown(item.children, depth + 1)]);
}

/**
 * Markdown for reading and exchange. Charts become data tables, callouts GitHub alerts (`> [!NOTE]`), citations footnotes.
 * Not representable and therefore dropped: underline, highlight, image/embed sizing and the open state of toggles.
 * Dividers are `---` and page breaks `***`, which `fromMarkdown` reads back.
 */
export function toMarkdown(document: ResearchDocument, options: MarkdownOptions = {}): string {
  const model = tree(document), chartRows = options.chartRows ?? 100, parts: string[] = [];
  if (options.title !== false && document.title) parts.push(`# ${escapeInline(line(document.title))}`);
  const render = (block: Block, depth: number): void => {
    const content = block.content;
    switch (content.type) {
      case 'section': parts.push(`${'#'.repeat(Math.min(6, 2 + depth))} ${escapeInline(line(content.title))}`); break;
      case 'toggle': parts.push(`**${escapeInline(line(content.title))}**`); break;
      case 'heading': parts.push(`${'#'.repeat(Math.min(6, content.level + depth))} ${escapeInline(line(content.text))}`); break;
      case 'paragraph': { const text = escapeLineStarts(runsToMarkdown(content.runs)); if (text.trim()) parts.push(text); break; }
      case 'list': parts.push(listMarkdown(content)); break;
      case 'table': {
        parts.push(mdTable(content.columns, content.rows, content.align));
        if (content.caption) parts.push(`*${escapeInline(line(content.caption))}*`); break;
      }
      case 'chart': {
        const spec = content.spec, table = chartTable(spec, chartRows);
        parts.push(`**${escapeInline(line(spec.title))}** (${chartDescriptor(spec)})`, mdTable(table.head, table.rows));
        if (table.omitted) parts.push(`*… ${table.omitted} more rows omitted*`);
        for (const extra of [annotationLine(spec), spec.caption, sourceLine(spec)]) if (extra) parts.push(escapeLineStarts(escapeInline(line(extra)))); break;
      }
      case 'embed': parts.push(`[${escapeInline(line(content.title))}](${content.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`); break;
      case 'timestamp': parts.push(escapeLineStarts(`${escapeInline(line(content.label))}: ${content.at}`)); break;
      case 'quote': {
        const body = escapeLineStarts(runsToMarkdown(content.runs));
        parts.push(quoted(content.attribution ? `${body}\n\n— ${escapeInline(line(content.attribution))}` : body)); break;
      }
      case 'callout': {
        const body = escapeLineStarts(runsToMarkdown(content.runs));
        parts.push(quoted(`[!${ALERTS[content.tone]}]\n${content.title ? `**${escapeInline(line(content.title))}**\n` : ''}${body}`)); break;
      }
      case 'code': parts.push(fence(content.text, content.language)); break;
      case 'divider': parts.push('---'); break;
      case 'pageBreak': parts.push('***'); break;
      case 'image': {
        parts.push(`![${escapeInline(line(content.alt))}](${content.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`);
        if (content.caption) parts.push(`*${escapeInline(line(content.caption))}*`); break;
      }
      case 'metrics': {
        const change = content.items.some(item => item.change !== undefined), hint = content.items.some(item => item.hint);
        parts.push(mdTable(['Metric', 'Value', ...(change ? ['Change'] : []), ...(hint ? ['Note'] : [])], content.items.map(item => [item.label, item.value, ...(change ? [item.change === undefined ? '' : percent(item.change)] : []), ...(hint ? [item.hint ?? ''] : [])]))); break;
      }
      case 'toc': { const outline = outlineMarkdown(getOutline(document)); if (outline.length) parts.push(outline.join('\n')); break; }
    }
    const sources = blockSources(block);
    if (sources.length) parts.push(`Sources: ${sources.map(id => `[^${id}]`).join(' ')}`);
    for (const child of model.children.get(block.id) ?? []) render(child, content.type === 'section' ? depth + 1 : depth);
  };
  for (const block of model.children.get(null) ?? []) render(block, 0);
  if (document.citations.length) parts.push(document.citations.map(citation => `[^${citation.id}]: [${escapeInline(line(citation.title))}](${citation.url.replace(/\(/g, '%28').replace(/\)/g, '%29')}), accessed ${citation.accessedAt.slice(0, 10)}${citation.publishedAt ? `, published ${citation.publishedAt.slice(0, 10)}` : ''}`).join('\n'));
  return `${parts.join('\n\n')}\n`;
}

// ---- fromMarkdown --------------------------------------------------------------------------------------------------

export type FromMarkdownOptions = {
  /** Block IDs are `<idPrefix>-1`, `<idPrefix>-2`, ... in document order. Use `createBlockId`/`reservedIds` first if the prefix may collide. */
  idPrefix: string;
  /** Container (section or toggle) that receives every block. Default: the top level. */
  parentId?: string | null;
  /** Read `[^id]` as an inline citation marker (the citation must exist when you apply the blocks). Default true; false keeps the text. */
  citationMarkers?: boolean;
};
const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_RULE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const IMAGE = /^!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)\s*$/;
const FOOTNOTE_DEFINITION = /^\[\^[^\]]+\]:\s/;

function splitRow(row: string): string[] {
  const cells: string[] = []; let current = '';
  for (let index = 0; index < row.length; index++) {
    if (row[index] === '\\' && row[index + 1] === '|') { current += '|'; index++; } else if (row[index] === '|') { cells.push(current); current = ''; } else current += row[index];
  }
  cells.push(current);
  if (cells[0]?.trim() === '') cells.shift();
  if (cells.length && cells[cells.length - 1]!.trim() === '') cells.pop();
  return cells.map(cell => cell.trim());
}
/** Whether a line starts a new block and so ends the paragraph or list item before it. Only `1.` can interrupt a paragraph as an ordered item. */
function startsBlock(text: string, next: string | undefined): boolean {
  return FENCE.test(text) || /^ {0,3}#{1,6}(\s|$)/.test(text) || /^ {0,3}>/.test(text) || BREAK.test(text) || /^ {0,3}(?:[-*+]|1[.)])\s/.test(text) || IMAGE.test(text.trim()) || (text.includes('|') && next !== undefined && TABLE_RULE.test(next) && next.includes('|'));
}

/**
 * Block-level markdown to `BlockInput[]` (ATX headings, paragraphs, bullet/numbered/task lists with nesting, GFM tables, fenced code,
 * block quotes and GitHub alerts, `---` dividers, `***` page breaks, `[TOC]`, https image lines). Headings deeper than level 3 become level 3.
 * Setext headings and raw HTML are not interpreted. List items and table cells are plain strings, so their inline formatting is flattened.
 */
export function fromMarkdown(markdown: string, options: FromMarkdownOptions): BlockInput[] {
  if (typeof options?.idPrefix !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(options.idPrefix)) throw new TypeError('fromMarkdown requires an idPrefix that starts with a letter or digit and uses only letters, digits, ".", "_", ":" or "-" (at most 100 characters).');
  const parentId = options.parentId ?? null, lines = markdown.replace(/\r\n?/g, '\n').split('\n'), result: BlockInput[] = [];
  const emit = (content: BlockContent): void => { result.push({ id: `${options.idPrefix}-${result.length + 1}`, parentId, content, citationIds: [] }); };
  const inline = (text: string) => {
    const parsed = parseRuns(text);
    return options.citationMarkers === false ? normalizeRuns(parsed.map(run => run.citationId !== undefined && run.text === '' ? { text: `[^${run.citationId}]` } : run)) : parsed;
  };
  let index = 0;
  while (index < lines.length) {
    const text = lines[index]!;
    if (!text.trim()) { index++; continue; }
    const fenced = FENCE.exec(text);
    if (fenced) {
      const marker = fenced[1]!, body: string[] = []; index++;
      while (index < lines.length && !new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`).test(lines[index]!)) body.push(lines[index++]!);
      index++; emit({ type: 'code', language: /^[A-Za-z0-9+#._-]*$/.test(fenced[2]!) ? fenced[2]!.slice(0, 40) : '', text: body.join('\n') }); continue;
    }
    const heading = HEADING.exec(text);
    if (heading) { emit({ type: 'heading', level: Math.min(3, heading[1]!.length) as 1 | 2 | 3, text: inlineToPlain(heading[2] ?? '') }); index++; continue; }
    const rule = BREAK.exec(text);
    if (rule) { emit({ type: rule[1] === '*' ? 'pageBreak' : 'divider' }); index++; continue; }
    if (/^\s*\[\[?toc\]\]?\s*$/i.test(text)) { emit({ type: 'toc' }); index++; continue; }
    const picture = IMAGE.exec(text.trim());
    if (picture && /^ {0,3}!/.test(text)) {
      const url = safeUrl(picture[2], { httpsOnly: true });
      if (url) { emit({ type: 'image', url, alt: picture[1]! }); index++; continue; }
    }
    if (/^ {0,3}>/.test(text)) {
      const inner: string[] = [];
      while (index < lines.length && /^ {0,3}>/.test(lines[index]!)) inner.push(lines[index++]!.replace(/^ {0,3}> ?/, ''));
      const alert = /^\[!([A-Za-z]+)\]\s*$/.exec(inner[0] ?? '');
      const paragraphs = (rows: string[]): string[] => rows.join('\n').split(/\n\s*\n/).map(block => block.split('\n').map(row => row.trim()).join(' ').trim()).filter(Boolean);
      if (alert && TONES[alert[1]!.toUpperCase()]) {
        const title = /^\*\*([^*]+)\*\*\s*$/.exec(inner[1] ?? ''), body = paragraphs(inner.slice(title ? 2 : 1));
        emit({ type: 'callout', tone: TONES[alert[1]!.toUpperCase()]!, ...(title ? { title: title[1]! } : {}), runs: inline(body.join('\n\n')) }); continue;
      }
      const body = paragraphs(inner), last = body[body.length - 1] ?? '', attribution = /^(?:—|--)\s+(.+)$/.exec(last);
      if (attribution) body.pop();
      emit({ type: 'quote', runs: inline(body.join('\n\n')), ...(attribution ? { attribution: inlineToPlain(attribution[1]!) } : {}) }); continue;
    }
    const first = ITEM.exec(text);
    if (first) {
      const items: string[] = [], checked: boolean[] = [], levels: number[] = [], stack: number[] = [];
      const ordered = /\d/.test(first![2]![0]!), todo = /^\[[ xX]\]\s/.test(first![3]!);
      while (index < lines.length) {
        const current = lines[index]!;
        if (!current.trim()) {
          let next = index + 1; while (next < lines.length && !lines[next]!.trim()) next++;
          const upcoming = next < lines.length ? ITEM.exec(lines[next]!) : null;
          if (upcoming && (upcoming[1]!.length > 0 || /\d/.test(upcoming[2]![0]!) === ordered) && !BREAK.test(lines[next]!)) { index = next; continue; }
          break;
        }
        const item = ITEM.exec(current);
        if (item && !BREAK.test(current)) {
          const spaces = item[1]!.length;
          if (spaces === 0 && /\d/.test(item[2]![0]!) !== ordered && items.length) break;
          while (stack.length > 1 && spaces < stack[stack.length - 1]!) stack.pop();
          if (!stack.length || spaces > stack[stack.length - 1]!) stack.push(spaces);
          const box = todo ? /^\[([ xX])\]\s+(.*)$/.exec(item[3]!) : null;
          levels.push(Math.min(3, stack.length - 1)); checked.push(box ? box[1]!.toLowerCase() === 'x' : false);
          items.push(inlineToPlain(box ? box[2]! : item[3]!)); index++; continue;
        }
        // Anything that does not start a new block continues the previous item (indented or lazy).
        if (items.length && !startsBlock(current, lines[index + 1])) { items[items.length - 1] += ` ${inlineToPlain(current.trim())}`; index++; continue; }
        break;
      }
      emit({ type: 'list', ordered: todo ? false : ordered, items, ...(todo ? { style: 'todo' as const, checked } : {}), ...(levels.some(level => level > 0) ? { indent: levels } : {}) }); continue;
    }
    if (text.includes('|') && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1]!) && lines[index + 1]!.includes('|')) {
      const columns = splitRow(text).map(inlineToPlain), alignment = splitRow(lines[index + 1]!).map(cell => /^:-+:$/.test(cell) ? 'center' as const : /-:$/.test(cell) ? 'right' as const : /^:-/.test(cell) ? 'left' as const : undefined);
      const rows: string[][] = []; index += 2;
      while (index < lines.length && lines[index]!.trim() && lines[index]!.includes('|')) {
        const cells = splitRow(lines[index++]!).map(inlineToPlain);
        rows.push(columns.map((_, column) => cells[column] ?? ''));
      }
      emit({ type: 'table', columns, rows, ...(alignment.some(Boolean) ? { align: columns.map((_, column) => alignment[column] ?? 'left') } : {}) }); continue;
    }
    const body: string[] = [];
    while (index < lines.length && lines[index]!.trim() && (body.length === 0 || !startsBlock(lines[index]!, lines[index + 1]))) body.push(lines[index++]!);
    const joined = body.map((row, position) => {
      const last = position === body.length - 1, trimmed = row.replace(/^\s+/, '');
      return !last && /( {2,}|\\)$/.test(row) ? `${trimmed.replace(/( {2,}|\\)$/, '')}\n` : last ? trimmed.trimEnd() : `${trimmed.trimEnd()} `;
    }).join('');
    if (FOOTNOTE_DEFINITION.test(body[0]!)) emit({ type: 'paragraph', runs: plainRuns(joined) }); else if (joined.trim()) emit({ type: 'paragraph', runs: inline(joined) });
  }
  return result;
}

// ---- toHTML --------------------------------------------------------------------------------------------------------

export type HtmlOptions = {
  /** Start with `<h1>` for the document title. Default true. */
  title?: boolean;
  /** Return a full HTML document with a small inline stylesheet. Default false: an `<article>` fragment. */
  standalone?: boolean;
  /** Rows of chart data shown per chart. Default 100. */
  chartRows?: number;
};
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const STYLE = 'body{font:16px/1.6 system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;color:#1f2328}table{border-collapse:collapse;margin:1rem 0}th,td{border:1px solid #d0d7de;padding:.3rem .6rem}blockquote{margin:1rem 0;padding-left:1rem;border-left:4px solid #d0d7de;color:#57606a}pre{background:#f6f8fa;padding:1rem;overflow:auto}aside.callout{border-left:4px solid #0969da;background:#f6f8fa;padding:.5rem 1rem;margin:1rem 0}img{max-width:100%}.page-break{break-after:page}.sources{font-size:.9em}figure{margin:1rem 0}';

/** Static, escaped HTML: no scripts, no inline event handlers, no iframes (embeds become links). Links and images are re-checked with `safeUrl`. */
export function toHTML(document: ResearchDocument, options: HtmlOptions = {}): string {
  const model = tree(document), chartRows = options.chartRows ?? 100;
  const link = (url: string, label: string): string => { const safe = safeUrl(url); return safe ? `<a href="${escapeHtml(safe)}" rel="noopener noreferrer">${label}</a>` : label; };
  const marker = (id: string): string => `<sup class="citation"><a href="#cite-${escapeHtml(id)}">[${model.numbers.get(id) ?? escapeHtml(id)}]</a></sup>`;
  const text = (value: string): string => escapeHtml(value).replace(/\r?\n/g, '<br>');
  const runsHtml = (runs: readonly InlineRun[]): string => runs.map(run => {
    let html = text(run.text);
    if (run.code) html = `<code>${html}</code>`;
    if (run.italic) html = `<em>${html}</em>`;
    if (run.bold) html = `<strong>${html}</strong>`;
    if (run.strike) html = `<s>${html}</s>`;
    if (run.underline) html = `<u>${html}</u>`;
    if (run.highlight) html = `<mark data-highlight="${run.highlight}">${html}</mark>`;
    if (run.href) html = link(run.href, html);
    return html + (run.citationId === undefined ? '' : marker(run.citationId));
  }).join('');
  const table = (head: string[], rows: string[][], extra: { caption?: string; align?: readonly string[]; headerColumn?: boolean; omitted?: number } = {}): string => {
    const style = (column: number): string => extra.align?.[column] && extra.align[column] !== 'left' ? ` style="text-align:${extra.align[column]}"` : '';
    return `<table>${extra.caption ? `<caption>${text(extra.caption)}</caption>` : ''}<thead><tr>${head.map((cell, column) => `<th scope="col"${style(column)}>${text(cell)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map((cell, column) => column === 0 && extra.headerColumn ? `<th scope="row"${style(column)}>${text(cell)}</th>` : `<td${style(column)}>${text(cell)}</td>`).join('')}</tr>`).join('')}${extra.omitted ? `<tr><td colspan="${head.length}">… ${extra.omitted} more rows omitted</td></tr>` : ''}</tbody></table>`;
  };
  const list = (content: Content<'list'>): string => {
    const tag = (content.style ? content.style === 'number' : content.ordered) ? 'ol' : 'ul', todo = content.style === 'todo';
    let html = `<${tag}${todo ? ' class="todo-list"' : ''}>`, previous = 0;
    content.items.forEach((item, index) => {
      const level = content.indent?.[index] ?? 0;
      if (index > 0) html += level > previous ? `<${tag}>`.repeat(level - previous) : `</li>${`</${tag}></li>`.repeat(previous - level)}`;
      html += `<li>${todo ? `<input type="checkbox" disabled${content.checked?.[index] ? ' checked' : ''}> ` : ''}${text(item)}`; previous = level;
    });
    return `${html}</li>${`</${tag}></li>`.repeat(previous)}</${tag}>`;
  };
  const outline = (items: OutlineItem[]): string => items.length ? `<ol>${items.map(item => `<li><a href="#${escapeHtml(item.id)}">${text(item.title)}</a>${outline(item.children)}</li>`).join('')}</ol>` : '';
  const render = (block: Block): string => {
    const content = block.content, id = ` id="${escapeHtml(block.id)}"`, kids = (model.children.get(block.id) ?? []).map(render).join('');
    let html: string;
    switch (content.type) {
      case 'section': html = `<section${id}><h2>${text(content.title)}</h2>${kids}</section>`; break;
      case 'toggle': html = `<details${id}${content.open ? ' open' : ''}><summary>${text(content.title)}</summary>${kids}</details>`; break;
      case 'heading': html = `<h${content.level}${id}>${text(content.text)}</h${content.level}>`; break;
      case 'paragraph': html = `<p${id}>${runsHtml(content.runs)}</p>`; break;
      case 'list': html = list(content).replace(/^<(ol|ul)/, `<$1${id}`); break;
      case 'table': html = table(content.columns, content.rows, { ...(content.caption ? { caption: content.caption } : {}), ...(content.align ? { align: content.align } : {}), ...(content.headerColumn ? { headerColumn: true } : {}) }).replace(/^<table/, `<table${id}`); break;
      case 'chart': {
        const spec = content.spec, data = chartTable(spec, chartRows);
        html = `<figure${id} class="chart" data-kind="${escapeHtml(spec.kind)}"><figcaption>${text(spec.title)} <small>(${text(chartDescriptor(spec))})</small></figcaption>${table(data.head, data.rows, { omitted: data.omitted })}${[annotationLine(spec), spec.caption, sourceLine(spec)].filter(Boolean).map(extra => `<p class="chart-note">${text(extra!)}</p>`).join('')}</figure>`; break;
      }
      case 'embed': html = `<p${id} class="embed">${link(content.url, text(content.title))}</p>`; break;
      case 'timestamp': html = `<p${id}><time datetime="${escapeHtml(content.at)}">${text(content.label)}: ${escapeHtml(content.at)}</time></p>`; break;
      case 'quote': html = `<blockquote${id}>${runsHtml(content.runs)}${content.attribution ? `<footer>— ${text(content.attribution)}</footer>` : ''}</blockquote>`; break;
      case 'callout': html = `<aside${id} class="callout" data-tone="${content.tone}" role="note">${content.title ? `<strong>${text(content.title)}</strong>` : ''}<p>${runsHtml(content.runs)}</p></aside>`; break;
      case 'code': html = `<pre${id}><code${content.language ? ` class="language-${escapeHtml(content.language)}"` : ''}>${escapeHtml(content.text)}</code></pre>`; break;
      case 'divider': html = `<hr${id}>`; break;
      case 'pageBreak': html = `<hr${id} class="page-break">`; break;
      case 'image': {
        const safe = safeUrl(content.url, { httpsOnly: true });
        html = `<figure${id} class="image width-${content.width ?? 'normal'}">${safe ? `<img src="${escapeHtml(safe)}" alt="${escapeHtml(content.alt)}" loading="lazy" referrerpolicy="no-referrer">` : text(content.alt)}${content.caption ? `<figcaption>${text(content.caption)}</figcaption>` : ''}</figure>`; break;
      }
      case 'metrics': html = `<dl${id} class="metrics">${content.items.map(item => `<div class="metric"${item.tone ? ` data-tone="${item.tone}"` : ''}><dt>${text(item.label)}</dt><dd>${text(item.value)}${item.change === undefined ? '' : ` <span class="change">${escapeHtml(percent(item.change))}</span>`}</dd>${item.hint ? `<dd class="hint">${text(item.hint)}</dd>` : ''}</div>`).join('')}</dl>`; break;
      case 'toc': html = `<nav${id} class="toc" aria-label="Table of contents">${outline(getOutline(document))}</nav>`; break;
    }
    const sources = blockSources(block);
    return html + (sources.length ? `<small class="block-sources">Sources: ${sources.map(marker).join(' ')}</small>` : '');
  };
  const body = (model.children.get(null) ?? []).map(render).join('\n');
  const sources = document.citations.length ? `\n<section class="sources" aria-label="Sources"><h2>Sources</h2><ol>${document.citations.map(citation => `<li id="cite-${escapeHtml(citation.id)}">${link(citation.url, text(citation.title))} <small>Accessed <time datetime="${escapeHtml(citation.accessedAt)}">${escapeHtml(citation.accessedAt.slice(0, 10))}</time>${citation.publishedAt ? ` · Published <time datetime="${escapeHtml(citation.publishedAt)}">${escapeHtml(citation.publishedAt.slice(0, 10))}</time>` : ''}</small></li>`).join('')}</ol></section>` : '';
  const article = `<article class="se-document" data-document-id="${escapeHtml(document.id)}">${options.title === false ? '' : `\n<h1>${text(document.title)}</h1>`}\n${body}${sources}\n</article>`;
  return options.standalone ? `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(document.title)}</title><style>${STYLE}</style></head><body>\n${article}\n</body></html>\n` : `${article}\n`;
}

// ---- toPlainText ---------------------------------------------------------------------------------------------------

export type PlainTextOptions = { title?: boolean; chartRows?: number };
/** Readable text without markup: lists keep their markers, tables become tab-separated rows, charts a short data listing. */
export function toPlainText(document: ResearchDocument, options: PlainTextOptions = {}): string {
  const model = tree(document), chartRows = options.chartRows ?? 20, parts: string[] = [];
  const withMarkers = (runs: readonly InlineRun[]): string => runs.map(run => run.text + (run.citationId === undefined ? '' : `[${model.numbers.get(run.citationId) ?? run.citationId}]`)).join('');
  const render = (block: Block): void => {
    const content = block.content, before = parts.length;
    switch (content.type) {
      case 'section': parts.push(content.title); break;
      case 'toggle': parts.push(content.title); break;
      case 'heading': parts.push(content.text); break;
      case 'paragraph': parts.push(withMarkers(content.runs)); break;
      case 'list': {
        const ordered = content.style ? content.style === 'number' : content.ordered, counters: number[] = [];
        parts.push(content.items.map((item, index) => {
          const level = content.indent?.[index] ?? 0; counters.length = level + 1; counters[level] = (counters[level] ?? 0) + 1;
          return `${'  '.repeat(level)}${content.style === 'todo' ? `[${content.checked?.[index] ? 'x' : ' '}]` : ordered ? `${counters[level]}.` : '-'} ${item}`;
        }).join('\n')); break;
      }
      case 'table': parts.push([...(content.caption ? [content.caption] : []), content.columns.join('\t'), ...content.rows.map(row => row.join('\t'))].join('\n')); break;
      case 'chart': {
        const spec = content.spec, data = chartTable(spec, chartRows);
        parts.push([`${spec.title} (${chartDescriptor(spec)})`, data.head.join('\t'), ...data.rows.map(row => row.join('\t')), ...(data.omitted ? [`… ${data.omitted} more rows`] : []), ...[annotationLine(spec), spec.caption, sourceLine(spec)].filter((entry): entry is string => Boolean(entry))].join('\n')); break;
      }
      case 'embed': parts.push(`${content.title} (${content.url})`); break;
      case 'timestamp': parts.push(`${content.label}: ${content.at}`); break;
      case 'quote': parts.push(`“${withMarkers(content.runs)}”${content.attribution ? ` — ${content.attribution}` : ''}`); break;
      case 'callout': parts.push(`${capitalize(content.tone)}${content.title ? `: ${content.title}` : ''}\n${withMarkers(content.runs)}`); break;
      case 'code': parts.push(content.text); break;
      case 'divider': case 'pageBreak': parts.push('----'); break;
      case 'image': parts.push(`[Image: ${content.alt || content.url}]${content.caption ? ` ${content.caption}` : ''}`); break;
      case 'metrics': parts.push(content.items.map(item => `${item.label}: ${item.value}${item.change === undefined ? '' : ` (${percent(item.change)})`}${item.hint ? ` — ${item.hint}` : ''}`).join('\n')); break;
      case 'toc': { const walk = (items: OutlineItem[], depth: number): string[] => items.flatMap(item => [`${'  '.repeat(depth)}${item.title}`, ...walk(item.children, depth + 1)]); const outline = walk(getOutline(document), 0); if (outline.length) parts.push(outline.join('\n')); break; }
    }
    const extra = blockSources(block);
    if (extra.length && parts.length > before) parts[parts.length - 1] += ` ${extra.map(id => `[${model.numbers.get(id) ?? id}]`).join('')}`;
    for (const child of model.children.get(block.id) ?? []) render(child);
  };
  if (options.title !== false && document.title) parts.push(document.title);
  for (const block of model.children.get(null) ?? []) render(block);
  if (document.citations.length) parts.push(['Sources', ...document.citations.map((citation, index) => `[${index + 1}] ${citation.title} — ${citation.url} (accessed ${citation.accessedAt.slice(0, 10)})`)].join('\n'));
  return `${parts.filter(part => part !== '').join('\n\n')}\n`;
}

