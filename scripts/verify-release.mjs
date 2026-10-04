import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { packageName, releasePackages } from './release-contract.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packages = releasePackages(root);
const output = resolve(root, 'artifacts', 'release');
mkdirSync(output, { recursive: true });
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: root, encoding: 'utf8' }).trim());
if (process.argv.includes('--require-clean') && dirty) throw new Error('Release verification requires a clean tracked source tree.');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Invoke using npm run release:check.');
const npm = (args, cwd = root) => execFileSync(process.execPath, [npmCli, ...args], { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
const canonicalLicense = readFileSync(resolve(root, 'LICENSE'));
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['npm token', /\bnpm_[A-Za-z0-9]{30,}\b/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['AWS access key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['AI API key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}\b/],
  ['local user path', /(?:[A-Z]:\\Users\\|\/home\/|\/Users\/)[^\s<>]+/],
];
function unpack(buffer) {
  const data = gunzipSync(buffer, { maxOutputLength: 8 * 1024 * 1024 });
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join('/');
    const sizeText = text(124, 12).trim();
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('Invalid tar size.');
    const size = Number.parseInt(sizeText, 8);
    const type = text(156, 1);
    if (!['', '0'].includes(type) || size > 2 * 1024 * 1024 || offset + 512 + size > data.length) throw new Error(`Unexpected tar entry: ${name}`);
    if (!/^package\/(?:package\.json|README\.md|LICENSE|dist\/[A-Za-z0-9._/-]+\.(?:js|d\.ts|css))$/.test(name) || name.includes('..') || files.has(name)) throw new Error(`Disallowed tar path: ${name}`);
    files.set(name, data.subarray(offset + 512, offset + 512 + size));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
function exportTargets(value) {
  return typeof value === 'string' ? [value] : Object.values(value ?? {}).flatMap(exportTargets);
}
const results = [];
for (const item of packages) {
  const args = [item.directory, '--ignore-scripts', '--json', '--pack-destination', output];
  const [dry] = JSON.parse(npm(['pack', '--dry-run', ...args]));
  const [packed] = JSON.parse(npm(['pack', ...args]));
  assert.deepEqual(dry.files.map(f => f.path).sort(), packed.files.map(f => f.path).sort(), 'Dry-run and actual files differ.');
  const tarball = resolve(output, packed.filename);
  const bytes = readFileSync(tarball);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  assert.equal(integrity, packed.integrity);
  const files = unpack(bytes);
  assert.deepEqual([...files.keys()].map(p => p.slice(8)).sort(), packed.files.map(f => f.path).sort());
  assert.ok(files.get('package/LICENSE')?.equals(canonicalLicense), 'Canonical owner license must be included unchanged.');
  const metadata = JSON.parse(files.get('package/package.json').toString('utf8'));
  assert.equal(metadata.name, item.pkg.name);
  assert.equal(metadata.version, item.version);
  for (const target of [...exportTargets(metadata.exports), metadata.types, ...Object.values(metadata.bin ?? {})]) {
    assert.ok(typeof target === 'string' && files.has(`package/${target.replace(/^\.\//, '')}`), `Missing packed export: ${target}`);
  }
  for (const [path, contents] of files) {
    for (const [label, pattern] of rules) if (pattern.test(contents.toString('utf8'))) throw new Error(`Packed content rejected (${label}): ${path}`);
  }
  results.push({ name: metadata.name, version: metadata.version, channel: item.channel, filename: packed.filename, size: bytes.length, integrity, sha256: createHash('sha256').update(bytes).digest('hex') });
  console.log(`Verified ${metadata.name}@${metadata.version}: ${files.size} allowlisted files; license, exports and secret-pattern scan passed.`);
}
const consumer = resolve(output, 'consumer');
mkdirSync(consumer, { recursive: true });
writeFileSync(resolve(output, 'empty.npmrc'), '');
const dependencies = Object.fromEntries(results.map(item => [item.name, `file:../${item.filename}`]));
Object.assign(dependencies, { react: '19.2.0', 'react-dom': '19.2.0', '@types/react': '19.2.2', '@types/react-dom': '19.2.2' });
writeFileSync(resolve(consumer, 'package.json'), `${JSON.stringify({ private: true, type: 'module', dependencies }, null, 2)}\n`);
execFileSync(process.execPath, [npmCli, 'install', '--prefix', consumer, '--workspaces=false', '--ignore-scripts', '--package-lock=false', '--no-audit', '--no-fund', '--registry', 'https://registry.npmjs.org/'], {
  cwd: consumer, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  env: { ...process.env, NPM_CONFIG_USERCONFIG: resolve(output, 'empty.npmrc') },
});
for (const item of results) {
  const installed = JSON.parse(readFileSync(resolve(consumer, 'node_modules', item.name, 'package.json'), 'utf8'));
  assert.equal(installed.name, item.name);
  assert.equal(installed.version, item.version);
}
writeFileSync(resolve(consumer, 'smoke.mjs'), `import assert from 'node:assert/strict';
import { createDocument, createEditor, createReportService, serializeDocument, parseDocument, runAgentAction, createTemplate, AGENT_ACTIONS } from '${packageName('core')}';
import { renderDocument, mountEditor } from '${packageName('ui')}';
import { ReportView, ReportEditor, useEditor } from '${packageName('react')}';
import { createHttpHandler } from '${packageName('api')}';
import { createMcpDispatcher } from '${packageName('mcp')}';
import { runCli, CLI_HELP } from '${packageName('cli')}';
import React from 'react';
import { renderToString } from 'react-dom/server';
const editor=createEditor(createDocument({id:'consumer',title:'Consumer smoke'}));
const service=createReportService(editor); assert.equal(parseDocument(serializeDocument(service.read())).ok,true);
const accepted=service.apply({id:'agent',actor:{id:'agent',kind:'agent'},baseRevision:0,operations:[{type:'insertBlock',block:{id:'summary',parentId:null,citationIds:[],content:{type:'paragraph',runs:[{text:'Verified consumer'}]}}}]}); assert.equal(accepted.ok,true);
const human=service.apply({id:'human',actor:{id:'human',kind:'human'},baseRevision:1,operations:[{type:'updateBlock',blockId:'summary',expectedVersion:1,content:{type:'paragraph',runs:[{text:'Human retained'}]}}]}); assert.equal(human.ok,true);
const stale=service.apply({id:'stale',actor:{id:'agent',kind:'agent'},baseRevision:1,operations:[{type:'updateBlock',blockId:'summary',expectedVersion:1,content:{type:'paragraph',runs:[{text:'Stale'}]}}]}); assert.equal(stale.ok,false);
const response=await createHttpHandler(service)(new Request('https://example.invalid/document')); assert.equal(response.status,200); assert.equal((await response.json()).revision,2);
const rpc=await createMcpDispatcher(service)({jsonrpc:'2.0',id:1,method:'tools/list',params:{}}); assert.equal(rpc.result.tools.length,4+AGENT_ACTIONS.length); assert.ok(rpc.result.tools.every(tool=>tool.annotations&&typeof tool.annotations.readOnlyHint==='boolean'));
const outline=runAgentAction(service,'get_outline',{}); assert.equal(outline.ok,true); assert.equal(runAgentAction(service,'find_blocks',{text:'Human retained'}).total,1); assert.ok(createTemplate('equity').length>10);
const openapi=await (await createHttpHandler(service)(new Request('https://example.invalid/openapi.json'))).json(); assert.equal(openapi.openapi,'3.1.0');
assert.match(renderToString(React.createElement(ReportView,{document:service.read()})),/Human retained/);
for(const fn of [renderDocument,mountEditor,ReportEditor,useEditor,runCli])assert.equal(typeof fn,'function'); assert.match(CLI_HELP,/super-editor/);
console.log('Independent six-tarball ESM, HTTP, MCP, React SSR and guarded edit smoke passed.');\n`);
console.log(execFileSync(process.execPath, [resolve(consumer, 'smoke.mjs')], { cwd: consumer, encoding: 'utf8' }).trim());
writeFileSync(resolve(consumer, 'smoke.ts'), `import {createDocument,createEditor,createReportService,type Transaction} from '${packageName('core')}';
import {renderDocument,mountEditor} from '${packageName('ui')}';
import {ReportView,ReportEditor,useEditor} from '${packageName('react')}';
import {createHttpHandler} from '${packageName('api')}';
import {createMcpDispatcher} from '${packageName('mcp')}';
import {runCli} from '${packageName('cli')}';
const editor=createEditor(createDocument({id:'typed',title:'Typed'})); const service=createReportService(editor);
const transaction:Transaction={id:'title',actor:{id:'agent',kind:'agent'},baseRevision:0,operations:[{type:'setTitle',title:'Typed consumer'}]};
service.apply(transaction); createHttpHandler(service); createMcpDispatcher(service); useEditor(editor);
void [renderDocument,mountEditor,ReportView,ReportEditor,runCli];\n`);
writeFileSync(resolve(consumer, 'tsconfig.json'), `${JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: false, typeRoots: ['./node_modules/@types'], types: ['react', 'react-dom'], lib: ['ES2022', 'DOM', 'DOM.Iterable'] }, include: ['smoke.ts'] }, null, 2)}\n`);
execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', resolve(consumer, 'tsconfig.json')], { cwd: consumer, encoding: 'utf8', stdio: 'pipe' });
const bin = resolve(consumer, 'node_modules/@super-solution/editor-cli/dist/cli.js');
assert.match(execFileSync(process.execPath, [bin, 'help'], { cwd: consumer, encoding: 'utf8' }), /super-editor init/);
const cliDocument = resolve(consumer, 'report.json');
const cliTransaction = resolve(consumer, 'transaction.json');
// Each verification owns these two scratch files; init itself must continue to refuse overwrites.
const { rmSync } = await import('node:fs');
rmSync(cliDocument, { force: true });
execFileSync(process.execPath, [bin, 'init', cliDocument, '--id', 'cli-consumer', '--title', 'Initial'], { cwd: consumer, encoding: 'utf8' });
writeFileSync(cliTransaction, JSON.stringify({ id: 'cli-update', actor: { id: 'agent', kind: 'agent' }, baseRevision: 0, operations: [{ type: 'setTitle', title: 'CLI verified' }] }));
execFileSync(process.execPath, [bin, 'apply', cliDocument, cliTransaction], { cwd: consumer, encoding: 'utf8' });
assert.equal(JSON.parse(execFileSync(process.execPath, [bin, 'read', cliDocument], { cwd: consumer, encoding: 'utf8' })).title, 'CLI verified');
const retainedBytes = readFileSync(cliDocument);
assert.throws(() => execFileSync(process.execPath, [bin, 'apply', cliDocument, cliTransaction], { cwd: consumer, encoding: 'utf8', stdio: 'pipe' }), error => error.status === 3);
assert.ok(readFileSync(cliDocument).equals(retainedBytes), 'Stale CLI transaction must preserve exact file bytes.');
const installedCss = resolve(consumer, 'node_modules/@super-solution/editor-ui/dist/styles.css');
assert.match(readFileSync(installedCss, 'utf8'), /--se-/);
const cliRun = (...args) => JSON.parse(execFileSync(process.execPath, [bin, ...args], { cwd: consumer, encoding: 'utf8' }));
const agentDocument = resolve(consumer, 'agent-report.json');
rmSync(agentDocument, { force: true });
execFileSync(process.execPath, [bin, 'new', agentDocument, '--id', 'agent-consumer', '--template', 'equity', '--subject', 'ACME'], { cwd: consumer, encoding: 'utf8' });
const thesis = cliRun('find', agentDocument, '--text', 'thesis', '--type', 'paragraph', '--json').blocks[0];
assert.equal(cliRun('update-text', agentDocument, thesis.id + '@' + thesis.version, '--text', 'Checked by the release smoke.', '--json').ok, true);
assert.throws(() => execFileSync(process.execPath, [bin, 'update-text', agentDocument, thesis.id + '@' + thesis.version, '--text', 'stale'], { cwd: consumer, encoding: 'utf8', stdio: 'pipe' }), error => error.status === 3);
assert.match(execFileSync(process.execPath, [bin, 'export', agentDocument], { cwd: consumer, encoding: 'utf8' }), /Checked by the release smoke/);
const mcpBin = resolve(consumer, 'node_modules/@super-solution/editor-mcp/dist/stdio.js');
const mcpDocument = resolve(consumer, 'mcp-report.json');
rmSync(mcpDocument, { force: true });
const mcpLines = execFileSync(process.execPath, [mcpBin, mcpDocument, '--create', '--id', 'mcp-consumer', '--template', 'macro'], {
  cwd: consumer, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
  input: [{ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' }, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_outline', arguments: {} } }].map(message => JSON.stringify(message)).join('\n') + '\n',
}).trim().split('\n').map(line => JSON.parse(line));
assert.equal(mcpLines[0].result.serverInfo.name, 'super-editor');
assert.ok(mcpLines[1].result.tools.some(tool => tool.name === 'insert_blocks'));
assert.ok(mcpLines[2].result.structuredContent.outline.length > 3);
console.log('Independent declaration resolution, CLI init/read/apply/conflict, agent commands, MCP stdio server and CSS asset smoke passed.');
writeFileSync(resolve(output, 'release-manifest.json'), `${JSON.stringify({ sourceCommit, dirty, version: packages[0].version, channel: packages[0].channel, packages: results }, null, 2)}\n`);
