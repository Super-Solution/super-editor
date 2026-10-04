import {
  chart, createReportService, runAgentAction, summarizeRevision, transaction,
  type Actor, type AgentActionInputs, type AgentActionName, type AgentActionOutputs, type AgentFailure, type AgentWriteSuccess, type Block, type BlockContent, type ChartSpec, type Editor, type TransactionBuilder,
} from '@super-solution/editor-core';

export const AGENT: Actor = { id: 'research-agent', kind: 'agent' };
export const REVIEWER: Actor = { id: 'reviewer', kind: 'human' };

export type Marks = { added: string[]; changed: string[]; moved: string[] };
export type Outcome = { ok: true; revision: number; summary: string; dryRun?: true; marks?: Marks } | AgentFailure;
/** One line of the agent log: who called what, why, and how it ended. A refusal carries the issues with their hints. */
export type Step = { actor: Actor['kind']; action: string; note: string; outcome: Outcome };
export type Agent = ReturnType<typeof createAgent>;
export type Scenario = { id: string; label: string; action: string; detail: string; run(agent: Agent, round: number): Step[] };

type WriteName = 'insert_blocks' | 'add_chart' | 'replace_text' | 'add_citation' | 'update_block';

/**
 * An agent as a host would build one: `runAgentAction` over the shared report service, always as the same `agent` actor. Nothing here is
 * special-cased for the demo; an MCP server, an HTTP route and the CLI call these same actions.
 */
export function createAgent(editor: Editor, dryRun: boolean) {
  const service = createReportService(editor);
  const call = <N extends AgentActionName>(name: N, input: AgentActionInputs[N]): AgentFailure | AgentActionOutputs[N] =>
    runAgentAction(service, name, input, { actor: AGENT }) as AgentFailure | AgentActionOutputs[N];
  /** A write action. With `dryRun` the same call only previews: the result says what would change and nothing is saved. */
  const write = <N extends WriteName>(name: N, input: AgentActionInputs[N], note: string): Step => {
    const result = call(name, dryRun ? { ...input, dryRun: true } : input) as AgentFailure | AgentWriteSuccess;
    if (!result.ok) return { actor: 'agent', action: name, note, outcome: result };
    return { actor: 'agent', action: name, note, outcome: { ok: true, revision: result.revision, summary: result.summary, ...(result.dryRun ? { dryRun: true as const } : {}), marks: { added: result.added, changed: result.changed, moved: result.moved } } };
  };
  /** An edit by a person, through the same guarded transaction API. */
  const person = (action: string, note: string, build: (tx: TransactionBuilder) => TransactionBuilder): Step => {
    const result = build(transaction(editor, REVIEWER)).commit();
    return { actor: 'human', action, note, outcome: result.ok ? { ok: true, revision: result.revision.number, summary: summarizeRevision(result.revision) } : result };
  };
  return { editor, call, write, person };
}

const found = (action: string, note: string, revision: number, summary: string): Step => ({ actor: 'agent', action, note, outcome: { ok: true, revision, summary } });
/** The agent reads before it writes: `find_blocks` returns each block with the version a later edit must name. */
function firstParagraph(agent: Agent): { step: Step; block?: Block | undefined } {
  const note = 'Look for a paragraph to work on.', result = agent.call('find_blocks', { type: 'paragraph', limit: 1, include: 'content' });
  if (!result.ok) return { step: { actor: 'agent', action: 'find_blocks', note, outcome: result } };
  const block = result.blocks[0] as Block | undefined;
  return { block, step: found('find_blocks', note, result.revision, block ? `Found paragraph "${block.id}" at version ${block.version}.` : 'This document has no paragraph.') };
}

const paragraphWith = (block: Block, text: string, italic: boolean): BlockContent =>
  block.content.type === 'paragraph' ? { type: 'paragraph', runs: [...block.content.runs, { text, ...(italic ? { italic } : {}) }] } : block.content;

