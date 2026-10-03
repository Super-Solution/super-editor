import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { serializeDocument, type ApplyResult } from '@super-solution/editor-core';
import { ReportEditor, useEditor } from '@super-solution/editor-react';
import { createResearchExample } from './report.js';
import '@super-solution/editor-ui/styles.css';
import './demo.css';

const editor = createResearchExample();
const human = { id: 'local-reviewer', kind: 'human' as const };
const agent = { id: 'research-agent', kind: 'agent' as const };

function Demo() {
  const report = useEditor(editor);
  const [lastResult, setLastResult] = useState<ApplyResult | null>(null);
  function simulateConflict() {
    const snapshot = editor.getSnapshot();
    const block = snapshot.blocks.find(b => b.id === 'macro-summary');
    if (!block) return;
    const changed = editor.apply({ id: crypto.randomUUID(), actor: human, baseRevision: snapshot.revision,
      operations: [{ type: 'updateBlock', blockId: block.id, expectedVersion: block.version,
        content: { type: 'paragraph', runs: [{ text: 'Human review: source verification is still pending.' }] } }] });
    if (!changed.ok) { setLastResult(changed); return; }
    setLastResult(editor.apply({ id: crypto.randomUUID(), actor: agent, baseRevision: snapshot.revision, conflictPolicy: 'rebase-safe',
      operations: [{ type: 'updateBlock', blockId: block.id, expectedVersion: block.version,
        content: { type: 'paragraph', runs: [{ text: 'Outdated agent draft requesting replacement.' }] } }] }));
  }
  function refreshAgent() {
    const snapshot = editor.getSnapshot();
    const block = snapshot.blocks.find(b => b.id === 'portfolio-summary');
    if (!block) return;
    setLastResult(editor.apply({ id: crypto.randomUUID(), actor: agent, baseRevision: snapshot.revision,
      operations: [{ type: 'updateBlock', blockId: block.id, expectedVersion: block.version,
        content: { type: 'paragraph', runs: [{ text: 'Agent update: review concentration, liquidity, duration, and the assumptions behind the scenario. Human approval is pending.' }] } }] }));
  }
  function download() {
    const url = URL.createObjectURL(new Blob([serializeDocument(editor.getSnapshot())], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'research-report.json'; anchor.click(); URL.revokeObjectURL(url);
  }
  return <div className="demo-shell">
    <header className="demo-header"><a href="#report" className="brand">Super Editor</a><span>Research workspace</span><button onClick={download}>Export JSON</button></header>
    <div className="demo-layout">
      <aside className="demo-sidebar"><p className="sidebar-title">Notebook</p><nav aria-label="Report sections">{report.blocks.filter(b => b.content.type === 'section').map(b => <a key={b.id} href={`#${b.id}`}>{b.content.type === 'section' ? b.content.title : b.id}</a>)}</nav>
        <div className="agent-panel"><h2>Agent review</h2><p>Submit incremental proposals through the same operation engine.</p><button onClick={refreshAgent}>Update portfolio note</button><button onClick={simulateConflict}>Try stale agent update</button>
          <p role="status">{lastResult ? lastResult.ok ? `Accepted at revision ${lastResult.document.revision}` : `Rejected: ${lastResult.issues.map(i => i.message).join(' ')}` : 'No pending proposal.'}</p>
        </div><p className="fixture-note">Fictional research data. Local session. Provider slot awaits a verified SuperChart API.</p>
      </aside>
      <main id="report"><ReportEditor editor={editor} actor={human}/></main>
    </div>
  </div>;
}
createRoot(document.getElementById('root')!).render(<Demo/>);
