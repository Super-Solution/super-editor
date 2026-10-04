import assert from 'node:assert/strict';
import test from 'node:test';
import { b, createDocument, createEditor, runs } from '@super-solution/editor-core';
import type { ApplyResult, BlockInput, Editor, InlineRun } from '@super-solution/editor-core';
import {
  CHART_TEMPLATES, CLIPBOARD_MIME, compatibleChartKinds, createInteraction, createShortcutRegistry, createSlashCatalog, dropTargetAt, filterSlashItems, formatShortcut, fuzzyScore,
  groupSlashItems, indexBlockLayout, isNoopPlacement, markState, matchInputRule, matchesShortcut, parseBlocksPayload, parseShortcut, placementOf, planPaste, serializeBlocks,
  setLink, splitRuns, toggleMark, wordRangeAt,
} from '@super-solution/editor-ui';
import type { ConflictInfo, FeedbackEvent, Interaction, InteractionOptions, LayoutBox } from '@super-solution/editor-ui';

const at = '2026-10-05T12:00:00.000Z';
const human = { id: 'seed-human', kind: 'human' as const };
let counter = 0;
function seed(blocks: BlockInput[]): Editor {
  const editor = createEditor(createDocument({ id: 'doc', title: 'Doc' }, { now: () => at }), { now: () => at });
  const result = editor.apply({ id: `seed-${++counter}`, actor: human, baseRevision: 0, operations: [{ type: 'addCitation', citation: { id: 'src', title: 'Source', url: 'https://example.com/s', accessedAt: at } }, ...blocks.map((block) => ({ type: 'insertBlock' as const, block }))] });
  assert.equal(result.ok, true, JSON.stringify(result));
  return editor;
}
function ok(result: ApplyResult | null): Extract<ApplyResult, { ok: true }> {
  assert.ok(result, 'expected a result');
  assert.equal(result.ok, true, result.ok ? '' : JSON.stringify(result.issues));
  return result as Extract<ApplyResult, { ok: true }>;
}
type Harness = { editor: Editor; interaction: Interaction; feedback: FeedbackEvent[]; conflicts: ConflictInfo[] };
function harness(blocks: BlockInput[], options: InteractionOptions = {}, editor = seed(blocks)): Harness {
  const feedback: FeedbackEvent[] = [], conflicts: ConflictInfo[] = [];
  const interaction = createInteraction(editor, { commitDelayMs: 0, platform: 'other', now: () => at, onFeedback: (event) => feedback.push(event), onConflict: (info) => conflicts.push(info), ...options });
  return { editor, interaction, feedback, conflicts };
}
const order = (editor: Editor): string[] => editor.getSnapshot().blocks.map((block) => block.id);
const get = (editor: Editor, id: string) => editor.getSnapshot().blocks.find((block) => block.id === id)!;
const text = (editor: Editor, id: string): string => { const c = get(editor, id).content; return c.type === 'paragraph' || c.type === 'quote' || c.type === 'callout' ? c.runs.map((run) => run.text).join('') : c.type === 'heading' ? c.text : c.type === 'section' || c.type === 'toggle' ? c.title : ''; };
const key = (value: string, extra: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; code: string }> = {}) => {
  let prevented = false;
  return { key: value, code: extra.code ?? '', ctrlKey: !!extra.ctrlKey, metaKey: !!extra.metaKey, altKey: !!extra.altKey, shiftKey: !!extra.shiftKey, preventDefault() { prevented = true; }, get prevented() { return prevented; } };
};
const doc = () => [b.section('s1', 'Section'), b.paragraph('p1', 'alpha', { parentId: 's1' }), b.paragraph('p2', 'beta', { parentId: 's1' }), b.paragraph('p3', 'gamma'), b.paragraph('p4', 'delta')];

test('slash menu: fuzzy filter ranks label, keyword, hint and subsequence matches', () => {
  const catalog = createSlashCatalog();
  assert.equal(filterSlashItems(catalog, '').length, catalog.length);
  assert.equal(filterSlashItems(catalog, 'head')[0]!.id, 'heading1');
  assert.deepEqual(filterSlashItems(catalog, 'heading 2').map((item) => item.id).slice(0, 1), ['heading2']);
  assert.equal(filterSlashItems(catalog, '##')[0]!.id, 'heading2');
  assert.ok(filterSlashItems(catalog, 'cand').some((item) => item.id === 'chart-candlestick'));
  assert.equal(filterSlashItems(catalog, 'ohlc')[0]!.id, 'chart-candlestick');
  assert.equal(filterSlashItems(catalog, 'tdl')[0]!.id, 'todo');
  assert.equal(filterSlashItems(catalog, 'checklist')[0]!.id, 'todo');
  assert.ok(filterSlashItems(catalog, 'zzzqqq').length === 0);
  assert.ok(fuzzyScore('bar', 'Bar chart') > fuzzyScore('bar', 'Candlestick chart'));
  assert.equal(fuzzyScore('xyz', 'Bar chart'), 0);
  const groups = groupSlashItems(catalog);
  assert.deepEqual(groups.map((group) => group.group), ['Basic blocks', 'Report', 'Charts']);
  assert.equal(groups.flatMap((group) => group.items).length, catalog.length);
});

test('slash catalog covers every block type and every chart kind with valid content', () => {
  const catalog = createSlashCatalog();
  const types = new Set(catalog.map((item) => item.create({ now: at, input: 'https://example.com/x' }).type));
  for (const type of ['section', 'heading', 'paragraph', 'list', 'table', 'chart', 'embed', 'timestamp', 'quote', 'callout', 'code', 'divider', 'image', 'toggle', 'metrics', 'toc', 'pageBreak']) assert.ok(types.has(type as never), `missing ${type}`);
  assert.equal(Object.keys(CHART_TEMPLATES).length, 11);
  const editor = seed([]);
  const blocks = catalog.map((item, index) => ({ id: `item-${index}`, parentId: null, citationIds: [], content: item.create({ now: at, input: 'https://example.com/x' }) }));
  ok(editor.apply({ id: 'catalog-all', actor: human, baseRevision: editor.getSnapshot().revision, operations: [{ type: 'insertBlocks', blocks }] }));
  assert.equal(catalog.filter((item) => item.input).length, 2);
});

test('shortcuts: platform-aware Mod, layout-proof digits, display labels', () => {
  assert.equal(matchesShortcut(parseShortcut('Mod+B'), key('b', { metaKey: true }), 'mac'), true);
  assert.equal(matchesShortcut(parseShortcut('Mod+B'), key('b', { ctrlKey: true }), 'mac'), false);
  assert.equal(matchesShortcut(parseShortcut('Mod+B'), key('b', { ctrlKey: true }), 'other'), true);
  assert.equal(matchesShortcut(parseShortcut('Mod+B'), key('b', { ctrlKey: true, shiftKey: true }), 'other'), false);
  assert.equal(matchesShortcut(parseShortcut('Mod+Alt+1'), key('¡', { metaKey: true, altKey: true, code: 'Digit1' }), 'mac'), true);
  assert.equal(matchesShortcut(parseShortcut('Mod+Shift+7'), key('&', { ctrlKey: true, shiftKey: true, code: 'Digit7' }), 'other'), true);
  assert.equal(matchesShortcut(parseShortcut('Mod+Alt+C'), key('ç', { ctrlKey: true, altKey: true, code: 'KeyC' }), 'other'), true);
  assert.equal(matchesShortcut(parseShortcut('Alt+Shift+ArrowUp'), key('ArrowUp', { altKey: true, shiftKey: true }), 'other'), true);
  assert.equal(matchesShortcut(parseShortcut('?'), key('?', { shiftKey: true }), 'other'), true);
  assert.equal(formatShortcut('Mod+Shift+S', 'mac'), '⇧⌘S');
  assert.equal(formatShortcut('Mod+Shift+S', 'other'), 'Ctrl+Shift+S');
  assert.equal(formatShortcut('Alt+Shift+ArrowDown', 'other'), 'Alt+Shift+↓');
  assert.throws(() => parseShortcut('Mod+'));
});

