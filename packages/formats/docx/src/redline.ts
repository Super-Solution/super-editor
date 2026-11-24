// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import {
  checkDocument, diffDocuments, reviewProposal, withHints,
  type Actor, type Block, type EditorIssue, type ExportResult, type FormatWarning, type InlineRun, type ResearchDocument,
} from '@supersolutions/super-editor-core';
import { escapeXmlAttribute, xmlText } from '@supersolutions/super-editor-opc';
import { optionIssues, type DocxOptions } from './options.js';
import { STYLE } from './parts.js';
import { assemble, inline, paragraph, renderBlock, sourceEntry, sourcesHeading, textRuns, type Context, type RunProps } from './export.js';

/**
 * Options of a redline: everything a plain export takes, and who and when the tracked changes say they were made by.
 */
export type DocxRedlineOptions = DocxOptions & {
  /** The name Word shows for every change. Default: the proposal's actor id, or "Super Editor". */
  changeAuthor?: string;
  /** When the changes were made (ISO 8601). Default: the new document's `updatedAt`, so the same input gives the same bytes. */
  changeDate?: string;
  /** Ask Word to keep tracking edits made to the file afterwards. Default true. */
  trackChanges?: boolean;
};
/** The document before, the document after, and who made the change (for the author shown in Word). */
export type RedlineInput = { before: ResearchDocument; after: ResearchDocument; actor?: Actor };

/** Every warning a redline can add to the ones every Word export has, with the hint it carries. Lets a host show the limits before exporting. */
export const REDLINE_LIMITS = {
  'redline-block-replaced': 'Only paragraphs, headings, sections, quotes, callouts and toggles show word-level changes. For other blocks, read the struck-through old block against the inserted new one.',
  'redline-move-not-tracked': 'Word cannot show a move of one block as a tracked change here. Compare the order of the sections with the previous version.',
  'redline-format-not-tracked': 'The file uses the new format. Check the previous version if the format matters.',
  'redline-no-changes': 'Check that the right two versions were compared.',
} as const;

const EXTRA = ['changeAuthor', 'changeDate', 'trackChanges'];
const issue = (path: string, message: string, hint: string): EditorIssue => ({ code: 'validation', path, message, hint });
const refuse = (issues: EditorIssue[]): ExportResult => ({ ok: false, issues: withHints(issues) });

function redlineOptionIssues(options: unknown): EditorIssue[] {
  const out = optionIssues(options, EXTRA);
  if (typeof options !== 'object' || options === null || Array.isArray(options)) return out;
  const given = options as Record<string, unknown>;
  if ('changeAuthor' in given && (typeof given.changeAuthor !== 'string' || given.changeAuthor === '' || given.changeAuthor.length > 200)) out.push(issue('options.changeAuthor', 'Expected a nonempty string of at most 200 characters.', 'Use the name a reviewer should see, for example "research-agent".'));
  if ('changeDate' in given && (typeof given.changeDate !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(given.changeDate) || !Number.isFinite(Date.parse(given.changeDate)))) out.push(issue('options.changeDate', 'Expected an ISO 8601 date and time, for example "2026-11-24T10:00:00Z".', 'Omit it to use the new document\'s updatedAt.'));
  if ('trackChanges' in given && typeof given.trackChanges !== 'boolean') out.push(issue('options.trackChanges', 'Expected true or false.', 'Pass a boolean or omit it.'));
  return out;
}

// ---- words ---------------------------------------------------------------------------------------------------------

type Props = Omit<InlineRun, 'text'>;
type Atom = { text: string; props: Props };
type Step = { status: 'same' | 'ins' | 'del'; atom: Atom };

/** Words, white space, single punctuation marks, and single CJK characters (which have no spaces between words). */
const TOKEN = /\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const MAX_CELLS = 4_000_000;

function atoms(runs: readonly InlineRun[]): Atom[] {
  const out: Atom[] = [];
  for (const run of runs) {
    const { text, citationId, ...style } = run;
    for (const part of text.match(TOKEN) ?? []) out.push({ text: part, props: style });
    if (citationId !== undefined) out.push({ text: '', props: { ...style, citationId } });
  }
  return out;
}
const key = (atom: Atom): string => JSON.stringify([atom.text, atom.props.bold === true, atom.props.italic === true, atom.props.code === true, atom.props.href ?? null, atom.props.strike === true, atom.props.underline === true, atom.props.highlight ?? null, atom.props.citationId ?? null]);

