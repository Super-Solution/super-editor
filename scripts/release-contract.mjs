import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
export const packageOrder = ['core', 'ui', 'react', 'element', 'chat-plugin', 'api', 'mcp', 'cli'];
/** Where each package lives, relative to the repo root. Folders group by role: bindings/<framework>, integrations/<host>, backends/<language>. */
export const packageDirs = {
  core: 'packages/core', ui: 'packages/ui', react: 'packages/bindings/react', element: 'packages/bindings/element',
  'chat-plugin': 'packages/integrations/chat-plugin', api: 'backends/typescript/api', mcp: 'backends/typescript/mcp', cli: 'packages/cli'
};
/** Dependencies on packages that live outside this workspace (Apache-2.0 protocol layer; publish it first). */
export const externalDependencies = { 'chat-plugin': { '@supersolutions/super-protocol': '0.1.0' } };
export const registry = 'https://registry.npmjs.org/';
/** Network-facing server packages are AGPL; libraries, the CLI and the UI are GPL. Texts live in LICENSES/. */
export const packageLicenses = { core: 'GPL-3.0-or-later', ui: 'GPL-3.0-or-later', react: 'GPL-3.0-or-later', element: 'GPL-3.0-or-later', 'chat-plugin': 'GPL-3.0-or-later', cli: 'GPL-3.0-or-later', api: 'AGPL-3.0-or-later', mcp: 'AGPL-3.0-or-later' };
export const licenseFile = name => `LICENSES/${packageLicenses[name]}.txt`;
export const packageName = name => `@supersolutions/super-editor-${name}`;
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
    const directory = resolve(root, packageDirs[name]);
    const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
    if (pkg.name !== packageName(name) || pkg.version !== version || pkg.private === true || pkg.license !== packageLicenses[name]) throw new Error(`Invalid release metadata: ${name}`);
    if (pkg.publishConfig?.registry !== registry || pkg.publishConfig?.access !== 'public' || pkg.publishConfig?.tag !== channel) throw new Error(`Invalid publish config: ${name}`);
    if (pkg.scripts && Object.keys(pkg.scripts).length) throw new Error(`Package lifecycle scripts are not allowed: ${name}`);
    const expected = name === 'core' ? {} : { [packageName('core')]: version };
    if (['react', 'element', 'chat-plugin'].includes(name)) expected[packageName('ui')] = version;
    Object.assign(expected, externalDependencies[name] ?? {});
    if (JSON.stringify(pkg.dependencies ?? {}) !== JSON.stringify(expected)) throw new Error(`Dependency contract mismatch: ${name}`);
    if (JSON.stringify(pkg.files) !== JSON.stringify(['dist', 'LICENSE', 'README.md'])) throw new Error(`Package file allowlist mismatch: ${name}`);
    return { name, directory, pkg, version, channel };
  });
}
