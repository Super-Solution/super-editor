import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { parseDocument } from '../packages/core/src/index.js';
import type { ResearchDocument } from '../packages/core/src/index.js';
import { CLI_HELP, runCli } from '../packages/cli/src/cli.js';
import { COMMANDS } from '../packages/cli/src/commands.js';

const execFileAsync = promisify(execFile);

function capture(stdin?: string) {
  const out: string[] = [], err: string[] = [];
  return { out, err, text: () => out.join(''), errors: () => err.join(''), io: { stdout: (value: string) => { out.push(value); }, stderr: (value: string) => { err.push(value); }, ...(stdin === undefined ? {} : { stdin: async () => stdin }) } };
}
async function scratch() {
  const directory = await mkdtemp(join(tmpdir(), 'super-editor-cli-'));
  return { directory, file: join(directory, 'report.json') };
}
async function cleanup(directory: string) {
  const absolute = resolve(directory);
  assert.equal(dirname(absolute), resolve(tmpdir()));
  assert.ok(basename(absolute).startsWith('super-editor-cli-'));
  await rm(absolute, { recursive: true, force: true });
}
async function run(args: string[], stdin?: string) {
  const io = capture(stdin);
  const code = await runCli(args, io.io);
  return { code, out: io.text(), err: io.errors(), json: () => JSON.parse(io.text()) as any, errJson: () => JSON.parse(io.errors()) as any };
}
async function document(file: string): Promise<ResearchDocument> {
  const parsed = parseDocument(await readFile(file, 'utf8'));
  assert.ok(parsed.ok);
  return parsed.value;
}
const block = (doc: ResearchDocument, id: string) => doc.blocks.find(entry => entry.id === id)!;

test('new creates a document from a template, refuses overwrite and bad input, and templates lists the kinds', async () => {
  const { directory, file } = await scratch();
  try {
    const created = await run(['new', file, '--id', 'aapl-q3', '--template', 'equity', '--subject', 'AAPL', '--json']);
    assert.equal(created.code, 0, created.err);
    assert.deepEqual([created.json().ok, created.json().title, created.json().template], [true, 'AAPL: equity analysis', 'equity']);
    const doc = await document(file);
    assert.equal(doc.revision, 1);
    assert.ok(doc.blocks.some(entry => entry.id === 'equity-summary-thesis'));
    const before = await readFile(file, 'utf8');
    assert.equal((await run(['new', file, '--id', 'again'])).code, 1);
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal((await run(['new', join(directory, 'x.json')])).code, 2);
    assert.equal((await run(['new', join(directory, 'x.json'), '--id', 'x', '--template', 'crypto'])).code, 2);
    assert.equal((await run(['new', join(directory, 'x.json'), '--id', 'bad id'])).code, 2);
    assert.equal(existsSync(join(directory, 'x.json')), false);
    const human = await run(['new', join(directory, 'plain.json'), '--id', 'plain']);
    assert.match(human.out, /Created .*plain\.json: "Untitled research report" \(0 blocks\)/);

    const listed = await run(['templates', '--json']);
    assert.deepEqual(listed.json().templates.map((entry: { kind: string }) => entry.kind), ['equity', 'macro', 'portfolio', 'strategy', 'arbitrage', 'comparison', 'blank']);
    assert.match((await run(['templates'])).out, /^equity\s+Equity analysis:/m);
  } finally { await cleanup(directory); }
});

