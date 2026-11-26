import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { b, createDocument, createEditor } from '@supersolutions/super-editor-core';
import type { BlockContent, BlockInput } from '@supersolutions/super-editor-core';
import { counted, createInteraction, htmlToBlocks, translator } from '@supersolutions/super-editor-ui';
import type { FeedbackEvent, PasteWarning } from '@supersolutions/super-editor-ui';

const at = '2026-10-05T12:00:00.000Z';
const parse = (html: string): Document => new JSDOM(html).window.document;
let n = 0;
const ids = (): string => `paste-${++n}`;
const contents = (html: string): BlockContent[] => (htmlToBlocks(html, ids, { parse }) ?? []).map((block) => block.content);

test('HTML paste keeps headings, marks, links, lists, quotes, code, tables and rules', () => {
  const blocks = contents(`<!--StartFragment--><h1>Title</h1><h5>Deep</h5><p>Plain <b>bold</b> <em>it</em> <a href="https://example.com/a">link</a> <code>x</code></p>
    <ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul><ol><li>First</li></ol><blockquote>Said</blockquote>
    <pre><code class="language-ts">const a = 1;\nconst b = 2;</code></pre><table><caption>Cap</caption><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><hr><!--EndFragment-->`);
  assert.deepEqual(blocks[0], { type: 'heading', level: 1, text: 'Title' });
  assert.deepEqual(blocks[1], { type: 'heading', level: 3, text: 'Deep' });
  assert.deepEqual(blocks[2], { type: 'paragraph', runs: [{ text: 'Plain ' }, { text: 'bold', bold: true }, { text: ' ' }, { text: 'it', italic: true }, { text: ' ' }, { text: 'link', href: 'https://example.com/a' }, { text: ' ' }, { text: 'x', code: true }] });
  assert.deepEqual(blocks[3], { type: 'list', ordered: false, items: ['One', 'Nested', 'Two'], indent: [0, 1, 0] });
  assert.deepEqual(blocks[4], { type: 'list', ordered: true, items: ['First'], style: 'number' });
  assert.deepEqual(blocks[5], { type: 'quote', runs: [{ text: 'Said' }] });
  assert.deepEqual(blocks[6], { type: 'code', language: 'ts', text: 'const a = 1;\nconst b = 2;' });
  assert.deepEqual(blocks[7], { type: 'table', columns: ['A', 'B'], rows: [['1', '2']], caption: 'Cap' });
  assert.deepEqual(blocks[8], { type: 'divider' });
});

test('HTML paste drops scripts, styles, event handlers, unsafe links and data images', () => {
  const blocks = contents('<p onclick="x()">Hi <a href="javascript:alert(1)">bad</a><script>alert(1)</script><style>p{}</style></p><img src="data:image/png;base64,AAAA"><img src="https://example.com/i.png" alt="Chart"><div hidden>secret</div>');
  assert.deepEqual(blocks[0], { type: 'paragraph', runs: [{ text: 'Hi bad' }] });
  assert.deepEqual(blocks[1], { type: 'image', url: 'https://example.com/i.png', alt: 'Chart' });
  assert.equal(blocks.length, 2);
});

test('HTML paste reads Word and Docs span styles and loose text', () => {
  const blocks = contents('<div><span style="font-weight:700">Bold</span> then plain</div><div>Second</div>');
  assert.deepEqual(blocks[0], { type: 'paragraph', runs: [{ text: 'Bold', bold: true }, { text: ' then plain' }] });
  assert.deepEqual(blocks[1], { type: 'paragraph', runs: [{ text: 'Second' }] });
  assert.equal(htmlToBlocks('just text', ids, { parse }), null);
  assert.equal(htmlToBlocks('<p>x</p>', ids, { parse: () => null }), null);
});

function harness(options: Parameters<typeof createInteraction>[1] = {}) {
  const editor = createEditor(createDocument({ id: 'd', title: 'D' }, { now: () => at }), { now: () => at });
  const seed = editor.apply({ id: 's1', actor: { id: 'h', kind: 'human' }, baseRevision: 0, operations: [{ type: 'insertBlock', block: b.paragraph('p1', 'alpha') as BlockInput }] });
  assert.equal(seed.ok, true);
  const feedback: FeedbackEvent[] = [];
  const interaction = createInteraction(editor, { commitDelayMs: 0, platform: 'other', now: () => at, onFeedback: (event) => feedback.push(event), ...options });
  return { editor, interaction, feedback };
}
const transfer = (data: Record<string, string>, files: File[] = []) => ({ getData: (type: string) => data[type] ?? '', setData: () => undefined, files });

test('pasting HTML through the interaction inserts structured blocks', () => {
  (globalThis as { DOMParser?: unknown }).DOMParser = new JSDOM('').window.DOMParser;
  try {
    const { editor, interaction } = harness();
    assert.equal(interaction.clipboard.paste(transfer({ 'text/html': '<h2>From the web</h2><ul><li>a</li><li>b</li></ul>', 'text/plain': 'From the web\na\nb' })), true);
    const types = editor.getSnapshot().blocks.map((block) => block.content.type);
    assert.deepEqual(types, ['paragraph', 'heading', 'list']);
  } finally { delete (globalThis as { DOMParser?: unknown }).DOMParser; }
});

