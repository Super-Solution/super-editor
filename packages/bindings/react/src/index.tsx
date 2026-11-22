// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
'use client';
import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Actor, ApplyResult, Block, BlockContent, Editor, Operation, ResearchDocument } from '@supersolutions/super-editor-core';
import { contentWithText, editableText, localId, resolveLabels, template } from '@supersolutions/super-editor-ui';
import type { Labels } from '@supersolutions/super-editor-ui';
import type { Interaction } from '@supersolutions/super-editor-ui';
import { ReportView } from './render/index.js';
import type { ReportViewProps } from './render/index.js';
import { InteractiveReportEditor } from './interaction/ReportEditor.js';
import type { InteractionProps } from './interaction/ReportEditor.js';

export function useEditor(editor: Editor): ResearchDocument {
  return useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
}

export type ReactControlsContext = { editor: Editor; report: ResearchDocument; actor: Actor; applyResult(result: ApplyResult): void; interaction?: Interaction; /** The resolved UI strings (the `labels` prop over the English defaults). */ labels?: Labels };
export type ReportEditorProps = Omit<ReportViewProps, 'document' | 'renderBlockActions'> & InteractionProps & {
  editor: Editor; actor?: Actor;
  renderControls?: false | ((context: ReactControlsContext) => ReactNode);
};
type Draft = { text: string; baseRevision: number; version: number; block: Block };
const defaultActor: Actor = { id: 'local-human', kind: 'human' };

function DefaultControls({ editor, report, actor, applyResult, labels: given }: ReactControlsContext): ReactNode {
  const c = (given ?? resolveLabels()).classic;
  const [type, setType] = useState('paragraph'), [parent, setParent] = useState('');
  const apply = (operations: Operation[], baseRevision: number) => applyResult(editor.apply({ id: localId('human'), actor, baseRevision, operations }));
  const add = () => {
    const current = editor.getSnapshot(), siblings = current.blocks.filter((block) => block.parentId === (parent || null));
    const content: BlockContent = type === 'paragraph' ? { type: 'paragraph', runs: [{ text: c.newParagraph }] } : type === 'section' ? { type: 'section', title: c.newSection } : { type: 'heading', level: type === 'heading3' ? 3 : 2, text: c.newHeading };
    apply([{ type: 'insertBlock', block: { id: localId('block'), parentId: parent || null, citationIds: [], content }, afterId: siblings.at(-1)?.id ?? null }], current.revision);
  };
  return <div className="super-editor-controls" role="toolbar" aria-label={c.controls}>
    <button type="button" onClick={() => applyResult(editor.undo(actor, editor.getSnapshot().revision))}>{c.undo}</button>
    <button type="button" onClick={() => applyResult(editor.redo(actor, editor.getSnapshot().revision))}>{c.redo}</button>
    <select aria-label={c.newBlockType} value={type} onChange={(event) => setType(event.target.value)}><option value="paragraph">{c.paragraph}</option><option value="heading2">{c.heading2}</option><option value="heading3">{c.heading3}</option><option value="section">{c.section}</option></select>
    <select aria-label={c.newBlockSection} value={parent} onChange={(event) => setParent(event.target.value)}><option value="">{c.documentRoot}</option>{report.blocks.filter((block) => block.content.type === 'section').map((block) => <option key={block.id} value={block.id}>{(block.content as Extract<BlockContent, { type: 'section' }>).title}</option>)}</select>
    <button type="button" onClick={add}>{c.addBlock}</button>
    <select aria-label={c.font} value={report.format.font} onChange={(event) => { const current = editor.getSnapshot(); apply([{ type: 'setFormat', format: { ...current.format, font: event.target.value as ResearchDocument['format']['font'] } }], current.revision); }}><option value="sans">sans</option><option value="serif">serif</option><option value="mono">mono</option></select>
    <select aria-label={c.page} value={report.format.page} onChange={(event) => { const current = editor.getSnapshot(); apply([{ type: 'setFormat', format: { ...current.format, page: event.target.value as ResearchDocument['format']['page'] } }], current.revision); }}><option value="screen">screen</option><option value="A4">A4</option><option value="letter">letter</option></select>
  </div>;
}

const editorKeys = new WeakMap<Editor, number>();
let nextEditorKey = 0;

/**
 * The editor. By default it composes the interaction layer (in-place editing, "/" menu, hover gutter, drag and drop, selection,
 * shortcuts, formatting toolbar, history); every part has an opt-out prop. `interaction={false}` restores the classic
 * "Edit" button per block with a plain-text draft.
 */
