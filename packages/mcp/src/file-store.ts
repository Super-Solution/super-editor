import { randomUUID } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, fsyncSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import type { ApplyResult, EditorIssue, ReportService, ResearchDocument } from '@super-solution/editor-core';
import { TRANSPORT_LIMITS, createEditor, createReportService, formatIssues, parseDocument, serializeDocument, summarizeRevision, withHints } from '@super-solution/editor-core';

/** A problem with the document file itself. `code` follows the CLI exit codes: 1 I/O, 2 invalid content. */
export class FileProblem extends Error {
  constructor(message: string, readonly code: 1 | 2 = 1) { super(message); }
}
const isFsError = (error: unknown, code: string): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === code;
const sleep = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export function readDocumentText(path: string): string {
  let size: number;
  try { size = statSync(path).size; }
  catch (error) { throw new FileProblem(isFsError(error, 'ENOENT') ? `Document file not found: ${path}` : `Cannot read ${path}.`); }
  if (size > TRANSPORT_LIMITS.fileBytes) throw new FileProblem(`${path} is larger than the ${TRANSPORT_LIMITS.fileBytes} byte limit.`, 2);
  return readFileSync(path, 'utf8').replace(/^﻿/, '');
}
export function parseDocumentText(text: string, path: string): ResearchDocument {
  const parsed = parseDocument(text);
  if (!parsed.ok) throw new FileProblem(`${path} is not a valid Super Editor document.\n${formatIssues(parsed.issues)}`, 2);
  return parsed.value;
}

/** Writes via a temporary file and rename so a reader never sees a half-written document. `createOnly` refuses to replace a file. */
export function writeDocumentFile(path: string, document: ResearchDocument, createOnly = false): string {
  const json = `${serializeDocument(document)}\n`;
  const temporary = resolve(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = openSync(temporary, 'wx', 0o600);
  try {
    try { writeSync(handle, json, null, 'utf8'); fsyncSync(handle); }
    finally { closeSync(handle); }
    if (createOnly) linkSync(temporary, path); else renameSync(temporary, path);
  } finally {
    try { unlinkSync(temporary); } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  }
  return json;
}

/** Exclusive `<file>.lock`, the same protocol the CLI uses, so a CLI write and this server never interleave. */
function withLock<T>(path: string, waitMs: number, action: () => T): T {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + waitMs;
  let handle: number;
  for (;;) {
    try { handle = openSync(lockPath, 'wx', 0o600); break; }
    catch (error) {
      if (!isFsError(error, 'EEXIST')) throw error;
      if (Date.now() >= deadline) throw new FileProblem(`Document is locked by another writer (${lockPath}). Retry shortly; if no other process is writing, delete the lock file.`);
      sleep(25);
    }
  }
  try { return action(); }
  finally { closeSync(handle); try { unlinkSync(lockPath); } catch { /* already gone */ } }
}

export type FileServiceOptions = { lockWaitMs?: number };

/**
 * A ReportService over one JSON file. It picks up edits made to the file by other tools (a person, the CLI) before the
 * next call, applies each change under the file lock and saves it atomically before reporting success. If saving
 * fails the in-memory document is reloaded from disk, so memory never gets ahead of the file.
 */
export function createFileService(path: string, options: FileServiceOptions = {}): ReportService {
  const file = resolve(path);
  const lockWaitMs = options.lockWaitMs ?? 2_000;
  const historyPath = `${file}.history.jsonl`;
  let text = readDocumentText(file);
  let service = createReportService(createEditor(parseDocumentText(text, file)));
  let seen = fingerprint();

  function fingerprint(): string { try { const stats = statSync(file); return `${stats.mtimeMs}:${stats.size}`; } catch { return 'missing'; } }
  function reload(): void {
    const next = readDocumentText(file);
    if (next !== text) { service = createReportService(createEditor(parseDocumentText(next, file))); text = next; }
    seen = fingerprint();
  }
  const refresh = (): void => { if (fingerprint() !== seen) { try { reload(); } catch { /* keep serving the last good state */ } } };
  const failure = (issues: EditorIssue[]): ApplyResult => ({ ok: false, issues: withHints(issues), currentRevision: service.read().revision });

  function mutate(action: () => ApplyResult): ApplyResult {
    try {
      return withLock(file, lockWaitMs, () => {
        reload();
        const result = action();
        if (!result.ok) return result;
        try {
          text = writeDocumentFile(file, result.document);
          seen = fingerprint();
        } catch (cause) {
          try { reload(); } catch { /* the next call reports it */ }
          return failure([{ code: 'conflict', message: `The change could not be saved to ${basename(file)}; nothing was changed.`, hint: `Check permissions and free disk space, then retry. (${cause instanceof Error ? cause.message : 'write failed'})` }]);
        }
        if (existsSync(historyPath)) {
          try { appendFileSync(historyPath, `${JSON.stringify({ number: result.revision.number, at: result.revision.at, actor: result.revision.actor, kind: result.revision.kind, transactionId: result.revision.transactionId, summary: summarizeRevision(result.revision) })}\n`); }
          catch { /* the history log is advisory */ }
        }
        return result;
      });
    } catch (cause) {
      return failure([{ code: 'conflict', message: cause instanceof Error ? cause.message : 'The document file could not be used.', hint: 'Retry shortly. If the file was replaced by invalid content, restore it.' }]);
    }
  }

  return {
    read: () => { refresh(); return service.read(); },
    apply: transaction => mutate(() => service.apply(transaction)),
    undo: (actor, expectedRevision) => mutate(() => service.undo(actor, expectedRevision)),
    redo: (actor, expectedRevision) => mutate(() => service.redo(actor, expectedRevision)),
    revisions: () => service.revisions?.() ?? [],
  };
}
