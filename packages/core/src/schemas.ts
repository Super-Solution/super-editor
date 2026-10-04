import { AXIS_FORMATS, CALLOUT_TONES, HIGHLIGHTS, IMAGE_WIDTHS, LIST_STYLES, METRIC_TONES, TABLE_ALIGNMENTS } from './constants.js';

// Tool descriptions are discoverable schemas. The Core remains the runtime authority.
// JSON Schema cannot express every rule (cross-field lengths, kind-specific chart data, references); the runtime reports those with a path and a hint.
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
const finiteNumber: Schema = { type: 'number', minimum: -1e15, maximum: 1e15 };
const captionSchema: Schema = { type: 'string', maxLength: 2000 };
const colorSchema: Schema = { type: 'string', minLength: 1, maxLength: 64, description: 'Hex color, CSS color keyword or var(--token).', pattern: '^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[A-Za-z]{3,30}|var\\(--[A-Za-z0-9_-]{1,60}\\))$' };
const httpsUrlSchema: Schema = { type: 'string', maxLength: 4096, format: 'uri', pattern: '^https://' };
const nonEmpty = (max: number): Schema => ({ type: 'string', minLength: 1, maxLength: max });
const citationIdsSchema: Schema = { type: 'array', maxItems: 2000, uniqueItems: true, items: idSchema };
const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
function object(properties: Record<string, Schema>, required: string[]): Schema {
  return { type: 'object', properties, required, additionalProperties: false };
}

