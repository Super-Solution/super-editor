import { getOutline } from '@super-solution/editor-core';
import type { Block, BlockContent, ChartSpec, Citation, InlineRun, OutlineItem, ResearchDocument } from '@super-solution/editor-core';
import { renderChartFigure } from '../charts/dom.js';
import { attributes, element, hostOf, revealBlock, safeLink, srOnly, timeElement } from './dom.js';
import { splitMatches } from './find.js';
import { template, type Labels } from './labels.js';
import { allowedEmbedUrl, embedHeight, imageModel, listModel, metricModels, runSegments, tableModel, TONE_ICONS, type ListItemNode } from './models.js';
import type { RenderContext } from './types.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Appends `text` to `parent`, wrapping matches of the active find query in <mark>. */
function appendText(document: Document, parent: Element | DocumentFragment, text: string, context: RenderContext, blockId?: string): void {
  const find = context.options.find;
  if (!find?.query) { parent.append(document.createTextNode(text)); return; }
  for (const part of splitMatches(text, find.query, find.caseSensitive)) {
    if (!part.match) { parent.append(document.createTextNode(part.text)); continue; }
    const mark = element(document, 'mark', part.text, 'se-find-match');
    if (blockId !== undefined && find.activeBlockId === blockId) mark.dataset.active = 'true';
    parent.append(mark);
  }
}
function textElement<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, text: string, context: RenderContext, block: Block, className?: string): HTMLElementTagNameMap[K] {
  const node = element(document, tag, undefined, className);
  appendText(document, node, text, context, block.id);
  return node;
}

export function citationCard(document: Document, citation: Citation, labels: Labels, id: string): HTMLElement {
  const card = element(document, 'span', undefined, 'se-citation-card');
  card.id = id; card.setAttribute('role', 'tooltip');
  card.append(element(document, 'strong', citation.title, 'se-citation-card-title'));
  const host = hostOf(citation.url);
  if (host) card.append(element(document, 'span', host, 'se-citation-card-host'));
  const dates = element(document, 'span', undefined, 'se-citation-card-dates');
  dates.append(timeElement(document, citation.accessedAt, labels.citation.accessed));
  if (citation.publishedAt) dates.append(document.createTextNode(' · '), timeElement(document, citation.publishedAt, labels.citation.published));
  card.append(dates);
  return card;
}

export function renderRuns(document: Document, report: ResearchDocument, runs: readonly InlineRun[], context: RenderContext, block?: Block): Node[] {
  const labels = context.labels;
  return runSegments(runs, report.citations).flatMap((segment, index) => {
    let node: Node = document.createTextNode('');
    if (segment.text) { const holder = document.createDocumentFragment(); appendText(document, holder, segment.text, context, block?.id); node = holder; }
    const wrap = (tag: 'code' | 'em' | 'strong' | 's' | 'u' | 'mark'): HTMLElement => { const wrapper = element(document, tag); wrapper.append(node); node = wrapper; return wrapper; };
    if (segment.code) wrap('code');
    if (segment.italic) wrap('em');
    if (segment.bold) wrap('strong');
    if (segment.strike) wrap('s');
    if (segment.underline) wrap('u');
    if (segment.highlight) { const mark = wrap('mark'); mark.dataset.highlight = segment.highlight; mark.className = 'se-highlight'; }
    if (segment.href) { const link = element(document, 'a'); link.href = segment.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.append(node); node = link; }
    else if (segment.unsafeHref) { const wrapper = element(document, 'span'); wrapper.append(node, document.createTextNode(` ${labels.document.unsafeUrl}`)); node = wrapper; }
    if (!segment.citation) return [node];
    const { citation } = segment;
    const marker = element(document, 'sup', undefined, 'se-citation'); marker.dataset.citationId = citation.id;
    const cardId = `se-card-${block?.id ?? 'x'}-${index}`;
    const link = element(document, 'a', `[${citation.number || '?'}]`);
    link.href = `#cite-${citation.id}`; link.className = 'se-citation-link';
    link.setAttribute('aria-label', template(labels.blocks.footnote, { number: citation.number || '?' }));
    marker.append(link);
    if (citation.citation) { link.setAttribute('aria-describedby', cardId); marker.append(citationCard(document, citation.citation, labels, cardId)); }
    return [node, marker];
  });
}

