import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { channelFor } from '../scripts/release-contract.mjs';
import { planPublication } from '../scripts/registry-preflight.mjs';

test('release channels cannot send a candidate to latest or accept arbitrary version inputs', () => {
  assert.equal(channelFor('0.1.0-next.0'), 'next');
  assert.equal(channelFor('1.2.3'), 'latest');
  for (const version of ['01.2.3', '1.2.3-rc.0', '1.2.3-next.01', '1.2.3 --force', '../1.2.3', 'latest']) assert.throws(() => channelFor(version));
});

const items = ['core', 'ui', 'react'].map(name => ({ name: `@super-solution/editor-${name}`, version: '0.1.0-next.0', integrity: `sha512-${name}` }));
test('partial release retry skips identical immutable bytes and retains dependency order', async () => {
  const plan = await planPublication(items, async item => item === items[0]
    ? { status: 200, document: { versions: { [item.version]: { dist: { integrity: item.integrity } } } } }
    : { status: 404 });
  assert.deepEqual(plan.skipped, [items[0]]);
  assert.deepEqual(plan.pending, [items[1], items[2]]);
});

test('different existing bytes or registry errors abort the complete plan before publication', async () => {
  const seen = [];
  await assert.rejects(planPublication(items, async item => {
    seen.push(item.name);
    return item === items[1] ? { status: 200, document: { versions: { [item.version]: { dist: { integrity: 'sha512-different' } } } } } : { status: 404 };
  }), /Immutable version/);
  assert.deepEqual(seen, [items[0].name, items[1].name]);
  await assert.rejects(planPublication(items, async () => ({ status: 503 })), /Registry preflight failed/);
});

test('publication executable refuses a local invocation before npm or credential handling', () => {
  assert.throws(() => execFileSync(process.execPath, ['scripts/publish-release.mjs'], {
    encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GITHUB_ACTIONS: 'false' },
  }), error => error.status !== 0 && error.stderr.includes('controlled manual workflow'));
});
