#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { Actor } from '@super-solution/editor-core';
import { TEMPLATE_KINDS, TRANSPORT_LIMITS, createDocument, createEditor, createTemplate, isTemplateKind, templateTitle } from '@super-solution/editor-core';
import { createMcpDispatcher } from './dispatcher.js';
import { FileProblem, createFileService, writeDocumentFile } from './file-store.js';

export const STDIO_HELP = `Super Editor MCP server (stdio)

Usage:
  super-editor-mcp <document.json> [options]

Serves the document file over the Model Context Protocol on stdin/stdout: tools to read and edit it,
resources for the document, outline and schemas, and prompts for drafting and reviewing reports.
Every accepted edit is saved to the file atomically before the tool call returns. Edits made to the file
by other tools are picked up before the next call.

Options:
  --actor <id[:kind]>   Provenance recorded on edits (kind: agent, human or system). Default: mcp-agent:agent
  --read-only           Expose only the read-only tools
  --create              Create the file when it does not exist (with --id; optional --title, --template, --subject)
  --id <id>             Document ID for --create
  --title <title>       Document title for --create
  --template <kind>     Start --create from a template: ${TEMPLATE_KINDS.join(', ')}
  --subject <text>      Template subject, for example a ticker
  --help, --version

Environment: SUPER_EDITOR_ACTOR and SUPER_EDITOR_READ_ONLY=1 set the defaults for --actor and --read-only.
Logs go to stderr; stdout carries only protocol messages. Exit codes: 0 normal, 1 I/O failure, 2 invalid input.
Example client configuration:  { "command": "npx", "args": ["-y", "-p", "@super-solution/editor-mcp@next", "super-editor-mcp", "report.json"] }
`;

export type StdioIo = { stdin: Readable; stdout: Writable; stderr: Writable };
class UsageError extends Error {}

function parseActor(value: string): Actor {
  const [id, kind = 'agent', ...rest] = value.split(':');
  if (rest.length || !id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !['agent', 'human', 'system'].includes(kind)) throw new UsageError('--actor must look like <id> or <id>:<agent|human|system>, for example research-bot:agent.');
  return { id, kind: kind as Actor['kind'] };
}
function parseOptions(argv: string[]) {
  return parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
    actor: { type: 'string' }, 'read-only': { type: 'boolean' }, create: { type: 'boolean' }, id: { type: 'string' }, title: { type: 'string' },
    template: { type: 'string' }, subject: { type: 'string' }, help: { type: 'boolean', short: 'h' }, version: { type: 'boolean' },
  } });
}
function packageVersion(): string {
  try { return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? '0.0.0'; }
  catch { return '0.0.0'; }
}

/**
 * Runs the server until `stdin` ends. Messages are newline-delimited JSON-RPC (the MCP stdio transport); requests are
 * handled one at a time, in order. Returns the process exit code.
 */
export async function runStdioServer(argv: string[], io: StdioIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  let parsed: ReturnType<typeof parseOptions>;
  try { parsed = parseOptions(argv); }
  catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : 'Invalid arguments.'}
Run super-editor-mcp --help.
`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) { io.stdout.write(STDIO_HELP); return 0; }
  if (values.version) { io.stdout.write(`${packageVersion()}\n`); return 0; }

  let dispatch: ReturnType<typeof createMcpDispatcher>;
  try {
    if (positionals.length !== 1 || !positionals[0]) throw new UsageError('Provide exactly one document file path.');
    const file = resolve(positionals[0]);
    const actor = parseActor(String(values.actor ?? process.env.SUPER_EDITOR_ACTOR ?? 'mcp-agent:agent'));
    const readOnly = values['read-only'] === true || process.env.SUPER_EDITOR_READ_ONLY === '1';
    if (!existsSync(file)) {
      if (!values.create) throw new FileProblem(`Document file not found: ${file}. Pass --create --id <id> to create it.`);
      if (readOnly) throw new UsageError('--create cannot be combined with --read-only.');
      if (typeof values.id !== 'string') throw new UsageError('--create requires --id <id>.');
      const template = values.template;
      if (template !== undefined && !isTemplateKind(template)) throw new UsageError(`--template must be one of: ${TEMPLATE_KINDS.join(', ')}.`);
      const subject = typeof values.subject === 'string' ? values.subject : undefined;
      let document;
      try {
        document = createDocument({ id: values.id, title: typeof values.title === 'string' ? values.title : template ? templateTitle(template, subject) : 'Untitled report' });
        if (template) {
          const editor = createEditor(document);
          const applied = editor.apply({ id: 'create-template', actor: { id: 'super-editor-mcp', kind: 'system' }, baseRevision: 0, operations: [{ type: 'insertBlocks', blocks: createTemplate(template, subject === undefined ? {} : { subject }) }] });
          if (!applied.ok) throw new FileProblem(`Template could not be applied: ${applied.issues[0]?.message ?? 'unknown error'}`, 2);
          document = applied.document;
        }
      } catch (error) {
        if (error instanceof FileProblem) throw error;
        throw new UsageError(error instanceof Error ? error.message : 'Invalid document ID or title.');
      }
      try { writeDocumentFile(file, document, true); }
      catch (error) { throw new FileProblem(`Could not create ${file}: ${error instanceof Error ? error.message : 'write failed'}`); }
      io.stderr.write(`Created ${file}\n`);
    }
    const service = createFileService(file);
    dispatch = createMcpDispatcher(service, { actor, readOnly, serverInfo: { name: 'super-editor', title: 'Super Editor', version: packageVersion() } });
    io.stderr.write(`super-editor-mcp serving ${file} as ${actor.id}:${actor.kind}${readOnly ? ' (read-only)' : ''}\n`);
  } catch (error) {
    io.stderr.write(`${error instanceof Error ? error.message : 'Could not start.'}\n`);
    return error instanceof UsageError ? 2 : error instanceof FileProblem ? error.code : 1;
  }

  const send = (value: unknown): void => { io.stdout.write(`${JSON.stringify(value)}\n`); };
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (line: string): void => {
    queue = queue.then(async () => {
      try { const response = await dispatch(line); if (response !== undefined) send(response); }
      catch { send({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Internal error.' } }); }
    });
  };

  return new Promise<number>(settle => {
    let buffer = '';
    let skipping = false;
    io.stdin.setEncoding('utf8');
    io.stdin.on('data', (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (skipping) { skipping = false; continue; }
        if (line.trim()) enqueue(line);
      }
      // A line with no end in sight that is already too long is dropped, and answered once.
      if (!skipping && Buffer.byteLength(buffer) > TRANSPORT_LIMITS.stdioMessageBytes) {
        buffer = ''; skipping = true;
        queue = queue.then(() => { send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Message exceeds ${TRANSPORT_LIMITS.stdioMessageBytes} bytes.` } }); });
      }
    });
    const finish = (): void => {
      if (buffer.trim() && !skipping) enqueue(buffer.replace(/\r$/, ''));
      buffer = '';
      void queue.then(() => settle(0));
    };
    io.stdin.on('end', finish);
    io.stdin.on('error', () => settle(1));
  });
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}
if (isMain()) process.exitCode = await runStdioServer(process.argv.slice(2));
