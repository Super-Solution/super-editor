import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { AGENT_ACTIONS, TEMPLATE_KINDS, TRANSPORT_LIMITS } from '../packages/core/src/index.js';
import { ROUTES } from '../packages/api/src/index.js';
import { PROMPTS, RESOURCES, RESOURCE_TEMPLATES, listTools } from '../packages/mcp/src/index.js';
import { COMMANDS } from '../packages/cli/src/commands.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFile(resolve(root, path), 'utf8');
const spaced = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

test('docs/API.md documents every action, route, command, resource, prompt and limit', async () => {
  const api = await read('docs/API.md');
  for (const action of AGENT_ACTIONS) assert.ok(api.includes(`\`${action.name}\``), `action ${action.name}`);
  for (const route of ROUTES) assert.ok(api.includes(route.path), `route ${route.path}`);
  for (const command of COMMANDS) assert.ok(api.includes(`\`${command.name}\``), `command ${command.name}`);
  for (const resource of RESOURCES) assert.ok(api.includes(resource.uri) || api.includes(resource.uri.replace('super-editor://', '')), `resource ${resource.uri}`);
  for (const template of RESOURCE_TEMPLATES) assert.ok(api.includes(template.uriTemplate), `resource template ${template.uriTemplate}`);
  for (const prompt of PROMPTS) assert.ok(api.includes(`\`${prompt.name}\``), `prompt ${prompt.name}`);
  for (const [name, value] of Object.entries(TRANSPORT_LIMITS)) assert.ok(api.includes(`\`${name}\``) || api.includes(`\`${name.replace(/Default|Max/, '')}`), `limit ${name}`);
  for (const value of [TRANSPORT_LIMITS.requestBytes, TRANSPORT_LIMITS.stdioMessageBytes, TRANSPORT_LIMITS.fileBytes]) assert.ok(api.includes(spaced(value)), `limit value ${spaced(value)}`);
  assert.ok(api.includes(spaced(TRANSPORT_LIMITS.markdownChars)));
  assert.match(api, /`0` success, `1` I\/O failure[^.]*`2` invalid input[^.]*`3` revision or version conflict, `4` block, citation or text not found/);
  for (const kind of TEMPLATE_KINDS) assert.ok(api.includes(`${kind}Template`) || kind === 'blank' || api.includes(kind), kind);
});

test('the counts quoted in the guides match the code', async () => {
  const tools = listTools().length, resources = RESOURCES.length, templates = RESOURCE_TEMPLATES.length, prompts = PROMPTS.length;
  assert.equal(tools, 4 + AGENT_ACTIONS.length);
  const guide = await read('docs/AGENT-GUIDE.md'), api = await read('docs/API.md'), mcp = await read('packages/mcp/README.md'), changelog = await read('CHANGELOG.md'), readme = await read('README.md');
  assert.ok(guide.includes(`${tools} tools, ${resources} resources, ${templates} resource templates and ${prompts} prompts`));
  assert.ok(api.includes(`**Tools (${tools}).**`));
  assert.ok(mcp.includes(`**${tools} tools**`) && mcp.includes(`**${resources} resources**`) && mcp.includes(`${templates} templates`) && mcp.includes(`**${prompts} prompts**`));
  assert.ok(mcp.includes(`${AGENT_ACTIONS.length} narrow ones`));
  assert.ok(changelog.includes(`${AGENT_ACTIONS.length} semantic operations`) && changelog.includes(`${tools} tools`));
  assert.ok(readme.includes(`${tools} tools`));
  assert.ok((await read('packages/api/README.md')).includes(`any of the ${AGENT_ACTIONS.length} semantic actions`));
});

test('package READMEs and the changelog name every tool and command', async () => {
  const mcp = await read('packages/mcp/README.md'), cli = await read('packages/cli/README.md'), changelog = await read('CHANGELOG.md'), core = await read('packages/core/README.md');
  for (const action of AGENT_ACTIONS) { assert.ok(mcp.includes(`\`${action.name}\``), `mcp README ${action.name}`); assert.ok(changelog.includes(`\`${action.name}\``), `changelog ${action.name}`); }
  for (const name of ['read_document', 'apply_transaction', 'undo', 'redo']) assert.ok(mcp.includes(`\`${name}\``), name);
  for (const command of COMMANDS) assert.ok(cli.includes(`\`${command.name}\``), `cli README ${command.name}`);
  for (const kind of TEMPLATE_KINDS) assert.ok(core.includes(kind), `core README ${kind}`);
  for (const prompt of PROMPTS) assert.ok(mcp.includes(`\`${prompt.name}\``), `mcp README ${prompt.name}`);
});

test('the agent guide covers every tool, every template and the error codes', async () => {
  const guide = await read('docs/AGENT-GUIDE.md');
  for (const action of AGENT_ACTIONS) assert.ok(guide.includes(action.name), `guide ${action.name}`);
  for (const name of ['apply_transaction', 'undo', 'redo', 'read_document']) assert.ok(guide.includes(name), name);
  for (const kind of TEMPLATE_KINDS) assert.ok(guide.includes(kind), `guide ${kind}`);
  for (const code of ['validation', 'conflict', 'not-found', 'duplicate', 'history']) assert.ok(guide.includes(`\`${code}\``), code);
  for (const kind of ['line', 'trend', 'area', 'bar', 'pie', 'donut', 'histogram', 'waterfall', 'scatter', 'candlestick', 'heatmap']) assert.ok(guide.includes(`\`${kind}\``), `chart kind ${kind}`);
});

test('relative links in the docs point at files that exist', async () => {
  for (const file of ['README.md', 'CHANGELOG.md', 'docs/AGENT-GUIDE.md', 'docs/API.md', 'docs/SECURITY.md', 'docs/RELEASING.md', 'docs/API-CONTRACT.md', 'examples/README.md', 'packages/api/README.md', 'packages/mcp/README.md', 'packages/cli/README.md', 'packages/core/README.md']) {
    const text = await read(file);
    for (const match of text.matchAll(/\]\((?!https?:|mailto:|#)([^)#\s]+)(?:#[^)\s]*)?\)/g)) {
      assert.ok(existsSync(resolve(root, dirname(file), match[1]!)), `${file} links to missing ${match[1]}`);
    }
  }
});

test('SECURITY.md documents image and embed URL handling and the transport boundaries', async () => {
  const security = await read('docs/SECURITY.md');
  for (const needle of ['## Image and embed URLs', '## Transports', 'https://', 'data:', 'javascript:', 'img-src', 'frame-src', 'sandbox', 'no-referrer', 'SSRF', 'Content-Security-Policy', 'tracking', 'readOnlyHint', 'not instructions']) assert.ok(security.includes(needle), needle);
});
