import { randomUUID } from 'node:crypto';
import { appendFile, link, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { TRANSPORT_LIMITS, formatIssues, parseDocument, summarizeRevision } from '@super-solution/editor-core';
import type { EditorIssue, ResearchDocument, Revision } from '@super-solution/editor-core';

/** A caller mistake: bad arguments or content. Exit code 2. */
export class InputError extends Error {}
/** The document or input is valid but a rule refused the change. */
export class Refusal extends Error { constructor(message: string, readonly exitCode: 2 | 3 | 4) { super(message); } }

export function isFsError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Reads a text file, refusing anything above the shared size limit. */
export async function readTextFile(path: string, label = 'File'): Promise<string> {
  let size: number;
  try { size = (await stat(path)).size; }
  catch (error) { throw isFsError(error, 'ENOENT') ? new InputError(`${label} not found: ${path}`) : error; }
  if (size > TRANSPORT_LIMITS.fileBytes) throw new InputError(`${label} is larger than the ${TRANSPORT_LIMITS.fileBytes} byte limit: ${path}`);
  return (await readFile(path, 'utf8')).replace(/^﻿/, '');
}

export async function loadDocument(file: string): Promise<ResearchDocument> {
  const parsed = parseDocument(await readTextFile(file, 'Document'));
  if (!parsed.ok) throw new InvalidDocument(parsed.issues);
  return parsed.value;
}
/** The file parsed as JSON but is not a valid document; carries the issues so the caller can print them as they are. */
export class InvalidDocument extends Error {
  constructor(readonly issues: EditorIssue[]) { super(formatIssues(issues)); }
}

export async function persistAtomic(file: string, json: string, createOnly = false): Promise<void> {
  const temporary = resolve(dirname(file), `.${basename(file)}.${randomUUID()}.tmp`);
  let created = false;
  try {
    const handle = await open(temporary, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(`${json}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (createOnly) {
      // A hard link creates the target atomically and refuses existing files.
      await link(temporary, file);
    } else await rename(temporary, file);
  } finally {
    if (created) await unlink(temporary).catch((cause: unknown) => {
      // rename consumed the temp file. Cleanup errors other than absence matter.
      if (!isFsError(cause, 'ENOENT')) throw cause;
    });
  }
}

/**
 * Runs `action` while holding the exclusive `<file>.lock`. Other writers must use the same protocol (the stdio MCP server does).
 * A stale lock is never removed automatically.
 */
export async function withFileLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lockPath = `${file}.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (isFsError(error, 'EEXIST')) throw new Error('Document is locked by another CLI writer; resolve the lock before retrying.');
    throw error;
  }
  try { return await action(); }
  finally {
    await lock.close();
    await unlink(lockPath);
  }
}

/** Optional revision log next to the document: it exists only when the user created it (`--history`), and then every CLI edit appends to it. */
export const historyPath = (file: string): string => `${file}.history.jsonl`;
export async function historyExists(file: string): Promise<boolean> {
  try { await stat(historyPath(file)); return true; } catch { return false; }
}
export async function appendHistory(file: string, revisions: readonly Revision[]): Promise<void> {
  if (!revisions.length || !(await historyExists(file))) return;
  const lines = revisions.map(revision => JSON.stringify({ number: revision.number, at: revision.at, actor: revision.actor, kind: revision.kind, transactionId: revision.transactionId, summary: summarizeRevision(revision) }));
  // The log is advisory: a failure to append never turns a saved edit into an error.
  await appendFile(historyPath(file), `${lines.join('\n')}\n`, 'utf8').catch(() => undefined);
}
export async function readHistory(file: string): Promise<unknown[]> {
  if (!(await historyExists(file))) return [];
  const text = await readFile(historyPath(file), 'utf8');
  return text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as unknown]; } catch { return []; } });
}
