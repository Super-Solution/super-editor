import type { Actor, ApplyResult, Editor, ResearchDocument, Revision } from './types.js';

/** Session-scoped facade. Persistence and access control belong to the host. */
export interface ReportService {
  read(): ResearchDocument;
  apply(transaction: unknown): ApplyResult;
  undo(actor: Actor, expectedRevision: number): ApplyResult;
  redo(actor: Actor, expectedRevision: number): ApplyResult;
  /**
   * Revisions this service can list, oldest first. Optional so a host that keeps durable history (or none) can
   * implement it however it likes; callers treat a missing method as an empty list.
   */
  revisions?(): readonly Revision[];
}

export function createReportService(editor: Editor): ReportService {
  return {
    read: () => editor.getSnapshot(),
    apply: (transaction) => editor.apply(transaction),
    undo: (actor, expectedRevision) => editor.undo(actor, expectedRevision),
    redo: (actor, expectedRevision) => editor.redo(actor, expectedRevision),
    revisions: () => editor.getRevisions(),
  };
}

export function validationFailure(service: ReportService, message: string): ApplyResult {
  return {
    ok: false,
    issues: [{ code: 'validation', message }],
    currentRevision: service.read().revision,
  };
}

