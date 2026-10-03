#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { link, open, readFile, rename, unlink } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createDocument, createEditor, parseDocument, serializeDocument } from '@super-editor/core';
import { createReportService } from './service.js';

export const CLI_HELP = `Super Editor local JSON CLI

Usage:
  super-editor init <document.json> --id <id> [--title <title>]
  super-editor read <document.json>
  super-editor apply <document.json> <transaction.json>
  super-editor help

init refuses to overwrite an existing file. apply validates the entire batch
through the Core and atomically replaces the document only on success.
Revision/version guards are mandatory. Undo/redo is session-only; use the API
for an ongoing editor session. This command does not start a network server.
Exit codes: 0 success, 1 IO failure, 2 invalid input, 3 revision conflict.
`;

export type CliOutput = { stdout(text: string): void; stderr(text: string): void };
const standardOutput: CliOutput = {
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
};

class InputError extends Error {}

function initOptions(args: string[]): { id: string; title: string } {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== '--id' && flag !== '--title') || value === undefined || options.has(flag)) {
      throw new InputError('init requires --id <id> and optionally --title <title>, with no duplicate options.');
    }
    options.set(flag, value);
  }
  const id = options.get('--id');
  if (id === undefined) throw new InputError('init requires --id <id>.');
  return { id, title: options.get('--title') ?? 'Untitled research report' };
}

async function persistAtomic(file: string, json: string, createOnly = false): Promise<void> {
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

function isFsError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

/** Local runner also usable by tests and another trusted CLI host. */
export async function runCli(args: string[], output: CliOutput = standardOutput): Promise<number> {
  const command = args[0];
  if (args.length === 0 || (args.length === 1 && ['help', '--help', '-h'].includes(command ?? ''))) {
    output.stdout(CLI_HELP);
    return 0;
  }
  try {
    if (!['init', 'read', 'apply'].includes(command ?? '')) throw new InputError('Unknown command. Run super-editor help.');
    const target = args[1];
    if (target === undefined || target.length === 0) throw new InputError('A document file path is required.');
    const file = resolve(target);
    if (command === 'init') {
      const options = initOptions(args.slice(2));
      let serialized: string;
      try { serialized = serializeDocument(createDocument(options)); }
      catch { throw new InputError('Invalid document ID or title.'); }
      await persistAtomic(file, serialized, true);
      output.stdout(`${serialized}\n`);
      return 0;
    }
    if (command === 'read') {
      if (args.length !== 2) throw new InputError('read takes one document path.');
      const parsed = parseDocument(await readFile(file, 'utf8'));
      if (!parsed.ok) {
        output.stderr(`${JSON.stringify(parsed)}\n`);
        return 2;
      }
      output.stdout(`${serializeDocument(parsed.value)}\n`);
      return 0;
    }
    const transactionFile = args[2];
    if (args.length !== 3 || !transactionFile) throw new InputError('apply requires document and transaction file paths.');

    // Exclusive lock coordinates this CLI's read/validate/write sequence.
    // Other writers must participate in the same lock protocol.
    const lockPath = `${file}.lock`;
    let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (isFsError(error, 'EEXIST')) throw new Error('Document is locked by another CLI writer; resolve the lock before retrying.');
      throw error;
    }
    try {
      const parsed = parseDocument(await readFile(file, 'utf8'));
      if (!parsed.ok) {
        output.stderr(`${JSON.stringify(parsed)}\n`);
        return 2;
      }
      let transaction: unknown;
      const transactionJson = await readFile(resolve(transactionFile), 'utf8');
      try { transaction = JSON.parse(transactionJson) as unknown; }
      catch { throw new InputError('Transaction file must contain valid JSON.'); }
      const result = createReportService(createEditor(parsed.value)).apply(transaction);
      if (!result.ok) {
        output.stderr(`${JSON.stringify(result)}\n`);
        return result.issues.some((issue) => issue.code === 'conflict') ? 3 : 2;
      }
      await persistAtomic(file, serializeDocument(result.document));
      output.stdout(`${JSON.stringify(result)}\n`);
      return 0;
    } finally {
      await lock.close();
      await unlink(lockPath);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Local CLI operation failed.';
    output.stderr(`${JSON.stringify({ ok: false, error: message })}\n`);
    return error instanceof InputError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
