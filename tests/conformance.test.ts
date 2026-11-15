// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
// The TypeScript editor must still produce every outcome in conformance/guarded-apply.v1.json, the
// data the Go and Python ports are tested against. Regenerate with
// `npx tsx --conditions=development scripts/export-conformance.ts` (and `scripts/export-document-conformance.ts`
// for document-ops.v1.json) when behaviour changes on purpose.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createEditor, createReportService, diffDocuments, summarizeRevision } from '../packages/core/src/index.js';
import { createHttpHandler } from '../backends/typescript/api/src/index.js';
import { buildServerSpec, SPEC_COPIES } from '../scripts/server-spec.js';
import { textParts } from '../packages/core/src/text.js';
import { readActor, safeUrl, timestamp } from '../packages/core/src/validation.js';
import { validateDocument, validateTransaction } from '../packages/core/src/index.js';
import { findBlocks, fromMarkdown, getOutline, runs, stats, toHTML, toMarkdown, toPlainText } from '../packages/core/src/index.js';
import { inlineToPlain, runsToMarkdown } from '../packages/core/src/inline.js';
import { countWords } from '../packages/core/src/stats.js';

const data = JSON.parse(readFileSync(new URL('../conformance/guarded-apply.v1.json', import.meta.url), 'utf8'));

test('the reference reproduces every conformance step', () => {
  let steps = 0;
  for (const scenario of data.scenarios) {
    let current = scenario.initial.createdAt;
    const editor = createEditor(scenario.initial, { now: () => current });
    for (const [index, step] of scenario.steps.entries()) {
      current = step.now;
      const result = editor.apply(step.transaction);
      const label = `${scenario.name} step ${index}`;
      assert.equal(result.ok, step.expect.ok, label);
      if (result.ok) {
        assert.equal(result.duplicate ?? undefined, step.expect.duplicate, label);
        assert.deepEqual(JSON.parse(JSON.stringify(result.document)), step.expect.document, label);
      } else {
        assert.deepEqual(result.issues.map(issue => ({ code: issue.code, ...(issue.blockId ? { blockId: issue.blockId } : {}) })), step.expect.issues, label);
        assert.equal(result.currentRevision, step.expect.currentRevision, label);
      }
      steps++;
    }
  }
  assert.ok(steps >= 250);
});

const ops = JSON.parse(readFileSync(new URL('../conformance/document-ops.v1.json', import.meta.url), 'utf8'));

test('the reference reproduces every document-ops case', () => {
  assert.ok(ops.text_parts.length >= 150 && ops.diff.length >= 150 && ops.summarize_revision.length >= 150);
  for (const [index, c] of ops.text_parts.entries()) assert.deepEqual(textParts(c.content), c.expect, `text_parts ${index}`);
  for (const [index, c] of ops.diff.entries()) assert.deepEqual(JSON.parse(JSON.stringify(diffDocuments(c.a, c.b))), c.expect, `diff ${index}`);
  for (const [index, c] of ops.summarize_revision.entries()) assert.equal(summarizeRevision(c.revision), c.expect, `summary ${index}`);
});

const validation = JSON.parse(readFileSync(new URL('../conformance/validation.v1.json', import.meta.url), 'utf8'));

test('the reference reproduces every validation case', () => {
  assert.ok(validation.cases.length >= 1000);
  const attempt = (read: () => unknown): unknown => {
    try { return { ok: true, value: read() }; } catch (error) { return { ok: false, issues: [(error as { issue: unknown }).issue] }; }
  };
  for (const [index, c] of validation.cases.entries()) {
    const label = `validation case ${index} (${c.kind})`;
    let got: unknown;
    if (c.kind === 'document') got = validateDocument(c.input);
    else if (c.kind === 'transaction') got = validateTransaction(c.input);
    else if (c.kind === 'actor') got = attempt(() => readActor(c.input));
    else if (c.kind === 'timestamp') got = attempt(() => timestamp(c.input));
    else { const href = safeUrl(c.input); got = href === null ? { ok: false, issues: [] } : { ok: true, value: href }; }
    assert.deepEqual(JSON.parse(JSON.stringify(got)), c.expect, label);
  }
});

const editorData = JSON.parse(readFileSync(new URL('../conformance/editor.v1.json', import.meta.url), 'utf8'));

test('the reference reproduces every editor scenario', () => {
  let steps = 0;
  for (const { scenario, steps: list } of editorData.scenarios) {
    let current = scenario.initial.createdAt;
    const editor = createEditor(scenario.initial, { now: () => current, ...(scenario.historyLimit === undefined ? {} : { historyLimit: scenario.historyLimit }) });
    for (const [index, step] of list.entries()) {
      current = step.now;
      const result = step.action === 'apply' ? editor.apply(step.input) : step.action === 'undo' ? editor.undo(step.input.actor, step.input.expectedRevision) : editor.redo(step.input.actor, step.input.expectedRevision);
      const got = result.ok
        ? { ok: true, ...(result.duplicate ? { duplicate: true } : {}), document: result.document, revision: result.revision }
        : { ok: false, issues: result.issues, currentRevision: result.currentRevision };
      assert.deepEqual(JSON.parse(JSON.stringify(got)), step.expect, `${scenario.name} step ${index}`);
      steps++;
    }
    assert.deepEqual(JSON.parse(JSON.stringify(editor.getRevisions())), scenario.revisions, `${scenario.name} revisions`);
    assert.deepEqual(JSON.parse(JSON.stringify(editor.getSnapshot())), scenario.final, `${scenario.name} final`);
  }
  assert.ok(steps >= 1000);
});

