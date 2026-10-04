import type { EditorIssue } from './types.js';

/** A generic remediation by issue code, used when the specific check did not attach a more precise `hint`. */
export function defaultHint(issue: Pick<EditorIssue, 'code' | 'path'>): string {
  switch (issue.code) {
    case 'validation': return issue.path ? `Compare "${issue.path}" with the JSON schemas (documentSchema, transactionSchema) and the limits in LIMITS.` : 'Compare the input with the JSON schemas (documentSchema, transactionSchema) and the limits in LIMITS.';
    case 'conflict': return 'Re-read the document, then rebuild the transaction from its current revision and block versions. Do not retry by removing the guards.';
    case 'not-found': return 'The block or citation does not exist (any more) or its ID is misspelled. Read the document to list current IDs.';
    case 'duplicate': return 'Choose a different ID. IDs of deleted blocks and of already used transactions stay reserved.';
    case 'history': return 'Undo and redo only cover edits made in this editor session and need the current document revision.';
  }
}
/** Returns the issues with a `hint` on every entry, leaving specific hints untouched. */
export function withHints(issues: readonly EditorIssue[]): EditorIssue[] {
  return issues.map(issue => issue.hint ? { ...issue } : { ...issue, hint: defaultHint(issue) });
}
/** Plain-text rendering for logs, CLIs and model-facing error messages: one issue per line, the hint indented below. */
export function formatIssues(issues: readonly EditorIssue[]): string {
  return withHints(issues).map(issue => `- [${issue.code}] ${issue.path ? `${issue.path}: ` : ''}${issue.message}${issue.blockId ? ` (block ${issue.blockId})` : ''}\n  hint: ${issue.hint}`).join('\n');
}
