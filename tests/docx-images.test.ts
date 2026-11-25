import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { b, createDocument, createEditor, type ExportResult, type FormatWarning, type ResearchDocument } from '../packages/core/src/index.js';
import { IMAGE_LIMITS, exportDocx, exportDocxRedline, sniffImage, type DocxImageRequest, type ResolveImage } from '../packages/formats/docx/src/index.js';
import { readZip } from '../packages/formats/opc/src/index.js';

const now = () => '2026-10-05T12:30:45.678Z';
const decode = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);
const base64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'base64'));
/** A real 1x1 PNG and GIF, so an independent reader can open them. */
const PNG = base64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==');
const GIF = base64('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
/** Only the header of a PNG of the given size: enough for the exporter, which reads the size and never decodes. */
function pngOf(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33), view = new DataView(out.buffer);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); view.setUint32(8, 13); out.set([0x49, 0x48, 0x44, 0x52], 12); view.setUint32(16, width); view.setUint32(20, height);
  return out;
}
/** A JPEG that is a header and a start-of-frame segment. */
function jpegOf(width: number, height: number): Uint8Array {
  const out = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]);
  const view = new DataView(out.buffer); view.setUint16(25, height); view.setUint16(27, width);
  return out;
}
function documentWith(blocks: ReturnType<typeof b.paragraph>[]): ResearchDocument {
  const editor = createEditor(createDocument({ id: 'doc', title: 'Doc' }, { now }), { now });
  const result = editor.apply({ id: 'seed', actor: { id: 'test', kind: 'system' }, baseRevision: 0, operations: Array.from({ length: Math.ceil(blocks.length / 500) }, (_, chunk) => ({ type: 'insertBlocks' as const, blocks: blocks.slice(chunk * 500, chunk * 500 + 500) })) });
  assert.equal(result.ok, true, JSON.stringify(result));
  return editor.getSnapshot();
}
const built = async (document: ResearchDocument, resolveImage?: ResolveImage) => {
  const result = await exportDocx(document, resolveImage ? { resolveImage } : undefined);
  assert.equal(result.ok, true, JSON.stringify(result));
  const ok = result as Extract<ExportResult, { ok: true }>, files = await readZip(ok.data as Uint8Array);
  const xml = (name: string): Document => { const dom = new JSDOM(decode(files.get(name)), { contentType: 'application/xml' }); assert.equal(dom.window.document.querySelector('parsererror'), null, name); return dom.window.document; };
  return { files, data: ok.data as Uint8Array, warnings: ok.warnings, xml };
};
const media = (files: Map<string, Uint8Array>): string[] => [...files.keys()].filter(name => name.startsWith('word/media/')).sort();
const warning = (warnings: FormatWarning[], code: string): FormatWarning | undefined => warnings.find(entry => entry.code === code);

test('sniffImage reads the type and the size from the header and refuses everything else with a reason', () => {
  assert.deepEqual(sniffImage(PNG), { mime: 'image/png', ext: 'png', widthPx: 1, heightPx: 1 });
  assert.deepEqual(sniffImage(GIF), { mime: 'image/gif', ext: 'gif', widthPx: 1, heightPx: 1 });
  assert.deepEqual(sniffImage(jpegOf(640, 480)), { mime: 'image/jpeg', ext: 'jpg', widthPx: 640, heightPx: 480 });
  assert.deepEqual(sniffImage(pngOf(IMAGE_LIMITS.pixels, 2)), { mime: 'image/png', ext: 'png', widthPx: IMAGE_LIMITS.pixels, heightPx: 2 });
  assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')), 'unsupported-type', 'SVG can run script and is not embedded');
  assert.equal(sniffImage(new Uint8Array(0)), 'unsupported-type');
  assert.equal(sniffImage(PNG.slice(0, 20)), 'unsupported-type', 'a truncated header is not a PNG');
  assert.equal(sniffImage(pngOf(0, 5)), 'unreadable');
  assert.equal(sniffImage(pngOf(IMAGE_LIMITS.pixels + 1, 5)), 'unreadable', 'a picture of a billion pixels is refused before it reaches Word');
  assert.equal(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0])), 'unreadable', 'a JPEG with no frame header has no size');
});

