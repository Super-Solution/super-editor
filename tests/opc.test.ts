import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { RELATIONSHIP_TYPES, ZipError, createPackage, crc32, escapeXmlAttribute, escapeXmlText, pathProblem, readZip, writeZip, xmlText } from '../packages/formats/opc/src/index.js';

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);
const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const failure = async (action: Promise<unknown>, code: ZipError['code']): Promise<ZipError> => {
  const error = await action.then(() => undefined, (caught: unknown) => caught);
  assert.ok(error instanceof ZipError, `expected a ZipError, got ${String(error)}`); assert.equal(error.code, code, error.message); return error;
};
const hasTool = (name: string): boolean => spawnSync(name, ['--help'], { stdio: 'ignore' }).error === undefined;

test('crc32 matches the published check value', () => {
  assert.equal(crc32(bytes('123456789')), 0xcbf43926); assert.equal(crc32(new Uint8Array()), 0);
});

test('writeZip then readZip returns the same files, stored and deflated, with names in any script', async () => {
  const big = 'The quick brown fox jumps over the lazy dog. '.repeat(500);
  const entries = [{ path: 'a.txt', data: 'hello' }, { path: 'dir/big.txt', data: big }, { path: 'dir/文件 名.txt', data: '內容 😀' }, { path: 'empty', data: '' }, { path: 'binary.bin', data: Uint8Array.from({ length: 300 }, (_, index) => (index * 7) % 256) }];
  const zip = await writeZip(entries), stored = await writeZip(entries, { compress: false });
  assert.ok(zip.length < stored.length, 'deflate made it smaller');
  for (const archive of [zip, stored]) {
    const files = await readZip(archive);
    assert.deepEqual([...files.keys()], entries.map(entry => entry.path));
    assert.equal(text(files.get('dir/big.txt')), big); assert.equal(text(files.get('dir/文件 名.txt')), '內容 😀'); assert.equal(files.get('empty')?.length, 0);
    assert.deepEqual([...files.get('binary.bin')!], [...(entries[4]!.data as Uint8Array)]);
  }
  assert.deepEqual([...await writeZip(entries)], [...zip], 'the same input gives the same bytes');
  assert.notDeepEqual([...await writeZip(entries, { modified: '2026-11-24T18:44:06Z' })], [...zip], 'the modification time is stored');
});

test('writeZip refuses what it cannot write correctly', async () => {
  await failure(writeZip([{ path: '../evil', data: 'x' }]), 'unsafe-path');
  await failure(writeZip([{ path: '/abs', data: 'x' }]), 'unsafe-path');
  await failure(writeZip([{ path: 'a\\b', data: 'x' }]), 'unsafe-path');
  await failure(writeZip([{ path: 'dir/', data: 'x' }]), 'unsafe-path');
  await failure(writeZip([{ path: 'A.txt', data: 'x' }, { path: 'a.TXT', data: 'y' }]), 'duplicate');
  await failure(writeZip([{ path: 'a', data: 'x' }], { modified: '1970-01-01' }), 'invalid-input');
  assert.equal(pathProblem('word/document.xml'), undefined); assert.match(pathProblem('')!, /1 to 512/); assert.match(pathProblem('a//b')!, /empty/);
});

test('readZip refuses damaged, unsafe and oversized archives with a reason', async () => {
  const good = await writeZip([{ path: 'a.txt', data: 'hello world, hello world, hello world, hello world, hello world, hello world, hello' }], { compress: false });
  await failure(readZip(new Uint8Array(10)), 'not-a-zip');
  await failure(readZip(bytes('this is not a zip file at all, just text, long enough to be searched')), 'not-a-zip');
  await failure(readZip(good.subarray(0, good.length - 30)), 'not-a-zip');
  const flipped = good.slice(); flipped[40] = flipped[40]! ^ 0xff;
  await failure(readZip(flipped), 'corrupt');
  const patched = (change: (view: DataView, bytes: Uint8Array) => void): Uint8Array => { const copy = good.slice(); change(new DataView(copy.buffer), copy); return copy; };
  const central = good.length - 22 - (46 + 5);
  await failure(readZip(patched(view => view.setUint16(central + 8, 1, true))), 'unsupported');                        // encrypted
  await failure(readZip(patched(view => view.setUint16(central + 10, 12, true))), 'unsupported');                      // bzip2
  await failure(readZip(patched(view => view.setUint32(central + 24, 0xffffffff, true))), 'unsupported');              // ZIP64 marker
  await failure(readZip(patched((_, copy) => { copy.set(bytes('../ab'), central + 46); })), 'unsafe-path');
  await failure(readZip(patched((_, copy) => { copy.set(bytes('/abcd'), central + 46); })), 'unsafe-path');
  await failure(readZip(patched((_, copy) => { copy.set([0xff, 0xfe], central + 46); })), 'corrupt');
  await failure(readZip(good, { maxEntryBytes: 10 }), 'too-large');
  await failure(readZip(good, { maxTotalBytes: 10 }), 'too-large');
  await failure(readZip(good, { maxEntries: 0 }), 'too-large');
  const two = await writeZip([{ path: 'aa', data: 'x' }, { path: 'bb', data: 'y' }], { compress: false });
  const duplicate = two.slice(); const second = duplicate.length - 22 - (46 + 2); duplicate.set(bytes('AA'), second + 46);
  await failure(readZip(duplicate), 'duplicate');
});

