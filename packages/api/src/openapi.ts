import { AGENT_ACTIONS, BLOCK_TYPES, TEMPLATE_KINDS, documentSchema, transactionSchema, type AgentAction } from '@super-solution/editor-core';
import { ROUTES, type QueryParam, type RouteDefinition } from './routes.js';

type Schema = Record<string, unknown>;
export type OpenApiOptions = {
  title?: string;
  /** Version of the API description (not of the npm package). Default "1.0.0". */
  version?: string;
  servers?: { url: string; description?: string }[];
};

const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const str: Schema = { type: 'string' };
const int: Schema = { type: 'integer' };
const strings: Schema = { type: 'array', items: str };

/**
 * OpenAPI 3.1 resolves `$ref` against the whole document, so the `$defs` of a JSON Schema are moved into
 * `components.schemas` as `<name>.<def>` and every local reference is rewritten to match.
 */
function hoist(name: string, schema: Schema, into: Record<string, Schema>): void {
  const { $schema: _schema, $id: _id, $defs, ...rest } = schema as { $schema?: unknown; $id?: unknown; $defs?: Record<string, Schema> } & Schema;
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === '$ref' && typeof entry === 'string' ? entry.replace('#/$defs/', `#/components/schemas/${name}.`) : rewrite(entry)]));
    }
    return value;
  };
  into[name] = rewrite(rest) as Schema;
  for (const [key, definition] of Object.entries($defs ?? {})) into[`${name}.${key}`] = rewrite(definition) as Schema;
}

