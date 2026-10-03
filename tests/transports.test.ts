import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { createDocument, createEditor, serializeDocument } from '../packages/core/src/index.js';
import type { Actor, Transaction } from '../packages/core/src/index.js';
import { createHttpHandler, createMcpDispatcher, createReportService, documentSchema, transactionSchema } from '../packages/transports/src/index.js';
import type { JsonRpcResponse, McpToolResult } from '../packages/transports/src/index.js';
import { runCli } from '../packages/transports/src/cli.js';

const now = () => '2026-10-03T00:00:00.000Z';
const agent: Actor = { id: 'research-agent', kind: 'agent' };
const human: Actor = { id: 'research-owner', kind: 'human' };
const initial = () => createDocument({ id: 'macro-weekly', title: 'Macro weekly' }, { now });
const service = () => createReportService(createEditor(initial(), { now }));
const insert: Transaction = {
  id: 'initial-agent-edit', actor: agent, baseRevision: 0,
  operations: [{ type: 'insertBlock', block: {
    id: 'summary', parentId: null, citationIds: [],
    content: { type: 'paragraph', runs: [{ text: 'Illustrative research.' }] },
  } }],
};

function request(path: string, body: unknown, method = 'POST') {
  return new Request(`http://local${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function tool(response: JsonRpcResponse | undefined): McpToolResult {
  assert.ok(response && 'result' in response);
  return response.result as McpToolResult;
}

function call(name: string, args: Record<string, unknown>, id = 1) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

test('service, HTTP, and MCP apply identical atomic operations and preserve guarded conflict results', async () => {
  const direct = service();
  const httpService = service();
  const mcpService = service();
  const http = createHttpHandler(httpService);
  const mcp = createMcpDispatcher(mcpService);
  const directResult = direct.apply(insert);
  const httpResponse = await http(request('/transactions', insert));
  assert.equal(httpResponse.status, 200);
  assert.equal(httpResponse.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await httpResponse.json(), directResult);
  const mcpResult = tool(await mcp(call('apply_transaction', { transaction: insert })));
  assert.deepEqual(mcpResult.structuredContent, directResult);
  assert.deepEqual(JSON.parse(mcpResult.content[0]!.text), directResult);
  assert.deepEqual(await (await http(new Request('http://local/document'))).json(), direct.read());
  assert.deepEqual(tool(await mcp(call('read_document', {}))).structuredContent, direct.read());

  const guardedEdit: Transaction = {
    id: 'human-edit', actor: human, baseRevision: 1,
    operations: [{ type: 'updateBlock', blockId: 'summary', expectedVersion: 1,
      content: { type: 'paragraph', runs: [{ text: 'Human revised this summary.' }] } }],
  };
  const result = direct.apply(guardedEdit);
  assert.deepEqual(await (await http(request('/transactions', guardedEdit))).json(), result);
  assert.deepEqual(tool(await mcp(call('apply_transaction', { transaction: guardedEdit }))).structuredContent, result);
  const staleEdit: Transaction = { ...guardedEdit, id: 'stale-agent', actor: agent, conflictPolicy: 'rebase-safe' };
  const rejected = direct.apply(staleEdit);
  assert.equal(rejected.ok, false);
  const conflict = await http(request('/transactions', staleEdit));
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), rejected);
  const rejectedMcp = tool(await mcp(call('apply_transaction', { transaction: staleEdit })));
  assert.equal(rejectedMcp.isError, true);
  assert.deepEqual(rejectedMcp.structuredContent, rejected);
  assert.deepEqual(httpService.read(), direct.read());
  assert.deepEqual(mcpService.read(), direct.read());
});

test('all adapters reject dangerous URLs and invalid batches without partial writes', async () => {
  const direct = service();
  const httpService = service();
  const mcpService = service();
  const invalid = { ...insert, operations: [
    ...insert.operations,
    { type: 'insertBlock', block: { id: 'unsafe', parentId: null, citationIds: [], content: {
      type: 'paragraph', runs: [{ text: 'Unsafe link', href: 'javascript:alert(1)' }],
    } } },
  ] };
  const before = direct.read();
  const rejected = direct.apply(invalid);
  assert.equal(rejected.ok, false);
  const response = await createHttpHandler(httpService)(request('/transactions', invalid));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), rejected);
  const mcpResult = tool(await createMcpDispatcher(mcpService)(call('apply_transaction', { transaction: invalid })));
  assert.equal(mcpResult.isError, true);
  assert.deepEqual(mcpResult.structuredContent, rejected);
  for (const instance of [direct, httpService, mcpService]) assert.deepEqual(instance.read(), before);
});

test('HTTP validates malformed, oversized, and history input before mutation', async () => {
  const instance = service();
  const http = createHttpHandler(instance, { maxBodyBytes: 512 });
  const before = instance.read();
  for (const body of ['{bad json', 'x'.repeat(513)]) {
    const response = await http(new Request('http://local/transactions', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
    }));
    assert.equal(response.status, 400);
  }
  const invalidUtf8 = await http(new Request('http://local/transactions', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array([0xff]),
  }));
  assert.equal(invalidUtf8.status, 400);
  assert.equal((await http(request('/undo', { actor: null, expectedRevision: 0 }))).status, 400);
  assert.equal((await http(request('/undo', { actor: agent, expectedRevision: '0' }))).status, 400);
  assert.equal((await http(request('/undo', { actor: agent, expectedRevision: 0, extra: true }))).status, 400);
  const wrongMethod = await http(new Request('http://local/undo'));
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  assert.equal((await http(new Request('http://local/not-supported'))).status, 404);
  assert.deepEqual(instance.read(), before);
  assert.throws(() => createHttpHandler(instance, { maxBodyBytes: 0 }));
});

test('HTTP and MCP undo/redo share exact guards and session history', async () => {
  const direct = service();
  const viaHttp = service();
  const viaMcp = service();
  for (const instance of [direct, viaHttp, viaMcp]) assert.equal(instance.apply(insert).ok, true);
  const http = createHttpHandler(viaHttp);
  const mcp = createMcpDispatcher(viaMcp);
  const undone = direct.undo(human, 1);
  assert.equal(undone.ok, true);
  assert.deepEqual(await (await http(request('/undo', { actor: human, expectedRevision: 1 }))).json(), undone);
  assert.deepEqual(tool(await mcp(call('undo', { actor: human, expectedRevision: 1 }))).structuredContent, undone);
  const redone = direct.redo(human, 2);
  assert.equal(redone.ok, true);
  assert.deepEqual(await (await http(request('/redo', { actor: human, expectedRevision: 2 }))).json(), redone);
  assert.deepEqual(tool(await mcp(call('redo', { actor: human, expectedRevision: 2 }))).structuredContent, redone);
  assert.deepEqual(viaHttp.read(), direct.read());
  assert.deepEqual(viaMcp.read(), direct.read());
  assert.equal((await http(request('/undo', { actor: human, expectedRevision: 1 }))).status, 409);
});

test('MCP exposes typed tools, handles protocol errors and notifications, and rejects invalid arguments', async () => {
  const instance = service();
  const mcp = createMcpDispatcher(instance);
  const list = await mcp({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
  assert.ok(list && 'result' in list);
  const discovered = list.result as { tools: { name: string; inputSchema: Record<string, unknown> }[] };
  assert.deepEqual(discovered.tools.map((item) => item.name), ['read_document', 'apply_transaction', 'undo', 'redo']);
  assert.ok(discovered.tools[1]!.inputSchema.$defs);
  discovered.tools[0]!.name = 'tampered';
  const next = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(next && 'result' in next);
  assert.equal((next.result as typeof discovered).tools[0]!.name, 'read_document');
  assert.deepEqual(await mcp('{invalid'), { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error.' } });
  for (const invalid of [[], { jsonrpc: '2.0', id: true, method: 'tools/call' }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: [] }]) {
    const response = await mcp(invalid);
    assert.ok(response && 'error' in response);
    assert.equal(response.error.code, -32600);
  }
  const unknown = await mcp(call('unknown_tool', {}));
  assert.ok(unknown && 'error' in unknown);
  assert.equal(unknown.error.code, -32602);
  const incomplete = tool(await mcp(call('apply_transaction', {})));
  assert.equal(incomplete.isError, true);
  const invalidHistory = tool(await mcp(call('undo', { actor: 'agent', expectedRevision: 0 })));
  assert.equal(invalidHistory.isError, true);
  assert.equal(instance.read().revision, 0);
  const notification = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'apply_transaction', arguments: { transaction: insert } } };
  assert.equal(await mcp(JSON.stringify(notification)), undefined);
  assert.equal(instance.read().revision, 1);
});

test('MCP rejects accessor envelopes and unsafe proxies without invoking getters or mutating state', async () => {
  const instance = service();
  const mcp = createMcpDispatcher(instance);
  let getterCalls = 0;
  let introspectionCalls = 0;
  const getter = () => { getterCalls++; throw new Error('Getter must not run.'); };
  const trap = () => { introspectionCalls++; throw new Error('Introspection failed.'); };
  const accessorEnvelope = Object.defineProperty({}, 'jsonrpc', { get: getter });
  const accessorParams = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: Object.defineProperty({}, 'name', { get: getter }) };
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const invalid = [
    accessorEnvelope, accessorParams, revoked.proxy,
    new Proxy({}, { get: getter }),
    new Proxy({}, { getPrototypeOf: trap }),
    new Proxy({}, { ownKeys: trap }),
    new Proxy({ jsonrpc: '2.0' }, { getOwnPropertyDescriptor: trap }),
  ];
  for (const value of invalid) {
    const response = await mcp(value);
    assert.ok(response && 'error' in response);
    assert.equal(response.error.code, -32600);
  }
  // Only proxy introspection traps may be called; property getters/get traps are not.
  assert.equal(introspectionCalls, 3);
  assert.equal(getterCalls, 0);
  const accessorArgs = Object.defineProperty({}, 'transaction', { get: getter });
  const response = await mcp(call('apply_transaction', accessorArgs));
  assert.ok(response && 'error' in response);
  assert.equal(response.error.code, -32602);
  assert.equal(getterCalls, 0);
  const dataProxy = new Proxy({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, { get: getter });
  const safeResult = await mcp(dataProxy);
  assert.ok(safeResult && 'result' in safeResult);
  assert.equal(getterCalls, 0);
  assert.deepEqual(instance.read(), initial());
});

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { stdout: (value: string) => { out.push(value); }, stderr: (value: string) => { err.push(value); } } };
}

async function cleanup(directory: string) {
  const absolute = resolve(directory);
  assert.equal(dirname(absolute), resolve(tmpdir()));
  assert.ok(basename(absolute).startsWith('super-editor-cli-'));
  await rm(absolute, { recursive: true, force: true });
}

test('CLI persists accepted Core edits and leaves exact original bytes on invalid/conflicting edits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'super-editor-cli-'));
  const documentPath = join(directory, 'report.json');
  const transactionPath = join(directory, 'transaction.json');
  try {
    await writeFile(documentPath, serializeDocument(initial()));
    await writeFile(transactionPath, JSON.stringify(insert));
    const output = capture();
    assert.equal(await runCli(['apply', documentPath, transactionPath], output.io), 0);
    const applied = JSON.parse(output.out[0]!) as { ok: boolean; document: { revision: number; blocks: { id: string }[] } };
    assert.equal(applied.ok, true);
    assert.equal(applied.document.revision, 1);
    assert.equal(applied.document.blocks[0]!.id, 'summary');
    const persisted = await readFile(documentPath, 'utf8');
    assert.deepEqual(JSON.parse(persisted), applied.document);
    const invalid = { ...insert, id: 'invalid-next', baseRevision: 1, operations: [{ type: 'setTitle', title: 42 }] };
    await writeFile(transactionPath, JSON.stringify(invalid));
    assert.equal(await runCli(['apply', documentPath, transactionPath], capture().io), 2);
    assert.equal(await readFile(documentPath, 'utf8'), persisted);
    await writeFile(transactionPath, JSON.stringify({ ...insert, id: 'stale-next' }));
    assert.equal(await runCli(['apply', documentPath, transactionPath], capture().io), 3);
    assert.equal(await readFile(documentPath, 'utf8'), persisted);
    await writeFile(transactionPath, '{invalid-json');
    assert.equal(await runCli(['apply', documentPath, transactionPath], capture().io), 2);
    assert.equal(await readFile(documentPath, 'utf8'), persisted);
    assert.deepEqual((await readdir(directory)).sort(), ['report.json', 'transaction.json']);
  } finally { await cleanup(directory); }
});

test('CLI init refuses overwrite, read validates, and an existing lock is preserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'super-editor-cli-'));
  const documentPath = join(directory, 'report.json');
  const transactionPath = join(directory, 'transaction.json');
  try {
    assert.equal(await runCli(['init', documentPath, '--id', 'weekly', '--title', 'Research'], capture().io), 0);
    const before = await readFile(documentPath, 'utf8');
    assert.equal(await runCli(['init', documentPath, '--id', 'different'], capture().io), 1);
    assert.equal(await readFile(documentPath, 'utf8'), before);
    const output = capture();
    assert.equal(await runCli(['read', documentPath], output.io), 0);
    assert.deepEqual(JSON.parse(output.out[0]!), JSON.parse(before));
    await writeFile(transactionPath, JSON.stringify(insert));
    await writeFile(`${documentPath}.lock`, 'owned by another writer');
    assert.equal(await runCli(['apply', documentPath, transactionPath], capture().io), 1);
    assert.equal(await readFile(documentPath, 'utf8'), before);
    assert.equal(await readFile(`${documentPath}.lock`, 'utf8'), 'owned by another writer');
    await writeFile(documentPath, '{invalid');
    assert.equal(await runCli(['read', documentPath], capture().io), 2);
    assert.equal(await runCli(['undo', documentPath], capture().io), 2);
    assert.equal(await runCli(['init', join(directory, 'missing-id.json')], capture().io), 2);
    assert.equal(await runCli(['help'], capture().io), 0);
  } finally { await cleanup(directory); }
});

test('exported v1 schemas contain persisted metadata and only resolvable local references', () => {
  for (const schema of [documentSchema, transactionSchema]) {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    const definitions = schema.$defs as Record<string, unknown>;
    function inspect(value: unknown) {
      if (!value || typeof value !== 'object') return;
      for (const [key, nested] of Object.entries(value)) {
        if (key === '$ref') {
          assert.equal(typeof nested, 'string');
          assert.ok((nested as string).startsWith('#/$defs/'));
          assert.ok(Object.hasOwn(definitions, (nested as string).slice('#/$defs/'.length)));
        } else inspect(nested);
      }
    }
    inspect(schema);
  }
  assert.equal(documentSchema.$id, 'urn:super-editor:document:1');
  assert.equal(transactionSchema.$id, 'urn:super-editor:transaction:1');
  const properties = documentSchema.properties as Record<string, unknown>;
  assert.deepEqual(properties.schemaVersion, { const: 1 });
  const definitions = documentSchema.$defs as Record<string, { required?: string[] }>;
  for (const field of ['version', 'createdAt', 'updatedAt']) assert.ok(definitions.persistedBlock!.required!.includes(field));
});