export const actorSchema = object({ id: idSchema, kind: { enum: ['human', 'agent', 'system'] } }, ['id', 'kind']);
const chartSchema = object({
  kind: { ...idSchema, description: `Known kinds: pie, donut, bar, trend, line, area, scatter, histogram, candlestick, heatmap, waterfall. Other kinds stay valid and render a data table. Every kind needs labels and series; scatter, candlestick and heatmap also need points, ohlc or matrix, with labels/series as the fallback table.` },
  title: titleSchema, labels: { type: 'array', minItems: 1, maxItems: 20_000, items: titleSchema },
  series: { type: 'array', minItems: 1, maxItems: 100, items: object({ name: titleSchema, values: { type: 'array', maxItems: 20_000, items: finiteNumber }, color: colorSchema }, ['name', 'values']) },
  unit: { type: 'string', maxLength: 100 }, asOf: timestampSchema,
  stacked: { type: 'boolean' }, horizontal: { type: 'boolean' },
  yAxis: object({ label: titleSchema, format: { enum: [...AXIS_FORMATS] }, min: finiteNumber, max: finiteNumber, currency: { type: 'string', pattern: '^[A-Z]{3}$' } }, []),
  xLabel: titleSchema, caption: captionSchema, source: titleSchema,
  annotations: { type: 'array', maxItems: 100, items: object({ label: nonEmpty(1000), at: nonEmpty(1000), value: finiteNumber }, ['label', 'at']) },
  points: { type: 'array', maxItems: 20_000, items: object({ series: titleSchema, x: finiteNumber, y: finiteNumber }, ['series', 'x', 'y']) },
  ohlc: { type: 'array', maxItems: 5_000, items: object({ t: nonEmpty(1000), o: finiteNumber, h: finiteNumber, l: finiteNumber, c: finiteNumber, v: { type: 'number', minimum: 0, maximum: 1e15 } }, ['t', 'o', 'h', 'l', 'c']) },
  matrix: object({ rows: { type: 'array', minItems: 1, maxItems: 200, items: titleSchema }, columns: { type: 'array', minItems: 1, maxItems: 200, items: titleSchema }, values: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'array', minItems: 1, maxItems: 200, items: finiteNumber } } }, ['rows', 'columns', 'values']),
}, ['kind', 'title', 'labels', 'series']);
const runsSchema: Schema = { type: 'array', maxItems: 1000, items: object({
  text: string, bold: { type: 'boolean' }, italic: { type: 'boolean' }, code: { type: 'boolean' }, href: urlSchema,
  strike: { type: 'boolean' }, underline: { type: 'boolean' }, highlight: { enum: [...HIGHLIGHTS] },
  citationId: { ...idSchema, description: 'Inline citation marker. Must reference an id in document.citations.' },
}, ['text']) };
const contentSchema: Schema = { anyOf: [
  object({ type: { const: 'section' }, title: titleSchema }, ['type', 'title']),
  object({ type: { const: 'heading' }, level: { enum: [1, 2, 3] }, text: string }, ['type', 'level', 'text']),
  object({ type: { const: 'paragraph' }, runs: runsSchema }, ['type', 'runs']),
  object({ type: { const: 'list' }, ordered: { type: 'boolean' }, items: { type: 'array', maxItems: 2000, items: { type: 'string', maxLength: 10_000 } },
    style: { enum: [...LIST_STYLES], description: 'bullet and todo need ordered: false, number needs ordered: true.' },
    checked: { type: 'array', maxItems: 2000, items: { type: 'boolean' }, description: 'One entry per item; only with style "todo".' },
    indent: { type: 'array', maxItems: 2000, items: { type: 'integer', minimum: 0, maximum: 3 }, description: 'One nesting level (0 to 3) per item.' },
  }, ['type', 'ordered', 'items']),
  object({ type: { const: 'table' }, columns: { type: 'array', minItems: 1, maxItems: 100, items: titleSchema }, rows: { type: 'array', maxItems: 2000, items: { type: 'array', maxItems: 100, items: { type: 'string', maxLength: 10_000 } } },
    align: { type: 'array', maxItems: 100, items: { enum: [...TABLE_ALIGNMENTS] }, description: 'One entry per column.' }, caption: captionSchema, headerColumn: { type: 'boolean' },
  }, ['type', 'columns', 'rows']),
  object({ type: { const: 'chart' }, spec: ref('chart') }, ['type', 'spec']),
  object({ type: { const: 'embed' }, provider: { const: 'superchart' }, url: httpsUrlSchema, title: titleSchema, height: { type: 'integer', minimum: 200, maximum: 1200 } }, ['type', 'provider', 'url', 'title']),
  object({ type: { const: 'timestamp' }, at: timestampSchema, label: titleSchema }, ['type', 'at', 'label']),
  object({ type: { const: 'quote' }, runs: runsSchema, attribution: titleSchema }, ['type', 'runs']),
  object({ type: { const: 'callout' }, tone: { enum: [...CALLOUT_TONES] }, title: titleSchema, runs: runsSchema }, ['type', 'tone', 'runs']),
  object({ type: { const: 'code' }, language: { type: 'string', maxLength: 40, pattern: '^[A-Za-z0-9+#._-]*$' }, text: string }, ['type', 'language', 'text']),
  object({ type: { const: 'divider' } }, ['type']),
  object({ type: { const: 'image' }, url: httpsUrlSchema, alt: titleSchema, caption: captionSchema, width: { enum: [...IMAGE_WIDTHS] } }, ['type', 'url', 'alt']),
  object({ type: { const: 'toggle' }, title: titleSchema, open: { type: 'boolean' } }, ['type', 'title', 'open']),
  object({ type: { const: 'metrics' }, items: { type: 'array', minItems: 1, maxItems: 50, items: object({ label: titleSchema, value: titleSchema, change: finiteNumber, tone: { enum: [...METRIC_TONES] }, hint: titleSchema }, ['label', 'value']) } }, ['type', 'items']),
  object({ type: { const: 'toc' } }, ['type']),
  object({ type: { const: 'pageBreak' } }, ['type']),
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
  object({ type: { const: 'insertBlocks' }, blocks: { type: 'array', minItems: 1, maxItems: 500, items: ref('block') }, afterId: optionalPosition }, ['type', 'blocks']),
  object({ type: { const: 'duplicateBlock' }, blockId: idSchema, expectedVersion: version, newIds: { type: 'object', minProperties: 1, maxProperties: 500, propertyNames: idSchema, additionalProperties: idSchema, description: 'Maps the block and every descendant (old id to new id).' }, afterId: optionalPosition }, ['type', 'blockId', 'expectedVersion', 'newIds']),
  object({ type: { const: 'replaceText' }, blockId: idSchema, expectedVersion: version, find: nonEmpty(1000), replace: string, all: { type: 'boolean' }, caseSensitive: { type: 'boolean' } }, ['type', 'blockId', 'expectedVersion', 'find', 'replace']),
  object({ type: { const: 'deleteBlocks' }, blocks: ref('blockRefs') }, ['type', 'blocks']),
  object({ type: { const: 'moveBlocks' }, blocks: ref('blockRefs'), parentId: optionalPosition, afterId: optionalPosition }, ['type', 'blocks', 'parentId']),
  object({ type: { const: 'updateCitation' }, citation: ref('citation') }, ['type', 'citation']),
  object({ type: { const: 'removeCitation' }, citationId: idSchema }, ['type', 'citationId']),
] };
const blockRefsSchema: Schema = { type: 'array', minItems: 1, maxItems: 500, items: object({ blockId: idSchema, expectedVersion: version }, ['blockId', 'expectedVersion']) };
const transactionDefinition = object({
  id: idSchema, actor: actorSchema, baseRevision: integer,
  conflictPolicy: { enum: ['reject', 'rebase-safe'] },
  operations: { type: 'array', minItems: 1, maxItems: 256, items: ref('operation') },
}, ['id', 'actor', 'baseRevision', 'operations']);

const definitions = { operation: operationSchema, content: contentSchema, block: blockSchema,
  blockRefs: blockRefsSchema, chart: chartSchema, format: formatSchema, citation: citationSchema };
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
