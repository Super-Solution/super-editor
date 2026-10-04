import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { Actor, ApplyResult, Block, BlockContent, Editor, Operation, ResearchDocument } from '@super-solution/editor-core';
import { contentWithText, editableText, localId } from '@super-solution/editor-ui';
import { ReportView } from './render/index.js';
import type { ReportViewProps } from './render/index.js';

export function useEditor(editor: Editor): ResearchDocument {
  return useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
}

export type ReactControlsContext = { editor: Editor; report: ResearchDocument; actor: Actor; applyResult(result: ApplyResult): void };
export type ReportEditorProps = Omit<ReportViewProps, 'document' | 'renderBlockActions'> & {
  editor: Editor; actor?: Actor;
  renderControls?: false | ((context: ReactControlsContext) => ReactNode);
};
type Draft = { text: string; baseRevision: number; version: number; block: Block };
const defaultActor: Actor = { id: 'local-human', kind: 'human' };

function DefaultControls({ editor, report, actor, applyResult }: ReactControlsContext): ReactNode {
  const [type, setType] = useState('paragraph'), [parent, setParent] = useState('');
  const apply = (operations: Operation[], baseRevision: number) => applyResult(editor.apply({ id: localId('human'), actor, baseRevision, operations }));
  const add = () => {
    const current = editor.getSnapshot(), siblings = current.blocks.filter((block) => block.parentId === (parent || null));
    const content: BlockContent = type === 'paragraph' ? { type: 'paragraph', runs: [{ text: 'New paragraph' }] } : type === 'section' ? { type: 'section', title: 'New section' } : { type: 'heading', level: type === 'heading3' ? 3 : 2, text: 'New heading' };
    apply([{ type: 'insertBlock', block: { id: localId('block'), parentId: parent || null, citationIds: [], content }, afterId: siblings.at(-1)?.id ?? null }], current.revision);
  };
  return <div className="super-editor-controls" role="toolbar" aria-label="Document controls">
    <button type="button" onClick={() => applyResult(editor.undo(actor, editor.getSnapshot().revision))}>Undo</button>
    <button type="button" onClick={() => applyResult(editor.redo(actor, editor.getSnapshot().revision))}>Redo</button>
    <select aria-label="New block type" value={type} onChange={(event) => setType(event.target.value)}><option value="paragraph">Paragraph</option><option value="heading2">Heading 2</option><option value="heading3">Heading 3</option><option value="section">Section</option></select>
    <select aria-label="New block section" value={parent} onChange={(event) => setParent(event.target.value)}><option value="">Document</option>{report.blocks.filter((block) => block.content.type === 'section').map((block) => <option key={block.id} value={block.id}>{(block.content as Extract<BlockContent, { type: 'section' }>).title}</option>)}</select>
    <button type="button" onClick={add}>Add block</button>
    <select aria-label="Document font" value={report.format.font} onChange={(event) => { const current = editor.getSnapshot(); apply([{ type: 'setFormat', format: { ...current.format, font: event.target.value as ResearchDocument['format']['font'] } }], current.revision); }}><option value="sans">sans</option><option value="serif">serif</option><option value="mono">mono</option></select>
    <select aria-label="Page format" value={report.format.page} onChange={(event) => { const current = editor.getSnapshot(); apply([{ type: 'setFormat', format: { ...current.format, page: event.target.value as ResearchDocument['format']['page'] } }], current.revision); }}><option value="screen">screen</option><option value="A4">A4</option><option value="letter">letter</option></select>
  </div>;
}

const editorKeys = new WeakMap<Editor, number>();
let nextEditorKey = 0;

/** Draft state belongs to one editor instance, including when a host swaps the editor prop. */
export function ReportEditor(props: ReportEditorProps): ReactNode {
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
  const controls = { editor, report, actor, applyResult };
  return <div className="super-editor">
    {renderControls === false ? null : renderControls ? renderControls(controls) : <DefaultControls {...controls} />}
    {error ? <p className="super-editor-error" role="alert">{error}</p> : null}
    <ReportView {...viewProps} document={report} renderBlockActions={(block) => {
      const draft = drafts.get(block.id);
      if (!draft && editableText(block) === null) return null;
      if (!draft) return <button type="button" onClick={() => begin(block)}>Edit {block.content.type}</button>;
      return <div className="super-editor-block-edit">
        <textarea aria-label={`Edit block ${block.id}`} value={draft.text} onChange={(event) => change(block.id, event.target.value)} />
        <small>Plain text editing replaces inline formatting when text changes.</small>
        {draft.version !== block.version || draft.baseRevision !== report.revision ? <p>Document changed since this draft began (revision {draft.baseRevision}). Read current content and discard or reconcile your draft before saving.</p> : null}
        <button type="button" onClick={() => save(block, draft)}>Save block</button><button type="button" onClick={() => discard(block.id)}>Discard draft</button>
      </div>;
    }} />
    {[...drafts].filter(([id]) => !report.blocks.some((block) => block.id === id)).map(([id, draft]) => <div className="super-editor-block-edit" key={id}><p>Block {id} was deleted. Your unsaved draft is preserved.</p><textarea aria-label={`Deleted block draft ${id}`} value={draft.text} readOnly /><button type="button" onClick={() => discard(id)}>Discard draft</button></div>)}
  </div>;
}

// Rendering layer (blocks, charts, labels) and panels. Interaction components are exported by their own modules.
export * from './render/index.js';
export * from './panels/index.js';
