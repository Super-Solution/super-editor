import assert from 'node:assert/strict';
import test from 'node:test';
import { ProposalReview } from '@supersolutions/super-editor-react';
import { everyBlock, click, withDom } from './helpers/dom.js';

const agent = { id: 'research-agent', kind: 'agent' as const };
const all = (root: ParentNode, selector: string): Element[] => Array.from(root.querySelectorAll(selector));

test('ProposalReview lists what changes, accepts through the editor, and refuses a stale or malformed proposal', async () => {
  await withDom(async (h) => {
    const editor = everyBlock();
    const document = editor.getSnapshot();
    const para = document.blocks.find((block) => block.id === 'para')!;
    const proposal = { id: 'prop-1', actor: agent, baseRevision: document.revision, operations: [
      { type: 'updateBlock', blockId: 'para', expectedVersion: para.version, content: { type: 'paragraph', runs: [{ text: 'Rewritten by the agent' }] } },
      { type: 'insertBlock', block: { id: 'agent-note', parentId: null, citationIds: [], content: { type: 'paragraph', runs: [{ text: 'A new note' }] } } },
    ] };
    const accepted: string[] = [], rejected: (string | null)[] = [], results: boolean[] = [];
    await h.render(<ProposalReview document={document} proposal={proposal} editor={editor} onAccept={(tx) => accepted.push(tx.id)} onReject={(tx) => rejected.push(tx?.id ?? null)} onResult={(result) => results.push(result.ok)} preview />);
    assert.equal(h.container.querySelector('.se-proposal')?.getAttribute('data-status'), 'ready');
    assert.match(h.container.textContent ?? '', /Proposed by research-agent/);
    assert.match(h.container.textContent ?? '', /Rewritten by the agent/);
    assert.deepEqual(all(h.container, '.se-proposal-change').map((node) => node.getAttribute('data-kind')), ['added', 'changed']);
    click(h.dom, all(h.container, 'button').find((button) => button.textContent === 'Show in document') ?? null);
    await h.flush();
    assert.ok(h.container.querySelector('.se-proposal-preview .super-editor-document'));
    assert.equal(editor.getSnapshot().revision, document.revision, 'nothing applied yet');
    click(h.dom, all(h.container, 'button').find((button) => button.textContent === 'Accept') ?? null);
    assert.deepEqual(accepted, ['prop-1']);
    assert.deepEqual(results, [true]);
    assert.equal(editor.getSnapshot().revision, document.revision + 1);
    assert.equal(editor.getRevisions().at(-1)?.actor.kind, 'agent');

    // Now the same proposal is stale: Accept is disabled and the reason is shown.
    await h.render(<ProposalReview document={editor.getSnapshot()} proposal={proposal} editor={editor} onAccept={(tx) => accepted.push(tx.id)} onReject={(tx) => rejected.push(tx?.id ?? null)} />);
    assert.equal(h.container.querySelector('.se-proposal')?.getAttribute('data-status'), 'stale');
    assert.equal((all(h.container, 'button').find((button) => button.textContent === 'Accept') as HTMLButtonElement).disabled, true);
    click(h.dom, all(h.container, 'button').find((button) => button.textContent === 'Reject') ?? null);
    assert.deepEqual(rejected, ['prop-1']);

    await h.render(<ProposalReview document={editor.getSnapshot()} proposal={{ nope: 1 }} />);
    assert.equal(h.container.querySelector('.se-proposal')?.getAttribute('data-status'), 'invalid');
    await h.render(<ProposalReview document={editor.getSnapshot()} proposal={null} />);
    assert.match(h.container.textContent ?? '', /No proposal to review/);
  });
});

test('ProposalReview texts are translatable', async () => {
  await withDom(async (h) => {
    const document = everyBlock().getSnapshot();
    await h.render(<ProposalReview document={document} proposal={{ id: 'x', actor: agent, baseRevision: document.revision, operations: [{ type: 'setTitle', title: 'Nuevo' }] }} labels={{ proposal: { title: 'Cambio propuesto', accept: 'Aceptar' } }} />);
    assert.match(h.container.textContent ?? '', /Cambio propuesto/);
    assert.ok(all(h.container, 'button').some((button) => button.textContent === 'Aceptar'));
  });
});
