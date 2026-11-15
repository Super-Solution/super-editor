// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Browser, Page } from 'playwright';
import { ReportView } from '../packages/bindings/react/src/index.js';
import { createResearchExample } from '../examples/report.js';
import { launch, packagedCss } from './helpers.js';

let browser: Browser | null = null;
before(async () => { browser = await launch(); });
after(async () => { await browser?.close(); });

const report = createResearchExample().getSnapshot();
async function page(viewport: { width: number; height: number }, body: string, htmlClass = ''): Promise<{ page: Page; close(): Promise<void> }> {
  const context = await browser!.newContext({ viewport });
  const tab = await context.newPage();
  await tab.setContent(`<!doctype html><html class="${htmlClass}"><head><meta charset="utf-8"><style>${packagedCss()}</style></head><body style="margin:0">${body}</body></html>`);
  return { page: tab, close: () => context.close() };
}
const view = (props: Record<string, unknown> = {}): string => renderToStaticMarkup(createElement(ReportView, { document: report, ...props }));

test('layout follows the container, not the viewport: narrow rules apply in a 360px column on a 1280px screen and not in a wide column on a phone', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const narrow = await page({ width: 1280, height: 900 }, `<div style="width:360px">${view()}</div>`);
  const wide = await page({ width: 390, height: 800 }, `<div style="width:900px">${view()}</div>`);
  try {
    const h1 = (tab: Page) => tab.locator('.super-editor-document h1').first().evaluate((node) => parseFloat(getComputedStyle(node).fontSize) / parseFloat(getComputedStyle(node.closest('.super-editor-document')!).fontSize));
    assert.ok(Math.abs((await h1(narrow.page)) - 1.75) < 0.02, `narrow column h1 ratio ${await h1(narrow.page)}`);
    assert.ok((await h1(wide.page)) > 1.9, `wide column keeps the large title (${await h1(wide.page)})`);
    const padding = (tab: Page) => tab.locator('.super-editor-document').first().evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft));
    assert.ok((await padding(narrow.page)) <= 40, `side padding gives way in a narrow column: ${await padding(narrow.page)}`);
    assert.ok((await padding(wide.page)) >= 48, `and stays generous in a wide one: ${await padding(wide.page)}`);
  } finally { await narrow.close(); await wide.close(); }
});

test('data-se-theme="host" follows an ancestor .dark class or data-theme, and host rules override tokens without specificity tricks', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const token = (tab: Page, name: string) => tab.locator('.super-editor-document').first().evaluate((node, variable) => getComputedStyle(node).getPropertyValue(variable).trim(), name);
  const light = await page({ width: 900, height: 700 }, view({ theme: 'host' }));
  const dark = await page({ width: 900, height: 700 }, view({ theme: 'host' }), 'dark');
  const attribute = await page({ width: 900, height: 700 }, `<div data-theme="dark">${view({ theme: 'host' })}</div>`);
  const override = await page({ width: 900, height: 700 }, `<style>.app [data-se-theme] { --se-text: rgb(1, 2, 3); }</style><div class="app">${view({ theme: 'light' })}</div>`);
  try {
    assert.equal(await token(light.page, '--se-surface'), '#ffffff');
    assert.equal(await token(dark.page, '--se-surface'), '#15181d');
    assert.equal(await token(attribute.page, '--se-surface'), '#15181d');
    assert.equal(await token(override.page, '--se-text'), 'rgb(1, 2, 3)');
  } finally { await light.close(); await dark.close(); await attribute.close(); await override.close(); }
});

test('the document container does not capture fixed-position layers', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const tab = await page({ width: 1000, height: 700 }, `<div style="height:2000px">${view()}<div id="layer" style="position:fixed;inset:0"></div></div>`);
  try {
    await tab.page.evaluate(() => { const layer = document.getElementById('layer')!; document.querySelector('.super-editor-document')!.append(layer); });
    const box = await tab.page.locator('#layer').boundingBox();
    assert.deepEqual([box?.width, box?.height], [1000, 700], 'a fixed child inside the container still covers the viewport');
  } finally { await tab.close(); }
});

test('timestamps and the updated time use the locale and time zone when given', async (t) => {
  if (!browser) return t.skip('no Chromium');
  const html = view({ locale: 'zh-TW', timeZone: 'Asia/Taipei' });
  assert.match(html, /2026年10月3日/);
  assert.doesNotMatch(html, /Fixture as of: 2026-10-03T/);
  assert.match(view(), /Fixture as of: 2026-10-03T00:00:00\.000Z/);
});
