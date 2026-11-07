import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { repairLatest, repairNames, repairVersion, checkPrereleaseBaseline, checkPublishedTags, waitForPublishedTags } from '../scripts/registry-tags.mjs';

function registryFixture() {
  return new Map(repairNames.map(name => [name, {
    'dist-tags': { latest: repairVersion, next: repairVersion, experimental: '0.0.0-stage' },
    versions: { [repairVersion]: { dist: { integrity: `sha512-${name}`, shasum: 'hash', tarball: `https://registry.npmjs.org/${name}.tgz` } }, '0.0.0-stage': { dist: { integrity: 'sha512-stage' } } },
  }]));
}
const reader = database => async name => structuredClone(database.get(name));

test('fixed six-package repair preserves versions/tarballs/next/other tags and is idempotent', async () => {
  const database = registryFixture(); const before = structuredClone(database); const removed = [];
  const removeLatest = async name => { removed.push(name); delete database.get(name)['dist-tags'].latest; };
  const audit = await repairLatest({ lookup: reader(database), removeLatest });
  assert.deepEqual(removed, repairNames);
  assert.equal(audit.filter(item => item.phase === 'final').length, 6);
  for (const name of repairNames) {
    delete before.get(name)['dist-tags'].latest;
    assert.deepEqual(database.get(name), before.get(name));
  }
  await repairLatest({ lookup: reader(database), removeLatest });
  assert.equal(removed.length, 6);
});

test('any unexpected latest, next, missing version or registry failure blocks all writes', async () => {
  for (const change of [document => document['dist-tags'].latest = '1.0.0', document => document['dist-tags'].next = '0.2.0-next.0', document => delete document.versions[repairVersion]]) {
    const database = registryFixture(); change(database.get(repairNames.at(-1))); let writes = 0;
    await assert.rejects(repairLatest({ lookup: reader(database), removeLatest: () => writes++ }), /guard failed/);
    assert.equal(writes, 0);
  }
  let writes = 0;
  await assert.rejects(repairLatest({ lookup: async () => { throw new Error('Registry read failed (503)'); }, removeLatest: () => writes++ }), /503/);
  assert.equal(writes, 0);
});

test('immediate reread detects a concurrent changed latest before removal', async () => {
  const database = registryFixture(); let reads = 0; let writes = 0;
  await assert.rejects(repairLatest({ lookup: async name => {
    if (++reads > 6) database.get(name)['dist-tags'].latest = '1.0.0';
    return structuredClone(database.get(name));
  }, removeLatest: () => writes++ }), /latest guard failed/);
  assert.equal(writes, 0);
});

test('post-removal readback catches lost next, changed integrity or lingering latest and stops', async () => {
  for (const [remove, mutate] of [[true, document => document['dist-tags'].next = '0.2.0-next.0'], [true, document => document.versions[repairVersion].dist.integrity = 'sha512-other'], [false, () => {}]]) {
    const database = registryFixture(); let writes = 0;
    await assert.rejects(repairLatest({ lookup: reader(database), removeLatest: async name => {
      writes++; const document = database.get(name);
      if (remove) delete document['dist-tags'].latest;
      mutate(document);
    } }));
    assert.equal(writes, 1);
  }
});

test('prerelease publication checks preserve absent or stable latest and never fix tags', () => {
  const item = { name: repairNames[0], version: repairVersion, channel: 'next' };
  assert.equal(checkPrereleaseBaseline(item.name, undefined), undefined);
  assert.equal(checkPrereleaseBaseline(item.name, { 'dist-tags': { latest: '1.0.0' } }), '1.0.0');
  // A prerelease latest is reported and returned as the baseline to preserve, not fatal.
  const warnings = [];
  assert.equal(checkPrereleaseBaseline(item.name, { 'dist-tags': { latest: repairVersion } }, message => warnings.push(message)), repairVersion);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /already present/);
  // The baseline then guards the publication: moving latest still fails.
  assert.throws(() => checkPublishedTags(item, repairVersion, { 'dist-tags': { next: repairVersion, latest: '1.0.0' } }), /changed latest/);
  checkPublishedTags(item, '1.0.0', { 'dist-tags': { latest: '1.0.0', next: repairVersion } });
  checkPublishedTags(item, undefined, { 'dist-tags': { next: repairVersion } });
  assert.throws(() => checkPublishedTags(item, '1.0.0', { 'dist-tags': { latest: repairVersion, next: repairVersion } }), /changed latest/);
  assert.throws(() => checkPublishedTags(item, '1.0.0', { 'dist-tags': { latest: '1.0.0', next: '0.2.0-next.0' } }), /channel mismatch/);
});

test('tag repair refuses local execution before invoking npm', () => {
  assert.throws(() => execFileSync(process.execPath, ['scripts/repair-prerelease-tags.mjs'], {
    encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GITHUB_ACTIONS: 'false' },
  }), error => error.status !== 0 && error.stderr.includes('controlled manual workflow'));
});

test('published tag checks wait for registry propagation but never for a moved latest', async () => {
  const item = { name: repairNames[0], version: '0.2.0-next.0', channel: 'next' };
  const quiet = { sleep: async () => {}, log: () => {} };
  // Stale metadata twice, then the new channel appears.
  const views = [{ next: repairVersion, latest: repairVersion }, { next: repairVersion, latest: repairVersion }, { next: item.version, latest: repairVersion }];
  let reads = 0;
  await waitForPublishedTags(item, repairVersion, { ...quiet, read: async () => ({ 'dist-tags': views[Math.min(reads++, views.length - 1)] }) });
  assert.equal(reads, 3);
  // The channel never appears: fails after the attempt budget.
  reads = 0;
  await assert.rejects(waitForPublishedTags(item, repairVersion, { ...quiet, attempts: 4, read: async () => { reads++; return { 'dist-tags': { next: repairVersion, latest: repairVersion } }; } }), /channel mismatch/);
  assert.equal(reads, 4);
  // A moved latest fails on the first read, without waiting.
  reads = 0;
  await assert.rejects(waitForPublishedTags(item, repairVersion, { ...quiet, read: async () => { reads++; return { 'dist-tags': { next: item.version, latest: item.version } }; } }), /changed latest/);
  assert.equal(reads, 1);
});
