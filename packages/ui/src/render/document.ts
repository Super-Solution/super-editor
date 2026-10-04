import type { Block, Citation, ResearchDocument } from '@super-solution/editor-core';
import { renderDefaultBlock } from './blocks.js';
import { element, hostOf, safeLink, timeElement } from './dom.js';
import { resolveLabels, template, type Labels } from './labels.js';
import { renderRoots, VIRTUALIZE_THRESHOLD } from './models.js';
import type { RenderContext, RenderOptions } from './types.js';

function renderCitations(report: ResearchDocument, document: Document, labels: Labels): HTMLElement | null {
  if (!report.citations.length) return null;
  const section = element(document, 'section', undefined, 'super-editor-citations se-sources');
  section.setAttribute('aria-label', labels.document.sources);
  section.append(element(document, 'h2', labels.document.sources));
  const list = element(document, 'ol');
  report.citations.forEach((citation: Citation) => {
    const item = element(document, 'li'); item.dataset.citationId = citation.id; item.id = `cite-${citation.id}`;
    item.append(safeLink(document, citation.url, citation.title, `${citation.title} ${labels.document.unsafeUrl}`));
    const host = hostOf(citation.url);
    if (host) item.append(document.createTextNode(' '), element(document, 'span', host, 'se-cite-host'));
    const dates = element(document, 'small'); dates.append(timeElement(document, citation.accessedAt, labels.document.accessed));
    if (citation.publishedAt) dates.append(document.createTextNode(' · '), timeElement(document, citation.publishedAt, labels.document.published));
    item.append(dates); list.append(item);
  });
  section.append(list); return section;
}

function diffMark(block: Block, sets: { added: Set<string>; changed: Set<string>; moved: Set<string> }): string | undefined {
  return sets.added.has(block.id) ? 'added' : sets.changed.has(block.id) ? 'changed' : sets.moved.has(block.id) ? 'moved' : undefined;
}

/** Applies the document-level attributes the stylesheet and print rules key off. */
export function applyDocumentAttributes(node: HTMLElement, report: ResearchDocument, options: Pick<RenderOptions, 'theme' | 'density'>): void {
  node.dataset.documentId = report.id; node.dataset.page = report.format.page; node.dataset.font = report.format.font;
  if (options.theme) node.dataset.seTheme = options.theme;
  if (options.density) node.dataset.seDensity = options.density;
  if (report.blocks.length > VIRTUALIZE_THRESHOLD) node.dataset.large = 'true';
  node.style.fontSize = `${report.format.fontSize}px`; node.style.lineHeight = String(report.format.lineHeight);
}

/** Render without attaching to the page; host renderers are trusted application code. */
export function renderDocument(report: ResearchDocument, options: RenderOptions = {}): HTMLElement {
  const document = options.document ?? globalThis.document;
  if (!document) throw new Error('renderDocument requires a DOM Document.');
  const labels = resolveLabels(options.labels);
  const article = element(document, 'article', undefined, `super-editor-document${options.className ? ` ${options.className}` : ''}`);
  applyDocumentAttributes(article, report, options);
  const titleId = `${report.id}-title`;
  article.setAttribute('aria-labelledby', titleId);
  if (options.showHeader !== false) {
    const header = element(document, 'header', undefined, 'se-header');
    const title = element(document, 'h1', report.title || labels.document.untitled); title.id = titleId;
    const metadata = element(document, 'p', undefined, 'super-editor-metadata');
    metadata.append(document.createTextNode(`${template(labels.document.revision, { revision: report.revision })} · `), timeElement(document, report.updatedAt, labels.document.updated));
    header.append(title, metadata); article.append(header);
  }
  const context: RenderContext = { document, report, options, labels, renderDefaultBlock: (block) => renderDefaultBlock(block, context) };
  const sets = { added: new Set(options.diff?.added ?? []), changed: new Set(options.diff?.changed ?? []), moved: new Set(options.diff?.moved ?? []) };
  const { roots, children, orphans } = renderRoots(report);
  const visited = new Set<string>();
  const appendBlock = (block: Block, parent: HTMLElement): void => {
    if (visited.has(block.id)) return;
    visited.add(block.id);
    const wrapper = element(document, block.content.type === 'section' ? 'section' : 'div', undefined, 'super-editor-block se-block');
    wrapper.id = block.id; wrapper.dataset.blockId = block.id; wrapper.dataset.blockType = block.content.type;
    const mark = diffMark(block, sets); if (mark) wrapper.dataset.diff = mark;
    let content: HTMLElement;
    try { content = options.blockRenderers?.[block.content.type]?.(block, context) ?? renderDefaultBlock(block, context); } catch (error) {
      options.onRenderError?.(error, block);
      content = element(document, 'div', undefined, 'se-block-error'); content.setAttribute('role', 'alert');
      content.append(element(document, 'strong', labels.blocks.renderError));
    }
    wrapper.append(content);
    if (block.content.type === 'section' && (content.id === `${block.id}-title` || Array.from(content.querySelectorAll('[id]')).some((node) => node.id === `${block.id}-title`))) wrapper.setAttribute('aria-labelledby', `${block.id}-title`);
    if (block.citationIds.length) {
      const references = element(document, 'small', undefined, 'super-editor-block-sources');
      references.textContent = template(labels.document.blockSources, { list: block.citationIds.map((id) => report.citations.find((citation) => citation.id === id)?.title ?? id).join('; ') });
      wrapper.append(references);
    }
    // Containers (sections, toggles) render their children into the slot their renderer provides.
    const slot = content.matches?.('[data-se-children]') ? content : content.querySelector<HTMLElement>('[data-se-children]');
    (children.get(block.id) ?? []).forEach((child) => appendBlock(child, slot ?? wrapper));
    parent.append(wrapper);
  };
  roots.forEach((block) => appendBlock(block, article));
  orphans.forEach((block) => appendBlock(block, article));
  const citations = renderCitations(report, document, labels); if (citations) article.append(citations);
  return article;
}

