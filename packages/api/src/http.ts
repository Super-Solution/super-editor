import type { ReportService } from '@super-solution/editor-core';
import { createOpenApiDocument } from './openapi.js';
import { HttpProblem, failureResponse, jsonResponse } from './respond.js';
import { HTTP_LIMITS, createContext, matchRoute, type CorsOptions, type HttpHandlerOptions } from './routes.js';

export type { CorsOptions, HttpHandlerOptions } from './routes.js';

const EXPOSED_HEADERS = 'x-document-revision';

function validateOptions(options: HttpHandlerOptions): number {
  const maxBodyBytes = options.maxBodyBytes ?? HTTP_LIMITS.maxBodyBytes;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw new Error('maxBodyBytes must be a positive integer.');
  if (options.basePath !== undefined && !/^\/[^?#]*[^/?#]$/.test(options.basePath)) throw new Error('basePath must start with "/" and must not end with "/".');
  const origins = options.cors?.origins;
  if (options.cors && origins !== '*' && (!Array.isArray(origins) || origins.some(origin => typeof origin !== 'string' || origin === '' || origin === '*' || origin.endsWith('/')))) {
    throw new Error('cors.origins must be "*" or an array of exact origins such as "https://app.example.com".');
  }
  return maxBodyBytes;
}

function allowedOrigin(cors: CorsOptions | undefined, origin: string | null): string | null {
  if (!cors || origin === null) return null;
  if (cors.origins === '*') return '*';
  return cors.origins.includes(origin) ? origin : null;
}

/**
 * Fetch-compatible adapter: `(Request) => Promise<Response>`. It does not bind a port, authenticate callers or check CSRF;
 * the host does that before forwarding a request. Every failure has the same JSON shape
 * `{ ok: false, issues: [{ code, message, path?, hint }], currentRevision }`.
 */
export function createHttpHandler(service: ReportService, options: HttpHandlerOptions = {}) {
  const maxBodyBytes = validateOptions(options);
  let openapi: unknown;

  return async (request: Request): Promise<Response> => {
    const origin = request.headers.get('origin');
    const allowed = allowedOrigin(options.cors, origin);
    const decorate = (response: Response): Response => {
      if (allowed !== null) {
        response.headers.set('access-control-allow-origin', allowed);
        response.headers.set('access-control-expose-headers', EXPOSED_HEADERS);
        if (allowed !== '*') response.headers.append('vary', 'origin');
      }
      return response;
    };
    try {
      let pathname = new URL(request.url).pathname;
      if (options.basePath !== undefined) {
        if (pathname !== options.basePath && !pathname.startsWith(`${options.basePath}/`)) return decorate(failureResponse(service, [{ code: 'not-found', message: 'Unknown route.', hint: `Routes live under ${options.basePath}.` }], 404));
        pathname = pathname.slice(options.basePath.length) || '/';
      }
      const found = matchRoute(request.method === 'HEAD' ? 'GET' : request.method, pathname);

      if (request.method === 'OPTIONS') {
        if (found === null) return decorate(failureResponse(service, [{ code: 'not-found', message: 'Unknown route.', hint: 'GET /openapi.json lists the routes.' }], 404));
        const methods = 'allow' in found ? found.allow : [found.match.route.method];
        const allow = [...methods, 'OPTIONS'].join(', ');
        if (request.headers.get('access-control-request-method') !== null && origin !== null && options.cors) {
          if (allowed === null) return failureResponse(service, [{ code: 'validation', message: 'This origin is not allowed.', hint: 'Ask the operator to add the origin to the CORS allow-list.' }], 403);
          const requested = request.headers.get('access-control-request-headers');
          const headers = new Headers({ allow, 'access-control-allow-origin': allowed, 'access-control-allow-methods': allow, 'access-control-max-age': String(options.cors.maxAge ?? 600), 'cache-control': 'no-store' });
          headers.set('access-control-allow-headers', requested !== null && (options.cors.headers ?? []).length > 0 ? ['content-type', ...(options.cors.headers ?? [])].join(', ') : 'content-type');
          if (allowed !== '*') headers.append('vary', 'origin');
          return new Response(null, { status: 204, headers });
        }
        return decorate(new Response(null, { status: 204, headers: { allow, 'cache-control': 'no-store' } }));
      }
      if (found === null) return decorate(failureResponse(service, [{ code: 'not-found', message: 'Unknown route.', hint: 'GET /openapi.json lists the routes.' }], 404));
      if ('allow' in found) {
        return decorate(failureResponse(service, [{ code: 'validation', message: `Method ${request.method} is not allowed here.`, hint: `Use ${found.allow.join(' or ')}.` }], 405, { allow: found.allow.join(', ') }));
      }
      const { route, params } = found.match;
      if (options.readOnly && route.write) {
        return decorate(failureResponse(service, [{ code: 'validation', message: 'This endpoint is read-only.', hint: 'Use a GET route, or ask the operator for a writable endpoint.' }], 403));
      }
      const url = new URL(request.url);
      const context = createContext(service, request, url, params, options, maxBodyBytes);
      let response: Response;
      if (route.operationId === 'openapi') {
        openapi ??= createOpenApiDocument({ ...(options.basePath ? { servers: [{ url: options.basePath }] } : {}) });
        response = jsonResponse(openapi);
      } else response = await route.run(context);
      if (request.method === 'HEAD') response = new Response(null, { status: response.status, headers: response.headers });
      return decorate(response);
    } catch (error) {
      if (error instanceof HttpProblem) return decorate(failureResponse(service, [error.issue], error.status));
      return decorate(failureResponse(service, [{ code: 'validation', message: 'The request could not be processed safely.', hint: 'Retry; if it keeps failing, report it with the route and body.' }], 500));
    }
  };
}
