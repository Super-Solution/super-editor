import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { defineSuperEditor } from '@supersolutions/super-editor-element';

// The Vue and Svelte examples are not compiled here (this repository has no Vue or Svelte dependency). What can be checked is that they
// only name attributes, methods and events the element really has, so the examples cannot drift from the component unnoticed.
const FILES = ['examples/vue/ReportEditor.vue', 'examples/svelte/ReportEditor.svelte'];
const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the framework examples use only attributes, methods and events the element documents', () => {
  const dom = new JSDOM('<!doctype html><body></body>');
  const Element = defineSuperEditor({ registry: dom.window.customElements, base: dom.window.HTMLElement as unknown as typeof HTMLElement, warn: false }) as unknown as { observedAttributes: string[]; prototype: object };
  const attributes = new Set([...Element.observedAttributes, 'credentials']);
  const methods = new Set(Object.getOwnPropertyNames(Element.prototype));
  const events = new Set(['change', 'error', 'load']);
  for (const path of FILES) {
    const source = read(path);
    // The element itself is the last <super-editor …> in the file (the header comment mentions it in prose).
    // Svelte: `{mode}` is shorthand for mode={mode}; the code inside `={ … }` (it holds `=>`) is not attribute syntax.
    let flat = source.replace(/\s\{([A-Za-z]+)\}/g, ' $1=""');
    for (let previous = ''; previous !== flat;) { previous = flat; flat = flat.replace(/\{[^{}]*\}/g, '""'); }
    const tags = [...flat.matchAll(/<super-editor\b([^>]*)>/gs)];
    const tag = tags[tags.length - 1];
    assert.ok(tag && tag[1]!.trim().length > 0, `${path} renders <super-editor> with attributes`);
    for (const match of tag[1]!.matchAll(/(?:^|\s)(?::|bind:|on|@)?([a-z][a-z-]*)(?=[=\s/>]|$)/g)) {
      const name = match[1]!;
      if (['ref', 'this', 'class', 'style', 'id'].includes(name)) continue;
      const isEvent = /(?:\s|^)(?:@|on)/.test(match[0]);
      if (isEvent) assert.ok(events.has(name), `${path}: unknown event ${name}`);
      else assert.ok(attributes.has(name) || attributes.has(name.replace(/^bind:/, '')), `${path}: unknown attribute ${name}`);
    }
    for (const method of source.matchAll(/(?:element(?:\.value)?\??)\.(load|reload|editor|document|labels)\b/g)) assert.ok(methods.has(method[1]!), `${path}: unknown member ${method[1]}`);
    for (const event of source.matchAll(/addEventListener\('([a-z]+)'/g)) assert.ok(events.has(event[1]!), `${path}: unknown event ${event[1]}`);
    assert.match(source, /basic editor/i, `${path} tells the reader that edit mode is the basic editor`);
    assert.match(source, /event\.target ===/, `${path} ignores the toolbar's native change events`);
  }
  dom.window.close();
});