test('pasted or dropped image files go through uploadImage and become image blocks; without a handler they are refused', async () => {
  const png = new File([new Uint8Array(4)], 'shot.png', { type: 'image/png' });
  const refused = harness();
  assert.equal(refused.interaction.clipboard.paste(transfer({}, [png])), true);
  assert.equal(refused.feedback.at(-1)?.kind, 'error');
  assert.equal(refused.editor.getSnapshot().blocks.length, 1);

  const calls: string[] = [];
  const { editor, interaction, feedback } = harness({ uploadImage: async (file) => { calls.push(file.name); return { url: 'https://cdn.example.com/shot.png' }; } });
  assert.equal(interaction.clipboard.pasteFiles([png]), true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(calls, ['shot.png']);
  const image = editor.getSnapshot().blocks.find((block) => block.content.type === 'image')?.content;
  assert.deepEqual(image, { type: 'image', url: 'https://cdn.example.com/shot.png', alt: 'shot' });
  assert.equal(feedback.some((event) => event.kind === 'info'), true);

  const insecure = harness({ uploadImage: async () => ({ url: 'http://cdn.example.com/a.png' }) });
  insecure.interaction.clipboard.pasteFiles([png]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(insecure.editor.getSnapshot().blocks.some((block) => block.content.type === 'image'), false);
  assert.equal(insecure.feedback.at(-1)?.kind, 'error');

  const huge = harness({ uploadImage: async () => ({ url: 'https://x.example/a.png' }), maxImageBytes: 2 });
  huge.interaction.clipboard.pasteFiles([png]);
  assert.equal(huge.feedback.at(-1)?.kind, 'error');
  assert.equal(harness().interaction.clipboard.pasteFiles([new File(['x'], 'a.txt', { type: 'text/plain' })]), false);
});

test('interaction messages translate notices, menu labels and shortcut descriptions', () => {
  const { interaction, feedback } = harness({ messages: { 'This document is read-only.': '此文件為唯讀。', Duplicate: '複製', 'Move up': '上移' }, readOnly: true });
  assert.equal(interaction.t('Duplicate'), '複製');
  assert.equal(interaction.t('Unlisted'), 'Unlisted');
  interaction.commands.deleteBlocks(['p1']);
  assert.equal(feedback.at(-1)?.message, '此文件為唯讀。');
  interaction.selection.set(['p1']);
  const labels = interaction.menu.actions().map((action) => action.label);
  assert.ok(labels.includes('複製') && labels.includes('上移'), labels.join(','));
});

const warningsOf = (html: string, options: { linkSchemes?: 'https' | 'http-https' } = {}) => {
  const warnings: PasteWarning[] = [];
  const blocks = htmlToBlocks(html, ids, { parse, warnings, ...options });
  return { blocks, warnings, codes: warnings.map((warning) => `${warning.code}:${warning.count}`) };
};

test('HTML paste reports what it left out, once per kind, and stays silent about what it drops on purpose', () => {
  const quiet = warningsOf('<style>p{color:red}</style><p class="x" style="color:red" onclick="x()">Fine <a href="#section">anchor</a> <a href="/relative">rel</a></p><script>1</script>');
  assert.deepEqual(quiet.codes, [], 'styles, scripts, classes and relative links are not a loss worth a notice');
  assert.equal(quiet.blocks?.length, 1);

  const lossy = warningsOf('<p>Hi <a href="javascript:alert(1)">bad</a> <a href="mailto:a@b.c">mail</a> <a href="http://example.com/">plain http</a></p><img src="data:image/png;base64,AAAA"><img src="http://example.com/i.png"><img src="https://example.com/ok.png" alt="ok"><img>');
  assert.deepEqual(lossy.codes, ['link-removed:3', 'image-left-out:2']);
  const [links, images] = lossy.warnings;
  assert.equal(links!.message, '{count} links were removed because their addresses are not allowed; their text was kept.'); assert.deepEqual(links!.params, { count: 3 });
  assert.equal(images!.message, '{count} images were left out: only https images can be pasted.');
  assert.equal(warningsOf('<p><a href="http://example.com/">x</a></p>', { linkSchemes: 'http-https' }).codes.length, 0, 'an allowed scheme is kept and silent');
  assert.equal(warningsOf('<img src="data:image/png;base64,AAAA"><p>x</p>').warnings[0]!.message, '{count} image was left out: only https images can be pasted.', 'one gets the singular template');
});

test('HTML paste reports blocks, list items, table cells and text over the limits', () => {
  const many = warningsOf('<p>x</p>'.repeat(503));
  assert.equal(many.blocks?.length, 500); assert.deepEqual(many.codes, ['blocks-capped:3']); assert.deepEqual(many.warnings[0]!.params, { count: 3, limit: 500 });
  const list = warningsOf(`<ul>${'<li>i</li>'.repeat(2_002)}</ul>`);
  assert.deepEqual(list.codes, ['list-items-capped:2']);
  const table = warningsOf(`<table>${'<tr>' + '<td>c</td>'.repeat(101) + '</tr>'}<tr><td>a</td></tr></table><table>${'<tr><td>r</td></tr>'.repeat(2_002)}</table>`);
  assert.deepEqual(table.codes, ['table-trimmed:2']);
  const long = warningsOf(`<h1>${'h'.repeat(100_001)}</h1><pre>${'c'.repeat(100_001)}</pre><ul><li>${'i'.repeat(10_001)}</li></ul>`);
  assert.deepEqual(long.codes, ['text-shortened:3']);
  assert.equal((long.blocks![0]!.content as { text: string }).text.length, 100_000);
  const huge: PasteWarning[] = [];
  assert.equal(htmlToBlocks(`<p>${'x'.repeat(1_000_001)}</p>`, ids, { parse, warnings: huge }), null);
  assert.deepEqual(huge.map((warning) => warning.code), ['html-too-large']);
  assert.equal(htmlToBlocks('<p>ok</p>', ids, { parse })?.length, 1, 'the sink is optional');
});

test('translator fills templates, takes a function per message for plural rules, and leaves unknown text alone', () => {
  const english = translator();
  assert.equal(english('Pasted {count} blocks', { count: 3 }), 'Pasted 3 blocks');
  assert.equal(english('Pasted {count} blocks'), 'Pasted {count} blocks', 'no parameters, no change');
  assert.equal(english('Hello {name}', { count: 1 }), 'Hello {name}', 'a placeholder without a value stays as written');
  assert.equal(counted(1, 'one {count}', 'many {count}'), 'one {count}'); assert.equal(counted(0, 'one', 'many'), 'many');
  const zh = translator({ 'Pasted {count} blocks': '已貼上 {count} 個區塊', 'Pasted {count} block': '已貼上 {count} 個區塊' });
  assert.equal(zh('Pasted {count} blocks', { count: 4 }), '已貼上 4 個區塊');
  const ru = translator({ 'Pasted {count} blocks': ({ count }) => `${count} ${new Intl.PluralRules('ru').select(Number(count)) === 'few' ? 'блока' : 'блоков'}` });
  assert.equal(ru('Pasted {count} blocks', { count: 3 }), '3 блока'); assert.equal(ru('Pasted {count} blocks', { count: 5 }), '5 блоков');
  assert.equal(translator({ constructor: 'x' })('constructor'), 'x'); assert.equal(translator({})('constructor'), 'constructor', 'inherited keys are not messages');
});

test('notices with a count or a name are templates a host can translate, and carry template and params', () => {
  (globalThis as { DOMParser?: unknown }).DOMParser = new JSDOM('').window.DOMParser;
  try {
    const { interaction, feedback } = harness({ messages: { 'Pasted {count} blocks': '已貼上 {count} 個區塊', 'Pasted {count} block': '已貼上 {count} 個區塊', 'Duplicated {count} block': '已複製 {count} 個區塊', '{count} images were left out: only https images can be pasted.': '有 {count} 張圖片未貼上：只能貼上 https 圖片。', '{count} image was left out: only https images can be pasted.': '有 {count} 張圖片未貼上：只能貼上 https 圖片。' } });
    interaction.clipboard.paste(transfer({ 'text/html': '<h2>One</h2><p>Two</p><img src="data:image/png;base64,AAAA"><img src="http://x.test/a.png">', 'text/plain': 'x' }));
    const pasted = feedback.find((event) => event.template === 'Pasted {count} blocks');
    assert.equal(pasted?.message, '已貼上 2 個區塊'); assert.deepEqual(pasted?.params, { count: 2 });
    const warned = feedback.find((event) => event.warnings?.length);
    assert.equal(warned?.kind, 'info'); assert.equal(warned?.message, '有 2 張圖片未貼上：只能貼上 https 圖片。'); assert.equal(warned?.warnings?.[0]?.code, 'image-left-out');
    interaction.selection.set(['p1']); interaction.commands.duplicateBlocks(['p1']);
    const copied = feedback.at(-1)!;
    assert.equal(copied.message, '已複製 1 個區塊'); assert.equal(copied.template, 'Duplicated {count} block');
    interaction.selection.set(['p1']); interaction.commands.turnInto('heading2', ['p1']);
    assert.equal(feedback.at(-1)!.message, 'Turned 1 block into Heading 2');
  } finally { delete (globalThis as { DOMParser?: unknown }).DOMParser; }
  const { interaction, feedback } = harness({ messages: { 'Turned {count} block into {type}': '已將 {count} 個區塊轉為 {type}', 'Heading 2': '標題 2' } });
  interaction.selection.set(['p1']); interaction.commands.turnInto('heading2', ['p1']);
  assert.equal(feedback.at(-1)!.message, '已將 1 個區塊轉為 標題 2', 'a block kind inside a template is translated too');
  assert.equal(feedback.at(-1)!.template, 'Turned {count} block into {type}');
});