/** The steps that turn `a` into `b`, deletions before insertions in each gap. `undefined` when the texts are too long to compare. */
function compare(a: readonly Atom[], b: readonly Atom[]): Step[] | undefined {
  const x = a.map(key), y = b.map(key);
  let start = 0;
  while (start < x.length && start < y.length && x[start] === y[start]) start++;
  let endX = x.length, endY = y.length;
  while (endX > start && endY > start && x[endX - 1] === y[endY - 1]) { endX--; endY--; }
  const n = endX - start, m = endY - start;
  if (n * m > MAX_CELLS) return undefined;
  const width = m + 1, table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) table[i * width + j] = x[start + i] === y[start + j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const steps: Step[] = [];
  for (let i = 0; i < start; i++) steps.push({ status: 'same', atom: b[i]! });
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[start + i] === y[start + j]) { steps.push({ status: 'same', atom: b[start + j]! }); i++; j++; }
    else if (j >= m || (i < n && table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) { steps.push({ status: 'del', atom: a[start + i]! }); i++; }
    else { steps.push({ status: 'ins', atom: b[start + j]! }); j++; }
  }
  for (let k = endY; k < b.length; k++) steps.push({ status: 'same', atom: b[k]! });
  // Within a gap, every deletion comes before the insertions that replace it.
  const ordered: Step[] = [];
  for (let k = 0; k < steps.length;) {
    if (steps[k]!.status === 'same') { ordered.push(steps[k++]!); continue; }
    const gap: Step[] = [];
    while (k < steps.length && steps[k]!.status !== 'same') gap.push(steps[k++]!);
    ordered.push(...gap.filter(step => step.status === 'del'), ...gap.filter(step => step.status === 'ins'));
  }
  return ordered;
}

/** Atoms of one status back into runs: neighbours with the same formatting are one run again. */
function toRuns(list: readonly Atom[]): InlineRun[] {
  const runs: InlineRun[] = [];
  for (const atom of list) {
    const last = runs[runs.length - 1];
    if (last && last.citationId === undefined && atom.props.citationId === undefined && JSON.stringify({ ...last, text: '' }) === JSON.stringify({ ...atom.props, text: '' })) last.text += atom.text;
    else runs.push({ ...atom.props, text: atom.text } as InlineRun);
  }
  return runs;
}

// ---- tracked-change XML --------------------------------------------------------------------------------------------

type Kind = 'ins' | 'del';
const RUN = /<w:r>(?:(?!<\/w:r>)[\s\S])*<\/w:r>/g;
const PARAGRAPH = /<w:p>(?:<w:pPr>((?:(?!<\/w:pPr>)[\s\S])*)<\/w:pPr>)?/g;

/** Marks XML that this package wrote (runs, paragraph marks and table rows) as inserted or deleted. Every mark gets its own id. */
function marks(author: string, date: string): { runs(xml: string, kind: Kind): string; block(xml: string, kind: Kind): string } {
  let id = 0;
  const attributes = (): string => `w:id="${++id}" w:author="${author}" w:date="${date}"`;
  const runs = (xml: string, kind: Kind): string => xml.replace(RUN, run => kind === 'ins'
    ? `<w:ins ${attributes()}>${run}</w:ins>`
    : `<w:del ${attributes()}>${run.replace(/<w:t(?=[ >])/g, '<w:delText').replace(/<\/w:t>/g, '</w:delText>')}</w:del>`);
  return {
    runs,
    block: (xml, kind) => runs(xml
      .replace(PARAGRAPH, (_, properties: string | undefined) => `<w:p><w:pPr>${properties ?? ''}<w:rPr><w:${kind} ${attributes()}/></w:rPr></w:pPr>`)
      .replace(/<\/w:trPr>/g, () => `<w:${kind} ${attributes()}/></w:trPr>`), kind),
  };
}

// ---- the merged document -------------------------------------------------------------------------------------------

type Status = { kind: 'ins' } | { kind: 'del' } | { kind: 'replace'; before: Block } | { kind: 'words' };

/** Blocks whose words can be compared one by one: the text, and the rest of the block that must be unchanged. */
function textOf(block: Block): { runs: InlineRun[]; rest: string } | undefined {
  const content = block.content;
  switch (content.type) {
    case 'paragraph': case 'quote': case 'callout': { const { runs, ...rest } = content; return { runs, rest: JSON.stringify([rest, block.citationIds]) }; }
    case 'heading': { const { text, ...rest } = content; return { runs: [{ text }], rest: JSON.stringify([rest, block.citationIds]) }; }
    case 'section': case 'toggle': { const { title, ...rest } = content; return { runs: [{ text: title }], rest: JSON.stringify([rest, block.citationIds]) }; }
    default: return undefined;
  }
}

