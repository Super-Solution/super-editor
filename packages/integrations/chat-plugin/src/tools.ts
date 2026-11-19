// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import {
  AGENT_ACTIONS,
  historyInputSchema,
  runAgentActionAsync,
  transactionInputSchema,
  type Actor,
  type AgentAction,
  type AsyncReportService,
  type ReportService,
} from '@supersolutions/super-editor-core';
import type { PluginTool, PluginToolAuthority, PluginToolRunContext } from '@supersolutions/super-protocol';

export type AuthorizedPluginTool = PluginTool & { authority: PluginToolAuthority };

export type EditorToolTarget = { service: ReportService | AsyncReportService; writable: boolean };
export type EditorToolHost = {
  /** The document a tool addresses; without an id, the most recent one on screen. */
  resolve(documentId: string | undefined): Promise<EditorToolTarget | undefined>;
  /** Documents on screen, newest last. */
  list(): Promise<{ documentId: string; title: string; revision: number; writable: boolean }[]>;
  actor: Actor;
};

type Schema = Record<string, unknown>;
const documentId: Schema = { type: 'string', description: 'Which document; omit for the most recent one on screen.' };
const withDocumentId = (schema: Schema): Schema => ({ ...schema, properties: { ...(schema.properties as Schema | undefined), documentId } });
const refuse = (message: string, hint: string, currentRevision = 0, extra: Schema = {}) => ({ ok: false, issues: [{ code: 'validation', message, hint }], currentRevision, ...extra });

/** Reads are `read`; additions the user can review in the card are `draft`; anything that overwrites or removes is `act` and asks first. */
function authorityOf(action: Pick<AgentAction, 'access' | 'destructive'>): { authority: PluginToolAuthority; confirm?: true } {
  if (action.access === 'read') return { authority: 'read' };
  return action.destructive ? { authority: 'act', confirm: true } : { authority: 'draft' };
}

export function createEditorTools(host: EditorToolHost): AuthorizedPluginTool[] {
  const tool = (
    name: string,
    description: string,
    inputSchema: Schema,
    access: { authority: PluginToolAuthority; confirm?: true },
    run: (service: ReportService | AsyncReportService, input: Record<string, unknown>) => unknown,
  ): AuthorizedPluginTool => ({
    name: `editor_${name}`,
    description,
    inputSchema: withDocumentId(inputSchema),
    ...access,
    run: async (raw: unknown, context: PluginToolRunContext) => {
      context.signal?.throwIfAborted();
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return refuse('Tool input must be an object.', 'Send the arguments as a JSON object.');
      const { documentId: id, ...input } = raw as Record<string, unknown>;
      if (id !== undefined && typeof id !== 'string') return refuse('documentId must be a string.', 'Call editor_list_documents to see the ids.');
      const target = await host.resolve(id);
      if (!target) return refuse(id === undefined ? 'No document is on screen.' : `Unknown document "${id}".`, 'Show a super-editor.document card first, or call editor_list_documents.');
      const revision = (await target.service.read()).revision;
      if (access.authority !== 'read' && !target.writable) return refuse('This document is open read-only.', 'Show it with mode "edit" to change it.', revision);
      // The host asks the user; a host that does not must not get a destructive change through.
      if (access.confirm && context.confirmed !== true) return refuse('This change needs the user\'s confirmation.', 'The host must ask the user before running this tool.', revision, { confirmationRequired: true });
      return run(target.service, input);
    },
  });

  return [
    {
      name: 'editor_list_documents',
      description: 'List the documents on screen with their id, title, revision and whether they can be edited. Read-only.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      authority: 'read',
      run: async () => ({ ok: true, documents: await host.list() }),
    },
    tool('read_document', 'Read the entire versioned document: every block with its version, the citations and the revision. Large documents are expensive: prefer editor_get_outline, editor_find_blocks and editor_get_block. Read-only.', { type: 'object', properties: {}, additionalProperties: false }, { authority: 'read' }, (service) => service.read()),
    ...AGENT_ACTIONS.map((action) => tool(action.name, action.description, action.inputSchema as Schema, authorityOf(action), (service, input) => runAgentActionAsync(service, action.name, input, { actor: host.actor }))),
    tool('apply_transaction', 'Apply an atomic Core transaction: every operation type, one revision, all or nothing. Use baseRevision and expectedVersion; a stale edit is refused and changes nothing. Prefer the narrower tools when they fit.', transactionInputSchema as Schema, { authority: 'act', confirm: true }, (service, input) => {
      const transaction = input.transaction;
      if (typeof transaction !== 'object' || transaction === null) return refuse('transaction must be an object.', 'Send { "transaction": { ... } }.');
      // Provenance is the host's to state: the model cannot sign its edit as somebody else.
      return service.apply({ ...transaction, actor: host.actor });
    }),
    ...(['undo', 'redo'] as const).map((name) => tool(name, `${name === 'undo' ? 'Undo the latest edit' : 'Redo the last undone edit'} made in this card. Needs the current expectedRevision.`, { ...historyInputSchema, properties: { expectedRevision: (historyInputSchema.properties as Schema).expectedRevision }, required: ['expectedRevision'] } as Schema, { authority: 'act', confirm: true }, (service, input) => {
      const expected = input.expectedRevision;
      if (!Number.isSafeInteger(expected)) return refuse('expectedRevision must be an integer.', 'Read the current revision first.');
      return service[name](host.actor, expected as number);
    })),
  ];
}
