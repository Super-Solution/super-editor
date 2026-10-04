import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import type { Actor, AgentActionResult, ReportService, ResearchDocument } from '@super-solution/editor-core';
import { AGENT_ACTIONS, TEMPLATE_KINDS, TRANSPORT_LIMITS, createDocument, createEditor, createReportService, createTemplate, getBlock, getAgentAction, isTemplateKind, listTemplates, runAgentAction, serializeDocument, templateTitle, withHints } from '@super-solution/editor-core';
import { formatFind, formatGet, formatOutline, formatRevisions, formatStats, formatTemplates, formatTools, formatValidate, formatWrite } from './format.js';
import { InputError, appendHistory, historyExists, historyPath, loadDocument, persistAtomic, readHistory, readTextFile, withFileLock } from './files.js';

export type CliIo = { stdout(text: string): void; stderr(text: string): void; /** Reads all of standard input; used for `-` arguments. */ stdin?: () => Promise<string> };
type OptionDef = { type: 'string' | 'boolean'; multiple?: boolean; short?: string };
type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;
export type Outcome = { value: Record<string, unknown>; human: string; /** Printed as is instead of the JSON/human text unless `--json`. */ raw?: string };
export type CommandContext = { file: string; rest: string[]; v: Values; io: CliIo; json: boolean; actor: Actor };
export type Command = {
  name: string; usage: string; summary: string;
  /** The first argument is a document file. */
  file: boolean;
  /** Print `Outcome.raw` even with --json (the original commands always answer with JSON). */
  alwaysRaw?: true;
  options: Record<string, OptionDef>;
  /** Description of each option, for `help <command>`. */
  notes?: string[];
  run(context: CommandContext): Promise<Outcome>;
};

// ------------------------------------------------------------------------------------------------ small helpers
const str = (c: CommandContext, key: string): string | undefined => typeof c.v[key] === 'string' ? c.v[key] as string : undefined;
const many = (c: CommandContext, key: string): string[] => (Array.isArray(c.v[key]) ? c.v[key] as string[] : typeof c.v[key] === 'string' ? [c.v[key] as string] : []);
const flag = (c: CommandContext, key: string): boolean => c.v[key] === true;
function int(c: CommandContext, key: string): number | undefined {
  const value = str(c, key);
  if (value === undefined) return undefined;
  if (!/^\d{1,15}$/.test(value)) throw new InputError(`--${key} must be a non-negative integer.`);
  return Number(value);
}
function parseActor(value: string): Actor {
  const [id, kind = 'agent', ...rest] = value.split(':');
  if (rest.length || !id || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !['agent', 'human', 'system'].includes(kind)) throw new InputError('--actor must look like <id> or <id>:<agent|human|system>, for example research-bot:agent.');
  return { id, kind: kind as Actor['kind'] };
}
export const defaultActor = (value: string | undefined): Actor => value === undefined ? { id: 'cli', kind: 'system' } : parseActor(value);

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    bytes += buffer.length;
    if (bytes > TRANSPORT_LIMITS.fileBytes) throw new InputError(`Standard input is larger than the ${TRANSPORT_LIMITS.fileBytes} byte limit.`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
}
/** Text from a file path, or from standard input for `-`. */
async function readSource(c: CommandContext, source: string, label: string): Promise<string> {
  return source === '-' ? await (c.io.stdin ?? readStdin)() : readTextFile(resolve(source), label);
}
async function readJsonSource(c: CommandContext, source: string, label: string): Promise<unknown> {
  const text = await readSource(c, source, label);
  try { return JSON.parse(text) as unknown; }
  catch { throw new InputError(`${label} must contain valid JSON.`); }
}

