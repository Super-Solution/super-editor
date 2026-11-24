// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import {
  chartFallback, chartRowsWarning, checkDocument, getOutline, lossWarnings, withHints,
  type Block, type CalloutTone, type EditorIssue, type ExportResult, type Exporter, type FidelityTable, type FormatWarning, type InlineRun, type OutlineItem, type ResearchDocument,
} from '@supersolutions/super-editor-core';
import { RELATIONSHIP_TYPES, ZipError, createPackage, escapeXmlAttribute, escapeXmlText, xmlText } from '@supersolutions/super-editor-opc';
import { DEFAULT_FONTS, DEFAULT_LABELS, DEFAULT_MARGIN_MM, optionIssues, type DocxLabels, type DocxOptions, type HeaderFooter } from './options.js';
import { CONTENT_TYPES, RELATIONSHIPS, R, STYLE, W, XML_HEADER, corePropertiesXml, extendedPropertiesXml, heading, numberingXml, settingsXml, stylesXml } from './parts.js';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** What a regenerated Word file does not carry. Tracked changes and comments are not in the editor's document model, so they are not listed here; see the package README. */
export const DOCX_FIDELITY: FidelityTable = {
  toggle: { level: 'degraded', note: 'A toggle becomes a bold title with its content below it; Word has no collapsible block, and whether it was open is lost.' },
  'todo-list': { level: 'degraded', note: 'Checkboxes become the characters ☐ and ☑, not clickable Word checkboxes.' },
  chart: { level: 'degraded', note: 'A chart becomes its title and data table; no picture is drawn. If the picture matters, paste it into Word or send the chart as an image.' },
  card: { level: 'degraded', note: 'A card becomes its title and alt text; the card itself is not in the file.' },
  embed: { level: 'degraded', note: 'An embed becomes a link.' },
  image: { level: 'degraded', note: 'An image becomes "[Image: alt text]" and a link to its address. Images are not downloaded or embedded.' },
  metrics: { level: 'degraded', note: 'Metrics become a table.' },
  timestamp: { level: 'degraded', note: 'A timestamp becomes the text "label: time".' },
  toc: { level: 'degraded', note: 'A table of contents becomes a fixed list of links to the headings, without page numbers; it does not update when headings change.' },
};

type Dimensions = { width: number; height: number; landscape: boolean; top: number; right: number; bottom: number; left: number };
const PAPER = { A4: { width: 11906, height: 16838 }, letter: { width: 12240, height: 15840 } } as const;
const twips = (mm: number): number => Math.round(mm * 56.6929);
const TONES: Record<CalloutTone, { color: string; fill: string }> = {
  info: { color: '0969DA', fill: 'EAF3FE' }, success: { color: '1A7F37', fill: 'E6F6EA' }, warning: { color: '9A6700', fill: 'FFF6D6' }, danger: { color: 'CF222E', fill: 'FFE9EA' }, note: { color: '8250DF', fill: 'F1EAFD' },
};
const HIGHLIGHTS = { yellow: 'FFF3A3', green: 'CDEFD6', blue: 'CDE7FF', pink: 'FFD6EB', gray: 'DDE1E6' } as const;
const percent = (value: number): string => `${value > 0 ? '+' : ''}${value}%`;

type RunProps = { style?: string; bold?: boolean; italic?: boolean | 'off'; strike?: boolean; underline?: boolean; code?: boolean; fill?: string; superscript?: boolean; color?: string; size?: number };
type ParagraphProps = { style?: string; keepNext?: boolean; num?: { id: number; level: number }; border?: { side: 'left' | 'bottom'; color: string; size: number; space: number }; fill?: string; spacing?: { before?: number; after?: number }; ind?: { left?: number; hanging?: number }; jc?: 'left' | 'center' | 'right' };
type Context = {
  document: ResearchDocument; labels: DocxLabels; monoFont: string; textWidth: number; chartRows: number; replaced: number;
  children: Map<string | null, Block[]>; numbers: Map<string, number>; headingNames: Map<string, string>; bookmarkSeq: number;
  addLink: (url: string) => string; orderedLists: number;
};

