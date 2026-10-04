import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ResearchDocument } from '@super-solution/editor-core';
import { outlineEntries, revealBlock } from '@super-solution/editor-ui';
import type { OutlineEntry, PartialLabels } from '@super-solution/editor-ui';
import { useLabels } from '../render/context.js';

/**
 * The id of the last outline heading whose top has scrolled past `offset` px from the top of the scroll area
 * (the viewport, or `root`). Updates on scroll and resize with one animation frame of throttling.
 */
export function useActiveHeading(ids: readonly string[], options: { root?: HTMLElement | null; offset?: number; enabled?: boolean } = {}): string | null {
  const { root, offset = 96, enabled = true } = options;
  const [active, setActive] = useState<string | null>(null);
  const key = ids.join('\n');
  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || !ids.length) { setActive(null); return; }
    const scope: Document | HTMLElement = root ?? document;
    let frame = 0;
    const compute = (): void => {
      frame = 0;
      const top = root ? root.getBoundingClientRect().top : 0;
      let current: string | null = null;
      for (const id of ids) {
        const node = (root ?? document).querySelector<HTMLElement>(`[data-block-id="${id}"]`);
        if (!node) continue;
        if (node.getBoundingClientRect().top - top <= offset) current = id; else break;
      }
      setActive(current ?? ids[0] ?? null);
    };
    const schedule = (): void => { if (!frame) frame = requestAnimationFrame(compute); };
    const target: EventTarget = root ?? window;
    target.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    compute();
    return () => { target.removeEventListener('scroll', schedule); window.removeEventListener('resize', schedule); if (frame) cancelAnimationFrame(frame); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, root, offset, enabled]);
  return active;
}

export type OutlineProps = {
  document: ResearchDocument;
  /** Highlights this entry. Omit to follow the scroll position automatically. */
  activeId?: string | null;
  /** Called after navigating (scrolling and focusing) to an entry. */
  onNavigate?: (id: string) => void;
  /** Deepest nesting to show. Default 3. */
  maxDepth?: number;
  /** Scroll container to track when it is not the page. */
  scrollRoot?: HTMLElement | null;
  /** Document or element that contains the rendered blocks. Default: the page. */
  contentRoot?: ParentNode | null;
  labels?: PartialLabels;
  className?: string;
};

/** A navigable outline of sections and headings. The current section follows scrolling; Enter on a link jumps and focuses the block. */
export function Outline({ document: report, activeId, onNavigate, maxDepth = 3, scrollRoot, contentRoot, labels: override, className }: OutlineProps): ReactNode {
  const labels = useLabels(override);
  const entries = useMemo<OutlineEntry[]>(() => outlineEntries(report).filter((entry) => entry.depth < maxDepth), [report, maxDepth]);
  const tracked = useActiveHeading(entries.map((entry) => entry.id), { root: scrollRoot ?? null, enabled: activeId === undefined });
  const current = activeId === undefined ? tracked : activeId;
  return <nav className={`se-panel se-outline${className ? ` ${className}` : ''}`} aria-label={labels.outline.navigation}>
    <h2 className="se-panel-title">{labels.outline.title}</h2>
    {entries.length === 0 ? <p className="se-panel-empty">{labels.outline.empty}</p> : <ol className="se-outline-list">
      {entries.map((entry) => <li key={entry.id} className="se-outline-item" data-depth={entry.depth} data-type={entry.type} data-active={entry.id === current || undefined}>
        <a href={`#${entry.id}`} aria-current={entry.id === current ? 'location' : undefined} style={{ paddingLeft: `${.6 + entry.depth * .9}rem` }}
          onClick={(event) => {
            const root = contentRoot ?? event.currentTarget.ownerDocument;
            if (revealBlock(root, entry.id)) event.preventDefault();
            onNavigate?.(entry.id);
          }}>{entry.title || '—'}</a>
      </li>)}
    </ol>}
  </nav>;
}
