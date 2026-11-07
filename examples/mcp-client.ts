import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Pending = { resolve(value: unknown): void; reject(error: Error): void };
const root = fileURLToPath(new URL('..', import.meta.url));

/** A minimal MCP client over stdio: one JSON-RPC message per line. Real clients (Claude Desktop, Claude Code, Cursor) do exactly this. */
export class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  readonly stderr: string[] = [];

  constructor(command: string, args: string[]) {
    this.child = spawn(command, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk: string) => { this.stderr.push(chunk); });
    createInterface({ input: this.child.stdout }).on('line', line => {
      const message = JSON.parse(line) as { id?: number; result?: unknown; error?: { message: string } };
      const waiting = message.id === undefined ? undefined : this.pending.get(message.id);
      if (!waiting || message.id === undefined) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new Error(message.error.message)); else waiting.resolve(message.result);
    });
  }
  request<T = Record<string, any>>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  notify(method: string, params: Record<string, unknown> = {}): void { this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); }
  /** Calls a tool and returns its structured result (a failed edit is a normal result with ok: false and a hint). */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const result = await this.request<{ structuredContent: Record<string, unknown> }>('tools/call', { name, arguments: args });
    return result.structuredContent;
  }
  close(): Promise<number | null> {
    return new Promise(resolve => { this.child.on('close', resolve); this.child.stdin.end(); });
  }
}

/** Prefers the built server (`npm run build`), falls back to running the TypeScript source through tsx. */
export function serverCommand(documentPath: string, ...options: string[]): { command: string; args: string[] } {
  const built = fileURLToPath(new URL('../packages/mcp/dist/stdio.js', import.meta.url));
  if (existsSync(built)) return { command: process.execPath, args: [built, documentPath, ...options] };
  return { command: process.execPath, args: ['--import', 'tsx', '--conditions=development', fileURLToPath(new URL('../packages/mcp/src/stdio.ts', import.meta.url)), documentPath, ...options] };
}

/**
 * A scripted agent session against `super-editor-mcp`. The server creates the file from a template, so there is
 * nothing to set up first:  npx tsx --conditions=development examples/mcp-client.ts /tmp/report.json
 */
export async function runMcpExample(documentPath: string, log: (line: string) => void = () => undefined) {
  const { command, args } = serverCommand(documentPath, '--create', '--id', 'mcp-demo', '--template', 'macro', '--subject', 'the euro area', '--actor', 'demo-agent:agent');
  const client = new McpStdioClient(command, args);
  try {
    const init = await client.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'example-client', version: '1.0.0' } });
    client.notify('notifications/initialized');
    log(`connected to ${init.serverInfo.name} ${init.serverInfo.version}`);
    const { tools } = await client.request<{ tools: { name: string; annotations: { readOnlyHint: boolean } }[] }>('tools/list');
    log(`${tools.length} tools, ${tools.filter(tool => tool.annotations.readOnlyHint).length} read-only`);

    const outline = await client.callTool('get_outline');
    log(`outline: ${outline.outline.map((entry: { title: string }) => entry.title).join(' | ')}`);
    const found = await client.callTool('find_blocks', { type: 'paragraph', text: 'overall view' });
    const target = found.blocks[0] as { id: string; version: number };
    const edited = await client.callTool('update_block_text', { blockId: target.id, expectedVersion: target.version, text: 'Growth is **moderating** while inflation eases.' });
    log(`edited ${target.id}: ${edited.summary}`);
    const stale = await client.callTool('update_block_text', { blockId: target.id, expectedVersion: target.version, text: 'A stale proposal.' });
    log(`stale edit refused: ${stale.issues[0].code} - ${stale.issues[0].hint}`);
    const cited = await client.callTool('add_citation', { title: 'Example statistics office', url: 'https://example.com/hicp', blockId: target.id, expectedVersion: edited.blocks[0].version, marker: true });
    const chart = await client.callTool('add_chart', { spec: { kind: 'line', title: 'Inflation', labels: ['Q1', 'Q2', 'Q3'], series: [{ name: 'HICP', values: [3.1, 2.8, 2.5] }], unit: '%', source: 'Example statistics office' }, parentId: 'macro-rates', afterId: null });
    log(`citation ${cited.citationId}, chart ${chart.blockId}`);

    const resource = await client.request<{ contents: { text: string }[] }>('resources/read', { uri: 'super-editor://stats' });
    log(`stats resource: ${resource.contents[0]!.text.replace(/\s+/g, ' ').slice(0, 80)}...`);
    const prompt = await client.request<{ messages: { content: { text: string } }[] }>('prompts/get', { name: 'review_report' });
    log(`review prompt: ${prompt.messages[0]!.content.text.split('\n')[0]}`);
    const markdown = await client.callTool('export_markdown');
    return { outline, edited, stale, cited, chart, markdown: markdown.text as string };
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) { console.error('Usage: tsx examples/mcp-client.ts <new-document.json>'); process.exitCode = 2; }
  else console.log((await runMcpExample(file, console.log)).markdown);
}
