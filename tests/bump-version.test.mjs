import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { packageOrder } from '../scripts/release-contract.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Skips only in a checkout without the script (it ships in scripts/ from 0.3.0-next.0).
const options = { skip: existsSync(join(repository, 'scripts', 'bump-version.mjs')) ? false : 'scripts/bump-version.mjs is not present in this checkout' };

/** Copy only the manifests and the two scripts into a scratch workspace; the real repository is never touched. */
function scratchWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'super-editor-bump-'));
  mkdirSync(join(root, 'scripts'));
  for (const script of ['bump-version.mjs', 'release-contract.mjs']) cpSync(join(repository, 'scripts', script), join(root, 'scripts', script));
  cpSync(join(repository, 'package.json'), join(root, 'package.json'));
  for (const name of packageOrder) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    cpSync(join(repository, 'packages', name, 'package.json'), join(root, 'packages', name, 'package.json'));
  }
  return root;
}
function cleanup(root) {
  assert.equal(dirname(resolve(root)), resolve(tmpdir()));
  assert.ok(basename(root).startsWith('super-editor-bump-'));
  rmSync(root, { recursive: true, force: true });
}
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const bump = (root, ...args) => execFileSync(process.execPath, [join(root, 'scripts', 'bump-version.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' });
async function contract(root) {
  const module = await import(`${pathToFileURL(join(root, 'scripts', 'release-contract.mjs')).href}?scratch=${encodeURIComponent(root)}`);
  return module.releasePackages(root);
}

test('bump-version moves the workspace, six packages, internal dependencies and publish tag together', options, async () => {
  const root = scratchWorkspace();
  try {
    const before = Object.fromEntries(packageOrder.map(name => [name, readJson(join(root, 'packages', name, 'package.json'))]));
    const output = bump(root, '9.9.9-next.9');
    assert.match(output, /9.9.9-next.9 \(next\)/);
    assert.equal(readJson(join(root, 'package.json')).version, '9.9.9-next.9');
    assert.equal(readJson(join(root, 'package.json')).private, true);
    for (const name of packageOrder) {
      const pkg = readJson(join(root, 'packages', name, 'package.json'));
      assert.equal(pkg.version, '9.9.9-next.9');
      assert.equal(pkg.publishConfig.tag, 'next');
      assert.equal(pkg.publishConfig.access, 'public');
      assert.equal(pkg.publishConfig.registry, 'https://registry.npmjs.org/');
      for (const [dependency, version] of Object.entries(pkg.dependencies ?? {})) assert.equal(version, '9.9.9-next.9', `${name} -> ${dependency}`);
      // Nothing else in the manifest moves: exports, bin, files, peers and metadata stay byte-for-byte equivalent.
      const { version, publishConfig, dependencies, ...rest } = pkg;
      const { version: oldVersion, publishConfig: oldPublish, dependencies: oldDependencies, ...oldRest } = before[name];
      assert.deepEqual(rest, oldRest, name);
      assert.deepEqual(Object.keys(dependencies ?? {}), Object.keys(oldDependencies ?? {}));
      assert.notEqual(version, oldVersion);
      assert.equal(oldPublish.tag, 'next');
    }
    // The result satisfies the same contract the release scripts enforce.
    const packages = await contract(root);
    assert.deepEqual(packages.map(item => item.name), packageOrder);
    assert.ok(packages.every(item => item.version === '9.9.9-next.9' && item.channel === 'next'));
  } finally { cleanup(root); }
});

test('bump-version is idempotent and accepts a stable version with the latest tag', options, async () => {
  const root = scratchWorkspace();
  try {
    bump(root, '9.9.8-next.0');
    const snapshot = packageOrder.map(name => readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'));
    bump(root, '9.9.8-next.0');
    assert.deepEqual(packageOrder.map(name => readFileSync(join(root, 'packages', name, 'package.json'), 'utf8')), snapshot);
    bump(root, '9.9.9');
    for (const name of packageOrder) assert.equal(readJson(join(root, 'packages', name, 'package.json')).publishConfig.tag, 'latest');
    assert.ok((await contract(root)).every(item => item.channel === 'latest'));
  } finally { cleanup(root); }
});

test('bump-version refuses anything but a stable or -next.N version and changes no file', options, () => {
  const root = scratchWorkspace();
  try {
    const snapshot = [readFileSync(join(root, 'package.json'), 'utf8'), ...packageOrder.map(name => readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'))];
    for (const version of ['1.2.3-rc.0', '01.2.3', 'latest', '../1.2.3', '1.2.3 --force', '9.9.9-next.01', '']) {
      assert.throws(() => bump(root, version), error => error.status !== 0, version);
    }
    assert.throws(() => bump(root), error => error.status !== 0 && /Usage: node scripts\/bump-version\.mjs/.test(error.stderr));
    assert.deepEqual([readFileSync(join(root, 'package.json'), 'utf8'), ...packageOrder.map(name => readFileSync(join(root, 'packages', name, 'package.json'), 'utf8'))], snapshot);
  } finally { cleanup(root); }
});
