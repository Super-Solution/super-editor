import { BLOCK_TYPES, CALLOUT_TONES, AXIS_FORMATS, HIGHLIGHTS, IMAGE_WIDTHS, LIST_STYLES, METRIC_TONES, OPERATION_TYPES, TABLE_ALIGNMENTS, isContainerType } from './constants.js';
import { runsOf } from './text.js';
import type { Actor, Block, BlockContent, BlockInput, ChartSpec, Citation, DocumentFormat, EditorIssue, InlineRun, Operation, ResearchDocument, Transaction, ValidationResult } from './types.js';

/** Explicit limits protect both browser renderers and JSON transport boundaries. */
export const LIMITS = Object.freeze({
  blocks: 5_000, depth: 64, operations: 256, citations: 2_000, text: 100_000, chartPoints: 20_000, chartMagnitude: 1e15, json: 8_000_000,
  // v0.2 additions. Earlier hard-coded budgets keep their values.
  blocksPerOperation: 500, runs: 1_000, listItems: 2_000, listItemText: 10_000, listIndent: 3,
  tableColumns: 100, tableRows: 2_000, tableCells: 20_000, tableCellText: 10_000,
  title: 1_000, caption: 2_000, series: 100, annotations: 100, ohlc: 5_000, heatmapDimension: 200, heatmapCells: 20_000,
  metrics: 50, embedHeightMin: 200, embedHeightMax: 1_200, codeLanguage: 40, searchText: 1_000,
});
type RecordValue = Record<string, unknown>;
class Invalid extends Error {
  constructor(readonly issue: EditorIssue) { super(issue.message); }
}
function fail(message: string, path: string, hint?: string): never { throw new Invalid({ code: 'validation', message, path, ...(hint ? { hint } : {}) }); }
function object(value: unknown, path: string, required: string[], optional: string[] = []): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a plain object.', path, required.length ? `Provide an object with: ${required.join(', ')}${optional.length ? ` (optional: ${optional.join(', ')})` : ''}.` : undefined);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('Expected a plain object.', path);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || ![...required, ...optional].includes(key)) fail('Unknown property.', `${path}.${String(key)}`, `Remove it. Allowed properties here: ${[...required, ...optional].join(', ')}.`);
    if (!('value' in descriptors[key]!)) fail('Accessors are not accepted.', `${path}.${key}`);
  }
  for (const key of required) if (!Object.hasOwn(descriptors, key)) fail('Required property is missing.', `${path}.${key}`, `Add "${key}".`);
  return value as RecordValue;
}
function string(value: unknown, path: string, max: number = LIMITS.text, allowEmpty = true): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) fail(`Expected ${allowEmpty ? 'a' : 'a nonempty'} string of at most ${max} characters.`, path);
  return value;
}
function id(value: unknown, path: string): string {
  const result = string(value, path, 128, false);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) fail('ID must use ASCII letters, numbers, dots, underscores, colons or hyphens.', path, 'Start with a letter or digit, for example "sec-1" or "macro.summary".');
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
function unique(values: string[], path: string, hint?: string): void { if (new Set(values).size !== values.length) fail('IDs must be unique.', path, hint); }

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
  if (!result) fail(`Expected an absolute ${httpsOnly ? 'HTTPS' : 'HTTP or HTTPS'} URL without credentials.`, path, `Use a full ${httpsOnly ? 'https://' : 'http(s)://'} URL such as https://example.com/page, with no spaces and no user:password.`);
  return result;
}
/** UTC ISO timestamps only; calendar rollover (such as February 30) is rejected. */
export function timestamp(value: unknown, path = 'timestamp'): string {
  const result = string(value, path, 30, false);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result)) fail('Expected an ISO UTC timestamp.', path, 'Use a form like 2026-10-05T12:00:00Z (UTC, trailing Z).');
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

