// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { createEditor } from './editor.js';
import { withHints } from './issues.js';
import { createReportService, type ReportService } from './service.js';
import type { Actor, ApplyResult, EditorIssue, ResearchDocument, Revision } from './types.js';

/**
 * Persistence for hosts whose documents live somewhere asynchronous (a database, an object store, another service).
 *
 * `ReportService` is synchronous on purpose: it wraps an in-memory editor. A store-backed host implements `DocumentStore` (two
 * methods) and gets `createStoreService`, an `AsyncReportService` that loads, applies one guarded transaction and saves it with a
 * compare-and-swap on the document revision. The HTTP handler and `runAgentActionAsync` accept either kind of service.
 */
export type SaveResult = { ok: true } | { ok: false; currentRevision?: number };
export interface DocumentStore {
  /** The stored document, or `undefined` when there is none. */
  load(): Promise<ResearchDocument | undefined> | ResearchDocument | undefined;
  /**
   * Stores `document` only if the stored revision is still `expectedRevision` (an atomic compare-and-swap: a conditional UPDATE,
   * a version check in a transaction, an `If-Match`). Return `{ ok: false }` when another writer got there first; never overwrite.
   * `revision` is the accepted change, for hosts that keep an audit log (it holds the transaction id, actor and operations).
   */
  save(document: ResearchDocument, expectedRevision: number, revision: Revision): Promise<SaveResult> | SaveResult;
  /** Recent accepted changes, oldest first. Optional: enables `list_revisions` and detection of an exact transaction retry. */
  revisions?(): Promise<readonly Revision[]> | readonly Revision[];
}

/** The asynchronous counterpart of `ReportService`. */
export interface AsyncReportService {
  read(): Promise<ResearchDocument>;
  apply(transaction: unknown): Promise<ApplyResult>;
  undo(actor: Actor, expectedRevision: number): Promise<ApplyResult>;
  redo(actor: Actor, expectedRevision: number): Promise<ApplyResult>;
  revisions?(): Promise<readonly Revision[]>;
}

export type StoreServiceOptions = { now?: () => string };

const failureOf = (issues: EditorIssue[], currentRevision: number): ApplyResult => ({ ok: false, issues: withHints(issues), currentRevision });
export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}
/** A clock that never runs behind the document it is applied to. */
function clockFor(document: ResearchDocument, now?: () => string): () => string {
  if (now) return now;
  const floor = Date.parse(document.updatedAt);
  return () => new Date(Math.max(Date.now(), floor)).toISOString();
}

/**
 * Applies one transaction to a document value and returns the result, with no session and nothing kept: the stateless form of
 * `createEditor(document).apply(transaction)`. The input is not modified (documents are immutable); on success `result.document`
 * is the new document. Undo history is not kept.
 */
export function applyToDocument(document: ResearchDocument, transaction: unknown, options: StoreServiceOptions = {}): ApplyResult {
  return createEditor(document, { now: clockFor(document, options.now), historyLimit: 0 }).apply(transaction);
}

/**
 * An `AsyncReportService` over a `DocumentStore`. Each write loads the document, applies the transaction with the usual guards
 * (revision, block versions, validation), then saves with a compare-and-swap. If another writer saved first, nothing is written and
 * the result is a `conflict` carrying the current revision; the caller re-reads and decides. Writes through one service object are
 * serialized. Undo and redo need session history, which a store does not keep: they answer a `history` issue (apply a new
 * transaction that reverses the change instead).
 */
