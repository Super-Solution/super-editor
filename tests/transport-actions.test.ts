import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AGENT_ACTIONS, createFormatRegistry, createReportService, formatActions, htmlExporter, markdownExporter, resolveActions, runTransportAction, serializeDocument,
  type AgentActionResult, type ReportService, type TransportAction,
} from '../packages/core/src/index.js';
import { docxExporter, exportDocx } from '../packages/formats/docx/src/index.js';
import { readZip } from '../packages/formats/opc/src/index.js';
import { createHttpHandler, createOpenApiDocument } from '../backends/typescript/api/src/index.js';
import { createMcpDispatcher, listTools } from '../backends/typescript/mcp/src/index.js';
import { runCli } from '../packages/cli/src/cli.js';
import { createAllBlocksExample } from '../examples/all-blocks.js';
import { createResearchExample } from '../examples/report.js';

const seeded = (): ReportService => createReportService(createResearchExample());
const registry = () => { const formats = createFormatRegistry(); formats.addExporter(markdownExporter); formats.addExporter(htmlExporter); formats.addExporter(docxExporter); return formats; };
const post = (path: string, body: unknown) => new Request(`http://local${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (path: string) => new Request(`http://local${path}`);
const echo = (overrides: Partial<TransportAction> = {}): TransportAction => ({
  name: 'echo_text', title: 'Echo', description: 'Returns its input. Read-only.', access: 'read', destructive: false, idempotent: true,
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: [], additionalProperties: false },
  async run(service, input) { await Promise.resolve(); return { ok: true, revision: service.read().revision, echoed: input }; }, ...overrides,
});

test('resolveActions: the default is the shared table, and a wrong list fails at start, naming the problem', () => {
  assert.deepEqual(resolveActions().names(), AGENT_ACTIONS.map(action => action.name));
  assert.equal(resolveActions([...AGENT_ACTIONS, echo()]).names().at(-1), 'echo_text');
  assert.throws(() => resolveActions([...AGENT_ACTIONS, AGENT_ACTIONS[0]!]), /Two actions are named "[a-z_]+"/);
  assert.throws(() => resolveActions([echo({ name: 'read_document' })], ['read_document']), /name of a tool this transport already has/);
  assert.throws(() => resolveActions([echo({ name: 'Bad-Name' })]), /snake_case/);
  assert.throws(() => resolveActions([echo({ run: undefined as never })]), /needs a run/);
  assert.throws(() => resolveActions([echo({ access: 'maybe' as never })]), /access must be/);
  assert.throws(() => resolveActions([echo({ inputSchema: { type: 'string' } as never })]), /inputSchema must be/);
  assert.throws(() => resolveActions('nope' as never), /array/);
  assert.equal(Object.isFrozen(resolveActions().list), true);
  assert.equal(AGENT_ACTIONS.some(action => action.name === 'export_document' || action.name === 'list_formats'), false, 'the shared table is unchanged');
});

test('runTransportAction awaits an asynchronous action, and never rejects', async () => {
  const table = resolveActions([...AGENT_ACTIONS, echo(), echo({ name: 'explode', run: async () => { throw new Error('secret path /etc/passwd'); } })]);
  const service = seeded();
  assert.deepEqual(await runTransportAction(table, service, 'echo_text', { text: 'x' }), { ok: true, revision: service.read().revision, echoed: { text: 'x' } });
  const failed = await runTransportAction(table, service, 'explode', {}) as Extract<AgentActionResult, { ok: false }>;
  assert.equal(failed.ok, false);
  assert.ok(!JSON.stringify(failed).includes('/etc/passwd'), 'what an action threw is not echoed back');
  const missing = await runTransportAction(table, service, 'nope', {}) as Extract<AgentActionResult, { ok: false }>;
  assert.equal(missing.issues[0]!.code, 'not-found');
  assert.ok(missing.issues[0]!.hint!.includes('echo_text'));
});

