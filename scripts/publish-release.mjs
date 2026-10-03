import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry, releasePackages } from './release-contract.mjs';
import { planPublication } from './registry-preflight.mjs';
import { readRegistry, checkPrereleaseBaseline, checkPublishedTags } from './registry-tags.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REPOSITORY !== 'Super-Solution/super-editor' || process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Publication is allowed only by the controlled manual workflow on this repository main branch.');
const packages = releasePackages(root);
const manifest = JSON.parse(readFileSync(resolve(root, 'artifacts/release/release-manifest.json'), 'utf8'));
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (manifest.dirty !== false || manifest.sourceCommit !== head || head !== process.env.GITHUB_SHA || manifest.version !== process.env.RELEASE_VERSION || manifest.channel !== process.env.RELEASE_CHANNEL || manifest.version !== packages[0].version || manifest.channel !== packages[0].channel || manifest.packages?.length !== packages.length) throw new Error('Verified source/version/channel does not match this exact release request.');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Invoke using npm run release:publish.');
const artifacts = [];
for (let i = 0; i < packages.length; i++) {
  const expected = packages[i]; const item = manifest.packages[i];
  if (item.name !== expected.pkg.name || item.version !== expected.version || item.channel !== expected.channel || !/^super-solution-editor-[a-z]+-[0-9a-z.-]+\.tgz$/.test(item.filename)) throw new Error('Artifact identity/order mismatch.');
  const tarball = resolve(root, 'artifacts/release', item.filename);
  const bytes = readFileSync(tarball);
  if (createHash('sha256').update(bytes).digest('hex') !== item.sha256 || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== item.integrity || bytes.length !== item.size) throw new Error(`Artifact checksum mismatch: ${item.name}`);
  artifacts.push({ ...item, tarball });
}
const beforeLatest = new Map();
const { pending, skipped } = await planPublication(artifacts, async item => {
  const document = await readRegistry(item.name);
  if (item.channel === 'next') beforeLatest.set(item.name, checkPrereleaseBaseline(item.name, document));
  return { status: document ? 200 : 404, document };
});
for (const item of skipped) console.log(`Already published with identical integrity; skipping ${item.name}@${item.version}.`);
for (const item of pending) {
  if (item.channel === 'next' && (await readRegistry(item.name))?.['dist-tags']?.latest !== beforeLatest.get(item.name)) {
    throw new Error(`Latest changed after preflight: ${item.name}; no publication attempted for this package.`);
  }
  // npm consumes the workflow's ephemeral NODE_AUTH_TOKEN through setup-node's auth configuration.
  // Never inspect or log credential values here; no lifecycle scripts, force or unpublish.
  execFileSync(process.execPath, [npmCli, 'publish', item.tarball, '--access', 'public', '--tag', item.channel, '--registry', registry, '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
  console.log(`Published ${item.name}@${item.version} to ${item.channel}.`);
}
// Checks are read-only. Unexpected tags stop the release; never move a changed tag automatically.
for (const item of artifacts) {
  checkPublishedTags(item, beforeLatest.get(item.name), await readRegistry(item.name));
  console.log(`Verified ${item.name} channel and preserved prerelease latest baseline.`);
}
