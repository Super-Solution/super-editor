import { isContainerType } from './constants.js';
import { replaceInContent, runsOf } from './text.js';
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
function reject(code: EditorIssue['code'], message: string, blockId?: string, hint?: string): never {
  throw new Rejected({ code, message, ...(blockId ? { blockId } : {}), ...(hint ? { hint } : {}) });
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
    if (!block) reject('not-found', 'Block does not exist.', blockId, 'Read the document to list current block IDs. Deleted IDs no longer exist.');
    if (block.version !== expectedVersion) reject('conflict', 'Block changed; re-read before proposing another edit.', blockId, `Block "${blockId}" is now at version ${block.version} (you sent ${expectedVersion}). Re-read it and retry with expectedVersion ${block.version} if your edit still applies.`);
    return block;
  }
  function parentExists(next: ResearchDocument, parentId: string | null): void {
    const found = parentId === null ? undefined : next.blocks.find(block => block.id === parentId);
    if (parentId !== null && !(found && isContainerType(found.content.type))) reject('validation', 'Parent must reference an existing section or toggle.', parentId, found ? `Block "${parentId}" is a ${found.content.type}; only section and toggle blocks can contain other blocks.` : `No block "${parentId}" exists. Insert the section or toggle first (earlier in the same batch is fine) or use parentId: null.`);
  }
  /** Index just past a block's contiguous descendants (documents are normally kept in pre-order). */
  function subtreeEnd(blocks: Block[], index: number): number {
    const members = new Set([blocks[index]!.id]);
    let end = index + 1;
    while (end < blocks.length && blocks[end]!.parentId !== null && members.has(blocks[end]!.parentId!)) { members.add(blocks[end]!.id); end++; }
    return end;
  }
  function put(next: ResearchDocument, block: Block, afterId: string | null | undefined): void {
    parentExists(next, block.parentId);
    if (afterId === block.id) reject('validation', 'A block cannot anchor itself.', block.id);
    // Placement is best-effort pre-order: a new block lands after the subtree of its predecessor, or right after its parent when it is the first child.
    let position = next.blocks.length;
    const firstChild = (): number => block.parentId === null ? position : next.blocks.findIndex(entry => entry.id === block.parentId) + 1;
    if (afterId === null) {
      const first = next.blocks.findIndex(entry => entry.parentId === block.parentId);
      position = first !== -1 ? first : firstChild();
    } else if (afterId !== undefined) {
      const anchor = next.blocks.findIndex(entry => entry.id === afterId);
      if (anchor === -1 || next.blocks[anchor]!.parentId !== block.parentId) reject('validation', 'Ordering anchor must reference a sibling in the destination section.', block.id, `afterId "${afterId}" must be a direct child of ${block.parentId === null ? 'the document root' : `"${block.parentId}"`}. Omit afterId to append, or use null to prepend.`);
      position = subtreeEnd(next.blocks, anchor);
    } else {
      // Omission appends among siblings, independent of the nesting depth of other containers.
      let last = -1;
      for (let index = next.blocks.length - 1; index >= 0; index--) if (next.blocks[index]!.parentId === block.parentId) { last = index; break; }
      position = last !== -1 ? subtreeEnd(next.blocks, last) : firstChild();
    }
    next.blocks.splice(position, 0, block);
  }
  /** Detaches a block with its contiguous descendants, then reinserts the run at the new position. */
  function relocate(next: ResearchDocument, block: Block, parentId: string | null, afterId: string | null | undefined): void {
    const index = next.blocks.indexOf(block);
    const run = next.blocks.splice(index, subtreeEnd(next.blocks, index) - index);
    block.parentId = parentId;
    put(next, block, afterId);
    next.blocks.splice(next.blocks.indexOf(block) + 1, 0, ...run.slice(1));
  }
  function subtreeIds(next: ResearchDocument, roots: string[]): Set<string> {
    const found = new Set(roots);
    // Breadth-first index avoids repeated full scans for large nested reports.
    const children = new Map<string, string[]>();
    for (const block of next.blocks) if (block.parentId !== null) {
      const siblings = children.get(block.parentId);
      if (siblings) siblings.push(block.id); else children.set(block.parentId, [block.id]);
    }
    const queue = [...roots];
    for (let index = 0; index < queue.length; index++) for (const child of children.get(queue[index]!) ?? []) if (!found.has(child)) { found.add(child); queue.push(child); }
    return found;
  }
  function removeBlocks(next: ResearchDocument, ids: Set<string>, highWater: Map<string, number>, at: string): void {
    const retired = new Set(next.retiredBlockIds);
    for (const block of next.blocks) if (ids.has(block.id)) { tick(block, highWater, at); if (!retired.has(block.id)) { retired.add(block.id); next.retiredBlockIds.push(block.id); } }
    next.blocks = next.blocks.filter(block => !ids.has(block.id));
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
        if (pendingReserved.has(input.id) || next.blocks.some(block => block.id === input.id)) reject('duplicate', 'Block ID is already used or reserved.', input.id, 'Choose a fresh ID. IDs of deleted blocks stay reserved so old references cannot point at new content.');
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
        if (operation.parentId !== null && subtreeIds(next, [block.id]).has(operation.parentId)) reject('validation', 'A block cannot be moved into itself or its own descendant.', block.id, 'Choose a destination outside the moved subtree.');
        relocate(next, block, operation.parentId, operation.afterId); tick(block, highWater, at); return;
      }
      case 'deleteBlock': {
        blockAt(next, operation.blockId, operation.expectedVersion);
        removeBlocks(next, subtreeIds(next, [operation.blockId]), highWater, at); return;
      }
      case 'setTitle': next.title = operation.title; return;
      case 'setFormat': next.format = clone(operation.format); return;
      case 'addCitation': {
        if (next.citations.some(item => item.id === operation.citation.id)) reject('duplicate', 'Citation ID already exists.', undefined, 'Use updateCitation to change an existing citation, or choose a new ID.');
        next.citations.push(clone(operation.citation)); return;
      }
      case 'insertBlocks': {
        // The first block follows afterId; each later block follows the previous block with the same parent, or is appended to its parent.
        const lastByParent = new Map<string | null, string>();
        operation.blocks.forEach((input, index) => {
          if (pendingReserved.has(input.id)) reject('duplicate', 'Block ID is already used or reserved.', input.id, 'Choose a fresh ID. IDs of deleted blocks stay reserved so old references cannot point at new content.');
          const block: Block = { ...clone(input), version: 1, createdAt: at, updatedAt: at };
          put(next, block, index === 0 ? operation.afterId : lastByParent.get(input.parentId));
          highWater.set(block.id, 1); pendingReserved.add(block.id); lastByParent.set(input.parentId, input.id);
        });
        return;
      }
      case 'duplicateBlock': {
        const original = blockAt(next, operation.blockId, operation.expectedVersion);
        const children = new Map<string, Block[]>();
        for (const block of next.blocks) if (block.parentId !== null) { const siblings = children.get(block.parentId); if (siblings) siblings.push(block); else children.set(block.parentId, [block]); }
        const order: Block[] = [original];
        const walk = (parentId: string): void => { for (const child of children.get(parentId) ?? []) { order.push(child); walk(child.id); } };
        walk(original.id);
        const needed = order.map(block => block.id), neededSet = new Set(needed);
        const missing = needed.filter(blockId => !Object.hasOwn(operation.newIds, blockId)), unexpected = Object.keys(operation.newIds).filter(blockId => !neededSet.has(blockId));
        if (missing.length || unexpected.length) reject('validation', `newIds must map exactly the duplicated block and its ${needed.length - 1} descendant(s).`, original.id, `${missing.length ? `Missing: ${missing.join(', ')}. ` : ''}${unexpected.length ? `Not part of this subtree: ${unexpected.join(', ')}. ` : ''}Required old IDs: ${needed.join(', ')}.`);
        for (const blockId of needed) if (pendingReserved.has(operation.newIds[blockId]!)) reject('duplicate', 'Block ID is already used or reserved.', operation.newIds[blockId], 'Choose a fresh ID for each copy. IDs of deleted blocks stay reserved.');
        order.forEach((source, index) => {
          const copy: Block = { ...clone(source), id: operation.newIds[source.id]!, parentId: index === 0 ? source.parentId : operation.newIds[source.parentId!]!, version: 1, createdAt: at, updatedAt: at };
          put(next, copy, index === 0 ? (operation.afterId === undefined ? original.id : operation.afterId) : undefined);
          highWater.set(copy.id, 1); pendingReserved.add(copy.id);
        });
        return;
      }
      case 'replaceText': {
        const block = blockAt(next, operation.blockId, operation.expectedVersion);
        const result = replaceInContent(block.content, { find: operation.find, replace: operation.replace, ...(operation.all === undefined ? {} : { all: operation.all }), ...(operation.caseSensitive === undefined ? {} : { caseSensitive: operation.caseSensitive }) });
        if (!result) reject('validation', `A ${block.content.type} block has no text to replace.`, block.id, 'Use updateBlock to change this block.');
        if (result.count === 0) reject('not-found', 'The text to replace was not found in the block.', block.id, `Matching ${operation.caseSensitive ? 'is' : 'is not'} case-sensitive. Read the block and copy the exact wording; a match cannot span separate list items or table cells.`);
        block.content = result.content; tick(block, highWater, at); return;
      }
      case 'deleteBlocks': {
        for (const ref of operation.blocks) blockAt(next, ref.blockId, ref.expectedVersion);
        removeBlocks(next, subtreeIds(next, operation.blocks.map(ref => ref.blockId)), highWater, at); return;
      }
      case 'moveBlocks': {
        const moving = new Set(operation.blocks.map(ref => ref.blockId));
        const blocks = operation.blocks.map(ref => blockAt(next, ref.blockId, ref.expectedVersion));
        if (operation.afterId != null && moving.has(operation.afterId)) reject('validation', 'afterId cannot be one of the moved blocks.', operation.afterId, 'Anchor on a block that stays in place, or omit afterId.');
        parentExists(next, operation.parentId);
        if (operation.parentId !== null && subtreeIds(next, [...moving]).has(operation.parentId)) reject('validation', 'A block cannot be moved into itself or its own descendant.', operation.parentId, 'Choose a destination outside the moved subtrees.');
        // Blocks land in the given order: the first after afterId, each later one after its predecessor.
        blocks.forEach((block, index) => { relocate(next, block, operation.parentId, index === 0 ? operation.afterId : blocks[index - 1]!.id); tick(block, highWater, at); });
        return;
      }
      case 'updateCitation': {
        const index = next.citations.findIndex(item => item.id === operation.citation.id);
        if (index === -1) reject('not-found', 'Citation does not exist.', undefined, `No citation "${operation.citation.id}". Use addCitation to create it.`);
        next.citations[index] = clone(operation.citation); return;
      }
      case 'removeCitation': {
        const index = next.citations.findIndex(item => item.id === operation.citationId);
        if (index === -1) reject('not-found', 'Citation does not exist.', undefined, `No citation "${operation.citationId}". Read the document to list citation IDs.`);
        next.citations.splice(index, 1);
        // References are stripped, never left dangling: block-level IDs, inline markers, and marker-only runs.
        for (const block of next.blocks) {
          let changed = false;
          if (block.citationIds.includes(operation.citationId)) { block.citationIds = block.citationIds.filter(entry => entry !== operation.citationId); changed = true; }
          const runs = runsOf(block.content);
          if (runs?.some(run => run.citationId === operation.citationId)) {
            const kept = runs.filter(run => run.citationId !== operation.citationId || run.text !== '');
            for (const run of kept) if (run.citationId === operation.citationId) delete run.citationId;
            runs.splice(0, runs.length, ...kept); changed = true;
          }
          if (changed) tick(block, highWater, at);
        }
        return;
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
      if (stale && (transaction.baseRevision > snapshot.revision || transaction.conflictPolicy !== 'rebase-safe' || !transaction.operations.every(operation => operation.type === 'updateBlock' || operation.type === 'replaceText'))) reject('conflict', 'Document changed; re-read before proposing another edit.', undefined, transaction.baseRevision > snapshot.revision ? `baseRevision ${transaction.baseRevision} is ahead of the document (revision ${snapshot.revision}).` : `The document is at revision ${snapshot.revision} (you sent ${transaction.baseRevision}). Re-read it and retry with baseRevision ${snapshot.revision}. conflictPolicy "rebase-safe" only carries version-guarded updateBlock and replaceText operations over a stale revision.`);
      if (stale) for (const operation of transaction.operations) if (operation.type === 'updateBlock' && snapshot.blocks.find(block => block.id === operation.blockId)?.content.type !== operation.content.type) reject('conflict', 'Rebased updates must preserve the block content type.', operation.blockId, 'Re-read the block and propose the change against the current document revision.');
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