/** The new blocks, with each removed block put back after the sibling it followed (or before the one it preceded, or under its parent). */
function mergeBlocks(before: ResearchDocument, after: ResearchDocument, removed: ReadonlySet<string>): Block[] {
  const result = [...after.blocks];
  const present = new Set(result.map(block => block.id));
  for (const block of before.blocks) {
    if (!removed.has(block.id)) continue;
    const siblings = before.blocks.filter(candidate => candidate.parentId === block.parentId), at = siblings.indexOf(block);
    const previous = siblings.slice(0, at).reverse().find(candidate => present.has(candidate.id)), next = siblings.slice(at + 1).find(candidate => present.has(candidate.id));
    let index: number;
    if (previous) index = result.findIndex(candidate => candidate.id === previous.id) + 1;
    else if (next) index = result.findIndex(candidate => candidate.id === next.id);
    else if (block.parentId !== null) index = result.findIndex(candidate => candidate.id === block.parentId) + 1;
    else index = 0;
    result.splice(Math.max(0, index), 0, block); present.add(block.id);
  }
  return result;
}

/**
 * A Word file that shows how `after` differs from `before` as tracked changes: new blocks inserted, removed blocks deleted, edited text
 * changed word by word, a new title and new or removed sources marked. Accepting every change gives the new document; rejecting every
 * change gives the old one. Always resolves; problems are `issues`, what cannot be shown is a `warning`.
 *
 * Text blocks (paragraph, heading, section, quote, callout, toggle) show their word-level changes. Any other block that changed (a
 * table, a list, a chart, ...) is shown as the old block deleted and the new one inserted, with a `redline-block-replaced` warning.
 * Moves and page-format changes are not tracked (warnings say so).
 */
export async function exportDocxRedline(input: RedlineInput, options?: DocxRedlineOptions): Promise<ExportResult> {
  const bad = redlineOptionIssues(options);
  if (bad.length) return refuse(bad);
  const first = checkDocument(input?.before), second = checkDocument(input?.after);
  if (!first.ok || !second.ok) return refuse([...(first.ok ? [] : first.issues.map(entry => ({ ...entry, path: `before.${entry.path}` }))), ...(second.ok ? [] : second.issues.map(entry => ({ ...entry, path: `after.${entry.path}` })))]);
  const before = first.document, after = second.document;
  if (before.id !== after.id) return refuse([issue('after.id', `The two documents are different documents ("${before.id}" and "${after.id}").`, 'Compare two versions of the same document.')]);
  const opts: DocxRedlineOptions = options ?? {};
  const authorName = opts.changeAuthor ?? input.actor?.id ?? 'Super Editor';
  const date = new Date(opts.changeDate ?? after.updatedAt).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const marker = marks(escapeXmlAttribute(xmlText(authorName).text), date);

  const diff = diffDocuments(before, after);
  const beforeBlocks = new Map(before.blocks.map(block => [block.id, block])), afterBlocks = new Map(after.blocks.map(block => [block.id, block]));
  const removedCitations = before.citations.filter(citation => diff.citations.removed.includes(citation.id));
  const merged: ResearchDocument = { ...after, blocks: mergeBlocks(before, after, new Set(diff.removed)), citations: [...after.citations, ...removedCitations] };

  const status = new Map<string, Status>(), words = new Map<string, Step[]>();
  for (const id of diff.added) status.set(id, { kind: 'ins' });
  for (const id of diff.removed) status.set(id, { kind: 'del' });
  const tooLong: string[] = [];
  for (const id of diff.changed) {
    const old = beforeBlocks.get(id)!, now = afterBlocks.get(id)!, oldText = textOf(old), newText = textOf(now);
    if (oldText && newText && old.content.type === now.content.type && oldText.rest === newText.rest) {
      const steps = compare(atoms(oldText.runs), atoms(newText.runs));
      if (!steps) { tooLong.push(id); status.set(id, { kind: 'replace', before: old }); continue; }
      if (steps.some(step => step.status !== 'same')) { words.set(id, steps); status.set(id, { kind: 'words' }); }
      continue;
    }
    status.set(id, { kind: 'replace', before: old });
  }

  const wordsXml = (ctx: Context, steps: readonly Step[], base: RunProps): string => {
    let out = '';
    for (let k = 0; k < steps.length;) {
      const kind = steps[k]!.status, group: Atom[] = [];
      while (k < steps.length && steps[k]!.status === kind) group.push(steps[k++]!.atom);
      const xml = inline(ctx, toRuns(group), base);
      out += kind === 'same' ? xml : marker.runs(xml, kind);
    }
    return out;
  };

  const plan = {
    trackRevisions: opts.trackChanges !== false,
    prepare(ctx: Context): void {
      ctx.merge = new Map();
      for (const [id, steps] of words) ctx.merge.set(id, base => wordsXml(ctx, steps, base));
      ctx.revise = (block, render) => {
        const entry = status.get(block.id);
        if (!entry || entry.kind === 'words') return render();
        if (entry.kind === 'ins') return marker.block(render(), 'ins');
        if (entry.kind === 'del') return marker.block(render(), 'del');
        return marker.block(render(entry.before), 'del') + marker.block(render(), 'ins');
      };
    },
    body(ctx: Context): string[] {
      const body: string[] = [];
      if (opts.title !== false && (after.title || before.title)) {
        if (diff.titleChanged) {
          const steps = compare(atoms([{ text: before.title }]), atoms([{ text: after.title }]));
          body.push(paragraph({ style: STYLE.title }, steps ? wordsXml(ctx, steps, {}) : marker.runs(textRuns(ctx, before.title), 'del') + marker.runs(textRuns(ctx, after.title), 'ins')));
        } else body.push(paragraph({ style: STYLE.title }, textRuns(ctx, after.title)));
      }
      for (const block of ctx.children.get(null) ?? []) body.push(renderBlock(ctx, block, 0));
      if (ctx.document.citations.length) {
        const heading = sourcesHeading(ctx);
        body.push(before.citations.length === 0 ? marker.block(heading, 'ins') : after.citations.length === 0 ? marker.block(heading, 'del') : heading);
        ctx.document.citations.forEach((citation, index) => {
          if (diff.citations.added.includes(citation.id)) body.push(marker.block(sourceEntry(ctx, citation, index), 'ins'));
          else if (diff.citations.removed.includes(citation.id)) body.push(marker.block(sourceEntry(ctx, citation, index, false), 'del'));
          else if (diff.citations.changed.includes(citation.id)) {
            const old = before.citations.find(candidate => candidate.id === citation.id)!;
            body.push(marker.block(sourceEntry(ctx, old, index, false), 'del'), marker.block(sourceEntry(ctx, citation, index), 'ins'));
          } else body.push(sourceEntry(ctx, citation, index));
        });
      }
      return body;
    },
    warnings(): FormatWarning[] {
      const out: FormatWarning[] = [];
      const replaced = [...status].filter(([, entry]) => entry.kind === 'replace').map(([id]) => id);
      if (replaced.length) out.push({
        code: 'redline-block-replaced', count: replaced.length, blockIds: replaced.slice(0, 20), path: `document.blocks[${after.blocks.findIndex(block => block.id === replaced[0])}]`,
        message: `${replaced.length} changed ${replaced.length === 1 ? 'block is' : 'blocks are'} shown as the old block deleted and the new one inserted${tooLong.length ? ` (${tooLong.length} too long to compare word by word)` : ''}.`,
        hint: REDLINE_LIMITS['redline-block-replaced'],
      });
      if (diff.moved.length) out.push({
        code: 'redline-move-not-tracked', count: diff.moved.length, blockIds: diff.moved.slice(0, 20),
        message: `${diff.moved.length} moved ${diff.moved.length === 1 ? 'block is' : 'blocks are'} shown at the new position without a tracked change.`,
        hint: REDLINE_LIMITS['redline-move-not-tracked'],
      });
      if (diff.formatChanged) out.push({
        code: 'redline-format-not-tracked', message: 'The page format changed (page size, font, font size or line height) and is not shown as a tracked change.',
        hint: REDLINE_LIMITS['redline-format-not-tracked'],
      });
      if (!diff.added.length && !diff.removed.length && !diff.changed.length && !diff.moved.length && !diff.formatChanged && !diff.titleChanged && !diff.citations.added.length && !diff.citations.removed.length && !diff.citations.changed.length) out.push({
        code: 'redline-no-changes', message: 'The two documents have the same text and structure; the file has no tracked changes.',
        hint: REDLINE_LIMITS['redline-no-changes'],
      });
      return out;
    },
  };
  return assemble(merged, opts, plan);
}

