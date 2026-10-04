import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkNpmAuth } from '../scripts/check-npm-auth.mjs';

test('auth diagnostic executes only whoami on the fixed registry with bounded captured output', () => {
  const result = checkNpmAuth((command, args, options) => {
    assert.equal(command, 'npm');
    assert.deepEqual(args, ['whoami', '--registry', 'https://registry.npmjs.org/', '--ignore-scripts']);
    assert.equal(options.shell, false);
    assert.equal(options.timeout, 20_000);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(Object.hasOwn(options, 'env'), false);
    return { status: 0, stdout: 'owner.name\n', stderr: 'warning: sensitive diagnostic data' };
  });
  assert.deepEqual(result, { success: true, message: 'npm authentication: success (owner.name)' });
});

test('failures, timeouts and malformed output never disclose npm diagnostics', () => {
  for (const output of [
    { status: 1, stdout: 'sensitive stdout', stderr: 'sensitive stderr' },
    { status: 0, stdout: 'owner\nsecret=value', stderr: '' },
    { status: 0, stdout: '\u001b[31mowner', stderr: '' },
    { status: 0, stdout: '', stderr: '' },
    { status: null, signal: 'SIGTERM', stdout: 'owner', stderr: 'sensitive timeout' },
    { status: 0, stdout: 'owner', error: new Error('sensitive error') },
  ]) assert.deepEqual(checkNpmAuth(() => output), { success: false, message: 'npm authentication: failed' });
  assert.deepEqual(checkNpmAuth(() => { throw new Error('sensitive exception'); }), { success: false, message: 'npm authentication: failed' });
});

test('local invocation refuses before authentication and never prints environment values', () => {
  assert.throws(() => execFileSync(process.execPath, ['scripts/check-npm-auth.mjs'], {
    encoding: 'utf8', stdio: 'pipe', env: { ...process.env, GITHUB_ACTIONS: 'false', NODE_AUTH_TOKEN: 'test-only-must-not-print' },
  }), error => error.status === 1 && error.stdout.includes('not run') && !error.stdout.includes('test-only-must-not-print') && error.stderr === '');
});

test('workflow remains manually triggered with existing secret reference and no write command', () => {
  const workflow = readFileSync('.github/workflows/check-npm-auth.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
  assert.match(workflow, /run: node scripts\/check-npm-auth\.mjs/);
  assert.doesNotMatch(workflow, /\benvironment:|id-token:|dist-tag|publish|unpublish|repair-tags|npm (?:config|token|login)|printenv|fingerprint/i);
  assert.equal((workflow.match(/\brun:/g) ?? []).length, 2);
});
