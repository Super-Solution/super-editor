import type { CalloutTone } from '@super-solution/editor-core';
import { defaultChartLabels, template, type ChartLabels } from '../charts/labels.js';

/**
 * Every user-visible string in the rendering layer and the panels. Hosts pass a `labels` prop with any subset
 * (translations, product wording); everything else falls back to these English defaults.
 * Templates use `{name}` placeholders; the singular forms are used when the count is exactly 1.
 */
export type Labels = {
  chart: ChartLabels;
  document: {
    untitled: string; landmark: string; revision: string; updated: string; sources: string; blockSources: string;
    accessed: string; published: string; unsafeUrl: string; empty: string;
    announceUpdated: string; actorHuman: string; actorAgent: string; actorSystem: string;
  };
  blocks: {
    copyCode: string; copied: string; copyFailed: string; toc: string; tocEmpty: string;
    expand: string; collapse: string; todoDone: string; todoOpen: string;
    toneNames: Record<CalloutTone, string>;
    metricUp: string; metricDown: string; metricFlat: string;
    imageBroken: string; pageBreak: string; embedOpen: string; embedBlocked: string; embedTitle: string;
    renderError: string; retry: string; language: string; loadingBlock: string; footnote: string;
  };
  outline: { title: string; empty: string; navigation: string; current: string; collapse: string; expand: string };
  find: {
    title: string; find: string; replace: string; replaceOne: string; replaceAll: string; next: string; previous: string; close: string;
    caseSensitive: string; matches: string; matchesOne: string; noMatches: string; position: string; replacedOne: string; replaced: string;
    conflict: string; readOnly: string; empty: string; showReplace: string; hideReplace: string;
  };
  status: {
    region: string; word: string; words: string; readingTime: string; readingShort: string; block: string; blocks: string;
    chart: string; charts: string; revision: string;
  };
  save: { saved: string; savedAt: string; saving: string; unsaved: string; error: string; offline: string; conflict: string; retry: string; justNow: string };
  toasts: { region: string; dismiss: string; conflictTitle: string; conflictBody: string; reload: string; success: string; error: string; info: string; warning: string; undo: string };
  history: {
    title: string; empty: string; current: string; restore: string; compare: string; selected: string; revision: string;
    human: string; agent: string; system: string; diffSummary: string; diffNone: string; list: string; at: string;
  };
  empty: {
    title: string; description: string; startWith: string;
    heading: string; paragraph: string; list: string; table: string; chart: string; callout: string; template: string;
  };
  header: { titleLabel: string; titlePlaceholder: string; edit: string; revision: string; updated: string; by: string };
  skeleton: { loading: string };
  citation: { open: string; accessed: string; published: string; source: string };
};

