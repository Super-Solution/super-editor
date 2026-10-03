import type { Actor, ApplyResult, Editor, ResearchDocument } from '@super-editor/core';

/** Session-scoped facade. Persistence and access control belong to the host. */
export interface ReportService {
  read(): ResearchDocument;
  apply(transaction: unknown): ApplyResult;
  undo(actor: Actor, expectedRevision: number): ApplyResult;
  redo(actor: Actor, expectedRevision: number): ApplyResult;
}

export function createReportService(editor: Editor): ReportService {
  return {
    read: () => editor.getSnapshot(),
    apply: (transaction) => editor.apply(transaction),
    undo: (actor, expectedRevision) => editor.undo(actor, expectedRevision),
    redo: (actor, expectedRevision) => editor.redo(actor, expectedRevision),
  };
}

export function validationFailure(service: ReportService, message: string): ApplyResult {
  return {
    ok: false,
    issues: [{ code: 'validation', message }],
    currentRevision: service.read().revision,
  };
}

export function resultStatus(result: ApplyResult): number {
  return result.ok ? 200 : result.issues.some((issue) => issue.code === 'conflict') ? 409 : 400;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
