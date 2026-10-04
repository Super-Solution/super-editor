import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Actor, BlockContent, Editor, ResearchDocument } from '@super-solution/editor-core';
import type { InteractionOptions, Interaction } from '@super-solution/editor-ui';
import { ReportView, useEditor } from '../index.js';
import type { ReactBlockRenderer, ReactControlsContext, ReportViewProps } from '../index.js';
import { BlockSlot } from './Blocks.js';
import { InteractionProvider, useInteraction, useLabels } from './context.js';
import { useCommands, useCreateInteraction } from './hooks.js';
import { InteractiveSurface } from './InteractiveSurface.js';
import type { InteractionParts, InteractiveSurfaceProps } from './InteractiveSurface.js';
import type { InteractionLabels } from './labels.js';
import { keepFocus } from './util.js';

/** Props of `ReportEditor` that configure the interaction layer. All optional: the defaults give a Notion-style editor. */
export type InteractionProps = InteractionParts & {
  /** Set to false for the classic editor: an "Edit" button per block that opens a plain-text draft. Default true. */
  interaction?: boolean;
  readOnly?: boolean;
  labels?: Partial<InteractionLabels>;
  /** Rebind or disable shortcuts by id, for example `{ 'text.bold': ['Mod+Alt+B'], 'block.duplicate': null }`. */
  shortcuts?: InteractionOptions['shortcuts'];
  slashItems?: InteractionOptions['slashItems'];
  slashLabels?: InteractionOptions['slashLabels'];
  commitDelayMs?: number;
  linkSchemes?: InteractionOptions['linkSchemes'];
  /** Called when an edit lost a race with another writer (an agent, another tab). */
  onConflict?: InteractionOptions['onConflict'];
  /** Every outcome worth telling the user about. Supplying it hides the built-in message bar unless `feedback` is set. */
  onFeedback?: InteractionOptions['onFeedback'];
  surface?: InteractiveSurfaceProps['surface'];
};

const EDITABLE_RENDERERS = ['paragraph', 'heading', 'section', 'quote', 'callout', 'code', 'list', 'table', 'toggle'] as const;
/**
 * Block renderers that swap in the editing view for the block being edited. Host renderers still draw every other block;
 * a host `list` renderer also keeps drawing todo lists (the built-in checkbox view is skipped).
 */
export function interactiveBlockRenderers(host?: Partial<Record<BlockContent['type'], ReactBlockRenderer>>): Partial<Record<BlockContent['type'], ReactBlockRenderer>> {
  const renderers: Partial<Record<BlockContent['type'], ReactBlockRenderer>> = { ...host };
  for (const type of EDITABLE_RENDERERS) {
    const own = host?.[type];
    renderers[type] = (block, context) => <BlockSlot block={block} keepHostList={type === 'list' && !!own} view={() => own ? own(block, context) : context.renderDefaultBlock(block)} />;
  }
  return renderers;
}

/** Undo, redo, shortcut help and document font/page, through the same attributed commands as everything else. */
export function EditorControls({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit), labels = useLabels(), commands = useCommands(interaction);
  const report = useEditor(interaction.editor);
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
    editor, actor, renderControls, interaction: _enabled, readOnly, labels, shortcuts, slashItems, slashLabels, commitDelayMs, linkSchemes, onConflict, onFeedback, surface,
    gutter, hoverOutline, selectionOverlay, dropIndicator, slashMenu, formattingToolbar, selectionToolbar, blockMenu, linkEditor, shortcutHelp, chartEditor, conflictNotice, feedback,
    ...viewProps
  } = props;
  const report = useEditor(editor);
  const human = useMemo(() => ({ id: actor?.id ?? 'local-human', kind: 'human' as const }), [actor?.id]);
  const instance = useCreateInteraction(editor, {
    actor: human, readOnly: !!readOnly,
    ...(shortcuts === undefined ? {} : { shortcuts }), ...(slashItems ? { slashItems } : {}), ...(slashLabels ? { slashLabels } : {}), ...(commitDelayMs === undefined ? {} : { commitDelayMs }),
    ...(linkSchemes ? { linkSchemes } : {}), ...(onConflict ? { onConflict } : {}), ...(onFeedback ? { onFeedback } : {}),
  });
  const renderers = useMemo(() => interactiveBlockRenderers(viewProps.blockRenderers), [viewProps.blockRenderers]);
  const controls = renderControls === false ? null : renderControls
    ? renderControls({ editor, report, actor: human, applyResult: () => undefined, interaction: instance })
    : <EditorControls interaction={instance} />;
  const parts: InteractionParts = {
    ...(gutter === undefined ? {} : { gutter }), ...(hoverOutline === undefined ? {} : { hoverOutline }), ...(selectionOverlay === undefined ? {} : { selectionOverlay }), ...(dropIndicator === undefined ? {} : { dropIndicator }),
    ...(slashMenu === undefined ? {} : { slashMenu }), ...(formattingToolbar === undefined ? {} : { formattingToolbar }), ...(selectionToolbar === undefined ? {} : { selectionToolbar }),
    ...(blockMenu === undefined ? {} : { blockMenu }), ...(linkEditor === undefined ? {} : { linkEditor }), ...(shortcutHelp === undefined ? {} : { shortcutHelp }), ...(chartEditor === undefined ? {} : { chartEditor }),
    ...(conflictNotice === undefined ? {} : { conflictNotice }), feedback: feedback ?? !onFeedback,
  };
  return <InteractionProvider interaction={instance} {...(labels ? { labels } : {})}>
    <div className="super-editor se-editor" data-se-readonly={readOnly ? '' : undefined}>
      {controls}
      <InteractiveSurface interaction={instance} {...parts} {...(labels ? { labels } : {})} {...(surface ? { surface } : {})}>
        <ReportView {...viewProps} document={report} blockRenderers={renderers} />
      </InteractiveSurface>
    </div>
  </InteractionProvider>;
}
