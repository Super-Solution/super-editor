import type { Actor, Block, BlockContent, Editor, ResearchDocument, ApplyResult, Operation } from '@super-solution/editor-core';
import { contentWithText, editableText, localId } from './presentation.js';
import { renderDocument } from './render/document.js';
import { element } from './render/dom.js';
import type { RenderOptions } from './render/types.js';

export type ControlsContext = { editor: Editor; report: ResearchDocument; document: Document; applyResult(result: ApplyResult): void };
export type MountOptions = RenderOptions & { actor?: Actor; controls?: false | ((context: ControlsContext) => HTMLElement) };

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

export { getChartModel, contentWithText, editableText, localId, type ChartModel, type ChartShape } from './presentation.js';
export * from './render/index.js';
export * from './charts/index.js';