export function createStoreService(store: DocumentStore, options: StoreServiceOptions = {}): AsyncReportService {
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task, task);
    queue = run.catch(() => undefined);
    return run;
  };
  async function load(): Promise<ResearchDocument> {
    const document = await store.load();
    if (!document) throw new TypeError('The document store has no document.');
    return document;
  }
  async function apply(transaction: unknown): Promise<ApplyResult> {
    const document = await load();
    // An exact retry of an already accepted transaction is answered from the log, as an in-memory editor does for its last one.
    const id = typeof transaction === 'object' && transaction !== null ? (transaction as { id?: unknown }).id : undefined;
    if (typeof id === 'string' && store.revisions) {
      const known = (await store.revisions()).find(revision => revision.transactionId === id);
      if (known) {
        const same = JSON.stringify((transaction as { operations?: unknown }).operations) === JSON.stringify(known.operations);
        return same ? { ok: true, document, revision: known, duplicate: true } : failureOf([{ code: 'duplicate', message: 'Transaction ID is consumed. Only an identical retry of an accepted transaction is allowed.' }], document.revision);
      }
    }
    const result = createEditor(document, { now: clockFor(document, options.now), historyLimit: 0 }).apply(transaction);
    if (!result.ok) return result;
    const saved = await store.save(result.document, document.revision, result.revision);
    if (saved.ok) return result;
    return failureOf([{ code: 'conflict', message: 'The document was changed by another writer while this edit was being saved; nothing was written.', hint: 'Re-read the document and retry with its new revision.' }], saved.currentRevision ?? (await store.load())?.revision ?? document.revision);
  }
  const history = async (): Promise<ApplyResult> => failureOf([{ code: 'history', message: 'A store-backed service keeps no session history, so undo and redo are not available.', hint: 'Apply a new transaction that reverses the change.' }], (await load()).revision);
  return {
    read: () => load(),
    apply: transaction => serialized(() => apply(transaction)),
    undo: () => history(),
    redo: () => history(),
    ...(store.revisions ? { revisions: async () => [...(await store.revisions!())] } : {}),
  };
}

/** A `DocumentStore` that keeps one document in memory with real compare-and-swap semantics. For tests, prototypes and single-process hosts. */
export function createMemoryStore(document: ResearchDocument, options: { revisionLimit?: number } = {}): DocumentStore & { current(): ResearchDocument } {
  let stored = document;
  let log: readonly Revision[] = [];
  const limit = options.revisionLimit ?? 1_000;
  return {
    load: () => stored,
    save(next, expectedRevision, revision) {
      if (stored.revision !== expectedRevision) return { ok: false, currentRevision: stored.revision };
      stored = next; log = [...log, revision].slice(-limit);
      return { ok: true };
    },
    revisions: () => log,
    current: () => stored,
  };
}

/** A request-local synchronous view of an asynchronous service, plus a way to send what was written back to it. */
export type ServiceSnapshot = {
  /** A normal `ReportService` over the document as it was read. Writes apply to this copy and are remembered. */
  service: ReportService;
  /** Writes made so far that still have to reach the real service. */
  pending(): readonly unknown[];
  /** Applies the remembered writes to the real service, in order. Resolves to the first failure, or `undefined` when all were accepted. */
  flush(): Promise<{ ok: false; issues: EditorIssue[]; currentRevision: number } | undefined>;
};
/**
 * Lets code written against the synchronous `ReportService` (the action table, the HTTP routes) run on an asynchronous service:
 * read once, run, then `flush()` the transactions it applied through the real service (where the compare-and-swap happens).
 */
export async function openSnapshot(service: AsyncReportService, options: { document?: ResearchDocument; revisions?: boolean } = {}): Promise<ServiceSnapshot> {
  const document = options.document ?? await service.read();
  const known = options.revisions && service.revisions ? await service.revisions() : undefined;
  const editor = createEditor(document, { now: clockFor(document), historyLimit: 100 });
  const local = createReportService(editor);
  const pending: unknown[] = [];
  const snapshot: ReportService = {
    read: () => local.read(),
    apply(transaction) { const result = local.apply(transaction); if (result.ok && !result.duplicate) pending.push(transaction); return result; },
    undo: () => failureOf([{ code: 'history', message: 'A store-backed service keeps no session history, so undo and redo are not available.', hint: 'Apply a new transaction that reverses the change.' }], editor.getSnapshot().revision),
    redo: () => failureOf([{ code: 'history', message: 'A store-backed service keeps no session history, so undo and redo are not available.', hint: 'Apply a new transaction that reverses the change.' }], editor.getSnapshot().revision),
    ...(known ? { revisions: () => known } : {}),
  };
  return {
    service: snapshot,
    pending: () => pending,
    async flush() {
      for (const transaction of pending.splice(0)) {
        const result = await service.apply(transaction);
        if (!result.ok) return { ok: false, issues: result.issues, currentRevision: result.currentRevision };
      }
      return undefined;
    },
  };
}