test('a resolved image is embedded: media part, relationship, content type, drawing with alt text, scaled to the page', async () => {
  const document = documentWith([b.image('wide', 'https://example.com/wide.png', 'A wide picture', { caption: 'Figure 1' }), b.image('gif', 'https://example.com/a.gif', 'An animated "one" & more'), b.image('jpg', 'https://example.com/c.jpg', 'Photo')]);
  const asked: DocxImageRequest[] = [];
  const { files, xml, warnings } = await built(document, request => { asked.push(request); return request.url.endsWith('.png') ? pngOf(2000, 1000) : request.url.endsWith('.gif') ? GIF : jpegOf(96, 48); });
  assert.deepEqual(asked.map(request => [request.url, request.blockId]), [['https://example.com/wide.png', 'wide'], ['https://example.com/a.gif', 'gif'], ['https://example.com/c.jpg', 'jpg']]);
  assert.deepEqual(media(files), ['word/media/image1.png', 'word/media/image2.gif', 'word/media/image3.jpg']);
  assert.deepEqual(files.get('word/media/image2.gif'), GIF, 'the bytes are the resolver\'s, unchanged');
  const types = decode(files.get('[Content_Types].xml'));
  for (const [path, mime] of [['image1.png', 'image/png'], ['image2.gif', 'image/gif'], ['image3.jpg', 'image/jpeg']]) assert.ok(types.includes(`PartName="/word/media/${path}" ContentType="${mime}"`), path);
  const rels = [...xml('word/_rels/document.xml.rels').getElementsByTagName('Relationship')];
  const images = rels.filter(rel => rel.getAttribute('Type')!.endsWith('/image'));
  assert.deepEqual(images.map(rel => [rel.getAttribute('Id'), rel.getAttribute('Target')]), [['rId4', 'media/image1.png'], ['rId5', 'media/image2.gif'], ['rId6', 'media/image3.jpg']]);
  const body = xml('word/document.xml'), blips = [...body.getElementsByTagName('a:blip')];
  assert.deepEqual(blips.map(blip => blip.getAttribute('r:embed')), ['rId4', 'rId5', 'rId6']);
  const extents = [...body.getElementsByTagName('wp:extent')].map(node => [Number(node.getAttribute('cx')), Number(node.getAttribute('cy'))]);
  const textWidthEmu = (11906 - 2 * Math.round(25.4 * 56.6929)) * 635;
  assert.equal(extents[0]![0], textWidthEmu, 'a picture wider than the text area is scaled to the text width');
  assert.equal(extents[0]![0]! / extents[0]![1]!, 2, 'the aspect ratio is kept');
  assert.deepEqual(extents[2], [96 * 9525, 48 * 9525], 'a small picture is never enlarged');
  const descriptions = [...body.getElementsByTagName('wp:docPr')].map(node => node.getAttribute('descr'));
  assert.deepEqual(descriptions, ['A wide picture', 'An animated "one" & more', 'Photo']);
  assert.deepEqual([...body.getElementsByTagName('wp:docPr')].map(node => node.getAttribute('id')), ['1', '2', '3'], 'drawing ids are unique');
  const text = body.documentElement.textContent!;
  assert.ok(!text.includes('[Image:'), 'an embedded picture is not also written as a label');
  assert.ok(text.includes('Figure 1'), 'the caption stays');
  assert.equal(warning(warnings, 'feature-degraded')?.feature === 'image', false, 'the general image warning is replaced by the precise one');
  assert.equal(warning(warnings, 'image-not-embedded'), undefined);
});

