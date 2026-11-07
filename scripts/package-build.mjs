import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { licenseFile, packageDirs } from './release-contract.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Inlines relative `@import './x.css';` lines so the published stylesheet is one self-contained file. */
async function inlineCss(file, seen = new Set()) {
  if (seen.has(file)) throw new Error(`Circular CSS import: ${file}`);
  seen.add(file);
  const text = await readFile(file, 'utf8');
  const parts = [];
  let last = 0;
  for (const match of text.matchAll(/@import\s+(?:url\()?['"](\.[^'"]+\.css)['"]\)?\s*;/g)) {
    parts.push(text.slice(last, match.index), await inlineCss(resolve(dirname(file), match[1]), new Set(seen)));
    last = match.index + match[0].length;
  }
  parts.push(text.slice(last));
  return parts.join('');
}
for (const name of ['core', 'ui', 'react', 'element', 'chat-plugin', 'api', 'mcp', 'cli']) {
  const directory = resolve(root, packageDirs[name]);
  const destination = resolve(directory, 'dist');
  if (!isAbsolute(destination) || relative(root, destination).startsWith('..')) throw new Error('Build destination leaves workspace.');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(resolve(root, 'dist', packageDirs[name], 'src'), destination, { recursive: true });
  await cp(resolve(root, licenseFile(name)), resolve(directory, 'LICENSE'));
  if (name === 'ui') await writeFile(resolve(destination, 'styles.css'), await inlineCss(resolve(directory, 'src', 'styles.css')));
}