test('formatActions needs an exporter, lists the formats with their limits, and exports text and binary', async () => {
  assert.throws(() => formatActions(createFormatRegistry()), /at least one registered exporter/);
  const table = resolveActions([...AGENT_ACTIONS, ...formatActions(registry())]);
  const service = seeded();
  const listed = await runTransportAction(table, service, 'list_formats', {}) as { ok: true; formats: { id: string; fidelity: Record<string, unknown> }[] };
  assert.deepEqual(listed.formats.map(format => format.id), ['markdown', 'html', 'docx']);
  assert.ok(Object.keys(listed.formats.find(format => format.id === 'docx')!.fidelity).includes('image'), 'what docx loses is listed before exporting');
  const markdown = await runTransportAction(table, service, 'export_document', { format: 'markdown' }) as { ok: true; encoding: string; data: string; mime: string; bytes: number };
  assert.equal(markdown.encoding, 'utf8'); assert.match(markdown.data, /^# /m); assert.equal(markdown.bytes, new TextEncoder().encode(markdown.data).length);
  const docx = await runTransportAction(table, service, 'export_document', { format: 'docx', options: { footer: '{page}' } }) as { ok: true; encoding: string; data: string; ext: string; warnings: unknown[] };
  assert.equal(docx.encoding, 'base64'); assert.equal(docx.ext, 'docx');
  const files = await readZip(new Uint8Array(Buffer.from(docx.data, 'base64')));
  assert.ok(files.has('word/document.xml') && files.has('word/footer1.xml'));
  assert.ok(Array.isArray(docx.warnings));
  const revision = service.read().revision;
  assert.equal(service.read().revision, revision, 'exporting is read-only');
});

test('export_document: one block, and every refusal names the field and says what to do', async () => {
  const table = resolveActions([...AGENT_ACTIONS, ...formatActions(registry())]);
  const service = seeded();
  const section = service.read().blocks.find(block => block.content.type === 'section')!;
  const part = await runTransportAction(table, service, 'export_document', { format: 'markdown', blockId: section.id }) as { ok: true; data: string };
  const whole = await runTransportAction(table, service, 'export_document', { format: 'markdown' }) as { ok: true; data: string };
  assert.ok(part.data.length > 0 && part.data.length < whole.data.length);
  const cases: [unknown, string, string][] = [
    [{ format: 'pdf' }, 'input.format', 'validation'],
    [{}, 'input', 'validation'],
    [{ format: 'markdown', blockId: 'does-not-exist' }, 'input.blockId', 'not-found'],
    [{ format: 'docx', options: { nope: true } }, 'input.options', 'validation'],
    [{ format: 'docx', options: { resolveImage: 'x' } }, 'input.options.resolveImage', 'validation'],
    [{ format: 'markdown', extra: 1 }, 'input', 'validation'],
  ];
  for (const [input, path, code] of cases) {
    const result = await runTransportAction(table, service, 'export_document', input) as Extract<AgentActionResult, { ok: false }>;
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(result.issues[0]!.code, code, JSON.stringify(result.issues));
    assert.ok(result.issues[0]!.path!.startsWith(path), `${result.issues[0]!.path} starts with ${path}`);
    assert.ok(result.issues[0]!.hint, 'a hint');
    assert.equal(typeof result.currentRevision, 'number');
  }
});

test('a host that sets resolveImage registers a configured exporter, and every transport then embeds pictures', async () => {
  const PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const configured = createFormatRegistry();
  configured.addExporter({ ...docxExporter, export: (document, options) => exportDocx(document, { ...(options as object), resolveImage: () => PNG }) });
  const service = createReportService(createAllBlocksExample());
  const withImage = service.read().blocks.some(block => block.content.type === 'image');
  assert.equal(withImage, true, 'the example has an image block');
  const http = createHttpHandler(service, { actions: [...AGENT_ACTIONS, ...formatActions(configured)] });
  const body = await (await http(post('/actions/export_document', { format: 'docx' }))).json() as { ok: boolean; data: string; warnings: { code: string }[] };
  assert.equal(body.ok, true);
  const files = await readZip(new Uint8Array(Buffer.from(body.data, 'base64')));
  assert.ok([...files.keys()].some(name => name.startsWith('word/media/')), 'the picture is in the file');
  assert.ok(!body.warnings.some(warning => warning.code === 'feature-degraded' && JSON.stringify(warning).includes('"image"')));
});

test('HTTP: GET /actions, POST /actions/{name} and the OpenAPI document include the extras; without them nothing changes', async () => {
  const service = seeded(), actions = [...AGENT_ACTIONS, ...formatActions(registry())];
  const http = createHttpHandler(service, { actions });
  const listed = await (await http(get('/actions'))).json() as { actions: { name: string }[] };
  assert.deepEqual(listed.actions.map(action => action.name), actions.map(action => action.name));
  const exported = await http(post('/actions/export_document', { format: 'html' }));
  assert.equal(exported.status, 200);
  const result = await exported.json() as { ok: boolean; encoding: string; data: string };
  assert.equal(result.ok, true); assert.equal(result.encoding, 'utf8'); assert.match(result.data, /<h1|<article|<!doctype/i);
  const bad = await http(post('/actions/export_document', { format: 'pdf' }));
  assert.equal(bad.status, 400);
  assert.equal(((await bad.json()) as { issues: { code: string }[] }).issues[0]!.code, 'validation');
  const document = createOpenApiDocument({ actions }) as { paths: Record<string, unknown> };
  assert.ok(document.paths['/actions/export_document'] && document.paths['/actions/list_formats']);
  assert.equal((createOpenApiDocument() as { paths: Record<string, unknown> }).paths['/actions/export_document'], undefined);
  const schemasOf = (value: unknown) => (value as { components: { schemas: Record<string, unknown> } }).components.schemas;
  assert.ok(schemasOf(document).ExtraActionResult, 'a result schema for the added actions');
  assert.equal(schemasOf(createOpenApiDocument()).ExtraActionResult, undefined, 'the default document is unchanged, so it still matches the Go and Python servers');
  const plain = createHttpHandler(service);
  const missing = await plain(post('/actions/export_document', { format: 'html' }));
  assert.equal(missing.status, 404);
  assert.equal(((await missing.json()) as { issues: { code: string }[] }).issues[0]!.code, 'not-found');
  assert.throws(() => createHttpHandler(service, { actions: [...AGENT_ACTIONS, AGENT_ACTIONS[0]!] }), /Two actions/);
  const readOnly = createHttpHandler(service, { actions, readOnly: true });
  assert.equal((await readOnly(post('/actions/export_document', { format: 'html' }))).status, 200, 'an export only reads, so a read-only server serves it');
});

test('MCP: the extras are tools with honest annotations, a name that clashes with a core tool is refused, and read-only keeps exports', async () => {
  const service = seeded(), actions = [...AGENT_ACTIONS, ...formatActions(registry())];
  const mcp = createMcpDispatcher(service, { actions });
  const listed = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } };
  const exportTool = listed.result.tools.find(tool => tool.name === 'export_document')!;
  assert.equal(exportTool.annotations.readOnlyHint, true);
  assert.ok(listed.result.tools.some(tool => tool.name === 'list_formats'));
  const called = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'export_document', arguments: { format: 'markdown' } } }) as { result: { isError?: boolean; structuredContent: { ok: boolean; data: string } } };
  assert.equal(called.result.isError, undefined);
  assert.equal(called.result.structuredContent.ok, true);
  const refused = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'export_document', arguments: { format: 'pdf' } } }) as { result: { isError: boolean; structuredContent: { issues: { hint: string }[] } } };
  assert.equal(refused.result.isError, true);
  assert.ok(refused.result.structuredContent.issues[0]!.hint);
  assert.throws(() => createMcpDispatcher(service, { actions: [echo({ name: 'read_document' })] }), /name of a tool this transport already has/);
  const readOnly = createMcpDispatcher(service, { actions, readOnly: true });
  const readOnlyList = await readOnly({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} }) as { result: { tools: { name: string }[] } };
  assert.ok(readOnlyList.result.tools.some(tool => tool.name === 'export_document'));
  assert.equal(listTools({ actions }).length, listTools().length + 2);
  assert.equal(listTools().some(tool => tool.name === 'export_document'), false, 'the default tool list is unchanged');
});