test('readZip stops an entry that inflates beyond what it declared (a zip bomb)', async () => {
  const bomb = await writeZip([{ path: 'bomb.txt', data: 'A'.repeat(2_000_000) }]);
  assert.ok(bomb.length < 5_000, 'a highly compressible entry');
  assert.equal((await readZip(bomb)).get('bomb.txt')?.length, 2_000_000);
  await failure(readZip(bomb, { maxEntryBytes: 1_000_000 }), 'too-large');
  const lying = bomb.slice(); const central = lying.length - 22 - (46 + 8);
  new DataView(lying.buffer).setUint32(central + 24, 100, true);                                                      // declare 100 bytes
  await failure(readZip(lying), 'too-large');
});

test('archives written here open in independent readers, and archives from an independent writer are read here', { skip: !hasTool('unzip') && 'unzip is not installed' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'opc-'));
  const archive = join(directory, 'out.zip'), body = 'interop '.repeat(300);
  writeFileSync(archive, await writeZip([{ path: 'x/y.txt', data: body }, { path: 'z.txt', data: '你好' }, { path: 'plain.bin', data: 'abc' }]));
  assert.match(execFileSync('unzip', ['-tq', archive], { encoding: 'utf8' }), /No errors detected/);
  assert.equal(execFileSync('unzip', ['-p', archive, 'x/y.txt'], { encoding: 'utf8' }), body);
  assert.equal(execFileSync('python3', ['-I', '-c', 'import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(z.read("z.txt").decode("utf-8"))', archive], { encoding: 'utf8' }).trim(), '你好');
  if (hasTool('zip')) {
    writeFileSync(join(directory, 'one.txt'), body); writeFileSync(join(directory, 'two.txt'), 'two');
    const made = join(directory, 'made.zip');
    execFileSync('zip', ['-q', '-9', made, 'one.txt', 'two.txt'], { cwd: directory });
    const files = await readZip(new Uint8Array(readFileSync(made)));
    assert.equal(text(files.get('one.txt')), body); assert.equal(text(files.get('two.txt')), 'two');
  }
});

test('xmlText replaces what XML 1.0 cannot hold and counts it; escapes cover text and attributes', () => {
  assert.deepEqual(xmlText('plain \t\n\r text 😀 你好'), { text: 'plain \t\n\r text 😀 你好', replaced: 0 });
  assert.deepEqual(xmlText('a\u0000b\u0001c￾￿d'), { text: 'a�b�c��d', replaced: 4 });
  assert.deepEqual(xmlText('lone \ud800 and \udc00 halves'), { text: 'lone � and � halves', replaced: 2 });
  assert.equal(escapeXmlText('a & b < c > d "q"'), 'a &amp; b &lt; c &gt; d "q"');
  assert.equal(escapeXmlAttribute('a "q" & <b>\n\t'), 'a &quot;q&quot; &amp; &lt;b&gt;&#10;&#9;');
  for (const value of ['a < b & c', '"\'<>&', 'line\nbreak']) {
    const { text: safe } = xmlText(value), dom = new JSDOM(`<r a="${escapeXmlAttribute(safe)}">${escapeXmlText(safe)}</r>`, { contentType: 'application/xml' }), root = dom.window.document.documentElement;
    assert.equal(root.textContent, safe); assert.equal(root.getAttribute('a'), safe);
  }
});

