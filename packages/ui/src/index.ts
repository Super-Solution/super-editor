import { safeUrl } from '@super-solution/editor-core';
import type { Actor, Block, BlockContent, ChartSpec, Editor, InlineRun, ResearchDocument, ApplyResult, Operation } from '@super-solution/editor-core';
import { contentWithText, editableText, getChartModel, localId } from './presentation.js';

export type EmbedPolicy = { enabled: boolean; allowedOrigins: readonly string[] };
export type RenderContext = {
  document: Document; report: ResearchDocument; options: RenderOptions;
  renderDefaultBlock(block: Block): HTMLElement;
};
export type BlockRenderer = (block: Block, context: RenderContext) => HTMLElement;
export type ChartRenderer = (spec: ChartSpec, context: RenderContext) => HTMLElement;
export type RenderOptions = {
  document?: Document;
  className?: string;
  blockRenderers?: Partial<Record<BlockContent['type'], BlockRenderer>>;
  chartRenderers?: Record<string, ChartRenderer>;
  embedPolicy?: EmbedPolicy;
};
export type ControlsContext = { editor: Editor; report: ResearchDocument; document: Document; applyResult(result: ApplyResult): void };
export type MountOptions = RenderOptions & { actor?: Actor; controls?: false | ((context: ControlsContext) => HTMLElement) };

/** An embed is permitted only after an explicit exact HTTPS-origin allowlist match. */
export function allowedEmbedUrl(input: string, policy?: EmbedPolicy): string | null {
  if (!policy?.enabled) return null;
  const safe = safeUrl(input, { httpsOnly: true });
  if (!safe) return null;
  const origin = new URL(safe).origin;
  return policy.allowedOrigins.some((entry) => {
    const allowed = safeUrl(entry, { httpsOnly: true });
    if (!allowed) return false;
    const parsed = new URL(allowed);
    return parsed.origin === origin && parsed.pathname === '/' && !parsed.search && !parsed.hash;
  }) ? safe : null;
}

function element<K extends keyof HTMLElementTagNameMap>(document: Document, tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

function safeLink(document: Document, url: string, label: string): HTMLElement {
  const safe = safeUrl(url);
  if (!safe) return element(document, 'span', `${label} (unsafe URL omitted)`);
  const link = element(document, 'a', label);
  link.href = safe;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  return link;
}

function time(document: Document, at: string, label?: string): HTMLElement {
  const node = element(document, 'time', label ? `${label}: ${at}` : at);
  node.dateTime = at;
  return node;
}

export function renderChart(spec: ChartSpec, context: RenderContext): HTMLElement {
  const { document } = context;
  const figure = element(document, 'figure');
  figure.className = 'super-editor-chart';
  figure.append(element(document, 'figcaption', spec.title));
  const model = getChartModel(spec);
  if (model.message) figure.append(element(document, 'p', model.message));
  if (model.shapes.length) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 640 280');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${spec.title}. ${spec.kind} chart; exact values in the following table.`);
    const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
    title.textContent = spec.title;
    svg.append(title);
    for (const shape of model.shapes) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', shape.tag);
      Object.entries(shape.attributes).forEach(([key, value]) => node.setAttribute(key, String(value)));
      svg.append(node);
    }
    figure.append(svg);
  }
  if (spec.kind === 'pie' && spec.series.length > 1) figure.append(element(document, 'p', `Pie displays ${spec.series[0]!.name}; all series appear in the table.`));
  const table = element(document, 'table');
  table.append(element(document, 'caption', `${spec.title}${spec.unit ? ` (${spec.unit})` : ''} — data`));
  const head = element(document, 'thead'), headings = element(document, 'tr');
  ['Label', ...spec.series.map((series) => series.name)].forEach((label) => { const th = element(document, 'th', label); th.scope = 'col'; headings.append(th); });
  head.append(headings); table.append(head);
  const body = element(document, 'tbody');
  spec.labels.forEach((label, index) => {
    const row = element(document, 'tr'), heading = element(document, 'th', label);
    heading.scope = 'row'; row.append(heading);
    spec.series.forEach((series) => row.append(element(document, 'td', String(series.values[index] ?? ''))));
    body.append(row);
  });
  table.append(body); figure.append(table);
  if (spec.asOf) figure.append(time(document, spec.asOf, 'As of'));
  return figure;
}

