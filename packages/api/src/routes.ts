import type { Actor, AgentActionResult, ReportService, TemplateKind } from '@super-solution/editor-core';
import { AGENT_ACTIONS, TEMPLATE_KINDS, TRANSPORT_LIMITS, createTemplate, documentSchema, getAgentAction, isTemplateKind, runAgentAction, templateTitle, transactionSchema } from '@super-solution/editor-core';
import { HttpProblem, failureResponse, jsonResponse, problem, statusForIssues, textResponse } from './respond.js';

export type HttpHandlerOptions = {
  /** Largest accepted request body in bytes. Default 1 MiB. */
  maxBodyBytes?: number;
  /**
   * Provenance recorded on edits. A fixed actor, or a function that derives it from the authenticated request. When set it wins
   * over any actor in a request body; when absent the body's `actor` is used, then `{ id: 'http-client', kind: 'agent' }`.
   */
  actor?: Actor | ((request: Request) => Actor);
  /** Refuse every route that can change the document with 403. */
  readOnly?: boolean;
  /** Cross-origin access. Off by default; the handler never authenticates, so only enable it behind your own auth. */
  cors?: CorsOptions;
  /** Path prefix to strip before routing, for a handler mounted below a sub-path. */
  basePath?: string;
  /** Clock for timestamps the actions create (citation `accessedAt`). */
  now?: () => string;
};
export type CorsOptions = {
  /** `'*'` or the exact origins allowed, for example `['https://app.example.com']`. */
  origins: '*' | readonly string[];
  /** Extra request headers allowed in preflight. `content-type` is always allowed. */
  headers?: readonly string[];
  /** Seconds a browser may cache a preflight answer. Default 600. */
  maxAge?: number;
};

export type QueryParam = { name: string; field: string; type: 'string' | 'integer' | 'boolean' | 'list'; description: string; enum?: readonly string[]; nullable?: boolean };
export type RouteContext = {
  service: ReportService; request: Request; url: URL; params: Record<string, string>; options: HttpHandlerOptions;
  actor(supplied?: unknown): Actor; body(): Promise<unknown>; text(): Promise<string>;
};
export type RouteDefinition = {
  method: 'GET' | 'POST';
  /** Path template; `{name}` is a path parameter. */
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tag: 'document' | 'read' | 'edit' | 'export' | 'meta';
  /** True when the route can change the document (refused on a read-only handler). */
  write: boolean;
  /** Keeps the original status rule of the Core routes (409 for a conflict, otherwise 400). */
  legacy?: boolean;
  query?: readonly QueryParam[];
  /** What the request body is. */
  body?: 'json' | 'markdown';
  response: { mediaType: string; schema: string; description: string };
  run(context: RouteContext): Response | Promise<Response>;
};

const DEFAULT_ACTOR: Actor = { id: 'http-client', kind: 'agent' };
const ACTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
export const HTTP_LIMITS = Object.freeze({ maxBodyBytes: TRANSPORT_LIMITS.requestBytes });

export function readActor(value: unknown, path: string): Actor {
  const record = value as Record<string, unknown> | null;
  if (record === null || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(key => key !== 'id' && key !== 'kind')
    || typeof record.id !== 'string' || record.id.length > 128 || !ACTOR_ID.test(record.id) || !['human', 'agent', 'system'].includes(record.kind as string)) {
    throw problem(400, 'Expected an actor: { id, kind }.', 'kind is one of human, agent or system; id uses letters, digits and . _ : - .', path);
  }
  return { id: record.id, kind: record.kind as Actor['kind'] };
}

// -------------------------------------------------------------------------------------------------- request bodies
export async function readBytes(request: Request, limit: number): Promise<Uint8Array> {
  const tooLarge = (): HttpProblem => problem(413, `The request body exceeds ${limit} bytes.`, 'Send less data per request: split large inserts into several calls.');
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) throw tooLarge();
  if (request.body === null) throw problem(400, 'A request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw tooLarge(); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}
function decode(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw problem(400, 'The request body is not valid UTF-8.'); }
}
const mediaType = (request: Request): string | undefined => request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();