// ---- XML pieces ----------------------------------------------------------------------------------------------------

const text = (ctx: Context, value: string): string => { const safe = xmlText(value); ctx.replaced += safe.replaced; return escapeXmlText(safe.text); };
function runProperties(ctx: Context, props: RunProps): string {
  const mono = props.code ? (() => { const name = escapeXmlAttribute(xmlText(ctx.monoFont).text); return `<w:rFonts w:ascii="${name}" w:hAnsi="${name}" w:cs="${name}"/>`; })() : '';
  const size = props.size === undefined ? '' : `<w:sz w:val="${props.size}"/><w:szCs w:val="${props.size}"/>`;
  const xml = `${props.style ? `<w:rStyle w:val="${props.style}"/>` : ''}${mono}${props.bold ? '<w:b/><w:bCs/>' : ''}${props.italic === true ? '<w:i/><w:iCs/>' : props.italic === 'off' ? '<w:i w:val="0"/><w:iCs w:val="0"/>' : ''}${props.strike ? '<w:strike/>' : ''}${props.color ? `<w:color w:val="${props.color}"/>` : ''}${size}${props.underline ? '<w:u w:val="single"/>' : ''}${props.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${props.fill}"/>` : ''}${props.superscript ? '<w:vertAlign w:val="superscript"/>' : ''}`;
  return xml ? `<w:rPr>${xml}</w:rPr>` : '';
}
/** Text as runs: a newline is a line break and a tab is a tab, as in Word; everything else is written as given (spaces are kept). */
function textRuns(ctx: Context, value: string, props: RunProps = {}): string {
  const properties = runProperties(ctx, props);
  return value.replace(/\r\n?/g, '\n').split(/(\n|\t)/).map(part => part === '' ? '' : part === '\n' ? `<w:r>${properties}<w:br/></w:r>` : part === '\t' ? `<w:r>${properties}<w:tab/></w:r>` : `<w:r>${properties}<w:t xml:space="preserve">${text(ctx, part)}</w:t></w:r>`).join('');
}
const link = (ctx: Context, url: string, inner: string): string => `<w:hyperlink r:id="${ctx.addLink(url)}" w:history="1">${inner}</w:hyperlink>`;
const marker = (ctx: Context, citationId: string): string => {
  const number = ctx.numbers.get(citationId);
  return `<w:hyperlink w:anchor="se_cite_${number}" w:history="1">${textRuns(ctx, `[${number}]`, { superscript: true })}</w:hyperlink>`;
};
function inline(ctx: Context, runs: readonly InlineRun[], base: RunProps = {}): string {
  return runs.map(run => {
    const props: RunProps = { ...base, ...(run.bold ? { bold: true } : {}), ...(run.italic ? { italic: true } : {}), ...(run.strike ? { strike: true } : {}), ...(run.underline ? { underline: true } : {}), ...(run.code ? { code: true } : {}), ...(run.highlight ? { fill: HIGHLIGHTS[run.highlight] } : {}), ...(run.href ? { style: STYLE.link } : {}) };
    const body = textRuns(ctx, run.text, props);
    return (run.href && body ? link(ctx, run.href, body) : body) + (run.citationId === undefined ? '' : marker(ctx, run.citationId));
  }).join('');
}
function paragraph(props: ParagraphProps, content = ''): string {
  const border = props.border ? `<w:pBdr><w:${props.border.side} w:val="single" w:sz="${props.border.size}" w:space="${props.border.space}" w:color="${props.border.color}"/></w:pBdr>` : '';
  const spacing = props.spacing ? `<w:spacing${props.spacing.before === undefined ? '' : ` w:before="${props.spacing.before}"`}${props.spacing.after === undefined ? '' : ` w:after="${props.spacing.after}"`}/>` : '';
  const ind = props.ind ? `<w:ind${props.ind.left === undefined ? '' : ` w:left="${props.ind.left}"`}${props.ind.hanging === undefined ? '' : ` w:hanging="${props.ind.hanging}"`}/>` : '';
  const xml = `${props.style ? `<w:pStyle w:val="${props.style}"/>` : ''}${props.keepNext ? '<w:keepNext/>' : ''}${props.num ? `<w:numPr><w:ilvl w:val="${props.num.level}"/><w:numId w:val="${props.num.id}"/></w:numPr>` : ''}${border}${props.fill ? `<w:shd w:val="clear" w:color="auto" w:fill="${props.fill}"/>` : ''}${spacing}${ind}${props.jc ? `<w:jc w:val="${props.jc}"/>` : ''}`;
  return `<w:p>${xml ? `<w:pPr>${xml}</w:pPr>` : ''}${content}</w:p>`;
}
/** An empty line that keeps two tables from merging into one, which Word does when nothing separates them. */
const separator = (): string => paragraph({ spacing: { after: 0 } });
function bookmarked(ctx: Context, name: string | undefined, content: string): string {
  if (!name) return content;
  const id = ++ctx.bookmarkSeq;
  return `<w:bookmarkStart w:id="${id}" w:name="${name}"/>${content}<w:bookmarkEnd w:id="${id}"/>`;
}

function table(ctx: Context, head: readonly string[], rows: readonly (readonly string[])[], options: { align?: readonly string[]; headerColumn?: boolean } = {}): string {
  const columns = Math.max(1, head.length), width = Math.floor(ctx.textWidth / columns);
  const cell = (value: string, column: number, header: boolean): string => {
    const align = options.align?.[column], bold = header || (options.headerColumn === true && column === 0);
    return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/>' : ''}</w:tcPr>${paragraph({ style: STYLE.tableText, ...(align && align !== 'left' ? { jc: align as 'center' | 'right' } : {}) }, textRuns(ctx, value, bold ? { bold: true } : {}))}</w:tc>`;
  };
  const row = (cells: readonly string[], header: boolean): string => `<w:tr><w:trPr><w:cantSplit/>${header ? '<w:tblHeader/>' : ''}</w:trPr>${head.map((_, column) => cell(cells[column] ?? '', column, header)).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblStyle w:val="${STYLE.tableGrid}"/><w:tblW w:w="${width * columns}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${head.map(() => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>${row(head, true)}${rows.map(cells => row(cells, false)).join('')}</w:tbl>`;
}

