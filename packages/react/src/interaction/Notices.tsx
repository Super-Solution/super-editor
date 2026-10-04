import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import type { BlockContent, InlineRun } from '@super-solution/editor-core';
import type { FeedbackEvent, Interaction } from '@super-solution/editor-ui';
import { useInteraction, useInteractionState, useLabels } from './context.js';

const preview = (content: BlockContent | undefined): string => {
  if (!content) return '';
  const text = 'runs' in content ? (content.runs as InlineRun[]).map((run) => run.text).join('') : content.type === 'heading' || content.type === 'code' ? content.text : content.type === 'section' || content.type === 'toggle' ? content.title : content.type === 'list' ? content.items.join(' / ') : '';
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
};
/** Shown while a block you are typing in was changed by someone else. Nothing is overwritten until you choose. */
export function ConflictNotice({ interaction: explicit }: { interaction?: Interaction }): ReactNode {
  const interaction = useInteraction(explicit), labels = useLabels();
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

/** One transient message with an optional action (for example "Undo" after a delete). Errors and conflicts are announced assertively. */
export function FeedbackBar({ interaction: explicit, durationMs = 6_000 }: { interaction?: Interaction; durationMs?: number }): ReactNode {
  const interaction = useInteraction(explicit), labels = useLabels();
  const [event, setEvent] = useState<FeedbackEvent | null>(null);
  useEffect(() => interaction.subscribeFeedback((next) => setEvent(next)), [interaction]);
  useEffect(() => {
    if (!event) return;
    const timer = setTimeout(() => setEvent(null), event.kind === 'error' || event.kind === 'conflict' ? durationMs * 2 : durationMs);
    return () => clearTimeout(timer);
  }, [event, durationMs]);
  if (!event) return null;
  const urgent = event.kind === 'error' || event.kind === 'conflict';
  return <div className={`se-feedback se-feedback-${event.kind}`} data-se-popup role={urgent ? 'alert' : 'status'} aria-live={urgent ? 'assertive' : 'polite'}>
    <span className="se-feedback-message">{event.message}</span>
    {event.action ? <button type="button" className="se-button" onClick={() => { event.action!.run(); setEvent(null); }}>{event.action.label}</button> : null}
    <button type="button" className="se-feedback-dismiss" aria-label={labels.dismiss} onClick={() => setEvent(null)}><span aria-hidden="true">{'×'}</span></button>
  </div>;
}
