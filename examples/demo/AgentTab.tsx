import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { Editor } from '@super-solution/editor-core';
import { AGENT, SCENARIOS, createAgent, type Scenario, type Step } from './agent.js';

type Run = { key: number; label: string; steps: Step[] };

function StepView({ step }: { step: Step }): ReactNode {
  const { outcome } = step;
  return <li className="log-step" data-ok={outcome.ok} data-actor={step.actor}>
    <div className="log-head">
      <span className="se-badge" data-kind={step.actor}>{step.actor === 'agent' ? 'Agent' : 'Person'}</span>
      <code>{step.action}</code>
      <span className="log-status">{outcome.ok ? outcome.dryRun ? 'dry run' : `ok · revision ${outcome.revision}` : 'refused'}</span>
    </div>
    <p className="log-note">{step.note}</p>
    {outcome.ok ? <p className="log-result">{outcome.dryRun ? 'Would have: ' : ''}{outcome.summary}</p>
      : <div className="log-result" role="note">{outcome.issues.map((issue, index) => <p key={index}><strong>{issue.code}:</strong> {issue.message}{issue.hint ? <span className="log-hint">{issue.hint}</span> : null}</p>)}
        <small>The document is at revision {outcome.currentRevision}. Nothing was applied.</small></div>}
  </li>;
}

type Props = { editor: Editor; onSteps(steps: Step[]): void };
/**
 * Buttons that act as an agent. Each one is a few `runAgentAction` calls as `research-agent`; the log shows the result of every call, so a
 * refusal and its hint are as visible as a success. Dry run previews a write without saving it.
 */
export function AgentTab({ editor, onSteps }: Props): ReactNode {
  const [runs, setRuns] = useState<Run[]>([]);
  const [dryRun, setDryRun] = useState(false);
  const rounds = useRef(new Map<string, number>()), keys = useRef(0);
  const run = (scenario: Scenario): void => {
    const round = rounds.current.get(scenario.id) ?? 0;
    rounds.current.set(scenario.id, round + 1);
    const steps = scenario.run(createAgent(editor, dryRun), round);
    setRuns((previous) => [{ key: ++keys.current, label: scenario.label, steps }, ...previous].slice(0, 12));
    onSteps(steps);
  };
  return <section className="se-panel agent" aria-label="Agent">
    <h2 className="se-panel-title">Agent</h2>
    <p className="tab-note">Acts as <code>{AGENT.id}</code> through <code>runAgentAction</code>, the same actions the MCP server, HTTP routes and CLI expose. Every write names what the agent last read.</p>
    <div className="agent-buttons">
      {SCENARIOS.map((scenario) => <button key={scenario.id} type="button" className="agent-button" onClick={() => run(scenario)}>
        <span>{scenario.label}</span><code>{scenario.action}</code><small>{scenario.detail}</small>
      </button>)}
    </div>
    <label className="agent-dry"><input type="checkbox" checked={dryRun} onChange={(event) => setDryRun(event.target.checked)} /> Dry run: preview writes, change nothing</label>
    <h3 className="se-panel-title">Log</h3>
    {runs.length === 0 ? <p className="se-panel-empty">Nothing yet. Press a button above.</p>
      : <ol className="log" aria-live="polite">{runs.map((entry) => <li key={entry.key}><h4>{entry.label}</h4><ol>{entry.steps.map((step, index) => <StepView key={index} step={step} />)}</ol></li>)}</ol>}
  </section>;
}
