import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { b, createDocument, createEditor } from '@supersolutions/super-editor-core';
import type { BlockContent, BlockInput } from '@supersolutions/super-editor-core';
import { createInteraction, htmlToBlocks } from '@supersolutions/super-editor-ui';
import type { FeedbackEvent } from '@supersolutions/super-editor-ui';

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
