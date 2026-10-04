#!/usr/bin/env node
// Bump the root workspace and all six packages to one version, together with
// their exact internal dependency versions and publish tag, as
// scripts/release-contract.mjs requires. Then refresh the lockfile with
// `npm install --package-lock-only --ignore-scripts`.
//
//   node scripts/bump-version.mjs 0.2.0-next.0
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { channelFor, packageName, packageOrder } from './release-contract.mjs';

const version = process.argv[2];
if (!version) throw new Error('Usage: node scripts/bump-version.mjs <version>');
const channel = channelFor(version);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);

const workspacePath = resolve(root, 'package.json');
const workspace = read(workspacePath);
workspace.version = version;
write(workspacePath, workspace);

for (const name of packageOrder) {
  const path = resolve(root, 'packages', name, 'package.json');
  const pkg = read(path);
  pkg.version = version;
  pkg.publishConfig = { ...pkg.publishConfig, tag: channel };
  for (const dep of Object.keys(pkg.dependencies ?? {})) {
    if (packageOrder.some(other => packageName(other) === dep)) pkg.dependencies[dep] = version;
  }
  write(path, pkg);
}
console.log(`Bumped workspace and ${packageOrder.length} packages to ${version} (${channel}). Now run: npm install --package-lock-only --ignore-scripts`);
