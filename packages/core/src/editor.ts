import type { Actor, ApplyResult, Block, Editor, EditorIssue, EditorOptions, Operation, ResearchDocument, Revision, Transaction } from './types.js';
import { timestamp, validateDocument, validateHistoryRequest, validateTransaction } from './validation.js';

function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) freeze(entry);
    Object.freeze(value);
  }
  return value;
}
class Rejected extends Error {
  constructor(readonly issue: EditorIssue) { super(issue.message); }
}
function reject(code: EditorIssue['code'], message: string, blockId?: string): never {
  throw new Rejected({ code, message, ...(blockId ? { blockId } : {}) });
}
function increment(value: number, label: string): number {
  if (value >= Number.MAX_SAFE_INTEGER) reject('conflict', `${label} has reached the maximum supported version.`);
  return value + 1;
}
function optionsReader(options: EditorOptions): { now: () => string; historyLimit: number } {
  if (!options || typeof options !== 'object' || (options.now !== undefined && typeof options.now !== 'function')) throw new TypeError('now must be a timestamp callback.');
  const historyLimit = options.historyLimit ?? 100;
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 0 || historyLimit > 1_000) throw new TypeError('historyLimit must be an integer between 0 and 1,000.');
  return { now: options.now ?? (() => new Date().toISOString()), historyLimit };
}
export function createDocument(input: { id: string; title: string }, options: EditorOptions = {}): ResearchDocument {
  const { now } = optionsReader(options);
  const at = timestamp(now(), 'options.now');
  const result = validateDocument({ schemaVersion: 1, id: input.id, title: input.title, revision: 0, createdAt: at, updatedAt: at,
    format: { page: 'screen', font: 'sans', fontSize: 16, lineHeight: 1.6 }, blocks: [], citations: [], retiredBlockIds: [] });
  if (!result.ok) throw new TypeError(result.issues[0]?.message ?? 'Invalid document input.');
  return freeze(result.value);
}
type HistoryEntry = { before: ResearchDocument; after: ResearchDocument; transaction: Transaction };