function renderList(document: Document, block: Block, content: Extract<BlockContent, { type: 'list' }>, context: RenderContext): HTMLElement {
  const model = listModel(content), { labels } = context, toggle = context.options.onToggleTodo;
  const build = (items: readonly ListItemNode[]): HTMLElement => {
    const list = element(document, model.style === 'number' ? 'ol' : 'ul', undefined, `se-list se-list-${model.style}`);
    for (const item of items) {
      const entry = element(document, 'li', undefined, model.style === 'todo' ? 'se-todo-item' : undefined);
      if (model.style === 'todo') {
        entry.dataset.checked = String(item.checked === true);
        const label = element(document, 'label', undefined, 'se-todo-label');
        const box = element(document, 'input', undefined, 'se-todo-box');
        box.type = 'checkbox'; box.checked = item.checked === true;
        box.setAttribute('aria-label', `${item.text} — ${item.checked ? labels.blocks.todoDone : labels.blocks.todoOpen}`);
        if (toggle) box.addEventListener('change', () => toggle(block, item.index, box.checked)); else box.disabled = true;
        label.append(box, textElement(document, 'span', item.text, context, block, 'se-todo-text'));
        entry.append(label);
      } else appendText(document, entry, item.text, context, block.id);
      if (item.children.length) entry.append(build(item.children));
      list.append(entry);
    }
    return list;
  };
  return build(model.items);
}

function renderTable(document: Document, block: Block, content: Extract<BlockContent, { type: 'table' }>, context: RenderContext): HTMLElement {
  const model = tableModel(content);
  const wrap = element(document, 'div', undefined, 'se-table-wrap');
  wrap.setAttribute('role', 'region'); wrap.tabIndex = 0;
  wrap.setAttribute('aria-label', model.caption ?? context.labels.chart.dataSuffix);
  if (model.rows.length > 14) wrap.dataset.long = 'true';
  const table = element(document, 'table', undefined, 'se-table');
  if (model.caption) table.append(textElement(document, 'caption', model.caption, context, block));
  const head = element(document, 'thead'), headings = element(document, 'tr');
  model.columns.forEach((column) => {
    const th = element(document, 'th'); th.scope = 'col'; th.className = `se-align-${column.align}`; appendText(document, th, column.label, context, block.id); headings.append(th);
  });
  head.append(headings); table.append(head);
  const body = element(document, 'tbody');
  for (const row of model.rows) {
    const tr = element(document, 'tr');
    row.cells.forEach((cell) => {
      const node = element(document, cell.header ? 'th' : 'td'); if (cell.header) node.scope = 'row';
      node.className = `se-align-${cell.align}${cell.numeric ? ' se-numeric' : ''}`; appendText(document, node, cell.text, context, block.id); tr.append(node);
    });
    body.append(tr);
  }
  table.append(body); wrap.append(table); return wrap;
}

function renderToc(document: Document, report: ResearchDocument, context: RenderContext): HTMLElement {
  const nav = element(document, 'nav', undefined, 'se-toc');
  nav.setAttribute('aria-label', context.labels.blocks.toc);
  const outline = getOutline(report);
  if (!outline.length) { nav.append(element(document, 'p', context.labels.blocks.tocEmpty, 'se-toc-empty')); return nav; }
  const build = (items: readonly OutlineItem[]): HTMLElement => {
    const list = element(document, 'ol');
    for (const item of items) {
      const entry = element(document, 'li'); entry.dataset.level = String(item.level);
      const link = element(document, 'a', item.title); link.href = `#${item.id}`;
      link.addEventListener('click', (event) => { if (revealBlock(nav.ownerDocument, item.id)) event.preventDefault(); });
      entry.append(link);
      if (item.children.length) entry.append(build(item.children));
      list.append(entry);
    }
    return list;
  };
  nav.append(build(outline));
  return nav;
}

function copyText(document: Document, text: string): Promise<void> {
  const clipboard = document.defaultView?.navigator?.clipboard;
  if (clipboard?.writeText) return clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const area = element(document, 'textarea'); area.value = text; area.setAttribute('readonly', ''); area.style.position = 'fixed'; area.style.opacity = '0';
    document.body.append(area); area.select();
    try { document.execCommand('copy') ? resolve() : reject(new Error('copy failed')); } catch (error) { reject(error); } finally { area.remove(); }
  });
}