// ---- blocks --------------------------------------------------------------------------------------------------------

const ownSources = (block: Block): string[] => {
  const inlineIds = new Set<string>();
  const content = block.content;
  if (content.type === 'paragraph' || content.type === 'quote' || content.type === 'callout') for (const run of content.runs) if (run.citationId !== undefined) inlineIds.add(run.citationId);
  return block.citationIds.filter(id => !inlineIds.has(id));
};

function renderBlock(ctx: Context, block: Block, depth: number): string {
  const content = block.content, parts: string[] = [];
  const sectionName = ctx.headingNames.get(block.id);
  switch (content.type) {
    case 'section': parts.push(paragraph({ style: heading(Math.min(6, 1 + depth)) }, bookmarked(ctx, sectionName, textRuns(ctx, content.title)))); break;
    case 'heading': parts.push(paragraph({ style: heading(Math.min(6, content.level + depth)) }, bookmarked(ctx, sectionName, textRuns(ctx, content.text)))); break;
    case 'toggle': parts.push(paragraph({ keepNext: true, spacing: { before: 120 } }, textRuns(ctx, content.title, { bold: true }))); break;
    case 'paragraph': parts.push(paragraph({}, inline(ctx, content.runs))); break;
    case 'list': {
      const ordered = content.style ? content.style === 'number' : content.ordered, todo = content.style === 'todo', numId = todo ? 0 : ordered ? ctx.orderedLists++ + 2 : 1;
      content.items.forEach((item, index) => {
        const level = content.indent?.[index] ?? 0;
        parts.push(todo
          ? paragraph({ style: STYLE.list, ind: { left: 720 + 360 * level, hanging: 360 } }, `${textRuns(ctx, content.checked?.[index] ? '☑' : '☐')}<w:r><w:tab/></w:r>${textRuns(ctx, item)}`)
          : paragraph({ style: STYLE.list, num: { id: numId, level } }, textRuns(ctx, item)));
      });
      break;
    }
    case 'table': {
      parts.push(table(ctx, content.columns, content.rows, { ...(content.align ? { align: content.align } : {}), ...(content.headerColumn ? { headerColumn: true } : {}) }));
      parts.push(content.caption ? paragraph({ style: STYLE.caption }, textRuns(ctx, content.caption)) : separator());
      break;
    }
    case 'chart': {
      const data = chartFallback(content.spec, ctx.chartRows);
      parts.push(paragraph({ keepNext: true, spacing: { before: 120, after: 60 } }, textRuns(ctx, data.title, { bold: true }) + textRuns(ctx, ` (${data.descriptor})`)));
      parts.push(table(ctx, data.head, data.rows));
      const notes = [...(data.omitted ? [ctx.labels.moreRows.replace('{count}', String(data.omitted))] : []), ...data.notes];
      if (notes.length) for (const note of notes) parts.push(paragraph({ style: STYLE.caption, spacing: { after: 40 } }, textRuns(ctx, note))); else parts.push(separator());
      break;
    }
    case 'embed': parts.push(paragraph({}, link(ctx, content.url, textRuns(ctx, content.title, { style: STYLE.link })))); break;
    case 'card': {
      if (content.title) parts.push(paragraph({ keepNext: true, spacing: { after: 40 } }, textRuns(ctx, content.title, { bold: true })));
      parts.push(paragraph({}, textRuns(ctx, content.alt)));
      break;
    }
    case 'timestamp': parts.push(paragraph({}, textRuns(ctx, `${content.label}: ${content.at}`))); break;
    case 'quote': {
      parts.push(paragraph({ style: STYLE.quote }, inline(ctx, content.runs)));
      if (content.attribution) parts.push(paragraph({ style: STYLE.quote }, textRuns(ctx, `— ${content.attribution}`, { italic: 'off' })));
      break;
    }
    case 'callout': {
      const tone = TONES[content.tone], frame: ParagraphProps = { border: { side: 'left', color: tone.color, size: 24, space: 8 }, fill: tone.fill, ind: { left: 200 } };
      if (content.title) parts.push(paragraph({ ...frame, keepNext: true, spacing: { after: 0 } }, textRuns(ctx, content.title, { bold: true, color: tone.color })));
      parts.push(paragraph({ ...frame, spacing: { after: 120 } }, inline(ctx, content.runs)));
      break;
    }
    case 'code': for (const line of content.text.replace(/\r\n?/g, '\n').split('\n')) parts.push(paragraph({ style: STYLE.code }, textRuns(ctx, line))); parts.push(paragraph({ spacing: { after: 60 } })); break;
    case 'divider': parts.push(paragraph({ border: { side: 'bottom', color: 'D0D7DE', size: 6, space: 1 }, spacing: { before: 120, after: 120 } })); break;
    case 'pageBreak': parts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>'); break;
    case 'image': {
      const label = `[${ctx.labels.image}: ${content.alt || content.url}] `;
      parts.push(paragraph({}, textRuns(ctx, label, { italic: true }) + link(ctx, content.url, textRuns(ctx, content.url, { style: STYLE.link }))));
      if (content.caption) parts.push(paragraph({ style: STYLE.caption }, textRuns(ctx, content.caption)));
      break;
    }
    case 'metrics': {
      const change = content.items.some(item => item.change !== undefined), hint = content.items.some(item => item.hint);
      const head = [ctx.labels.metric, ctx.labels.value, ...(change ? [ctx.labels.change] : []), ...(hint ? [ctx.labels.note] : [])];
      parts.push(table(ctx, head, content.items.map(item => [item.label, item.value, ...(change ? [item.change === undefined ? '' : percent(item.change)] : []), ...(hint ? [item.hint ?? ''] : [])])));
      parts.push(separator());
      break;
    }
    case 'toc': {
      const entries = (items: OutlineItem[], level: number): string[] => items.flatMap(item => {
        const name = ctx.headingNames.get(item.id);
        const label = textRuns(ctx, item.title, name ? { style: STYLE.link } : {});
        return [paragraph({ spacing: { after: 40 }, ind: { left: 360 * level } }, name ? `<w:hyperlink w:anchor="${name}" w:history="1">${label}</w:hyperlink>` : label), ...entries(item.children, level + 1)];
      });
      parts.push(...entries(getOutline(ctx.document), 0));
      break;
    }
  }
  const sources = ownSources(block);
  if (sources.length) parts.push(paragraph({ style: STYLE.caption, spacing: { after: 120 } }, textRuns(ctx, `${ctx.labels.sources}: `) + sources.map(id => marker(ctx, id)).join(textRuns(ctx, ' '))));
  for (const child of ctx.children.get(block.id) ?? []) parts.push(renderBlock(ctx, child, content.type === 'section' ? depth + 1 : depth));
  return parts.join('');
}