/**
 * The same, from an agent's proposed transaction: reviews it against `document` (the document as it is now) and, when it is ready to
 * apply, writes the redline of what applying it would change. A stale or invalid proposal returns the review's issues. Nothing is applied.
 * The change date defaults to the time of the review (`now()` when given, so tests and replays are repeatable).
 */
export async function exportProposalDocx(document: ResearchDocument, proposal: unknown, options?: DocxRedlineOptions & { now?: () => string }): Promise<ExportResult> {
  const { now, ...rest } = options ?? {};
  if (now !== undefined && typeof now !== 'function') return refuse([issue('options.now', 'Expected a function that returns an ISO 8601 date and time.', 'Omit it to use the clock.')]);
  const bad = redlineOptionIssues(options === undefined ? undefined : rest);
  if (bad.length) return refuse(bad);
  const checked = checkDocument(document);
  if (!checked.ok) return refuse(checked.issues.map(entry => ({ ...entry, path: `document.${entry.path}` })));
  const review = reviewProposal(checked.document, proposal, now ? { now } : {});
  if (review.status !== 'ready' || !review.after || !review.transaction) return refuse(review.issues.length ? review.issues : [issue('proposal', `The proposal is ${review.status}.`, 'Propose it again against the current document.')]);
  return exportDocxRedline({ before: checked.document, after: review.after, actor: review.transaction.actor }, rest);
}
