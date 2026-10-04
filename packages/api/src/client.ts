import type { Actor, AgentActionInputs, AgentActionName, AgentActionOutputs, AgentActionResult, AgentFailure, ApplyResult, ResearchDocument, Transaction } from '@super-solution/editor-core';
import { AGENT_ACTIONS } from '@super-solution/editor-core';

export type HttpClientOptions = {
  /** Where the handler is mounted, for example `https://host.example.com/reports/42`. */
  baseUrl: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Headers for every request (authentication). May be a function, called per request. */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Sent as the author of edits that do not name one. Ignored by a handler that resolves the actor itself. */
  actor?: Actor;
  /** Abort a request after this many milliseconds. Default 30 000. */
  timeoutMs?: number;
};

/** Thrown when no usable answer arrived: a network failure, a timeout or a body that is not JSON. API-level failures are returned, not thrown. */
export class HttpClientError extends Error {
  constructor(message: string, readonly status?: number, options?: { cause?: unknown }) { super(message, options); this.name = 'HttpClientError'; }
}

type Call<Input, Output> = {} extends Input ? (input?: Input) => Promise<Output | AgentFailure> : (input: Input) => Promise<Output | AgentFailure>;
export type ActionClient = { [Name in AgentActionName]: Call<AgentActionInputs[Name], AgentActionOutputs[Name]> };
export interface HttpClient {
  /** One method per action, typed from the action's input and result: `client.actions.update_block_text({ ... })`. */
  readonly actions: ActionClient;
  /** Run an action by name with untyped input. */
  run(name: string, input?: Record<string, unknown>): Promise<AgentActionResult>;
  document(): Promise<ResearchDocument>;
  apply(transaction: Transaction): Promise<ApplyResult>;
  undo(actor: Actor, expectedRevision: number): Promise<ApplyResult>;
  redo(actor: Actor, expectedRevision: number): Promise<ApplyResult>;
  /** The OpenAPI document of the server. */
  openapi(): Promise<Record<string, unknown>>;
  health(): Promise<{ ok: true; revision: number }>;
}

/**
 * Typed client for the HTTP API. Edits that the server refuses come back as `{ ok: false, issues, currentRevision }`, the same
 * shape as everywhere else, so one `if (!result.ok)` handles conflicts from any transport.
 */
export function createHttpClient(options: HttpClientOptions): HttpClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) throw new TypeError('baseUrl must be an absolute http(s) URL.');
  const timeoutMs = options.timeoutMs ?? 30_000;

  async function request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const send = options.fetch ?? globalThis.fetch;
    if (typeof send !== 'function') throw new HttpClientError('No fetch implementation is available; pass options.fetch.');
    const extra = typeof options.headers === 'function' ? await options.headers() : options.headers ?? {};
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
    let response: Response;
    try {
      response = await send(`${base}${path}`, {
        method, signal: controller.signal, headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new HttpClientError(controller.signal.aborted ? `Request to ${path} timed out after ${timeoutMs} ms.` : `Request to ${path} failed: ${cause instanceof Error ? cause.message : 'network error'}.`, undefined, { cause });
    } finally { clearTimeout(timer); }
    const text = await response.text();
    try { return JSON.parse(text) as T; }
    catch { throw new HttpClientError(`${method} ${path} returned ${response.status} with a body that is not JSON.`, response.status); }
  }

  const withActor = (input: Record<string, unknown> = {}): Record<string, unknown> => options.actor && !Object.hasOwn(input, 'actor') ? { ...input, actor: options.actor } : input;
  const run = (name: string, input: Record<string, unknown> = {}): Promise<AgentActionResult> => request('POST', `/actions/${encodeURIComponent(name)}`, withActor(input));

  const actions = Object.fromEntries(AGENT_ACTIONS.map(action => [action.name, (input: Record<string, unknown> = {}) => run(action.name, input)])) as unknown as ActionClient;
  return {
    actions, run,
    document: async () => {
      const found = await request<ResearchDocument | AgentFailure>('GET', '/document');
      if ('ok' in found && found.ok === false) throw new HttpClientError(found.issues[0]?.message ?? 'The document could not be read.');
      return found as ResearchDocument;
    },
    apply: transaction => request('POST', '/transactions', transaction),
    undo: (actor, expectedRevision) => request('POST', '/undo', { actor, expectedRevision }),
    redo: (actor, expectedRevision) => request('POST', '/redo', { actor, expectedRevision }),
    openapi: () => request('GET', '/openapi.json'),
    health: () => request('GET', '/health'),
  };
}