test('CLI: tools lists the extras and call runs them against the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'super-editor-cli-')), file = join(directory, 'report.json');
  try {
    await writeFile(file, serializeDocument(seeded().read()));
    const actions = [...AGENT_ACTIONS, ...formatActions(registry())];
    const run = async (args: string[], withActions = true) => {
      const out: string[] = [], err: string[] = [];
      const code = await runCli(args, { stdout: value => { out.push(value); }, stderr: value => { err.push(value); } }, withActions ? { actions } : {});
      return { code, out: out.join(''), err: err.join('') };
    };
    const tools = await run(['tools', '--json']);
    assert.equal(tools.code, 0);
    assert.ok((JSON.parse(tools.out) as { actions: { name: string }[] }).actions.some(action => action.name === 'export_document'));
    const exported = await run(['call', file, 'export_document', '--input', '{"format":"markdown"}']);
    assert.equal(exported.code, 0, exported.err);
    assert.match((JSON.parse(exported.out) as { data: string }).data, /^# /m);
    const without = await run(['call', file, 'export_document', '--input', '{"format":"markdown"}'], false);
    assert.notEqual(without.code, 0);
    assert.match(without.err, /Unknown action .*export_document/);
    const clash = await runCli(['tools'], { stdout() {}, stderr() {} }, { actions: [AGENT_ACTIONS[0]!, AGENT_ACTIONS[0]!] });
    assert.equal(clash, 2, 'a wrong action list is a usage error at start');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
