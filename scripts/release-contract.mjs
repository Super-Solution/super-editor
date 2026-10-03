import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const packageOrder = ['core', 'ui', 'react', 'api', 'mcp', 'cli'];
export const registry = 'https://registry.npmjs.org/';
export const packageName = name => `@super-solution/editor-${name}`;
export function channelFor(version) {
  if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-next\.(0|[1-9]\d*)$/.test(version)) return 'next';
  if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return 'latest';
  throw new Error('Only a stable semantic version or -next.N prerelease is supported.');
}
export function releasePackages(root) {
  const workspace = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (workspace.private !== true) throw new Error('The root workspace must remain private.');
  const version = workspace.version;
  const channel = channelFor(version);
  return packageOrder.map(name => {
    const directory = resolve(root, 'packages', name);
    const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
    if (pkg.name !== packageName(name) || pkg.version !== version || pkg.private === true || pkg.license !== 'Apache-2.0') throw new Error(`Invalid release metadata: ${name}`);
    if (pkg.publishConfig?.registry !== registry || pkg.publishConfig?.access !== 'public' || pkg.publishConfig?.tag !== channel) throw new Error(`Invalid publish config: ${name}`);
    if (pkg.scripts && Object.keys(pkg.scripts).length) throw new Error(`Package lifecycle scripts are not allowed: ${name}`);
    const expected = name === 'core' ? {} : { [packageName('core')]: version };
    if (name === 'react') expected[packageName('ui')] = version;
    if (JSON.stringify(pkg.dependencies ?? {}) !== JSON.stringify(expected)) throw new Error(`Dependency contract mismatch: ${name}`);
    if (JSON.stringify(pkg.files) !== JSON.stringify(['dist', 'LICENSE', 'README.md'])) throw new Error(`Package file allowlist mismatch: ${name}`);
    return { name, directory, pkg, version, channel };
  });
}
