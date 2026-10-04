import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { LIMITS, stats } from '@super-solution/editor-core';
import type { Actor, ApplyResult, Editor, ResearchDocument } from '@super-solution/editor-core';
import { localId, plural, template } from '@super-solution/editor-ui';
import type { PartialLabels } from '@super-solution/editor-ui';
import { useLabels } from '../render/context.js';
import { absoluteTime, relativeTime, useNow } from './hooks.js';

export type DocumentHeaderProps = {
  document: ResearchDocument;
  /** When set, committing a new title applies a `setTitle` transaction through this editor. */
  editor?: Editor;
  actor?: Actor;
  /** Called after the title is committed (or instead of an editor, for hosts that save elsewhere). */
  onTitleChange?: (title: string) => void;
  /** Called with the apply result when the editor path is used, so the host can toast conflicts. */
  onResult?: (result: ApplyResult) => void;
  /** Force read-only. Default: editable when an `editor` or `onTitleChange` is given. */
  editable?: boolean;
  /** Extra meta items after revision, update time and word count (kind badge, owner, tags). */
  meta?: ReactNode;
  /** Right-aligned actions (export, share). */
  actions?: ReactNode;
  now?: number;
  locale?: string;
  labels?: PartialLabels;
  className?: string;
};
const defaultActor: Actor = { id: 'local-human', kind: 'human' };

/** Editable title (Enter saves, Esc reverts) and a meta line with revision, time and length. */
export function DocumentHeader({ document, editor, actor = defaultActor, onTitleChange, onResult, editable, meta, actions, now: fixedNow, locale, labels: override, className }: DocumentHeaderProps): ReactNode {
  const labels = useLabels(override), inputId = useId();
  const canEdit = editable ?? (editor !== undefined || onTitleChange !== undefined);
  const [draft, setDraft] = useState(document.title), focused = useRef(false);
  // Follow the document unless the reader is typing.
  useEffect(() => { if (!focused.current) setDraft(document.title); }, [document.title]);
  const ticking = useNow(fixedNow === undefined, 60_000), now = fixedNow ?? ticking;
  const deferred = useDeferredValue(document);
  const words = useMemo(() => stats(deferred).words, [deferred]);
  const commit = (): void => {
    focused.current = false;
    const title = draft.trim().slice(0, LIMITS.title);
    if (title === document.title) { setDraft(document.title); return; }
    if (!title) { setDraft(document.title); return; }
    if (editor) {
      const snapshot = editor.getSnapshot();
      const result = editor.apply({ id: localId('human'), actor, baseRevision: snapshot.revision, operations: [{ type: 'setTitle', title }] });
      onResult?.(result);
      if (!result.ok) setDraft(document.title);
    }
    onTitleChange?.(title);
  };
  return <header className={`se-doc-header${className ? ` ${className}` : ''}`}>
    <div className="se-doc-header-main">
      {canEdit
        ? <h1 className="se-doc-title"><input id={inputId} className="se-doc-title-input" value={draft} maxLength={LIMITS.title} placeholder={labels.header.titlePlaceholder} aria-label={labels.header.titleLabel} spellCheck
          onFocus={() => { focused.current = true; }} onChange={(event) => setDraft(event.target.value)} onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); (event.target as HTMLInputElement).blur(); } else if (event.key === 'Escape') { setDraft(document.title); focused.current = false; (event.target as HTMLInputElement).blur(); } }} /></h1>
        : <h1 className="se-doc-title">{document.title || labels.header.titlePlaceholder}</h1>}
      <p className="se-doc-meta">
        <span>{template(labels.header.revision, { revision: document.revision })}</span>
        <span><time dateTime={document.updatedAt} title={absoluteTime(document.updatedAt, locale)}>{template(labels.header.updated, { time: relativeTime(document.updatedAt, now, labels.save.justNow, locale) })}</time></span>
        <span>{plural(words, labels.status.word, labels.status.words)}</span>
        {meta}
      </p>
    </div>
    {actions ? <div className="se-doc-actions">{actions}</div> : null}
  </header>;
}