export const defaultLabels: Labels = {
  chart: defaultChartLabels,
  document: {
    untitled: 'Untitled document', landmark: 'Report', revision: 'Revision {revision}', updated: 'Updated', sources: 'Sources',
    blockSources: 'Sources: {list}', accessed: 'Accessed', published: 'Published', unsafeUrl: '(unsafe URL omitted)', empty: 'This document is empty.',
    announceUpdated: 'Document updated to revision {revision} by {actor}.', actorHuman: 'a person', actorAgent: 'an agent', actorSystem: 'the system',
  },
  blocks: {
    copyCode: 'Copy', copied: 'Copied', copyFailed: 'Copy failed', toc: 'Table of contents', tocEmpty: 'No headings yet.',
    expand: 'Expand {title}', collapse: 'Collapse {title}', todoDone: 'Completed', todoOpen: 'Not completed',
    toneNames: { info: 'Info', success: 'Success', warning: 'Warning', danger: 'Danger', note: 'Note' },
    metricUp: 'Up', metricDown: 'Down', metricFlat: 'Unchanged',
    imageBroken: 'This image could not be loaded.', pageBreak: 'Page break', embedOpen: 'Open {title}',
    embedBlocked: 'The interactive view is not enabled for this document. Open it in a new tab instead.', embedTitle: 'Interactive chart',
    renderError: 'This block could not be displayed.', retry: 'Try again', language: 'Language: {language}', loadingBlock: 'Loading…', footnote: 'Source {number}',
  },
  outline: { title: 'Outline', empty: 'Add a heading to build an outline.', navigation: 'Document outline', current: 'Current section', collapse: 'Collapse outline', expand: 'Expand outline' },
  find: {
    title: 'Find and replace', find: 'Find', replace: 'Replace with', replaceOne: 'Replace', replaceAll: 'Replace all', next: 'Next match', previous: 'Previous match', close: 'Close',
    caseSensitive: 'Match case', matches: '{count} matches in {blocks} blocks', matchesOne: '1 match in 1 block', noMatches: 'No matches', position: 'Block {current} of {total}',
    replacedOne: 'Replaced 1 occurrence.', replaced: 'Replaced {count} occurrences.', conflict: 'The document changed while replacing. Search again and retry.',
    readOnly: 'This document is read-only.', empty: 'Type to search the document.', showReplace: 'Show replace', hideReplace: 'Hide replace',
  },
  status: {
    region: 'Document status', word: '{count} word', words: '{count} words', readingTime: '{minutes} min read', readingShort: '< 1 min read',
    block: '{count} block', blocks: '{count} blocks', chart: '{count} chart', charts: '{count} charts', revision: 'Revision {revision}',
  },
  save: { saved: 'Saved', savedAt: 'Saved {time}', saving: 'Saving…', unsaved: 'Unsaved changes', error: 'Save failed', offline: 'Offline', conflict: 'Conflict', retry: 'Retry', justNow: 'just now' },
  toasts: {
    region: 'Notifications', dismiss: 'Dismiss', conflictTitle: 'This document changed', conflictBody: 'Someone else saved a newer version. Reload to continue from it.',
    reload: 'Reload', success: 'Success', error: 'Error', info: 'Notice', warning: 'Warning', undo: 'Undo',
  },
  history: {
    title: 'Revision history', empty: 'No revisions yet.', current: 'Current', restore: 'Restore this version', compare: 'Compare with current', selected: 'Selected',
    revision: 'Revision {revision}', human: 'You', agent: 'Agent', system: 'System', diffSummary: '{added} added, {changed} changed, {removed} removed, {moved} moved',
    diffNone: 'No differences from the current version.', list: 'Revisions', at: '{time}',
  },
  empty: {
    title: 'Start your report', description: 'Add a first block, or ask an agent to draft it.', startWith: 'Start with',
    heading: 'Heading', paragraph: 'Paragraph', list: 'List', table: 'Table', chart: 'Chart', callout: 'Callout', template: 'Use a template',
  },
  header: { titleLabel: 'Document title', titlePlaceholder: 'Untitled document', edit: 'Rename document', revision: 'Revision {revision}', updated: 'Updated {time}', by: 'by {actor}' },
  skeleton: { loading: 'Loading…' },
  citation: { open: 'Open source', accessed: 'Accessed', published: 'Published', source: 'Source' },
};

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K] };
export type PartialLabels = DeepPartial<Labels>;

function merge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object') return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined || !Object.hasOwn(out, key)) continue;
    const current = out[key];
    out[key] = current && typeof current === 'object' && !Array.isArray(current) ? merge(current, value) : value;
  }
  return out as T;
}
const cache = new WeakMap<object, Labels>();
/** Deep-merges a partial `labels` prop over the defaults. The result is memoized per input object. */
export function resolveLabels(partial?: PartialLabels): Labels {
  if (!partial) return defaultLabels;
  const hit = cache.get(partial);
  if (hit) return hit;
  const resolved = merge(defaultLabels, partial);
  cache.set(partial, resolved);
  return resolved;
}

export { template };
export function plural(count: number, one: string, other: string, extra: Record<string, string | number> = {}): string {
  return template(count === 1 ? one : other, { count, ...extra });
}