test('hyperlink ids follow the picture ids and the package stays valid', async () => {
  const document = documentWith([b.paragraph('p', [{ text: 'See', href: 'https://example.com/page' }]), b.image('i', 'https://example.com/x.png', 'x'), b.image('broken', 'https://example.com/y.png', 'y')]);
  const { xml } = await built(document, request => request.url.endsWith('x.png') ? PNG : null);
  const rels = [...xml('word/_rels/document.xml.rels').getElementsByTagName('Relationship')].map(rel => [rel.getAttribute('Id'), rel.getAttribute('Type')!.split('/').pop(), rel.getAttribute('Target')]);
  const link = rels.find(rel => rel[1] === 'hyperlink' && rel[2] === 'https://example.com/page')!;
  assert.equal(link[0], 'rId5', 'styles, numbering, settings, then the picture, then the first link');
  const body = xml('word/document.xml');
  assert.equal(body.getElementsByTagName('w:hyperlink')[0]!.getAttribute('r:id'), 'rId5');
  assert.ok(body.documentElement.textContent!.includes('[Image: y]'), 'the image the resolver had no bytes for is still a labelled link');
});

test('the same address is asked for once and embedded once; the output does not depend on how fast answers arrive', async () => {
  const document = documentWith([b.image('a', 'https://example.com/1.png', 'one'), b.image('b', 'https://example.com/2.png', 'two'), b.image('c', 'https://example.com/1.png', 'one again'), b.image('d', 'https://example.com/3.png', 'three')]);
  const calls: string[] = [];
  const quick = await built(document, request => { calls.push(request.url); return pngOf(10, 10); });
  assert.deepEqual(calls, ['https://example.com/1.png', 'https://example.com/2.png', 'https://example.com/3.png']);
  assert.equal(media(quick.files).length, 3);
  assert.equal([...quick.xml('word/document.xml').getElementsByTagName('a:blip')].filter(blip => blip.getAttribute('r:embed') === 'rId4').length, 2, 'two blocks share one part');
  const slow = await built(document, async request => { await new Promise(resolve => setTimeout(resolve, request.url.includes('1.png') ? 30 : 1)); return pngOf(10, 10); });
  assert.deepEqual(slow.data, quick.data, 'same bytes whatever the order the resolver answered in');
  assert.deepEqual((await built(document, () => pngOf(10, 10))).data, quick.data, 'deterministic');
});

test('an image that cannot be embedded stays a link, and one warning says how many, why and which blocks', async () => {
  const document = documentWith([
    b.image('ok', 'https://example.com/ok.png', 'ok'), b.image('none', 'https://example.com/none.png', 'none'), b.image('throws', 'https://example.com/throws.png', 'throws'),
    b.image('svg', 'https://example.com/a.svg', 'svg'), b.image('junk', 'https://example.com/junk.png', 'junk'), b.image('huge', 'https://example.com/huge.png', 'huge'),
  ]);
  const { warnings, xml, files } = await built(document, request => {
    switch (request.blockId) {
      case 'ok': return PNG;
      case 'none': return undefined;
      case 'throws': throw new Error('connection refused to http://10.0.0.1/secret');
      case 'svg': return new TextEncoder().encode('<svg/>');
      case 'junk': return pngOf(0, 5);
      default: return new Uint8Array(IMAGE_LIMITS.perImageBytes + 1);
    }
  });
  assert.equal(media(files).length, 1);
  const stayed = warning(warnings, 'image-not-embedded')!;
  assert.equal(stayed.count, 5);
  assert.deepEqual(stayed.blockIds, ['none', 'throws', 'svg', 'junk', 'huge']);
  for (const phrase of ['1 the resolver returned nothing', '1 the resolver failed', '1 not a PNG, JPEG or GIF', '1 unreadable image data', '1 over the size limit']) assert.ok(stayed.message.includes(phrase), `${phrase} in "${stayed.message}"`);
  assert.ok(!JSON.stringify(stayed).includes('10.0.0.1'), 'what a resolver threw is not copied into the report');
  assert.ok(stayed.hint!.includes('resolveImage'));
  const text = xml('word/document.xml').documentElement.textContent!;
  for (const alt of ['none', 'throws', 'svg', 'junk', 'huge']) assert.ok(text.includes(`[Image: ${alt}]`), alt);
});

test('limits: pictures past the count are links, and the total is counted in document order', async () => {
  const many = Array.from({ length: IMAGE_LIMITS.images + 2 }, (_, index) => b.image(`i${index}`, `https://example.com/${index}.png`, `i${index}`));
  const document = documentWith(many);
  const { files, warnings } = await built(document, () => pngOf(2, 2));
  assert.equal(media(files).length, IMAGE_LIMITS.images);
  const stayed = warning(warnings, 'image-not-embedded')!;
  assert.equal(stayed.count, 2);
  assert.ok(stayed.message.includes('over the limit on how many pictures'));
});

