import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { packageDirs, packageName, packageOrder } from '../scripts/release-contract.mjs';

const root = resolve(import.meta.dirname, '..');
const read = name => JSON.parse(readFileSync(resolve(root, packageDirs[name], 'package.json'), 'utf8'));

test('every package declares its side effects and resolves for bundlers and require()', () => {
  for (const name of packageOrder) {
    const pkg = read(name);
    // Importing a package must not do anything by itself (the custom element is registered by defineSuperEditor), so bundlers may drop unused modules.
    assert.deepEqual(pkg.sideEffects, name === 'ui' ? ['**/*.css'] : false, `${pkg.name}: sideEffects`);
    assert.equal(pkg.main, pkg.exports['.'].import, `${pkg.name}: main mirrors the import entry for tools that ignore "exports"`);
    for (const [entry, conditions] of Object.entries(pkg.exports)) {
      if (typeof conditions === 'string') continue;
      assert.equal(conditions.default, conditions.import, `${pkg.name} ${entry}: a default condition next to import, so require() and non-import resolvers find the entry`);
      assert.deepEqual(Object.keys(conditions), ['types', 'import', 'default'], `${pkg.name} ${entry}: condition order (types first)`);
    }
  }
});

test('built packages load through require() and import()', { skip: !existsSync(resolve(root, packageDirs.core, 'dist/index.js')) && 'run npm run build first' }, async () => {
  const require = createRequire(import.meta.url);
  for (const name of ['core', 'api']) {
    const viaRequire = require(packageName(name));
    const viaImport = await import(packageName(name));
    assert.deepEqual(Object.keys(viaRequire).sort(), Object.keys(viaImport).filter(key => key !== 'default').sort(), `${name}: same named exports`);
  }
});