function sourcesSection(ctx: Context): string {
  if (!ctx.document.citations.length) return '';
  const entries = ctx.document.citations.map((citation, index) => {
    const dates = ` — ${ctx.labels.accessed} ${citation.accessedAt.slice(0, 10)}${citation.publishedAt ? `, ${ctx.labels.published} ${citation.publishedAt.slice(0, 10)}` : ''}`;
    return paragraph({ style: STYLE.sources }, bookmarked(ctx, `se_cite_${index + 1}`, textRuns(ctx, `[${index + 1}] `) + link(ctx, citation.url, textRuns(ctx, citation.title, { style: STYLE.link })) + textRuns(ctx, dates)));
  });
  return paragraph({ style: heading(1) }, textRuns(ctx, ctx.labels.sources)) + entries.join('');
}

function headerFooterXml(ctx: Context, tag: 'hdr' | 'ftr', value: HeaderFooter): string {
  const spec = typeof value === 'string' ? { text: value } : value, align = spec.align ?? (tag === 'ftr' ? 'center' : 'left');
  const field = (instruction: string): string => `<w:fldSimple w:instr=" ${instruction} "><w:r><w:t>1</w:t></w:r></w:fldSimple>`;
  const body = spec.text.split(/(\{page\}|\{pages\}|\{title\})/).map(part => part === '{page}' ? field('PAGE') : part === '{pages}' ? field('NUMPAGES') : part === '{title}' ? textRuns(ctx, ctx.document.title) : textRuns(ctx, part)).join('');
  return `${XML_HEADER}<w:${tag} xmlns:w="${W}" xmlns:r="${R}">${paragraph({ style: tag === 'hdr' ? STYLE.header : STYLE.footer, jc: align }, body)}</w:${tag}>`;
}