test('shortcut registry: priority, when, decline, override and disable', () => {
  const registry = createShortcutRegistry<{ open: boolean }>({ platform: 'other' });
  const calls: string[] = [];
  registry.register({ id: 'low', keys: ['Enter'], description: 'low', group: 'g', run: () => { calls.push('low'); } });
  registry.register({ id: 'high', keys: ['Enter'], description: 'high', group: 'g', priority: 10, when: (context) => context.open, run: () => { calls.push('high'); } });
  registry.register({ id: 'decline', keys: ['Tab'], description: 'decline', group: 'g', priority: 5, run: () => false });
  registry.register({ id: 'tab', keys: ['Tab'], description: 'tab', group: 'g', run: () => { calls.push('tab'); } });
  const press = (name: string, open: boolean) => { const event = key(name); return { handled: registry.handle(event, { open }), prevented: event.prevented }; };
  assert.deepEqual(press('Enter', false), { handled: true, prevented: true });
  assert.deepEqual(press('Enter', true), { handled: true, prevented: true });
  assert.deepEqual(calls, ['low', 'high']);
  assert.equal(press('Tab', false).handled, true);
  assert.deepEqual(calls.slice(2), ['tab']);
  registry.override('low', ['Mod+J']);
  assert.equal(press('Enter', false).handled, false);
  assert.equal(registry.handle(key('j', { ctrlKey: true }), { open: false }), true);
  registry.override('low', null);
  assert.equal(registry.list().find((entry) => entry.id === 'low')!.disabled, true);
  assert.equal(registry.handle({ ...key('Enter'), isComposing: true }, { open: true }), false);
  assert.deepEqual(registry.list().find((entry) => entry.id === 'high')!.display, ['Enter']);
});

test('input rules map markdown prefixes to blocks', () => {
  const para = (value: string) => ({ type: 'paragraph' as const, runs: value ? [{ text: value }] : [] });
  const rule = (value: string, caret = value.length, trigger: 'space' | 'enter' | 'input' = 'space') => matchInputRule(para(value), caret, trigger);
  assert.deepEqual(rule('# ')?.content, { type: 'heading', level: 1, text: '' });
  assert.deepEqual(rule('## ')?.content, { type: 'heading', level: 2, text: '' });
  assert.deepEqual(rule('### Title', 4)?.content, { type: 'heading', level: 3, text: 'Title' });
  assert.equal(rule('#### '), null);
  assert.deepEqual(rule('- ')?.content, { type: 'list', ordered: false, style: 'bullet', items: [''] });
  assert.equal(rule('* ')?.rule, 'bullet');
  assert.deepEqual(rule('1. ')?.content, { type: 'list', ordered: true, style: 'number', items: [''] });
  assert.equal(rule('12) ')?.rule, 'number');
  assert.deepEqual(rule('[] ')?.content, { type: 'list', ordered: false, style: 'todo', items: [''], checked: [false] });
  assert.deepEqual(rule('[x] done', 4)?.content, { type: 'list', ordered: false, style: 'todo', items: ['done'], checked: [true] });
  assert.deepEqual(rule('[ ] ')?.content, { type: 'list', ordered: false, style: 'todo', items: [''], checked: [false] });
  assert.equal(rule('> ')?.rule, 'quote');
  assert.equal(rule('!! ')?.rule, 'callout');
  assert.equal(rule('---', 3, 'input')?.rule, 'divider');
  assert.equal(rule('---', 3, 'input')?.followWithParagraph, true);
  assert.equal(rule('```', 3, 'input')?.rule, 'code');
  assert.deepEqual(rule('```ts', 5, 'enter')?.content, { type: 'code', language: 'ts', text: '' });
  assert.equal(rule('a - '), null);
  assert.equal(rule('text # '), null);
  assert.equal(rule('--', 2, 'input'), null);
  assert.equal(matchInputRule({ type: 'heading', level: 1, text: '# ' }, 2, 'space'), null);
  // The remaining text keeps its inline marks when it becomes a quote.
  const marked = matchInputRule({ type: 'paragraph', runs: [{ text: '> ' }, { text: 'bold', bold: true }] }, 2, 'space');
  assert.deepEqual(marked?.content, { type: 'quote', runs: [{ text: 'bold', bold: true }] });
});

test('inline runs: marks toggle across runs, links, splits and citations', () => {
  const base: InlineRun[] = [{ text: 'plain ' }, { text: 'bold', bold: true }, { text: ' tail', citationId: 'src' }];
  const all = toggleMark(base, 0, 10, 'bold');
  assert.equal(markState(all, 0, 10, 'bold'), 'all');
  assert.equal(markState(toggleMark(all, 0, 10, 'bold'), 0, 10, 'bold'), 'none');
  assert.equal(markState(base, 0, 10, 'bold'), 'some');
  const [left, right] = splitRuns(base, 8);
  assert.equal(left.map((run) => run.text).join(''), 'plain bo');
  assert.equal(right.map((run) => run.text).join(''), 'ld tail');
  assert.equal(right[right.length - 1]!.citationId, 'src', 'a marker stays with the end of its run');
  assert.equal(left.some((run) => run.citationId), false);
  const linked = setLink(base, 0, 5, 'https://example.com/');
  assert.equal(linked[0]!.href, 'https://example.com/');
  assert.equal(linked[0]!.text, 'plain');
  assert.deepEqual(wordRangeAt('hello big world', 7), { start: 6, end: 9 });
  assert.equal(wordRangeAt('a  b', 2), null);
  assert.equal(runs('**x**')[0]!.bold, true);
});

test('human actor is required and read-only blocks every mutation', () => {
  const editor = seed(doc());
  assert.throws(() => createInteraction(editor, { actor: { id: 'bot', kind: 'agent' } as never }), /human actor/);
  const { interaction, feedback } = harness([], {}, editor);
  interaction.setReadOnly(true);
  const revision = editor.getSnapshot().revision;
  assert.equal(interaction.commands.deleteBlocks(['p1']), null);
  assert.equal(interaction.commands.duplicateBlocks(['p1']), null);
  assert.equal(interaction.edit.start('p1'), false);
  assert.equal(editor.getSnapshot().revision, revision);
  assert.ok(feedback.some((event) => /read-only/i.test(event.message)));
  interaction.setReadOnly(false);
  ok(interaction.commands.duplicateBlocks(['p3']));
  const last = editor.getRevisions().at(-1)!;
  assert.equal(last.actor.kind, 'human');
  assert.equal(last.actor.id, 'local-human');
});

test('selection model: click, shift-range, toggle, select all, keyboard moves and pruning', () => {
  const { editor, interaction } = harness(doc());
  const ids = () => [...interaction.getState().selection.ids];
  interaction.selection.select('p1');
  assert.deepEqual(ids(), ['p1']);
  interaction.selection.select('p3', 'extend');
  assert.deepEqual(ids(), ['p1', 'p2', 'p3']);
  interaction.selection.select('p2', 'toggle');
  assert.deepEqual(ids(), ['p1', 'p3']);
  interaction.selection.selectAll();
  assert.deepEqual(ids(), ['s1', 'p1', 'p2', 'p3', 'p4']);
  interaction.selection.select('p3');
  interaction.selection.move(1);
  assert.deepEqual(ids(), ['p4']);
  interaction.selection.move(-1, true);
  interaction.selection.move(-1, true);
  assert.deepEqual(ids(), ['p2', 'p3', 'p4']);
  interaction.selection.set(['p4', 'p1']);
  assert.deepEqual(ids(), ['p1', 'p4'], 'document order');
  ok(interaction.commands.deleteBlocks(['p4']));
  assert.deepEqual(ids(), ['p1']);
  assert.equal(order(editor).includes('p4'), false);
  assert.equal(interaction.escape(), true);
  assert.deepEqual(ids(), []);
  assert.equal(interaction.escape(), false);
});

test('multi-block delete reports an Undo action that restores the blocks', () => {
  const { editor, interaction, feedback } = harness(doc());
  interaction.selection.set(['p3', 'p4']);
  ok(interaction.commands.deleteBlocks());
  assert.deepEqual(order(editor), ['s1', 'p1', 'p2']);
  const deleted = feedback.find((event) => /Deleted 2 blocks/.test(event.message));
  assert.ok(deleted?.action);
  deleted.action.run();
  assert.deepEqual(order(editor), ['s1', 'p1', 'p2', 'p3', 'p4']);
  assert.equal(editor.getRevisions().at(-1)!.kind, 'undo');
});

