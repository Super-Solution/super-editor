import { serializeDocument } from '@super-solution/editor-core';
import { createReportService } from '@super-solution/editor-core';
import { createResearchExample } from './report.js';
const editor = createResearchExample();
const service = createReportService(editor);
const snapshot = editor.getSnapshot();
const block = snapshot.blocks.find(b => b.id === 'macro-summary')!;
const human = service.apply({ id: 'human-note', actor: { id: 'reviewer', kind: 'human' }, baseRevision: snapshot.revision,
  operations: [{ type: 'updateBlock', blockId: block.id, expectedVersion: block.version,
    content: { type: 'paragraph', runs: [{ text: 'Human review: verify the source before updating this thesis.' }] } }] });
const staleAgent = service.apply({ id: 'stale-agent', actor: { id: 'research-agent', kind: 'agent' }, baseRevision: snapshot.revision, conflictPolicy: 'rebase-safe',
  operations: [{ type: 'updateBlock', blockId: block.id, expectedVersion: block.version,
    content: { type: 'paragraph', runs: [{ text: 'An outdated agent proposal.' }] } }] });
if (!human.ok || staleAgent.ok) throw new Error('Concurrency guard failed');
console.log(JSON.stringify({ revision: editor.getSnapshot().revision, rejectedAgentIssues: staleAgent.issues, serializedBytes: serializeDocument(editor.getSnapshot()).length }, null, 2));