export function ReportEditor(props: ReportEditorProps): ReactNode {
  if (props.interaction === false) return <ClassicReportEditor {...props} />;
  return <InteractiveReportEditor {...props} />;
}
const INTERACTION_PROPS = ['interaction', 'readOnly', 'interactionLabels', 'onReload', 'shortcuts', 'slashItems', 'slashLabels', 'messages', 'uploadImage', 'maxImageBytes', 'commitDelayMs', 'linkSchemes', 'onConflict', 'onFeedback', 'surface', 'portalContainer',
  'gutter', 'hoverOutline', 'selectionOverlay', 'dropIndicator', 'slashMenu', 'formattingToolbar', 'selectionToolbar', 'blockMenu', 'linkEditor', 'shortcutHelp', 'chartEditor', 'conflictNotice', 'feedback'] as const;
function ClassicReportEditor(allProps: ReportEditorProps): ReactNode {
  const props = { ...allProps } as ReportEditorProps;
  for (const name of INTERACTION_PROPS) delete (props as Record<string, unknown>)[name];
  // Draft state belongs to one editor instance, including when a host swaps the editor prop.
  let key = editorKeys.get(props.editor);
  if (key === undefined) { key = ++nextEditorKey; editorKeys.set(props.editor, key); }
  return <ReportEditorSurface key={key} {...props} />;
}

function ReportEditorSurface({ editor, actor = defaultActor, renderControls, ...viewProps }: ReportEditorProps): ReactNode {
  const report = useEditor(editor);
  const [drafts, setDrafts] = useState<Map<string, Draft>>(() => new Map()), [error, setError] = useState('');
  const applyResult = (outcome: ApplyResult): void => setError(outcome.ok ? '' : outcome.issues.map((issue) => issue.message).join(' '));
  const discard = (id: string): void => { setDrafts((previous) => { const next = new Map(previous); next.delete(id); return next; }); setError(''); };
  const begin = (block: Block): void => { setDrafts((previous) => new Map(previous).set(block.id, { text: editableText(block)!, baseRevision: report.revision, version: block.version, block })); };
  const change = (id: string, text: string): void => { setDrafts((previous) => { const draft = previous.get(id); return draft ? new Map(previous).set(id, { ...draft, text }) : previous; }); };
  const save = (block: Block, draft: Draft): void => {
    const outcome = editor.apply({ id: localId('human'), actor, baseRevision: draft.baseRevision, operations: [{ type: 'updateBlock', blockId: block.id, expectedVersion: draft.version, content: contentWithText(draft.block, draft.text) }] });
    if (outcome.ok) discard(block.id);
    applyResult(outcome);
  };
  const labels = resolveLabels(viewProps.labels), c = labels.classic;
  const controls = { editor, report, actor, applyResult, labels };
  return <div className="super-editor">
    {renderControls === false ? null : renderControls ? renderControls(controls) : <DefaultControls {...controls} />}
    {error ? <p className="super-editor-error" role="alert">{error}</p> : null}
    <ReportView {...viewProps} document={report} renderBlockActions={(block) => {
      const draft = drafts.get(block.id);
      if (!draft && editableText(block) === null) return null;
      if (!draft) return <button type="button" onClick={() => begin(block)}>{template(c.editBlock, { type: block.content.type })}</button>;
      return <div className="super-editor-block-edit">
        <textarea aria-label={template(c.editBlockLabel, { id: block.id })} value={draft.text} onChange={(event) => change(block.id, event.target.value)} />
        <small>{c.plainTextNote}</small>
        {draft.version !== block.version || draft.baseRevision !== report.revision ? <p>{template(c.staleDraft, { revision: draft.baseRevision })}</p> : null}
        <button type="button" onClick={() => save(block, draft)}>{c.saveBlock}</button><button type="button" onClick={() => discard(block.id)}>{c.discardDraft}</button>
      </div>;
    }} />
    {[...drafts].filter(([id]) => !report.blocks.some((block) => block.id === id)).map(([id, draft]) => <div className="super-editor-block-edit" key={id}><p>{template(c.deletedDraft, { id })}</p><textarea aria-label={template(c.deletedDraftLabel, { id })} value={draft.text} readOnly /><button type="button" onClick={() => discard(id)}>{c.discardDraft}</button></div>)}
  </div>;
}

// Rendering layer (blocks, charts, labels) and panels, plus the interaction layer.
export * from './render/index.js';
export * from './panels/index.js';
export * from './interaction/index.js';
export { OverlayPortal, PortalProvider, usePortalSetting, type PortalContainer } from './portal.js';