const renderData = JSON.parse(readFileSync(new URL('../conformance/render.v1.json', import.meta.url), 'utf8'));

test('the reference reproduces every render case', () => {
  const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
  for (const c of renderData.inline) {
    const parsed = runs(c.input);
    assert.deepEqual(plain(parsed), c.runs, `inline ${JSON.stringify(c.input)}`);
    assert.equal(runsToMarkdown(parsed), c.markdown, `inline markdown ${JSON.stringify(c.input)}`);
    assert.equal(inlineToPlain(c.input), c.plain, `inline plain ${JSON.stringify(c.input)}`);
  }
  for (const c of renderData.runsToMarkdown) assert.equal(runsToMarkdown(c.runs), c.markdown);
  for (const c of renderData.fromMarkdown) assert.deepEqual(plain(fromMarkdown(c.markdown, c.options)), c.blocks, JSON.stringify(c.markdown));
  for (const c of renderData.badPrefixes) assert.throws(() => fromMarkdown('x', { idPrefix: c.idPrefix }));
  for (const [index, c] of renderData.documents.entries()) {
    const doc = c.document;
    assert.equal(toMarkdown(doc), c.markdown, `document ${index} markdown`);
    assert.equal(toMarkdown(doc, { title: false, chartRows: 2 }), c.markdownBare, `document ${index} markdownBare`);
    assert.equal(toHTML(doc), c.html, `document ${index} html`);
    assert.equal(toHTML(doc, { title: false, chartRows: 2 }), c.htmlBare, `document ${index} htmlBare`);
    assert.equal(toHTML(doc, { standalone: true }), c.htmlStandalone, `document ${index} htmlStandalone`);
    assert.equal(toPlainText(doc), c.text, `document ${index} text`);
    assert.equal(toPlainText(doc, { title: false, chartRows: 1 }), c.textBare, `document ${index} textBare`);
    assert.deepEqual(plain(stats(doc)), c.stats, `document ${index} stats`);
    assert.deepEqual(plain(getOutline(doc)), c.outline, `document ${index} outline`);
    for (const q of c.queries) assert.deepEqual(findBlocks(doc, q.selector).map((block: { id: string }) => block.id), q.ids, `document ${index} query ${JSON.stringify(q.selector)}`);
  }
  for (const w of renderData.words) assert.deepEqual(countWords(w.text), { latin: w.latin, cjk: w.cjk }, JSON.stringify(w.text));
});

// ---- the HTTP server ----------------------------------------------------------------------------------------------------

const serverData = JSON.parse(readFileSync(new URL('../conformance/server.v1.json', import.meta.url), 'utf8'));

const RANDOM_ID = /^[a-z_]+-[0-9a-f]{16}$/;
// Generated transaction ids carry a random suffix; the Go and Python tests blank it the same way.
function blankRandomIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(blankRandomIds);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, key === 'transactionId' && typeof entry === 'string' && RANDOM_ID.test(entry) ? `${entry.slice(0, entry.lastIndexOf('-'))}-RANDOM` : blankRandomIds(entry)]));
  }
  return value;
}

test('the reference reproduces every recorded HTTP exchange', async () => {
  let steps = 0;
  for (const scenario of serverData.scenarios) {
    let clock = '';
    const editor = createEditor(structuredClone(scenario.document), { now: () => clock });
    const handler = createHttpHandler(createReportService(editor), { ...scenario.options, now: () => clock });
    for (const [index, step] of scenario.steps.entries()) {
      clock = step.now;
      const headers = new Headers(step.request.headers ?? {});
      if (step.request.body !== undefined && !headers.has('content-type') && !step.request.headers?.['x-no-content-type']) headers.set('content-type', 'application/json');
      headers.delete('x-no-content-type');
      const response = await handler(new Request(`http://localhost${step.request.path}`, { method: step.request.method, headers, ...(step.request.body === undefined ? {} : { body: step.request.body }) }));
      const label = `${scenario.name} #${index} ${step.request.method} ${step.request.path}`;
      assert.equal(response.status, step.response.status, label);
      assert.deepEqual(Object.fromEntries([...response.headers.entries()].sort(([a], [b]) => (a < b ? -1 : 1))), step.response.headers, label);
      const text = await response.text();
      if ('json' in step.response) assert.deepEqual(blankRandomIds(JSON.parse(text)), blankRandomIds(step.response.json), label);
      else assert.equal(text, step.response.text, label);
      steps++;
    }
  }
  assert.ok(steps > 1000, `only ${steps} steps`);
});

test('the Go and Python servers embed the spec the reference generates', () => {
  const expected = `${JSON.stringify(buildServerSpec())}\n`;
  for (const path of SPEC_COPIES) assert.equal(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), expected, `${path} is out of date: run scripts/export-server-spec.ts`);
});
