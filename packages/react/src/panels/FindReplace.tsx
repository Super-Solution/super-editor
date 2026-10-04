import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Actor, ApplyResult, Editor } from '@super-solution/editor-core';
import { findMatches, localId, plural, replaceOperations, revealBlock, template } from '@super-solution/editor-ui';
import type { FindHighlight, PartialLabels } from '@super-solution/editor-ui';
import { useLabels } from '../render/context.js';
import { useEditorDocument } from './hooks.js';

export type FindReplaceProps = {
  editor: Editor;
  actor?: Actor;
  /** Controlled visibility. Omit to let the panel open itself on Mod+F / Mod+H. */
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Open with the replace field showing. */
  defaultReplace?: boolean;
  /** Pass the result to `ReportView find={...}` to highlight matches in the document. `null` when closed or empty. */
  onFindChange?: (find: FindHighlight | null) => void;
  /** Called after jumping to a block. */
  onNavigate?: (blockId: string) => void;
  /** Every replace goes through `editor.apply`; this reports the outcome so you can toast conflicts. */
  onResult?: (result: ApplyResult, info: { replaced: number }) => void;
  /** Document or element containing the rendered blocks, for scrolling. Default: the page. */
  contentRoot?: ParentNode | null;
  /** Listen for Mod+F (find) and Mod+H (replace). Default true; turn off when your own shortcut registry owns them. */
  shortcuts?: boolean;
  readOnly?: boolean;
  labels?: PartialLabels;
  className?: string;
};
const defaultActor: Actor = { id: 'local-human', kind: 'human' };

/**
 * Find and replace over the document text. Matches are listed per block; Replace changes the first match in the
 * current block, Replace all changes every match in one transaction. Every change is a `replaceText` operation
 * guarded by the block's version, so a concurrent edit by an agent is reported as a conflict rather than overwritten.
 */