const ids = (c: CommandContext): string[] => c.rest;
/** `blockId@version`, the guard a stale read cannot satisfy. `--unguarded` takes the current version instead. */
async function blockRef(c: CommandContext, token: string): Promise<{ blockId: string; expectedVersion: number }> {
  const guarded = /^([^@\s]+)@(\d+)$/.exec(token);
  if (guarded) return { blockId: guarded[1]!, expectedVersion: Number(guarded[2]) };
  if (!/^[^@\s]+$/.test(token)) throw new InputError(`"${token}" is not a block reference. Use <blockId>@<version>.`);
  if (!flag(c, 'unguarded')) throw new InputError(`"${token}" needs the version you last read: write ${token}@<version> (see the find and get commands), or pass --unguarded to use the current version without a stale-read guard.`);
  const block = getBlock(await loadDocument(c.file), token);
  if (!block) throw new InputError(`Block "${token}" does not exist. Use the find command to list block IDs.`);
  return { blockId: block.id, expectedVersion: block.version };
}
function placement(c: CommandContext): { afterId?: string | null } {
  const after = str(c, 'after');
  if (after !== undefined && flag(c, 'first')) throw new InputError('Use either --after or --first, not both.');
  return flag(c, 'first') ? { afterId: null } : after !== undefined ? { afterId: after } : {};
}
const parentOption = (c: CommandContext, key = 'parent'): { parentId?: string | null } => { const parent = str(c, key); return parent === undefined ? {} : { parentId: parent === 'root' ? null : parent }; };
function controls(c: CommandContext): Record<string, unknown> {
  const revision = int(c, 'expect-revision');
  return { ...(revision === undefined ? {} : { expectedRevision: revision }), ...(flag(c, 'dry-run') ? { dryRun: true } : {}) };
}

/** Runs an action against the document file. Writes take the file lock and save atomically only when the revision moved. */
async function runOnFile(c: CommandContext, action: string, input: Record<string, unknown>, writes: boolean): Promise<AgentActionResult> {
  const execute = async (): Promise<AgentActionResult> => {
    const editor = createEditor(await loadDocument(c.file));
    const service = createReportService(editor);
    const before = service.read().revision;
    const result = runAgentAction(service, action, input, { actor: c.actor });
    if (result.ok && service.read().revision !== before) {
      await persistAtomic(c.file, serializeDocument(service.read()));
      await appendHistory(c.file, service.revisions?.() ?? []);
    }
    return result;
  };
  return writes && input.dryRun !== true ? withFileLock(c.file, execute) : execute();
}
async function viaAction(c: CommandContext, action: string, input: Record<string, unknown>, format: (value: Record<string, unknown>) => string, writes = true): Promise<Outcome> {
  const result = await runOnFile(c, action, input, writes);
  return { value: result as unknown as Record<string, unknown>, human: result.ok ? format(result) : '' };
}

// ------------------------------------------------------------------------------------------------ option groups
const JSON_FLAG: Record<string, OptionDef> = { json: { type: 'boolean' } };
const GUARD: Record<string, OptionDef> = { actor: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'expect-revision': { type: 'string' }, json: { type: 'boolean' } };
const POSITION: Record<string, OptionDef> = { after: { type: 'string' }, first: { type: 'boolean' }, parent: { type: 'string' } };
const GUARD_NOTES = ['--actor <id[:kind]>  author recorded on the edit (default cli:system)', '--dry-run  validate and preview, save nothing', '--expect-revision <n>  fail with a conflict unless the document is at revision n', '--json  print the machine-readable result'];

