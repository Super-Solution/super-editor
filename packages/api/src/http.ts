import type { Actor } from '@super-solution/editor-core';
import { validationFailure, type ApplyResult, type ReportService } from '@super-solution/editor-core';

export type HttpHandlerOptions = { maxBodyBytes?: number };

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

async function readJson(request: Request, limit: number): Promise<unknown> {
  const contentLength = request.headers.get('content-length');
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) {
    throw new Error('Request body exceeds the byte limit or has an invalid Content-Length.');
  }
  if (request.body === null) throw new Error('A JSON request body is required.');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error('Request body exceeds the byte limit.');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as unknown;
}

/** Fetch-compatible adapter; it does not bind a port or establish authentication. */
export function createHttpHandler(service: ReportService, options: HttpHandlerOptions = {}) {
  const maxBodyBytes = options.maxBodyBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error('maxBodyBytes must be a positive integer.');

  return async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    const method = path === '/document' ? 'GET' : ['/transactions', '/undo', '/redo'].includes(path) ? 'POST' : null;
    if (method === null) return json({ error: 'Unknown route.' }, 404);
    if (request.method !== method) return json({ error: 'Method not allowed.' }, 405, { allow: method });
    if (path === '/document') return json(service.read());

    const contentType = request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType && contentType !== 'application/json') {
      return json(validationFailure(service, 'Content-Type must be application/json.'), 400);
    }
    let body: unknown;
    try {
      body = await readJson(request, maxBodyBytes);
    } catch {
      return json(validationFailure(service, 'Expected valid UTF-8 JSON within the request byte limit.'), 400);
    }

    if (path === '/transactions') {
      const result = service.apply(body);
      return json(result, resultStatus(result));
    }
    if (!isRecord(body) || Object.keys(body).some((key) => key !== 'actor' && key !== 'expectedRevision')) {
      return json(validationFailure(service, 'History request requires only actor and expectedRevision.'), 400);
    }
    // The Core validates these unknown runtime values, including malformed actors.
    const result = path === '/undo'
      ? service.undo(body.actor as Actor, body.expectedRevision as number)
      : service.redo(body.actor as Actor, body.expectedRevision as number);
    return json(result, resultStatus(result));
  };
}

function resultStatus(result: ApplyResult): number {
  return result.ok ? 200 : result.issues.some((issue) => issue.code === 'conflict') ? 409 : 400;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