// -------------------------------------------------------------------------------------------------- query strings
export function parseQuery(params: URLSearchParams, definitions: readonly QueryParam[] = []): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const key of new Set(params.keys())) {
    const definition = definitions.find(entry => entry.name === key);
    const path = `query.${key}`;
    if (!definition) throw problem(400, `Unknown query parameter "${key}".`, definitions.length ? `Allowed parameters: ${definitions.map(entry => entry.name).join(', ')}.` : 'This route takes no query parameters.', path);
    const values = params.getAll(key);
    if (definition.type !== 'list' && values.length > 1) throw problem(400, `Query parameter "${key}" was given more than once.`, 'Send it once.', path);
    const value = values[0] ?? '';
    switch (definition.type) {
      case 'list': input[definition.field] = values.flatMap(entry => entry.split(',')).map(entry => entry.trim()).filter(Boolean); break;
      case 'integer':
        if (!/^\d{1,15}$/.test(value)) throw problem(400, `Query parameter "${key}" must be a non-negative integer.`, undefined, path);
        input[definition.field] = Number(value); break;
      case 'boolean':
        if (!['true', 'false', '1', '0'].includes(value)) throw problem(400, `Query parameter "${key}" must be true or false.`, undefined, path);
        input[definition.field] = value === 'true' || value === '1'; break;
      default:
        if (definition.nullable && value === 'null') { input[definition.field] = null; break; }
        if (definition.enum && !definition.enum.includes(value)) throw problem(400, `Query parameter "${key}" must be one of: ${definition.enum.join(', ')}.`, undefined, path);
        input[definition.field] = value;
    }
  }
  return input;
}

// -------------------------------------------------------------------------------------------------- route table
const idParam = { name: 'id', field: 'blockId' };
const limitParam: QueryParam = { name: 'limit', field: 'limit', type: 'integer', description: 'Maximum results.' };
const offsetParam: QueryParam = { name: 'offset', field: 'offset', type: 'integer', description: 'Results to skip.' };
const blockIdParam: QueryParam = { name: 'blockId', field: 'blockId', type: 'string', description: 'Only this block and its descendants.' };

function respondAction(context: RouteContext, result: AgentActionResult, legacy = false): Response {
  return result.ok ? jsonResponse(result) : failureResponse(context.service, result.issues, statusForIssues(result.issues, legacy));
}
function actionContext(context: RouteContext, supplied?: unknown) {
  return { actor: context.actor(supplied), ...(context.options.now ? { now: context.options.now } : {}) };
}
function readAction(action: string, path: string, query: readonly QueryParam[], summary: string, description: string, schema: string, extra: { pathParam?: { name: string; field: string } } = {}): RouteDefinition {
  return {
    method: 'GET', path, operationId: action, summary, description, tag: 'read', write: false, query, response: { mediaType: 'application/json', schema, description: 'The result.' },
    run: context => {
      const input = parseQuery(context.url.searchParams, query);
      if (extra.pathParam) input[extra.pathParam.field] = context.params[extra.pathParam.name];
      return respondAction(context, runAgentAction(context.service, action, input, actionContext(context)));
    },
  };
}
function exportRoute(action: string, path: string, format: string, type: string, extraQuery: readonly QueryParam[] = []): RouteDefinition {
  const query = [blockIdParam, ...extraQuery];
  return {
    method: 'GET', path, operationId: action, summary: `Export the document as ${format}`, tag: 'export', write: false, query,
    description: `Returns the document (or one block with its descendants) as ${format}, as a plain ${type} response you can save or open directly.`,
    response: { mediaType: type, schema: 'Text', description: `The ${format} text.` },
    run: context => {
      const input = parseQuery(context.url.searchParams, query);
      if (action === 'export_html' && input.standalone === undefined) input.standalone = true;
      const result = runAgentAction(context.service, action, input, actionContext(context));
      if (!result.ok) return failureResponse(context.service, result.issues, statusForIssues(result.issues));
      const headers: Record<string, string> = { 'x-document-revision': String(result.revision) };
      // A generated page must stay inert even if it is opened directly: no scripts, no framing, images over https only.
      if (type === 'text/html') headers['content-security-policy'] = "default-src 'none'; img-src https:; style-src 'unsafe-inline'; sandbox";
      return textResponse(result.text as string, type, headers);
    },
  };
}
const writeRoute = (context: RouteContext, name: string, input: unknown, supplied: unknown): Response =>
  respondAction(context, runAgentAction(context.service, name, input, actionContext(context, supplied)));