test('a resolver is a function or nothing; a redline refuses it instead of ignoring it', async () => {
  const document = documentWith([b.paragraph('p', 'x')]);
  const bad = await exportDocx(document, { resolveImage: 'https://example.com' } as never);
  assert.equal(bad.ok, false);
  assert.equal((bad as Extract<ExportResult, { ok: false }>).issues[0]!.path, 'options.resolveImage');
  assert.ok((bad as Extract<ExportResult, { ok: false }>).issues[0]!.hint);
  assert.equal((await exportDocx(document, { resolveImage: undefined } as never)).ok, true);
  const redline = await exportDocxRedline({ before: document, after: document }, { resolveImage: () => PNG } as never);
  assert.equal(redline.ok, false);
  assert.equal((redline as Extract<ExportResult, { ok: false }>).issues[0]!.path, 'options.resolveImage');
});

test('without a resolver nothing changes: no media, the label and the link, and the existing warning', async () => {
  const document = documentWith([b.image('i', 'https://example.com/x.png', 'x')]);
  const { files, warnings, xml } = await built(document);
  assert.equal(media(files).length, 0);
  assert.ok(xml('word/document.xml').documentElement.textContent!.includes('[Image: x]'));
  assert.deepEqual(warnings.map(entry => `${entry.code}:${entry.feature}`), ['feature-degraded:image']);
});

const has = (command: string, args: string[]): boolean => spawnSync(command, args, { stdio: 'ignore', timeout: 20_000 }).status === 0;
test('python-docx, an independent reader, finds the pictures and their alt text', { skip: !has('python3', ['-I', '-c', 'import docx']) && 'python-docx is not installed' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'docx-img-')), file = join(directory, 'pictures.docx');
  const document = documentWith([b.paragraph('p', 'Before'), b.image('a', 'https://example.com/a.png', 'First picture'), b.image('g', 'https://example.com/g.gif', 'Second picture')]);
  writeFileSync(file, (await built(document, request => request.url.endsWith('.png') ? PNG : GIF)).data);
  const script = 'import docx, json, sys\nd = docx.Document(sys.argv[1])\nprint(json.dumps({"shapes": len(d.inline_shapes), "parts": sorted(r.target_part.partname for r in d.part.rels.values() if "image" in r.reltype), "descr": [s._inline.docPr.get("descr") for s in d.inline_shapes], "blobs": [r.target_part.blob.hex() for r in d.part.rels.values() if "image" in r.reltype and r.target_part.partname.endswith(".png")]}))';
  const result = JSON.parse(execFileSync('python3', ['-I', '-c', script, file], { encoding: 'utf8' })) as { shapes: number; parts: string[]; descr: string[]; blobs: string[] };
  assert.equal(result.shapes, 2);
  assert.deepEqual(result.parts, ['/word/media/image1.png', '/word/media/image2.gif']);
  assert.deepEqual(result.descr, ['First picture', 'Second picture']);
  assert.deepEqual(result.blobs, [Buffer.from(PNG).toString('hex')]);
});

test('LibreOffice, a second independent reader, draws the picture (the PDF it writes holds an image)', { skip: !has('soffice', ['--version']) && 'LibreOffice is not installed', timeout: 120_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'docx-img-lo-')), file = join(directory, 'pictures.docx');
  const document = documentWith([b.paragraph('p', 'Before the picture'), b.image('a', 'https://example.com/a.png', 'First picture')]);
  writeFileSync(file, (await built(document, () => PNG)).data);
  execFileSync('soffice', ['--headless', `-env:UserInstallation=file://${join(directory, 'profile')}`, '--convert-to', 'pdf', '--outdir', directory, file], { stdio: 'ignore', timeout: 100_000 });
  const pdf = readFileSync(join(directory, 'pictures.pdf')).toString('latin1');
  assert.match(pdf, /\/Subtype\s*\/Image/, 'the PDF contains an image object');
});