test('deleting a container takes its subtree and focus moves to the previous block', () => {
  const { editor, interaction } = harness([b.paragraph('intro', 'intro'), ...doc()]);
  interaction.selection.set(['s1', 'p1']);
  ok(interaction.commands.deleteBlocks());
  assert.deepEqual(order(editor), ['intro', 'p3', 'p4']);
  assert.equal(interaction.getState().editing, null, 'deleting a selection does not pop the keyboard up');
  interaction.edit.start('p4');
  ok(interaction.commands.deleteBlocks());
  assert.equal(interaction.getState().editing?.blockId, 'p3', 'deleting the block being typed in moves to its neighbour');
});

test('duplicate is deep, keeps order, and a sibling selection duplicates as a group', () => {
  const { editor, interaction } = harness(doc());
  ok(interaction.commands.duplicateBlocks(['s1']));
  const after = editor.getSnapshot().blocks;
  assert.equal(after.length, 5 + 3);
  const copies = interaction.getState().selection.ids;
  assert.equal(copies.length, 1);
  assert.equal(get(editor, copies[0]!).parentId, null);
  assert.equal(after.filter((block) => block.parentId === copies[0]).length, 2);
  interaction.selection.set(['p3', 'p4']);
  ok(interaction.commands.duplicateBlocks());
  const top = editor.getSnapshot().blocks.filter((block) => block.parentId === null).map((block) => text(editor, block.id));
  assert.deepEqual(top.slice(-4), ['gamma', 'delta', 'gamma', 'delta']);
});

test('keyboard move swaps siblings and leaves containers at their first or last child', () => {
  const { editor, interaction } = harness(doc());
  ok(interaction.commands.moveStep('down', ['p1']));
  assert.deepEqual(order(editor), ['s1', 'p2', 'p1', 'p3', 'p4']);
  ok(interaction.commands.moveStep('down', ['p1']));
  assert.equal(get(editor, 'p1').parentId, null, 'moving down past the last child leaves the section');
  assert.deepEqual(order(editor), ['s1', 'p2', 'p1', 'p3', 'p4']);
  ok(interaction.commands.moveStep('up', ['p2']));
  assert.equal(get(editor, 'p2').parentId, null);
  assert.deepEqual(order(editor), ['p2', 's1', 'p1', 'p3', 'p4'].filter((id) => order(editor).includes(id)));
  assert.equal(interaction.commands.moveStep('up', ['p2']), null, 'already first');
  ok(interaction.commands.moveStep('down', ['p3', 'p4'].slice(0, 1)));
  assert.deepEqual(order(editor).slice(-2), ['p4', 'p3']);
  // Mixed parents are refused with feedback, nothing moves.
});

test('turn into keeps text and marks; a multi-item list becomes one block per item', () => {
  const { editor, interaction } = harness([b.paragraph('rich', '**bold** tail'), b.list('items', ['one', 'two', 'three']), b.paragraph('target', 'plain'), b.chart('chart', CHART_TEMPLATES.bar())]);
  ok(interaction.commands.turnInto('quote', ['rich']));
  assert.deepEqual(get(editor, 'rich').content, { type: 'quote', runs: [{ text: 'bold', bold: true }, { text: ' tail' }] });
  ok(interaction.commands.turnInto('heading2', ['items']));
  assert.deepEqual(editor.getSnapshot().blocks.filter((block) => block.content.type === 'heading').map((block) => block.content.type === 'heading' ? block.content.text : ''), ['one', 'two', 'three']);
  ok(interaction.commands.turnInto('todo', ['target']));
  assert.deepEqual(get(editor, 'target').content, { type: 'list', ordered: false, style: 'todo', items: ['plain'], checked: [false] });
  ok(interaction.commands.turnInto('paragraph', ['target']));
  assert.deepEqual(get(editor, 'target').content, { type: 'paragraph', runs: [{ text: 'plain' }] });
  assert.equal(interaction.commands.turnInto('paragraph', ['chart']), null, 'charts are not convertible');
});

test('turn into refuses to strip a container of its children', () => {
  const { editor, interaction, feedback } = harness(doc());
  assert.equal(interaction.commands.turnInto('paragraph', ['s1']), null);
  assert.equal(get(editor, 's1').content.type, 'section');
  assert.ok(feedback.some((event) => event.kind === 'error'));
  ok(interaction.commands.turnInto('toggle', ['s1']));
  assert.equal(get(editor, 's1').content.type, 'toggle');
  assert.equal(get(editor, 'p1').parentId, 's1');
});

function layoutFor(editor: Editor): LayoutBox[] {
  // Simple vertical stack: every block 40px tall, containers wrap their children with a 30px header and 10px footer.
  const blocks = editor.getSnapshot().blocks;
  const boxes: LayoutBox[] = [];
  let y = 0;
  const place = (parentId: string | null): void => {
    for (const block of blocks.filter((entry) => entry.parentId === parentId)) {
      const top = y, children = blocks.some((entry) => entry.parentId === block.id);
      if (block.content.type === 'section' || block.content.type === 'toggle') {
        y += 30; place(block.id); y += 10;
        boxes.push({ id: block.id, parentId, left: 100, right: 700, top, bottom: y });
      } else { y += 40; boxes.push({ id: block.id, parentId, left: 100, right: 700, top, bottom: y }); }
      void children;
    }
  };
  place(null);
  return boxes;
}
const geometry = (editor: Editor) => indexBlockLayout(layoutFor(editor));

test('drop targets: before/after, into and out of containers, never into the dragged subtree', () => {
  const { editor } = harness(doc());
  const index = geometry(editor); // s1: 0..110 (header 0-30, p1 30-70, p2 70-110 wait: footer to 120), p3, p4 follow
  const box = (id: string) => index.byId.get(id)!;
  const d = editor.getSnapshot();
  assert.equal(box('s1').bottom, 120);
  assert.deepEqual(dropTargetAt(index, d, ['p4'], 400, box('p3').top + 5), { overId: 'p3', position: 'before' });
  assert.deepEqual(dropTargetAt(index, d, ['p4'], 400, box('p3').bottom - 5), { overId: 'p3', position: 'after' });
  assert.deepEqual(dropTargetAt(index, d, ['p3'], 400, box('p1').top + 5), { overId: 'p1', position: 'before' });
  assert.deepEqual(dropTargetAt(index, d, ['p3'], 400, 20), { overId: 's1', position: 'inside-start' }, 'lower half of the header drops inside');
  assert.deepEqual(dropTargetAt(index, d, ['p3'], 400, 5), { overId: 's1', position: 'before' });
  assert.deepEqual(dropTargetAt(index, d, ['p3'], 400, 115), { overId: 's1', position: 'after' }, 'the footer drops after the container');
  assert.equal(dropTargetAt(index, d, ['s1'], 400, box('p1').top + 5)?.overId === 'p1', false, 'cannot drop into own subtree');
  assert.deepEqual(dropTargetAt(index, d, ['p4'], 400, 1000), { overId: 'p3', position: 'after' }, 'below everything');
  assert.deepEqual(dropTargetAt(index, d, ['p4'], 60, box('p3').top + 5, { expandLeft: 56 }), { overId: 'p3', position: 'before' }, 'gutter counts as the block (expandLeft)');
  assert.deepEqual(placementOf(d, { overId: 'p2', position: 'after' }, ['p4']), { parentId: 's1', afterId: 'p2' });
  assert.deepEqual(placementOf(d, { overId: 'p2', position: 'before' }, ['p1']), { parentId: 's1', afterId: null }, 'the anchor is never a moved block');
  assert.deepEqual(placementOf(d, { overId: 's1', position: 'inside-end' }, ['p3']), { parentId: 's1', afterId: 'p2' });
  assert.equal(placementOf(d, { overId: 'p1', position: 'inside-end' }, ['p3']), null, 'only containers hold blocks');
  assert.equal(isNoopPlacement(d, ['p3'], { parentId: null, afterId: 's1' }), true);
  assert.equal(isNoopPlacement(d, ['p3'], { parentId: null, afterId: 'p4' }), false);
});

