import { createDocument, createEditor, createTemplate, listTemplates, templateTitle, transaction, type Editor, type ResearchDocument, type TemplateKind } from '@super-solution/editor-core';
import { createAllBlocksExample } from '../all-blocks.js';
import { createResearchExample } from '../report.js';

/**
 * One page of the workspace. Every page has its own editor session, so switching pages is a re-render, not a reload, and each page keeps
 * its own undo history. `snapshots` remembers the document at every revision, which is what History compares and restores from.
 */
export type Doc = { id: string; name: string; kind: 'Fixture' | 'Template' | 'Empty'; editor: Editor; baseline: ResearchDocument; snapshots: Map<number, ResearchDocument> };

// The fixtures stamp fixed dates on their clock. A live clock that never runs behind the document keeps "updated 2 minutes ago" honest.
const liveClock = (floor: string) => (): string => new Date(Math.max(Date.now(), Date.parse(floor))).toISOString();

let counter = 0;
const made = new Map<string, number>();
/** "Equity analysis", then "Equity analysis 2", and so on. */
const nameFor = (base: string): string => { const nth = (made.get(base) ?? 0) + 1; made.set(base, nth); return nth === 1 ? base : `${base} ${nth}`; };

function open(seed: ResearchDocument, name: string, kind: Doc['kind']): Doc {
  const editor = createEditor(seed, { now: liveClock(seed.updatedAt) });
  const baseline = editor.getSnapshot();
  const snapshots = new Map([[baseline.revision, baseline]]);
  editor.subscribe(() => { const snapshot = editor.getSnapshot(); snapshots.set(snapshot.revision, snapshot); });
  return { id: `${seed.id}-${++counter}`, name, kind, editor, baseline, snapshots };
}

/** The two fixtures of the examples folder, opened as workspace pages. */
export const startPages = (): Doc[] => [
  open(createResearchExample().getSnapshot(), 'Research report', 'Fixture'),
  open(createAllBlocksExample().getSnapshot(), 'Every block & chart', 'Fixture'),
];

/** A page with no blocks at all, which shows the empty state. */
export const emptyPage = (): Doc => open(createDocument({ id: `page-${counter + 1}`, title: 'Untitled page' }), nameFor('Empty page'), 'Empty');

/** The report templates core ships, for the "New from template" list. */
export const TEMPLATES = listTemplates();

/** A page started from a core report template (`createTemplate`), inserted as one guarded transaction. */
export function templatePage(kind: TemplateKind): Doc {
  const draft = createEditor(createDocument({ id: `${kind}-${counter + 1}`, title: templateTitle(kind) }));
  const result = transaction(draft, { id: 'template', kind: 'system' }).insert(createTemplate(kind)).commit();
  if (!result.ok) throw new Error(`The ${kind} template did not apply: ${result.issues[0]?.message ?? 'unknown error'}`);
  return open(result.document, nameFor(templateTitle(kind)), 'Template');
}