test('read commands show structure, search and single blocks, in text and JSON', async () => {
  const { directory, file } = await scratch();
  try {
    await run(['new', file, '--id', 'r1', '--template', 'portfolio', '--subject', 'Core book']);
    const outline = await run(['outline', file]);
    assert.equal(outline.code, 0);
    assert.match(outline.out, /^Core book: portfolio review {2}\(revision 1, \d+ blocks\)/);
    assert.match(outline.out, /portfolio-allocation {2}\[section\] {2}Allocation/);
    const outlineJson = (await run(['outline', file, '--json', '--max-depth', '1'])).json();
    assert.ok(outlineJson.outline.length >= 5);

    const tables = await run(['find', file, '--type', 'table', '--json']);
    assert.equal(tables.json().total, 1);
    const found = tables.json().blocks[0];
    assert.deepEqual(Object.keys(found).sort(), ['id', 'parentId', 'text', 'type', 'version']);
    assert.equal((await run(['find', file, '--type', 'table,metrics', '--json'])).json().total, 2);
    assert.equal((await run(['find', file, '--type', 'table', '--type', 'metrics', '--json'])).json().total, 2);
    assert.ok((await run(['find', file, '--text', 'ALLOCATION', '--json'])).json().total >= 1);
    assert.equal((await run(['find', file, '--parent', 'null', '--json'])).json().total, 6);
    assert.equal((await run(['find', file, '--within', 'portfolio-risk', '--json'])).json().total, 2);
    assert.equal((await run(['find', file, '--ids', 'portfolio-summary,nope', '--json'])).json().total, 1);
    const page = (await run(['find', file, '--limit', '2', '--offset', '1', '--json'])).json();
    assert.deepEqual([page.count, page.truncated], [2, true]);
    assert.equal((await run(['find', file, '--type', 'metrics', '--full', '--json'])).json().blocks[0].content.type, 'metrics');
    const text = await run(['find', file, '--type', 'callout']);
    assert.match(text.out, /^portfolio-allocation-chart {2}callout {2}v1 {2}in portfolio-allocation {2}Chart placeholder/m);
    assert.match(text.out, /4 of 4 block\(s\)\n$/);
    assert.match((await run(['find', file, '--type', 'callout', '--limit', '1'])).out, /1 of 4 block\(s\); more with --offset 1\n$/);
    assert.equal((await run(['find', file, '--type', 'banner'])).code, 2);
    assert.equal((await run(['find', file, '--limit', 'many'])).code, 2);

    const get = await run(['get', file, 'portfolio-allocation-table']);
    assert.match(get.out, /^portfolio-allocation-table {2}table {2}version 1 {2}parent portfolio-allocation/);
    assert.match(get.out, /path: portfolio-allocation > portfolio-allocation-table/);
    assert.equal((await run(['get', file, 'portfolio-allocation-table', '--json'])).json().block.version, 1);
    const missing = await run(['get', file, 'ghost']);
    assert.equal(missing.code, 4);
    assert.match(missing.err, /\[not-found\].*ghost/s);
    assert.match(missing.err, /hint:/);
    assert.equal((await run(['get', file, 'ghost', '--json'])).code, 4);
    assert.equal((await run(['get', file])).code, 2);

    const stats = await run(['stats', file]);
    assert.match(stats.out, /^title: Core book: portfolio review\nrevision: 1\nwords: \d+/);
    assert.ok((await run(['stats', file, '--json'])).json().words > 50);
    assert.deepEqual(await readdir(directory), ['report.json']);
  } finally { await cleanup(directory); }
});

