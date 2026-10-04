import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registry } from './release-contract.mjs';

/** Read-only authentication probe. Never forward npm stderr or unexpected stdout. */
export function checkNpmAuth(run = spawnSync) {
  try {
    const result = run('npm', ['whoami', '--registry', registry, '--ignore-scripts'], {
      encoding: 'utf8', timeout: 20_000, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const account = typeof result.stdout === 'string' ? result.stdout.trim() : '';
    if (result.error || result.signal || result.status !== 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(account)) {
      return { success: false, message: 'npm authentication: failed' };
    }
    return { success: true, message: `npm authentication: success (${account})` };
  } catch {
    return { success: false, message: 'npm authentication: failed' };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch' || process.env.GITHUB_REPOSITORY !== 'Super-Solution/super-editor' || process.env.GITHUB_REF !== 'refs/heads/main' || process.env.GITHUB_WORKFLOW !== 'Check npm authentication') {
    console.log('npm authentication: not run (requires the manual main-branch diagnostic workflow)');
    process.exitCode = 1;
  } else {
    const result = checkNpmAuth();
    console.log(result.message);
    process.exitCode = result.success ? 0 : 1;
  }
}