test('createPackage writes content types, relationships with relative targets, and refuses an inconsistent package', async () => {
  const pkg = createPackage();
  pkg.addPart('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', '<doc/>');
  pkg.addPart('word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml', '<styles/>');
  pkg.addPart('word/parts/deep.xml', 'application/xml', '<deep/>');
  pkg.addPart('docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml', '<core/>');
  assert.equal(pkg.addRelationship(null, { type: RELATIONSHIP_TYPES.officeDocument, part: 'word/document.xml' }), 'rId1');
  assert.equal(pkg.addRelationship(null, { type: RELATIONSHIP_TYPES.coreProperties, part: 'docProps/core.xml' }), 'rId2');
  assert.equal(pkg.addRelationship('word/document.xml', { type: 'http://example/styles', part: 'word/styles.xml' }), 'rId1');
  assert.equal(pkg.addRelationship('word/document.xml', { type: RELATIONSHIP_TYPES.hyperlink, url: 'https://example.com/?a=1&b="2"' }), 'rId2');
  assert.equal(pkg.addRelationship('word/parts/deep.xml', { type: 'http://example/up', part: 'word/styles.xml' }), 'rId1');
  assert.equal(pkg.addRelationship('docProps/core.xml', { type: 'http://example/other', part: 'word/document.xml' }), 'rId1');
  const files = await readZip(await pkg.toBytes());
  assert.deepEqual([...files.keys()], ['[Content_Types].xml', '_rels/.rels', 'word/document.xml', 'word/styles.xml', 'word/parts/deep.xml', 'docProps/core.xml', 'word/_rels/document.xml.rels', 'word/parts/_rels/deep.xml.rels', 'docProps/_rels/core.xml.rels']);
  const parse = (name: string) => { const dom = new JSDOM(text(files.get(name)), { contentType: 'application/xml' }); assert.equal(dom.window.document.querySelector('parsererror'), null, name); return dom.window.document; };
  const types = parse('[Content_Types].xml'), overrides = [...types.getElementsByTagName('Override')].map(node => [node.getAttribute('PartName'), node.getAttribute('ContentType')]);
  assert.deepEqual(overrides[0], ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml']);
  assert.equal(types.getElementsByTagName('Default')[0]?.getAttribute('Extension'), 'rels');
  const rels = (name: string) => [...parse(name).getElementsByTagName('Relationship')].map(node => [node.getAttribute('Id'), node.getAttribute('Target'), node.getAttribute('TargetMode')]);
  assert.deepEqual(rels('_rels/.rels'), [['rId1', 'word/document.xml', null], ['rId2', 'docProps/core.xml', null]]);
  assert.deepEqual(rels('word/_rels/document.xml.rels'), [['rId1', 'styles.xml', null], ['rId2', 'https://example.com/?a=1&b="2"', 'External']]);
  assert.deepEqual(rels('word/parts/_rels/deep.xml.rels'), [['rId1', '../styles.xml', null]]);
  assert.deepEqual(rels('docProps/_rels/core.xml.rels'), [['rId1', '../word/document.xml', null]]);

  const throws = (action: () => unknown, code: ZipError['code']) => assert.throws(action, (error: unknown) => error instanceof ZipError && error.code === code);
  throws(() => pkg.addPart('word/document.xml', 'application/xml', ''), 'duplicate');
  throws(() => pkg.addPart('WORD/Document.xml', 'application/xml', ''), 'duplicate');
  throws(() => pkg.addPart('[Content_Types].xml', 'application/xml', ''), 'invalid-input');
  throws(() => pkg.addPart('word/_rels/x.rels', 'application/xml', ''), 'invalid-input');
  throws(() => pkg.addPart('x.xml', 'not a type', ''), 'invalid-input');
  throws(() => pkg.addPart('../x.xml', 'application/xml', ''), 'unsafe-path');
  throws(() => pkg.addRelationship('missing.xml', { type: 't', part: 'word/styles.xml' }), 'invalid-input');
  const dangling = createPackage(); dangling.addPart('a.xml', 'application/xml', '<a/>'); dangling.addRelationship('a.xml', { type: 't', part: 'b.xml' });
  await failure(dangling.toBytes(), 'invalid-input');
});
