import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['core', 'ui', 'react', 'api', 'mcp', 'cli']) {
  const destination = resolve(root, 'packages', name, 'dist');
  if (!isAbsolute(destination) || relative(root, destination).startsWith('..')) throw new Error('Build destination leaves workspace.');
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(resolve(root, 'dist', 'packages', name, 'src'), destination, { recursive: true });
  await cp(resolve(root, 'LICENSE'), resolve(root, 'packages', name, 'LICENSE'));
  if (name === 'ui') await cp(resolve(root, 'packages', name, 'src', 'styles.css'), resolve(destination, 'styles.css'));
}