function importMarkdownRoute(): RouteDefinition {
  const query: QueryParam[] = [
    { name: 'mode', field: 'mode', type: 'string', enum: ['append', 'replace'], description: 'append (default) or replace the whole body.' },
    { name: 'afterId', field: 'afterId', type: 'string', nullable: true, description: 'Append after this sibling; null for first.' },
    { name: 'parentId', field: 'parentId', type: 'string', nullable: true, description: 'Container for the blocks; null for the root.' },
    { name: 'setTitle', field: 'setTitle', type: 'boolean', description: 'Take the title from a leading "# Title" line.' },
    { name: 'idPrefix', field: 'idPrefix', type: 'string', description: 'Prefix for generated block IDs.' },
    { name: 'dryRun', field: 'dryRun', type: 'boolean', description: 'Preview without saving.' },
    { name: 'actor', field: 'actor', type: 'string', description: 'Actor as id or id:kind (only when the handler has no actor option).' },
  ];
  return {
    method: 'POST', path: '/import/markdown', operationId: 'import_markdown', tag: 'edit', write: true, body: 'markdown', query,
    summary: 'Import markdown', description: 'Import a markdown document. Send JSON (the import_markdown input) or the raw markdown with Content-Type text/markdown and the options as query parameters. mode "replace" first deletes every existing block (undoable).',
    response: { mediaType: 'application/json', schema: 'WriteResult', description: 'What changed.' },
    run: async context => {
      if (mediaType(context.request) === 'text/markdown' || mediaType(context.request) === 'text/plain') {
        const input = parseQuery(context.url.searchParams, query);
        const supplied = input.actor === undefined ? undefined : (() => { const [id, kind = 'agent'] = String(input.actor).split(':'); return { id, kind }; })();
        delete input.actor;
        return writeRoute(context, 'import_markdown', { ...input, markdown: await context.text() }, supplied);
      }
      const body = await context.body();
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'Expected a JSON object.', 'Send { "markdown": "..." }, or raw markdown with Content-Type text/markdown.');
      const { actor, ...input } = body as Record<string, unknown>;
      return writeRoute(context, 'import_markdown', input, actor);
    },
  };
}