test('pointer drag model: drop applies one guarded moveBlocks; into, out of and no-op drops', () => {
  const { editor, interaction } = harness(doc());
  const revisions = () => editor.getSnapshot().revision;
  assert.equal(interaction.drag.start(['p3']), true);
  assert.deepEqual(interaction.getState().selection.ids, ['p3']);
  let index = geometry(editor);
  const target = interaction.drag.hover(index, 400, index.byId.get('p1')!.top + 30);
  assert.deepEqual(target, { overId: 'p1', position: 'after' }, 'into the section after its first child');
  assert.deepEqual(interaction.getState().drag!.placement, { parentId: 's1', afterId: 'p1' });
  const before = revisions();
  ok(interaction.drag.drop());
  assert.equal(revisions(), before + 1);
  assert.equal(get(editor, 'p3').parentId, 's1');
  assert.deepEqual(order(editor), ['s1', 'p1', 'p3', 'p2', 'p4']);
  assert.equal(interaction.getState().drag, null);
  // Out of the section: drop into its footer.
  interaction.drag.start(['p3']);
  index = geometry(editor);
  interaction.drag.hover(index, 400, index.byId.get('s1')!.bottom - 3);
  ok(interaction.drag.drop());
  assert.equal(get(editor, 'p3').parentId, null);
  assert.deepEqual(order(editor), ['s1', 'p1', 'p2', 'p3', 'p4']);
  // Dropping where it already is changes nothing.
  interaction.drag.start(['p4']);
  index = geometry(editor);
  interaction.drag.hover(index, 400, index.byId.get('p4')!.bottom - 2);
  assert.equal(interaction.getState().drag!.placement, null);
  const quiet = revisions();
  assert.equal(interaction.drag.drop(), null);
  assert.equal(revisions(), quiet);
  // Escape cancels.
  interaction.drag.start(['p4']);
  assert.equal(interaction.escape(), true);
  assert.equal(interaction.getState().drag, null);
});

test('dragging several selected blocks moves them together, in document order', () => {
  const { editor, interaction } = harness(doc());
  interaction.drag.start(['p4', 'p3']);
  assert.deepEqual([...interaction.getState().drag!.ids], ['p3', 'p4']);
  const index = geometry(editor);
  interaction.drag.hover(index, 400, index.byId.get('p1')!.top + 3);
  ok(interaction.drag.drop());
  assert.deepEqual(order(editor), ['s1', 'p3', 'p4', 'p1', 'p2']);
});

test('typing is buffered into guarded updates attributed to the human actor', () => {
  const { editor, interaction } = harness(doc());
  assert.equal(interaction.edit.start('p3', { caret: 'end' }), true);
  const before = editor.getSnapshot().revision;
  interaction.edit.input('p3', 'main', [{ text: 'gamma!' }], { caret: 6, data: '!' });
  assert.equal(text(editor, 'p3'), 'gamma!');
  assert.equal(editor.getSnapshot().revision, before + 1);
  const revision = editor.getRevisions().at(-1)!;
  assert.deepEqual(revision.actor, { id: 'local-human', kind: 'human' });
  assert.equal(revision.operations[0]!.type, 'updateBlock');
  assert.equal((revision.operations[0] as { expectedVersion: number }).expectedVersion, 1);
});

test('typing pauses before committing when delay is set and flushes on blur-style calls', async () => {
  const { editor, interaction } = harness(doc(), { commitDelayMs: 20 });
  interaction.edit.start('p3');
  interaction.edit.input('p3', 'main', [{ text: 'gamma 1' }]);
  interaction.edit.input('p3', 'main', [{ text: 'gamma 12' }]);
  assert.equal(text(editor, 'p3'), 'gamma', 'nothing committed yet');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(text(editor, 'p3'), 'gamma 12');
  assert.equal(editor.getRevisions().filter((revision) => revision.actor.kind === 'human' && revision.operations.some((operation) => operation.type === 'updateBlock')).length, 1, 'one commit for the burst');
  interaction.edit.input('p3', 'main', [{ text: 'gamma 123' }]);
  interaction.edit.flush('p3');
  assert.equal(text(editor, 'p3'), 'gamma 123');
  interaction.destroy();
});

test('an edit made elsewhere while typing becomes a conflict, never an overwrite; "mine" and "theirs" resolve it', () => {
  const { editor, interaction, conflicts, feedback } = harness(doc(), { commitDelayMs: 1_000 });
  interaction.edit.start('p3');
  interaction.edit.input('p3', 'main', [{ text: 'my draft' }]);
  const v = get(editor, 'p3').version;
  ok(editor.apply({ id: 'agent-1', actor: { id: 'agent', kind: 'agent' }, baseRevision: editor.getSnapshot().revision, operations: [{ type: 'updateBlock', blockId: 'p3', expectedVersion: v, content: { type: 'paragraph', runs: [{ text: 'agent text' }] } }] }));
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.blockId, 'p3');
  assert.deepEqual(conflicts[0]!.theirs, { type: 'paragraph', runs: [{ text: 'agent text' }] });
  assert.ok(feedback.some((event) => event.kind === 'conflict'));
  assert.ok(interaction.getState().conflicts.p3);
  interaction.edit.flush('p3');
  assert.equal(text(editor, 'p3'), 'agent text', 'the agent edit is untouched');
  assert.deepEqual(interaction.edit.draftContent('p3'), { type: 'paragraph', runs: [{ text: 'my draft' }] }, 'the local draft is kept');
  interaction.edit.resolveConflict('p3', 'mine');
  assert.equal(text(editor, 'p3'), 'my draft');
  assert.equal(interaction.getState().conflicts.p3, undefined);
  // Resolve "theirs": drop the draft and show the document's text.
  interaction.edit.input('p3', 'main', [{ text: 'second draft' }]);
  ok(editor.apply({ id: 'agent-2', actor: { id: 'agent', kind: 'agent' }, baseRevision: editor.getSnapshot().revision, operations: [{ type: 'updateBlock', blockId: 'p3', expectedVersion: get(editor, 'p3').version, content: { type: 'paragraph', runs: [{ text: 'agent again' }] } }] }));
  interaction.edit.resolveConflict('p3', 'theirs');
  assert.equal(interaction.edit.draftContent('p3') && (interaction.edit.draftContent('p3') as { runs: InlineRun[] }).runs[0]!.text, 'agent again');
  interaction.destroy();
});

test('a clean draft quietly follows an external change; deleting the block under a dirty draft reports the lost text', () => {
  const { editor, interaction, conflicts } = harness(doc(), { commitDelayMs: 1_000 });
  interaction.edit.start('p3');
  interaction.edit.input('p3', 'main', [{ text: 'unsent words' }]);
  ok(editor.apply({ id: 'agent-del', actor: { id: 'agent', kind: 'agent' }, baseRevision: editor.getSnapshot().revision, operations: [{ type: 'deleteBlock', blockId: 'p3', expectedVersion: get(editor, 'p3').version }] }));
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0]!.mine, { type: 'paragraph', runs: [{ text: 'unsent words' }] });
  assert.equal(interaction.getState().editing, null);
  interaction.destroy();
});

test('structural commands report a conflict through onConflict when they lose a race', () => {
  const real = seed(doc());
  let raced = false;
  const racing: Editor = { ...real, apply(value: unknown) {
    if (!raced) { raced = true; real.apply({ id: 'race-1', actor: { id: 'other', kind: 'agent' }, baseRevision: real.getSnapshot().revision, operations: [{ type: 'setTitle', title: 'Changed elsewhere' }] }); }
    return real.apply(value);
  } };
  const { interaction, conflicts, feedback } = harness([], {}, racing);
  const revision = real.getSnapshot().revision;
  const result = interaction.commands.deleteBlocks(['p4']);
  assert.equal(result?.ok, false);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.command, 'deleteBlocks');
  assert.equal(feedback.at(-1)!.kind, 'conflict');
  assert.equal(real.getSnapshot().revision, revision + 1, 'only the other writer committed');
  ok(interaction.commands.deleteBlocks(['p4']));
});

test('Enter splits at the caret, keeps marks on both halves and continues in the new block', () => {
  const { editor, interaction } = harness([b.paragraph('p', 'hello **bold world**')]);
  interaction.edit.start('p', { caret: 9 });
  assert.equal(interaction.edit.enter(), true);
  const [first, second] = editor.getSnapshot().blocks;
  assert.deepEqual(first!.content, { type: 'paragraph', runs: [{ text: 'hello ' }, { text: 'bol', bold: true }] });
  assert.deepEqual(second!.content, { type: 'paragraph', runs: [{ text: 'd world', bold: true }] });
  assert.equal(interaction.getState().editing?.blockId, second!.id);
  assert.equal(interaction.getState().editing?.caret, 'start');
  assert.equal(editor.getRevisions().at(-1)!.operations.length, 2, 'split is one atomic transaction');
});