function renderRuns(document: Document, report: ResearchDocument, runs: readonly InlineRun[]): Node[] {
  return runs.flatMap((run) => {
    let node: Node = document.createTextNode(run.text);
    const wrap = (tag: 'code' | 'em' | 'strong' | 's' | 'u' | 'mark'): HTMLElement => { const wrapper = element(document, tag); wrapper.append(node); node = wrapper; return wrapper; };
    if (run.code) wrap('code');
    if (run.italic) wrap('em');
    if (run.bold) wrap('strong');
    // v0.2 fallback; full renderer in SE2b
    if (run.strike) wrap('s');
    if (run.underline) wrap('u');
    if (run.highlight) wrap('mark').dataset.highlight = run.highlight;
    if (run.href) { const safe = safeUrl(run.href); if (safe) { const wrapper = element(document, 'a'); wrapper.href = safe; wrapper.target = '_blank'; wrapper.rel = 'noopener noreferrer'; wrapper.append(node); node = wrapper; } }
    if (!run.citationId) return [node];
    const marker = element(document, 'sup', `[${report.citations.findIndex((citation) => citation.id === run.citationId) + 1}]`); marker.dataset.citationId = run.citationId;
    return [node, marker];
  });
}

export function renderDefaultBlock(block: Block, context: RenderContext): HTMLElement {
  const { document } = context, { content } = block;
  switch (content.type) {
    case 'section': { const section = element(document, 'section'); section.append(element(document, 'h2', content.title)); return section; }
    case 'heading': return element(document, content.level === 1 ? 'h1' : content.level === 2 ? 'h2' : 'h3', content.text);
    case 'paragraph': { const paragraph = element(document, 'p'); paragraph.append(...renderRuns(document, context.report, content.runs)); return paragraph; }
    case 'list': {
      const list = element(document, content.ordered ? 'ol' : 'ul');
      // v0.2 fallback; full renderer in SE2b: todo state is shown as a text prefix and indent is ignored.
      content.items.forEach((item, index) => list.append(element(document, 'li', content.style === 'todo' ? `${content.checked?.[index] ? '☑' : '☐'} ${item}` : item)));
      return list;
    }
    case 'table': {
      const table = element(document, 'table'), head = element(document, 'thead'), headings = element(document, 'tr');
      // v0.2 fallback; full renderer in SE2b: caption and column alignment only.
      if (content.caption) table.append(element(document, 'caption', content.caption));
      content.columns.forEach((column, index) => { const th = element(document, 'th', column); th.scope = 'col'; if (content.align?.[index]) th.style.textAlign = content.align[index]!; headings.append(th); });
      head.append(headings); table.append(head);
      const body = element(document, 'tbody');
      content.rows.forEach((row) => { const tr = element(document, 'tr'); row.forEach((cell, index) => { const td = element(document, 'td', cell); if (content.align?.[index]) td.style.textAlign = content.align[index]!; tr.append(td); }); body.append(tr); });
      table.append(body); return table;
    }
    case 'chart': {
      const registry = context.options.chartRenderers;
      const renderer = registry && Object.hasOwn(registry, content.spec.kind) ? registry[content.spec.kind] : undefined;
      return renderer?.(content.spec, context) ?? renderChart(content.spec, context);
    }
    case 'embed': {
      const figure = element(document, 'figure'); figure.className = 'super-editor-embed';
      figure.append(safeLink(document, content.url, content.title));
      const url = allowedEmbedUrl(content.url, context.options.embedPolicy);
      if (url) {
        const iframe = element(document, 'iframe'); iframe.src = url; iframe.title = content.title;
        iframe.setAttribute('sandbox', 'allow-scripts'); iframe.referrerPolicy = 'no-referrer'; iframe.loading = 'lazy';
        figure.append(iframe);
      }
      return figure;
    }
    case 'timestamp': return time(document, content.at, content.label);
    // v0.2 fallback; full renderer in SE2b. Everything below is deliberately plain.
    case 'quote': { const quote = element(document, 'blockquote'); quote.append(...renderRuns(document, context.report, content.runs)); if (content.attribution) quote.append(element(document, 'cite', content.attribution)); return quote; }
    case 'callout': {
      const callout = element(document, 'aside'); callout.dataset.tone = content.tone;
      if (content.title) callout.append(element(document, 'strong', content.title));
      const body = element(document, 'p'); body.append(...renderRuns(document, context.report, content.runs)); callout.append(body); return callout;
    }
    case 'code': { const pre = element(document, 'pre'), code = element(document, 'code', content.text); if (content.language) code.dataset.language = content.language; pre.append(code); return pre; }
    case 'divider': return element(document, 'hr');
    case 'image': { const figure = element(document, 'figure'); figure.className = 'super-editor-image'; figure.append(safeLink(document, content.url, content.alt || content.url)); if (content.caption) figure.append(element(document, 'figcaption', content.caption)); return figure; }
    case 'toggle': return element(document, 'p', `▸ ${content.title}`);
    case 'metrics': { const list = element(document, 'ul'); content.items.forEach((item) => list.append(element(document, 'li', `${item.label}: ${item.value}`))); return list; }
    case 'toc': {
      const nav = element(document, 'nav'), list = element(document, 'ol'); nav.setAttribute('aria-label', 'Table of contents');
      context.report.blocks.forEach((entry) => { if (entry.content.type === 'heading') list.append(element(document, 'li', entry.content.text)); else if (entry.content.type === 'section') list.append(element(document, 'li', entry.content.title)); });
      nav.append(list); return nav;
    }
    case 'pageBreak': { const rule = element(document, 'hr'); rule.className = 'super-editor-page-break'; return rule; }
  }
}