test('guarded edits need <blockId>@<version>, report conflicts with exit 3 and never touch the file on failure', async () => {
  const { directory, file } = await scratch();
  try {
    await run(['new', file, '--id', 'g1', '--template', 'macro', '--history']);
    const target = 'macro-summary-view';
    const updated = await run(['update-text', file, `${target}@1`, '--text', 'Inflation is **cooling**.', '--actor', 'macro-bot:agent', '--json']);
    assert.equal(updated.code, 0, updated.err);
    assert.deepEqual([updated.json().ok, updated.json().changed, updated.json().revision], [true, [target], 2]);
    const doc = await document(file);
    assert.deepEqual(block(doc, target).content, { type: 'paragraph', runs: [{ text: 'Inflation is ' }, { text: 'cooling', bold: true }, { text: '.' }] });
    assert.equal(block(doc, target).version, 2);

    const saved = await readFile(file, 'utf8');
    const stale = await run(['update-text', file, `${target}@1`, '--text', 'stale']);
    assert.equal(stale.code, 3);
    assert.match(stale.err, /\[conflict\]/);
    assert.match(stale.err, /version 2/);
    const bare = await run(['update-text', file, target, '--text', 'x']);
    assert.equal(bare.code, 2);
    assert.match(bare.err, /needs the version you last read.*--unguarded/);
    assert.equal((await run(['update-text', file, `${target}@2`])).code, 2);
    assert.equal((await run(['update-text', file, `${target}@2`, '--text', 'a', '--text-file', 'b'])).code, 2);
    assert.equal((await run(['update-text', file, `ghost@1`, '--text', 'x'])).code, 4);
    assert.equal((await run(['update-text', file, `${target}@2`, '--text', 'x', '--actor', 'no good'])).code, 2);
    assert.equal((await run(['update-text', file, 'macro-calendar-table@1', '--text', 'x'])).code, 2);
    assert.equal((await run(['update-text', file, `${target}@2`, '--text', 'x', '--expect-revision', '1'])).code, 3);
    assert.equal((await run(['update-text', file, `${target}@2`, '--text', 'x', '--bogus'])).code, 2);
    assert.equal(await readFile(file, 'utf8'), saved, 'failed commands leave the exact bytes');

    const preview = await run(['update-text', file, `${target}@2`, '--text', 'preview', '--dry-run']);
    assert.equal(preview.code, 0);
    assert.match(preview.out, /^dry run \(nothing saved\): would reach revision 3/);
    assert.equal(await readFile(file, 'utf8'), saved);

    const unguarded = await run(['update-text', file, target, '--unguarded', '--plain', '--text', '**kept literally**']);
    assert.equal(unguarded.code, 0, unguarded.err);
    assert.match(unguarded.out, /^ok, revision 3: changed 1\.\nblocks: macro-summary-view@3/);
    assert.deepEqual(block(await document(file), target).content, { type: 'paragraph', runs: [{ text: '**kept literally**' }] });
    const piped = await run(['update-text', file, `${target}@3`, '--text-file', '-'], 'From standard input.\n');
    assert.equal(piped.code, 0, piped.err);
    assert.deepEqual(block(await document(file), target).content, { type: 'paragraph', runs: [{ text: 'From standard input.\n' }] });
    assert.equal((await run(['update-text', file, `${target}@4`, '--text', 'x', '--expect-revision', '4'])).code, 0);

    const history = await run(['revisions', file, '--json']);
    assert.equal(history.json().total, 4, 'one log entry per saved edit; dry runs and failures log nothing');
    assert.equal(history.json().revisions[0].number, 5);
    assert.equal(history.json().revisions.at(-1).actor.id, 'macro-bot');
    assert.match((await run(['revisions', file])).out, /^#5 .*cli:system .*edited|^#5 .*changed|^#5 /m);
    assert.deepEqual((await readdir(directory)).sort(), ['report.json', 'report.json.history.jsonl']);
  } finally { await cleanup(directory); }
});

test('without a history log the revisions command explains how to get one', async () => {
  const { directory, file } = await scratch();
  try {
    await run(['init', file, '--id', 'h1']);
    const none = await run(['revisions', file, '--json']);
    assert.equal(none.code, 0);
    assert.deepEqual([none.json().total, none.json().revision], [0, 0]);
    assert.match(none.json().note, /init --history/);
    assert.match((await run(['revisions', file])).out, /No history log/);
    assert.equal(existsSync(`${file}.history.jsonl`), false);
  } finally { await cleanup(directory); }
});

test('insert, import, replace, move and delete work through files, stdin and guards', async () => {
  const { directory, file } = await scratch();
  try {
    await run(['new', file, '--id', 'e1', '--template', 'blank']);
    const inserted = await run(['insert', file, '--markdown', '-', '--json'], '# Findings\n\nInflation cooled in **March**.\n\n- one\n- two');
    assert.equal(inserted.code, 0, inserted.err);
    const ids: string[] = inserted.json().added;
    assert.equal(ids.length, 3);
    await writeFile(join(directory, 'more.md'), 'Appended later.');
    assert.equal((await run(['insert', file, '--markdown', join(directory, 'more.md'), '--first'])).code, 0);
    assert.equal((await document(file)).blocks[0]!.content.type, 'paragraph');
    const blocksFile = join(directory, 'blocks.json');
    await writeFile(blocksFile, JSON.stringify([{ id: 'sec', content: { type: 'section', title: 'Appendix' } }, { id: 'sec-note', parentId: 'sec', content: { type: 'paragraph', runs: [{ text: 'Inside.' }] } }]));
    assert.equal((await run(['insert', file, '--blocks', blocksFile])).code, 0);
    const nested = await run(['insert', file, '--markdown', '-', '--parent', 'sec', '--after', 'sec-note'], 'Nested **text**');
    assert.equal(nested.code, 0, nested.err);
    assert.equal((await document(file)).blocks.at(-1)!.parentId, 'sec');
    assert.equal((await run(['insert', file])).code, 2);
    assert.equal((await run(['insert', file, '--markdown', '-', '--blocks', blocksFile], 'x')).code, 2);
    assert.equal((await run(['insert', file, '--markdown', '-', '--after', 'sec', '--first'], 'x')).code, 2);
    assert.equal((await run(['insert', file, '--blocks', join(directory, 'missing.json')])).code, 2);
    await writeFile(blocksFile, '{not json');
    assert.equal((await run(['insert', file, '--blocks', blocksFile])).code, 2);
    assert.equal((await run(['insert', file, '--markdown', '-'], '   '))?.code, 2);

    const replaced = await run(['replace', file, '--find', 'march', '--replace', 'April', '--json']);
    assert.equal(replaced.code, 0, replaced.err);
    assert.equal(replaced.json().matchedBlocks, 1);
    assert.equal((await run(['replace', file, '--find', 'April', '--replace', 'May', '--case-sensitive', '--first', '--within', 'sec'])).code, 4);
    assert.equal((await run(['replace', file, '--find', 'nothing like this', '--replace', 'x'])).code, 4);
    assert.equal((await run(['replace', file, '--find', 'x'])).code, 2);
    const emptyReplacement = await run(['replace', file, '--find', ' in April', '--replace', '']);
    assert.equal(emptyReplacement.code, 0, emptyReplacement.err);
    const guarded = await run(['replace', file, '--find', 'Inside', '--replace', 'Within', '--block', 'sec-note@1']);
    assert.equal(guarded.code, 0, guarded.err);
    assert.equal((await run(['replace', file, '--find', 'Within', '--replace', 'x', '--block', 'sec-note@1'])).code, 3);

    const doc = await document(file);
    const [first] = ids;
    assert.ok(first);
    const moved = await run(['move', file, `sec-note@${block(doc, 'sec-note').version}`, `${first}@${block(doc, first).version}`, '--to', 'root', '--first']);
    assert.equal(moved.code, 0, moved.err);
    assert.deepEqual((await document(file)).blocks.slice(0, 2).map(entry => entry.id), ['sec-note', first]);
    assert.equal((await run(['move', file, `${first}@99`, '--to', 'root'])).code, 3);
    assert.equal((await run(['move', file, `${first}@1`])).code, 2);
    assert.equal((await run(['move', file, '--to', 'root'])).code, 2);
    const before = await document(file);
    const removed = await run(['delete', file, `sec@${block(before, 'sec').version}`, '--json']);
    assert.equal(removed.code, 0, removed.err);
    assert.equal(removed.json().removed[0], 'sec');
    assert.equal(removed.json().removed.length, before.blocks.filter(entry => entry.id === 'sec' || entry.parentId === 'sec').length);
    assert.ok((await document(file)).retiredBlockIds.includes('sec'));
    assert.equal((await run(['delete', file])).code, 2);
    assert.equal((await run(['delete', file, 'ghost@1'])).code, 4);

    const imported = await run(['import', file, '--markdown', '-', '--mode', 'replace', '--set-title'], '# Fresh start\n\nOnly this.');
    assert.equal(imported.code, 0, imported.err);
    const fresh = await document(file);
    assert.equal(fresh.title, 'Fresh start');
    assert.equal(fresh.blocks.length, 2);
    const unchanged = await readFile(file, 'utf8');
    assert.equal((await run(['import', file, '--markdown', '-', '--mode', 'replace', '--dry-run'], 'Preview'))?.code, 0);
    assert.equal((await run(['import', file, '--markdown', '-', '--mode', 'sideways'], 'x')).code, 2);
    assert.equal((await run(['import', file])).code, 2);
    assert.equal(await readFile(file, 'utf8'), unchanged);
  } finally { await cleanup(directory); }
});

test('chart, cite, title and add-template cover the report-building flow', async () => {
  const { directory, file } = await scratch();
  try {
    await run(['new', file, '--id', 'b1', '--template', 'blank']);
    const spec = join(directory, 'chart.json');
    await writeFile(spec, JSON.stringify({ kind: 'line', title: 'Rebased', labels: ['a', 'b', 'c'], series: [{ name: 'X', values: [100, 101, 103] }], source: 'Sample' }));
    const chart = await run(['chart', file, '--spec', spec, '--json']);
    assert.equal(chart.code, 0, chart.err);
    assert.equal(chart.json().blockId, 'chart-1');
    assert.equal((await run(['chart', file, '--spec', '-', '--id', 'second', '--first'], JSON.stringify({ kind: 'bar', title: 'B', labels: ['a'], series: [{ name: 's', values: [1] }] }))).code, 0);
    assert.equal((await document(file)).blocks[0]!.id, 'second');
    const bad = await run(['chart', file, '--spec', '-'], JSON.stringify({ kind: 'line', title: 'Bad', labels: ['a', 'b'], series: [{ name: 's', values: [1] }] }));
    assert.equal(bad.code, 2);
    assert.match(bad.err, /input\.spec\.series\[0\]\.values/);
    assert.match(bad.err, /hint:.*exactly 2 values/);
    assert.equal((await run(['chart', file])).code, 2);

    const cited = await run(['cite', file, '--title', 'Bureau', '--url', 'https://example.com/cpi', '--block', 'blank-intro@1', '--marker', '--id', 'bureau', '--json']);
    assert.equal(cited.code, 0, cited.err);
    assert.equal(cited.json().citationId, 'bureau');
    assert.equal((await document(file)).citations[0]!.id, 'bureau');
    assert.equal((await run(['cite', file, '--title', 'x'])).code, 2);
    assert.equal((await run(['cite', file, '--title', 'x', '--url', 'javascript:alert(1)'])).code, 2);
    assert.equal((await run(['cite', file, '--title', 'x', '--url', 'https://example.com/x', '--id', 'bureau'])).code, 2);

    assert.equal((await run(['title', file, 'A better title'])).code, 0);
    assert.equal((await document(file)).title, 'A better title');
    assert.equal((await run(['title', file])).code, 2);
    const template = await run(['add-template', file, 'strategy', '--subject', 'Momentum', '--set-title', '--json']);
    assert.equal(template.code, 0, template.err);
    assert.equal(template.json().idPrefix, 'strategy');
    assert.equal((await document(file)).title, 'Momentum: strategy backtest');
    assert.equal((await run(['add-template', file, 'crypto'])).code, 2);
    assert.equal((await run(['add-template', file, 'strategy', '--id-prefix', 'strategy'])).code, 2);
  } finally { await cleanup(directory); }
});

test('export writes Markdown, HTML or text to stdout or a file; stats and validate check documents', async () => {
  const { directory, file } = await scratch();
  try {
    await run(['new', file, '--id', 'x1', '--template', 'comparison', '--subject', 'AAA vs BBB']);
    const markdown = await run(['export', file]);
    assert.equal(markdown.code, 0);
    assert.match(markdown.out, /^# AAA vs BBB: asset comparison/);
    assert.equal(markdown.out, (await run(['export', file, '--format', 'markdown'])).out);
    assert.match((await run(['export', file, '--format', 'html', '--standalone'])).out, /^<!doctype html>/);
    assert.match((await run(['export', file, '--format', 'html'])).out, /^<article/);
    assert.match((await run(['export', file, '--format', 'txt'])).out, /^AAA vs BBB: asset comparison/);
    assert.match((await run(['export', file, '--block', 'comparison-metrics'])).out, /Metric comparison/);
    assert.equal((await run(['export', file, '--format', 'docx'])).code, 2);
    assert.equal((await run(['export', file, '--block', 'ghost'])).code, 4);
    const asJson = await run(['export', file, '--json']);
    assert.equal(asJson.json().format, 'markdown');
    const out = join(directory, 'report.md');
    const written = await run(['export', file, '--out', out]);
    assert.equal(written.code, 0);
    assert.match(written.out, /^Wrote \d+ characters to /);
    assert.equal(await readFile(out, 'utf8'), markdown.out);
    assert.equal((await run(['export', file, '--out', file])).code, 2);

    const valid = await run(['validate', file]);
    assert.match(valid.out, /^valid: \d+ blocks, 0 citations, revision 1/);
    assert.equal((await run(['validate', file, '--json'])).json().valid, true);
    const transaction = join(directory, 'tx.json');
    await writeFile(transaction, JSON.stringify({ id: 'v1', actor: { id: 'a', kind: 'agent' }, baseRevision: 1, operations: [{ type: 'setTitle', title: 'Checked' }] }));
    const checked = await run(['validate', file, '--transaction', transaction, '--json']);
    assert.deepEqual([checked.code, checked.json().transaction, checked.json().revisionAfter], [0, true, 2]);
    assert.equal((await document(file)).title, 'AAA vs BBB: asset comparison', 'validate changes nothing');
    await writeFile(transaction, JSON.stringify({ id: 'v1', actor: { id: 'a', kind: 'agent' }, baseRevision: 0, operations: [{ type: 'setTitle', title: 'Checked' }] }));
    assert.equal((await run(['validate', file, '--transaction', transaction])).code, 3);
    await writeFile(join(directory, 'broken.json'), '{"schemaVersion":1}');
    const broken = await run(['validate', join(directory, 'broken.json')]);
    assert.equal(broken.code, 2);
    assert.match(broken.err, /^error: the document is not valid\n- \[validation\]/);
    assert.equal((await run(['validate', join(directory, 'broken.json'), '--json'])).errJson().ok, false);
    assert.equal((await run(['outline', join(directory, 'absent.json')])).code, 2);
  } finally { await cleanup(directory); }
});

test('tools lists the actions and call runs any of them', async () => {
  const { directory, file } = await scratch();
  try {
    await run(['new', file, '--id', 't1', '--template', 'blank']);
    const tools = await run(['tools', '--json']);
    assert.ok(tools.json().actions.length >= 21);
    assert.match((await run(['tools'])).out, /^get_outline\s+read\s+/m);
    assert.match((await run(['tools'])).out, /^delete_blocks\s+write!/m);
    const one = await run(['tools', 'update_block_text']);
    assert.equal(JSON.parse(one.out).inputSchema.required.includes('expectedVersion'), true);
    assert.equal((await run(['tools', 'nope'])).code, 2);

    const outline = await run(['call', file, 'get_outline']);
    assert.equal(outline.code, 0);
    assert.equal(outline.json().ok, true);
    const inline = await run(['call', file, 'set_title', '--input', '{"title":"Via call"}', '--actor', 'caller:human']);
    assert.equal(inline.json().revision, 2);
    assert.equal((await document(file)).title, 'Via call');
    const piped = await run(['call', file, 'insert_blocks', '--input', '-'], JSON.stringify({ markdown: 'From call.' }));
    assert.equal(piped.json().added.length, 1);
    const failure = await run(['call', file, 'update_block_text', '--input', '{"blockId":"ghost","expectedVersion":1,"text":"x"}']);
    assert.equal(failure.code, 4);
    assert.equal(failure.errJson().issues[0].code, 'not-found');
    assert.equal((await run(['call', file, 'nope'])).code, 2);
    assert.equal((await run(['call', file, 'set_title', '--input', '[1]'])).code, 2);
    assert.equal((await run(['call', file, 'set_title', '--input', '{oops'])).code, 2);
    const preview = await run(['call', file, 'set_title', '--input', '{"title":"Preview"}', '--dry-run']);
    assert.equal(preview.json().dryRun, true);
    assert.equal((await document(file)).title, 'Via call');
  } finally { await cleanup(directory); }
});

test('help is generated from the command table and unknown input exits with 2', async () => {
  assert.match(CLI_HELP, /super-editor init/);
  for (const command of COMMANDS) assert.ok(CLI_HELP.includes(`  ${command.name}`), command.name);
  for (const name of ['outline', 'find', 'insert', 'update-text', 'replace', 'move', 'delete', 'chart', 'cite', 'export', 'import', 'stats', 'revisions', 'validate', 'new', 'templates']) assert.ok(COMMANDS.some(command => command.name === name), name);
  assert.match(CLI_HELP, /Exit codes: 0 success, 1 I\/O failure, 2 invalid input, 3 revision or version conflict, 4 block or citation not found/);
  const help = await run(['help']);
  assert.equal(help.out, CLI_HELP);
  const detail = await run(['help', 'update-text']);
  assert.equal(detail.code, 0);
  assert.match(detail.out, /^super-editor update-text <document\.json> <blockId>@<version>/);
  assert.match(detail.out, /--unguarded/);
  assert.equal((await run(['update-text', '--help'])).out, detail.out);
  assert.equal((await run(['help', 'nope'])).code, 2);
  const unknown = await run(['frobnicate']);
  assert.equal(unknown.code, 2);
  assert.deepEqual(unknown.errJson(), { ok: false, error: 'Unknown command. Run super-editor help.' });
  const bareFlag = await run(['outline']);
  assert.equal(bareFlag.code, 2);
  assert.match(bareFlag.err, /document file path is required/);
  const typo = await run(['find', 'x.json', '--tpye', 'chart']);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /Run: super-editor help find/);
});

test('a lock held by another writer blocks every editing command and is never removed', async () => {
  const { directory, file } = await scratch();
  try {
    await run(['new', file, '--id', 'l1', '--template', 'blank']);
    const before = await readFile(file, 'utf8');
    await writeFile(`${file}.lock`, 'someone else');
    for (const args of [['title', file, 'x'], ['insert', file, '--markdown', '-'], ['call', file, 'set_title', '--input', '{"title":"x"}']]) {
      const result = await run(args, 'text');
      assert.equal(result.code, 1, args.join(' '));
      assert.match(result.err, /locked/);
    }
    assert.equal((await run(['outline', file])).code, 0, 'reads do not need the lock');
    assert.equal((await run(['title', file, 'x', '--dry-run'])).code, 0, 'a dry run does not need the lock');
    assert.equal(await readFile(file, 'utf8'), before);
    assert.equal(await readFile(`${file}.lock`, 'utf8'), 'someone else');
  } finally { await cleanup(directory); }
});

test('the built binary also starts when launched through a symlink, the way a package manager links it', async (t) => {
  const built = resolve('packages/cli/dist/cli.js');
  if (!existsSync(built)) { t.skip('run npm run build first'); return; }
  const { directory } = await scratch();
  try {
    const link = join(directory, 'super-editor');
    try { await symlink(built, link); }
    catch { t.skip('symlinks are not permitted here'); return; }
    const { stdout } = await execFileAsync(process.execPath, [link, 'help']);
    assert.match(stdout, /^Super Editor: read and edit a research report/);
  } finally { await cleanup(directory); }
});
