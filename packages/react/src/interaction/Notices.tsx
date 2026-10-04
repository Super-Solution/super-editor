import { useEffect } from 'react';
import type { ReactNode } from 'react';
import type { BlockContent, InlineRun } from '@super-solution/editor-core';
import type { FeedbackEvent, Interaction } from '@super-solution/editor-ui';
import { useLabels } from '../render/context.js';
import { toastFromApplyResult, useToasts } from '../panels/Toasts.js';
import type { ToastInput } from '../panels/Toasts.js';
import { useInteraction, useInteractionState, useInteractionLabels } from './context.js';

const preview = (content: BlockContent | undefined): string => {
  if (!content) return '';
  const text = 'runs' in content ? (content.runs as InlineRun[]).map((run) => run.text).join('') : content.type === 'heading' || content.type === 'code' ? content.text : content.type === 'section' || content.type === 'toggle' ? content.title : content.type === 'list' ? content.items.join(' / ') : '';
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
};
/** Shown while a block you are typing in was changed by someone else. Nothing is overwritten until you choose. */
export function ConflictNotice({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit), labels = useInteractionLabels();
  const conflicts = useInteractionState(interaction, (state) => state.conflicts);
  const entries = Object.entries(conflicts);
  if (!entries.length) return null;
  return <div className="se-conflicts" data-se-popup>
    {entries.map(([blockId, info]) => <div key={blockId} className="se-conflict" role="alert" data-se-conflict={blockId}>
      <div className="se-conflict-text"><strong>{labels.conflictTitle}</strong>{info.theirs ? <span className="se-conflict-preview">{preview(info.theirs)}</span> : null}</div>
      <div className="se-popup-actions">
        <button type="button" className="se-button se-button-primary" onClick={() => interaction.edit.resolveConflict(blockId, 'mine')}>{labels.conflictKeepMine}</button>
        <button type="button" className="se-button" onClick={() => interaction.edit.resolveConflict(blockId, 'theirs')}>{labels.conflictUseLatest}</button>
      </div>
    </div>)}
  </div>;
}

/**
 * Turns an interaction feedback event into a toast for the toast system of the rendering layer (`ToastProvider`).
 * A refused edit goes through `toastFromApplyResult`, so conflicts and errors read the same everywhere.
 */
export function feedbackToToast(event: FeedbackEvent, labels?: Parameters<typeof toastFromApplyResult>[1], options: { onReload?: (() => void) | undefined } = {}): ToastInput {
  if (event.result) {
    const toast = toastFromApplyResult(event.result, labels, options);
    if (toast) return event.kind === 'conflict' || toast.tone === 'conflict' ? { ...toast, message: event.message } : toast;
  }
  return {
    tone: event.kind === 'conflict' ? 'conflict' : event.kind,
    message: event.message,
    ...(event.kind === 'conflict' ? { key: 'conflict' } : {}),
    ...(event.action ? { action: { label: event.action.label, onClick: event.action.run } } : {}),
  };
}
/** Forwards every feedback event of the interaction to the nearest `ToastProvider` (success with Undo, refused edits, conflicts). */
export function FeedbackToasts({ interaction: explicit, onReload }: { interaction?: Interaction; onReload?: () => void }): ReactNode {
  const interaction = useInteraction(explicit), toasts = useToasts(), labels = useLabels();
  useEffect(() => interaction.subscribeFeedback((event) => { toasts.show(feedbackToToast(event, labels, { onReload })); }), [interaction, toasts.show, labels, onReload]);
  return null;
}
