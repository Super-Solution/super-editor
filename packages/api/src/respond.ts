import type { EditorIssue, ReportService } from '@super-solution/editor-core';
import { withHints } from '@super-solution/editor-core';

const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } as const;

export function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...BASE_HEADERS, ...headers } });
}
export function textResponse(text: string, mediaType: string, headers?: HeadersInit): Response {
  return new Response(text, { status: 200, headers: { 'content-type': `${mediaType}; charset=utf-8`, ...BASE_HEADERS, ...headers } });
}

/** Every failure, from any route, has this shape: `{ ok: false, issues: [{ code, message, path?, blockId?, hint }], currentRevision }`. */
export function failureResponse(service: ReportService, issues: EditorIssue[], status: number, headers?: HeadersInit): Response {
  return jsonResponse({ ok: false, issues: withHints(issues), currentRevision: service.read().revision }, status, headers);
}

/** Status for a failed edit. `legacy` keeps the original rule of the Core routes: 409 for a conflict, otherwise 400. */
export function statusForIssues(issues: readonly EditorIssue[], legacy = false): number {
  if (issues.some(issue => issue.code === 'conflict')) return 409;
  if (!legacy && issues.some(issue => issue.code === 'duplicate' || issue.code === 'history')) return 409;
  if (!legacy && issues.some(issue => issue.code === 'not-found')) return 404;
  return 400;
}

/** Raised inside route handlers for request-level problems; the handler turns it into a failure response. */
export class HttpProblem extends Error {
  constructor(readonly status: number, readonly issue: EditorIssue) { super(issue.message); }
}
export const problem = (status: number, message: string, hint?: string, path?: string): HttpProblem =>
  new HttpProblem(status, { code: 'validation', message, ...(path ? { path } : {}), ...(hint ? { hint } : {}) });
