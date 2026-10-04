import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runCli } from '@super-solution/editor-cli';

export type Step = { command: string; code: number; output: string };

/**
 * The commands an agent (or a person) runs to build a report in a JSON file, in order. Each step is a real `super-editor`
 * invocation; the exit code and the first lines of output are recorded. Run it with:
 *   npx tsx --conditions=development examples/cli-walkthrough.ts
 */
export async function runCliWalkthrough(directory: string): Promise<Step[]> {
  const file = join(directory, 'report.json');
  const steps: Step[] = [];
  let version = 1;
  const run = async (args: string[], stdin?: string): Promise<{ code: number; output: string }> => {
    let output = '';
    const code = await runCli(args, { stdout: text => { output += text; }, stderr: text => { output += text; }, ...(stdin === undefined ? {} : { stdin: async () => stdin }) });
    steps.push({ command: `super-editor ${args.map(arg => /[\s*]/.test(arg) ? JSON.stringify(arg) : arg).join(' ')}`, code, output: output.trimEnd().split('\n').slice(0, 6).join('\n') });
    return { code, output };
  };

  await run(['new', file, '--id', 'acme-q3', '--template', 'equity', '--subject', 'ACME', '--history']);
  await run(['outline', file]);
  const found = await run(['find', file, '--type', 'paragraph', '--text', 'thesis', '--json']);
  const target = (JSON.parse(found.output) as { blocks: { id: string; version: number }[] }).blocks[0]!;
  version = target.version;
  await run(['update-text', file, `${target.id}@${version}`, '--text', 'ACME grew revenue **12%** while margins held.', '--actor', 'analyst-bot:agent']);
  // The same edit with the version we read before is now stale: exit code 3, nothing written.
  await run(['update-text', file, `${target.id}@${version}`, '--text', 'A stale proposal.']);
  await run(['insert', file, '--markdown', '-', '--parent', 'equity-risk', '--after', 'equity-risk-table'], 'Volatility rose in **August**.');
  await run(['chart', file, '--spec', '-', '--parent', 'equity-performance', '--first'], JSON.stringify({ kind: 'line', title: 'Price', labels: ['Mon', 'Tue', 'Wed'], series: [{ name: 'ACME', values: [10, 10.4, 10.2] }], source: 'Example feed' }));
  await run(['cite', file, '--title', 'ACME annual report', '--url', 'https://example.com/acme-10k', '--block', `${target.id}@${version + 1}`, '--marker']);
  await run(['replace', file, '--find', 'margins held', '--replace', 'margins improved']);
  await run(['stats', file]);
  await run(['revisions', file]);
  await run(['export', file, '--format', 'md', '--out', join(directory, 'report.md')]);
  return steps;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const directory = await mkdtemp(join(tmpdir(), 'super-editor-walkthrough-'));
  try {
    for (const step of await runCliWalkthrough(directory)) console.log(`$ ${step.command}\n${step.output}\n[exit ${step.code}]\n`);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