test('Enter at the start of a block inserts an empty paragraph above and keeps the caret', () => {
  const { editor, interaction } = harness([b.paragraph('a', 'first'), b.paragraph('b', 'second')]);
  interaction.edit.start('b', { caret: 0 });
  interaction.edit.enter();
  assert.deepEqual(order(editor).length, 3);
  assert.equal(order(editor)[2], 'b');
  assert.equal(text(editor, 'b'), 'second');
  assert.equal(text(editor, order(editor)[1]!), '');
  assert.equal(interaction.getState().editing?.blockId, 'b');
});

test('Enter in headings, sections, toggles and quotes', () => {
  const { editor, interaction } = harness([b.heading('h', 2, 'Title here'), b.section('s', 'Sec title'), b.toggle('t', 'Toggle', { open: false }), b.quote('q', 'quote')]);
  interaction.edit.start('h', { caret: 5 });
  interaction.edit.enter();
  assert.equal(text(editor, 'h'), 'Title');
  const next = order(editor)[1]!;
  assert.deepEqual(get(editor, next).content, { type: 'paragraph', runs: [{ text: ' here' }] });
  interaction.edit.start('s', { caret: 'end' });
  interaction.edit.enter();
  const child = editor.getSnapshot().blocks.find((block) => block.parentId === 's')!;
  assert.equal(child.content.type, 'paragraph');
  assert.equal(interaction.getState().editing?.blockId, child.id);
  interaction.edit.start('t', { caret: 'end' });
  interaction.edit.enter();
  assert.equal((get(editor, 't').content as { open: boolean }).open, true, 'opens the toggle to show the new child');
  assert.ok(editor.getSnapshot().blocks.some((block) => block.parentId === 't'));
  // An empty quote line leaves the quote.
  interaction.edit.start('q', { caret: 'end' });
  interaction.edit.enter();
  const split = order(editor).indexOf('q');
  assert.equal(get(editor, 'q').content.type, 'quote');
  const emptyQuote = order(editor)[split + 1]!;
  assert.equal(get(editor, emptyQuote).content.type, 'paragraph', 'the new line after a quote is a paragraph');
});

test('lists: Enter adds an item, an empty item leaves the list, Tab indents, Backspace outdents or merges', () => {
  const { editor, interaction } = harness([b.list('l', ['one', 'two'], { style: 'bullet' }), b.paragraph('after', 'after')]);
  interaction.edit.start('l', { field: 'item:1', caret: 'end' });
  interaction.edit.enter();
  let content = get(editor, 'l').content as { items: string[] };
  assert.deepEqual(content.items, ['one', 'two', '']);
  assert.equal(interaction.getState().editing?.field, 'item:2');
  assert.equal(interaction.edit.indent(1), true);
  content = get(editor, 'l').content as never;
  assert.deepEqual((interaction.edit.draftContent('l') as { indent?: number[] }).indent, [0, 0, 1]);
  interaction.edit.flush('l');
  interaction.edit.enter(); // empty indented item: outdent first
  assert.equal((get(editor, 'l').content as { indent?: number[] }).indent, undefined);
  interaction.edit.enter(); // empty item at level 0: leaves the list
  assert.deepEqual((get(editor, 'l').content as { items: string[] }).items, ['one', 'two']);
  const created = order(editor)[1]!;
  assert.equal(get(editor, created).content.type, 'paragraph');
  assert.equal(interaction.getState().editing?.blockId, created);
  // Backspace at the start of an item merges it into the previous one.
  interaction.edit.start('l', { field: 'item:1', caret: 0 });
  interaction.edit.backspace();
  assert.deepEqual((get(editor, 'l').content as { items: string[] }).items, ['onetwo']);
  assert.equal(interaction.getState().editing?.field, 'item:0');
  // First item at the start becomes a paragraph.
  interaction.edit.start('l', { field: 'item:0', caret: 0 });
  interaction.edit.backspace();
  assert.equal(get(editor, 'l').content.type, 'paragraph');
});

test('an empty item in the middle of a list splits it around a new paragraph', () => {
  const { editor, interaction } = harness([b.list('l', ['a', '', 'c'])]);
  interaction.edit.start('l', { field: 'item:1', caret: 0 });
  interaction.edit.enter();
  const blocks = editor.getSnapshot().blocks;
  assert.equal(blocks.length, 3);
  assert.deepEqual((blocks[0]!.content as { items: string[] }).items, ['a']);
  assert.equal(blocks[1]!.content.type, 'paragraph');
  assert.deepEqual((blocks[2]!.content as { items: string[] }).items, ['c']);
});

test('Backspace: empty block deletes and focuses the previous; at start of a heading turns it into text; paragraphs merge', () => {
  const { editor, interaction } = harness([b.paragraph('a', 'one'), b.paragraph('empty', ''), b.heading('h', 1, 'Head'), b.paragraph('b', 'two'), b.paragraph('c', 'three')]);
  interaction.edit.start('empty');
  assert.equal(interaction.edit.backspace(), true);
  assert.equal(order(editor).includes('empty'), false);
  assert.equal(interaction.getState().editing?.blockId, 'a');
  assert.equal(interaction.getState().editing?.caret, 'end');
  interaction.edit.start('h', { caret: 0 });
  interaction.edit.backspace();
  assert.deepEqual(get(editor, 'h').content, { type: 'paragraph', runs: [{ text: 'Head' }] });
  interaction.edit.start('b', { caret: 0 });
  interaction.edit.backspace();
  assert.equal(text(editor, 'h'), 'Headtwo');
  assert.equal(order(editor).includes('b'), false);
  assert.equal(interaction.getState().editing?.caret, 4);
  // Mid-text Backspace is left to the browser.
  interaction.edit.start('c', { caret: 2 });
  assert.equal(interaction.edit.backspace(), false);
  // The only block of the document stays.
  const solo = harness([b.paragraph('only', '')]);
  solo.interaction.edit.start('only');
  assert.equal(solo.interaction.edit.backspace(), false);
  assert.deepEqual(order(solo.editor), ['only']);
});

test('Backspace after a non-text neighbour selects it instead of merging', () => {
  const { editor, interaction } = harness([b.divider('div'), b.paragraph('p', '')]);
  interaction.edit.start('p');
  interaction.edit.backspace();
  assert.deepEqual(order(editor), ['div']);
  assert.deepEqual(interaction.getState().selection.ids, ['div']);
});

test('markdown input rules convert the paragraph, keep editing, and one Backspace undoes the conversion', () => {
  const { editor, interaction } = harness([b.paragraph('p', '')]);
  interaction.edit.start('p');
  interaction.edit.input('p', 'main', [{ text: '## ' }], { caret: 3, data: ' ' });
  assert.deepEqual(get(editor, 'p').content, { type: 'heading', level: 2, text: '' });
  assert.equal(interaction.getState().editing?.blockId, 'p');
  interaction.edit.reportSelection('p', 'main', 4, 4);
  assert.equal(interaction.edit.backspace(), false, 'moving the caret away ends the undo-the-rule window');
  assert.deepEqual(get(editor, 'p').content, { type: 'heading', level: 2, text: '' });
  const second = harness([b.paragraph('q', '')]);
  second.interaction.edit.start('q');
  second.interaction.edit.input('q', 'main', [{ text: '- ' }], { caret: 2, data: ' ' });
  assert.equal(get(second.editor, 'q').content.type, 'list');
  assert.equal(second.interaction.getState().editing?.field, 'item:0');
  const third = harness([b.paragraph('r', '')]);
  third.interaction.edit.start('r');
  third.interaction.edit.input('r', 'main', [{ text: '---' }], { caret: 3, data: '-' });
  assert.equal(get(third.editor, 'r').content.type, 'divider');
  assert.equal(order(third.editor).length, 2, 'a paragraph follows the divider');
  assert.equal(third.interaction.getState().editing?.blockId, order(third.editor)[1]);
});

test('Backspace right after an input rule restores the typed text', () => {
  const { editor, interaction } = harness([b.paragraph('p', '')]);
  interaction.edit.start('p');
  interaction.edit.input('p', 'main', [{ text: '> ' }], { caret: 2, data: ' ' });
  assert.equal(get(editor, 'p').content.type, 'quote');
  assert.equal(interaction.edit.backspace(), true);
  assert.deepEqual(get(editor, 'p').content, { type: 'paragraph', runs: [{ text: '> ' }] });
});

