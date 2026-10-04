#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatIssues, withHints } from '@super-solution/editor-core';
import type { EditorIssue } from '@super-solution/editor-core';
import { COMMANDS, defaultActor, parseCommand, type CliIo, type Command } from './commands.js';
import { InputError, InvalidDocument, Refusal } from './files.js';

export type CliOutput = CliIo;

function buildHelp(): string {
  const width = Math.max(...COMMANDS.map(command => command.name.length));
  return `Super Editor: read and edit a research report stored as a JSON file

Usage:
  super-editor init <document.json> --id <id> [--title <title>]
  super-editor read <document.json>
  super-editor apply <document.json> <transaction.json>
  super-editor <command> <document.json> [arguments] [options]
  super-editor help [<command>]

Commands:
${COMMANDS.map(command => `  ${command.name.padEnd(width)}  ${command.summary}`).join('\n')}

Every command that edits validates the whole change through the Core, takes an exclusive lock and replaces the file
atomically only on success. Guarded edits name the block version you last read as <blockId>@<version> (see find and get);
a stale version is a conflict. Use --dry-run to preview an edit, --json for machine-readable output.
Undo/redo is session-only and not available from the CLI. This command does not start a network server.

Examples:
  super-editor new report.json --id aapl-q3 --template equity --subject AAPL
  super-editor outline report.json
  super-editor find report.json --type paragraph --text revenue --json
  super-editor update-text report.json aapl-q3-summary-thesis@1 --text "Revenue grew **12%**."
  super-editor insert report.json --markdown notes.md --after aapl-q3-summary
  super-editor chart report.json --spec chart.json --parent aapl-q3-performance
  super-editor export report.json --format html --out report.html

Exit codes: 0 success, 1 I/O failure, 2 invalid input, 3 revision or version conflict, 4 block or citation not found.
Environment: SUPER_EDITOR_ACTOR=<id[:kind]> sets the default --actor.
`;
}
export const CLI_HELP = buildHelp();

function commandHelp(command: Command): string {
  return `super-editor ${command.usage}\n\n${command.summary}.\n${command.notes?.length ? `\n${command.notes.map(note => `  ${note}`).join('\n')}\n` : ''}\nExit codes: 0 success, 1 I/O failure, 2 invalid input, 3 conflict, 4 not found. Run super-editor help for all commands.\n`;
}

const standardOutput: CliOutput = {
  stdout: (text) => { process.stdout.write(text); },
  stderr: (text) => { process.stderr.write(text); },
};

/** 0 success, 2 invalid input, 3 conflict, 4 not found. */
function exitCodeFor(issues: readonly EditorIssue[]): number {
  if (issues.some(issue => issue.code === 'conflict')) return 3;
  if (issues.some(issue => issue.code === 'not-found')) return 4;
  return 2;
}

/** Local runner also usable by tests and another trusted CLI host. */
export async function runCli(args: string[], output: CliOutput = standardOutput): Promise<number> {
  const name = args[0];
  if (args.length === 0 || (args.length === 1 && ['help', '--help', '-h'].includes(name ?? ''))) {
    output.stdout(CLI_HELP);
    return 0;
  }
  const wantsJson = args.includes('--json');
  let command: Command | undefined;
  try {
    if (name === 'help') {
      const target = COMMANDS.find(entry => entry.name === args[1]);
      if (!target || args.length > 2) throw new InputError(`Unknown command "${args[1] ?? ''}". Run super-editor help.`);
      output.stdout(commandHelp(target));
      return 0;
    }
    command = COMMANDS.find(entry => entry.name === name);
    if (!command) throw new InputError('Unknown command. Run super-editor help.');
    const { values, positionals } = parseCommand(command, args.slice(1));
    if (values.help === true) { output.stdout(commandHelp(command)); return 0; }
    let file = '';
    let rest = positionals;
    if (command.file) {
      const target = positionals[0];
      if (target === undefined || target.length === 0) throw new InputError('A document file path is required.');
      file = resolve(target);
      rest = positionals.slice(1);
    }
    const actorValue = typeof values.actor === 'string' ? values.actor : process.env.SUPER_EDITOR_ACTOR;
    const json = values.json === true;
    const outcome = await command.run({ file, rest, v: values, io: output, json, actor: defaultActor(actorValue) });

    if (outcome.value.ok === false) {
      const issues = withHints((outcome.value.issues ?? []) as EditorIssue[]);
      const failure = { ...outcome.value, issues };
      output.stderr(command.alwaysRaw || json ? `${JSON.stringify(failure)}\n` : `error: the change was not applied\n${formatIssues(issues)}\n`);
      return exitCodeFor(issues);
    }
    if (outcome.raw !== undefined && (!json || command.alwaysRaw)) output.stdout(outcome.raw);
    else output.stdout(json ? `${JSON.stringify(outcome.value)}\n` : outcome.human);
    return 0;
  } catch (error) {
    const machine = wantsJson || command?.alwaysRaw === true || command === undefined;
    if (error instanceof InvalidDocument) {
      output.stderr(machine ? `${JSON.stringify({ ok: false, issues: withHints(error.issues) })}\n` : `error: the document is not valid\n${formatIssues(error.issues)}\n`);
      return 2;
    }
    const message = error instanceof Error ? error.message : 'Local CLI operation failed.';
    output.stderr(machine ? `${JSON.stringify({ ok: false, error: message })}\n` : `error: ${message}\n`);
    return error instanceof Refusal ? error.exitCode : error instanceof InputError ? 2 : 1;
  }
}

function isMain(): boolean {
  if (!process.argv[1]) return false;
  // The package manager launches a bin through a symlink; compare real paths so that works too.
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
}
if (isMain()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
