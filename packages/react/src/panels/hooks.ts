import { useEffect, useState, useSyncExternalStore } from 'react';
import type { Editor, ResearchDocument } from '@super-solution/editor-core';

/** The editor's current document, re-rendering on every committed revision. */
export function useEditorDocument(editor: Editor): ResearchDocument {
  return useSyncExternalStore(editor.subscribe, editor.getSnapshot, editor.getSnapshot);
}

/** A clock that ticks every `interval` ms while `active`, so relative times ("2 min ago") stay fresh. */
export function useNow(active = true, interval = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [active, interval]);
  return now;
}

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['week', 604_800], ['day', 86_400], ['hour', 3_600], ['minute', 60]];
/** "2 minutes ago" / "in 3 days" for an ISO string or timestamp. Under a minute returns `justNow`. */
export function relativeTime(at: string | number | Date, now: number, justNow: string, locale?: string): string {
  const time = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.round((time - now) / 1000);
  if (Math.abs(seconds) < 60) return justNow;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of UNITS) if (Math.abs(seconds) >= size) return formatter.format(Math.trunc(seconds / size), unit);
  return justNow;
}
/** Absolute local time for tooltips. */
export function absoluteTime(at: string | number | Date, locale?: string): string {
  const date = at instanceof Date ? at : new Date(at);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
}