export function FindReplace({ editor, actor = defaultActor, open: controlledOpen, defaultOpen = false, onOpenChange, defaultReplace = false, onFindChange, onNavigate, onResult, contentRoot, shortcuts = true, readOnly = false, labels: override, className }: FindReplaceProps): ReactNode {
  const labels = useLabels(override), report = useEditorDocument(editor), id = useId();
  const [innerOpen, setInnerOpen] = useState(defaultOpen);
  const open = controlledOpen ?? innerOpen;
  const [query, setQuery] = useState(''), [replacement, setReplacement] = useState(''), [caseSensitive, setCaseSensitive] = useState(false);
  const [showReplace, setShowReplace] = useState(defaultReplace), [position, setPosition] = useState(0), [message, setMessage] = useState('');
  const findInput = useRef<HTMLInputElement>(null), replaceInput = useRef<HTMLInputElement>(null);
  const setOpen = useCallback((next: boolean): void => { setInnerOpen(next); onOpenChange?.(next); }, [onOpenChange]);

  const result = useMemo(() => findMatches(report, query, { caseSensitive }), [report, query, caseSensitive]);
  const index = result.blocks.length ? Math.min(position, result.blocks.length - 1) : -1;
  const active = index >= 0 ? result.blocks[index] : undefined;

  useEffect(() => { setPosition(0); setMessage(''); }, [query, caseSensitive]);
  useEffect(() => { onFindChange?.(open && query ? { query, caseSensitive, activeBlockId: active?.blockId ?? null } : null); }, [open, query, caseSensitive, active?.blockId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) { (showReplace && query ? replaceInput : findInput).current?.focus(); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = useCallback((blockId: string | undefined): void => {
    if (!blockId) return;
    const root = contentRoot ?? (typeof document === 'undefined' ? null : document);
    if (root) revealBlock(root, blockId, { focus: false });
    onNavigate?.(blockId);
  }, [contentRoot, onNavigate]);
  const move = (delta: number): void => {
    if (!result.blocks.length) return;
    const next = (index + delta + result.blocks.length) % result.blocks.length;
    setPosition(next); go(result.blocks[next]?.blockId);
  };
  // Jump to the first match as the reader types.
  useEffect(() => { if (open && query && result.blocks[0]) go(result.blocks[0].blockId); }, [query, caseSensitive, open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!shortcuts || typeof document === 'undefined') return;
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'f' && key !== 'h') return;
      event.preventDefault();
      if (key === 'h' && !readOnly) setShowReplace(true);
      setOpen(true);
      requestAnimationFrame(() => (key === 'h' && !readOnly ? replaceInput : findInput).current?.select());
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [shortcuts, readOnly, setOpen]);

  const run = (matches: typeof result.blocks, all: boolean): void => {
    if (readOnly || !matches.length) return;
    const count = all ? matches.reduce((sum, match) => sum + match.count, 0) : 1;
    const outcome = editor.apply({ id: localId('human'), actor, baseRevision: report.revision, operations: replaceOperations(matches, query, replacement, { all, caseSensitive }) });
    setMessage(outcome.ok ? plural(count, labels.find.replacedOne, labels.find.replaced) : outcome.issues.some((issue) => issue.code === 'conflict') ? labels.find.conflict : outcome.issues.map((issue) => issue.message).join(' '));
    onResult?.(outcome, { replaced: outcome.ok ? count : 0 });
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
    else if (event.key === 'Enter' && (event.target as HTMLElement).tagName === 'INPUT') { event.preventDefault(); if ((event.target as HTMLElement) === replaceInput.current && !event.shiftKey) run(active ? [active] : [], false); else move(event.shiftKey ? -1 : 1); }
  };

  if (!open) return null;
  const summary = !query ? labels.find.empty : result.total === 0 ? labels.find.noMatches : result.total === 1 && result.blocks.length === 1 ? labels.find.matchesOne : template(labels.find.matches, { count: result.total, blocks: result.blocks.length });
  return <section className={`se-panel se-find${className ? ` ${className}` : ''}`} role="search" aria-label={labels.find.title} onKeyDown={onKeyDown}>
    <div className="se-find-row">
      <button type="button" className="se-icon-button" aria-expanded={showReplace} aria-label={showReplace ? labels.find.hideReplace : labels.find.showReplace} onClick={() => setShowReplace((value) => !value)} disabled={readOnly}>{showReplace ? '▾' : '▸'}</button>
      <input ref={findInput} className="se-input" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={labels.find.find} aria-label={labels.find.find} aria-describedby={`${id}-count`} autoComplete="off" spellCheck={false} />
      <button type="button" className="se-icon-button" aria-pressed={caseSensitive} title={labels.find.caseSensitive} aria-label={labels.find.caseSensitive} onClick={() => setCaseSensitive((value) => !value)}>Aa</button>
      <button type="button" className="se-icon-button" aria-label={labels.find.previous} title={labels.find.previous} onClick={() => move(-1)} disabled={!result.blocks.length}>↑</button>
      <button type="button" className="se-icon-button" aria-label={labels.find.next} title={labels.find.next} onClick={() => move(1)} disabled={!result.blocks.length}>↓</button>
      <button type="button" className="se-icon-button" aria-label={labels.find.close} title={labels.find.close} onClick={() => setOpen(false)}>×</button>
    </div>
    {showReplace && !readOnly ? <div className="se-find-row">
      <span className="se-find-spacer" aria-hidden="true" />
      <input ref={replaceInput} className="se-input" type="text" value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder={labels.find.replace} aria-label={labels.find.replace} autoComplete="off" spellCheck={false} />
      <button type="button" className="se-button" disabled={!active} onClick={() => run(active ? [active] : [], false)}>{labels.find.replaceOne}</button>
      <button type="button" className="se-button" disabled={!result.blocks.length} onClick={() => run(result.blocks, true)}>{labels.find.replaceAll}</button>
    </div> : null}
    <p className="se-find-status" id={`${id}-count`} role="status" aria-live="polite">
      <span>{message || summary}</span>
      {active && !message ? <span className="se-find-position">{template(labels.find.position, { current: index + 1, total: result.blocks.length })}</span> : null}
    </p>
    {readOnly ? <p className="se-find-status">{labels.find.readOnly}</p> : null}
    {active ? <p className="se-find-preview" title={active.preview}>{active.preview}</p> : null}
  </section>;
}
