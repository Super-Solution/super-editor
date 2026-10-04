import { AGENT_ACTIONS, emptyInputSchema, historyInputSchema, transactionInputSchema, type AgentAction } from '@super-solution/editor-core';

export type McpToolAnnotations = {
  title: string;
  /** True when the tool never changes the document. */
  readOnlyHint: boolean;
  /** True when the tool may delete or overwrite existing content (only meaningful when readOnlyHint is false). */
  destructiveHint: boolean;
  /** True when calling the tool again with the same arguments changes nothing more. */
  idempotentHint: boolean;
  /** Always false: the tools only touch the one open document. */
  openWorldHint: false;
};
export type McpTool = { name: string; title: string; description: string; inputSchema: Record<string, unknown>; annotations: McpToolAnnotations };

function tool(name: string, title: string, description: string, inputSchema: Record<string, unknown>, flags: { readOnly: boolean; destructive: boolean; idempotent: boolean }): McpTool {
  return { name, title, description, inputSchema, annotations: { title, readOnlyHint: flags.readOnly, destructiveHint: flags.destructive, idempotentHint: flags.idempotent, openWorldHint: false } };
}

/** The original four tools. They take and return raw Core objects and stay available for full control. */
const coreTools: McpTool[] = [
  tool('read_document', 'Read the whole document', 'Read the entire versioned document: every block with its version, the citations and the revision. Large documents are expensive: prefer get_outline, find_blocks and get_block, and re-read before proposing guarded edits. Read-only.', emptyInputSchema, { readOnly: true, destructive: false, idempotent: true }),
  tool('apply_transaction', 'Apply a Core transaction', 'Apply an atomic Core transaction with full control: every operation type, one revision, all or nothing. Use stable IDs, baseRevision and expectedVersion for updates. Rejected edits change nothing and say why in issues[].hint. Prefer the narrower tools (insert_blocks, update_block_text, replace_text, move_blocks, delete_blocks, add_chart, add_citation) when they fit.', transactionInputSchema, { readOnly: false, destructive: true, idempotent: false }),
  tool('undo', 'Undo the last edit', 'Undo the latest edit made in this editing session. Needs the current expectedRevision. History is not saved with the file, so a restarted server has nothing to undo.', historyInputSchema, { readOnly: false, destructive: true, idempotent: false }),
  tool('redo', 'Redo the last undone edit', 'Redo the last undone edit in this editing session. Needs the current expectedRevision.', historyInputSchema, { readOnly: false, destructive: true, idempotent: false }),
];

export function toolFor(action: AgentAction): McpTool {
  return tool(action.name, action.title, action.description, action.inputSchema, { readOnly: action.access === 'read', destructive: action.destructive, idempotent: action.idempotent });
}

const readOnlyCore = new Set(['read_document']);
/** Tool descriptors in a stable order: the Core tools, then the semantic tools reads first. */
export function listTools(options: { readOnly?: boolean } = {}): McpTool[] {
  const all = [...coreTools, ...AGENT_ACTIONS.map(toolFor)];
  return options.readOnly ? all.filter(entry => entry.annotations.readOnlyHint) : all;
}
export function isCoreTool(name: string): boolean { return coreTools.some(entry => entry.name === name); }
export function isReadOnlyTool(name: string): boolean {
  if (readOnlyCore.has(name)) return true;
  const action = AGENT_ACTIONS.find(entry => entry.name === name);
  return action?.access === 'read';
}
