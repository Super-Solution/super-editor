import type { Actor, AgentActionResult, ReportService } from '@super-solution/editor-core';
import { getAgentAction, runAgentAction, validationFailure, withHints } from '@super-solution/editor-core';
import { SERVER_INSTRUCTIONS } from './guide.js';
import { PROMPTS, getPrompt } from './prompts.js';
import { RESOURCES, RESOURCE_TEMPLATES, readResource } from './resources.js';
import { isCoreTool, isReadOnlyTool, listTools } from './tools.js';

type RpcId = string | number | null;
export type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: RpcId; result: unknown }
  | { jsonrpc: '2.0'; id: RpcId; error: { code: number; message: string; data?: unknown } };
export type McpToolResult = {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError?: boolean;
};
export type McpDispatcherOptions = {
  /** Provenance recorded on edits made through the semantic tools. Default `{ id: 'mcp-agent', kind: 'agent' }`. */
  actor?: Actor;
  /** Hide and refuse every tool that can change the document. */
  readOnly?: boolean;
  /** Reported by `initialize`. */
  serverInfo?: { name: string; title?: string; version: string };
  /** Reported by `initialize`. Defaults to a short operating guide for models. */
  instructions?: string;
  /** Clock for timestamps the tools create (citation `accessedAt`). */
  now?: () => string;
};

/** Newest first. A client that asks for another version is told which one this server speaks. */
export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'] as const;
const DEFAULT_SERVER_INFO = { name: 'super-editor', title: 'Super Editor', version: '0.0.0' };

