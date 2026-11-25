// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { AGENT_ACTIONS, type AgentAction, type AgentActionContext, type AgentActionResult } from './actions.js';
import type { FormatRegistry } from './formats.js';
import { InputIssue, check, plainCopy, type Schema } from './input-check.js';
import { withHints } from './issues.js';
import { descendantsOf } from './query.js';
import type { ReportService } from './service.js';
import type { EditorIssue } from './types.js';

/**
 * An action a transport serves. Every entry of the shared `AGENT_ACTIONS` is one, so a transport that is given nothing extra behaves
 * exactly as before. An extra action (a format export, a host's own read) differs only in that `run` may be asynchronous.
 */
export type TransportAction = Omit<AgentAction, 'run'> & {
  run(service: ReportService, input: unknown, context?: AgentActionContext): AgentActionResult | Promise<AgentActionResult>;
};
/** The actions a transport serves, in order, with lookup by name. */
export type ActionTable = { readonly list: readonly TransportAction[]; get(name: string): TransportAction | undefined; names(): string[] };

const NAME = /^[a-z]+(?:_[a-z]+)*$/;
/**
 * Checks a transport's action list and returns its table. Throws a `TypeError` that names the problem (a duplicate name, a name a
 * transport reserves for its own tools, a missing `run`, a schema that is not an object schema), so a wrong list fails when the
 * server starts, not on the first request. Without a list it is the shared `AGENT_ACTIONS`.
 */
export function resolveActions(actions?: readonly TransportAction[], reserved: readonly string[] = []): ActionTable {
  const list: readonly TransportAction[] = actions ?? AGENT_ACTIONS;
  if (!Array.isArray(list)) throw new TypeError('actions must be an array of actions, for example [...AGENT_ACTIONS, ...formatActions(registry)].');
  const byName = new Map<string, TransportAction>();
  list.forEach((action, index) => {
    const at = `actions[${index}]`;
    if (typeof action !== 'object' || action === null) throw new TypeError(`${at} must be an action object.`);
    if (typeof action.name !== 'string' || !NAME.test(action.name)) throw new TypeError(`${at}.name must be snake_case (for example "export_document"); got ${JSON.stringify(action.name)}.`);
    if (byName.has(action.name)) throw new TypeError(`Two actions are named "${action.name}". Action names are the tool name and the route, so they must be unique.`);
    if (reserved.includes(action.name)) throw new TypeError(`"${action.name}" is the name of a tool this transport already has; choose another name.`);
    if (typeof action.run !== 'function') throw new TypeError(`${at} ("${action.name}") needs a run(service, input, context) function.`);
    if (action.access !== 'read' && action.access !== 'write') throw new TypeError(`${at} ("${action.name}").access must be "read" or "write".`);
    if (typeof action.destructive !== 'boolean' || typeof action.idempotent !== 'boolean') throw new TypeError(`${at} ("${action.name}") needs boolean destructive and idempotent flags.`);
    if (typeof action.title !== 'string' || typeof action.description !== 'string' || action.description.length === 0) throw new TypeError(`${at} ("${action.name}") needs a title and a description written for a model.`);
    if (typeof action.inputSchema !== 'object' || action.inputSchema === null || action.inputSchema.type !== 'object') throw new TypeError(`${at} ("${action.name}").inputSchema must be a JSON Schema with type "object".`);
    byName.set(action.name, action);
  });
  const frozen = Object.freeze([...list]);
  return Object.freeze({ list: frozen, get: (name: string) => byName.get(name), names: () => frozen.map(action => action.name) });
}

const failure = (service: ReportService, issues: EditorIssue[]): AgentActionResult => ({ ok: false, issues: withHints(issues), currentRevision: service.read().revision });
/**
 * Runs one action of a table by name. Never throws or rejects: an unknown name, a bad input and an action that throws all come back as
 * `{ ok: false, issues, currentRevision }`, like `runAgentAction`.
 */
export async function runTransportAction(table: ActionTable, service: ReportService, name: string, input: unknown, context: AgentActionContext = {}): Promise<AgentActionResult> {
  const action = table.get(name);
  if (!action) return failure(service, [{ code: 'not-found', message: `Unknown action "${name}".`, hint: `Available actions: ${table.names().join(', ')}.` }]);
  try { return await action.run(service, input, context); }
  catch { return failure(service, [{ code: 'validation', message: `The action "${name}" could not be completed safely.`, hint: 'Check the input against the action schema and retry; if it keeps failing, report it with the action name.' }]); }
}

// ---------------------------------------------------------------------------------------------------- formats
/** Largest export a format action returns inline, in bytes (a Word file is base64 text inside JSON). */
export const FORMAT_EXPORT_BYTES = 8 * 1024 * 1024;
const idS: Schema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$', description: 'Letters, digits and . _ : - ; starts with a letter or digit.' };
const objectOf = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let start = 0; start < bytes.length; start += 0x8000) binary += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  return btoa(binary);
};
const invalid = (service: ReportService, error: unknown): AgentActionResult => failure(service, [error instanceof InputIssue ? error.issue : { code: 'validation', message: 'The action could not be completed safely.', hint: 'Check the input against the action schema and retry.' }]);

