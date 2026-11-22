// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import type { Browser, Page } from 'playwright';
import { launch, serveDemo, type Demo } from './helpers.js';

let browser: Browser | null = null, demo: Demo;
before(async () => { browser = await launch(); if (browser) demo = await serveDemo(); });
after(async () => { await browser?.close(); await demo?.close(); });

async function open(width = 1280, height = 900, touch = false): Promise<{ page: Page; errors: string[]; close(): Promise<void> }> {
  const context = await browser!.newContext({ viewport: { width, height }, ...(touch ? { hasTouch: true, isMobile: true } : {}) });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(demo.url);
  await page.locator('p.se-paragraph').first().waitFor();
  return { page, errors, close: () => context.close() };
}
async function focusFirstParagraph(page: Page): Promise<void> {
  const box = (await page.locator('p.se-paragraph').first().boundingBox())!;
  await page.mouse.click(box.x + box.width - 20, box.y + box.height - 8);
  await page.locator('[contenteditable=true]').first().waitFor();
}

test('typing, bold and the slash menu work in a real browser with no console errors', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const { page, errors, close } = await open();
  try {
    await focusFirstParagraph(page);
    await page.keyboard.press('End');
    await page.keyboard.type(' typed-by-playwright');
    assert.match((await page.evaluate(() => document.activeElement?.textContent)) ?? '', /typed-by-playwright$/);
    await page.keyboard.press('Shift+Home');
    await page.keyboard.press('Control+b');
    assert.ok(await page.locator('[contenteditable=true] strong, [contenteditable=true] b, [contenteditable=true] [data-bold]').count() > 0 || /font-weight|<strong|<b[ >]/.test(await page.evaluate(() => document.activeElement?.innerHTML ?? '')), 'bold applied');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('/table');
    await page.locator('[role=listbox]').waitFor();
    await page.keyboard.press('Enter');
    await page.locator('table').first().waitFor();
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('pasting HTML keeps bold and links; pasting an image file without an upload handler is refused with a notice', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const { page, errors, close } = await open();
  try {
    await focusFirstParagraph(page);
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.evaluate(() => {
      const target = document.activeElement!;
      const data = new DataTransfer();
      data.setData('text/html', '<p>Pasted <b>bold</b> and <a href="https://example.com/x">a link</a></p>');
      data.setData('text/plain', 'Pasted bold and a link');
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    const html = await page.evaluate(() => document.activeElement?.innerHTML ?? '');
    assert.match(html, /bold/);
    assert.match(html, /href="https:\/\/example\.com\/x"/);
    assert.match(html, /<(strong|b)\b|font-weight|data-bold/, html);
    await page.evaluate(() => {
      const data = new DataTransfer();
      data.items.add(new File([new Uint8Array(8)], 'shot.png', { type: 'image/png' }));
      document.activeElement!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await page.getByText(/no image upload/i).first().waitFor({ timeout: 3000 });
    assert.deepEqual(errors, []);
  } finally { await close(); }
});

test('a long document title wraps instead of being clipped', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const { page, close } = await open(1100, 800);
  try {
    const title = page.locator('textarea.se-doc-title-input').first();
    if (await title.count() === 0) return t.skip('the demo has no editable title');
    await title.fill('A deliberately very long research report title that cannot possibly fit on a single line of the document header');
    await title.blur();
    const { client, scroll } = await title.evaluate((node) => ({ client: node.clientHeight, scroll: node.scrollHeight }));
    assert.ok(scroll <= client + 1, `title is clipped: ${scroll} > ${client}`);
    assert.ok(client > 40, `title did not grow to a second line (${client}px)`);
  } finally { await close(); }
});

test('the demo is usable at phone width: no horizontal page scroll', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const { page, errors, close } = await open(390, 800, true);
  try {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 1, `page scrolls horizontally by ${overflow}px`);
    assert.deepEqual(errors, []);
  } finally { await close(); }
});
