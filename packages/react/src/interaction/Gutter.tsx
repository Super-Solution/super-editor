import type { ReactNode } from 'react';
import { blockRoots, indicatorFor } from '@super-solution/editor-ui';
import type { Interaction } from '@super-solution/editor-ui';
import { useBlockRect, useCoarsePointer, useDocumentRevision, useInteraction, useInteractionState, useInteractionLabels, useSurface } from './context.js';
import { keepFocus } from './util.js';

/** The "+" and drag handle that appear beside the hovered block (or the block being edited on touch devices). */
export type BlockGutterProps = { interaction?: Interaction; /** Pin the gutter to one block instead of following hover. */ blockId?: string | null; /** Space reserved left of the block, in px. Default 56. */ width?: number };
export function BlockGutter(props: BlockGutterProps): ReactNode {
  const interaction = useInteraction(props.interaction), labels = useInteractionLabels(), coarse = useCoarsePointer();
  const hover = useInteractionState(interaction, (state) => state.hover);
  const editing = useInteractionState(interaction, (state) => state.editing?.blockId ?? null);
  const anchor = useInteractionState(interaction, (state) => state.menu?.anchorId ?? null);
  const busy = useInteractionState(interaction, (state) => state.drag !== null || state.readOnly);
  const id = props.blockId ?? anchor ?? hover ?? (coarse ? editing : null);
  useDocumentRevision(interaction);
  const rect = useBlockRect(!busy ? id : null);
  if (!rect || !id) return null;
  const width = props.width ?? 56;
  return <div className="se-gutter" data-se-gutter role="group" aria-label={labels.blockMenu} style={{ left: Math.max(0, rect.left - width + 8), top: rect.top + 2 }}>
    <button type="button" className="se-gutter-button se-gutter-add" data-se-add data-se-block-id={id} aria-label={labels.addBlock} title={labels.addBlock} onMouseDown={keepFocus}
      onClick={() => interaction.slash.openAfter(id)}><span aria-hidden="true">+</span></button>
    <button type="button" className="se-gutter-button se-gutter-handle" data-se-drag-handle data-se-block-id={id} aria-label={labels.dragHandle} title={labels.dragHandle}
      aria-haspopup="menu" aria-expanded={anchor === id} onMouseDown={keepFocus}
      // A pointer click is handled by the surface (it can tell a click from a drag); this is the keyboard / assistive-technology path.
      onClick={(event) => { if (event.detail === 0) interaction.menu.open([id], id); }}><span aria-hidden="true">{'⋮⋮'}</span></button>
  </div>;
}

/** Outline around the hovered block. A section or toggle outlines everything it contains. */
export function BlockOutline({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit);
  const hover = useInteractionState(interaction, (state) => state.hover);
  const editing = useInteractionState(interaction, (state) => state.editing?.blockId ?? null);
  const busy = useInteractionState(interaction, (state) => state.drag !== null || state.readOnly);
  useDocumentRevision(interaction);
  const rect = useBlockRect(!busy && hover && hover !== editing ? hover : null);
  if (!rect) return null;
  return <div className="se-outline" aria-hidden="true" style={{ left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }} />;
}

function SelectedRect({ id }: { id: string }): ReactNode {
  const rect = useBlockRect(id);
  if (!rect) return null;
  return <div className="se-selected" aria-hidden="true" data-se-selected={id} style={{ left: rect.left, top: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top }} />;
}
/** Highlights every selected block. Descendants of a selected container are covered by the container's own highlight. */
export function SelectionOverlay({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit);
  const ids = useInteractionState(interaction, (state) => state.selection.ids, (a, b) => a === b);
  useDocumentRevision(interaction);
  const roots = blockRoots(interaction.editor.getSnapshot(), ids);
  return <>{roots.map((id) => <SelectedRect key={id} id={id} />)}</>;
}

/** The line (or inset line) showing where dragged blocks will land. */
export function DropIndicator({ interaction: explicit, indent }: { interaction?: Interaction; indent?: number }): ReactNode {
  const interaction = useInteraction(explicit), binding = useSurface();
  const drag = useInteractionState(interaction, (state) => state.drag);
  useDocumentRevision(interaction);
  if (!drag?.target || !binding) return null;
  const line = indicatorFor(binding.layout(), drag.target, { expandLeft: 56, ...(indent === undefined ? {} : { indent }) }, drag.ids);
  if (!line) return null;
  return <div className={`se-drop-indicator${line.inside ? ' se-drop-inside' : ''}`} aria-hidden="true" data-se-drop-position={drag.target.position} style={{ left: line.left, top: line.top, width: line.width }} />;
}
