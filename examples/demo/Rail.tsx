import type { ReactNode } from 'react';
import type { TemplateKind } from '@super-solution/editor-core';
import { Outline, useEditorDocument } from '@super-solution/editor-react';
import { TEMPLATES, type Doc } from './documents.js';
import { Icon } from './ui.js';

type Props = {
  docs: readonly Doc[]; active: Doc; onOpen(id: string): void; onTemplate(kind: TemplateKind): void; onEmpty(): void;
  /** The scroll container of the document, so the outline can follow it. */
  scroller: HTMLElement | null; open: boolean; onClose(): void;
};

/** Left rail: the page switcher, "New from template", and the outline of the current page with its active heading. A drawer on narrow screens. */
export function Rail({ docs, active, onOpen, onTemplate, onEmpty, scroller, open, onClose }: Props): ReactNode {
  const report = useEditorDocument(active.editor);
  return <aside className="rail" data-open={open || undefined} aria-label="Pages and outline">
    <button type="button" className="se-icon-button drawer-close" aria-label="Close pages" onClick={onClose}><Icon name="close" /></button>
    <nav aria-label="Pages">
      <h2 className="se-panel-title">Pages</h2>
      <ul className="rail-list">
        {docs.map((doc) => <li key={doc.id}><button type="button" className="rail-item" aria-current={doc.id === active.id ? 'page' : undefined} onClick={() => onOpen(doc.id)}>{doc.name}</button></li>)}
      </ul>
    </nav>
    <section aria-labelledby="new-from-template">
      <h2 className="se-panel-title" id="new-from-template">New from template</h2>
      <ul className="rail-list">
        {TEMPLATES.map((template) => <li key={template.kind}>
          <button type="button" className="rail-item" title={template.description} onClick={() => onTemplate(template.kind)}>{template.title}<small>{template.kind}</small></button>
        </li>)}
        <li><button type="button" className="rail-item" title="A document with no blocks: shows the empty state." onClick={onEmpty}>Empty page<small>no blocks</small></button></li>
      </ul>
    </section>
    <Outline document={report} scrollRoot={scroller} onNavigate={onClose} />
    <section className="rail-hint" aria-label="Things to try">
      <h2 className="se-panel-title">Try</h2>
      <ul>
        <li>Click the page and type. <kbd>/</kbd> inserts any block.</li>
        <li>Hover a block (or long-press) for its <kbd>+</kbd> and drag handle.</li>
        <li><kbd>Ctrl/⌘ F</kbd> finds, <kbd>Ctrl/⌘ H</kbd> replaces.</li>
        <li>Press a button in the Agent tab, then open History.</li>
      </ul>
      <p>Fictional data. Everything runs in your browser.</p>
    </section>
  </aside>;
}
