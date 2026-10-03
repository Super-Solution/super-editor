import type { Actor, Block, BlockContent, BlockInput, ChartSpec, Citation, DocumentFormat, EditorIssue, Operation, ResearchDocument, Transaction, ValidationResult } from './types.js';

/** Explicit limits protect both browser renderers and JSON transport boundaries. */
export const LIMITS = Object.freeze({ blocks: 5_000, depth: 64, operations: 256, citations: 2_000, text: 100_000, chartPoints: 20_000, chartMagnitude: 1e15, json: 8_000_000 });
type RecordValue = Record<string, unknown>;
class Invalid extends Error {
  constructor(readonly issue: EditorIssue) { super(issue.message); }
}
function fail(message: string, path: string): never { throw new Invalid({ code: 'validation', message, path }); }
function object(value: unknown, path: string, required: string[], optional: string[] = []): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a plain object.', path);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('Expected a plain object.', path);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || ![...required, ...optional].includes(key)) fail('Unknown property.', `${path}.${String(key)}`);
    if (!('value' in descriptors[key]!)) fail('Accessors are not accepted.', `${path}.${key}`);
  }
  for (const key of required) if (!Object.hasOwn(descriptors, key)) fail('Required property is missing.', `${path}.${key}`);
  return value as RecordValue;
}
function string(value: unknown, path: string, max: number = LIMITS.text, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) fail(`Expected ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${max} characters.`, path);
  return value;
}
function id(value: unknown, path: string): string {
  const result = string(value, path, 128, false);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) fail('ID must use ASCII letters, numbers, dots, underscores, colons or hyphens.', path);
  return result;
}
function integer(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(`Expected an integer between ${min} and ${max}.`, path);
  return value;
}
function finite(value: unknown, path: string, min = -Number.MAX_VALUE, max = Number.MAX_VALUE): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail('Expected a finite number in the supported range.', path);
  return value;
}
function boolean(value: unknown, path: string): boolean { if (typeof value !== 'boolean') fail('Expected a boolean.', path); return value; }
function enumeration<T extends string>(value: unknown, path: string, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) fail(`Expected one of: ${values.join(', ')}.`, path);
  return value as T;
}
function array<T>(value: unknown, path: string, max: number, parse: (entry: unknown, path: string) => T): T[] {
  if (!Array.isArray(value) || value.length > max) fail(`Expected an array with at most ${max} entries.`, path);
  const result: T[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) fail('Sparse arrays and accessors are not accepted.', `${path}[${index}]`);
    result.push(parse(descriptor.value, `${path}[${index}]`));
  }
  return result;
}
function unique(values: string[], path: string): void { if (new Set(values).size !== values.length) fail('IDs must be unique.', path); }

