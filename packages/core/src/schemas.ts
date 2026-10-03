// Tool descriptions are discoverable schemas. The Core remains the runtime authority.
type Schema = Record<string, unknown>;
const string: Schema = { type: 'string', maxLength: 100_000 };
const idSchema: Schema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$' };
const timestampSchema: Schema = { type: 'string', maxLength: 30, format: 'date-time', pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{1,3})?Z$' };
const urlSchema: Schema = { type: 'string', maxLength: 4096, format: 'uri' };
const titleSchema: Schema = { type: 'string', maxLength: 1000 };
const stringArray: Schema = { type: 'array', items: string };
const integer: Schema = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const version: Schema = { ...integer, minimum: 1 };
const optionalPosition: Schema = { anyOf: [idSchema, { type: 'null' }] };
const citationIdsSchema: Schema = { type: 'array', maxItems: 2000, uniqueItems: true, items: idSchema };
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
function object(properties: Record<string, Schema>, required: string[]): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const actorSchema = object({ id: idSchema, kind: { enum: ['human', 'agent', 'system'] } }, ['id', 'kind']);
const chartSchema = object({
  kind: idSchema, title: titleSchema, labels: { type: 'array', minItems: 1, maxItems: 20_000, items: titleSchema },
  series: { type: 'array', minItems: 1, maxItems: 100, items: object({ name: titleSchema, values: { type: 'array', maxItems: 20_000, items: { type: 'number', minimum: -1e15, maximum: 1e15 } } }, ['name', 'values']) },
  unit: { type: 'string', maxLength: 100 }, asOf: timestampSchema,
}, ['kind', 'title', 'labels', 'series']);
const contentSchema: Schema = { anyOf: [
  object({ type: { const: 'section' }, title: titleSchema }, ['type', 'title']),
  object({ type: { const: 'heading' }, level: { enum: [2, 3] }, text: string }, ['type', 'level', 'text']),
  object({ type: { const: 'paragraph' }, runs: { type: 'array', maxItems: 1000, items: object({
    text: string, bold: { type: 'boolean' }, italic: { type: 'boolean' }, code: { type: 'boolean' }, href: urlSchema,
  }, ['text']) } }, ['type', 'runs']),
  object({ type: { const: 'list' }, ordered: { type: 'boolean' }, items: stringArray }, ['type', 'ordered', 'items']),
  object({ type: { const: 'table' }, columns: stringArray, rows: { type: 'array', items: stringArray } }, ['type', 'columns', 'rows']),
  object({ type: { const: 'chart' }, spec: ref('chart') }, ['type', 'spec']),
  object({ type: { const: 'embed' }, provider: { const: 'superchart' }, url: urlSchema, title: titleSchema }, ['type', 'provider', 'url', 'title']),
  object({ type: { const: 'timestamp' }, at: timestampSchema, label: titleSchema }, ['type', 'at', 'label']),
] };
const formatSchema = object({
  page: { enum: ['screen', 'A4', 'letter'] }, font: { enum: ['sans', 'serif', 'mono'] },
  fontSize: { type: 'number', minimum: 8, maximum: 72 }, lineHeight: { type: 'number', minimum: 1, maximum: 3 },
}, ['page', 'font', 'fontSize', 'lineHeight']);
const citationSchema = object({
  id: idSchema, title: titleSchema, url: urlSchema, accessedAt: timestampSchema, publishedAt: timestampSchema,
}, ['id', 'title', 'url', 'accessedAt']);
const blockSchema = object({
  id: idSchema, parentId: optionalPosition, content: ref('content'), citationIds: citationIdsSchema,
}, ['id', 'parentId', 'content', 'citationIds']);
const operationSchema: Schema = { anyOf: [
  object({ type: { const: 'insertBlock' }, block: ref('block'), afterId: optionalPosition }, ['type', 'block']),
  object({ type: { const: 'updateBlock' }, blockId: idSchema, expectedVersion: version, content: ref('content'), citationIds: citationIdsSchema }, ['type', 'blockId', 'expectedVersion', 'content']),
  object({ type: { const: 'moveBlock' }, blockId: idSchema, expectedVersion: version, parentId: optionalPosition, afterId: optionalPosition }, ['type', 'blockId', 'expectedVersion', 'parentId']),
  object({ type: { const: 'deleteBlock' }, blockId: idSchema, expectedVersion: version }, ['type', 'blockId', 'expectedVersion']),
  object({ type: { const: 'setTitle' }, title: titleSchema }, ['type', 'title']),
  object({ type: { const: 'setFormat' }, format: ref('format') }, ['type', 'format']),
  object({ type: { const: 'addCitation' }, citation: ref('citation') }, ['type', 'citation']),
] };
const transactionDefinition = object({
  id: idSchema, actor: actorSchema, baseRevision: integer,
  conflictPolicy: { enum: ['reject', 'rebase-safe'] },
  operations: { type: 'array', minItems: 1, maxItems: 256, items: ref('operation') },
}, ['id', 'actor', 'baseRevision', 'operations']);

const definitions = { operation: operationSchema, content: contentSchema, block: blockSchema,
  chart: chartSchema, format: formatSchema, citation: citationSchema };
const draft = 'https://json-schema.org/draft/2020-12/schema';

/** Structural schema. Core additionally checks graph relationships and safe URLs. */
export const transactionSchema: Schema = {
  $schema: draft, $id: 'urn:super-editor:transaction:1', title: 'Super Editor v1 Transaction',
  ...transactionDefinition, $defs: definitions,
};

export const documentSchema: Schema = {
  $schema: draft, $id: 'urn:super-editor:document:1', title: 'Super Editor v1 ResearchDocument',
  ...object({
    schemaVersion: { const: 1 }, id: idSchema, title: titleSchema, revision: integer,
    createdAt: timestampSchema, updatedAt: timestampSchema, format: ref('format'),
    blocks: { type: 'array', maxItems: 5000, items: ref('persistedBlock') },
    citations: { type: 'array', maxItems: 2000, items: ref('citation') },
    retiredBlockIds: { type: 'array', maxItems: 100_000, uniqueItems: true, items: idSchema },
  }, ['schemaVersion', 'id', 'title', 'revision', 'createdAt', 'updatedAt', 'format', 'blocks', 'citations', 'retiredBlockIds']),
  $defs: { ...definitions, persistedBlock: object({
    id: idSchema, parentId: optionalPosition, content: ref('content'), citationIds: citationIdsSchema,
    version, createdAt: timestampSchema, updatedAt: timestampSchema,
  }, ['id', 'parentId', 'content', 'citationIds', 'version', 'createdAt', 'updatedAt']) },
};

export const transactionInputSchema: Schema = {
  ...object({ transaction: ref('transaction') }, ['transaction']),
  $defs: { transaction: transactionDefinition, ...definitions },
};
export const historyInputSchema = object({ actor: actorSchema, expectedRevision: integer }, ['actor', 'expectedRevision']);
export const emptyInputSchema = object({}, []);
