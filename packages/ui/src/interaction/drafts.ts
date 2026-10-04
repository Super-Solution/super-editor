import type { ApplyResult, BlockContent, Editor } from '@super-solution/editor-core';
import type { ConflictInfo, FeedbackEvent } from './types.js';

/**
 * Typing is buffered in drafts and committed to the editor as guarded `updateBlock` operations: after a short idle
 * delay, on blur, and before any structural command. A draft remembers the block version it started from, so a change
 * made elsewhere (an agent, another tab) surfaces as a conflict instead of being overwritten.
 */
type Draft = { content: BlockContent; baseVersion: number; dirty: boolean; timer: ReturnType<typeof setTimeout> | null };
export type DraftDeps = {
  editor: Editor;
  /** Submits the update. The commands layer reports failures to the host; drafts only track state. */
  commit(blockId: string, content: BlockContent, expectedVersion: number): ApplyResult;
  /** Milliseconds of typing silence before a commit. 0 commits on every edit. */
  delayMs: number;
  onConflict(info: ConflictInfo): void;
  onFeedback(event: FeedbackEvent): void;
  onConflictsChanged(conflicts: Readonly<Record<string, ConflictInfo>>): void;
  /** Ask the editing surface to re-render a field from the document (after "use latest"). */
  requestResync(blockId: string): void;
};
export type Drafts = ReturnType<typeof createDrafts>;