function renderCode(document: Document, content: Extract<BlockContent, { type: 'code' }>, context: RenderContext): HTMLElement {
  const { labels } = context;
  const wrap = element(document, 'div', undefined, 'se-code');
  const bar = element(document, 'div', undefined, 'se-code-bar');
  if (content.language) bar.append(element(document, 'span', content.language, 'se-code-language'));
  const button = element(document, 'button', labels.blocks.copyCode, 'se-code-copy'); button.type = 'button';
  const status = srOnly(document, ''); status.setAttribute('role', 'status');
  let timer: ReturnType<typeof setTimeout> | undefined;
  button.addEventListener('click', () => {
    void copyText(document, content.text).then(() => { button.textContent = labels.blocks.copied; status.textContent = labels.blocks.copied; }, () => { button.textContent = labels.blocks.copyFailed; status.textContent = labels.blocks.copyFailed; });
    clearTimeout(timer); timer = setTimeout(() => { button.textContent = labels.blocks.copyCode; status.textContent = ''; }, 1600);
  });
  bar.append(button, status);
  const pre = element(document, 'pre'); pre.tabIndex = 0;
  const code = element(document, 'code', content.text); if (content.language) { code.dataset.language = content.language; code.className = `language-${content.language}`; }
  pre.append(code); wrap.append(bar, pre);
  return wrap;
}

function renderImage(document: Document, content: Extract<BlockContent, { type: 'image' }>, context: RenderContext): HTMLElement {
  const model = imageModel(content);
  const figure = element(document, 'figure', undefined, 'super-editor-image se-image'); figure.dataset.width = model.width;
  if (model.src) {
    const image = element(document, 'img'); image.src = model.src; image.alt = model.alt; image.loading = 'lazy'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => { const broken = element(document, 'p', context.labels.blocks.imageBroken, 'se-image-broken'); broken.setAttribute('role', 'img'); broken.setAttribute('aria-label', model.alt || context.labels.blocks.imageBroken); image.replaceWith(broken); });
    figure.append(image);
  } else figure.append(element(document, 'p', model.alt || content.url, 'se-image-broken'));
  if (model.caption) figure.append(element(document, 'figcaption', model.caption));
  return figure;
}

/** The embed block: a sandboxed iframe when the policy allows the origin, always with a link card as the fallback. */
function renderEmbed(document: Document, content: Extract<BlockContent, { type: 'embed' }>, context: RenderContext): HTMLElement {
  const { labels } = context, url = allowedEmbedUrl(content.url, context.options.embedPolicy);
  const figure = element(document, 'figure', undefined, 'super-editor-embed se-embed');
  figure.dataset.provider = content.provider; figure.dataset.state = url ? 'live' : 'card';
  const card = element(document, 'div', undefined, 'se-embed-card');
  card.append(element(document, 'span', 'SuperChart', 'se-embed-provider'), safeLink(document, content.url, content.title, `${content.title} ${labels.document.unsafeUrl}`));
  if (!url) card.append(element(document, 'span', labels.blocks.embedBlocked, 'se-embed-note'));
  figure.append(card);
  if (url) {
    const iframe = element(document, 'iframe', undefined, 'se-embed-frame'); iframe.src = url; iframe.title = content.title;
    iframe.setAttribute('sandbox', 'allow-scripts'); iframe.referrerPolicy = 'no-referrer'; iframe.loading = 'lazy';
    iframe.style.height = `${embedHeight(content.height)}px`;
    figure.append(iframe);
  }
  return figure;
}

function renderToggle(document: Document, block: Block, content: Extract<BlockContent, { type: 'toggle' }>, context: RenderContext): HTMLElement {
  const { labels } = context;
  const wrap = element(document, 'div', undefined, 'se-toggle');
  const bodyId = `${block.id}-body`;
  const button = element(document, 'button', undefined, 'se-toggle-button'); button.type = 'button';
  const caret = element(document, 'span', '▸', 'se-toggle-caret'); caret.setAttribute('aria-hidden', 'true');
  button.append(caret, textElement(document, 'span', content.title, context, block, 'se-toggle-title'));
  const body = element(document, 'div', undefined, 'se-toggle-body'); body.id = bodyId; body.setAttribute('role', 'group'); body.setAttribute('aria-label', content.title);
  body.dataset.seChildren = '';
  const apply = (open: boolean): void => {
    button.setAttribute('aria-expanded', String(open)); button.setAttribute('aria-label', template(open ? labels.blocks.collapse : labels.blocks.expand, { title: content.title }));
    wrap.dataset.open = String(open); body.hidden = !open;
  };
  button.setAttribute('aria-controls', bodyId);
  apply(content.open);
  button.addEventListener('click', () => { const next = button.getAttribute('aria-expanded') !== 'true'; apply(next); context.options.onToggle?.(block, next); });
  wrap.append(button, body);
  return wrap;
}

