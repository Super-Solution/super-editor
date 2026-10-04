import { useCallback, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Actor, Block, BlockContent, Editor, ResearchDocument } from '@super-solution/editor-core';
import type { Interaction, InteractionOptions } from '@super-solution/editor-ui';
import { ReportView } from '../render/ReportView.js';
import type { ReactBlockRenderer, ReportViewProps } from '../render/types.js';
import { useEditorDocument } from '../panels/hooks.js';
import { ToastProvider } from '../panels/Toasts.js';
import type { ReactControlsContext } from '../index.js';
import { BlockSlot } from './Blocks.js';
import { InteractionProvider, useInteraction, useInteractionLabels } from './context.js';
import { useCommands, useCreateInteraction } from './hooks.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import type { InteractionParts, InteractiveSurfaceProps } from './InteractiveSurface.js';
import type { InteractionLabels } from './labels.js';
import { FeedbackToasts } from './Notices.js';
import { keepFocus } from './util.js';

/** Props of `ReportEditor` that configure the interaction layer. All optional: the defaults give a Notion-style editor. */
export type InteractionProps = InteractionParts & {
  /** Set to false for the classic editor: an "Edit" button per block that opens a plain-text draft. Default true. */
  interaction?: boolean;
  readOnly?: boolean;
  /** Strings of the interaction components (menus, toolbars, placeholders). Rendering strings use `labels`. */
  interactionLabels?: Partial<InteractionLabels>;
  /** Rebind or disable shortcuts by id, for example `{ 'text.bold': ['Mod+Alt+B'], 'block.duplicate': null }`. */
  shortcuts?: InteractionOptions['shortcuts'];
  slashItems?: InteractionOptions['slashItems'];
  slashLabels?: InteractionOptions['slashLabels'];
  commitDelayMs?: number;
  linkSchemes?: InteractionOptions['linkSchemes'];
  /** Called when an edit lost a race with another writer (an agent, another tab). */
  onConflict?: InteractionOptions['onConflict'];
  /** Every outcome worth telling the user about. Supplying it replaces the built-in toasts, unless `feedback` is true. */
  onFeedback?: InteractionOptions['onFeedback'];
  /** The "Reload" action on a conflict toast. Omit it when the editor holds the live document. */
  onReload?: () => void;
  /** Show the built-in toasts for success, refused edits and conflicts. Default: on unless `onFeedback` is given. */
  feedback?: boolean;
  surface?: InteractiveSurfaceProps['surface'];
};

const EDITABLE_RENDERERS = ['paragraph', 'heading', 'section', 'quote', 'callout', 'code', 'list', 'table', 'toggle'] as const;
/**
 * Block renderers that swap in the editing view for the block being edited. Host renderers still draw every other block and every
 * non-editing block. Call it once (or memoize the result): the document view re-renders every block when the renderer map changes.
 */
export function interactiveBlockRenderers(host?: Partial<Record<BlockContent['type'], ReactBlockRenderer>>): Partial<Record<BlockContent['type'], ReactBlockRenderer>> {
  const renderers: Partial<Record<BlockContent['type'], ReactBlockRenderer>> = { ...host };
  for (const type of EDITABLE_RENDERERS) {
    const own = host?.[type];
    renderers[type] = (block, context) => <BlockSlot block={block} view={() => own ? own(block, context) : context.renderDefaultBlock(block)} />;
  }
  return renderers;
}

/** Undo, redo, shortcut help and document font/page, through the same attributed commands as everything else. */
export function EditorControls({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit), labels = useInteractionLabels(), commands = useCommands(interaction);
  const report = useEditorDocument(interaction.editor);
  return <div className="se-controls super-editor-controls" role="toolbar" aria-label={labels.surface}>
    <button type="button" className="se-button" onMouseDown={keepFocus} onClick={() => commands.undo()} disabled={commands.readOnly}>{labels.undo}</button>
    <button type="button" className="se-button" onMouseDown={keepFocus} onClick={() => commands.redo()} disabled={commands.readOnly}>{labels.redo}</button>
    <select aria-label={labels.documentFont} value={report.format.font} disabled={commands.readOnly} onChange={(event) => commands.setFormat({ font: event.target.value as ResearchDocument['format']['font'] })}><option value="sans">sans</option><option value="serif">serif</option><option value="mono">mono</option></select>
    <select aria-label={labels.documentPage} value={report.format.page} disabled={commands.readOnly} onChange={(event) => commands.setFormat({ page: event.target.value as ResearchDocument['format']['page'] })}><option value="screen">screen</option><option value="A4">A4</option><option value="letter">letter</option></select>
    <button type="button" className="se-button" onClick={() => interaction.toggleHelp()} aria-haspopup="dialog">{labels.help}</button>
  </div>;
}