// ---- export --------------------------------------------------------------------------------------------------------

const refuse = (issues: EditorIssue[]): ExportResult => ({ ok: false, issues: withHints(issues) });
function dimensions(document: ResearchDocument, options: DocxOptions): { ok: true; value: Dimensions } | { ok: false; issues: EditorIssue[] } {
  const requested = options.page?.size, named = requested ?? (document.format.page === 'screen' ? undefined : document.format.page);
  const base = named === undefined ? PAPER.A4 : typeof named === 'string' ? PAPER[named] : { width: twips(named.widthMm), height: twips(named.heightMm) };
  const orientation = options.page?.orientation, margin = (side: 'top' | 'right' | 'bottom' | 'left'): number => twips(options.page?.marginsMm?.[side] ?? DEFAULT_MARGIN_MM);
  const [width, height] = orientation === 'landscape' ? [Math.max(base.width, base.height), Math.min(base.width, base.height)] : orientation === 'portrait' ? [Math.min(base.width, base.height), Math.max(base.width, base.height)] : [base.width, base.height];
  const value: Dimensions = { width, height, landscape: orientation === 'landscape', top: margin('top'), right: margin('right'), bottom: margin('bottom'), left: margin('left') };
  if (width - value.left - value.right < 720 || height - value.top - value.bottom < 720) return { ok: false, issues: [{ code: 'validation', path: 'options.page.marginsMm', message: 'The margins leave less than half an inch of text area.', hint: 'Use smaller margins or a larger page size.' }] };
  return { ok: true, value };
}

