import { cp, mkdir } from 'node:fs/promises';
for (const name of ['core', 'ui', 'react', 'transports']) {
  await mkdir(new URL(`../packages/${name}/dist/`, import.meta.url), { recursive: true });
  await cp(new URL(`../dist/packages/${name}/src/`, import.meta.url), new URL(`../packages/${name}/dist/`, import.meta.url), { recursive: true });
}
