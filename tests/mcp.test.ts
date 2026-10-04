import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_ACTIONS, createReportService } from '../packages/core/src/index.js';
import type { ReportService } from '../packages/core/src/index.js';
import { MCP_PROTOCOL_VERSIONS, PROMPTS, RESOURCES, RESOURCE_TEMPLATES, createMcpDispatcher, listTools } from '../packages/mcp/src/index.js';
import type { JsonRpcResponse, McpTool, McpToolResult } from '../packages/mcp/src/index.js';
import { createResearchExample } from '../examples/report.js';

const seeded = (): ReportService => createReportService(createResearchExample());
const rpc = (method: string, params: Record<string, unknown> = {}, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params });
const call = (name: string, args: Record<string, unknown> = {}, id = 1) => rpc('tools/call', { name, arguments: args }, id);

function result<T = Record<string, any>>(response: JsonRpcResponse | undefined): T {
  assert.ok(response && 'result' in response, JSON.stringify(response));
  return response.result as T;
}
function failure(response: JsonRpcResponse | undefined, code: number) {
  assert.ok(response && 'error' in response, JSON.stringify(response));
  assert.equal(response.error.code, code, response.error.message);
  return response.error;
}
function tool(response: JsonRpcResponse | undefined): McpToolResult { return result<McpToolResult>(response); }

test('initialize negotiates the protocol version and describes the server', async () => {
  const mcp = createMcpDispatcher(seeded(), { serverInfo: { name: 'super-editor', title: 'Super Editor', version: '9.9.9' } });
  for (const version of MCP_PROTOCOL_VERSIONS) {
    const init = result(await mcp(rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'test', version: '1' } })));
    assert.equal(init.protocolVersion, version);
  }
  const init = result(await mcp(rpc('initialize', { protocolVersion: '1999-01-01' })));
  assert.equal(init.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);
  assert.deepEqual(init.serverInfo, { name: 'super-editor', title: 'Super Editor', version: '9.9.9' });
  assert.deepEqual(Object.keys(init.capabilities).sort(), ['prompts', 'resources', 'tools']);
  assert.match(init.instructions, /get_outline/);
  assert.match(init.instructions, /version/);
  failure(await mcp(rpc('initialize', {})), -32602);
  assert.equal(await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal(await mcp({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }), undefined);
  assert.deepEqual(result(await mcp(rpc('ping'))), {});
  failure(await mcp(rpc('logging/setLevel', { level: 'info' })), -32601);
});

test('tools/list describes every tool with a schema, a title and honest annotations', async () => {
  const mcp = createMcpDispatcher(seeded());
  const { tools } = result<{ tools: McpTool[] }>(await mcp(rpc('tools/list')));
  const names = tools.map(entry => entry.name);
  assert.deepEqual(names.slice(0, 4), ['read_document', 'apply_transaction', 'undo', 'redo']);
  assert.deepEqual(names.slice(4), AGENT_ACTIONS.map(action => action.name));
  assert.equal(new Set(names).size, names.length);
  for (const entry of tools) {
    assert.equal(typeof entry.title, 'string');
    assert.ok(entry.description.length > 40, entry.name);
    assert.equal(entry.inputSchema.type, 'object', entry.name);
    assert.equal(entry.annotations.title, entry.title);
    assert.equal(entry.annotations.openWorldHint, false);
    if (entry.annotations.readOnlyHint) {
      assert.equal(entry.annotations.destructiveHint, false, entry.name);
      assert.equal(entry.annotations.idempotentHint, true, entry.name);
    }
  }
  const flags = (name: string) => tools.find(entry => entry.name === name)!.annotations;
  for (const name of ['read_document', 'get_outline', 'find_blocks', 'get_block', 'export_markdown', 'export_html', 'document_stats', 'validate_transaction']) assert.equal(flags(name).readOnlyHint, true, name);
  for (const name of ['update_block_text', 'update_block', 'replace_text', 'delete_blocks', 'import_markdown', 'apply_transaction', 'undo']) {
    assert.deepEqual([flags(name).readOnlyHint, flags(name).destructiveHint], [false, true], name);
  }
  for (const name of ['insert_blocks', 'add_chart', 'add_citation', 'insert_template', 'move_blocks']) assert.deepEqual([flags(name).readOnlyHint, flags(name).destructiveHint], [false, false], name);
  // Some clients (the Claude API among them) reject combinators at the top level of a tool's input schema.
  for (const entry of tools) for (const keyword of ['anyOf', 'oneOf', 'allOf', 'not', 'enum']) assert.equal(Object.hasOwn(entry.inputSchema, keyword), false, `${entry.name} has a top-level ${keyword}`);
  // The whole listing goes into a model's context; keep it bounded.
  assert.ok(JSON.stringify(tools).length < 120_000, `tools/list is ${JSON.stringify(tools).length} characters`);
  const semantic = tools.slice(4);
  assert.ok(JSON.stringify(semantic).length < 40_000, `semantic tools are ${JSON.stringify(semantic).length} characters`);
  assert.deepEqual(listTools().map(entry => entry.name), names);

  const mutated = result<{ tools: McpTool[] }>(await mcp(rpc('tools/list')));
  mutated.tools[4]!.name = 'tampered';
  assert.equal(result<{ tools: McpTool[] }>(await mcp(rpc('tools/list'))).tools[4]!.name, 'get_outline');
  assert.deepEqual(result<{ tools: unknown[] }>(await mcp(rpc('tools/list', { cursor: 'next' }))).tools, []);
  failure(await mcp(rpc('tools/list', { extra: 1 })), -32602);
});