test('slash menu: "/" opens at the caret, query filters, Enter replaces the empty paragraph and keeps typing', () => {
  const { editor, interaction } = harness([b.paragraph('p', 'intro'), b.paragraph('e', '')]);
  interaction.edit.start('e');
  interaction.edit.input('e', 'main', [{ text: '/' }], { caret: 1, data: '/' });
  assert.ok(interaction.getState().slash);
  assert.equal(interaction.getState().slash!.anchor, 0);
  interaction.edit.input('e', 'main', [{ text: '/head' }], { caret: 5, data: 'd' });
  assert.equal(interaction.getState().slash!.query, 'head');
  assert.equal(interaction.getState().slash!.items[0]!.id, 'heading1');
  interaction.slash.move(1);
  assert.equal(interaction.getState().slash!.activeIndex, 1);
  ok(interaction.slash.run());
  assert.deepEqual(get(editor, 'e').content, { type: 'heading', level: 2, text: '' });
  assert.equal(interaction.getState().slash, null);
  assert.equal(interaction.getState().editing?.blockId, 'e');
  // An input method may insert "/ch" in one go: the menu still opens, already filtered.
  interaction.edit.start('p');
  interaction.edit.input('p', 'main', [{ text: 'intro /ch' }], { caret: 9, data: ' /ch' });
  assert.equal(interaction.getState().slash?.query, 'ch');
  assert.equal(interaction.getState().slash?.anchor, 6);
  interaction.slash.close();
  interaction.edit.input('p', 'main', [{ text: 'intro' }], { caret: 5, data: null });
  // "/" in the middle of a word does not open the menu.
  interaction.edit.start('p');
  interaction.edit.input('p', 'main', [{ text: 'intro/' }], { caret: 6, data: '/' });
  assert.equal(interaction.getState().slash, null);
});

test('slash on a non-empty paragraph inserts after it and strips the typed command', () => {
  const { editor, interaction } = harness([b.paragraph('p', 'keep this')]);
  interaction.edit.start('p');
  interaction.edit.input('p', 'main', [{ text: 'keep this /chart' }], { caret: 16, data: 't' });
  interaction.edit.input('p', 'main', [{ text: 'keep this /bar' }], { caret: 14, data: 'r' });
  assert.equal(interaction.getState().slash, null, 'a slash that does not start a word never opened a menu');
  interaction.edit.input('p', 'main', [{ text: 'keep this ' }], { caret: 10, data: null });
  interaction.edit.input('p', 'main', [{ text: 'keep this /' }], { caret: 11, data: '/' });
  assert.equal(interaction.getState().slash?.anchor, 10);
  interaction.slash.setQuery('bar');
  assert.equal(interaction.getState().slash!.items[0]!.id, 'chart-bar');
  interaction.edit.input('p', 'main', [{ text: 'keep this /bar' }], { caret: 14, data: 'r' });
  ok(interaction.slash.run());
  assert.equal(text(editor, 'p').trim(), 'keep this');
  const chart = editor.getSnapshot().blocks.find((block) => block.content.type === 'chart')!;
  assert.equal(chart.content.type === 'chart' && chart.content.spec.kind, 'bar');
  assert.equal(order(editor).length, 3, 'a paragraph follows so typing can continue');
  assert.equal(get(editor, order(editor)[2]!).content.type, 'paragraph');
  assert.equal(interaction.getState().editing?.blockId, order(editor)[2]);
});

test('the + button opens the menu on a fresh paragraph after the block (first child for containers)', () => {
  const { editor, interaction } = harness([b.paragraph('p', 'one'), b.section('s', 'S'), b.paragraph('q', '')]);
  interaction.slash.openAfter('p');
  const state = interaction.getState().slash!;
  assert.equal(state.insertAfter, true);
  assert.equal(order(editor)[1], state.blockId);
  assert.equal(get(editor, state.blockId).parentId, null);
  interaction.slash.setQuery('divider');
  ok(interaction.slash.run());
  assert.equal(get(editor, state.blockId).content.type, 'divider');
  interaction.slash.openAfter('s');
  const inner = interaction.getState().slash!.blockId;
  assert.equal(get(editor, inner).parentId, 's');
  interaction.slash.close();
  interaction.slash.openAfter('q');
  assert.equal(interaction.getState().slash!.blockId, 'q', 'an empty paragraph is reused');
});

test('blocks that need a URL ask for it first and reject non-https input', () => {
  const { editor, interaction } = harness([b.paragraph('p', '')]);
  interaction.slash.openAfter('p');
  interaction.slash.setQuery('image');
  assert.equal(interaction.slash.run(), null);
  const prompt = interaction.getState().prompt;
  assert.equal(prompt?.kind, 'url');
  assert.equal(interaction.slash.submitInput('http://insecure.example/x.png'), null);
  assert.match((interaction.getState().prompt as { error: string }).error, /https/);
  ok(interaction.slash.submitInput('https://example.com/figure.png'));
  assert.deepEqual(get(editor, 'p').content, { type: 'image', url: 'https://example.com/figure.png', alt: '' });
  assert.equal(interaction.getState().prompt, null);
});

test('formatting: toggle marks on the selection, word fallback, highlight and https-only links', () => {
  const { editor, interaction } = harness([b.paragraph('p', 'hello big world')]);
  interaction.edit.start('p', { caret: 6, selectEnd: 9 });
  assert.equal(interaction.format.toggle('bold'), true);
  assert.deepEqual((interaction.edit.draftContent('p') as { runs: InlineRun[] }).runs, [{ text: 'hello ' }, { text: 'big', bold: true }, { text: ' world' }]);
  interaction.format.toggle('bold');
  assert.equal((interaction.edit.draftContent('p') as { runs: InlineRun[] }).runs.length, 1);
  interaction.edit.start('p', { caret: 7 });
  interaction.format.toggle('italic');
  assert.deepEqual((interaction.edit.draftContent('p') as { runs: InlineRun[] }).runs[1], { text: 'big', italic: true }, 'a caret formats the word under it');
  interaction.edit.start('p', { caret: 0, selectEnd: 5 });
  interaction.format.highlight('green');
  assert.equal((interaction.edit.draftContent('p') as { runs: InlineRun[] }).runs[0]!.highlight, 'green');
  assert.equal(interaction.format.openLink(), true);
  assert.equal(interaction.format.applyLink('javascript:alert(1)'), false);
  assert.match((interaction.getState().prompt as { error: string }).error, /https/);
  assert.equal(interaction.format.applyLink('http://plain.example'), false);
  assert.equal(interaction.format.applyLink('example.com/page'), true);
  assert.equal((interaction.edit.draftContent('p') as { runs: InlineRun[] }).runs[0]!.href, 'https://example.com/page');
  interaction.edit.flush('p');
  assert.equal((get(editor, 'p').content as { runs: InlineRun[] }).runs[0]!.href, 'https://example.com/page');
  const loose = harness([b.paragraph('p', 'abc')], { linkSchemes: 'http-https' });
  loose.interaction.edit.start('p', { caret: 0, selectEnd: 3 });
  loose.interaction.format.openLink();
  assert.equal(loose.interaction.format.applyLink('http://intranet.example/x'), true);
});

test('shortcuts drive the layer end to end (Mod+B, Mod+Alt+2, Mod+D, Alt+Shift+Arrow, Mod+Z)', () => {
  const { editor, interaction } = harness([b.paragraph('a', 'one'), b.paragraph('b', 'two words')]);
  interaction.edit.start('b', { caret: 0, selectEnd: 3 });
  const pressed = (name: string, extra: Parameters<typeof key>[1] = {}) => { const event = key(name, { ctrlKey: true, ...extra }); return { handled: interaction.shortcuts.handleKeyDown(event), prevented: event.prevented }; };
  assert.deepEqual(pressed('b', { code: 'KeyB' }), { handled: true, prevented: true });
  assert.equal((interaction.edit.draftContent('b') as { runs: InlineRun[] }).runs[0]!.bold, true);
  assert.equal(pressed('2', { altKey: true, code: 'Digit2' }).handled, true);
  assert.equal(get(editor, 'b').content.type, 'heading');
  assert.equal(pressed('d', { code: 'KeyD' }).handled, true);
  assert.equal(order(editor).length, 3);
  interaction.edit.start('b');
  assert.equal(pressed('ArrowUp', { ctrlKey: false, altKey: true, shiftKey: true }).handled, true);
  assert.equal(order(editor)[0], 'b');
  assert.equal(pressed('z', { code: 'KeyZ' }).handled, true);
  assert.equal(editor.getRevisions().at(-1)!.kind, 'undo');
  assert.equal(pressed('/', { code: 'Slash' }).handled, true);
  assert.equal(interaction.getState().help, true);
  assert.equal(interaction.escape(), true);
  assert.equal(interaction.getState().help, false);
});