/**
 * The document as a .docx (Office Open XML for Word 2013 and later; also opens in LibreOffice and Google Docs). Deterministic: the
 * same document and options give the same bytes. Always resolves; problems are `issues`, losses are `warnings`.
 */
export async function exportDocx(input: ResearchDocument, options?: DocxOptions): Promise<ExportResult> {
  const bad = optionIssues(options);
  if (bad.length) return refuse(bad);
  const checked = checkDocument(input);
  if (!checked.ok) return checked;
  const document = checked.document, opts = options ?? {}, page = dimensions(document, opts);
  if (!page.ok) return refuse(page.issues);
  const labels: DocxLabels = { ...DEFAULT_LABELS, ...opts.labels };
  const fonts = { ...DEFAULT_FONTS, ...opts.fonts }, bodyFont = fonts[document.format.font];
  const children = new Map<string | null, Block[]>();
  for (const block of document.blocks) { const siblings = children.get(block.parentId); if (siblings) siblings.push(block); else children.set(block.parentId, [block]); }
  const headingNames = new Map<string, string>();
  for (const block of document.blocks) if (block.content.type === 'section' || block.content.type === 'heading') headingNames.set(block.id, `se_h${headingNames.size + 1}`);

  // The document part's relationships: styles, numbering and settings, then the header and footer when given, then one per distinct link,
  // in order of first use. The ids are known before the package exists, so the body can name them while it is written.
  const fixed = 3 + (opts.header === undefined ? 0 : 1) + (opts.footer === undefined ? 0 : 1), linkUrls: string[] = [];
  const ctx: Context = {
    document, labels, monoFont: fonts.mono, textWidth: page.value.width - page.value.left - page.value.right, chartRows: opts.chartRows ?? 100, replaced: 0,
    children, numbers: new Map(document.citations.map((citation, index) => [citation.id, index + 1])), headingNames, bookmarkSeq: 0, orderedLists: 0,
    addLink: url => { let index = linkUrls.indexOf(url); if (index < 0) index = linkUrls.push(url) - 1; return `rId${fixed + index + 1}`; },
  };
  const body: string[] = [];
  if (opts.title !== false && document.title) body.push(paragraph({ style: STYLE.title }, textRuns(ctx, document.title)));
  for (const block of children.get(null) ?? []) body.push(renderBlock(ctx, block, 0));
  body.push(sourcesSection(ctx));

  const documentPart = 'word/document.xml', pkg = createPackage();
  const parts: { kind: 'header' | 'footer'; path: string; rel: string }[] = [];
  for (const kind of ['header', 'footer'] as const) {
    const value = opts[kind];
    if (value === undefined) continue;
    const path = `word/${kind}1.xml`;
    pkg.addPart(path, CONTENT_TYPES[kind], headerFooterXml(ctx, kind === 'header' ? 'hdr' : 'ftr', value));
    parts.push({ kind, path, rel: RELATIONSHIPS[kind] });
  }
  const { width, height, landscape, top, right, bottom, left } = page.value;
  const references = parts.map((part, index) => `<w:${part.kind}Reference w:type="default" r:id="rId${4 + index}"/>`).join('');
  const section = `<w:sectPr>${references}<w:pgSz w:w="${width}" w:h="${height}"${landscape ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${top}" w:right="${right}" w:bottom="${bottom}" w:left="${left}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>`;
  pkg.addPart(documentPart, CONTENT_TYPES.document, `${XML_HEADER}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${body.join('')}${section}</w:body></w:document>`);
  pkg.addPart('word/styles.xml', CONTENT_TYPES.styles, stylesXml({ body: bodyFont, mono: fonts.mono, ...(opts.fonts?.eastAsia ? { eastAsia: opts.fonts.eastAsia } : {}) }, { fontSize: document.format.fontSize, lineHeight: document.format.lineHeight, language: opts.language ?? 'en-US', ...(opts.eastAsiaLanguage ? { eastAsiaLanguage: opts.eastAsiaLanguage } : {}) }));
  pkg.addPart('word/numbering.xml', CONTENT_TYPES.numbering, numberingXml(ctx.orderedLists, bodyFont));
  pkg.addPart('word/settings.xml', CONTENT_TYPES.settings, settingsXml());
  pkg.addPart('docProps/core.xml', CONTENT_TYPES.core, corePropertiesXml({ title: document.title, ...(opts.author ? { author: opts.author } : {}), created: document.createdAt, modified: document.updatedAt }));
  pkg.addPart('docProps/app.xml', CONTENT_TYPES.extended, extendedPropertiesXml());
  pkg.addRelationship(null, { type: RELATIONSHIP_TYPES.officeDocument, part: documentPart });
  pkg.addRelationship(null, { type: RELATIONSHIP_TYPES.coreProperties, part: 'docProps/core.xml' });
  pkg.addRelationship(null, { type: RELATIONSHIP_TYPES.extendedProperties, part: 'docProps/app.xml' });
  const ids = [
    pkg.addRelationship(documentPart, { type: RELATIONSHIPS.styles, part: 'word/styles.xml' }), pkg.addRelationship(documentPart, { type: RELATIONSHIPS.numbering, part: 'word/numbering.xml' }), pkg.addRelationship(documentPart, { type: RELATIONSHIPS.settings, part: 'word/settings.xml' }),
    ...parts.map(part => pkg.addRelationship(documentPart, { type: part.rel, part: part.path })),
    ...linkUrls.map(url => pkg.addRelationship(documentPart, { type: RELATIONSHIP_TYPES.hyperlink, url })),
  ];
  if (ids.some((id, index) => id !== `rId${index + 1}`)) throw new Error('Relationship ids drifted from the ones written into the body.');

  let data: Uint8Array;
  try { data = await pkg.toBytes({ modified: document.updatedAt, ...(opts.compress === false ? { compress: false } : {}) }); } catch (error) {
    if (error instanceof ZipError) return refuse([{ code: 'validation', path: 'document', message: `The package could not be written: ${error.message}`, hint: 'Report this: it is a fault in the exporter, the document was not changed.' }]);
    throw error;
  }
  const warnings: FormatWarning[] = lossWarnings(document, DOCX_FIDELITY);
  const cut = chartRowsWarning(document, ctx.chartRows);
  if (cut) warnings.push(cut);
  if (ctx.replaced) warnings.push({ code: 'invalid-xml-characters', count: ctx.replaced, message: `${ctx.replaced} ${ctx.replaced === 1 ? 'character' : 'characters'} cannot be written in a Word file (control characters) and ${ctx.replaced === 1 ? 'was' : 'were'} replaced with U+FFFD.`, hint: 'Remove the control characters from the text at the source; Word files cannot hold them.' });
  return { ok: true, data, mime: DOCX_MIME, ext: 'docx', warnings };
}

export const docxExporter: Exporter<DocxOptions> = {
  id: 'docx', label: 'Word document', mime: DOCX_MIME, ext: 'docx', capabilities: ['tables', 'numbering', 'page-layout'], fidelity: DOCX_FIDELITY,
  export: (document, options) => exportDocx(document, options),
};