test('semantic tools read, edit, report guarded results and attribute edits to the configured actor', async () => {
  const service = seeded();
  const mcp = createMcpDispatcher(service, { actor: { id: 'bot-7', kind: 'agent' }, now: () => '2026-10-05T10:00:00.000Z' });
  const outline = tool(await mcp(call('get_outline')));
  assert.equal(outline.isError, undefined);
  assert.deepEqual(JSON.parse(outline.content[0]!.text), outline.structuredContent);
  assert.equal((outline.structuredContent as { outline: unknown[] }).outline.length >= 2, true);

  const found = tool(await mcp(call('find_blocks', { type: 'paragraph', text: 'concentration' }))).structuredContent as { blocks: { id: string; version: number }[] };
  const target = found.blocks.find(block => block.id === 'portfolio-summary')!;
  assert.ok(target);
  const updated = tool(await mcp(call('update_block_text', { blockId: target.id, expectedVersion: target.version, text: 'Updated by **the agent**.' })));
  assert.equal(updated.isError, undefined, updated.content[0]!.text);
  assert.deepEqual((updated.structuredContent as { changed: string[] }).changed, ['portfolio-summary']);
  assert.equal(service.revisions?.().at(-1)?.actor.id, 'bot-7');
  assert.equal(service.revisions?.().at(-1)?.actor.kind, 'agent');

  const stale = tool(await mcp(call('update_block_text', { blockId: target.id, expectedVersion: target.version, text: 'again' })));
  assert.equal(stale.isError, true);
  const issue = (stale.structuredContent as { issues: { code: string; hint: string }[] }).issues[0]!;
  assert.equal(issue.code, 'conflict');
  assert.match(issue.hint, /version 2/);
  assert.deepEqual(JSON.parse(stale.content[0]!.text), stale.structuredContent);

  const preview = tool(await mcp(call('delete_blocks', { blocks: [{ blockId: 'macro', expectedVersion: 1 }], dryRun: true }))).structuredContent as { dryRun: boolean; removed: string[] };
  assert.equal(preview.dryRun, true);
  assert.ok(preview.removed.includes('macro-trend'));
  assert.ok(service.read().blocks.some(block => block.id === 'macro'));

  const cited = tool(await mcp(call('add_citation', { title: 'Source', url: 'https://example.com/s', blockId: 'portfolio-summary', expectedVersion: 2, marker: true }))).structuredContent as { citationId: string };
  assert.equal(cited.citationId, 'src-1');
  assert.equal(service.read().citations.find(entry => entry.id === 'src-1')!.accessedAt, '2026-10-05T10:00:00.000Z');
  const chart = tool(await mcp(call('add_chart', { spec: { kind: 'line', title: 'Rebased', labels: ['a', 'b'], series: [{ name: 'X', values: [1, 2] }] }, parentId: 'portfolio' }))).structuredContent as { blockId: string };
  assert.equal(chart.blockId, 'chart-1');

  const markdown = tool(await mcp(call('export_markdown')));
  assert.match(markdown.content[0]!.text, /^# Weekly research notebook/);
  assert.equal((markdown.structuredContent as { format: string }).format, 'markdown');
  assert.match(tool(await mcp(call('export_html'))).content[0]!.text, /<article/);
  assert.equal(typeof (tool(await mcp(call('document_stats'))).structuredContent as { words: number }).words, 'number');
  const revisions = tool(await mcp(call('list_revisions', { limit: 2 }))).structuredContent as { revisions: { number: number; summary: string }[] };
  assert.equal(revisions.revisions.length, 2);
  assert.ok(revisions.revisions[0]!.number > revisions.revisions[1]!.number);

  const unknownArg = tool(await mcp(call('get_block', { blockId: 'macro', color: 'red' })));
  assert.equal(unknownArg.isError, true);
  assert.match((unknownArg.structuredContent as { issues: { hint: string }[] }).issues[0]!.hint, /Allowed properties: blockId/);
  failure(await mcp(call('nope')), -32602);
  failure(await mcp(rpc('tools/call', { name: 'get_outline', arguments: {}, extra: true })), -32602);
  assert.equal(tool(await mcp(rpc('tools/call', { name: 'get_outline', arguments: {}, _meta: { progressToken: 'x' } }))).isError, undefined);
});

test('Core tools keep their raw results and add hints to failures', async () => {
  const service = seeded();
  const mcp = createMcpDispatcher(service);
  const failed = tool(await mcp(call('apply_transaction', { transaction: { id: 'bad', actor: { id: 'a', kind: 'agent' }, baseRevision: 0, operations: [{ type: 'deleteBlock', blockId: 'macro', expectedVersion: 1 }] } })));
  assert.equal(failed.isError, true);
  const issues = (failed.structuredContent as { issues: { hint?: string }[] }).issues;
  assert.ok(issues.every(entry => typeof entry.hint === 'string' && entry.hint.length > 0));
  const noHistory = tool(await mcp(call('undo', { actor: { id: 'a', kind: 'human' }, expectedRevision: 1 })));
  assert.equal(noHistory.isError, true);
  assert.ok((noHistory.structuredContent as { issues: { hint?: string }[] }).issues[0]!.hint);
});

test('a read-only server hides and refuses every tool that can change the document', async () => {
  const service = seeded();
  const before = service.read();
  const mcp = createMcpDispatcher(service, { readOnly: true });
  const { tools } = result<{ tools: McpTool[] }>(await mcp(rpc('tools/list')));
  assert.ok(tools.length >= 8);
  assert.ok(tools.every(entry => entry.annotations.readOnlyHint), tools.filter(entry => !entry.annotations.readOnlyHint).map(entry => entry.name).join());
  assert.ok(!tools.some(entry => entry.name === 'apply_transaction'));
  for (const [name, args] of [['apply_transaction', { transaction: {} }], ['insert_blocks', { markdown: 'x' }], ['delete_blocks', { blocks: [{ blockId: 'macro', expectedVersion: 1 }] }], ['undo', { actor: { id: 'a', kind: 'human' }, expectedRevision: 1 }]] as const) {
    const refused = tool(await mcp(call(name, args)));
    assert.equal(refused.isError, true, name);
    assert.match((refused.structuredContent as { issues: { message: string; hint: string }[] }).issues[0]!.message, /read-only/);
  }
  assert.equal(tool(await mcp(call('get_outline'))).isError, undefined);
  assert.equal(tool(await mcp(call('read_document'))).isError, undefined);
  assert.deepEqual(service.read(), before);
});

test('resources expose the document in several forms and one block or section on demand', async () => {
  const service = seeded();
  const mcp = createMcpDispatcher(service);
  const listed = result<{ resources: { uri: string; mimeType: string }[] }>(await mcp(rpc('resources/list'))).resources;
  assert.deepEqual(listed.map(entry => entry.uri), RESOURCES.map(entry => entry.uri));
  const templates = result<{ resourceTemplates: { uriTemplate: string }[] }>(await mcp(rpc('resources/templates/list'))).resourceTemplates;
  assert.deepEqual(templates.map(entry => entry.uriTemplate), RESOURCE_TEMPLATES.map(entry => entry.uriTemplate));
  for (const resource of listed) {
    const { contents } = result<{ contents: { uri: string; mimeType: string; text: string }[] }>(await mcp(rpc('resources/read', { uri: resource.uri })));
    assert.equal(contents.length, 1);
    assert.equal(contents[0]!.uri, resource.uri);
    assert.equal(contents[0]!.mimeType, resource.mimeType);
    assert.ok(contents[0]!.text.length > 10, resource.uri);
    if (resource.mimeType.includes('json')) JSON.parse(contents[0]!.text);
  }
  const read = async (uri: string) => result<{ contents: { text: string }[] }>(await mcp(rpc('resources/read', { uri }))).contents[0]!.text;
  assert.deepEqual(JSON.parse(await read('super-editor://document')), service.read());
  assert.match(await read('super-editor://document.md'), /Macro outlook/);
  assert.equal(JSON.parse(await read('super-editor://block/macro-trend')).block.id, 'macro-trend');
  const section = await read('super-editor://section/portfolio.md');
  assert.match(section, /Exposure and concentration/);
  assert.doesNotMatch(section, /A measured view of growth/);
  assert.equal(JSON.parse(await read('super-editor://schema/transaction')).$id, 'urn:super-editor:transaction:1');
  assert.match(await read('super-editor://guide'), /expectedVersion|version/);
  const missing = failure(await mcp(rpc('resources/read', { uri: 'super-editor://block/ghost' })), -32002);
  assert.deepEqual(missing.data, { uri: 'super-editor://block/ghost' });
  failure(await mcp(rpc('resources/read', { uri: 'file:///etc/passwd' })), -32002);
  failure(await mcp(rpc('resources/read', {})), -32602);
});

test('prompts guide an agent through drafting, reviewing, summarizing and sourcing', async () => {
  const mcp = createMcpDispatcher(seeded());
  const listed = result<{ prompts: { name: string; arguments: { name: string; required: boolean }[] }[] }>(await mcp(rpc('prompts/list'))).prompts;
  assert.deepEqual(listed.map(entry => entry.name), PROMPTS.map(entry => entry.name));
  const draft = result<{ messages: { role: string; content: { type: string; text: string } }[] }>(await mcp(rpc('prompts/get', { name: 'draft_report', arguments: { kind: 'macro', subject: 'the euro area', notes: 'Cover inflation.' } })));
  assert.equal(draft.messages[0]!.role, 'user');
  const text = draft.messages[0]!.content.text;
  for (const needle of ['insert_template', 'the euro area', 'Cover inflation.', 'add_chart', 'add_citation', 'analysis only']) assert.ok(text.includes(needle), needle);
  assert.doesNotMatch(text, /\b(buy|sell)\b/i);
  for (const name of ['review_report', 'summarize_document']) assert.ok(result<{ messages: unknown[] }>(await mcp(rpc('prompts/get', { name }))).messages.length === 1);
  assert.match(result<{ messages: { content: { text: string } }[] }>(await mcp(rpc('prompts/get', { name: 'add_citations', arguments: { sources: 'Bank: https://example.com/b' } }))).messages[0]!.content.text, /https:\/\/example\.com\/b/);
  failure(await mcp(rpc('prompts/get', { name: 'draft_report', arguments: { subject: 'x' } })), -32602);
  failure(await mcp(rpc('prompts/get', { name: 'draft_report', arguments: { kind: 'crypto', subject: 'x' } })), -32602);
  failure(await mcp(rpc('prompts/get', { name: 'nope' })), -32602);
  failure(await mcp(rpc('prompts/get', { name: 'review_report', arguments: { focus: 5 } })), -32602);
});