function resultSchemas(): Record<string, Schema> {
  const brief: Schema = { type: 'object', required: ['id', 'type', 'version', 'parentId', 'text'], properties: { id: str, type: { enum: [...BLOCK_TYPES] }, version: int, parentId: { type: ['string', 'null'] }, text: str, citationIds: strings, children: int } };
  const writeProperties: Record<string, Schema> = { ok: { const: true }, revision: int, summary: str, added: strings, removed: strings, changed: strings, moved: strings, truncated: { type: 'boolean' }, duplicate: { type: 'boolean' }, dryRun: { type: 'boolean' }, revisionAfter: int,
    blocks: { type: 'array', items: { type: 'object', required: ['id', 'type', 'version'], properties: { id: str, type: { enum: [...BLOCK_TYPES] }, version: int } } } };
  return {
    Actor: { type: 'object', required: ['id', 'kind'], additionalProperties: false, properties: { id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$', maxLength: 128 }, kind: { enum: ['human', 'agent', 'system'] } } },
    EditorIssue: { type: 'object', required: ['code', 'message', 'hint'], properties: { code: { enum: ['validation', 'conflict', 'not-found', 'duplicate', 'history'] }, message: str, path: str, blockId: str, hint: { type: 'string', description: 'What to do about it.' } } },
    Failure: { type: 'object', required: ['ok', 'issues', 'currentRevision'], properties: { ok: { const: false }, issues: { type: 'array', items: ref('EditorIssue') }, currentRevision: int } },
    ApplyResult: { oneOf: [{ type: 'object', required: ['ok', 'document', 'revision'], properties: { ok: { const: true }, document: ref('Document'), revision: { type: 'object' }, duplicate: { const: true } } }, ref('Failure')] },
    BlockBrief: brief,
    WriteResult: { type: 'object', required: ['ok', 'revision', 'summary', 'added', 'removed', 'changed', 'moved', 'blocks'], properties: writeProperties, additionalProperties: true, description: 'Compact result of an edit. Some actions add fields (blockId, citationId, idPrefix, matchedBlocks, mode).' },
    OutlineResult: { type: 'object', required: ['ok', 'revision', 'title', 'blockCount', 'outline'], properties: { ok: { const: true }, revision: int, title: str, blockCount: int, outline: { type: 'array', items: { type: 'object', required: ['id', 'type', 'title', 'level', 'children'], properties: { id: str, type: { enum: ['section', 'heading'] }, title: str, level: int, children: { type: 'array', items: { type: 'object' } } } } } } },
    FindBlocksResult: { type: 'object', required: ['ok', 'revision', 'total', 'offset', 'count', 'blocks'], properties: { ok: { const: true }, revision: int, total: int, offset: int, count: int, truncated: { const: true }, blocks: { type: 'array', items: { oneOf: [ref('BlockBrief'), { type: 'object' }] } } } },
    GetBlockResult: { type: 'object', required: ['ok', 'revision', 'block', 'ancestors', 'children'], properties: { ok: { const: true }, revision: int, block: { type: 'object' }, ancestors: { type: 'array', items: ref('BlockBrief') }, children: strings, descendantCount: int } },
    StatsResult: { type: 'object', required: ['ok', 'revision', 'words', 'characters', 'blocks', 'readingMinutes'], additionalProperties: true, properties: { ok: { const: true }, revision: int, title: str, words: int, characters: int, blocks: int, charts: int, tables: int, images: int, citations: int, readingMinutes: int, blocksByType: { type: 'object', additionalProperties: int } } },
    RevisionsResult: { type: 'object', required: ['ok', 'revision', 'total', 'revisions'], properties: { ok: { const: true }, revision: int, total: int, offset: int, count: int, revisions: { type: 'array', items: { type: 'object', required: ['number', 'at', 'actor', 'kind', 'transactionId', 'summary'], properties: { number: int, at: str, actor: ref('Actor'), kind: { enum: ['apply', 'undo', 'redo'] }, transactionId: str, rebasedFrom: int, summary: str } } } } },
    ExportResult: { type: 'object', required: ['ok', 'revision', 'format', 'characters', 'text'], properties: { ok: { const: true }, revision: int, format: { enum: ['markdown', 'html', 'text'] }, characters: int, text: str } },
    ValidationResult: { type: 'object', required: ['ok', 'valid', 'revision', 'revisionAfter'], additionalProperties: true, properties: { ok: { const: true }, valid: { const: true }, revision: int, revisionAfter: int, added: strings, removed: strings, changed: strings, moved: strings } },
    TemplatesResult: { type: 'object', required: ['ok', 'templates'], properties: { ok: { const: true }, revision: int, templates: { type: 'array', items: { type: 'object', required: ['kind', 'title', 'description', 'sections'], properties: { kind: { enum: [...TEMPLATE_KINDS] }, title: str, description: str, sections: strings } } } } },
    TemplatePreview: { type: 'object', required: ['ok', 'kind', 'title', 'blocks'], properties: { ok: { const: true }, revision: int, kind: { enum: [...TEMPLATE_KINDS] }, title: str, blocks: { type: 'array', items: { type: 'object' } } } },
    ActionsResult: { type: 'object', required: ['ok', 'actions'], properties: { ok: { const: true }, revision: int, actions: { type: 'array', items: { type: 'object', required: ['name', 'title', 'description', 'access', 'inputSchema'], properties: { name: str, title: str, description: str, access: { enum: ['read', 'write'] }, destructive: { type: 'boolean' }, idempotent: { type: 'boolean' }, inputSchema: { type: 'object' } } } } } },
    ActionResult: { oneOf: [ref('WriteResult'), ref('Failure')] },
    Health: { type: 'object', required: ['ok', 'revision'], properties: { ok: { const: true }, revision: int } },
    Text: str,
    Any: {},
  };
}

const RESPONSE_FOR_ACTION: Record<string, string> = {
  get_outline: 'OutlineResult', find_blocks: 'FindBlocksResult', get_block: 'GetBlockResult', document_stats: 'StatsResult', list_revisions: 'RevisionsResult',
  export_markdown: 'ExportResult', export_html: 'ExportResult', export_text: 'ExportResult', list_templates: 'TemplatesResult', validate_transaction: 'ValidationResult',
};

const FAILURES = {
  '400': { description: 'Invalid request or edit. issues[] says what and how to fix it.', content: { 'application/json': { schema: ref('Failure') } } },
  '403': { description: 'The endpoint is read-only.', content: { 'application/json': { schema: ref('Failure') } } },
  '404': { description: 'Unknown route, action, block or citation.', content: { 'application/json': { schema: ref('Failure') } } },
  '409': { description: 'Conflict: the document or a block changed. Re-read and retry with the versions in the hint.', content: { 'application/json': { schema: ref('Failure') } } },
  '413': { description: 'The request body is too large.', content: { 'application/json': { schema: ref('Failure') } } },
  '415': { description: 'The body must be application/json.', content: { 'application/json': { schema: ref('Failure') } } },
};

function parameter(location: 'query' | 'path', name: string, schema: Schema, description: string, required = location === 'path'): Schema {
  return { name, in: location, required, description, schema };
}
function queryParameter(param: QueryParam): Schema {
  const schema: Schema = param.type === 'list' ? { type: 'array', items: str } : param.type === 'integer' ? { type: 'integer', minimum: 0 } : param.type === 'boolean' ? { type: 'boolean' } : { type: 'string', ...(param.enum ? { enum: [...param.enum] } : {}) };
  return { ...parameter('query', param.name, schema, param.description, false), ...(param.type === 'list' ? { style: 'form', explode: false } : {}) };
}
function operation(route: RouteDefinition, extra: Schema = {}): Schema {
  const parameters = [...[...route.path.matchAll(/\{(\w+)\}/g)].map(match => parameter('path', match[1]!, str, `The ${match[1]}.`)), ...(route.query ?? []).map(queryParameter)];
  const responses: Record<string, unknown> = {
    '200': { description: route.response.description, content: { [route.response.mediaType]: { schema: route.response.schema === 'Text' ? { type: 'string' } : ref(route.response.schema) } } },
    '400': FAILURES['400'], '404': FAILURES['404'], ...(route.write ? { '403': FAILURES['403'], '409': FAILURES['409'] } : {}), ...(route.body ? { '413': FAILURES['413'], '415': FAILURES['415'] } : {}),
  };
  return { operationId: route.operationId, summary: route.summary, description: route.description, tags: [route.tag], ...(parameters.length ? { parameters } : {}), responses, ...extra };
}
const jsonBody = (schema: Schema, description: string): Schema => ({ requestBody: { required: true, description, content: { 'application/json': { schema } } } });

function actionOperation(action: AgentAction): Schema {
  const response = RESPONSE_FOR_ACTION[action.name] ?? 'WriteResult';
  return {
    operationId: `action_${action.name}`, summary: action.title, description: `${action.description}\n\nSend the action input as the JSON body, plus an optional "actor". MCP tool of the same name: ${action.name}.`,
    tags: [action.access === 'read' ? 'read' : 'edit'], 'x-access': action.access, 'x-destructive': action.destructive, 'x-idempotent': action.idempotent,
    ...jsonBody(ref(`Action.${action.name}`), 'The action input.'),
    responses: { '200': { description: 'The result.', content: { 'application/json': { schema: ref(response) } } }, '400': FAILURES['400'], '403': FAILURES['403'], '404': FAILURES['404'], '409': FAILURES['409'], '413': FAILURES['413'], '415': FAILURES['415'] },
  };
}

/** The OpenAPI 3.1 description of the HTTP API, generated from the same route and action tables the handler serves. */
export function createOpenApiDocument(options: OpenApiOptions = {}): Record<string, unknown> {
  const schemas: Record<string, Schema> = resultSchemas();
  hoist('Document', documentSchema, schemas);
  hoist('Transaction', transactionSchema, schemas);
  const history: Schema = { type: 'object', required: ['actor', 'expectedRevision'], additionalProperties: false, properties: { actor: ref('Actor'), expectedRevision: int } };
  const paths: Record<string, Record<string, unknown>> = {};
  const add = (path: string, method: string, value: Schema): void => { (paths[path] ??= {})[method] = value; };

  for (const route of ROUTES) {
    if (route.path === '/actions/{name}') continue; // documented once per action below
    let extra: Schema = {};
    if (route.path === '/transactions') extra = jsonBody(ref('Transaction'), 'A Core transaction.');
    else if (route.path === '/undo' || route.path === '/redo') extra = jsonBody(history, 'The actor and the revision you last read.');
    else if (route.path === '/import/markdown') extra = { requestBody: { required: true, content: { 'application/json': { schema: ref('Action.import_markdown') }, 'text/markdown': { schema: { type: 'string' } } } } };
    add(route.path, route.method.toLowerCase(), operation(route, extra));
  }
  for (const action of AGENT_ACTIONS) {
    const properties = { ...(action.inputSchema.properties as Record<string, unknown>), actor: ref('Actor') };
    hoist(`Action.${action.name}`, { ...action.inputSchema, properties }, schemas);
    add(`/actions/${action.name}`, 'post', actionOperation(action));
  }

  return {
    openapi: '3.1.0',
    info: {
      title: options.title ?? 'Super Editor HTTP API', version: options.version ?? '1.0.0',
      description: 'Read and edit one versioned report document. Every edit is guarded: send the block version you last read and read the hint on any failure. The API does not authenticate callers; the host does.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    ...(options.servers ? { servers: options.servers } : {}),
    tags: [
      { name: 'document', description: 'The whole document.' }, { name: 'read', description: 'Cheap, focused reads.' }, { name: 'edit', description: 'Guarded edits.' },
      { name: 'export', description: 'Markdown, HTML and plain text.' }, { name: 'meta', description: 'Templates, schemas and this description.' },
    ],
    paths,
    components: { schemas },
  };
}