/** Session editor. Hosts own durable persistence, auth and coordination between independent editor instances. */
export function createEditor(document: ResearchDocument, options: EditorOptions = {}): Editor {
  const validated = validateDocument(document);
  if (!validated.ok) throw new TypeError(validated.issues[0]?.message ?? 'Invalid document.');
  const { now, historyLimit } = optionsReader(options);
  let snapshot = freeze(validated.value);
  let versions = new Map(snapshot.blocks.map(block => [block.id, block.version]));
  const reserved = new Set([...snapshot.retiredBlockIds, ...snapshot.blocks.map(block => block.id)]);
  // Only the last successful apply retains its exact payload. Earlier IDs stay consumed for this session.
  const seen = new Set<string>();
  const listeners = new Set<() => void>();
  let undoStack: HistoryEntry[] = [];
  let redoStack: HistoryEntry[] = [];
  let revisions: readonly Revision[] = freeze([] as Revision[]);
  let lastApply: { id: string; fingerprint: string; result: Extract<ApplyResult, { ok: true }> } | undefined;
  let committing = false;

  function failure(issues: EditorIssue[]): ApplyResult { return { ok: false, issues, currentRevision: snapshot.revision }; }
  function clock(): string {
    let at: string;
    try { at = timestamp(now(), 'options.now'); }
    catch { reject('validation', 'Clock must return a valid ISO UTC timestamp.'); }
    if (new Date(at).getTime() < new Date(snapshot.updatedAt).getTime()) reject('validation', 'Clock cannot move backward relative to the current document.');
    return at;
  }
  function emit(): void {
    // A listener failure cannot turn an already committed transaction into an apparent failure.
    for (const listener of [...listeners]) { try { listener(); } catch { /* Hosts should handle errors inside their own listeners. */ } }
  }
  function commit(next: ResearchDocument, revision: Revision, nextVersions: Map<string, number>): Extract<ApplyResult, { ok: true }> {
    snapshot = freeze(next);
    versions = nextVersions;
    for (const block of next.blocks) reserved.add(block.id);
    for (const blockId of next.retiredBlockIds) reserved.add(blockId);
    revisions = freeze([...revisions, freeze(revision)].slice(-Math.max(1, historyLimit)));
    return freeze({ ok: true, document: snapshot, revision: revisions[revisions.length - 1]! });
  }
  function blockAt(next: ResearchDocument, blockId: string, expectedVersion: number): Block {
    const block = next.blocks.find(entry => entry.id === blockId);
    if (!block) reject('not-found', 'Block does not exist.', blockId);
    if (block.version !== expectedVersion) reject('conflict', 'Block changed; re-read before proposing another edit.', blockId);
    return block;
  }
  function parentExists(next: ResearchDocument, parentId: string | null): void {
    if (parentId !== null && next.blocks.find(block => block.id === parentId)?.content.type !== 'section') reject('validation', 'Parent must reference an existing section.', parentId);
  }
  function put(next: ResearchDocument, block: Block, afterId: string | null | undefined): void {
    parentExists(next, block.parentId);
    if (afterId === block.id) reject('validation', 'A block cannot anchor itself.', block.id);
    let position = next.blocks.length;
    if (afterId === null) {
      const first = next.blocks.findIndex(entry => entry.parentId === block.parentId);
      if (first !== -1) position = first;
    } else if (afterId !== undefined) {
      const anchor = next.blocks.findIndex(entry => entry.id === afterId);
      if (anchor === -1 || next.blocks[anchor]!.parentId !== block.parentId) reject('validation', 'Ordering anchor must reference a sibling in the destination section.', block.id);
      position = anchor + 1;
    } else {
      // Omission appends among siblings, independent of the nesting depth of other sections.
      for (let index = next.blocks.length - 1; index >= 0; index--) if (next.blocks[index]!.parentId === block.parentId) { position = index + 1; break; }
    }
    next.blocks.splice(position, 0, block);
  }
  function tick(block: Block, highWater: Map<string, number>, at: string): void {
    block.version = increment(Math.max(block.version, highWater.get(block.id) ?? 0), `Block ${block.id}`);
    block.updatedAt = at;
    highWater.set(block.id, block.version);
  }
  function applyOperation(next: ResearchDocument, operation: Operation, highWater: Map<string, number>, at: string, pendingReserved: Set<string>): void {
    switch (operation.type) {
      case 'insertBlock': {
        const input = operation.block;
        if (pendingReserved.has(input.id) || next.blocks.some(block => block.id === input.id)) reject('duplicate', 'Block ID is already used or reserved.', input.id);
        const block: Block = { ...clone(input), version: 1, createdAt: at, updatedAt: at };
        put(next, block, operation.afterId); highWater.set(block.id, 1); pendingReserved.add(block.id); return;
      }
      case 'updateBlock': {
        const block = blockAt(next, operation.blockId, operation.expectedVersion);
        block.content = clone(operation.content);
        if (operation.citationIds !== undefined) block.citationIds = [...operation.citationIds];
        tick(block, highWater, at); return;
      }
      case 'moveBlock': {
        const block = blockAt(next, operation.blockId, operation.expectedVersion);
        // Validate destination before detaching; cycles are validated against the final atomic document.
        parentExists(next, operation.parentId);
        next.blocks.splice(next.blocks.indexOf(block), 1);
        block.parentId = operation.parentId;
        put(next, block, operation.afterId); tick(block, highWater, at); return;
      }
      case 'deleteBlock': {
        blockAt(next, operation.blockId, operation.expectedVersion);
        const deleted = new Set([operation.blockId]);
        // Breadth-first index avoids repeated full scans for large nested reports.
        const children = new Map<string, string[]>();
        for (const block of next.blocks) if (block.parentId !== null) {
          const siblings = children.get(block.parentId);
          if (siblings) siblings.push(block.id); else children.set(block.parentId, [block.id]);
        }
        const queue = [operation.blockId];
        for (let index = 0; index < queue.length; index++) for (const child of children.get(queue[index]!) ?? []) if (!deleted.has(child)) { deleted.add(child); queue.push(child); }
        for (const block of next.blocks) if (deleted.has(block.id)) { tick(block, highWater, at); if (!next.retiredBlockIds.includes(block.id)) next.retiredBlockIds.push(block.id); }
        next.blocks = next.blocks.filter(block => !deleted.has(block.id)); return;
      }
      case 'setTitle': next.title = operation.title; return;
      case 'setFormat': next.format = clone(operation.format); return;
      case 'addCitation': {
        if (next.citations.some(item => item.id === operation.citation.id)) reject('duplicate', 'Citation ID already exists.');
        next.citations.push(clone(operation.citation)); return;
      }
    }
  }
  function apply(value: unknown): ApplyResult {
    if (committing) return failure([{ code: 'conflict', message: 'An editor commit is already in progress.' }]);
    const result = validateTransaction(value);
    if (!result.ok) return failure(result.issues);
    const transaction = result.value;
    const fingerprint = JSON.stringify(transaction);
    if (seen.has(transaction.id)) {
      if (lastApply?.id === transaction.id && lastApply.fingerprint === fingerprint) return freeze({ ...lastApply.result, duplicate: true });
      return failure([{ code: 'duplicate', message: 'Transaction ID is consumed. Only an identical retry of the immediately preceding successful transaction is allowed.' }]);
    }
    if (seen.size >= 100_000) return failure([{ code: 'history', message: 'Session transaction limit reached. Persist and reload the document to start a new session.' }]);
    committing = true;
    let committed: Extract<ApplyResult, { ok: true }>;
    try {
      const stale = transaction.baseRevision !== snapshot.revision;
      if (stale && (transaction.baseRevision > snapshot.revision || transaction.conflictPolicy !== 'rebase-safe' || !transaction.operations.every(operation => operation.type === 'updateBlock'))) reject('conflict', 'Document changed; re-read before proposing another edit.');
      if (stale) for (const operation of transaction.operations) if (operation.type === 'updateBlock' && snapshot.blocks.find(block => block.id === operation.blockId)?.content.type !== operation.content.type) reject('conflict', 'Rebased updates must preserve the block content type.', operation.blockId);
      const at = clock();
      const next = clone(snapshot);
      const highWater = new Map(versions);
      const pendingReserved = new Set(reserved);
      for (const operation of transaction.operations) applyOperation(next, operation, highWater, at, pendingReserved);
      next.revision = increment(snapshot.revision, 'Document'); next.updatedAt = at;
      const final = validateDocument(next);
      if (!final.ok) return failure(final.issues);
      const revision: Revision = { number: next.revision, transactionId: transaction.id, actor: clone(transaction.actor), at, kind: 'apply', operations: clone(transaction.operations), ...(stale ? { rebasedFrom: transaction.baseRevision } : {}) };
      const before = snapshot;
      committed = commit(final.value, revision, highWater);
      if (historyLimit > 0) undoStack = [...undoStack, { before, after: snapshot, transaction: freeze(clone(transaction)) }].slice(-historyLimit);
      redoStack = [];
      seen.add(transaction.id);
      lastApply = { id: transaction.id, fingerprint, result: committed };
    } catch (error) {
      return failure([error instanceof Rejected ? error.issue : { code: 'validation', message: 'Transaction could not be applied safely.' }]);
    } finally { committing = false; }
    emit(); return committed;
  }
  function history(kind: 'undo' | 'redo', actorValue: Actor, expectedRevisionValue: number): ApplyResult {
    if (committing) return failure([{ code: 'conflict', message: 'An editor commit is already in progress.' }]);
    const request = validateHistoryRequest(actorValue, expectedRevisionValue);
    if (!request.ok) return failure(request.issues);
    if (request.value.expectedRevision !== snapshot.revision) return failure([{ code: 'conflict', message: 'Document changed; re-read before using history.' }]);
    const stack = kind === 'undo' ? undoStack : redoStack;
    const entry = stack[stack.length - 1];
    if (!entry) return failure([{ code: 'history', message: `No ${kind} history is available.` }]);
    committing = true;
    let committed: Extract<ApplyResult, { ok: true }>;
    try {
      const at = clock();
      const target = clone(kind === 'undo' ? entry.before : entry.after);
      const highWater = new Map(versions);
      const currentById = new Map(snapshot.blocks.map(block => [block.id, block]));
      const targetIds = new Set(target.blocks.map(block => block.id));
      const retired = new Set([...snapshot.retiredBlockIds, ...target.retiredBlockIds]);
      const siblingPredecessors = (document: ResearchDocument): Map<string, string | undefined> => {
        const predecessors = new Map<string, string | undefined>(); const previous = new Map<string | null, string>();
        for (const block of document.blocks) { predecessors.set(block.id, previous.get(block.parentId)); previous.set(block.parentId, block.id); }
        return predecessors;
      };
      const currentPredecessors = siblingPredecessors(snapshot); const targetPredecessors = siblingPredecessors(target);
      for (const current of snapshot.blocks) if (!targetIds.has(current.id)) { highWater.set(current.id, increment(highWater.get(current.id) ?? current.version, `Block ${current.id}`)); retired.add(current.id); }
      // History never copies old versions back: all restored blocks receive their current high-water version.
      for (const block of target.blocks) {
        const current = currentById.get(block.id);
        const currentContent = current ? JSON.stringify({ parentId: current.parentId, content: current.content, citationIds: current.citationIds }) : undefined;
        const nextContent = JSON.stringify({ parentId: block.parentId, content: block.content, citationIds: block.citationIds });
        const reordered = current && currentPredecessors.get(block.id) !== targetPredecessors.get(block.id);
        if (!current || currentContent !== nextContent || reordered) tick(block, highWater, at);
        else { block.version = current.version; block.updatedAt = current.updatedAt; }
      }
      target.retiredBlockIds = [...retired]; target.revision = increment(snapshot.revision, 'Document'); target.updatedAt = at;
      const final = validateDocument(target);
      if (!final.ok) return failure(final.issues);
      const revision: Revision = { number: target.revision, transactionId: `history:${kind}:${target.revision}`, actor: clone(request.value.actor), at, kind, operations: [] };
      committed = commit(final.value, revision, highWater);
      if (kind === 'undo') { undoStack = undoStack.slice(0, -1); redoStack = [...redoStack, entry].slice(-historyLimit); }
      else { redoStack = redoStack.slice(0, -1); undoStack = [...undoStack, entry].slice(-historyLimit); }
      lastApply = undefined;
    } catch (error) {
      return failure([error instanceof Rejected ? error.issue : { code: 'validation', message: 'History could not be restored safely.' }]);
    } finally { committing = false; }
    emit(); return committed;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('Listener must be a function.'); listeners.add(listener); return () => { listeners.delete(listener); }; },
    apply,
    undo: (actor, revision) => history('undo', actor, revision),
    redo: (actor, revision) => history('redo', actor, revision),
    getRevisions: () => revisions,
  };
}