function renderMetrics(document: Document, content: Extract<BlockContent, { type: 'metrics' }>, context: RenderContext): HTMLElement {
  const { labels } = context;
  const list = element(document, 'dl', undefined, 'se-metrics');
  for (const metric of metricModels(content)) {
    const card = element(document, 'div', undefined, 'se-metric'); card.dataset.tone = metric.tone;
    card.append(element(document, 'dt', metric.label, 'se-metric-label'), element(document, 'dd', metric.value, 'se-metric-value'));
    if (metric.change !== undefined) {
      const change = element(document, 'dd', undefined, 'se-metric-change');
      const arrow = element(document, 'span', metric.arrow); arrow.setAttribute('aria-hidden', 'true');
      change.append(arrow, srOnly(document, `${metric.tone === 'up' ? labels.blocks.metricUp : metric.tone === 'down' ? labels.blocks.metricDown : labels.blocks.metricFlat} `), document.createTextNode(metric.change));
      card.append(change);
    }
    if (metric.hint) card.append(element(document, 'dd', metric.hint, 'se-metric-hint'));
    list.append(card);
  }
  return list;
}

function calloutIcon(document: Document, tone: keyof typeof TONE_ICONS): SVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  attributes(svg, { viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'se-callout-icon' });
  const shape = document.createElementNS(SVG_NS, 'path'); shape.setAttribute('d', TONE_ICONS[tone]); svg.append(shape);
  return svg;
}

/** The built-in chart view for a spec, configured from the render context. */
export function renderChart(spec: ChartSpec, context: RenderContext): HTMLElement {
  return renderChartFigure(spec, {
    document: context.document, labels: context.labels.chart, actions: context.options.chartActions !== false,
    ...(context.options.locale ? { locale: context.options.locale } : {}), ...(context.options.exportTheme ? { exportTheme: context.options.exportTheme } : {}),
  });
}

export function renderDefaultBlock(block: Block, context: RenderContext): HTMLElement {
  const { document, report, labels } = context, { content } = block;
  switch (content.type) {
    case 'section': { const title = textElement(document, 'h2', content.title, context, block, 'se-section-title'); title.id = `${block.id}-title`; return title; }
    case 'heading': return textElement(document, content.level === 1 ? 'h1' : content.level === 2 ? 'h2' : 'h3', content.text, context, block, 'se-heading');
    case 'paragraph': { const paragraph = element(document, 'p', undefined, 'se-paragraph'); paragraph.append(...renderRuns(document, report, content.runs, context, block)); return paragraph; }
    case 'list': return renderList(document, block, content, context);
    case 'table': return renderTable(document, block, content, context);
    case 'chart': {
      const registry = context.options.chartRenderers;
      const renderer = registry && Object.hasOwn(registry, content.spec.kind) ? registry[content.spec.kind] : undefined;
      return renderer?.(content.spec, context) ?? renderChart(content.spec, context);
    }
    case 'embed': return renderEmbed(document, content, context);
    case 'timestamp': { const stamp = timeElement(document, content.at, content.label); stamp.className = 'se-timestamp'; return stamp; }
    case 'quote': {
      const quote = element(document, 'blockquote', undefined, 'se-quote');
      const text = element(document, 'p'); text.append(...renderRuns(document, report, content.runs, context, block)); quote.append(text);
      if (content.attribution) { const footer = element(document, 'footer'); footer.append(document.createTextNode('— '), element(document, 'cite', content.attribution)); quote.append(footer); }
      return quote;
    }
    case 'callout': {
      const callout = element(document, 'div', undefined, 'se-callout'); callout.dataset.tone = content.tone;
      callout.setAttribute('role', 'note'); callout.setAttribute('aria-label', labels.blocks.toneNames[content.tone]);
      const body = element(document, 'div', undefined, 'se-callout-body');
      if (content.title) body.append(textElement(document, 'strong', content.title, context, block, 'se-callout-title'));
      const text = element(document, 'p'); text.append(...renderRuns(document, report, content.runs, context, block)); body.append(text);
      callout.append(calloutIcon(document, content.tone), body); return callout;
    }
    case 'code': return renderCode(document, content, context);
    case 'divider': return element(document, 'hr', undefined, 'se-divider');
    case 'image': return renderImage(document, content, context);
    case 'toggle': return renderToggle(document, block, content, context);
    case 'metrics': return renderMetrics(document, content, context);
    case 'toc': return renderToc(document, report, context);
    case 'pageBreak': { const rule = element(document, 'div', undefined, 'se-page-break super-editor-page-break'); rule.setAttribute('role', 'separator'); rule.setAttribute('aria-label', labels.blocks.pageBreak); rule.append(element(document, 'span', labels.blocks.pageBreak)); return rule; }
  }
}