/** The agent holds a block version; a person edits first. Without `safe` the same block changed (refused). With `safe` only the title changed (rebased). */
function stale(agent: Agent, safe: boolean): Step[] {
  const { step, block } = firstParagraph(agent);
  if (!block) return [step];
  const base = agent.editor.getSnapshot();
  const title = base.title.replace(/( \(reviewed\))+$/, '');
  const interject = safe
    ? agent.person('set_title', 'Meanwhile a person renames the document. The paragraph the agent holds is untouched.', (tx) => tx.setTitle(`${title} (reviewed)`))
    : agent.person('update_block', `Meanwhile a person edits the same paragraph, so "${block.id}" moves past version ${block.version}.`, (tx) => tx.update(block.id, paragraphWith(block, ' (reviewer note)', false)));
  const update = agent.write('update_block', {
    blockId: block.id, expectedVersion: block.version, content: paragraphWith(block, ' (agent addendum)', true),
    ...(safe ? { expectedRevision: base.revision, conflictPolicy: 'rebase-safe' as const } : {}),
  }, safe ? `The agent still holds revision ${base.revision}. rebase-safe applies its edit because the block did not change.` : `The agent still holds version ${block.version} and is refused.`);
  return [step, interject, update];
}

const LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
const CHARTS: ChartSpec[] = [
  chart.line({ title: 'Agent chart: rebased performance', labels: LABELS, series: [{ name: 'Alpha', values: [100, 103, 101, 106, 109, 112] }, { name: 'Benchmark', values: [100, 101, 100, 103, 104, 106] }], source: 'Fictional data' }),
  chart.bar({ title: 'Agent chart: revenue by quarter', labels: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'This year', values: [12, 14, 13, 17] }, { name: 'Last year', values: [10, 11, 12, 13] }], source: 'Fictional data' }),
  chart.donut({ title: 'Agent chart: risk contribution', labels: ['Equity', 'Rates', 'Credit'], values: [55, 30, 15], unit: '%', source: 'Fictional data' }),
  chart.waterfall({ title: 'Agent chart: return attribution', labels: ['Start', 'Selection', 'Allocation', 'Costs', 'End'], values: [0, 9.1, 4.2, -0.9, 12.4], unit: '%', source: 'Fictional data' }),
];
const notes = (round: number): string => [
  `## Agent notes ${round + 1}`, '', 'A **second pass** over the data. _A person reviews it before it goes anywhere._', '',
  '- Growth is slowing, but margins held.', '- Valuation sits near its five-year median.', '- Revisit after the next filing.', '',
  '> [!NOTE]', '> Written by research-agent with `insert_blocks`.',
].join('\n');
const PHRASES: [string, string][] = [['research', 'analysis'], ['analysis', 'research']];

export const SCENARIOS: readonly Scenario[] = [
  { id: 'chart', label: 'Insert a chart', action: 'add_chart', detail: 'Appends a chart spec; kinds rotate on every click.',
    run: (agent, round) => [agent.write('add_chart', { spec: CHARTS[round % CHARTS.length]! }, 'Append a chart at the end of the document.')] },
  { id: 'markdown', label: 'Append a markdown section', action: 'insert_blocks', detail: 'Markdown in; heading, list and callout blocks out.',
    run: (agent, round) => [agent.write('insert_blocks', { markdown: notes(round) }, 'Append a section written as markdown.')] },
  { id: 'replace', label: 'Replace a phrase', action: 'replace_text', detail: 'Document-wide, formatting kept. Swaps back on the next click.',
    run: (agent, round) => { const [find, replace] = PHRASES[round % 2]!; return [agent.write('replace_text', { find, replace }, `Replace "${find}" with "${replace}" everywhere.`)]; } },
  { id: 'cite', label: 'Add a citation', action: 'add_citation', detail: 'Reads a paragraph first, then cites it with its version.',
    run: (agent, round) => {
      const { step, block } = firstParagraph(agent), n = round + 1;
      const cite = agent.write('add_citation', { title: `Agent-found source ${n}`, url: `https://example.com/agent/source-${n}`, ...(block ? { blockId: block.id, expectedVersion: block.version, marker: true } : {}) }, block ? `Cite the paragraph "${block.id}" and mark it inline.` : 'Add the source to the document.');
      return [step, cite];
    } },
  { id: 'stale', label: 'Stale update: refused', action: 'update_block', detail: "A person edits first, so the agent's version guard fails, with a hint.", run: (agent) => stale(agent, false) },
  { id: 'rebase', label: 'Stale update: rebase-safe', action: 'update_block', detail: 'Only something else changed, so the edit is rebased and applied.', run: (agent) => stale(agent, true) },
];