// ------------------------------------------------------------------------------------------------ commands
export const COMMANDS: readonly Command[] = [
  {
    name: 'init', usage: 'init <document.json> --id <id> [--title <title>] [--history]', summary: 'Create an empty document (refuses to overwrite)', file: true, alwaysRaw: true,
    options: { id: { type: 'string' }, title: { type: 'string' }, history: { type: 'boolean' } },
    notes: ['--history  also create <document>.history.jsonl; every later CLI edit appends a line to it'],
    run: async c => {
      if (c.rest.length) throw new InputError('init takes only the document path and its options.');
      const id = str(c, 'id');
      if (id === undefined) throw new InputError('init requires --id <id>.');
      let serialized: string;
      try { serialized = serializeDocument(createDocument({ id, title: str(c, 'title') ?? 'Untitled research report' })); }
      catch { throw new InputError('Invalid document ID or title.'); }
      await persistAtomic(c.file, serialized, true);
      if (flag(c, 'history')) await persistHistory(c.file);
      return { value: JSON.parse(serialized) as Record<string, unknown>, human: '', raw: `${serialized}\n` };
    },
  },
  {
    name: 'new', usage: 'new <document.json> --id <id> [--title <title>] [--template <kind>] [--subject <text>] [--history]', summary: 'Create a document, optionally from a report template (refuses to overwrite)', file: true,
    options: { id: { type: 'string' }, title: { type: 'string' }, template: { type: 'string' }, subject: { type: 'string' }, history: { type: 'boolean' }, json: { type: 'boolean' } },
    notes: [`--template <kind>  one of ${TEMPLATE_KINDS.join(', ')}`, '--subject <text>  what the report is about (a ticker, theme, strategy)'],
    run: async c => {
      if (c.rest.length) throw new InputError('new takes only the document path and its options.');
      const id = str(c, 'id');
      if (id === undefined) throw new InputError('new requires --id <id>.');
      const template = str(c, 'template');
      if (template !== undefined && !isTemplateKind(template)) throw new InputError(`--template must be one of: ${TEMPLATE_KINDS.join(', ')}.`);
      const subject = str(c, 'subject');
      let document: ResearchDocument;
      try {
        document = createDocument({ id, title: str(c, 'title') ?? (template ? templateTitle(template, subject) : 'Untitled research report') });
        if (template) {
          const applied = createEditor(document).apply({ id: 'new-from-template', actor: { id: 'cli', kind: 'system' }, baseRevision: 0, operations: [{ type: 'insertBlocks', blocks: createTemplate(template, subject === undefined ? {} : { subject }) }] });
          if (!applied.ok) throw new InputError(`The template could not be applied: ${applied.issues[0]?.message ?? 'unknown error'}`);
          document = applied.document;
        }
      } catch (error) { throw error instanceof InputError ? error : new InputError(error instanceof Error ? error.message : 'Invalid document ID, title or subject.'); }
      await persistAtomic(c.file, serializeDocument(document), true);
      if (flag(c, 'history')) await persistHistory(c.file);
      return { value: { ok: true, file: c.file, id: document.id, title: document.title, revision: document.revision, blocks: document.blocks.length, template: template ?? null },
        human: `Created ${c.file}: "${document.title}" (${document.blocks.length} blocks${template ? `, ${template} template` : ''}).\n` };
    },
  },
  {
    name: 'templates', usage: 'templates [--json]', summary: 'List the report templates', file: false, options: JSON_FLAG,
    run: async () => { const value = { ok: true, templates: listTemplates() }; return { value, human: formatTemplates(value) }; },
  },
  {
    name: 'tools', usage: 'tools [<name>] [--json]', summary: 'List the actions the other commands wrap, or print one action\'s JSON Schema', file: false, options: JSON_FLAG,
    notes: ['Every action is also an MCP tool and an HTTP route of the same name. `call` runs any of them with a JSON input.'],
    run: async c => {
      const name = c.rest[0];
      if (name !== undefined) {
        const action = getAgentAction(name);
        if (!action) throw new InputError(`Unknown action "${name}". Run tools to list them.`);
        const value = { ok: true, name: action.name, title: action.title, description: action.description, access: action.access, destructive: action.destructive, idempotent: action.idempotent, inputSchema: action.inputSchema };
        return { value, human: `${JSON.stringify(value, null, 2)}\n` };
      }
      const value = { ok: true, actions: AGENT_ACTIONS.map(action => ({ name: action.name, title: action.title, description: action.description, access: action.access, destructive: action.destructive, idempotent: action.idempotent, inputSchema: action.inputSchema })) };
      return { value, human: formatTools(value) };
    },
  },
  {
    name: 'read', usage: 'read <document.json>', summary: 'Print the whole document as JSON (validated)', file: true, alwaysRaw: true, options: JSON_FLAG,
    run: async c => {
      if (c.rest.length) throw new InputError('read takes one document path.');
      const document = await loadDocument(c.file);
      return { value: document as unknown as Record<string, unknown>, human: '', raw: `${serializeDocument(document)}\n` };
    },
  },
  {
    name: 'apply', usage: 'apply <document.json> <transaction.json|->', summary: 'Apply a Core transaction atomically (exit 3 on a revision conflict)', file: true, alwaysRaw: true, options: JSON_FLAG,
    notes: ['The transaction file holds { id, actor, baseRevision, operations[] }. Use - to read it from standard input.'],
    run: async c => {
      const source = c.rest[0];
      if (c.rest.length !== 1 || !source) throw new InputError('apply requires document and transaction file paths.');
      // The exclusive lock covers this CLI's read/validate/write sequence. Other writers must use the same lock protocol.
      const result = await withFileLock(c.file, async () => {
        const editor = createEditor(await loadDocument(c.file));
        let transaction: unknown;
        const text = await readSource(c, source, 'Transaction file');
        try { transaction = JSON.parse(text) as unknown; }
        catch { throw new InputError('Transaction file must contain valid JSON.'); }
        const applied = createReportService(editor).apply(transaction);
        if (applied.ok) { await persistAtomic(c.file, serializeDocument(applied.document)); await appendHistory(c.file, editor.getRevisions()); }
        return applied;
      });
      const value = (result.ok ? result : { ...result, issues: withHints(result.issues) }) as unknown as Record<string, unknown>;
      return { value, human: '', raw: `${JSON.stringify(value)}\n` };
    },
  },
  {
    name: 'validate', usage: 'validate <document.json> [--transaction <file|->] [--json]', summary: 'Check a document (and optionally a transaction against it) without changing anything', file: true,
    options: { transaction: { type: 'string' }, json: { type: 'boolean' } },
    run: async c => {
      const document = await loadDocument(c.file);
      const base = { ok: true, valid: true, revision: document.revision, blocks: document.blocks.length, citations: document.citations.length };
      const source = str(c, 'transaction');
      if (source === undefined) return { value: base, human: formatValidate(base) };
      const transaction = await readJsonSource(c, source, 'Transaction file');
      const result = runAgentAction(createReportService(createEditor(document)), 'validate_transaction', { transaction }, { actor: c.actor });
      if (!result.ok) return { value: result as unknown as Record<string, unknown>, human: '' };
      const value = { ...base, transaction: true, revisionAfter: result.revisionAfter, added: result.added, removed: result.removed, changed: result.changed, moved: result.moved, summary: `${(result.added as string[]).length} added, ${(result.changed as string[]).length} changed, ${(result.removed as string[]).length} removed` };
      return { value, human: formatValidate(value) };
    },
  },
  {
    name: 'outline', usage: 'outline <document.json> [--max-depth <n>] [--json]', summary: 'Show sections and headings as a tree', file: true, options: { 'max-depth': { type: 'string' }, json: { type: 'boolean' } },
    run: c => viaAction(c, 'get_outline', int(c, 'max-depth') === undefined ? {} : { maxDepth: int(c, 'max-depth') }, formatOutline, false),
  },
  {
    name: 'find', usage: 'find <document.json> [--type <t>]... [--text <q>] [--parent <id|null>] [--within <id>] [--ids <a,b>] [--cite <id>] [--limit <n>] [--offset <n>] [--full] [--json]', summary: 'List blocks (id, type, version, text preview) matching filters', file: true,
    options: { type: { type: 'string', multiple: true }, text: { type: 'string' }, parent: { type: 'string' }, within: { type: 'string' }, ids: { type: 'string' }, cite: { type: 'string' }, limit: { type: 'string' }, offset: { type: 'string' }, full: { type: 'boolean' }, json: { type: 'boolean' } },
    notes: ['--full  return whole blocks instead of summaries', 'The version shown is what update-text, move, delete and the other guarded commands need (<id>@<version>).'],
    run: c => {
      const types = many(c, 'type').flatMap(entry => entry.split(',')).filter(Boolean);
      const parent = str(c, 'parent');
      const idList = str(c, 'ids');
      return viaAction(c, 'find_blocks', {
        ...(types.length ? { type: types.length === 1 ? types[0] : types } : {}), ...(str(c, 'text') === undefined ? {} : { text: str(c, 'text') }),
        ...(parent === undefined ? {} : { parentId: parent === 'null' || parent === 'root' ? null : parent }), ...(str(c, 'within') === undefined ? {} : { within: str(c, 'within') }),
        ...(idList === undefined ? {} : { ids: idList.split(',').map(entry => entry.trim()).filter(Boolean) }), ...(str(c, 'cite') === undefined ? {} : { citationId: str(c, 'cite') }),
        ...(int(c, 'limit') === undefined ? {} : { limit: int(c, 'limit') }), ...(int(c, 'offset') === undefined ? {} : { offset: int(c, 'offset') }), ...(flag(c, 'full') ? { include: 'content' } : {}),
      }, formatFind, false);
    },
  },
  {
    name: 'get', usage: 'get <document.json> <blockId> [--json]', summary: 'Show one block in full with its version, path and children', file: true, options: JSON_FLAG,
    run: c => {
      if (c.rest.length !== 1) throw new InputError('get takes a document path and one block ID.');
      return viaAction(c, 'get_block', { blockId: c.rest[0] }, formatGet, false);
    },
  },
  {
    name: 'insert', usage: 'insert <document.json> (--markdown <file|-> | --blocks <file|->) [--after <id> | --first] [--parent <id|root>] [--id-prefix <p>]', summary: 'Insert blocks from markdown or from a JSON array of blocks', file: true,
    options: { markdown: { type: 'string' }, blocks: { type: 'string' }, 'id-prefix': { type: 'string' }, ...POSITION, ...GUARD },
    notes: [...GUARD_NOTES, '--markdown -  read markdown from standard input', 'Default position: the end of the parent (the document root unless --parent is given).'],
    run: async c => {
      if (c.rest.length) throw new InputError('insert takes only the document path and its options.');
      const markdown = str(c, 'markdown'), blocks = str(c, 'blocks');
      if ((markdown === undefined) === (blocks === undefined)) throw new InputError('Provide exactly one of --markdown or --blocks.');
      const content = markdown !== undefined ? { markdown: await readSource(c, markdown, 'Markdown file') } : { blocks: await readJsonSource(c, blocks!, 'Blocks file') };
      return viaAction(c, 'insert_blocks', { ...content, ...placement(c), ...(markdown !== undefined ? parentOption(c) : {}), ...(str(c, 'id-prefix') === undefined ? {} : { idPrefix: str(c, 'id-prefix') }), ...controls(c) }, formatWrite);
    },
  },
  {
    name: 'update-text', usage: 'update-text <document.json> <blockId>@<version> (--text <text> | --text-file <file|->) [--plain] [--rebase]', summary: 'Replace all the text of one block', file: true,
    options: { text: { type: 'string' }, 'text-file': { type: 'string' }, plain: { type: 'boolean' }, rebase: { type: 'boolean' }, unguarded: { type: 'boolean' }, ...GUARD },
    notes: [...GUARD_NOTES, '--plain  keep the text literally instead of parsing **bold**, _italic_, `code` and [links](https://...)', '--rebase  apply even if other blocks changed since --expect-revision (this block must be unchanged)', '--unguarded  accept a bare <blockId> and use its current version (no stale-read protection)', 'Text that starts with "-" must be written --text=<text> or come from --text-file.'],
    run: async c => {
      if (c.rest.length !== 1) throw new InputError('update-text takes a document path and one <blockId>@<version>.');
      const inline = str(c, 'text'), file = str(c, 'text-file');
      if ((inline === undefined) === (file === undefined)) throw new InputError('Provide exactly one of --text or --text-file.');
      const ref = await blockRef(c, c.rest[0]!);
      return viaAction(c, 'update_block_text', { ...ref, text: inline ?? await readSource(c, file!, 'Text file'), ...(flag(c, 'plain') ? { format: 'plain' } : {}), ...(flag(c, 'rebase') ? { conflictPolicy: 'rebase-safe' } : {}), ...controls(c) }, formatWrite);
    },
  },
  {
    name: 'update', usage: 'update <document.json> <blockId>@<version> --content <file|-> [--citations <a,b>]', summary: 'Replace the whole content of one block with JSON (tables, charts, callouts...)', file: true,
    options: { content: { type: 'string' }, citations: { type: 'string' }, rebase: { type: 'boolean' }, unguarded: { type: 'boolean' }, ...GUARD },
    notes: GUARD_NOTES,
    run: async c => {
      if (c.rest.length !== 1) throw new InputError('update takes a document path and one <blockId>@<version>.');
      const source = str(c, 'content');
      if (source === undefined) throw new InputError('update requires --content <file|->.');
      const ref = await blockRef(c, c.rest[0]!);
      const citations = str(c, 'citations');
      return viaAction(c, 'update_block', { ...ref, content: await readJsonSource(c, source, 'Content file'), ...(citations === undefined ? {} : { citationIds: citations.split(',').map(entry => entry.trim()).filter(Boolean) }), ...(flag(c, 'rebase') ? { conflictPolicy: 'rebase-safe' } : {}), ...controls(c) }, formatWrite);
    },
  },
  {
    name: 'replace', usage: 'replace <document.json> --find <text> --replace <text> [--block <id>@<version>] [--within <id>] [--first] [--case-sensitive]', summary: 'Find and replace text, keeping formatting', file: true,
    options: { find: { type: 'string' }, replace: { type: 'string' }, block: { type: 'string' }, within: { type: 'string' }, first: { type: 'boolean' }, 'case-sensitive': { type: 'boolean' }, unguarded: { type: 'boolean' }, ...GUARD },
    notes: [...GUARD_NOTES, 'Without --block every block that contains the text is edited using current versions. Replaces all occurrences unless --first.'],
    run: async c => {
      if (c.rest.length) throw new InputError('replace takes only the document path and its options.');
      const find = str(c, 'find'), replace = str(c, 'replace');
      if (find === undefined || replace === undefined) throw new InputError('replace requires --find <text> and --replace <text> (the replacement may be empty).');
      const block = str(c, 'block');
      const ref = block === undefined ? undefined : await blockRef(c, block);
      return viaAction(c, 'replace_text', { find, replace, ...(ref ?? {}), ...(str(c, 'within') === undefined ? {} : { within: str(c, 'within') }), ...(flag(c, 'first') ? { all: false } : {}), ...(flag(c, 'case-sensitive') ? { caseSensitive: true } : {}), ...controls(c) }, formatWrite);
    },
  },
  {
    name: 'move', usage: 'move <document.json> <blockId>@<version>... --to <parentId|root> [--after <id> | --first]', summary: 'Move blocks (with their children) under a parent', file: true,
    options: { to: { type: 'string' }, after: { type: 'string' }, first: { type: 'boolean' }, unguarded: { type: 'boolean' }, ...GUARD },
    notes: GUARD_NOTES,
    run: async c => {
      const to = str(c, 'to');
      if (to === undefined) throw new InputError('move requires --to <parentId|root>.');
      if (!ids(c).length) throw new InputError('move needs at least one <blockId>@<version>.');
      const blocks = await Promise.all(ids(c).map(token => blockRef(c, token)));
      return viaAction(c, 'move_blocks', { blocks, parentId: to === 'root' ? null : to, ...placement(c), ...controls(c) }, formatWrite);
    },
  },
  {
    name: 'delete', usage: 'delete <document.json> <blockId>@<version>...', summary: 'Delete blocks (a section takes everything inside it)', file: true,
    options: { unguarded: { type: 'boolean' }, ...GUARD }, notes: GUARD_NOTES,
    run: async c => {
      if (!ids(c).length) throw new InputError('delete needs at least one <blockId>@<version>.');
      return viaAction(c, 'delete_blocks', { blocks: await Promise.all(ids(c).map(token => blockRef(c, token))), ...controls(c) }, formatWrite);
    },
  },
  {
    name: 'chart', usage: 'chart <document.json> --spec <file|-> [--after <id> | --first] [--parent <id|root>] [--id <blockId>] [--cite <a,b>]', summary: 'Add a chart from a JSON chart spec', file: true,
    options: { spec: { type: 'string' }, id: { type: 'string' }, cite: { type: 'string' }, ...POSITION, ...GUARD },
    notes: [...GUARD_NOTES, 'The spec is { kind, title, labels, series: [{ name, values }], source?, asOf?, ... }. Run `tools add_chart` for the full schema.'],
    run: async c => {
      const source = str(c, 'spec');
      if (source === undefined) throw new InputError('chart requires --spec <file|->.');
      const cite = str(c, 'cite');
      return viaAction(c, 'add_chart', { spec: await readJsonSource(c, source, 'Spec file'), ...placement(c), ...parentOption(c), ...(str(c, 'id') === undefined ? {} : { id: str(c, 'id') }), ...(cite === undefined ? {} : { citationIds: cite.split(',').map(entry => entry.trim()).filter(Boolean) }), ...controls(c) }, formatWrite);
    },
  },
  {
    name: 'cite', usage: 'cite <document.json> --title <title> --url <url> [--id <id>] [--accessed <iso>] [--published <iso>] [--block <blockId>@<version> [--marker]]', summary: 'Add a source; optionally cite it from a block', file: true,
    options: { title: { type: 'string' }, url: { type: 'string' }, id: { type: 'string' }, accessed: { type: 'string' }, published: { type: 'string' }, block: { type: 'string' }, marker: { type: 'boolean' }, unguarded: { type: 'boolean' }, ...GUARD },
    notes: [...GUARD_NOTES, '--marker  also append an inline citation marker to the block text'],
    run: async c => {
      const title = str(c, 'title'), url = str(c, 'url');
      if (title === undefined || url === undefined) throw new InputError('cite requires --title and --url.');
      const block = str(c, 'block');
      const ref = block === undefined ? undefined : await blockRef(c, block);
      return viaAction(c, 'add_citation', { title, url, ...(str(c, 'id') === undefined ? {} : { id: str(c, 'id') }), ...(str(c, 'accessed') === undefined ? {} : { accessedAt: str(c, 'accessed') }), ...(str(c, 'published') === undefined ? {} : { publishedAt: str(c, 'published') }), ...(ref ?? {}), ...(flag(c, 'marker') ? { marker: true } : {}), ...controls(c) }, formatWrite);
    },
  },
  {
    name: 'title', usage: 'title <document.json> <new title>', summary: 'Set the document title', file: true, options: GUARD, notes: GUARD_NOTES,
    run: c => {
      if (c.rest.length !== 1) throw new InputError('title takes the document path and the new title as one argument.');
      return viaAction(c, 'set_title', { title: c.rest[0], ...controls(c) }, formatWrite);
    },
  },
  {
    name: 'add-template', usage: 'add-template <document.json> <kind> [--subject <text>] [--id-prefix <p>] [--set-title] [--after <id> | --first] [--parent <id|root>]', summary: `Insert a report template (${TEMPLATE_KINDS.join(', ')})`, file: true,
    options: { subject: { type: 'string' }, 'id-prefix': { type: 'string' }, 'set-title': { type: 'boolean' }, ...POSITION, ...GUARD }, notes: GUARD_NOTES,
    run: c => {
      if (c.rest.length !== 1) throw new InputError('add-template takes the document path and one template kind.');
      return viaAction(c, 'insert_template', { kind: c.rest[0], ...(str(c, 'subject') === undefined ? {} : { subject: str(c, 'subject') }), ...(str(c, 'id-prefix') === undefined ? {} : { idPrefix: str(c, 'id-prefix') }), ...(flag(c, 'set-title') ? { setTitle: true } : {}), ...placement(c), ...parentOption(c), ...controls(c) }, formatWrite);
    },
  },
  {
    name: 'export', usage: 'export <document.json> [--format md|html|txt] [--block <id>] [--standalone] [--out <file>]', summary: 'Export the document (or one section) as Markdown, HTML or plain text', file: true,
    options: { format: { type: 'string' }, block: { type: 'string' }, standalone: { type: 'boolean' }, out: { type: 'string' }, json: { type: 'boolean' } },
    notes: ['The text goes to standard output unless --out is given. With --json the result object is printed instead.'],
    run: async c => {
      if (c.rest.length) throw new InputError('export takes only the document path and its options.');
      const format = str(c, 'format') ?? 'md';
      const action = ({ md: 'export_markdown', markdown: 'export_markdown', html: 'export_html', txt: 'export_text', text: 'export_text' } as Record<string, string>)[format];
      if (!action) throw new InputError('--format must be md, html or txt.');
      const result = await runOnFile(c, action, { ...(str(c, 'block') === undefined ? {} : { blockId: str(c, 'block') }), ...(flag(c, 'standalone') ? { standalone: true } : {}) }, false);
      if (!result.ok) return { value: result as unknown as Record<string, unknown>, human: '' };
      const out = str(c, 'out');
      if (out !== undefined) {
        if (resolve(out) === c.file) throw new InputError('--out must not be the document file.');
        await writeFile(resolve(out), result.text as string, 'utf8');
        const value = { ok: true, revision: result.revision, format: result.format, characters: result.characters, out: resolve(out) };
        return { value, human: `Wrote ${String(result.characters)} characters to ${out}.\n` };
      }
      return { value: result as unknown as Record<string, unknown>, human: '', raw: result.text as string };
    },
  },
  {
    name: 'import', usage: 'import <document.json> --markdown <file|-> [--mode append|replace] [--set-title] [--after <id> | --first] [--parent <id|root>]', summary: 'Import a markdown document (append, or replace the whole body)', file: true,
    options: { markdown: { type: 'string' }, mode: { type: 'string' }, 'set-title': { type: 'boolean' }, 'id-prefix': { type: 'string' }, ...POSITION, ...GUARD },
    notes: [...GUARD_NOTES, '--mode replace  delete every existing block first (undoable in a session, not from the CLI: keep a copy or use --dry-run)'],
    run: async c => {
      if (c.rest.length) throw new InputError('import takes only the document path and its options.');
      const source = str(c, 'markdown');
      if (source === undefined) throw new InputError('import requires --markdown <file|->.');
      const mode = str(c, 'mode');
      if (mode !== undefined && mode !== 'append' && mode !== 'replace') throw new InputError('--mode must be append or replace.');
      return viaAction(c, 'import_markdown', { markdown: await readSource(c, source, 'Markdown file'), ...(mode === undefined ? {} : { mode }), ...(flag(c, 'set-title') ? { setTitle: true } : {}), ...(str(c, 'id-prefix') === undefined ? {} : { idPrefix: str(c, 'id-prefix') }), ...placement(c), ...parentOption(c), ...controls(c) }, formatWrite);
    },
  },
  {
    name: 'stats', usage: 'stats <document.json> [--json]', summary: 'Words, reading time, block and chart counts', file: true, options: JSON_FLAG,
    run: c => viaAction(c, 'document_stats', {}, formatStats, false),
  },
  {
    name: 'revisions', usage: 'revisions <document.json> [--limit <n>] [--json]', summary: 'Show the edit history log, if the document has one', file: true, options: { limit: { type: 'string' }, json: { type: 'boolean' } },
    notes: ['A JSON file stores only its revision number. Create the log with `init --history` or `new --history` (or by creating <document>.history.jsonl); every later CLI or MCP-server edit then appends one line.'],
    run: async c => {
      const document = await loadDocument(c.file);
      const entries = (await readHistory(c.file)).reverse() as { number: number }[];
      const limit = int(c, 'limit') ?? TRANSPORT_LIMITS.revisionsDefault;
      const logged = await historyExists(c.file);
      const value = { ok: true, revision: document.revision, updatedAt: document.updatedAt, total: entries.length, revisions: entries.slice(0, limit), ...(logged ? {} : { note: `No history log. The document is at revision ${document.revision}. Create ${historyPath(c.file)} (init --history) to record edits.` }) };
      return { value, human: formatRevisions(value) };
    },
  },
  {
    name: 'call', usage: 'call <document.json> <action> [--input <json|file|->] [--actor <id[:kind]>]', summary: 'Run any action (see `tools`) with a JSON input; prints the JSON result', file: true, alwaysRaw: true,
    options: { input: { type: 'string' }, ...GUARD },
    run: async c => {
      const name = c.rest[0];
      if (c.rest.length !== 1 || !name) throw new InputError('call takes a document path and one action name.');
      const action = getAgentAction(name);
      if (!action) throw new InputError(`Unknown action "${name}". Run tools to list them.`);
      const given = str(c, 'input');
      const input = given === undefined ? {} : given.trimStart().startsWith('{') ? (() => { try { return JSON.parse(given) as unknown; } catch { throw new InputError('--input is not valid JSON.'); } })() : await readJsonSource(c, given, 'Input file');
      if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new InputError('The input must be a JSON object.');
      const merged = { ...(input as Record<string, unknown>), ...controls(c) };
      const result = await runOnFile(c, name, merged, action.access === 'write');
      return { value: result as unknown as Record<string, unknown>, human: '', raw: `${JSON.stringify(result)}\n` };
    },
  },
];

async function persistHistory(file: string): Promise<void> {
  const handle = await open(historyPath(file), 'a', 0o600);
  await handle.close();
}

export function parseCommand(command: Command, args: string[]): { values: Values; positionals: string[] } {
  try {
    const parsed = parseArgs({ args, options: { ...command.options, help: { type: 'boolean', short: 'h' } }, allowPositionals: true, strict: true });
    return { values: parsed.values as Values, positionals: parsed.positionals };
  } catch (error) {
    throw new InputError(`${error instanceof Error ? error.message.replace(/\. To specify a positional.*$/, '.') : 'Invalid arguments.'} Run: super-editor help ${command.name}`);
  }
}
