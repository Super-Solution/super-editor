// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { build } from 'vite';

/**
 * Real-browser tests: Chromium through Playwright against the built demo. They cover what jsdom cannot: layout and container
 * queries, contenteditable and the clipboard, focus, fixed positioning and console errors. Run with `npm run test:e2e`
 * (after `npm run build`, which produces the packaged stylesheet some tests read). Without a Chromium they skip, loudly.
 */
export const root = fileURLToPath(new URL('..', import.meta.url));
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.map': 'application/json' };

/**
 * Starts Chromium. `SUPER_EDITOR_CHROMIUM=/path/to/chrome` uses a browser you already have (Chrome, Chromium, Edge) instead of
 * Playwright's own download; `SUPER_EDITOR_E2E_SANDBOX=1` turns the sandbox on (it is off by default because hosted CI runners and
 * containers often forbid the user namespaces it needs).
 */
export async function launch(): Promise<Browser | null> {
  const executablePath = process.env.SUPER_EDITOR_CHROMIUM || undefined;
  try { return await chromium.launch({ ...(executablePath ? { executablePath } : {}), args: process.env.SUPER_EDITOR_E2E_SANDBOX === '1' ? [] : ['--no-sandbox'] }); }
  catch (error) { console.warn(`SKIP e2e: Chromium could not start (${(error as Error).message.split('\n')[0]}). Install it with "npx playwright install chromium" or point SUPER_EDITOR_CHROMIUM at a browser.`); return null; }
}

export type Demo = { url: string; close(): Promise<void> };
/** Builds the demo into a temporary folder and serves it on a free local port. */
export async function serveDemo(): Promise<Demo> {
  const out = mkdtempSync(join(tmpdir(), 'super-editor-demo-'));
  await build({ root, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
  const server: Server = createServer((request, response) => {
    const path = normalize(decodeURIComponent((request.url ?? '/').split('?')[0]!)).replace(/^(\.\.[/\\])+/, '');
    let file = join(out, path);
    try { if (statSync(file).isDirectory()) file = join(file, 'index.html'); } catch { file = join(out, 'index.html'); }
    try { response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }); response.end(readFileSync(file)); }
    catch { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise<void>((resolve) => { server.close(() => { rmSync(out, { recursive: true, force: true }); resolve(); }); }) };
}

/** The packaged, self-contained stylesheet (`npm run build` writes it). */
export function packagedCss(): string {
  try { return readFileSync(join(root, 'packages/ui/dist/styles.css'), 'utf8'); }
  catch { throw new Error('packages/ui/dist/styles.css is missing: run "npm run build" first.'); }
}