test('Mod+A selects the text first, then all blocks; Esc steps out; arrows move a block selection', () => {
  const { interaction } = harness([b.paragraph('a', 'one'), b.paragraph('b', 'two')]);
  const press = (name: string, extra: Parameters<typeof key>[1] = {}) => interaction.shortcuts.handleKeyDown(key(name, { ctrlKey: false, ...extra }));
  interaction.edit.start('a', { caret: 1 });
  assert.equal(press('a', { ctrlKey: true, code: 'KeyA' }), false, 'first press is the browser’s own select-all inside the text');
  interaction.edit.start('a', { caret: 0, selectEnd: 3 });
  assert.equal(press('a', { ctrlKey: true, code: 'KeyA' }), true);
  assert.deepEqual(interaction.getState().selection.ids, ['a', 'b']);
  assert.equal(interaction.getState().editing, null);
  interaction.selection.select('a');
  assert.equal(press('ArrowDown'), true);
  assert.deepEqual(interaction.getState().selection.ids, ['b']);
  assert.equal(press('Enter'), true);
  assert.equal(interaction.getState().editing?.blockId, 'b');
  assert.equal(press('Escape'), true);
  assert.deepEqual(interaction.getState().selection.ids, ['b']);
  assert.equal(press('Escape'), true);
  assert.deepEqual(interaction.getState().selection.ids, []);
});

test('arrow navigation crosses fields, cells and blocks; non-text neighbours are selected', () => {
  const { editor, interaction } = harness([b.paragraph('a', 'aa'), b.list('l', ['x', 'y']), b.table('t', ['H1', 'H2'], [['1', '2']]), b.divider('d'), b.paragraph('z', 'zz')]);
  interaction.edit.start('a', { caret: 'end' });
  assert.equal(interaction.edit.navigate('down'), true);
  assert.deepEqual([interaction.getState().editing?.blockId, interaction.getState().editing?.field], ['l', 'item:0']);
  assert.equal(interaction.edit.navigate('down'), true);
  assert.equal(interaction.getState().editing?.field, 'item:1');
  interaction.edit.navigate('down');
  assert.deepEqual([interaction.getState().editing?.blockId, interaction.getState().editing?.field], ['t', 'cell:-1:0']);
  interaction.edit.start('t', { field: 'cell:-1:0', caret: 'end' });
  interaction.edit.navigate('right');
  assert.equal(interaction.getState().editing?.field, 'cell:-1:1');
  interaction.edit.start('t', { field: 'cell:-1:1', caret: 'end' });
  interaction.edit.navigate('right');
  assert.equal(interaction.getState().editing?.field, 'cell:0:0', 'wraps to the next row');
  interaction.edit.start('t', { field: 'cell:0:1', caret: 'end' });
  interaction.edit.navigate('down');
  assert.deepEqual(interaction.getState().selection.ids, ['d']);
  assert.equal(interaction.getState().editing, null);
  interaction.edit.start('z', { caret: 0 });
  assert.equal(interaction.edit.navigate('up'), true);
  assert.deepEqual(interaction.getState().selection.ids, ['d']);
  interaction.edit.start('a', { caret: 1 });
  assert.equal(interaction.edit.navigate('left'), false, 'not at the edge: the browser moves the caret');
  assert.equal(editor.getSnapshot().blocks.length, 5);
});

test('todo checkboxes, toggle open state and table edits are guarded updates', () => {
  const { editor, interaction } = harness([b.list('todo', ['a', 'b'], { style: 'todo', checked: [false, true] }), b.toggle('tg', 'More', { open: false }), b.table('t', ['A', 'B'], [['1', '2']])]);
  ok(interaction.commands.setChecked('todo', 0, true));
  assert.deepEqual((get(editor, 'todo').content as { checked: boolean[] }).checked, [true, true]);
  assert.equal(interaction.commands.setChecked('t', 0, true), null);
  ok(interaction.commands.setOpen('tg', true));
  assert.equal((get(editor, 'tg').content as { open: boolean }).open, true);
  ok(interaction.commands.table.addRow('t'));
  ok(interaction.commands.table.addColumn('t'));
  const table = get(editor, 't').content as { columns: string[]; rows: string[][]; align?: string[] };
  assert.deepEqual(table.columns, ['A', 'B', 'Column 3']);
  assert.deepEqual(table.rows, [['1', '2', ''], ['', '', '']]);
  ok(interaction.commands.table.setAlign('t', 2, 'right'));
  assert.deepEqual((get(editor, 't').content as { align: string[] }).align, ['left', 'left', 'right']);
  ok(interaction.commands.table.removeColumn('t', 0));
  ok(interaction.commands.table.removeRow('t', 1));
  const final = get(editor, 't').content as { columns: string[]; rows: string[][]; align: string[] };
  assert.deepEqual([final.columns, final.rows, final.align], [['B', 'Column 3'], [['2', '']], ['left', 'right']]);
  assert.equal(interaction.commands.table.removeColumn('t', 5), null);
});

test('chart quick edit patches title, kind and layout and only offers kinds the data supports', () => {
  const { editor, interaction } = harness([b.chart('c', CHART_TEMPLATES.bar()), b.chart('multi', { kind: 'bar', title: 'M', labels: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [3, 4] }] })]);
  const specOf = (id: string) => { const content = get(editor, id).content; assert.equal(content.type, 'chart'); return (content as Extract<typeof content, { type: 'chart' }>).spec; };
  assert.ok(compatibleChartKinds(specOf('c')).includes('donut'));
  assert.equal(compatibleChartKinds(specOf('multi')).includes('pie'), false);
  assert.equal(compatibleChartKinds(specOf('c')).includes('scatter'), false);
  ok(interaction.commands.patchChart('c', { title: 'Revenue', kind: 'line', caption: '', stacked: true, horizontal: true }));
  const spec = (get(editor, 'c').content as { spec: { title: string; kind: string; caption?: string; stacked?: boolean } }).spec;
  assert.deepEqual([spec.title, spec.kind, spec.caption, spec.stacked], ['Revenue', 'line', undefined, true]);
  assert.equal(interaction.commands.patchChart('c', { kind: 'scatter' })?.ok, false, 'invalid kind for the data is rejected by core, not applied');
  assert.equal(specOf('c').kind, 'line');
  interaction.openChartEditor('c');
  assert.equal(interaction.getState().chartEditor, 'c');
  assert.equal(interaction.escape(), true);
  assert.equal(interaction.getState().chartEditor, null);
});

test('block menu offers the right actions and runs them', () => {
  const { editor, interaction } = harness([b.paragraph('p', 'one'), b.chart('c', CHART_TEMPLATES.pie()), b.section('s', 'S'), b.paragraph('in', 'inner', { parentId: 's' })], { copyText: () => undefined });
  interaction.menu.open(['p'], 'p');
  assert.deepEqual(interaction.getState().menu, { blockIds: ['p'], anchorId: 'p', submenu: null });
  const ids = interaction.menu.actions().map((action) => action.id);
  assert.deepEqual(ids, ['turn-into', 'duplicate', 'copy-id', 'copy-link', 'copy', 'move-up', 'move-down', 'delete']);
  const turn = interaction.menu.actions().find((action) => action.id === 'turn-into')!;
  assert.ok(turn.children!.find((child) => child.id === 'turn:paragraph')!.current);
  interaction.menu.run('turn-into');
  assert.equal(interaction.getState().menu!.submenu, 'turn-into');
  interaction.menu.run('turn:heading1');
  assert.equal(get(editor, 'p').content.type, 'heading');
  assert.equal(interaction.getState().menu, null);
  interaction.menu.open(['c']);
  assert.equal(interaction.menu.actions()[0]!.id, 'edit-chart');
  assert.equal(interaction.menu.actions().some((action) => action.id === 'turn-into'), false);
  interaction.menu.run('edit-chart');
  assert.equal(interaction.getState().chartEditor, 'c');
  interaction.menu.open(['in']);
  assert.ok(interaction.menu.actions().some((action) => action.id === 'move-out'));
  interaction.menu.run('move-out');
  assert.equal(get(editor, 'in').parentId, null);
  interaction.menu.open(['p', 'c']);
  interaction.menu.run('delete');
  assert.equal(order(editor).includes('p'), false);
  assert.equal(order(editor).includes('c'), false);
});

