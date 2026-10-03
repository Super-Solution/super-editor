import type { Actor } from '@super-solution/editor-core';
import { emptyInputSchema, historyInputSchema, transactionInputSchema } from '@super-solution/editor-core';
import { validationFailure, type ReportService } from '@super-solution/editor-core';

type RpcId = string | number | null;
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: RpcId; result: unknown }
  | { jsonrpc: '2.0'; id: RpcId; error: { code: number; message: string } };
export type McpToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};

const tools = [
  { name: 'read_document', description: 'Read the current versioned research document. Re-read before proposing guarded edits.', inputSchema: emptyInputSchema },
  { name: 'apply_transaction', description: 'Apply an atomic Core transaction. Use stable IDs, baseRevision, and expectedVersion for updates. Rejected edits change nothing.', inputSchema: transactionInputSchema },
  { name: 'undo', description: 'Undo the latest edit in this editor session. Requires current expectedRevision. JSON files do not persist this session history.', inputSchema: historyInputSchema },
  { name: 'redo', description: 'Redo the last undone edit in this editor session. Requires current expectedRevision.', inputSchema: historyInputSchema },
];

function error(id: RpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(value: Record<string, unknown>, failed = false): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, ...(failed ? { isError: true } : {}) };
}

/** Inspect own data descriptors, then use a copy so Proxy get traps never run. */
function ownRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      if (typeof key !== 'string') return null;
      const descriptor = descriptors[key]!;
      if (!Object.hasOwn(descriptor, 'value')) return null;
      result[key] = descriptor.value;
    }
    return result;
  } catch {
    // Revoked Proxies and throwing descriptor/prototype traps are invalid data.
    return null;
  }
}

/**
 * JSON-RPC tools adapter only. A host must implement MCP initialization,
 * authenticated sessions, wire transport, and its own authorization policy.
 * Supports individual requests/notifications, not JSON-RPC batch arrays.
 */
export function createMcpDispatcher(service: ReportService) {
  return async (input: unknown): Promise<JsonRpcResponse | undefined> => {
    let request: unknown = input;
    if (typeof request === 'string') {
      try { request = JSON.parse(request) as unknown; }
      catch { return error(null, -32700, 'Parse error.'); }
    }
    const envelope = ownRecord(request);
    if (envelope === null || envelope.jsonrpc !== '2.0' || typeof envelope.method !== 'string'
      || (Object.hasOwn(envelope, 'id') && envelope.id !== null && typeof envelope.id !== 'string'
        && (typeof envelope.id !== 'number' || !Number.isFinite(envelope.id)))) {
      return error(null, -32600, 'Invalid Request.');
    }
    const params = ownRecord(Object.hasOwn(envelope, 'params') ? envelope.params : {});
    if (params === null) return error(null, -32600, 'Invalid Request.');
    const notification = !Object.hasOwn(envelope, 'id');
    const id = notification ? null : envelope.id as RpcId;
    const respond = (response: JsonRpcResponse): JsonRpcResponse | undefined => notification ? undefined : response;

    try {
      if (envelope.method === 'tools/list') {
        if (Object.keys(params).length !== 0) return respond(error(id, -32602, 'tools/list takes no parameters.'));
        // Return copies so a host/caller cannot alter future tool discovery.
        return respond({ jsonrpc: '2.0', id, result: { tools: JSON.parse(JSON.stringify(tools)) as unknown } });
      }
      if (envelope.method !== 'tools/call') return respond(error(id, -32601, 'Method not found.'));
      if (typeof params.name !== 'string' || Object.keys(params).some((key) => key !== 'name' && key !== 'arguments')) {
        return respond(error(id, -32602, 'tools/call requires name and optional arguments.'));
      }
      const args = ownRecord(Object.hasOwn(params, 'arguments') ? params.arguments : {});
      if (args === null) return respond(error(id, -32602, 'Tool arguments must be an object with own data properties.'));
      let result: McpToolResult;
      if (params.name === 'read_document') {
        if (Object.keys(args).length !== 0) return respond(error(id, -32602, 'read_document takes no arguments.'));
        result = toolResult(service.read() as unknown as Record<string, unknown>);
      } else if (params.name === 'apply_transaction') {
        if (Object.keys(args).some((key) => key !== 'transaction')) {
          return respond(error(id, -32602, 'apply_transaction requires only transaction.'));
        }
        const applied = service.apply(args.transaction);
        result = toolResult(applied as unknown as Record<string, unknown>, !applied.ok);
      } else if (params.name === 'undo' || params.name === 'redo') {
        const invalidKeys = Object.keys(args).some((key) => key !== 'actor' && key !== 'expectedRevision');
        const applied = invalidKeys ? validationFailure(service, 'History request requires only actor and expectedRevision.')
          : params.name === 'undo'
            ? service.undo(args.actor as Actor, args.expectedRevision as number)
            : service.redo(args.actor as Actor, args.expectedRevision as number);
        result = toolResult(applied as unknown as Record<string, unknown>, !applied.ok);
      } else return respond(error(id, -32602, 'Unknown tool.'));
      return respond({ jsonrpc: '2.0', id, result });
    } catch {
      return respond(error(id, -32603, 'Internal error.'));
    }
  };
}
