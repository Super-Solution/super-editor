import type { EditorIssue } from './types.js';

/** A JSON Schema fragment. Only the keywords listed in `check` are enforced. */
export type Schema = Record<string, unknown>;

const MAX_DEPTH = 40;
const MAX_NODES = 400_000;

export class InputIssue extends Error {
  constructor(readonly issue: EditorIssue) { super(issue.message); }
}
function fail(message: string, path: string, hint?: string): never {
  throw new InputIssue({ code: 'validation', message, path, ...(hint ? { hint } : {}) });
}

/**
 * Copies untrusted JSON-like input into plain data. Accessors, symbols, exotic prototypes, sparse arrays, cycles and
 * non-finite numbers are rejected without ever invoking a getter, so a hostile object cannot run code or hide state.
 */
export function plainCopy(value: unknown, path = 'input'): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  const walk = (entry: unknown, at: string, depth: number): unknown => {
    if (++nodes > MAX_NODES) fail('Input is too large.', at, 'Send less data per call.');
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') { if (!Number.isFinite(entry)) fail('Numbers must be finite.', at); return entry; }
    if (typeof entry !== 'object') fail('Only JSON values are accepted.', at, 'Use null, booleans, numbers, strings, arrays and plain objects.');
    if (depth > MAX_DEPTH) fail('Input is nested too deeply.', at);
    if (seen.has(entry)) fail('Input must not contain cycles or shared references.', at);
    seen.add(entry);
    try {
      if (Array.isArray(entry)) {
        const length = entry.length;
        if (length > 100_000) fail('Array is too long.', at);
        const copy: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
          if (!descriptor || !('value' in descriptor)) fail('Sparse arrays and accessors are not accepted.', `${at}[${index}]`);
          copy.push(walk(descriptor.value, `${at}[${index}]`, depth + 1));
        }
        return copy;
      }
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) fail('Only plain objects are accepted.', at);
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      const copy = Object.create(null) as Record<string, unknown>;
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') fail('Symbol keys are not accepted.', at);
        const descriptor = descriptors[key]!;
        if (!('value' in descriptor)) fail('Accessors are not accepted.', `${at}.${key}`);
        // Like JSON, an undefined property means "absent".
        if (descriptor.enumerable !== false && descriptor.value !== undefined) copy[key] = walk(descriptor.value, `${at}.${key}`, depth + 1);
      }
      return copy;
    } finally { seen.delete(entry); }
  };
  try { return walk(value, path, 0); }
  catch (error) {
    if (error instanceof InputIssue) throw error;
    // Revoked proxies and throwing traps count as invalid data.
    return fail('Input could not be read safely.', path);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}
function matchesType(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === 'number' && actual === 'integer');
}
function pretty(value: unknown): string { return typeof value === 'string' ? `"${value}"` : JSON.stringify(value); }

/**
 * Validates `value` against the subset of JSON Schema the action schemas use: type, enum, const, minimum, maximum,
 * minLength, maxLength, pattern, items, minItems, maxItems, uniqueItems, properties, required, additionalProperties,
 * anyOf and local `$ref`. Throws InputIssue for the first problem, with a path and a hint an agent can act on.
 */
export function check(schema: Schema, value: unknown, path: string, root: Schema = schema): void {
  if (typeof schema.$ref === 'string') {
    const target = (root.$defs as Record<string, Schema> | undefined)?.[schema.$ref.replace('#/$defs/', '')];
    if (!target) fail('Internal schema reference could not be resolved.', path);
    return check(target, value, path, root);
  }
  if (Array.isArray(schema.anyOf)) {
    let matched = false;
    let first: InputIssue | undefined;
    for (const alternative of schema.anyOf as Schema[]) {
      try { check(alternative, value, path, root); matched = true; break; }
      catch (error) { if (error instanceof InputIssue) first ??= error; else throw error; }
    }
    if (!matched) fail('The value does not match any allowed form.', path, typeof schema['x-hint'] === 'string' ? schema['x-hint'] : first?.issue.hint ?? first?.issue.message);
  }
  if (Object.hasOwn(schema, 'const') && value !== schema.const) fail(`Expected ${pretty(schema.const)}.`, path);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) fail(`Expected one of: ${(schema.enum as unknown[]).map(pretty).join(', ')}.`, path, `Use one of ${(schema.enum as unknown[]).map(pretty).join(', ')}.`);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string];
    if (!types.some(expected => matchesType(expected, value))) fail(`Expected ${types.join(' or ')}, received ${typeOf(value)}.`, path, typeof schema.description === 'string' ? schema.description : undefined);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) fail(`Expected at least ${schema.minLength} character(s).`, path);
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) fail(`Expected at most ${schema.maxLength} characters (received ${value.length}).`, path, 'Shorten the text, or split it across several calls.');
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) fail('Value has an invalid format.', path, typeof schema.description === 'string' ? schema.description : `It must match ${schema.pattern}.`);
  } else if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail(`Expected a value of at least ${schema.minimum}.`, path);
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail(`Expected a value of at most ${schema.maximum}.`, path);
  } else if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(`Expected at least ${schema.minItems} item(s).`, path);
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail(`Expected at most ${schema.maxItems} items (received ${value.length}).`, path, 'Send fewer items per call.');
    if (schema.uniqueItems === true && new Set(value.map(entry => JSON.stringify(entry))).size !== value.length) fail('Items must be unique.', path);
    if (isRecord(schema.items)) value.forEach((entry, index) => check(schema.items as Schema, entry, `${path}[${index}]`, root));
  } else if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties as Record<string, Schema> : {};
    if (Array.isArray(schema.required)) for (const key of schema.required as string[]) if (!Object.hasOwn(value, key)) fail('Required property is missing.', `${path}.${key}`, `Add "${key}".`);
    for (const [key, entry] of Object.entries(value)) {
      const property = properties[key];
      if (property === undefined) {
        if (schema.additionalProperties === false) fail('Unknown property.', `${path}.${key}`, `Remove it. Allowed properties: ${Object.keys(properties).join(', ') || '(none)'}.`);
        continue;
      }
      check(property, entry, `${path}.${key}`, root);
    }
  }
}
