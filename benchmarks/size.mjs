// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
// Bundle size of what a host actually imports: esbuild (it ships with vite) bundles each entry from the built `dist/` with minification
// and reports gzip bytes. React and react-dom stay external, as in a host that already has them. Run `npm run build` first.
import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const entries = {
  'core: createDocument + createEditor': "export { createDocument, createEditor } from '@supersolutions/super-editor-core';",
  'core: everything': "export * from '@supersolutions/super-editor-core';",
  'ui: renderDocument': "export { renderDocument } from '@supersolutions/super-editor-ui';",
  'ui: everything': "export * from '@supersolutions/super-editor-ui';",
  'react: ReportView': "export { ReportView } from '@supersolutions/super-editor-react';",
  'react: ReportEditor': "export { ReportEditor } from '@supersolutions/super-editor-react';",
  'element: defineSuperEditor': "export { defineSuperEditor } from '@supersolutions/super-editor-element';",
  'docx: exportDocx': "export { exportDocx } from '@supersolutions/super-editor-docx';",
  'opc': "export * from '@supersolutions/super-editor-opc';",
  'chat-plugin': "export * from '@supersolutions/super-editor-chat-plugin';",
};
const rows = [];
for (const [name, contents] of Object.entries(entries)) {
  const result = await build({ stdin: { contents, resolveDir: root, loader: 'js' }, bundle: true, minify: true, write: false, format: 'esm', platform: 'browser', logLevel: 'silent', external: ['react', 'react-dom', 'react/jsx-runtime'] });
  const bytes = result.outputFiles[0].contents;
  rows.push({ entry: name, 'min KB': +(bytes.length / 1024).toFixed(1), 'gzip KB': +(gzipSync(bytes).length / 1024).toFixed(1) });
}
const css = readFileSync(`${root}packages/ui/dist/styles.css`);
rows.push({ entry: 'ui styles.css', 'min KB': +(css.length / 1024).toFixed(1), 'gzip KB': +(gzipSync(css).length / 1024).toFixed(1) });
console.table(rows);
