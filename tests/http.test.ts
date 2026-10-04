import assert from 'node:assert/strict';
import test from 'node:test';
import { AGENT_ACTIONS, createReportService } from '../packages/core/src/index.js';
import type { ReportService } from '../packages/core/src/index.js';
import { HttpClientError, ROUTES, createHttpClient, createHttpHandler, createOpenApiDocument } from '../packages/api/src/index.js';
import type { HttpHandlerOptions } from '../packages/api/src/index.js';
import { createResearchExample } from '../examples/report.js';

const seeded = (): ReportService => createReportService(createResearchExample());
const get = (path: string, init: RequestInit = {}) => new Request(`http://local${path}`, init);
const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`http://local${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
async function json(response: Response): Promise<any> { return response.json(); }
async function expectFailure(response: Response, status: number, code?: string) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  const body = await json(response);
  assert.equal(body.ok, false);
  assert.equal(typeof body.currentRevision, 'number');
  assert.ok(Array.isArray(body.issues) && body.issues.length > 0);
  for (const issue of body.issues) { assert.equal(typeof issue.message, 'string'); assert.ok(typeof issue.hint === 'string' && issue.hint.length > 0, JSON.stringify(issue)); }
  if (code) assert.equal(body.issues[0].code, code);
  return body;
}

test('read routes return compact, filterable views of the document', async () => {
  const service = seeded();
  const http = createHttpHandler(service);
  const health = await http(get('/health'));
  assert.deepEqual(await json(health), { ok: true, revision: 1 });
  assert.equal(health.headers.get('cache-control'), 'no-store');
  assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(await json(await http(get('/document'))), service.read());

  const outline = await json(await http(get('/outline')));
  assert.equal(outline.title, 'Weekly research notebook');
  assert.ok(outline.outline.length >= 2);
  assert.ok((await json(await http(get('/outline?maxDepth=1')))).outline.every((node: { children: unknown[] }) => node.children.length === 0));

  const charts = await json(await http(get('/blocks?type=chart')));
  assert.equal(charts.total, 3);
  assert.deepEqual(charts.blocks.map((block: { id: string }) => block.id), ['macro-trend', 'allocation', 'factor']);
  assert.equal((await json(await http(get('/blocks?type=chart,table')))).total, 4);
  assert.equal((await json(await http(get('/blocks?type=chart&type=table')))).total, 4);
  assert.equal((await json(await http(get('/blocks?q=CONCENTRATION')))).total >= 2, true);
  assert.equal((await json(await http(get('/blocks?parentId=null')))).total, 3);
  assert.equal((await json(await http(get('/blocks?within=portfolio&type=heading')))).total, 1);
  assert.equal((await json(await http(get('/blocks?ids=macro,portfolio,ghost')))).total, 2);
  const page = await json(await http(get('/blocks?limit=2&offset=1')));
  assert.deepEqual([page.count, page.truncated], [2, true]);
  assert.equal((await json(await http(get('/blocks?type=timestamp&include=content')))).blocks[0].content.type, 'timestamp');

  const block = await json(await http(get('/blocks/macro-trend')));
  assert.equal(block.block.id, 'macro-trend');
  assert.deepEqual(block.ancestors.map((entry: { id: string }) => entry.id), ['macro']);
  const missing = await expectFailure(await http(get('/blocks/ghost')), 404, 'not-found');
  assert.equal(missing.issues[0].blockId, 'ghost');
  await expectFailure(await http(get('/blocks/%E0%A4%A')), 400, 'validation');
  assert.equal((await json(await http(get('/stats')))).charts, 3);
  const revisions = await json(await http(get('/revisions')));
  assert.equal(revisions.total, 0);
  assert.deepEqual(revisions.revisions, []);
});

test('bad query strings are rejected with the allowed parameters', async () => {
  const http = createHttpHandler(seeded());
  const unknown = await expectFailure(await http(get('/blocks?tpye=chart')), 400, 'validation');
  assert.equal(unknown.issues[0].path, 'query.tpye');
  assert.match(unknown.issues[0].hint, /Allowed parameters: type, q, parentId/);
  await expectFailure(await http(get('/blocks?limit=abc')), 400);
  await expectFailure(await http(get('/blocks?limit=-1')), 400);
  await expectFailure(await http(get('/blocks?limit=1&limit=2')), 400);
  await expectFailure(await http(get('/blocks?limit=0')), 400, 'validation');
  await expectFailure(await http(get('/blocks?limit=201')), 400, 'validation');
  await expectFailure(await http(get('/blocks?include=everything')), 400);
  await expectFailure(await http(get('/blocks?type=banner')), 400);
  await expectFailure(await http(get('/blocks?within=ghost')), 404, 'not-found');
  await expectFailure(await http(get('/stats?x=1')), 400);
  await expectFailure(await http(get('/export.md?standalone=maybe')), 400);
});

test('export routes return downloadable text with safe headers', async () => {
  const http = createHttpHandler(seeded());
  const markdown = await http(get('/export.md'));
  assert.equal(markdown.status, 200);
  assert.equal(markdown.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(markdown.headers.get('x-document-revision'), '1');
  assert.match(await markdown.text(), /^# Weekly research notebook/);
  const html = await http(get('/export.html'));
  assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.match(html.headers.get('content-security-policy') ?? '', /default-src 'none'.*sandbox/);
  const page = await html.text();
  assert.match(page, /^<!doctype html>/);
  assert.doesNotMatch(page, /<script/i);
  assert.match(await (await http(get('/export.html?standalone=false'))).text(), /^<article/);
  assert.equal((await http(get('/export.txt'))).headers.get('content-type'), 'text/plain; charset=utf-8');
  const section = await (await http(get('/export.md?blockId=portfolio'))).text();
  assert.match(section, /Exposure and concentration/);
  assert.doesNotMatch(section, /A measured view of growth/);
  await expectFailure(await http(get('/export.md?blockId=ghost')), 404, 'not-found');
  const head = await http(get('/export.md', { method: 'HEAD' }));
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
});

test('actions run by name, guard every edit and attribute it to the actor', async () => {
  const service = seeded();
  const http = createHttpHandler(service);
  const found = await json(await http(get('/blocks?q=concentration&type=paragraph')));
  const target = found.blocks.find((block: { id: string }) => block.id === 'portfolio-summary');
  const updated = await http(post('/actions/update_block_text', { blockId: target.id, expectedVersion: target.version, text: 'Updated over HTTP.', actor: { id: 'http-bot', kind: 'agent' } }));
  assert.equal(updated.status, 200);
  const result = await json(updated);
  assert.deepEqual([result.ok, result.revision, result.changed], [true, 2, ['portfolio-summary']]);
  assert.equal(service.revisions?.().at(-1)?.actor.id, 'http-bot');

  const stale = await expectFailure(await http(post('/actions/update_block_text', { blockId: target.id, expectedVersion: target.version, text: 'again' })), 409, 'conflict');
  assert.match(stale.issues[0].hint, /version 2/);
  const invalid = await expectFailure(await http(post('/actions/add_chart', { spec: { kind: 'line', title: 't', labels: ['a', 'b'], series: [{ name: 's', values: [1] }] } })), 400, 'validation');
  assert.equal(invalid.issues[0].path, 'input.spec.series[0].values');
  await expectFailure(await http(post('/actions/get_block', { blockId: 'ghost' })), 404, 'not-found');
  await expectFailure(await http(post('/actions/no_such_action', {})), 404, 'not-found');
  await expectFailure(await http(post('/actions/get_outline', [])), 400);
  await expectFailure(await http(post('/actions/get_outline', null)), 400);
  await expectFailure(await http(post('/actions/set_title', { title: 'x', actor: { id: 'bad id', kind: 'agent' } })), 400);
  await expectFailure(await http(post('/actions/set_title', { title: 'x', actor: { id: 'a', kind: 'robot' } })), 400);
  await expectFailure(await http(get('/actions/get_outline')), 405);

  const before = service.read();
  const preview = await json(await http(post('/actions/delete_blocks', { blocks: [{ blockId: 'macro', expectedVersion: 1 }], dryRun: true })));
  assert.deepEqual([preview.ok, preview.dryRun, preview.revision, preview.revisionAfter], [true, true, 2, 3]);
  assert.deepEqual(service.read(), before);

  const retry = { title: 'Once', transactionId: 'http-retry', expectedRevision: 2 };
  assert.equal((await json(await http(post('/actions/set_title', retry)))).revision, 3);
  assert.equal((await json(await http(post('/actions/set_title', retry)))).duplicate, true);
  assert.equal(service.read().revision, 3);

  const listed = await json(await http(get('/actions')));
  assert.deepEqual(listed.actions.map((entry: { name: string }) => entry.name), AGENT_ACTIONS.map(action => action.name));
  assert.ok(listed.actions.every((entry: { inputSchema: { type: string } }) => entry.inputSchema.type === 'object'));
});

test('a handler that resolves the actor itself ignores the actor in the body', async () => {
  const service = seeded();
  const http = createHttpHandler(service, { actor: request => ({ id: request.headers.get('x-user') ?? 'anonymous', kind: 'human' }) });
  const response = await http(post('/actions/set_title', { title: 'Authenticated', actor: { id: 'spoofed', kind: 'system' } }, { 'x-user': 'maria' }));
  assert.equal(response.status, 200);
  assert.deepEqual(service.revisions?.().at(-1)?.actor, { id: 'maria', kind: 'human' });
  const fixed = seeded();
  await createHttpHandler(fixed, { actor: { id: 'service-account', kind: 'system' } })(post('/actions/set_title', { title: 'Fixed' }));
  assert.equal(fixed.revisions?.().at(-1)?.actor.id, 'service-account');
  const none = seeded();
  await createHttpHandler(none)(post('/actions/set_title', { title: 'Default' }));
  assert.deepEqual(none.revisions?.().at(-1)?.actor, { id: 'http-client', kind: 'agent' });
});

test('markdown import accepts JSON or a raw markdown body', async () => {
  const service = seeded();
  const http = createHttpHandler(service);
  const raw = await http(new Request('http://local/import/markdown?mode=append&parentId=portfolio&actor=md-bot:agent', { method: 'POST', headers: { 'content-type': 'text/markdown' }, body: '## Added over HTTP\n\nA paragraph.' }));
  assert.equal(raw.status, 200, await raw.clone().text());
  const added = await json(raw);
  assert.equal(added.added.length, 2);
  assert.ok(service.read().blocks.filter(block => added.added.includes(block.id)).every(block => block.parentId === 'portfolio'));
  assert.equal(service.revisions?.().at(-1)?.actor.id, 'md-bot');
  const replaced = await json(await http(post('/import/markdown', { markdown: '# Fresh start\n\nOnly this.', mode: 'replace', setTitle: true })));
  assert.equal(replaced.mode, 'replace');
  assert.equal(service.read().title, 'Fresh start');
  assert.equal(service.read().blocks.length, 2);
  const preview = await json(await http(new Request('http://local/import/markdown?mode=replace&dryRun=true', { method: 'POST', headers: { 'content-type': 'text/markdown' }, body: 'Preview only' })));
  assert.equal(preview.dryRun, true);
  assert.equal(service.read().blocks.length, 2);
  await expectFailure(await http(new Request('http://local/import/markdown?mode=sideways', { method: 'POST', headers: { 'content-type': 'text/markdown' }, body: 'x' })), 400);
  await expectFailure(await http(new Request('http://local/import/markdown', { method: 'POST', headers: { 'content-type': 'text/markdown' }, body: '' })), 400);
  await expectFailure(await http(post('/import/markdown', { markdown: 5 })), 400);
  await expectFailure(await http(post('/import/markdown', [])), 400);
  await expectFailure(await http(new Request('http://local/import/markdown', { method: 'POST', headers: { 'content-type': 'application/xml' }, body: '<x/>' })), 415);
});

test('templates are listed and previewed without touching the document', async () => {
  const service = seeded();
  const before = service.read();
  const http = createHttpHandler(service);
  const listed = await json(await http(get('/templates')));
  assert.equal(listed.templates.length, 7);
  const preview = await json(await http(get('/templates/equity?subject=ACME&idPrefix=acme')));
  assert.equal(preview.title, 'ACME: equity analysis');
  assert.ok(preview.blocks.every((block: { id: string }) => block.id.startsWith('acme-')));
  await expectFailure(await http(get('/templates/crypto')), 404, 'not-found');
  await expectFailure(await http(get('/templates/equity?idPrefix=bad%20prefix')), 400);
  assert.deepEqual(service.read(), before);
});

test('a read-only handler refuses every route that could change the document', async () => {
  const service = seeded();
  const before = service.read();
  const http = createHttpHandler(service, { readOnly: true });
  for (const request of [
    post('/transactions', {}), post('/undo', {}), post('/redo', {}), post('/actions/set_title', { title: 'x' }), post('/import/markdown', { markdown: 'x' }),
  ]) await expectFailure(await http(request), 403);
  assert.equal((await http(post('/actions/get_outline', {}))).status, 200, 'read actions stay available');
  assert.equal((await http(get('/outline'))).status, 200);
  assert.deepEqual(service.read(), before);
});

test('every failure shares one shape, including routing, method, type and size errors', async () => {
  const service = seeded();
  const http = createHttpHandler(service, { maxBodyBytes: 200 });
  await expectFailure(await http(get('/nope')), 404, 'not-found');
  const wrongMethod = await http(get('/transactions'));
  assert.equal(wrongMethod.headers.get('allow'), 'POST');
  await expectFailure(wrongMethod, 405);
  await expectFailure(await http(new Request('http://local/outline', { method: 'DELETE' })), 405);
  await expectFailure(await http(post('/transactions', 'x'.repeat(400))), 413, 'validation');
  await expectFailure(await http(new Request('http://local/transactions', { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '999999' }, body: '{}' })), 413);
  await expectFailure(await http(new Request('http://local/transactions', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' })), 415);
  await expectFailure(await http(new Request('http://local/transactions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })), 400);
  await expectFailure(await http(new Request('http://local/transactions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: new Uint8Array([0xff, 0xfe]) })), 400);
  await expectFailure(await http(new Request('http://local/transactions', { method: 'POST' })), 400);
  assert.equal(service.read().revision, 1);
  assert.throws(() => createHttpHandler(service, { maxBodyBytes: 0 }));
  assert.throws(() => createHttpHandler(service, { basePath: 'api' }));
  assert.throws(() => createHttpHandler(service, { basePath: '/api/' }));
  assert.throws(() => createHttpHandler(service, { cors: { origins: ['https://x.example/'] } }));
  assert.throws(() => createHttpHandler(service, { cors: { origins: ['*'] } }));
});

test('CORS is off unless configured, then answers preflight for exactly the allowed origins', async () => {
  const off = createHttpHandler(seeded());
  const plain = await off(get('/outline', { headers: { origin: 'https://app.example.com' } }));
  assert.equal(plain.headers.get('access-control-allow-origin'), null);
  const options = await off(new Request('http://local/actions/set_title', { method: 'OPTIONS', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' } }));
  assert.equal(options.status, 204);
  assert.equal(options.headers.get('access-control-allow-origin'), null);
  assert.equal(options.headers.get('allow'), 'POST, OPTIONS');
  assert.equal((await off(new Request('http://local/nope', { method: 'OPTIONS' }))).status, 404);

  const open = createHttpHandler(seeded(), { cors: { origins: '*' } });
  const star = await open(get('/outline', { headers: { origin: 'https://anywhere.example' } }));
  assert.equal(star.headers.get('access-control-allow-origin'), '*');
  assert.equal(star.headers.get('vary'), null);
  assert.equal((await open(get('/outline'))).headers.get('access-control-allow-origin'), null, 'no Origin header, no CORS headers');

  const strict = createHttpHandler(seeded(), { cors: { origins: ['https://app.example.com'], headers: ['authorization'], maxAge: 60 } });
  const allowed = await strict(get('/outline', { headers: { origin: 'https://app.example.com' } }));
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example.com');
  assert.equal(allowed.headers.get('vary'), 'origin');
  assert.equal(allowed.headers.get('access-control-expose-headers'), 'x-document-revision');
  const preflight = await strict(new Request('http://local/actions/set_title', { method: 'OPTIONS', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } }));
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example.com');
  assert.equal(preflight.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
  assert.equal(preflight.headers.get('access-control-allow-headers'), 'content-type, authorization');
  assert.equal(preflight.headers.get('access-control-max-age'), '60');
  assert.equal(await preflight.text(), '');
  const denied = await strict(new Request('http://local/actions/set_title', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } }));
  await expectFailure(denied, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const blocked = await strict(get('/outline', { headers: { origin: 'https://evil.example' } }));
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  const errorWithCors = await strict(get('/nope', { headers: { origin: 'https://app.example.com' } }));
  assert.equal(errorWithCors.headers.get('access-control-allow-origin'), 'https://app.example.com');
});

test('a handler can be mounted below a base path', async () => {
  const http = createHttpHandler(seeded(), { basePath: '/api/reports/42' });
  assert.equal((await http(get('/api/reports/42/outline'))).status, 200);
  assert.equal((await http(get('/api/reports/42'))).status, 404);
  await expectFailure(await http(get('/outline')), 404);
  await expectFailure(await http(get('/api/reports/420/outline')), 404);
  const openapi = await json(await http(get('/api/reports/42/openapi.json')));
  assert.deepEqual(openapi.servers, [{ url: '/api/reports/42' }]);
});

function references(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach(entry => references(entry, found));
  else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { if (key === '$ref' && typeof entry === 'string') found.push(entry); else references(entry, found); }
  return found;
}

test('the OpenAPI document describes every route and action with resolvable references', async () => {
  const document = createOpenApiDocument({ title: 'Test API', version: '1.2.3' }) as { openapi: string; info: { title: string; version: string }; paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } };
  assert.equal(document.openapi, '3.1.0');
  assert.deepEqual([document.info.title, document.info.version], ['Test API', '1.2.3']);
  const served = await json(await createHttpHandler(seeded())(get('/openapi.json')));
  assert.equal(served.openapi, '3.1.0');
  assert.deepEqual(Object.keys(served.paths), Object.keys(createOpenApiDocument().paths as object));

  const operationIds: string[] = [];
  for (const [path, methods] of Object.entries(document.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      assert.ok(['get', 'post'].includes(method), `${method} ${path}`);
      operationIds.push(operation.operationId);
      assert.ok(operation.summary && operation.description, `${method} ${path}`);
      assert.ok(operation.responses['200'] && operation.responses['400'], `${method} ${path}`);
      for (const name of path.match(/\{(\w+)\}/g) ?? []) assert.ok(operation.parameters.some((entry: { name: string; in: string; required: boolean }) => `{${entry.name}}` === name && entry.in === 'path' && entry.required), `${path} ${name}`);
      if (method === 'post') assert.ok(operation.requestBody, `${method} ${path}`);
    }
  }
  assert.equal(new Set(operationIds).size, operationIds.length, 'operationIds are unique');
  for (const route of ROUTES) if (route.path !== '/actions/{name}') assert.ok(document.paths[route.path]?.[route.method.toLowerCase()], `${route.method} ${route.path}`);
  for (const action of AGENT_ACTIONS) {
    const operation = document.paths[`/actions/${action.name}`]?.post;
    assert.ok(operation, action.name);
    assert.equal(operation['x-access'], action.access);
    const body = document.components.schemas[`Action.${action.name}`];
    assert.ok(body.properties.actor, `${action.name} accepts an actor`);
    assert.equal(body.additionalProperties, false);
  }
  assert.equal(document.paths['/blocks']!.get.parameters.find((entry: { name: string }) => entry.name === 'type').explode, false);
  assert.ok(document.paths['/import/markdown']!.post.requestBody.content['text/markdown']);

  const text = JSON.stringify(document);
  assert.doesNotMatch(text, /#\/\$defs\//, 'no JSON Schema $defs references remain');
  assert.doesNotMatch(text, /"\$(?:id|schema)"/);
  for (const reference of references(document)) {
    assert.match(reference, /^#\/components\/schemas\/[A-Za-z0-9._-]+$/, reference);
    assert.ok(Object.hasOwn(document.components.schemas, reference.slice('#/components/schemas/'.length)), `unresolved ${reference}`);
  }
  assert.ok(document.components.schemas['Transaction.block'] && document.components.schemas['Document.persistedBlock'] && document.components.schemas['Action.add_chart.chart']);
  assert.deepEqual(Object.keys(document.components.schemas.EditorIssue.properties).sort(), ['blockId', 'code', 'hint', 'message', 'path']);
});

test('the typed client talks to the handler and returns failures instead of throwing', async () => {
  const service = seeded();
  const handler = createHttpHandler(service);
  const seen: string[] = [];
  const client = createHttpClient({
    baseUrl: 'http://local/', actor: { id: 'client-bot', kind: 'agent' }, headers: () => ({ 'x-trace': 'abc' }),
    fetch: (async (url: string | URL | Request, init?: RequestInit) => { const request = new Request(url as string, init); seen.push(`${request.method} ${new URL(request.url).pathname} ${request.headers.get('x-trace')}`); return handler(request); }) as typeof fetch,
  });
  assert.deepEqual(await client.health(), { ok: true, revision: 1 });
  assert.equal((await client.document()).title, 'Weekly research notebook');
  const outline = await client.actions.get_outline();
  assert.ok(outline.ok && outline.outline.length >= 2);
  const found = await client.actions.find_blocks({ type: 'paragraph', text: 'concentration' });
  assert.ok(found.ok);
  const brief = (found.blocks as { id: string; version: number }[]).find(block => block.id === 'portfolio-summary')!;
  const updated = await client.actions.update_block_text({ blockId: brief.id, expectedVersion: brief.version, text: 'Typed update' });
  assert.ok(updated.ok);
  assert.deepEqual(updated.changed, ['portfolio-summary']);
  assert.equal(service.revisions?.().at(-1)?.actor.id, 'client-bot', 'the client actor is sent with edits');
  const stale = await client.actions.update_block_text({ blockId: brief.id, expectedVersion: brief.version, text: 'Stale' });
  assert.equal(stale.ok, false);
  if (!stale.ok) { assert.equal(stale.issues[0]!.code, 'conflict'); assert.match(stale.issues[0]!.hint!, /version 2/); }
  const chart = await client.actions.add_chart({ spec: { kind: 'bar', title: 'T', labels: ['a'], series: [{ name: 's', values: [1] }] } });
  assert.ok(chart.ok && chart.blockId === 'chart-1');
  const exported = await client.actions.export_markdown();
  assert.ok(exported.ok && exported.text.includes('# Weekly research notebook'));
  const untyped = await client.run('document_stats');
  assert.equal(untyped.ok, true);
  const applied = await client.apply({ id: 'client-tx', actor: { id: 'client-bot', kind: 'agent' }, baseRevision: service.read().revision, operations: [{ type: 'setTitle', title: 'Via transaction' }] });
  assert.ok(applied.ok);
  const undone = await client.undo({ id: 'client-bot', kind: 'agent' }, service.read().revision);
  assert.ok(undone.ok);
  assert.equal(service.read().title, 'Weekly research notebook');
  assert.equal((await client.openapi()).openapi, '3.1.0');
  assert.ok(seen.every(line => line.endsWith(' abc')));
  assert.ok(seen.every(line => !line.includes('//')), 'a trailing slash on baseUrl does not double up');
});

test('the client reports network, timeout and non-JSON problems as HttpClientError', async () => {
  const unreachable = createHttpClient({ baseUrl: 'http://local', fetch: (async () => { throw new Error('connection refused'); }) as typeof fetch });
  await assert.rejects(unreachable.health(), (error: unknown) => error instanceof HttpClientError && /connection refused/.test(error.message) && error.status === undefined);
  const hanging = createHttpClient({ baseUrl: 'http://local', timeoutMs: 20, fetch: ((_url: unknown, init?: RequestInit) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new Error('aborted')); }); })) as typeof fetch });
  await assert.rejects(hanging.health(), (error: unknown) => error instanceof HttpClientError && /timed out after 20 ms/.test(error.message));
  const html = createHttpClient({ baseUrl: 'http://local', fetch: (async () => new Response('<html>gateway</html>', { status: 502 })) as typeof fetch });
  await assert.rejects(html.actions.get_outline(), (error: unknown) => error instanceof HttpClientError && error.status === 502);
  assert.throws(() => createHttpClient({ baseUrl: '/relative' }), TypeError);
  const noFetch = createHttpClient({ baseUrl: 'http://local' });
  void noFetch;
});
