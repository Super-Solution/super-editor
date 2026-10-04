import type { ReactNode } from 'react';
import type { PartialLabels } from '@super-solution/editor-ui';
import { template } from '@super-solution/editor-ui';
import { useLabels } from '../render/context.js';
import { absoluteTime, relativeTime, useNow } from './hooks.js';

export type SaveState = 'saved' | 'saving' | 'unsaved' | 'error' | 'offline' | 'conflict';
export type SaveIndicatorProps = {
  state: SaveState;
  /** When the last save finished; shown as "Saved 2 minutes ago". */
  savedAt?: string | number | Date;
  /** Shows a Retry button for `error` and `offline`. */
  onRetry?: () => void;
  /** Fixed clock for tests and server rendering. */
  now?: number;
  locale?: string;
  labels?: PartialLabels;
  className?: string;
};

/** Where the document stands with the server: saved, saving, unsaved, failed, offline or in conflict. A polite live region. */
export function SaveIndicator({ state, savedAt, onRetry, now: fixedNow, locale, labels: override, className }: SaveIndicatorProps): ReactNode {
  const labels = useLabels(override);
  const ticking = useNow(fixedNow === undefined && state === 'saved' && savedAt !== undefined);
  const now = fixedNow ?? ticking;
  const when = savedAt !== undefined ? relativeTime(savedAt, now, labels.save.justNow, locale) : '';
  const text = state === 'saved' ? (when ? template(labels.save.savedAt, { time: when }) : labels.save.saved)
    : state === 'saving' ? labels.save.saving : state === 'unsaved' ? labels.save.unsaved : state === 'error' ? labels.save.error : state === 'offline' ? labels.save.offline : labels.save.conflict;
  return <span className={`se-save${className ? ` ${className}` : ''}`} data-state={state} role="status" aria-live="polite" title={savedAt !== undefined ? absoluteTime(savedAt, locale) : undefined}>
    <span className="se-save-dot" aria-hidden="true" />
    <span className="se-save-text">{text}</span>
    {onRetry && (state === 'error' || state === 'offline') ? <button type="button" className="se-link-button" onClick={onRetry}>{labels.save.retry}</button> : null}
  </span>;
}