/** URL validation does not grant permission to load an embed; hosts must separately allow its origin. */
export function safeUrl(value: unknown, options: { httpsOnly?: boolean } = {}): string | null {
  if (typeof value !== 'string' || value.length > 4_096 || /[\s\\\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (!(options.httpsOnly ? parsed.protocol === 'https:' : ['http:', 'https:'].includes(parsed.protocol)) || parsed.username || parsed.password || !parsed.hostname) return null;
    return parsed.href;
  } catch { return null; }
}
function url(value: unknown, path: string, httpsOnly = false): string {
  const result = safeUrl(value, { httpsOnly });
  if (!result) fail(`Expected an absolute ${httpsOnly ? 'HTTPS' : 'HTTP or HTTPS'} URL without credentials.`, path);
  return result;
}
/** UTC ISO timestamps only; calendar rollover (such as February 30) is rejected. */
export function timestamp(value: unknown, path = 'timestamp'): string {
  const result = string(value, path, 30, false);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result)) fail('Expected an ISO UTC timestamp.', path);
  const date = new Date(result);
  const normalized = result.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) fail('Timestamp contains an invalid calendar date or time.', path);
  return result;
}
function parent(value: unknown, path: string): string | null { return value === null ? null : id(value, path); }
export function readActor(value: unknown, path = 'actor'): Actor {
  const v = object(value, path, ['id', 'kind']);
  return { id: id(v.id, `${path}.id`), kind: enumeration(v.kind, `${path}.kind`, ['human', 'agent', 'system']) };
}
function chart(value: unknown, path: string): ChartSpec {
  const v = object(value, path, ['kind', 'title', 'labels', 'series'], ['unit', 'asOf']);
  let textLength = 0;
  const labels = array(v.labels, `${path}.labels`, LIMITS.chartPoints, (entry, p) => {
    const label = string(entry, p, 1_000); textLength += label.length;
    if (textLength > LIMITS.json) fail('Chart labels exceed the supported text size.', path);
    return label;
  });
  if (!labels.length) fail('A chart requires at least one label.', `${path}.labels`);
  const series = array(v.series, `${path}.series`, 100, (entry, p) => {
    const item = object(entry, p, ['name', 'values']);
    const values = array(item.values, `${p}.values`, LIMITS.chartPoints, (entry, vp) => finite(entry, vp, -LIMITS.chartMagnitude, LIMITS.chartMagnitude));
    if (values.length !== labels.length) fail('Series length must match chart labels.', `${p}.values`);
    return { name: string(item.name, `${p}.name`, 1_000), values };
  });
  if (!series.length || labels.length * series.length > LIMITS.chartPoints) fail('Chart must contain 1 to 20,000 numeric points.', path);
  const kind = id(v.kind, `${path}.kind`);
  if (kind === 'pie' && (series.length !== 1 || series[0]!.values.some(item => item < 0) || !series[0]!.values.some(item => item > 0) || !Number.isFinite(series[0]!.values.reduce((sum, item) => sum + item, 0)))) fail('Pie charts require one nonnegative series with a finite positive total.', path);
  return { kind, title: string(v.title, `${path}.title`, 1_000), labels, series,
    ...(Object.hasOwn(v, 'unit') ? { unit: string(v.unit, `${path}.unit`, 100) } : {}),
    ...(Object.hasOwn(v, 'asOf') ? { asOf: timestamp(v.asOf, `${path}.asOf`) } : {}) };
}
function content(value: unknown, path: string): BlockContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected block content.', path);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'type');
  if (!descriptor || !('value' in descriptor)) fail('Block content type is required.', `${path}.type`);
  switch (descriptor.value) {
    case 'section': { const v = object(value, path, ['type', 'title']); return { type: 'section', title: string(v.title, `${path}.title`, 1_000) }; }
    case 'heading': { const v = object(value, path, ['type', 'level', 'text']); return { type: 'heading', level: integer(v.level, `${path}.level`, 2, 3) as 2 | 3, text: string(v.text, `${path}.text`) }; }
    case 'paragraph': {
      const v = object(value, path, ['type', 'runs']);
      const runs = array(v.runs, `${path}.runs`, 1_000, (entry, p) => {
        const run = object(entry, p, ['text'], ['bold', 'italic', 'code', 'href']);
        return { text: string(run.text, `${p}.text`),
          ...(Object.hasOwn(run, 'bold') ? { bold: boolean(run.bold, `${p}.bold`) } : {}),
          ...(Object.hasOwn(run, 'italic') ? { italic: boolean(run.italic, `${p}.italic`) } : {}),
          ...(Object.hasOwn(run, 'code') ? { code: boolean(run.code, `${p}.code`) } : {}),
          ...(Object.hasOwn(run, 'href') ? { href: url(run.href, `${p}.href`) } : {}) };
      });
      if (runs.reduce((sum, run) => sum + run.text.length, 0) > LIMITS.text) fail('Paragraph text exceeds the supported size.', path);
      return { type: 'paragraph', runs };
    }
    case 'list': {
      const v = object(value, path, ['type', 'ordered', 'items']); let textLength = 0;
      return { type: 'list', ordered: boolean(v.ordered, `${path}.ordered`), items: array(v.items, `${path}.items`, 2_000, (entry, p) => {
        const item = string(entry, p, 10_000); textLength += item.length;
        if (textLength > LIMITS.json) fail('List exceeds the supported text size.', path);
        return item;
      }) };
    }
    case 'table': {
      const v = object(value, path, ['type', 'columns', 'rows']);
      const columns = array(v.columns, `${path}.columns`, 100, (entry, p) => string(entry, p, 1_000));
      if (!columns.length) fail('Table requires at least one column.', `${path}.columns`);
      let textLength = columns.join('').length;
      const rows = array(v.rows, `${path}.rows`, Math.min(2_000, Math.floor(20_000 / columns.length)), (entry, p) => {
        const row = array(entry, p, columns.length, (cell, cp) => {
          const item = string(cell, cp, 10_000); textLength += item.length;
          if (textLength > LIMITS.json) fail('Table exceeds the supported text size.', path);
          return item;
        });
        if (row.length !== columns.length) fail('Table row width must match its columns.', p);
        return row;
      });
      if (columns.length * rows.length > 20_000) fail('Table exceeds 20,000 cells.', path);
      return { type: 'table', columns, rows };
    }
    case 'chart': { const v = object(value, path, ['type', 'spec']); return { type: 'chart', spec: chart(v.spec, `${path}.spec`) }; }
    case 'embed': { const v = object(value, path, ['type', 'provider', 'url', 'title']); return { type: 'embed', provider: enumeration(v.provider, `${path}.provider`, ['superchart']), url: url(v.url, `${path}.url`, true), title: string(v.title, `${path}.title`, 1_000) }; }
    case 'timestamp': { const v = object(value, path, ['type', 'at', 'label']); return { type: 'timestamp', at: timestamp(v.at, `${path}.at`), label: string(v.label, `${path}.label`, 1_000) }; }
    default: return fail('Unsupported block content type. Raw HTML is not supported.', `${path}.type`);
  }
}
function blockInput(value: unknown, path: string, persisted = false): BlockInput | Block {
  const v = object(value, path, ['id', 'parentId', 'content', 'citationIds', ...(persisted ? ['version', 'createdAt', 'updatedAt'] : [])]);
  const citationIds = array(v.citationIds, `${path}.citationIds`, LIMITS.citations, id);
  unique(citationIds, `${path}.citationIds`);
  const input: BlockInput = { id: id(v.id, `${path}.id`), parentId: parent(v.parentId, `${path}.parentId`), content: content(v.content, `${path}.content`), citationIds };
  return persisted ? { ...input, version: integer(v.version, `${path}.version`, 1), createdAt: timestamp(v.createdAt, `${path}.createdAt`), updatedAt: timestamp(v.updatedAt, `${path}.updatedAt`) } : input;
}
function citation(value: unknown, path: string): Citation {
  const v = object(value, path, ['id', 'title', 'url', 'accessedAt'], ['publishedAt']);
  return { id: id(v.id, `${path}.id`), title: string(v.title, `${path}.title`, 1_000), url: url(v.url, `${path}.url`), accessedAt: timestamp(v.accessedAt, `${path}.accessedAt`), ...(Object.hasOwn(v, 'publishedAt') ? { publishedAt: timestamp(v.publishedAt, `${path}.publishedAt`) } : {}) };
}
function format(value: unknown, path: string): DocumentFormat {
  const v = object(value, path, ['page', 'font', 'fontSize', 'lineHeight']);
  return { page: enumeration(v.page, `${path}.page`, ['screen', 'A4', 'letter']), font: enumeration(v.font, `${path}.font`, ['sans', 'serif', 'mono']), fontSize: finite(v.fontSize, `${path}.fontSize`, 8, 72), lineHeight: finite(v.lineHeight, `${path}.lineHeight`, 1, 3) };
}
function operation(value: unknown, path: string): Operation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an operation.', path);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'type');
  if (!descriptor || !('value' in descriptor)) fail('Operation type is required.', `${path}.type`);
  switch (descriptor.value) {
    case 'insertBlock': { const v = object(value, path, ['type', 'block'], ['afterId']); return { type: 'insertBlock', block: blockInput(v.block, `${path}.block`), ...(Object.hasOwn(v, 'afterId') ? { afterId: parent(v.afterId, `${path}.afterId`) } : {}) }; }
    case 'updateBlock': {
      const v = object(value, path, ['type', 'blockId', 'expectedVersion', 'content'], ['citationIds']);
      const citationIds = Object.hasOwn(v, 'citationIds') ? array(v.citationIds, `${path}.citationIds`, LIMITS.citations, id) : undefined;
      if (citationIds) unique(citationIds, `${path}.citationIds`);
      return { type: 'updateBlock', blockId: id(v.blockId, `${path}.blockId`), expectedVersion: integer(v.expectedVersion, `${path}.expectedVersion`, 1), content: content(v.content, `${path}.content`), ...(citationIds ? { citationIds } : {}) };
    }
    case 'moveBlock': { const v = object(value, path, ['type', 'blockId', 'expectedVersion', 'parentId'], ['afterId']); return { type: 'moveBlock', blockId: id(v.blockId, `${path}.blockId`), expectedVersion: integer(v.expectedVersion, `${path}.expectedVersion`, 1), parentId: parent(v.parentId, `${path}.parentId`), ...(Object.hasOwn(v, 'afterId') ? { afterId: parent(v.afterId, `${path}.afterId`) } : {}) }; }
    case 'deleteBlock': { const v = object(value, path, ['type', 'blockId', 'expectedVersion']); return { type: 'deleteBlock', blockId: id(v.blockId, `${path}.blockId`), expectedVersion: integer(v.expectedVersion, `${path}.expectedVersion`, 1) }; }
    case 'setTitle': { const v = object(value, path, ['type', 'title']); return { type: 'setTitle', title: string(v.title, `${path}.title`, 1_000) }; }
    case 'setFormat': { const v = object(value, path, ['type', 'format']); return { type: 'setFormat', format: format(v.format, `${path}.format`) }; }
    case 'addCitation': { const v = object(value, path, ['type', 'citation']); return { type: 'addCitation', citation: citation(v.citation, `${path}.citation`) }; }
    default: return fail('Unsupported operation type.', `${path}.type`);
  }
}
function validate<T>(reader: () => T): ValidationResult<T> {
  try { return { ok: true, value: reader() }; }
  catch (error) { return { ok: false, issues: [error instanceof Invalid ? error.issue : { code: 'validation', message: 'Input could not be safely read.' }] }; }
}
export function validateTransaction(value: unknown): ValidationResult<Transaction> {
  return validate(() => {
    const v = object(value, 'transaction', ['id', 'actor', 'baseRevision', 'operations'], ['conflictPolicy']);
    let size = 0;
    const operations = array(v.operations, 'transaction.operations', LIMITS.operations, (entry, path) => {
      const parsed = operation(entry, path); size += JSON.stringify(parsed).length;
      if (size > LIMITS.json) fail('Transaction exceeds the supported serialized size.', 'transaction');
      return parsed;
    });
    if (!operations.length) fail('A transaction requires at least one operation.', 'transaction.operations');
    const transactionId = id(v.id, 'transaction.id');
    if (transactionId.startsWith('history:')) fail('The history: transaction namespace is reserved.', 'transaction.id');
    return { id: transactionId, actor: readActor(v.actor, 'transaction.actor'), baseRevision: integer(v.baseRevision, 'transaction.baseRevision'), operations, ...(Object.hasOwn(v, 'conflictPolicy') ? { conflictPolicy: enumeration(v.conflictPolicy, 'transaction.conflictPolicy', ['reject', 'rebase-safe']) } : {}) };
  });
}
export function validateHistoryRequest(actor: unknown, expectedRevision: unknown): ValidationResult<{ actor: Actor; expectedRevision: number }> {
  return validate(() => ({ actor: readActor(actor), expectedRevision: integer(expectedRevision, 'expectedRevision') }));
}
export function validateDocument(value: unknown): ValidationResult<ResearchDocument> {
  return validate(() => {
    const v = object(value, 'document', ['schemaVersion', 'id', 'title', 'revision', 'createdAt', 'updatedAt', 'format', 'blocks', 'citations', 'retiredBlockIds']);
    integer(v.schemaVersion, 'document.schemaVersion', 1, 1);
    let size = 0;
    const blocks = array(v.blocks, 'document.blocks', LIMITS.blocks, (entry, path) => {
      const parsed = blockInput(entry, path, true) as Block; size += JSON.stringify(parsed).length;
      if (size > LIMITS.json) fail('Document exceeds the supported serialized size.', 'document');
      return parsed;
    });
    const citations = array(v.citations, 'document.citations', LIMITS.citations, citation);
    const retiredBlockIds = array(v.retiredBlockIds, 'document.retiredBlockIds', 100_000, id);
    unique(blocks.map(block => block.id), 'document.blocks'); unique(citations.map(item => item.id), 'document.citations'); unique(retiredBlockIds, 'document.retiredBlockIds');
    const byId = new Map(blocks.map(block => [block.id, block]));
    const citationIds = new Set(citations.map(item => item.id));
    // Each ancestry chain is visited once, avoiding quadratic work on deeply nested sections.
    const depth = new Map<string, number>();
    for (const block of blocks) {
      for (const reference of block.citationIds) if (!citationIds.has(reference)) fail('Citation reference does not exist.', `document.blocks.${block.id}.citationIds`);
      const chain = new Set<string>(); let cursor: Block | undefined = block; let parentDepth = 0;
      while (cursor && !depth.has(cursor.id)) {
        if (chain.has(cursor.id)) fail('Section ancestry contains a cycle.', `document.blocks.${block.id}.parentId`);
        chain.add(cursor.id);
        if (chain.size > LIMITS.depth) fail(`Document nesting exceeds ${LIMITS.depth} levels.`, `document.blocks.${block.id}.parentId`);
        if (cursor.parentId === null) { cursor = undefined; break; }
        const ancestor = byId.get(cursor.parentId);
        if (!ancestor || ancestor.content.type !== 'section') fail('Parent must reference an existing section.', `document.blocks.${cursor.id}.parentId`);
        cursor = ancestor;
      }
      if (cursor) parentDepth = depth.get(cursor.id) ?? 0;
      for (const entry of [...chain].reverse()) {
        parentDepth++;
        if (parentDepth > LIMITS.depth) fail(`Document nesting exceeds ${LIMITS.depth} levels.`, `document.blocks.${block.id}.parentId`);
        depth.set(entry, parentDepth);
      }
    }
    const result: ResearchDocument = { schemaVersion: 1, id: id(v.id, 'document.id'), title: string(v.title, 'document.title', 1_000), revision: integer(v.revision, 'document.revision'), createdAt: timestamp(v.createdAt, 'document.createdAt'), updatedAt: timestamp(v.updatedAt, 'document.updatedAt'), format: format(v.format, 'document.format'), blocks, citations, retiredBlockIds };
    if (Date.parse(result.createdAt) > Date.parse(result.updatedAt)) fail('Document update timestamp precedes creation.', 'document.updatedAt');
    for (const block of blocks) if (Date.parse(block.createdAt) > Date.parse(block.updatedAt) || Date.parse(block.updatedAt) > Date.parse(result.updatedAt)) fail('Block timestamps must follow creation and not exceed the document update timestamp.', `document.blocks.${block.id}.updatedAt`);
    if (JSON.stringify(result).length > LIMITS.json) fail('Document exceeds the supported serialized size.', 'document');
    return result;
  });
}
export function parseDocument(json: string): ValidationResult<ResearchDocument> {
  if (typeof json !== 'string' || json.length > LIMITS.json) return { ok: false, issues: [{ code: 'validation', message: 'Expected a JSON string within the supported size limit.' }] };
  try { return validateDocument(JSON.parse(json) as unknown); }
  catch { return { ok: false, issues: [{ code: 'validation', message: 'Invalid JSON.' }] }; }
}
export function serializeDocument(document: ResearchDocument): string {
  const result = validateDocument(document);
  if (!result.ok) throw new Error(result.issues[0]?.message ?? 'Invalid document.');
  return JSON.stringify(result.value);
}
