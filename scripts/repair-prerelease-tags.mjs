import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry } from './release-contract.mjs';
import { repairLatest, repairVersion } from './registry-tags.mjs';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REPOSITORY !== 'Super-Solution/super-editor' || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_WORKFLOW !== 'Repair prerelease latest tags') {
  throw new Error('Tag repair is allowed only by the controlled manual workflow on this repository main branch.');
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Invoke using npm run release:repair-tags.');
const audit = { sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, expectedVersion: repairVersion, startedAt: new Date().toISOString(), entries: [] };
try {
  await repairLatest({ audit: audit.entries, removeLatest: name => {
    // setup-node supplies the existing organization secret through ephemeral npm auth.
    execFileSync(process.execPath, [npmCli, 'dist-tag', 'rm', name, 'latest', '--registry', registry, '--ignore-scripts'], { cwd: root, stdio: 'inherit' });
  } });
  audit.success = true;
  console.log('All six registry readbacks passed; next, versions and tarballs preserved.');
} catch (error) {
  audit.success = false;
  audit.error = error.message;
  throw error;
} finally {
  audit.finishedAt = new Date().toISOString();
  mkdirSync(resolve(root, 'artifacts/tag-repair'), { recursive: true });
  writeFileSync(resolve(root, 'artifacts/tag-repair/audit.json'), JSON.stringify(audit, null, 2));
}