function renderCitations(report: ResearchDocument, document: Document): HTMLElement | null {
  if (!report.citations.length) return null;
  const section = element(document, 'section'); section.className = 'super-editor-citations';
  section.setAttribute('aria-label', 'Sources'); section.append(element(document, 'h2', 'Sources'));
  const list = element(document, 'ol');
  report.citations.forEach((citation) => {
    const item = element(document, 'li'); item.dataset.citationId = citation.id;
    item.append(safeLink(document, citation.url, citation.title));
    const dates = element(document, 'small'); dates.append(time(document, citation.accessedAt, 'Accessed'));
    if (citation.publishedAt) dates.append(document.createTextNode(' · '), time(document, citation.publishedAt, 'Published'));
    item.append(dates); list.append(item);
  });
  section.append(list); return section;
}

/** Render without attaching to the page; host renderers are trusted application code. */
export function renderDocument(report: ResearchDocument, options: RenderOptions = {}): HTMLElement {
  const document = options.document ?? globalThis.document;
  if (!document) throw new Error('renderDocument requires a DOM Document.');
  const article = element(document, 'article');
  article.className = `super-editor-document${options.className ? ` ${options.className}` : ''}`;
  article.dataset.documentId = report.id; article.dataset.page = report.format.page; article.dataset.font = report.format.font;
  article.style.fontSize = `${report.format.fontSize}px`; article.style.lineHeight = String(report.format.lineHeight);
  article.append(element(document, 'h1', report.title));
  const metadata = element(document, 'p'); metadata.className = 'super-editor-metadata';
  metadata.append(document.createTextNode(`Revision ${report.revision} · `), time(document, report.updatedAt, 'Updated')); article.append(metadata);
  const context: RenderContext = { document, report, options, renderDefaultBlock: (block) => renderDefaultBlock(block, context) };
  const children = new Map<string | null, Block[]>();
  report.blocks.forEach((block) => { const siblings = children.get(block.parentId) ?? []; siblings.push(block); children.set(block.parentId, siblings); });
  const visited = new Set<string>();
  const appendBlock = (block: Block, parent: HTMLElement): void => {
    if (visited.has(block.id)) return;
    visited.add(block.id);
    const wrapper = element(document, block.content.type === 'section' ? 'section' : 'div');
    wrapper.className = 'super-editor-block'; wrapper.id = block.id; wrapper.dataset.blockId = block.id; wrapper.dataset.blockType = block.content.type;
    wrapper.append(options.blockRenderers?.[block.content.type]?.(block, context) ?? renderDefaultBlock(block, context));
    if (block.citationIds.length) {
      const references = element(document, 'small'); references.className = 'super-editor-block-sources';
      references.textContent = `Sources: ${block.citationIds.map((id) => report.citations.find((citation) => citation.id === id)?.title ?? id).join('; ')}`;
      wrapper.append(references);
    }
    (children.get(block.id) ?? []).forEach((child) => appendBlock(child, wrapper));
    parent.append(wrapper);
  };
  (children.get(null) ?? []).forEach((block) => appendBlock(block, article));
  report.blocks.filter((block) => !visited.has(block.id)).forEach((block) => appendBlock(block, article));
  const citations = renderCitations(report, document); if (citations) article.append(citations);
  return article;
}