/** Every fixed route. `POST /actions/{name}` (any action by name) is handled separately and documented per action. */
export const ROUTES: readonly RouteDefinition[] = Object.freeze([
  { method: 'GET', path: '/document', operationId: 'read_document', summary: 'Read the whole document', description: 'The complete versioned document: blocks with versions, citations, revision. Prefer /outline and /blocks for large documents.', tag: 'document', write: false, response: { mediaType: 'application/json', schema: 'Document', description: 'The document.' }, run: context => jsonResponse(context.service.read()) },
  { method: 'POST', path: '/transactions', operationId: 'apply_transaction', summary: 'Apply a Core transaction', description: 'Apply an atomic Core transaction: one revision, all or nothing. A conflict is 409, anything else invalid 400. The body is the Core transaction.', tag: 'edit', write: true, legacy: true, body: 'json', response: { mediaType: 'application/json', schema: 'ApplyResult', description: 'The accepted edit with the new document.' },
    run: async context => {
      const result = context.service.apply(await context.body());
      return result.ok ? jsonResponse(result) : failureResponse(context.service, result.issues, statusForIssues(result.issues, true));
    } },
  ...(['undo', 'redo'] as const).map((direction): RouteDefinition => ({
    method: 'POST', path: `/${direction}`, operationId: direction, summary: `${direction === 'undo' ? 'Undo' : 'Redo'} the last edit`, description: `${direction === 'undo' ? 'Undo' : 'Redo'} in this editing session. Body: { actor, expectedRevision }. History is session-scoped.`, tag: 'edit', write: true, legacy: true, body: 'json',
    response: { mediaType: 'application/json', schema: 'ApplyResult', description: 'The new document state.' },
    run: async context => {
      const body = await context.body();
      const record = body as Record<string, unknown> | null;
      if (record === null || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).some(key => key !== 'actor' && key !== 'expectedRevision')) {
        return failureResponse(context.service, [{ code: 'validation', message: 'History request requires only actor and expectedRevision.' }], 400);
      }
      // The Core validates these unknown runtime values, including malformed actors.
      const result = direction === 'undo' ? context.service.undo(record.actor as Actor, record.expectedRevision as number) : context.service.redo(record.actor as Actor, record.expectedRevision as number);
      return result.ok ? jsonResponse(result) : failureResponse(context.service, result.issues, statusForIssues(result.issues, true));
    },
  })),
  readAction('get_outline', '/outline', [{ name: 'maxDepth', field: 'maxDepth', type: 'integer', description: 'Trim the tree below this depth.' }], 'Document outline', 'Sections and headings as a nested tree with the title and revision: the cheapest way to learn the layout.', 'OutlineResult'),
  readAction('find_blocks', '/blocks', [
    { name: 'type', field: 'type', type: 'list', description: 'Block type(s), comma separated or repeated.' },
    { name: 'q', field: 'text', type: 'string', description: 'Case-insensitive text the block must contain.' },
    { name: 'parentId', field: 'parentId', type: 'string', nullable: true, description: 'Direct children of this block; "null" for top-level blocks.' },
    { name: 'within', field: 'within', type: 'string', description: 'Descendants of this container.' },
    { name: 'ids', field: 'ids', type: 'list', description: 'Only these block IDs, comma separated.' },
    { name: 'citationId', field: 'citationId', type: 'string', description: 'Blocks that cite this source.' },
    limitParam, offsetParam,
    { name: 'include', field: 'include', type: 'string', enum: ['summary', 'content'], description: 'summary (default) or full blocks.' },
  ], 'Find blocks', 'Compact block summaries (id, type, version, parentId, text preview) in document order, filtered by type, text, parent, container or citation. At most 200 per request; page with offset.', 'FindBlocksResult'),
  readAction('get_block', '/blocks/{id}', [], 'Get one block', 'One block in full with its ancestors and child IDs. Its version is what guarded edits need.', 'GetBlockResult', { pathParam: idParam }),
  readAction('document_stats', '/stats', [], 'Document statistics', 'Words, characters, reading time, block counts by type, charts, tables, images and citations.', 'StatsResult'),
  readAction('list_revisions', '/revisions', [limitParam, offsetParam], 'List revisions', 'Recent revisions of this editing session, newest first, each with a one-line summary. Session-scoped unless the host keeps durable history.', 'RevisionsResult'),
  exportRoute('export_markdown', '/export.md', 'Markdown', 'text/markdown'),
  exportRoute('export_html', '/export.html', 'HTML', 'text/html', [{ name: 'standalone', field: 'standalone', type: 'boolean', description: 'A complete page (default for this route) or an article fragment.' }]),
  exportRoute('export_text', '/export.txt', 'plain text', 'text/plain'),
  importMarkdownRoute(),
  { method: 'GET', path: '/templates', operationId: 'list_templates', summary: 'List report templates', description: 'The available report templates with their section titles.', tag: 'meta', write: false, response: { mediaType: 'application/json', schema: 'TemplatesResult', description: 'The templates.' },
    run: context => respondAction(context, runAgentAction(context.service, 'list_templates', {}, actionContext(context))) },
  { method: 'GET', path: '/templates/{kind}', operationId: 'preview_template', summary: 'Preview a template', description: `The blocks of one template (${TEMPLATE_KINDS.join(', ')}) and the title that goes with it. Nothing is inserted; use POST /actions/insert_template.`, tag: 'meta', write: false,
    query: [{ name: 'subject', field: 'subject', type: 'string', description: 'What the report is about.' }, { name: 'idPrefix', field: 'idPrefix', type: 'string', description: 'Prefix for the block IDs.' }],
    response: { mediaType: 'application/json', schema: 'TemplatePreview', description: 'The template.' },
    run: context => {
      const kind = context.params.kind ?? '';
      if (!isTemplateKind(kind)) return failureResponse(context.service, [{ code: 'not-found', message: `Unknown template "${kind}".`, hint: `Use one of: ${TEMPLATE_KINDS.join(', ')}.` }], 404);
      const input = parseQuery(context.url.searchParams, [{ name: 'subject', field: 'subject', type: 'string', description: '' }, { name: 'idPrefix', field: 'idPrefix', type: 'string', description: '' }]);
      try {
        const blocks = createTemplate(kind as TemplateKind, input as { subject?: string; idPrefix?: string });
        return jsonResponse({ ok: true, revision: context.service.read().revision, kind, title: templateTitle(kind as TemplateKind, input.subject as string | undefined), blocks });
      } catch (error) { throw problem(400, error instanceof TypeError ? error.message : 'Invalid template options.'); }
    } },
  { method: 'GET', path: '/actions', operationId: 'list_actions', summary: 'List the semantic actions', description: 'Every action with its description and JSON Schema input. Call one with POST /actions/{name}.', tag: 'meta', write: false, response: { mediaType: 'application/json', schema: 'ActionsResult', description: 'The actions.' },
    run: context => jsonResponse({ ok: true, revision: context.service.read().revision, actions: AGENT_ACTIONS.map(action => ({ name: action.name, title: action.title, description: action.description, access: action.access, destructive: action.destructive, idempotent: action.idempotent, inputSchema: action.inputSchema })) }) },
  { method: 'POST', path: '/actions/{name}', operationId: 'run_action', summary: 'Run an action by name', description: 'Run any semantic action (see GET /actions). The JSON body is the action input; an optional top-level "actor" names the author. Each action also has its own entry in the OpenAPI document.', tag: 'edit', write: false /* checked per action */, body: 'json', response: { mediaType: 'application/json', schema: 'ActionResult', description: 'The action result.' },
    run: async context => {
      const name = context.params.name ?? '';
      const action = getAgentAction(name);
      if (!action) return failureResponse(context.service, [{ code: 'not-found', message: `Unknown action "${name}".`, hint: `GET /actions lists them: ${AGENT_ACTIONS.map(entry => entry.name).join(', ')}.` }], 404);
      if (context.options.readOnly && action.access === 'write') return failureResponse(context.service, [{ code: 'validation', message: `This endpoint is read-only; "${name}" can change the document.`, hint: 'Use a read action, or ask the operator for a writable endpoint.' }], 403);
      const body = await context.body();
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw problem(400, 'Expected a JSON object with the action input.', undefined, 'body');
      const { actor, ...input } = body as Record<string, unknown>;
      return writeRoute(context, name, input, actor);
    } },
  { method: 'GET', path: '/openapi.json', operationId: 'openapi', summary: 'OpenAPI document', description: 'This API as an OpenAPI 3.1 document, generated from the live route and action tables.', tag: 'meta', write: false, response: { mediaType: 'application/json', schema: 'Any', description: 'The OpenAPI document.' }, run: () => { throw new Error('replaced by the handler'); } },
  { method: 'GET', path: '/schemas/document.json', operationId: 'document_schema', summary: 'Document JSON Schema', description: 'JSON Schema 2020-12 for the document.', tag: 'meta', write: false, response: { mediaType: 'application/schema+json', schema: 'Any', description: 'The schema.' }, run: () => jsonResponse(documentSchema) },
  { method: 'GET', path: '/schemas/transaction.json', operationId: 'transaction_schema', summary: 'Transaction JSON Schema', description: 'JSON Schema 2020-12 for transactions, operations and every block type.', tag: 'meta', write: false, response: { mediaType: 'application/schema+json', schema: 'Any', description: 'The schema.' }, run: () => jsonResponse(transactionSchema) },
  { method: 'GET', path: '/health', operationId: 'health', summary: 'Health check', description: 'Always { ok: true } with the current revision; for load balancers and smoke tests.', tag: 'meta', write: false, response: { mediaType: 'application/json', schema: 'Health', description: 'Alive.' }, run: context => jsonResponse({ ok: true, revision: context.service.read().revision }) },
]);