const KNOWN_KINDS: readonly string[] = ['pie', 'donut', 'bar', 'trend', 'line', 'area', 'scatter', 'histogram', 'candlestick', 'heatmap', 'waterfall'];
/** Kinds whose labels are x-axis categories, so an annotation `at` must name one of them. */
const CATEGORY_KINDS: readonly string[] = ['bar', 'trend', 'line', 'area', 'histogram', 'candlestick', 'waterfall'];
function color(value: unknown, path: string): string {
  const result = string(value, path, 64, false);
  if (!/^(?:#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[A-Za-z]{3,30}|var\(--[A-Za-z0-9_-]{1,60}\))$/.test(result)) fail('Expected a hex color (#rgb, #rrggbb), a CSS color keyword or var(--token).', path, 'Use for example "#2f6fed" or "var(--se-series-1)". Functions such as url() are not accepted.');
  return result;
}
function magnitude(value: unknown, path: string): number { return finite(value, path, -LIMITS.chartMagnitude, LIMITS.chartMagnitude); }
function chart(value: unknown, path: string): ChartSpec {
  const v = object(value, path, ['kind', 'title', 'labels', 'series'], ['unit', 'asOf', 'stacked', 'horizontal', 'yAxis', 'xLabel', 'caption', 'source', 'annotations', 'points', 'ohlc', 'matrix']);
  let textLength = 0;
  const labels = array(v.labels, `${path}.labels`, LIMITS.chartPoints, (entry, p) => {
    const label = string(entry, p, 1_000); textLength += label.length;
    if (textLength > LIMITS.json) fail('Chart labels exceed the supported text size.', path);
    return label;
  });
  if (!labels.length) fail('A chart requires at least one label.', `${path}.labels`, 'Every kind needs labels and series; scatter, candlestick and heatmap also carry a labels/series fallback table next to points, ohlc or matrix.');
  const series = array(v.series, `${path}.series`, LIMITS.series, (entry, p) => {
    const item = object(entry, p, ['name', 'values'], ['color']);
    const values = array(item.values, `${p}.values`, LIMITS.chartPoints, (entry, vp) => magnitude(entry, vp));
    if (values.length !== labels.length) fail('Series length must match chart labels.', `${p}.values`, `Provide exactly ${labels.length} values, one per label.`);
    return { name: string(item.name, `${p}.name`, 1_000), values, ...(Object.hasOwn(item, 'color') ? { color: color(item.color, `${p}.color`) } : {}) };
  });
  if (!series.length || labels.length * series.length > LIMITS.chartPoints) fail('Chart must contain 1 to 20,000 numeric points.', path);
  const kind = id(v.kind, `${path}.kind`);
  const known = KNOWN_KINDS.includes(kind);
  if ((kind === 'pie' || kind === 'donut') && (series.length !== 1 || series[0]!.values.some(item => item < 0) || !series[0]!.values.some(item => item > 0) || !Number.isFinite(series[0]!.values.reduce((sum, item) => sum + item, 0)))) fail(`${kind === 'pie' ? 'Pie' : 'Donut'} charts require one nonnegative series with a finite positive total.`, path, 'Use a single series of nonnegative values, or switch to a bar chart.');
  if (kind === 'histogram' && (series.length !== 1 || series[0]!.values.some(item => item < 0))) fail('Histogram charts require one series of nonnegative counts.', path, 'Put bin labels in labels and one count per bin in a single series.');
  if (kind === 'waterfall' && series.length !== 1) fail('Waterfall charts require exactly one series of signed deltas.', path, 'Put step names in labels and one signed change per step in a single series.');
  const points = Object.hasOwn(v, 'points') ? array(v.points, `${path}.points`, LIMITS.chartPoints, (entry, p) => {
    const point = object(entry, p, ['series', 'x', 'y']);
    return { series: string(point.series, `${p}.series`, 1_000), x: magnitude(point.x, `${p}.x`), y: magnitude(point.y, `${p}.y`) };
  }) : undefined;
  const ohlc = Object.hasOwn(v, 'ohlc') ? array(v.ohlc, `${path}.ohlc`, LIMITS.ohlc, (entry, p) => {
    const candle = object(entry, p, ['t', 'o', 'h', 'l', 'c'], ['v']);
    const o = magnitude(candle.o, `${p}.o`), h = magnitude(candle.h, `${p}.h`), l = magnitude(candle.l, `${p}.l`), c = magnitude(candle.c, `${p}.c`);
    if (l > Math.min(o, c) || h < Math.max(o, c)) fail('A candle needs low <= open/close <= high.', p, 'Check the o/h/l/c order of this candle; h must be the highest and l the lowest price.');
    return { t: string(candle.t, `${p}.t`, 1_000, false), o, h, l, c, ...(Object.hasOwn(candle, 'v') ? { v: finite(candle.v, `${p}.v`, 0, LIMITS.chartMagnitude) } : {}) };
  }) : undefined;
  const matrix = Object.hasOwn(v, 'matrix') ? (() => {
    const m = object(v.matrix, `${path}.matrix`, ['rows', 'columns', 'values']);
    const rows = array(m.rows, `${path}.matrix.rows`, LIMITS.heatmapDimension, (entry, p) => string(entry, p, 1_000));
    const columns = array(m.columns, `${path}.matrix.columns`, LIMITS.heatmapDimension, (entry, p) => string(entry, p, 1_000));
    if (!rows.length || !columns.length || rows.length * columns.length > LIMITS.heatmapCells) fail(`A heatmap needs at least one row and column and at most ${LIMITS.heatmapCells} cells.`, `${path}.matrix`);
    const cells = array(m.values, `${path}.matrix.values`, rows.length, (row, rp) => array(row, rp, columns.length, (cell, cp) => magnitude(cell, cp)));
    if (cells.length !== rows.length || cells.some(row => row.length !== columns.length)) fail('Heatmap values must have one row per rows entry and one cell per column.', `${path}.matrix.values`, `Provide ${rows.length} rows of ${columns.length} numbers.`);
    return { rows, columns, values: cells };
  })() : undefined;
  if (known) {
    if (points && kind !== 'scatter') fail('points are only valid for scatter charts.', `${path}.points`, 'Remove points or set kind to "scatter".');
    if (ohlc && kind !== 'candlestick') fail('ohlc is only valid for candlestick charts.', `${path}.ohlc`, 'Remove ohlc or set kind to "candlestick".');
    if (matrix && kind !== 'heatmap') fail('matrix is only valid for heatmap charts.', `${path}.matrix`, 'Remove matrix or set kind to "heatmap".');
  }
  if (kind === 'scatter' && !points?.length) fail('Scatter charts require points.', `${path}.points`, 'Provide points: [{series, x, y}, ...] next to the labels/series fallback table.');
  if (kind === 'candlestick' && !ohlc?.length) fail('Candlestick charts require ohlc candles.', `${path}.ohlc`, 'Provide ohlc: [{t, o, h, l, c, v?}, ...] next to the labels/series close-price fallback.');
  if (kind === 'heatmap' && !matrix) fail('Heatmap charts require a matrix.', `${path}.matrix`, 'Provide matrix: {rows, columns, values} next to the labels/series fallback table.');
  const yAxis = Object.hasOwn(v, 'yAxis') ? (() => {
    const axis = object(v.yAxis, `${path}.yAxis`, [], ['label', 'format', 'min', 'max', 'currency']);
    const min = Object.hasOwn(axis, 'min') ? magnitude(axis.min, `${path}.yAxis.min`) : undefined, max = Object.hasOwn(axis, 'max') ? magnitude(axis.max, `${path}.yAxis.max`) : undefined;
    if (min !== undefined && max !== undefined && min >= max) fail('yAxis.min must be less than yAxis.max.', `${path}.yAxis`);
    const currency = Object.hasOwn(axis, 'currency') ? string(axis.currency, `${path}.yAxis.currency`, 3, false) : undefined;
    if (currency !== undefined && !/^[A-Z]{3}$/.test(currency)) fail('Expected a three-letter ISO 4217 currency code.', `${path}.yAxis.currency`, 'Use for example "USD".');
    return { ...(Object.hasOwn(axis, 'label') ? { label: string(axis.label, `${path}.yAxis.label`, LIMITS.title) } : {}),
      ...(Object.hasOwn(axis, 'format') ? { format: enumeration(axis.format, `${path}.yAxis.format`, AXIS_FORMATS) } : {}),
      ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}), ...(currency !== undefined ? { currency } : {}) };
  })() : undefined;
  const annotations = Object.hasOwn(v, 'annotations') ? array(v.annotations, `${path}.annotations`, LIMITS.annotations, (entry, p) => {
    const note = object(entry, p, ['label', 'at'], ['value']);
    const at = string(note.at, `${p}.at`, 1_000, false);
    if (CATEGORY_KINDS.includes(kind) && !labels.includes(at)) fail('Annotation "at" must be one of the chart labels.', `${p}.at`, `Use one of: ${labels.slice(0, 8).join(', ')}${labels.length > 8 ? ', ...' : ''}.`);
    return { label: string(note.label, `${p}.label`, 1_000, false), at, ...(Object.hasOwn(note, 'value') ? { value: magnitude(note.value, `${p}.value`) } : {}) };
  }) : undefined;
  return { kind, title: string(v.title, `${path}.title`, 1_000), labels, series,
    ...(Object.hasOwn(v, 'unit') ? { unit: string(v.unit, `${path}.unit`, 100) } : {}),
    ...(Object.hasOwn(v, 'asOf') ? { asOf: timestamp(v.asOf, `${path}.asOf`) } : {}),
    ...(Object.hasOwn(v, 'stacked') ? { stacked: boolean(v.stacked, `${path}.stacked`) } : {}),
    ...(Object.hasOwn(v, 'horizontal') ? { horizontal: boolean(v.horizontal, `${path}.horizontal`) } : {}),
    ...(yAxis ? { yAxis } : {}),
    ...(Object.hasOwn(v, 'xLabel') ? { xLabel: string(v.xLabel, `${path}.xLabel`, LIMITS.title) } : {}),
    ...(Object.hasOwn(v, 'caption') ? { caption: string(v.caption, `${path}.caption`, LIMITS.caption) } : {}),
    ...(Object.hasOwn(v, 'source') ? { source: string(v.source, `${path}.source`, LIMITS.title) } : {}),
    ...(annotations ? { annotations } : {}), ...(points ? { points } : {}), ...(ohlc ? { ohlc } : {}), ...(matrix ? { matrix } : {}) };
}
function runs(value: unknown, path: string): InlineRun[] {
  const parsed = array(value, path, LIMITS.runs, (entry, p) => {
    const run = object(entry, p, ['text'], ['bold', 'italic', 'code', 'href', 'strike', 'underline', 'highlight', 'citationId']);
    return { text: string(run.text, `${p}.text`),
      ...(Object.hasOwn(run, 'bold') ? { bold: boolean(run.bold, `${p}.bold`) } : {}),
      ...(Object.hasOwn(run, 'italic') ? { italic: boolean(run.italic, `${p}.italic`) } : {}),
      ...(Object.hasOwn(run, 'code') ? { code: boolean(run.code, `${p}.code`) } : {}),
      ...(Object.hasOwn(run, 'href') ? { href: url(run.href, `${p}.href`) } : {}),
      ...(Object.hasOwn(run, 'strike') ? { strike: boolean(run.strike, `${p}.strike`) } : {}),
      ...(Object.hasOwn(run, 'underline') ? { underline: boolean(run.underline, `${p}.underline`) } : {}),
      ...(Object.hasOwn(run, 'highlight') ? { highlight: enumeration(run.highlight, `${p}.highlight`, HIGHLIGHTS) } : {}),
      ...(Object.hasOwn(run, 'citationId') ? { citationId: id(run.citationId, `${p}.citationId`) } : {}) };
  });
  if (parsed.reduce((sum, run) => sum + run.text.length, 0) > LIMITS.text) fail('Text exceeds the supported size.', path);
  return parsed;
}
function content(value: unknown, path: string): BlockContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected block content.', path, `Provide an object such as {"type":"paragraph","runs":[{"text":"..."}]}. Block types: ${BLOCK_TYPES.join(', ')}.`);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'type');
  if (!descriptor || !('value' in descriptor)) fail('Block content type is required.', `${path}.type`, `Use one of: ${BLOCK_TYPES.join(', ')}.`);
  switch (descriptor.value) {
    case 'section': { const v = object(value, path, ['type', 'title']); return { type: 'section', title: string(v.title, `${path}.title`, LIMITS.title) }; }
    case 'heading': { const v = object(value, path, ['type', 'level', 'text']); return { type: 'heading', level: integer(v.level, `${path}.level`, 1, 3) as 1 | 2 | 3, text: string(v.text, `${path}.text`) }; }
    case 'paragraph': { const v = object(value, path, ['type', 'runs']); return { type: 'paragraph', runs: runs(v.runs, `${path}.runs`) }; }
    case 'list': {
      const v = object(value, path, ['type', 'ordered', 'items'], ['style', 'checked', 'indent']); let textLength = 0;
      const ordered = boolean(v.ordered, `${path}.ordered`);
      const items = array(v.items, `${path}.items`, LIMITS.listItems, (entry, p) => {
        const item = string(entry, p, LIMITS.listItemText); textLength += item.length;
        if (textLength > LIMITS.json) fail('List exceeds the supported text size.', path);
        return item;
      });
      const style = Object.hasOwn(v, 'style') ? enumeration(v.style, `${path}.style`, LIST_STYLES) : undefined;
      if (style === 'number' && !ordered) fail('A "number" list must set ordered: true.', `${path}.ordered`, 'Set ordered: true, or use style "bullet".');
      if ((style === 'bullet' || style === 'todo') && ordered) fail(`A "${style}" list must set ordered: false.`, `${path}.ordered`, 'Set ordered: false, or use style "number".');
      const checked = Object.hasOwn(v, 'checked') ? array(v.checked, `${path}.checked`, LIMITS.listItems, boolean) : undefined;
      if (checked && style !== 'todo') fail('checked is only valid on a "todo" list.', `${path}.checked`, 'Set style: "todo" (with ordered: false) or remove checked.');
      if (checked && checked.length !== items.length) fail('checked must have one entry per list item.', `${path}.checked`, `Provide ${items.length} booleans.`);
      const indent = Object.hasOwn(v, 'indent') ? array(v.indent, `${path}.indent`, LIMITS.listItems, (entry, p) => integer(entry, p, 0, LIMITS.listIndent)) : undefined;
      if (indent && indent.length !== items.length) fail('indent must have one entry per list item.', `${path}.indent`, `Provide ${items.length} integers from 0 to ${LIMITS.listIndent}.`);
      return { type: 'list', ordered, items, ...(style ? { style } : {}), ...(checked ? { checked } : {}), ...(indent ? { indent } : {}) };
    }
    case 'table': {
      const v = object(value, path, ['type', 'columns', 'rows'], ['align', 'caption', 'headerColumn']);
      const columns = array(v.columns, `${path}.columns`, LIMITS.tableColumns, (entry, p) => string(entry, p, LIMITS.title));
      if (!columns.length) fail('Table requires at least one column.', `${path}.columns`);
      let textLength = columns.join('').length;
      const rows = array(v.rows, `${path}.rows`, Math.min(LIMITS.tableRows, Math.floor(LIMITS.tableCells / columns.length)), (entry, p) => {
        const row = array(entry, p, columns.length, (cell, cp) => {
          const item = string(cell, cp, LIMITS.tableCellText); textLength += item.length;
          if (textLength > LIMITS.json) fail('Table exceeds the supported text size.', path);
          return item;
        });
        if (row.length !== columns.length) fail('Table row width must match its columns.', p, `Each row needs exactly ${columns.length} cells.`);
        return row;
      });
      if (columns.length * rows.length > LIMITS.tableCells) fail(`Table exceeds ${LIMITS.tableCells} cells.`, path);
      const align = Object.hasOwn(v, 'align') ? array(v.align, `${path}.align`, LIMITS.tableColumns, (entry, p) => enumeration(entry, p, TABLE_ALIGNMENTS)) : undefined;
      if (align && align.length !== columns.length) fail('align must have one entry per column.', `${path}.align`, `Provide ${columns.length} entries of left, center or right.`);
      return { type: 'table', columns, rows, ...(align ? { align } : {}),
        ...(Object.hasOwn(v, 'caption') ? { caption: string(v.caption, `${path}.caption`, LIMITS.caption) } : {}),
        ...(Object.hasOwn(v, 'headerColumn') ? { headerColumn: boolean(v.headerColumn, `${path}.headerColumn`) } : {}) };
    }
    case 'chart': { const v = object(value, path, ['type', 'spec']); return { type: 'chart', spec: chart(v.spec, `${path}.spec`) }; }
    case 'embed': {
      const v = object(value, path, ['type', 'provider', 'url', 'title'], ['height']);
      return { type: 'embed', provider: enumeration(v.provider, `${path}.provider`, ['superchart']), url: url(v.url, `${path}.url`, true), title: string(v.title, `${path}.title`, LIMITS.title),
        ...(Object.hasOwn(v, 'height') ? { height: integer(v.height, `${path}.height`, LIMITS.embedHeightMin, LIMITS.embedHeightMax) } : {}) };
    }
    case 'timestamp': { const v = object(value, path, ['type', 'at', 'label']); return { type: 'timestamp', at: timestamp(v.at, `${path}.at`), label: string(v.label, `${path}.label`, LIMITS.title) }; }
    case 'quote': {
      const v = object(value, path, ['type', 'runs'], ['attribution']);
      return { type: 'quote', runs: runs(v.runs, `${path}.runs`), ...(Object.hasOwn(v, 'attribution') ? { attribution: string(v.attribution, `${path}.attribution`, LIMITS.title) } : {}) };
    }
    case 'callout': {
      const v = object(value, path, ['type', 'tone', 'runs'], ['title']);
      return { type: 'callout', tone: enumeration(v.tone, `${path}.tone`, CALLOUT_TONES), ...(Object.hasOwn(v, 'title') ? { title: string(v.title, `${path}.title`, LIMITS.title) } : {}), runs: runs(v.runs, `${path}.runs`) };
    }
    case 'code': {
      const v = object(value, path, ['type', 'language', 'text']);
      const language = string(v.language, `${path}.language`, LIMITS.codeLanguage);
      if (!/^[A-Za-z0-9+#._-]*$/.test(language)) fail('Language must use letters, digits and + # . _ - only.', `${path}.language`, 'Use a short name such as "ts", "python" or "sql", or "" for plain text.');
      return { type: 'code', language, text: string(v.text, `${path}.text`) };
    }
    case 'divider': object(value, path, ['type']); return { type: 'divider' };
    case 'image': {
      const v = object(value, path, ['type', 'url', 'alt'], ['caption', 'width']);
      return { type: 'image', url: url(v.url, `${path}.url`, true), alt: string(v.alt, `${path}.alt`, LIMITS.title),
        ...(Object.hasOwn(v, 'caption') ? { caption: string(v.caption, `${path}.caption`, LIMITS.caption) } : {}),
        ...(Object.hasOwn(v, 'width') ? { width: enumeration(v.width, `${path}.width`, IMAGE_WIDTHS) } : {}) };
    }
    case 'toggle': { const v = object(value, path, ['type', 'title', 'open']); return { type: 'toggle', title: string(v.title, `${path}.title`, LIMITS.title), open: boolean(v.open, `${path}.open`) }; }
    case 'metrics': {
      const v = object(value, path, ['type', 'items']);
      const items = array(v.items, `${path}.items`, LIMITS.metrics, (entry, p) => {
        const item = object(entry, p, ['label', 'value'], ['change', 'tone', 'hint']);
        return { label: string(item.label, `${p}.label`, LIMITS.title), value: string(item.value, `${p}.value`, LIMITS.title),
          ...(Object.hasOwn(item, 'change') ? { change: magnitude(item.change, `${p}.change`) } : {}),
          ...(Object.hasOwn(item, 'tone') ? { tone: enumeration(item.tone, `${p}.tone`, METRIC_TONES) } : {}),
          ...(Object.hasOwn(item, 'hint') ? { hint: string(item.hint, `${p}.hint`, LIMITS.title) } : {}) };
      });
      if (!items.length) fail('A metrics block requires at least one item.', `${path}.items`, 'Provide items: [{label, value, change?, tone?, hint?}, ...].');
      return { type: 'metrics', items };
    }
    case 'toc': object(value, path, ['type']); return { type: 'toc' };
    case 'pageBreak': object(value, path, ['type']); return { type: 'pageBreak' };
    default: return fail('Unsupported block content type. Raw HTML is not supported.', `${path}.type`, `Use one of: ${BLOCK_TYPES.join(', ')}.`);
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
function blockRefs(value: unknown, path: string): { blockId: string; expectedVersion: number }[] {
  const refs = array(value, path, LIMITS.blocksPerOperation, (entry, p) => {
    const ref = object(entry, p, ['blockId', 'expectedVersion']);
    return { blockId: id(ref.blockId, `${p}.blockId`), expectedVersion: integer(ref.expectedVersion, `${p}.expectedVersion`, 1) };
  });
  if (!refs.length) fail('At least one block is required.', path);
  unique(refs.map(ref => ref.blockId), path, 'List each block once.');
  return refs;
}
/** A plain object whose keys and values are all block IDs. */
function idMap(value: unknown, path: string): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an object mapping old block IDs to new block IDs.', path, 'Example: {"intro":"intro-copy"}. Include the block and every descendant.');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('Expected a plain object.', path);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (!keys.length || keys.length > LIMITS.blocksPerOperation) fail(`Expected between 1 and ${LIMITS.blocksPerOperation} ID mappings.`, path);
  const result: Record<string, string> = {};
  for (const key of keys) {
    if (typeof key !== 'string') fail('Symbol keys are not accepted.', path);
    const descriptor = descriptors[key]!;
    if (!('value' in descriptor)) fail('Accessors are not accepted.', `${path}.${key}`);
    result[id(key, `${path}.${key}`)] = id(descriptor.value, `${path}.${key}`);
  }
  unique(Object.values(result), path, 'Every new ID must be different.');
  return result;
}
function operation(value: unknown, path: string): Operation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected an operation.', path, `Provide an object such as {"type":"setTitle","title":"..."}. Operation types: ${OPERATION_TYPES.join(', ')}.`);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'type');
  if (!descriptor || !('value' in descriptor)) fail('Operation type is required.', `${path}.type`, `Use one of: ${OPERATION_TYPES.join(', ')}.`);
  const after = (v: RecordValue): { afterId?: string | null } => Object.hasOwn(v, 'afterId') ? { afterId: parent(v.afterId, `${path}.afterId`) } : {};
  switch (descriptor.value) {
    case 'insertBlock': { const v = object(value, path, ['type', 'block'], ['afterId']); return { type: 'insertBlock', block: blockInput(v.block, `${path}.block`), ...after(v) }; }
    case 'updateBlock': {
      const v = object(value, path, ['type', 'blockId', 'expectedVersion', 'content'], ['citationIds']);
      const citationIds = Object.hasOwn(v, 'citationIds') ? array(v.citationIds, `${path}.citationIds`, LIMITS.citations, id) : undefined;
      if (citationIds) unique(citationIds, `${path}.citationIds`);
      return { type: 'updateBlock', blockId: id(v.blockId, `${path}.blockId`), expectedVersion: integer(v.expectedVersion, `${path}.expectedVersion`, 1), content: content(v.content, `${path}.content`), ...(citationIds ? { citationIds } : {}) };
    }
    case 'moveBlock': { const v = object(value, path, ['type', 'blockId', 'expectedVersion', 'parentId'], ['afterId']); return { type: 'moveBlock', blockId: id(v.blockId, `${path}.blockId`), expectedVersion: integer(v.expectedVersion, `${path}.expectedVersion`, 1), parentId: parent(v.parentId, `${path}.parentId`), ...after(v) }; }
    case 'deleteBlock': { const v = object(value, path, ['type', 'blockId', 'expectedVersion']); return { type: 'deleteBlock', blockId: id(v.blockId, `${path}.blockId`), expectedVersion: integer(v.expectedVersion, `${path}.expectedVersion`, 1) }; }
    case 'setTitle': { const v = object(value, path, ['type', 'title']); return { type: 'setTitle', title: string(v.title, `${path}.title`, 1_000) }; }
    case 'setFormat': { const v = object(value, path, ['type', 'format']); return { type: 'setFormat', format: format(v.format, `${path}.format`) }; }
    case 'addCitation': { const v = object(value, path, ['type', 'citation']); return { type: 'addCitation', citation: citation(v.citation, `${path}.citation`) }; }
    case 'insertBlocks': {
      const v = object(value, path, ['type', 'blocks'], ['afterId']);
      const blocks = array(v.blocks, `${path}.blocks`, LIMITS.blocksPerOperation, (entry, p) => blockInput(entry, p) as BlockInput);
      if (!blocks.length) fail('insertBlocks requires at least one block.', `${path}.blocks`);
      unique(blocks.map(block => block.id), `${path}.blocks`, 'Each inserted block needs its own new ID.');
      return { type: 'insertBlocks', blocks, ...after(v) };
    }
    case 'duplicateBlock': {
      const v = object(value, path, ['type', 'blockId', 'expectedVersion', 'newIds'], ['afterId']);
      const blockId = id(v.blockId, `${path}.blockId`), newIds = idMap(v.newIds, `${path}.newIds`);
      if (!Object.hasOwn(newIds, blockId)) fail('newIds must include the duplicated block itself.', `${path}.newIds`, `Add "${blockId}": "<new id>".`);
      return { type: 'duplicateBlock', blockId, expectedVersion: integer(v.expectedVersion, `${path}.expectedVersion`, 1), newIds, ...after(v) };
    }
    case 'replaceText': {
      const v = object(value, path, ['type', 'blockId', 'expectedVersion', 'find', 'replace'], ['all', 'caseSensitive']);
      return { type: 'replaceText', blockId: id(v.blockId, `${path}.blockId`), expectedVersion: integer(v.expectedVersion, `${path}.expectedVersion`, 1),
        find: string(v.find, `${path}.find`, LIMITS.searchText, false), replace: string(v.replace, `${path}.replace`),
        ...(Object.hasOwn(v, 'all') ? { all: boolean(v.all, `${path}.all`) } : {}), ...(Object.hasOwn(v, 'caseSensitive') ? { caseSensitive: boolean(v.caseSensitive, `${path}.caseSensitive`) } : {}) };
    }
    case 'deleteBlocks': { const v = object(value, path, ['type', 'blocks']); return { type: 'deleteBlocks', blocks: blockRefs(v.blocks, `${path}.blocks`) }; }
    case 'moveBlocks': { const v = object(value, path, ['type', 'blocks', 'parentId'], ['afterId']); return { type: 'moveBlocks', blocks: blockRefs(v.blocks, `${path}.blocks`), parentId: parent(v.parentId, `${path}.parentId`), ...after(v) }; }
    case 'updateCitation': { const v = object(value, path, ['type', 'citation']); return { type: 'updateCitation', citation: citation(v.citation, `${path}.citation`) }; }
    case 'removeCitation': { const v = object(value, path, ['type', 'citationId']); return { type: 'removeCitation', citationId: id(v.citationId, `${path}.citationId`) }; }
    default: return fail('Unsupported operation type.', `${path}.type`, `Use one of: ${OPERATION_TYPES.join(', ')}.`);
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
    if (!operations.length) fail('A transaction requires at least one operation.', 'transaction.operations', 'Add at least one operation, for example {"type":"setTitle","title":"..."}.');
    const transactionId = id(v.id, 'transaction.id');
    if (transactionId.startsWith('history:')) fail('The history: transaction namespace is reserved.', 'transaction.id', 'Choose a transaction ID that does not start with "history:".');
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
      for (const reference of block.citationIds) if (!citationIds.has(reference)) fail('Citation reference does not exist.', `document.blocks.${block.id}.citationIds`, `Add citation "${reference}" with addCitation (the same transaction is fine) or remove the reference.`);
      runsOf(block.content)?.forEach((run, index) => {
        if (run.citationId !== undefined && !citationIds.has(run.citationId)) fail('Inline citation reference does not exist.', `document.blocks.${block.id}.content.runs[${index}].citationId`, `Add citation "${run.citationId}" with addCitation (the same transaction is fine) or remove citationId from the run.`);
      });
      const chain = new Set<string>(); let cursor: Block | undefined = block; let parentDepth = 0;
      while (cursor && !depth.has(cursor.id)) {
        if (chain.has(cursor.id)) fail('Section ancestry contains a cycle.', `document.blocks.${block.id}.parentId`);
        chain.add(cursor.id);
        if (chain.size > LIMITS.depth) fail(`Document nesting exceeds ${LIMITS.depth} levels.`, `document.blocks.${block.id}.parentId`);
        if (cursor.parentId === null) { cursor = undefined; break; }
        const ancestor = byId.get(cursor.parentId);
        if (!ancestor || !isContainerType(ancestor.content.type)) fail('Parent must reference an existing section or toggle.', `document.blocks.${cursor.id}.parentId`, 'Only section and toggle blocks can contain other blocks. Insert the container first (earlier in the same batch is fine) or use parentId: null.');
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