export function createDrafts(deps: DraftDeps) {
  const drafts = new Map<string, Draft>();
  let conflicts: Record<string, ConflictInfo> = {};
  let committing = false;
  const same = (a: BlockContent, b: BlockContent): boolean => JSON.stringify(a) === JSON.stringify(b);
  const block = (id: string) => deps.editor.getSnapshot().blocks.find((entry) => entry.id === id);
  const publishConflicts = (next: Record<string, ConflictInfo>): void => { conflicts = next; deps.onConflictsChanged(Object.freeze({ ...next })); };
  const setConflict = (id: string, info: ConflictInfo): void => { publishConflicts({ ...conflicts, [id]: info }); };
  const clearConflict = (id: string): void => { if (!(id in conflicts)) return; const { [id]: _removed, ...rest } = conflicts; publishConflicts(rest); };
  const stop = (draft: Draft): void => { if (draft.timer !== null) { clearTimeout(draft.timer); draft.timer = null; } };

  /** Reconciles drafts with the document: unchanged blocks are fine, changed ones refresh (clean draft) or conflict (dirty draft). */
  function check(): void {
    if (committing) return;
    for (const [id, draft] of [...drafts]) {
      const current = block(id);
      if (!current) {
        stop(draft); drafts.delete(id); clearConflict(id);
        if (draft.dirty) {
          const info: ConflictInfo = { command: 'draft', blockId: id, message: 'The block you were editing was deleted. Your unsaved text is available in this notice.', issues: [], mine: draft.content };
          deps.onConflict(info); deps.onFeedback({ kind: 'conflict', message: info.message, blockIds: [id] });
        }
        continue;
      }
      if (current.version === draft.baseVersion) continue;
      if (!draft.dirty) { drafts.delete(id); clearConflict(id); continue; }
      if (conflicts[id]) { setConflict(id, { ...conflicts[id]!, theirs: current.content }); continue; }
      stop(draft);
      const info: ConflictInfo = { command: 'draft', blockId: id, message: 'This block was changed elsewhere while you were typing. Choose which version to keep.', issues: [], mine: draft.content, theirs: current.content };
      setConflict(id, info); deps.onConflict(info); deps.onFeedback({ kind: 'conflict', message: info.message, blockIds: [id] });
    }
  }
  const unsubscribe = deps.editor.subscribe(check);

  function flush(id: string): ApplyResult | null {
    const draft = drafts.get(id);
    if (!draft) return null;
    stop(draft);
    if (conflicts[id]) return null;
    const current = block(id);
    if (!current) { drafts.delete(id); return null; }
    if (!draft.dirty || (draft.baseVersion === current.version && same(draft.content, current.content))) { drafts.delete(id); return null; }
    committing = true;
    let result: ApplyResult;
    try { result = deps.commit(id, draft.content, draft.baseVersion); } finally { committing = false; }
    if (result.ok) { drafts.delete(id); return result; }
    if (result.issues.some((issue) => issue.code === 'conflict')) {
      const latest = block(id);
      setConflict(id, { command: 'commit', blockId: id, message: 'This block was changed elsewhere. Choose which version to keep.', issues: result.issues, mine: draft.content, ...(latest ? { theirs: latest.content } : {}) });
    }
    return result;
  }
  function mutate(id: string, produce: (content: BlockContent) => BlockContent): 'missing' | 'same' | 'changed' {
    const current = block(id);
    if (!current) return 'missing';
    let draft = drafts.get(id);
    if (!draft) { draft = { content: current.content, baseVersion: current.version, dirty: false, timer: null }; drafts.set(id, draft); }
    const next = produce(draft.content);
    if (same(next, draft.content)) return 'same';
    draft.content = next; draft.dirty = true;
    stop(draft);
    return 'changed';
  }
  function schedule(id: string): void {
    const draft = drafts.get(id);
    if (!draft || conflicts[id]) return;
    if (deps.delayMs <= 0) flush(id);
    else draft.timer = setTimeout(() => { draft.timer = null; flush(id); }, deps.delayMs);
  }
  return {
    has: (id: string): boolean => drafts.has(id),
    isDirty: (id: string): boolean => drafts.get(id)?.dirty ?? false,
    dirtyIds: (): string[] => [...drafts].filter(([, draft]) => draft.dirty).map(([id]) => id),
    /** What the user currently sees in the block: the draft, or the committed content. */
    contentOf(id: string): BlockContent | undefined { return drafts.get(id)?.content ?? block(id)?.content; },
    /** The version an update of this block must be guarded with. */
    versionOf(id: string): number | undefined { return drafts.get(id)?.baseVersion ?? block(id)?.version; },
    conflictOf: (id: string): ConflictInfo | undefined => conflicts[id],
    /** Applies `produce` to the visible content and schedules a commit. Returns false when the block no longer exists. */
    edit(id: string, produce: (content: BlockContent) => BlockContent): boolean {
      const outcome = mutate(id, produce);
      if (outcome === 'missing') return false;
      if (outcome === 'changed') schedule(id);
      return true;
    },
    /** Like `edit`, but commits right away (checkboxes, table structure) and returns the result; null when nothing changed. */
    editNow(id: string, produce: (content: BlockContent) => BlockContent | null): ApplyResult | null {
      const outcome = mutate(id, (content) => produce(content) ?? content);
      return outcome === 'changed' ? flush(id) : null;
    },
    flush,
    flushAll(): ApplyResult[] { return [...drafts.keys()].map(flush).filter((result): result is ApplyResult => result !== null); },
    discard(id: string): void { const draft = drafts.get(id); if (draft) stop(draft); drafts.delete(id); clearConflict(id); },
    /** "mine" re-bases the draft on the latest version and commits it; "theirs" drops the draft and shows the document's content. */
    resolve(id: string, choice: 'mine' | 'theirs'): ApplyResult | null {
      const draft = drafts.get(id), current = block(id);
      if (choice === 'theirs' || !draft || !current) { if (draft) stop(draft); drafts.delete(id); clearConflict(id); deps.requestResync(id); return null; }
      draft.baseVersion = current.version; draft.dirty = true; clearConflict(id);
      return flush(id);
    },
    /**
     * Runs a structural commit that consumes the drafts of `consumed` blocks (Enter, merge, input rules...). Their drafts must not
     * be mistaken for conflicts while the document changes under them; on success they are dropped, on failure they stay.
     */
    guarded<T extends ApplyResult | null>(consumed: readonly string[], run: () => T): T {
      const was = committing;
      committing = true;
      let result: T;
      try { result = run(); } finally { committing = was; }
      if (result?.ok) for (const id of consumed) { const draft = drafts.get(id); if (draft) stop(draft); drafts.delete(id); clearConflict(id); }
      else if (result && !result.ok && result.issues.some((issue) => issue.code === 'conflict')) for (const id of consumed) { const draft = drafts.get(id); const latest = block(id); if (draft?.dirty && latest) setConflict(id, { command: 'commit', blockId: id, message: 'This block was changed elsewhere. Choose which version to keep.', issues: result.issues, mine: draft.content, theirs: latest.content }); }
      check();
      return result;
    },
    check,
    dispose(): void { unsubscribe(); for (const draft of drafts.values()) stop(draft); drafts.clear(); },
  };
}