test('copy writes markdown and a lossless flavour; paste rebuilds blocks with fresh ids and drops unknown citations', () => {
  const { editor, interaction } = harness([b.heading('h', 2, 'Title'), b.paragraph('p', 'see **this** [^src]'), b.list('l', ['a', 'b'], { style: 'todo', checked: [true, false] }), b.section('s', 'Sec'), b.paragraph('in', 'inside', { parentId: 's' })]);
  interaction.selection.set(['h', 'p', 'l', 's']);
  const data = new Map<string, string>();
  const transfer = { getData: (type: string) => data.get(type) ?? '', setData: (type: string, value: string) => { data.set(type, value); } };
  assert.equal(interaction.clipboard.copy(transfer), true);
  const markdown = data.get('text/plain')!;
  assert.match(markdown, /^## Title/);
  assert.match(markdown, /\*\*this\*\*/);
  assert.match(markdown, /- \[x\] a/);
  assert.match(markdown, /inside/);
  assert.ok(data.get(CLIPBOARD_MIME));
  interaction.selection.set(['in']);
  assert.equal(interaction.clipboard.paste(transfer), true);
  const blocks = editor.getSnapshot().blocks;
  assert.equal(blocks.length, 5 + 5, 'every selected block and its child came back');
  const pastedIds = blocks.map((block) => block.id).filter((id) => !['h', 'p', 'l', 's', 'in'].includes(id));
  assert.equal(pastedIds.length, 5);
  const pastedSection = blocks.find((block) => pastedIds.includes(block.id) && block.content.type === 'section')!;
  assert.equal(blocks.find((block) => block.parentId === pastedSection.id)?.content.type, 'paragraph');
  const foreign = JSON.stringify({ v: 1, blocks: [{ id: 'x', parentId: null, content: { type: 'paragraph', runs: [{ text: 'cited', citationId: 'missing' }] }, citationIds: ['missing'] }] });
  const parsed = parseBlocksPayload(foreign, editor.getSnapshot(), (prefix) => `${prefix}-fresh`)!;
  assert.deepEqual(parsed[0]!.citationIds, []);
  assert.equal((parsed[0]!.content as { runs: InlineRun[] }).runs[0]!.citationId, undefined);
  assert.equal(parseBlocksPayload('{"v":2}', editor.getSnapshot(), (prefix) => prefix), null);
  assert.equal(parseBlocksPayload('not json', editor.getSnapshot(), (prefix) => prefix), null);
  assert.equal(serializeBlocks(editor.getSnapshot(), []), null);
});

test('cut removes the selection after copying it', () => {
  const { editor, interaction } = harness(doc());
  interaction.selection.set(['p3']);
  const data = new Map<string, string>();
  assert.equal(interaction.clipboard.cut({ getData: (t) => data.get(t) ?? '', setData: (t, v) => { data.set(t, v); } }), true);
  assert.equal(order(editor).includes('p3'), false);
  assert.equal(data.get('text/plain'), 'gamma');
});

test('paste planning: URL over a selection links, lines become paragraphs, markdown becomes blocks, single lines stay inline', () => {
  const ids = (prefix: string) => `${prefix}-x${++counter}`;
  assert.deepEqual(planPaste('https://example.com/a', { hasSelection: true, inRichField: true }, ids), { kind: 'link', href: 'https://example.com/a' });
  assert.equal(planPaste('https://example.com/a', { hasSelection: false, inRichField: true }, ids)?.kind, 'inline');
  assert.equal(planPaste('http://example.com/a', { hasSelection: true, inRichField: true }, ids)?.kind, 'inline', 'http is not linked by default');
  assert.equal(planPaste('http://example.com/a', { hasSelection: true, inRichField: true, linkSchemes: 'http-https' }, ids)?.kind, 'link');
  const plain = planPaste('one\ntwo\n\nthree', { hasSelection: false, inRichField: true }, ids);
  assert.equal(plain?.kind, 'blocks');
  assert.deepEqual(plain?.kind === 'blocks' && plain.blocks.map((block) => block.content.type), ['paragraph', 'paragraph', 'paragraph']);
  const md = planPaste('# Head\n\n- a\n- b\n\n| x | y |\n| --- | --- |\n| 1 | 2 |\n\n```ts\ncode\n```', { hasSelection: false, inRichField: true }, ids);
  assert.deepEqual(md?.kind === 'blocks' && md.blocks.map((block) => block.content.type), ['heading', 'list', 'table', 'code']);
  const inline = planPaste('a **bold** word', { hasSelection: false, inRichField: true }, ids);
  assert.deepEqual(inline?.kind === 'inline' && inline.runs, [{ text: 'a ' }, { text: 'bold', bold: true }, { text: ' word' }]);
  assert.deepEqual(planPaste('a **bold** word', { hasSelection: false, inRichField: false }, ids)?.kind === 'inline' && (planPaste('a **bold** word', { hasSelection: false, inRichField: false }, ids) as { runs: InlineRun[] }).runs, [{ text: 'a **bold** word' }]);
  assert.equal(planPaste('   \n  ', { hasSelection: false, inRichField: true }, ids), null);
});

test('pasting text into a paragraph being edited: inline at the caret, URL becomes a link, markdown becomes blocks after it', () => {
  const { editor, interaction } = harness([b.paragraph('p', 'hello world')]);
  const paste = (value: string) => interaction.clipboard.paste({ getData: (type) => type === 'text/plain' ? value : '', setData: () => undefined });
  interaction.edit.start('p', { caret: 5 });
  assert.equal(paste(', **dear**'), true);
  assert.deepEqual((interaction.edit.draftContent('p') as { runs: InlineRun[] }).runs, [{ text: 'hello, ' }, { text: 'dear', bold: true }, { text: ' world' }]);
  interaction.edit.start('p', { caret: 0, selectEnd: 5 });
  assert.equal(paste('https://example.com/dest'), true);
  assert.equal((interaction.edit.draftContent('p') as { runs: InlineRun[] }).runs[0]!.href, 'https://example.com/dest');
  interaction.edit.start('p', { caret: 'end' });
  assert.equal(paste('# New\n\nbody text'), true);
  const types = editor.getSnapshot().blocks.map((block) => block.content.type);
  assert.deepEqual(types, ['paragraph', 'heading', 'paragraph']);
  assert.equal(interaction.getState().editing?.blockId, order(editor)[2]);
});

test('pasting multiple lines over an empty paragraph replaces it', () => {
  const { editor, interaction } = harness([b.paragraph('a', 'keep'), b.paragraph('e', '')]);
  interaction.edit.start('e');
  assert.equal(interaction.clipboard.paste({ getData: (type) => type === 'text/plain' ? 'one\ntwo' : '', setData: () => undefined }), true);
  assert.deepEqual(editor.getSnapshot().blocks.map((block) => block.id === 'e' ? 'E' : text(editor, block.id)), ['keep', 'one', 'two']);
});

test('headless layer survives document changes from other writers (selection, hover, menu, editing are pruned)', () => {
  const { editor, interaction } = harness(doc());
  interaction.selection.set(['p3', 'p4']);
  interaction.setHover('p4');
  interaction.menu.open(['p4']);
  ok(editor.apply({ id: 'x-del', actor: { id: 'agent', kind: 'agent' }, baseRevision: editor.getSnapshot().revision, operations: [{ type: 'deleteBlock', blockId: 'p4', expectedVersion: get(editor, 'p4').version }] }));
  const state = interaction.getState();
  assert.deepEqual(state.selection.ids, [], 'opening the menu selected p4, which is gone');
  assert.equal(state.hover, null);
  assert.equal(state.menu, null);
  interaction.destroy();
  assert.equal(interaction.edit.start('p1'), false, 'destroyed layers do nothing');
});