type Draft = { text: string; baseRevision: number; version: number; block: Block };

/** A small local editing surface. Drafts retain their original guards until explicitly discarded. */
export function mountEditor(container: HTMLElement, editor: Editor, options: MountOptions = {}): { destroy(): void } {
  const document = options.document ?? container.ownerDocument;
  const actor = options.actor ?? { id: 'local-human', kind: 'human' as const };
  const drafts = new Map<string, Draft>();
  let error = '', destroyed = false;
  const root = element(document, 'div'); root.className = 'super-editor'; container.append(root);
  const result = (outcome: ApplyResult): void => { error = outcome.ok ? '' : outcome.issues.map((issue) => issue.message).join(' '); render(); };
  const button = (label: string, action: () => void): HTMLButtonElement => {
    const node = element(document, 'button', label); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const apply = (operations: Operation[], baseRevision = editor.getSnapshot().revision): ApplyResult => editor.apply({ id: localId('human'), actor, baseRevision, operations });
  const defaultControls = (report: ResearchDocument): HTMLElement => {
    const controls = element(document, 'div'); controls.className = 'super-editor-controls'; controls.setAttribute('role', 'toolbar'); controls.setAttribute('aria-label', 'Document controls');
    controls.append(button('Undo', () => result(editor.undo(actor, editor.getSnapshot().revision))), button('Redo', () => result(editor.redo(actor, editor.getSnapshot().revision))));
    const blockType = element(document, 'select'); blockType.setAttribute('aria-label', 'New block type');
    [['paragraph', 'Paragraph'], ['heading2', 'Heading 2'], ['heading3', 'Heading 3'], ['section', 'Section']].forEach(([value, label]) => { const option = element(document, 'option', label!); option.value = value!; blockType.append(option); });
    const parent = element(document, 'select'); parent.setAttribute('aria-label', 'New block section');
    const top = element(document, 'option', 'Document'); top.value = ''; parent.append(top);
    report.blocks.filter((block) => block.content.type === 'section').forEach((block) => { const option = element(document, 'option', (block.content as Extract<BlockContent, { type: 'section' }>).title); option.value = block.id; parent.append(option); });
    controls.append(blockType, parent, button('Add block', () => {
      const content: BlockContent = blockType.value === 'paragraph' ? { type: 'paragraph', runs: [{ text: 'New paragraph' }] } : blockType.value === 'section' ? { type: 'section', title: 'New section' } : { type: 'heading', level: blockType.value === 'heading3' ? 3 : 2, text: 'New heading' };
      const current = editor.getSnapshot();
      const siblings = current.blocks.filter((block) => block.parentId === (parent.value || null));
      result(apply([{ type: 'insertBlock', block: { id: localId('block'), parentId: parent.value || null, citationIds: [], content }, afterId: siblings.at(-1)?.id ?? null }], current.revision));
    }));
    for (const key of ['font', 'page'] as const) {
      const select = element(document, 'select'); select.setAttribute('aria-label', key === 'font' ? 'Document font' : 'Page format');
      const choices = key === 'font' ? ['sans', 'serif', 'mono'] : ['screen', 'A4', 'letter'];
      choices.forEach((value) => { const option = element(document, 'option', value); option.value = value; select.append(option); }); select.value = report.format[key];
      select.addEventListener('change', () => { const current = editor.getSnapshot(); result(apply([{ type: 'setFormat', format: { ...current.format, [key]: select.value } as ResearchDocument['format'] }], current.revision)); });
      controls.append(select);
    }
    return controls;
  };
  const render = (): void => {
    if (destroyed) return;
    const report = editor.getSnapshot();
    const nodes: Node[] = [];
    if (options.controls !== false) nodes.push(typeof options.controls === 'function' ? options.controls({ editor, report, document, applyResult: result }) : defaultControls(report));
    if (error) { const message = element(document, 'p', error); message.className = 'super-editor-error'; message.setAttribute('role', 'alert'); nodes.push(message); }
    const article = renderDocument(report, { ...options, document });
    for (const block of report.blocks) {
      const draft = drafts.get(block.id);
      if (!draft && editableText(block) === null) continue;
      const wrapper = Array.from(article.querySelectorAll<HTMLElement>('[data-block-id]')).find((node) => node.dataset.blockId === block.id);
      if (!wrapper) continue;
      if (!draft) {
        wrapper.append(button(`Edit ${block.content.type}`, () => { drafts.set(block.id, { text: editableText(block)!, baseRevision: report.revision, version: block.version, block }); render(); }));
        continue;
      }
      const edit = element(document, 'div'); edit.className = 'super-editor-block-edit';
      const textarea = element(document, 'textarea'); textarea.setAttribute('aria-label', `Edit block ${block.id}`); textarea.value = draft.text;
      textarea.addEventListener('input', () => { draft.text = textarea.value; });
      edit.append(textarea, element(document, 'small', 'Plain text editing replaces inline formatting when text changes.'));
      if (draft.version !== block.version || draft.baseRevision !== report.revision) edit.append(element(document, 'p', `Document changed since this draft began (revision ${draft.baseRevision}). Read current content and discard or reconcile your draft before saving.`));
      edit.append(button('Save block', () => {
        const outcome = apply([{ type: 'updateBlock', blockId: block.id, expectedVersion: draft.version, content: contentWithText(draft.block, draft.text) }], draft.baseRevision);
        if (outcome.ok) drafts.delete(block.id);
        result(outcome);
      }), button('Discard draft', () => { drafts.delete(block.id); error = ''; render(); }));
      wrapper.append(edit);
    }
    const deletedDrafts = [...drafts].filter(([id]) => !report.blocks.some((block) => block.id === id));
    for (const [id, draft] of deletedDrafts) {
      const recovery = element(document, 'div'); recovery.className = 'super-editor-block-edit';
      recovery.append(element(document, 'p', `Block ${id} was deleted. Your unsaved draft is preserved.`));
      const textarea = element(document, 'textarea'); textarea.setAttribute('aria-label', `Deleted block draft ${id}`); textarea.value = draft.text; textarea.readOnly = true;
      recovery.append(textarea, button('Discard draft', () => { drafts.delete(id); render(); })); nodes.push(recovery);
    }
    nodes.push(article); root.replaceChildren(...nodes);
  };
  const unsubscribe = editor.subscribe(render);
  render();
  return { destroy() { if (destroyed) return; destroyed = true; unsubscribe(); drafts.clear(); root.remove(); } };
}

export { getChartModel, chartColors, contentWithText, editableText, localId } from './presentation.js';