export type InteractiveReportEditorProps = Omit<ReportViewProps, 'document' | 'renderBlockActions'> & InteractionProps & {
  editor: Editor; actor?: Actor;
  renderControls?: false | ((context: ReactControlsContext) => ReactNode);
};
/** The interaction-enabled editor: a `ReportView` inside an `InteractiveSurface`, with in-place editing of text, lists, tables and toggles. */
export function InteractiveReportEditor(props: InteractiveReportEditorProps): ReactNode {
  const {
    editor, actor, renderControls, interaction: _enabled, readOnly, interactionLabels, shortcuts, slashItems, slashLabels, commitDelayMs, linkSchemes, onConflict, onFeedback, onReload, surface,
    gutter, hoverOutline, selectionOverlay, dropIndicator, slashMenu, formattingToolbar, selectionToolbar, blockMenu, linkEditor, shortcutHelp, chartEditor, conflictNotice, feedback,
    ...viewProps
  } = props;
  const report = useEditorDocument(editor);
  const human = useMemo(() => ({ id: actor?.id ?? 'local-human', kind: 'human' as const }), [actor?.id]);
  const instance = useCreateInteraction(editor, {
    actor: human, readOnly: !!readOnly,
    ...(shortcuts === undefined ? {} : { shortcuts }), ...(slashItems ? { slashItems } : {}), ...(slashLabels ? { slashLabels } : {}), ...(commitDelayMs === undefined ? {} : { commitDelayMs }),
    ...(linkSchemes ? { linkSchemes } : {}), ...(onConflict ? { onConflict } : {}), ...(onFeedback ? { onFeedback } : {}),
  });
  // The document view memoizes every block by id and version, but re-renders all of them when these props change identity.
  // Keep them stable so editing one block never re-renders the others.
  const hostRenderers = viewProps.blockRenderers;
  const renderers = useMemo(() => interactiveBlockRenderers(hostRenderers), [hostRenderers]);
  const hostTodo = viewProps.onToggleTodo;
  const toggleTodo = useCallback((block: Block, index: number, checked: boolean) => { if (hostTodo) hostTodo(block, index, checked); else instance.commands.setChecked(block.id, index, checked); }, [hostTodo, instance]);
  const controls = renderControls === false ? null : renderControls
    ? renderControls({ editor, report, actor: human, applyResult: () => undefined, interaction: instance })
    : <EditorControls interaction={instance} />;
  const parts: InteractionParts = {
    ...(gutter === undefined ? {} : { gutter }), ...(hoverOutline === undefined ? {} : { hoverOutline }), ...(selectionOverlay === undefined ? {} : { selectionOverlay }), ...(dropIndicator === undefined ? {} : { dropIndicator }),
    ...(slashMenu === undefined ? {} : { slashMenu }), ...(formattingToolbar === undefined ? {} : { formattingToolbar }), ...(selectionToolbar === undefined ? {} : { selectionToolbar }),
    ...(blockMenu === undefined ? {} : { blockMenu }), ...(linkEditor === undefined ? {} : { linkEditor }), ...(shortcutHelp === undefined ? {} : { shortcutHelp }), ...(chartEditor === undefined ? {} : { chartEditor }),
    ...(conflictNotice === undefined ? {} : { conflictNotice }),
  };
  const toasts = feedback ?? !onFeedback;
  const content = <>
    {controls}
    <InteractiveSurface interaction={instance} {...parts} {...(interactionLabels ? { labels: interactionLabels } : {})} {...(surface ? { surface } : {})}>
      <ReportView {...viewProps} document={report} blockRenderers={renderers} onToggleTodo={toggleTodo} />
    </InteractiveSurface>
    {toasts ? <FeedbackToasts interaction={instance} {...(onReload ? { onReload } : {})} /> : null}
  </>;
  // The wrapper carries the theme attributes, so popups and toasts (siblings of the document) pick up the same tokens.
  return <InteractionProvider interaction={instance} {...(interactionLabels ? { labels: interactionLabels } : {})}>
    <div className="super-editor se-editor" data-se-readonly={readOnly ? '' : undefined} data-se-theme={viewProps.theme} data-se-density={viewProps.density}>
      {toasts ? <ToastProvider {...(viewProps.labels ? { labels: viewProps.labels } : {})}>{content}</ToastProvider> : content}
    </div>
  </InteractionProvider>;
}