function error(id: RpcId, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function toolResult(value: Record<string, unknown>, failed = false, text?: string): McpToolResult {
  return { content: [{ type: 'text', text: text ?? JSON.stringify(value) }], structuredContent: value, ...(failed ? { isError: true } : {}) };
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

const withoutMeta = (record: Record<string, unknown>): string[] => Object.keys(record).filter(key => key !== '_meta');

/**
 * JSON-RPC MCP server core: `initialize`, `ping`, `tools/*`, `resources/*` and `prompts/*`. It has no transport and no
 * session state, so a host supplies the wire (see `runStdioServer` for stdio), authentication and persistence.
 * Supports individual requests/notifications, not JSON-RPC batch arrays (removed from MCP in 2025-06-18).
 */
export function createMcpDispatcher(service: ReportService, options: McpDispatcherOptions = {}) {
  const actor: Actor = options.actor ?? { id: 'mcp-agent', kind: 'agent' };
  const readOnly = options.readOnly === true;
  const serverInfo = options.serverInfo ?? DEFAULT_SERVER_INFO;
  const instructions = options.instructions ?? SERVER_INSTRUCTIONS;
  const context = { actor, ...(options.now ? { now: options.now } : {}) };

  function actionResult(name: string, args: Record<string, unknown>): McpToolResult {
    const result: AgentActionResult = runAgentAction(service, name, args, context);
    if (!result.ok) return toolResult(result as unknown as Record<string, unknown>, true);
    const textField = getAgentAction(name)?.textField;
    const raw = textField !== undefined && typeof result[textField] === 'string' ? result[textField] as string : undefined;
    return toolResult(result, false, raw);
  }

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
    const ok = (result: unknown): JsonRpcResponse | undefined => respond({ jsonrpc: '2.0', id, result });
    const invalid = (message: string): JsonRpcResponse | undefined => respond(error(id, -32602, message));
    const method = envelope.method;

    try {
      if (method.startsWith('notifications/')) return undefined;
      switch (method) {
        case 'initialize': {
          if (typeof params.protocolVersion !== 'string') return invalid('initialize requires protocolVersion.');
          const requested = params.protocolVersion;
          const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : MCP_PROTOCOL_VERSIONS[0];
          return ok({
            protocolVersion,
            capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false }, prompts: { listChanged: false } },
            serverInfo: { ...serverInfo }, instructions,
          });
        }
        case 'ping': return ok({});
        case 'tools/list': {
          if (withoutMeta(params).some(key => key !== 'cursor') || (Object.hasOwn(params, 'cursor') && typeof params.cursor !== 'string')) return invalid('tools/list takes only an optional cursor.');
          // One page only; a cursor can only point past the end. Copies keep a caller from altering future discovery.
          return ok({ tools: Object.hasOwn(params, 'cursor') ? [] : JSON.parse(JSON.stringify(listTools({ readOnly }))) as unknown });
        }
        case 'tools/call': {
          if (typeof params.name !== 'string' || withoutMeta(params).some(key => key !== 'name' && key !== 'arguments')) {
            return invalid('tools/call requires name and optional arguments.');
          }
          const args = ownRecord(Object.hasOwn(params, 'arguments') ? params.arguments : {});
          if (args === null) return invalid('Tool arguments must be an object with own data properties.');
          const name = params.name;
          let result: McpToolResult;
          if (!isCoreTool(name) && getAgentAction(name) === undefined) return invalid('Unknown tool.');
          if (readOnly && !isReadOnlyTool(name)) {
            const refused = { ok: false, issues: withHints([{ code: 'validation', message: `This server is read-only; "${name}" can change the document.`, hint: 'Use a read-only tool (get_outline, find_blocks, get_block, export_markdown, document_stats) or ask the operator for a writable server.' }]), currentRevision: service.read().revision };
            return ok(toolResult(refused, true));
          }
          if (name === 'read_document') {
            if (Object.keys(args).length !== 0) return invalid('read_document takes no arguments.');
            result = toolResult(service.read() as unknown as Record<string, unknown>);
          } else if (name === 'apply_transaction') {
            if (Object.keys(args).some(key => key !== 'transaction')) return invalid('apply_transaction requires only transaction.');
            const applied = service.apply(args.transaction);
            result = toolResult(withFailureHints(applied), !applied.ok);
          } else if (name === 'undo' || name === 'redo') {
            const invalidKeys = Object.keys(args).some(key => key !== 'actor' && key !== 'expectedRevision');
            const applied = invalidKeys ? validationFailure(service, 'History request requires only actor and expectedRevision.')
              : name === 'undo'
                ? service.undo(args.actor as Actor, args.expectedRevision as number)
                : service.redo(args.actor as Actor, args.expectedRevision as number);
            result = toolResult(withFailureHints(applied), !applied.ok);
          } else result = actionResult(name, args);
          return ok(result);
        }
        case 'resources/list': return ok({ resources: JSON.parse(JSON.stringify(RESOURCES)) as unknown });
        case 'resources/templates/list': return ok({ resourceTemplates: JSON.parse(JSON.stringify(RESOURCE_TEMPLATES)) as unknown });
        case 'resources/read': {
          if (typeof params.uri !== 'string' || withoutMeta(params).some(key => key !== 'uri')) return invalid('resources/read requires uri.');
          const contents = readResource(service, params.uri);
          if (!contents) return respond(error(id, -32002, 'Resource not found.', { uri: params.uri }));
          return ok({ contents: [contents] });
        }
        case 'prompts/list': return ok({ prompts: JSON.parse(JSON.stringify(PROMPTS)) as unknown });
        case 'prompts/get': {
          if (typeof params.name !== 'string' || withoutMeta(params).some(key => key !== 'name' && key !== 'arguments')) return invalid('prompts/get requires name and optional arguments.');
          const given = ownRecord(Object.hasOwn(params, 'arguments') ? params.arguments : {});
          if (given === null || Object.values(given).some(value => typeof value !== 'string')) return invalid('Prompt arguments must be an object of strings.');
          try { return ok(getPrompt(params.name, given as Record<string, string>)); }
          catch (cause) { return invalid(cause instanceof TypeError ? cause.message : 'Invalid prompt request.'); }
        }
        default: return respond(error(id, -32601, 'Method not found.'));
      }
    } catch {
      return respond(error(id, -32603, 'Internal error.'));
    }
  };
}

/** Core results keep their shape; failures only gain a `hint` where the check did not supply one. */
function withFailureHints<T extends { ok: boolean }>(result: T): Record<string, unknown> {
  const value = result as unknown as { ok: boolean; issues?: Parameters<typeof withHints>[0] };
  return (value.ok || !value.issues ? result : { ...result, issues: withHints(value.issues) }) as unknown as Record<string, unknown>;
}