// -------------------------------------------------------------------------------------------------- matching
type Compiled = { route: RouteDefinition; pattern: RegExp; names: string[] };
const compiled: Compiled[] = ROUTES.map(route => {
  const names: string[] = [];
  const source = route.path.split('/').map(segment => {
    const match = /^\{(\w+)\}$/.exec(segment);
    if (match) { names.push(match[1]!); return '([^/]+)'; }
    return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { route, pattern: new RegExp(`^${source}$`), names };
});

export type Match = { route: RouteDefinition; params: Record<string, string> };
/** Finds the route for a request, or the methods the path does support (for 405 and OPTIONS). */
export function matchRoute(method: string, pathname: string): { match: Match } | { allow: string[] } | null {
  const allow: string[] = [];
  for (const entry of compiled) {
    const found = entry.pattern.exec(pathname);
    if (!found) continue;
    if (entry.route.method !== method) { if (!allow.includes(entry.route.method)) allow.push(entry.route.method); continue; }
    const params: Record<string, string> = {};
    for (const [index, name] of entry.names.entries()) {
      try { params[name] = decodeURIComponent(found[index + 1]!); }
      catch { throw problem(400, 'The path contains invalid percent-encoding.', undefined, 'path'); }
    }
    return { match: { route: entry.route, params } };
  }
  return allow.length ? { allow } : null;
}

export function createContext(service: ReportService, request: Request, url: URL, params: Record<string, string>, options: HttpHandlerOptions, limit: number): RouteContext {
  let bytes: Promise<Uint8Array> | undefined;
  const raw = (): Promise<Uint8Array> => bytes ??= readBytes(request, limit);
  return {
    service, request, url, params, options,
    actor: supplied => {
      if (options.actor !== undefined) return typeof options.actor === 'function' ? options.actor(request) : options.actor;
      return supplied === undefined ? DEFAULT_ACTOR : readActor(supplied, 'body.actor');
    },
    body: async () => {
      const type = mediaType(request);
      if (type && type !== 'application/json') throw problem(415, 'Content-Type must be application/json.', 'Send the body as JSON with Content-Type: application/json.');
      const text = decode(await raw());
      try { return JSON.parse(text) as unknown; }
      catch { throw problem(400, 'The request body is not valid JSON.', 'Send one JSON value.'); }
    },
    text: async () => decode(await raw()),
  };
}
