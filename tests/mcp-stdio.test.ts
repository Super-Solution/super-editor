import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { promisify } from 'node:util';
import { TRANSPORT_LIMITS, createDocument, createEditor, parseDocument, serializeDocument } from '../packages/core/src/index.js';
import { FileProblem, createFileService } from '../packages/mcp/src/file-store.js';
import { STDIO_HELP, runStdioServer } from '../packages/mcp/src/stdio.js';

const execFileAsync = promisify(execFile);
const now = () => '2026-10-01T00:00:00.000Z';
const initial = () => createDocument({ id: 'stdio-doc', title: 'Stdio report' }, { now });

async function scratch(): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'super-editor-mcp-'));
  return { directory, file: join(directory, 'report.json') };
}
async function cleanup(directory: string) {
  const absolute = resolve(directory);
  assert.equal(dirname(absolute), resolve(tmpdir()));
  assert.ok(basename(absolute).startsWith('super-editor-mcp-'));
  await rm(absolute, { recursive: true, force: true });
}

/** Drives the server with in-memory streams and collects every protocol line it writes. */
function harness() {
  const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
  let out = '', err = '';
  stdout.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); });
  stderr.on('data', (chunk: Buffer) => { err += chunk.toString('utf8'); });
  return {
    io: { stdin, stdout, stderr },
    send: (value: unknown) => { stdin.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`); },
    end: () => stdin.end(),
    lines: () => out.split('\n').filter(Boolean).map(line => JSON.parse(line) as { id: unknown; result?: any; error?: { code: number; message: string } }),
    raw: () => out,
    stderr: () => err,
  };
}
const request = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method, params });

test('the stdio server handshakes, edits the file atomically and exits when the client closes', async () => {
  const { directory, file } = await scratch();
  try {
    await writeFile(file, serializeDocument(initial()));
    const client = harness();
    const exit = runStdioServer([file, '--actor', 'bot-1:agent'], client.io);
    client.send(request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send(request(2, 'tools/list'));
    client.send(request(3, 'tools/call', { name: 'insert_blocks', arguments: { markdown: '# Findings\n\nInflation cooled.' } }));
    client.send('{not json');
    client.send(request(4, 'tools/call', { name: 'get_outline', arguments: {} }));
    client.end();
    assert.equal(await exit, 0);
    const lines = client.lines();
    assert.deepEqual(lines.map(line => line.id), [1, 2, 3, null, 4], 'one response per request, in order, none for the notification');
    assert.equal(lines[0]!.result.serverInfo.name, 'super-editor');
    assert.match(lines[0]!.result.serverInfo.version, /^\d+\.\d+\.\d+/);
    assert.ok(lines[1]!.result.tools.length > 20);
    assert.equal(lines[2]!.result.isError, undefined, JSON.stringify(lines[2]));
    assert.equal(lines[2]!.result.structuredContent.revision, 1);
    assert.equal(lines[3]!.error!.code, -32700);
    assert.equal(lines[4]!.result.structuredContent.revision, 1);
    assert.match(client.stderr(), /serving .*report\.json as bot-1:agent/);
    assert.doesNotMatch(client.raw(), /serving/, 'stdout carries protocol messages only');

    const saved = parseDocument(await readFile(file, 'utf8'));
    assert.ok(saved.ok);
    assert.equal(saved.value.revision, 1);
    assert.equal(saved.value.blocks.length, 2);
    assert.deepEqual((await readdir(directory)).sort(), ['report.json'], 'no temp or lock files remain');
  } finally { await cleanup(directory); }
});

test('edits made to the file by someone else are picked up before the next call', async () => {
  const { directory, file } = await scratch();
  try {
    await writeFile(file, serializeDocument(initial()));
    const client = harness();
    const exit = runStdioServer([file], client.io);
    client.send(request(1, 'tools/call', { name: 'set_title', arguments: { title: 'From the agent' } }));
    // A person edits the file through another tool between two calls.
    for (let attempt = 0; attempt < 200 && client.lines().length < 1; attempt++) await new Promise(settle => setTimeout(settle, 10));
    assert.equal(client.lines().length, 1);
    const current = parseDocument(await readFile(file, 'utf8'));
    assert.ok(current.ok);
    const external = createEditor(current.value);
    const applied = external.apply({ id: 'human-edit', actor: { id: 'person', kind: 'human' }, baseRevision: 1, operations: [{ type: 'insertBlock', block: { id: 'human-note', parentId: null, citationIds: [], content: { type: 'paragraph', runs: [{ text: 'Human note' }] } } }] });
    assert.ok(applied.ok);
    await writeFile(file, serializeDocument(applied.document));
    client.send(request(2, 'tools/call', { name: 'find_blocks', arguments: { text: 'human' } }));
    client.send(request(3, 'tools/call', { name: 'update_block_text', arguments: { blockId: 'human-note', expectedVersion: 1, text: 'Agent follow-up' } }));
    client.end();
    assert.equal(await exit, 0);
    const lines = client.lines();
    assert.equal(lines[1]!.result.structuredContent.total, 1, 'the human block is visible');
    assert.equal(lines[2]!.result.isError, undefined, JSON.stringify(lines[2]));
    const saved = parseDocument(await readFile(file, 'utf8'));
    assert.ok(saved.ok);
    assert.equal(saved.value.title, 'From the agent');
    assert.equal(saved.value.revision, 3);
    assert.deepEqual(saved.value.blocks[0]!.content, { type: 'paragraph', runs: [{ text: 'Agent follow-up' }] });
  } finally { await cleanup(directory); }
});

test('a read-only server never writes, and refused writes leave the file bytes alone', async () => {
  const { directory, file } = await scratch();
  try {
    await writeFile(file, serializeDocument(initial()));
    const before = await readFile(file, 'utf8');
    const client = harness();
    const exit = runStdioServer([file, '--read-only'], client.io);
    client.send(request(1, 'tools/list'));
    client.send(request(2, 'tools/call', { name: 'set_title', arguments: { title: 'x' } }));
    client.send(request(3, 'tools/call', { name: 'get_outline', arguments: {} }));
    client.end();
    assert.equal(await exit, 0);
    const lines = client.lines();
    assert.ok(lines[0]!.result.tools.every((entry: { annotations: { readOnlyHint: boolean } }) => entry.annotations.readOnlyHint));
    assert.equal(lines[1]!.result.isError, true);
    assert.equal(lines[2]!.result.isError, undefined);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.match(client.stderr(), /\(read-only\)/);
  } finally { await cleanup(directory); }
});

test('startup problems exit with a clear message and the documented code', async () => {
  const { directory, file } = await scratch();
  try {
    const run = async (argv: string[]) => { const client = harness(); const code = await runStdioServer(argv, client.io); return { code, stdout: client.raw(), stderr: client.stderr() }; };
    const missing = await run([file]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /not found.*--create/);
    await writeFile(file, '{"not":"a document"}');
    const invalid = await run([file]);
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /not a valid Super Editor document/);
    assert.match(invalid.stderr, /hint:/);
    assert.equal((await run([])).code, 2);
    assert.equal((await run([file, 'extra'])).code, 2);
    assert.equal((await run([file, '--nope'])).code, 2);
    assert.equal((await run([file, '--actor', 'bad actor'])).code, 2);
    assert.equal((await run([file, '--actor', 'x:robot'])).code, 2);
    const help = await run(['--help']);
    assert.equal(help.code, 0);
    assert.equal(help.stdout, STDIO_HELP);
    assert.match(help.stdout, /--read-only/);
    const version = await run(['--version']);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^\d+\.\d+\.\d+/);
    assert.equal(await readFile(file, 'utf8'), '{"not":"a document"}');
  } finally { await cleanup(directory); }
});

test('--create starts a new document, optionally from a template, and never overwrites', async () => {
  const { directory, file } = await scratch();
  try {
    const refused = harness();
    assert.equal(await runStdioServer([file, '--create'], refused.io), 2);
    assert.match(refused.stderr(), /--id/);
    assert.equal(existsSync(file), false);

    const client = harness();
    const exit = runStdioServer([file, '--create', '--id', 'macro-1', '--template', 'macro', '--subject', 'the euro area'], client.io);
    client.send(request(1, 'tools/call', { name: 'get_outline', arguments: {} }));
    client.end();
    assert.equal(await exit, 0);
    const outline = client.lines()[0]!.result.structuredContent;
    assert.equal(outline.title, 'the euro area: macro outlook');
    assert.ok(outline.outline.some((entry: { title: string }) => entry.title === 'Data and methodology'));
    const created = await readFile(file, 'utf8');
    assert.ok(parseDocument(created).ok);

    const again = harness();
    again.end();
    assert.equal(await runStdioServer([file, '--create', '--id', 'other'], again.io), 0, 'an existing file is served as is');
    assert.equal(await readFile(file, 'utf8'), created);
    const badTemplate = harness();
    assert.equal(await runStdioServer([join(directory, 'other.json'), '--create', '--id', 'x', '--template', 'nope'], badTemplate.io), 2);
    assert.equal(existsSync(join(directory, 'other.json')), false);
  } finally { await cleanup(directory); }
});

test('an oversized message is rejected once and the server keeps working', async () => {
  const { directory, file } = await scratch();
  try {
    await writeFile(file, serializeDocument(initial()));
    const client = harness();
    const exit = runStdioServer([file], client.io);
    client.io.stdin.write('x'.repeat(TRANSPORT_LIMITS.stdioMessageBytes + 10));
    client.io.stdin.write('x'.repeat(100));
    client.io.stdin.write('\n');
    client.send(request(1, 'ping'));
    client.end();
    assert.equal(await exit, 0);
    const lines = client.lines();
    assert.equal(lines.length, 2);
    assert.equal(lines[0]!.error!.code, -32600);
    assert.match(lines[0]!.error!.message, /exceeds/);
    assert.deepEqual(lines[1]!.result, {});
  } finally { await cleanup(directory); }
});

test('the file service coordinates through the lock file, saves atomically and keeps an optional history log', async () => {
  const { directory, file } = await scratch();
  try {
    await writeFile(file, serializeDocument(initial()));
    const service = createFileService(file, { lockWaitMs: 40 });
    const edit = (id: string, baseRevision: number) => ({ id, actor: { id: 'a', kind: 'agent' }, baseRevision, operations: [{ type: 'setTitle', title: id }] });

    await writeFile(`${file}.lock`, 'held by someone else');
    const blocked = service.apply(edit('first', 0));
    assert.equal(blocked.ok, false);
    assert.match((blocked as { issues: { message: string }[] }).issues[0]!.message, /locked/);
    assert.equal(await readFile(`${file}.lock`, 'utf8'), 'held by someone else', 'a foreign lock is never removed');
    await rm(`${file}.lock`);

    assert.equal(existsSync(`${file}.history.jsonl`), false);
    assert.equal(service.apply(edit('first', 0)).ok, true);
    assert.equal(existsSync(`${file}.history.jsonl`), false, 'no history log unless one exists');
    await writeFile(`${file}.history.jsonl`, '');
    assert.equal(service.apply(edit('second', 1)).ok, true);
    const history = (await readFile(`${file}.history.jsonl`, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { number: number; actor: { id: string }; summary: string });
    assert.deepEqual(history.map(entry => entry.number), [2]);
    assert.match(history[0]!.summary, /renamed the document/);
    assert.equal(service.undo({ id: 'a', kind: 'agent' }, 2).ok, true);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).title, 'first');
    assert.equal(service.read().revision, 3);
    assert.equal(service.revisions?.().length, 3);
    assert.deepEqual((await readdir(directory)).sort(), ['report.json', 'report.json.history.jsonl']);

    assert.throws(() => createFileService(join(directory, 'missing.json')), (error: unknown) => error instanceof FileProblem && error.code === 1);
    await writeFile(file, '{');
    assert.throws(() => createFileService(file), (error: unknown) => error instanceof FileProblem && error.code === 2);
  } finally { await cleanup(directory); }
});

test('the built server binary also starts when launched through a symlink', async (t) => {
  const built = resolve('packages/mcp/dist/stdio.js');
  if (!existsSync(built)) { t.skip('run npm run build first'); return; }
  const { directory } = await scratch();
  try {
    const link = join(directory, 'super-editor-mcp');
    try { await symlink(built, link); }
    catch { t.skip('symlinks are not permitted here'); return; }
    const { stdout } = await execFileAsync(process.execPath, [link, '--help']);
    assert.equal(stdout, STDIO_HELP);
  } finally { await cleanup(directory); }
});