/**
 * Actions that list and run the exporters of a format registry, for a transport to serve next to the shared ones:
 *
 *     createHttpHandler(service, { actions: [...AGENT_ACTIONS, ...formatActions(registry)] })
 *
 * The same list goes to `createMcpDispatcher` and the CLI. It adds `list_formats` (what each exporter carries and what it loses, so a
 * caller knows before exporting) and `export_document` (the document, or one block with its descendants, in a registered format; text
 * formats come back as text, binary ones as base64 with their MIME type and extension, and the format's warnings are always included).
 * Both only read the document. The shared `AGENT_ACTIONS` is not changed, and the exporters are the ones you registered: nothing is
 * fetched from the network and nothing is registered for you. Register every exporter before calling this: the format ids are
 * listed in the schema when it is built. Import is not here (`import_markdown` already imports Markdown).
 */
export function formatActions(registry: FormatRegistry): readonly TransportAction[] {
  const ids = registry.exporters().map(entry => entry.id);
  if (ids.length === 0) throw new TypeError('formatActions needs at least one registered exporter: call registry.addExporter(...) first.');
  const listFormats: TransportAction = Object.freeze({
    name: 'list_formats', title: 'List export formats',
    description: 'List the formats the document can be exported in (export_document), with each format\'s MIME type, file extension, what it carries in full and, per document feature, what it cannot carry (dropped or degraded). Read-only. Call it before export_document to tell the user what a format will lose.',
    access: 'read' as const, destructive: false, idempotent: true, inputSchema: objectOf({}),
    run(service, input) {
      try { check(this.inputSchema, plainCopy(input ?? {}, 'input'), 'input'); } catch (error) { return invalid(service, error); }
      return { ok: true, revision: service.read().revision, formats: registry.exporters() };
    },
  });
  const exportDocument: TransportAction = Object.freeze({
    name: 'export_document', title: 'Export the document in a format',
    description: `Export the document (or one block with its descendants) in a registered format: ${ids.join(', ')}. Read-only. Returns { format, mime, ext, encoding, data, bytes, warnings }: encoding is "utf8" (data is the text) or "base64" (data is a binary file such as a Word document). warnings lists everything the format could not carry; read it before telling the user the export is complete. options are the format's own (unknown options are refused with the valid list). Call list_formats first to see each format's limits.`,
    access: 'read' as const, destructive: false, idempotent: true,
    inputSchema: objectOf({
      format: { type: 'string', enum: ids, description: 'A format id from list_formats.' },
      blockId: { ...idS, description: 'Export only this block and its descendants.' },
      options: { type: 'object', description: 'The format\'s own options, for example { "footer": "{page} / {pages}" } for docx. JSON values only.' },
    }, ['format']),
    async run(service, input) {
      let values: Record<string, unknown>;
      try { values = plainCopy(input ?? {}, 'input') as Record<string, unknown>; check(this.inputSchema, values, 'input'); } catch (error) { return invalid(service, error); }
      const document = service.read();
      let source = document;
      if (typeof values.blockId === 'string') {
        const root = document.blocks.find(block => block.id === values.blockId);
        if (!root) return failure(service, [{ code: 'not-found', message: `Block "${values.blockId}" does not exist.`, blockId: values.blockId, path: 'input.blockId', hint: 'Use get_outline or find_blocks to list current block IDs.' }]);
        const blocks = [{ ...root, parentId: null }, ...descendantsOf(document, root.id)];
        source = { ...document, blocks };
      }
      const exported = await registry.export(values.format as string, source, values.options);
      if (!exported.ok) return failure(service, exported.issues.map(issue => ({ ...issue, path: issue.path?.startsWith('options') ? `input.${issue.path}` : issue.path ?? 'input.format' })));
      const bytes = typeof exported.data === 'string' ? new TextEncoder().encode(exported.data).length : exported.data.length;
      if (bytes > FORMAT_EXPORT_BYTES) return failure(service, [{ code: 'validation', message: `The ${values.format as string} export is ${bytes} bytes; one call returns at most ${FORMAT_EXPORT_BYTES}.`, path: 'input.format', hint: 'Export one section with blockId, or export the whole document from the host with registry.export().' }]);
      return {
        ok: true, revision: document.revision, format: values.format, mime: exported.mime, ext: exported.ext,
        encoding: typeof exported.data === 'string' ? 'utf8' : 'base64', data: typeof exported.data === 'string' ? exported.data : toBase64(exported.data), bytes, warnings: exported.warnings,
      };
    },
  });
  return Object.freeze([listFormats, exportDocument]);
}
