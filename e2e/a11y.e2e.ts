// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test, { after, before } from 'node:test';
import type { Browser, Page } from 'playwright';
import { launch, serveDemo, type Demo } from './helpers.js';

/**
 * Accessibility in a real browser: axe-core (a devDependency, never shipped) on the demo in the states a person reaches, the
 * keyboard-only way into the first block, and input-method composition driven through the DevTools protocol.
 */
let browser: Browser | null = null, demo: Demo;
before(async () => { browser = await launch(); if (browser) demo = await serveDemo(); });
after(async () => { await browser?.close(); await demo?.close(); });

const axePath = createRequire(import.meta.url).resolve('axe-core/axe.min.js');
type Violation = { id: string; impact: string | null; help: string; nodes: { target: string[]; html: string; why: string }[] };

async function open(width = 1280, height = 900, scheme: 'light' | 'dark' = 'light'): Promise<{ page: Page; errors: string[]; close(): Promise<void> }> {
  const context = await browser!.newContext({ viewport: { width, height }, colorScheme: scheme });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(demo.url);
  await page.locator('p.se-paragraph').first().waitFor();
  return { page, errors, close: () => context.close() };
}
/** Runs axe on the page. Everything WCAG 2.0 to 2.2 A and AA plus axe's best practices; returns the violations. */
async function axe(page: Page, include?: string): Promise<Violation[]> {
  // Entrance animations blend colours with the page for a few frames; judge contrast on the settled state.
  await page.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))));
  if (!(await page.evaluate(() => 'axe' in window))) await page.addScriptTag({ path: axePath });
  return page.evaluate(async (scope) => {
    const result = await (window as unknown as { axe: { run(context: unknown, options: unknown): Promise<{ violations: { id: string; impact: string | null; help: string; nodes: { target: unknown[]; html: string; any: { message: string }[]; all: { message: string }[]; none: { message: string }[] }[] }[] }> } }).axe.run(scope ? { include: [scope] } : document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
    });
    return result.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.map((n) => ({ target: n.target as string[], html: n.html.slice(0, 160), why: [...n.any, ...n.all, ...n.none].map((c) => c.message).join(' | ') })) }));
  }, include ?? null);
}
const describe = (violations: Violation[]): string => violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.slice(0, 3).map((n) => `    ${n.target.join(' ')}  ${n.html}  [${n.why}]`).join('\n')}`).join('\n');
/** Fails with every violation (rule, impact, the nodes and why) so a regression names what to fix. */
async function clean(page: Page, state: string): Promise<void> {
  const violations = await axe(page);
  assert.equal(violations.length, 0, `axe found ${violations.length} violation(s) ${state}:\n${describe(violations)}`);
}
async function focusFirstParagraph(page: Page): Promise<void> {
  const box = (await page.locator('p.se-paragraph').first().boundingBox())!;
  await page.mouse.click(box.x + box.width - 20, box.y + box.height - 8);
  await page.locator('[contenteditable=true]').first().waitFor();
}
async function openSlashMenu(page: Page): Promise<void> {
  await focusFirstParagraph(page);
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await page.locator('[role=listbox]').waitFor();
}

for (const scheme of ['light', 'dark'] as const) {
  for (const width of [1280, 390]) {
    test(`axe finds nothing at rest, while editing and with the slash menu open (${width}px, ${scheme})`, async (t) => {
      if (!browser) return t.skip('no Chromium');
      const { page, errors, close } = await open(width, 900, scheme);
      try {
        await clean(page, 'at rest');
        await focusFirstParagraph(page);
        await clean(page, 'while editing a paragraph');
        await openSlashMenu(page);
        await clean(page, 'with the slash menu open');
        const field = await page.evaluate(() => { const e = document.activeElement!; return { role: e.getAttribute('role'), expanded: e.getAttribute('aria-expanded'), controls: e.getAttribute('aria-controls'), name: e.getAttribute('aria-label') }; });
        assert.equal(field.role, 'combobox', 'the field that owns the open menu is the combobox');
        assert.equal(field.expanded, 'true');
        assert.ok(field.controls && field.name, 'it names the listbox it controls and has an accessible name');
        await page.keyboard.press('Escape');
        assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('role')), 'textbox', 'closing the menu gives the field its textbox role back');
        assert.deepEqual(errors, []);
      } finally { await close(); }
    });
  }
}

const blockText = (page: Page, id: string): Promise<string> => page.evaluate((blockId) => document.querySelector(`[data-block-id="${blockId}"]`)?.textContent ?? '', id);
const announced = (page: Page): Promise<string> => page.evaluate(() => document.querySelector('.se-surface > .se-sr[role=status]')?.textContent ?? '');
async function tabToSurface(page: Page): Promise<void> {
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); window.scrollTo(0, 0); });
  for (let presses = 0; presses < 120; presses++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate(() => document.activeElement?.classList.contains('se-surface') ?? false)) return;
  }
  assert.fail('Tab never reached the document surface');
}

test('the document can be entered, read, edited and left with the keyboard alone', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const { page, errors, close } = await open();
  try {
    await tabToSurface(page);
    assert.match(await page.evaluate(() => document.getElementById(document.activeElement!.getAttribute('aria-describedby')!)?.textContent ?? ''), /Down or Enter/, 'the focused surface says how to start');
    // Down selects the first block and says what it is.
    await page.keyboard.press('ArrowDown');
    await page.locator('[data-se-selected="macro"]').waitFor();
    assert.match(await announced(page), /^Section selected: /);
    // Down again moves on; Enter edits the selected block with the caret at its end.
    await page.keyboard.press('ArrowDown');
    assert.match(await announced(page), /^Heading selected: /);
    await page.keyboard.press('Enter');
    await page.locator('[data-se-editable][data-se-block-id="macro-heading"]').waitFor();
    await page.keyboard.type(' (kb)');
    await page.keyboard.press('Escape');
    await page.locator('[data-se-selected="macro-heading"]').waitFor();
    assert.match(await blockText(page, 'macro-heading'), /\(kb\)$/, 'the typed text reached the document');
    // Leaving the selection puts the focus back on the surface, so Tab moves on from there rather than from the top.
    await page.keyboard.press('Escape');
    // The focus moves in a later task than the key press, so wait for it (and still fail, with the timeout, if it never comes).
    await page.waitForFunction(() => document.activeElement?.classList.contains('se-surface') === true, undefined, { timeout: 5000 });
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

for (const width of [320, 360, 390]) {
  test(`the selection toolbar stays on screen at ${width}px wide and the page does not crash`, async (t) => {
    if (!browser) return t.skip('no Chromium');
    const { page, errors, close } = await open(width, 844);
    try {
      await tabToSurface(page);
      await page.keyboard.press('ArrowDown');
      await page.locator('.se-selection-toolbar').waitFor();
      // The toolbar is as wide as the phone; it must slide back into view (a half-pixel feedback in the helper that did this once
      // blanked the whole page with "maximum update depth exceeded" at exactly this width).
      await page.waitForTimeout(300);
      const box = (await page.locator('.se-selection-toolbar').boundingBox())!;
      assert.ok(box.x >= 0 && box.x + box.width <= width, `toolbar spans ${Math.round(box.x)} to ${Math.round(box.x + box.width)} on a ${width}px screen`);
      assert.equal(await page.locator('.se-surface').count(), 1, 'the editor is still on the page');
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}

test('Enter on a block with no text says so instead of doing nothing; Enter on a fresh surface starts the first block', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const { page, errors, close } = await open();
  try {
    await tabToSurface(page);
    await page.keyboard.press('ArrowDown');
    for (let steps = 0; steps < 40 && !/^Embed selected/.test(await announced(page)); steps++) await page.keyboard.press('ArrowDown');
    assert.match(await announced(page), /^Embed selected/, 'Down reaches the embed');
    await page.keyboard.press('Enter');
    await page.locator('.se-toasts [role=status], .se-toasts [role=alert]').filter({ hasText: /no text to edit/i }).waitFor({ timeout: 3000 });
    assert.equal(await page.locator('[contenteditable=true]').count(), 0, 'nothing started editing');
    await page.keyboard.press('Escape');
    // Enter on a surface with nothing selected edits the first block.
    await page.keyboard.press('Enter');
    await page.locator('[data-se-editable][data-se-block-id="macro"]').waitFor();
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('headings keep their role while edited, fields have names and text runs in its own direction', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const { page, errors, close } = await open();
  try {
    await page.locator('.se-surface .se-heading').first().click();
    const heading = await page.locator('[data-se-editable]').first().evaluate((node) => ({ tag: node.tagName, role: node.getAttribute('role'), label: node.getAttribute('aria-label'), dir: node.getAttribute('dir') }));
    assert.match(heading.tag, /^H[1-6]$/);
    assert.equal(heading.role, null, 'a heading is not turned into a textbox');
    assert.equal(heading.label, null, 'its own text is its name');
    assert.equal(heading.dir, 'auto');
    await page.keyboard.press('Escape');
    await focusFirstParagraph(page);
    const paragraph = await page.locator('[data-se-editable]').first().evaluate((node) => ({ role: node.getAttribute('role'), label: node.getAttribute('aria-label'), placeholder: node.getAttribute('aria-placeholder'), dir: node.getAttribute('dir') }));
    assert.deepEqual(paragraph, { role: 'textbox', label: 'Paragraph', placeholder: "Type '/' for commands", dir: 'auto' });
    // The table's cells say where they are.
    await page.locator('.se-surface .se-table td').first().click();
    assert.match(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''), /^Row \d+, column \d+$/);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('input-method composition commits, undoes as one step and keeps emoji whole', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const { page, errors, close } = await open();
  try {
    await focusFirstParagraph(page);
    await page.keyboard.press('Control+End');
    const before = await page.evaluate(() => document.activeElement?.textContent ?? '');
    // Chromium's own IME entry points, driven through the DevTools protocol (not a real input method: see docs/ACCESSIBILITY.md).
    const client = await page.context().newCDPSession(page);
    for (const text of ['ㄋ', 'ㄋㄧ', 'ㄋㄧˇ', '你']) await client.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
    assert.ok((await page.evaluate(() => document.activeElement?.textContent ?? '')).endsWith('你'), 'the composition is shown while it is being made');
    await client.send('Input.insertText', { text: '你好' });
    await client.send('Input.insertText', { text: '😀' });
    await page.keyboard.type('𠮷');
    const typed = await page.evaluate(() => document.activeElement?.textContent ?? '');
    assert.equal(typed, `${before}你好😀𠮷`);
    await page.locator('.se-surface .se-heading').first().click();   // leave the field: the draft is committed
    await page.waitForTimeout(100);
    assert.ok((await page.locator('p.se-paragraph').first().textContent())?.endsWith(`你好😀𠮷`), 'the composed text is in the document');
    // Back in the field, one undo removes the typed run as a single step and leaves the original text.
    await page.keyboard.press('Escape');
    await focusFirstParagraph(page);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(100);
    assert.equal((await page.locator('p.se-paragraph').first().textContent())?.includes('你好'), false, 'one undo removes the whole composed run');
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`axe finds nothing with a block selected, the shortcut dialog, a table cell and a heading being edited (${scheme})`, async (t) => {
    if (!browser) return t.skip('no Chromium');
    const { page, errors, close } = await open(1280, 900, scheme);
    try {
      await tabToSurface(page);
      await page.keyboard.press('ArrowDown');
      await page.locator('[data-se-selected]').waitFor();
      await clean(page, 'a block selected');
      await page.keyboard.press('?');
      await page.locator('[role=dialog]').first().waitFor();
      await clean(page, 'the shortcut dialog');
      await page.keyboard.press('Escape');
      await page.locator('[role=dialog]').first().waitFor({ state: 'detached' });
      await page.locator('.se-surface .se-table td').first().click();
      await clean(page, 'editing a table cell');
      await page.keyboard.press('Escape');
      await page.locator('.se-surface .se-heading').first().click();
      await clean(page, 'editing a heading');
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}

test('a paragraph in a right-to-left script reads and aligns right to left, in the view and while editing', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const { page, errors, close } = await open();
  try {
    await focusFirstParagraph(page);
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText('مرحبا بالعالم، هذا نص عربي للاختبار');
    // Where the text sits inside its box: right-aligned means the text's right edge is at the box's right edge.
    const gap = (editing: boolean) => page.evaluate((isEditing) => {
      const element = (isEditing ? document.querySelector('p[data-se-editable]') : document.querySelector('.se-surface p.se-paragraph'))!;
      const range = document.createRange(); range.selectNodeContents(element);
      const text = range.getBoundingClientRect(), box = element.getBoundingClientRect();
      return { left: Math.round(text.left - box.left), right: Math.round(box.right - text.right) };
    }, editing);
    const editing = await gap(true);
    assert.ok(editing.right < editing.left, `edited text hugs the right edge (${JSON.stringify(editing)})`);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const viewing = await gap(false);
    assert.ok(viewing.right < viewing.left, `rendered text hugs the right edge (${JSON.stringify(viewing)})`);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
