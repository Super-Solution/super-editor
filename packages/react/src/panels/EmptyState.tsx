import type { ReactNode } from 'react';
import type { PartialLabels } from '@super-solution/editor-ui';
import { useLabels } from '../render/context.js';

export type EmptyStateAction = { label: string; onClick: () => void; primary?: boolean };
export type EmptyStateProps = {
  title: string;
  description?: string;
  actions?: readonly EmptyStateAction[];
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
};
/** A centred "nothing here yet" message with up to a few clear next steps. */
export function EmptyState({ title, description, actions = [], icon, children, className }: EmptyStateProps): ReactNode {
  return <section className={`se-empty-state${className ? ` ${className}` : ''}`} aria-label={title}>
    {icon ? <div className="se-empty-icon" aria-hidden="true">{icon}</div> : null}
    <h2 className="se-empty-title">{title}</h2>
    {description ? <p className="se-empty-description">{description}</p> : null}
    {children}
    {actions.length ? <div className="se-empty-actions">{actions.map((action) => <button key={action.label} type="button" className="se-button" data-primary={action.primary || undefined} onClick={action.onClick}>{action.label}</button>)}</div> : null}
  </section>;
}

export type QuickStartKind = 'heading' | 'paragraph' | 'list' | 'table' | 'chart' | 'callout';
export type EmptyDocumentProps = {
  /** Called with the kind the reader picked; insert the matching block. */
  onInsert: (kind: QuickStartKind) => void;
  /** Adds a "Use a template" action. */
  onTemplate?: () => void;
  kinds?: readonly QuickStartKind[];
  labels?: PartialLabels;
  className?: string;
};
const ALL_KINDS: readonly QuickStartKind[] = ['heading', 'paragraph', 'list', 'table', 'chart', 'callout'];
/** The quick start for a document with no blocks: one button per starting block. */
export function EmptyDocumentState({ onInsert, onTemplate, kinds = ALL_KINDS, labels: override, className }: EmptyDocumentProps): ReactNode {
  const labels = useLabels(override);
  const actions: EmptyStateAction[] = kinds.map((kind, index) => ({ label: labels.empty[kind], onClick: () => onInsert(kind), primary: index === 0 }));
  if (onTemplate) actions.push({ label: labels.empty.template, onClick: onTemplate });
  return <EmptyState title={labels.empty.title} description={labels.empty.description} actions={actions} {...(className ? { className } : {})} />;
}
