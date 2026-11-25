import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AGENT_ACTIONS, PROPOSAL_LIMITS, createProposalBox, createReportService, createStoreService, proposalActions, resolveActions, runTransportAction,
  type AgentActionResult, type DocumentStore, type ResearchDocument,
} from '../packages/core/src/index.js';
import { createHttpHandler } from '../backends/typescript/api/src/index.js';
import { createMcpDispatcher, listTools } from '../backends/typescript/mcp/src/index.js';
import { createResearchExample } from '../examples/report.js';

const agent = { id: 'research-agent', kind: 'agent' as const }, person = { id: 'zou', kind: 'human' as const };
const fixture = () => { const service = createReportService(createResearchExample()); const box = createProposalBox(service); return { service, box, table: resolveActions([...AGENT_ACTIONS, ...proposalActions(box)]) }; };
const title = (service: { read(): ResearchDocument }, text: string, id: string, extra: Record<string, unknown> = {}) => ({ id, actor: agent, baseRevision: service.read().revision, operations: [{ type: 'setTitle', title: text }], ...extra });
const run = (f: ReturnType<typeof fixture>, name: string, input: unknown, actor?: { id: string; kind: 'human' | 'agent' | 'system' }) => runTransportAction(f.table, f.service, name, input, actor ? { actor } : {});
const failed = (result: AgentActionResult) => { assert.equal(result.ok, false, JSON.stringify(result)); const bad = result as Extract<AgentActionResult, { ok: false }>; assert.ok(bad.issues.every(issue => issue.hint), JSON.stringify(bad.issues)); return bad; };

test('proposing changes nothing in the document and returns what would change', async () => {
  const f = fixture(), before = f.service.read();
  const result = await run(f, 'propose_transaction', { transaction: title(f.service, 'Renamed', 'p1'), note: 'The title is out of date' }, agent) as Record<string, any>;
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.proposalId, 'p1'); assert.equal(result.state, 'pending'); assert.equal(result.note, 'The title is out of date');
  assert.deepEqual(result.submittedBy, agent);
  assert.match(result.summary, /research-agent/);
  assert.deepEqual(f.service.read(), before, 'the document is untouched');
  assert.equal(f.box.list('pending').length, 1);
});

test('a proposal is checked when it is made: invalid, stale and duplicate each name the problem and what to do', async () => {
  const f = fixture();
  failed(await run(f, 'propose_transaction', { transaction: { nonsense: true } }));
  const stale = failed(await run(f, 'propose_transaction', { transaction: title(f.service, 'x', 'old', { baseRevision: 0 }) }));
  assert.equal(stale.issues[0]!.code, 'conflict'); assert.equal(stale.currentRevision, 1);
  const missing = failed(await run(f, 'propose_transaction', { transaction: { id: 'm', actor: agent, baseRevision: 1, operations: [{ type: 'deleteBlock', blockId: 'does-not-exist' }] } }));
  assert.notEqual(missing.issues[0]!.code, 'conflict');
  failed(await run(f, 'propose_transaction', {}));
  assert.equal(f.box.list().length, 0, 'nothing refused was stored');
  const first = await run(f, 'propose_transaction', { transaction: title(f.service, 'A', 'same') }) as Record<string, any>;
  const again = await run(f, 'propose_transaction', { transaction: { ...title(f.service, 'A', 'same') } }) as Record<string, any>;
  assert.equal(again.ok, true); assert.equal(again.duplicate, true); assert.equal(again.proposedAt, first.proposedAt);
  const reordered = await run(f, 'propose_transaction', { transaction: { operations: [{ title: 'A', type: 'setTitle' }], baseRevision: 1, actor: { kind: 'agent', id: 'research-agent' }, id: 'same' } }) as Record<string, any>;
  assert.equal(reordered.duplicate, true, 'key order does not make a different proposal');
  const clash = failed(await run(f, 'propose_transaction', { transaction: title(f.service, 'B', 'same') }));
  assert.equal(clash.issues[0]!.code, 'duplicate');
  assert.equal(f.box.list().length, 1);
});

test('list_proposals says whether a waiting proposal is still ready, and shows each change', async () => {
  const f = fixture();
  await run(f, 'propose_transaction', { transaction: title(f.service, 'One', 'p1') });
  await run(f, 'propose_transaction', { transaction: title(f.service, 'Two', 'p2') });
  const waiting = await run(f, 'list_proposals', {}) as Record<string, any>;
  assert.equal(waiting.total, 2);
  assert.deepEqual(waiting.proposals.map((p: any) => [p.proposalId, p.review]), [['p1', 'ready'], ['p2', 'ready']], 'oldest first');
  assert.equal(waiting.proposals[0].changes, undefined, 'changes only on request');
  const detail = await run(f, 'list_proposals', { proposalId: 'p1' }) as Record<string, any>;
  assert.equal(detail.proposals[0].state, 'pending');
  assert.ok(Array.isArray(detail.proposals[0].changes));
  // a person accepts p1: p2 was made against revision 1 and is now stale
  const accepted = await run(f, 'resolve_proposal', { proposalId: 'p1', decision: 'accept', expectedRevision: 1 }, person) as Record<string, any>;
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(f.service.read().title, 'One'); assert.equal(f.service.read().revision, 2);
  const after = await run(f, 'list_proposals', { state: 'all' }) as Record<string, any>;
  assert.deepEqual(after.proposals.map((p: any) => [p.proposalId, p.state, p.review ?? null]), [['p1', 'accepted', null], ['p2', 'pending', 'stale']]);
  assert.equal(after.proposals[1].issues[0].code, 'conflict');
  failed(await run(f, 'list_proposals', { proposalId: 'nope' }));
  failed(await run(f, 'list_proposals', { state: 'sideways' }));
});

test('resolve_proposal is for people: an agent, a missing actor and a wrong kind are refused and nothing changes', async () => {
  const f = fixture();
  await run(f, 'propose_transaction', { transaction: title(f.service, 'Mine', 'p1') }, agent);
  for (const actor of [agent, { id: 'bot', kind: 'system' as const }, undefined]) {
    const refused = failed(await run(f, 'resolve_proposal', { proposalId: 'p1', decision: 'accept', expectedRevision: 1 }, actor));
    assert.equal(refused.issues[0]!.path, 'actor'); assert.match(refused.issues[0]!.message, /Only a person/);
  }
  assert.equal(f.service.read().title, 'Weekly research notebook'); assert.equal(f.box.get('p1')!.state, 'pending');
  const custom = createProposalBox(f.service, { canResolve: actor => actor.id === 'editor-in-chief' });
  const table = resolveActions([...proposalActions(custom)]);
  await runTransportAction(table, f.service, 'propose_transaction', { transaction: title(f.service, 'Custom', 'c1') });
  assert.equal((await runTransportAction(table, f.service, 'resolve_proposal', { proposalId: 'c1', decision: 'reject' }, { actor: person })).ok, false, 'a host decides who counts');
  assert.equal((await runTransportAction(table, f.service, 'resolve_proposal', { proposalId: 'c1', decision: 'reject' }, { actor: { id: 'editor-in-chief', kind: 'agent' } })).ok, true);
});

test('accepting needs the reviewed revision, applies the proposal with its own author, and cannot be repeated differently', async () => {
  const f = fixture();
  await run(f, 'propose_transaction', { transaction: title(f.service, 'Accepted title', 'p1') }, agent);
  const none = failed(await run(f, 'resolve_proposal', { proposalId: 'p1', decision: 'accept' }, person));
  assert.equal(none.issues[0]!.path, 'input.expectedRevision');
  const moved = failed(await run(f, 'resolve_proposal', { proposalId: 'p1', decision: 'accept', expectedRevision: 7 }, person));
  assert.equal(moved.issues[0]!.code, 'conflict'); assert.equal(moved.currentRevision, 1);
  assert.equal(f.service.read().title, 'Weekly research notebook');
  const ok = await run(f, 'resolve_proposal', { proposalId: 'p1', decision: 'accept', expectedRevision: 1, reason: 'Looks right' }, person) as Record<string, any>;
  assert.equal(ok.ok, true); assert.equal(ok.state, 'accepted'); assert.deepEqual(ok.resolved.by, person); assert.equal(ok.resolved.revision, 2); assert.equal(ok.resolved.reason, 'Looks right');
  const revision = f.service.revisions!().at(-1)!;
  assert.deepEqual(revision.actor, agent, 'the revision names the proposal\'s author, the resolution names the person');
  const repeat = await run(f, 'resolve_proposal', { proposalId: 'p1', decision: 'accept', expectedRevision: 2 }, person) as Record<string, any>;
  assert.equal(repeat.ok, true); assert.equal(repeat.duplicate, true); assert.equal(f.service.read().revision, 2, 'applied once');
  const opposite = failed(await run(f, 'resolve_proposal', { proposalId: 'p1', decision: 'reject' }, person));
  assert.equal(opposite.issues[0]!.code, 'conflict');
  failed(await run(f, 'resolve_proposal', { proposalId: 'nope', decision: 'reject' }, person));
});

test('a stale proposal cannot be accepted, stays listed, and can be rejected; reject never touches the document', async () => {
  const f = fixture();
  await run(f, 'propose_transaction', { transaction: title(f.service, 'Late', 'late') });
  f.service.apply({ id: 'someone-else', actor: person, baseRevision: 1, operations: [{ type: 'setTitle', title: 'Someone else was first' }] });
  const refused = failed(await run(f, 'resolve_proposal', { proposalId: 'late', decision: 'accept', expectedRevision: 2 }, person));
  assert.equal(refused.issues[0]!.code, 'conflict');
  assert.equal(f.service.read().title, 'Someone else was first'); assert.equal(f.box.get('late')!.state, 'pending');
  const rejected = await run(f, 'resolve_proposal', { proposalId: 'late', decision: 'reject', reason: 'Out of date' }, person) as Record<string, any>;
  assert.equal(rejected.ok, true); assert.equal(rejected.state, 'rejected'); assert.equal(f.service.read().revision, 2);
});

test('limits: pending proposals are capped with a hint, resolved ones are remembered up to a cap, and bad limits are refused at creation', async () => {
  const service = createReportService(createResearchExample()), box = createProposalBox(service, { maxPending: 2, maxResolved: 1 });
  const table = resolveActions([...proposalActions(box)]);
  const go = (name: string, input: unknown, actor?: typeof person) => runTransportAction(table, service, name, input, actor ? { actor } : {});
  for (const id of ['a', 'b']) assert.equal((await go('propose_transaction', { transaction: title(service, id, id) })).ok, true);
  const full = failed(await go('propose_transaction', { transaction: title(service, 'c', 'c') }));
  assert.match(full.issues[0]!.message, /already 2 proposals/);
  await go('resolve_proposal', { proposalId: 'a', decision: 'reject' }, person);
  assert.equal((await go('propose_transaction', { transaction: title(service, 'c', 'c') })).ok, true, 'room again');
  await go('resolve_proposal', { proposalId: 'b', decision: 'reject' }, person);
  assert.deepEqual(box.list('rejected').map(record => record.id), ['b'], 'only the newest resolved proposal is remembered');
  assert.throws(() => createProposalBox(service, { maxPending: 0 }), /maxPending/);
  assert.throws(() => createProposalBox(service, { canResolve: 'yes' as never }), /canResolve/);
  assert.equal(PROPOSAL_LIMITS.maxPending, 100);
});

test('the box hands out copies and tells a subscriber about every change', async () => {
  const f = fixture(); let calls = 0;
  const off = f.box.subscribe(() => { calls++; throw new Error('a broken listener'); });
  await run(f, 'propose_transaction', { transaction: title(f.service, 'x', 'p1') });
  f.box.get('p1')!.summary = 'tampered'; f.box.list()[0]!.state = 'accepted';
  assert.equal(f.box.get('p1')!.state, 'pending'); assert.notEqual(f.box.get('p1')!.summary, 'tampered');
  await run(f, 'resolve_proposal', { proposalId: 'p1', decision: 'reject' }, person);
  assert.equal(calls, 2); off();
  await run(f, 'propose_transaction', { transaction: title(f.service, 'y', 'p2') });
  assert.equal(calls, 2, 'unsubscribed');
});

test('over a store-backed service the compare-and-swap decides: a lost race leaves the proposal pending', async () => {
  let stored: ResearchDocument = createResearchExample().getSnapshot(), failNext = false;
  const store: DocumentStore = { load: () => stored, save: (document, expectedRevision) => { if (failNext || stored.revision !== expectedRevision) { return { ok: false, currentRevision: stored.revision }; } stored = document; return { ok: true }; } } as DocumentStore;
  const service = createStoreService(store), box = createProposalBox(service);
  const table = resolveActions([...proposalActions(box)]);
  const stub = createReportService(createResearchExample());
  const go = (name: string, input: unknown, actor?: typeof person) => runTransportAction(table, stub, name, input, actor ? { actor } : {});
  assert.equal((await go('propose_transaction', { transaction: { id: 's1', actor: agent, baseRevision: 1, operations: [{ type: 'setTitle', title: 'Stored' }] } })).ok, true);
  failNext = true;
  const lost = failed(await go('resolve_proposal', { proposalId: 's1', decision: 'accept', expectedRevision: 1 }, person));
  assert.equal(lost.issues[0]!.code, 'conflict'); assert.equal(box.get('s1')!.state, 'pending'); assert.equal(stored.title, 'Weekly research notebook');
  failNext = false;
  assert.equal((await go('resolve_proposal', { proposalId: 's1', decision: 'accept', expectedRevision: 1 }, person)).ok, true);
  assert.equal(stored.title, 'Stored'); assert.equal(box.get('s1')!.state, 'accepted');
});

test('HTTP: the actor option decides who is a person, propose is served read-only and resolve never is', async () => {
  const service = createReportService(createResearchExample()), box = createProposalBox(service);
  const actions = [...AGENT_ACTIONS, ...proposalActions(box)];
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`http://local${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const server = createHttpHandler(service, { actions, actor: request => request.headers.get('x-person') ? person : agent });
  const proposed = await server(post('/actions/propose_transaction', { transaction: title(service, 'Over HTTP', 'h1') }));
  assert.equal(proposed.status, 200);
  const bot = await server(post('/actions/resolve_proposal', { proposalId: 'h1', decision: 'accept', expectedRevision: 1 }));
  assert.equal(bot.status, 400); assert.equal(((await bot.json()) as any).issues[0].path, 'actor');
  const claimed = await server(post('/actions/resolve_proposal', { proposalId: 'h1', decision: 'accept', expectedRevision: 1, actor: person }));
  assert.equal(claimed.status, 400, 'the actor option wins over an actor in the body, so an agent cannot claim to be a person');
  const human = await server(post('/actions/resolve_proposal', { proposalId: 'h1', decision: 'accept', expectedRevision: 1 }, { 'x-person': '1' }));
  assert.equal(human.status, 200, JSON.stringify(await human.clone().json()));
  assert.equal(service.read().title, 'Over HTTP');
  const readOnly = createHttpHandler(service, { actions, readOnly: true });
  assert.equal((await readOnly(post('/actions/propose_transaction', { transaction: title(service, 'Read-only proposal', 'h2') }))).status, 200);
  assert.equal((await readOnly(post('/actions/resolve_proposal', { proposalId: 'h2', decision: 'reject' }, { 'x-person': '1' }))).status, 403);
  assert.equal(service.read().title, 'Over HTTP');
});

test('MCP: the server\'s own actor decides, so an agent cannot call itself a person; read-only servers offer propose and list only', async () => {
  const service = createReportService(createResearchExample()), box = createProposalBox(service);
  const actions = [...AGENT_ACTIONS, ...proposalActions(box)];
  const rpc = (mcp: ReturnType<typeof createMcpDispatcher>, name: string, args: unknown, id = 1) => mcp({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) as Promise<{ result: { isError?: boolean; structuredContent: Record<string, any> } }>;
  const agentServer = createMcpDispatcher(service, { actions, actor: agent });
  assert.equal((await rpc(agentServer, 'propose_transaction', { transaction: title(service, 'Via MCP', 'm1') })).result.isError, undefined);
  const refused = await rpc(agentServer, 'resolve_proposal', { proposalId: 'm1', decision: 'accept', expectedRevision: 1, actor: person });
  assert.equal(refused.result.isError, true, 'an extra "actor" argument is not accepted either');
  const asAgent = await rpc(agentServer, 'resolve_proposal', { proposalId: 'm1', decision: 'accept', expectedRevision: 1 });
  assert.equal(asAgent.result.isError, true); assert.equal(asAgent.result.structuredContent.issues[0].path, 'actor');
  const personServer = createMcpDispatcher(service, { actions, actor: person });
  assert.equal((await rpc(personServer, 'resolve_proposal', { proposalId: 'm1', decision: 'accept', expectedRevision: 1 })).result.isError, undefined);
  assert.equal(service.read().title, 'Via MCP');
  const names = listTools({ actions, readOnly: true }).map(tool => tool.name);
  assert.ok(names.includes('propose_transaction') && names.includes('list_proposals') && !names.includes('resolve_proposal'));
  const annotations = Object.fromEntries(listTools({ actions }).filter(tool => tool.name.endsWith('proposal') || tool.name.endsWith('proposals') || tool.name === 'propose_transaction').map(tool => [tool.name, tool.annotations.readOnlyHint]));
  assert.deepEqual(annotations, { propose_transaction: false, list_proposals: true, resolve_proposal: false }, 'only a read is annotated as read-only');
  const readOnlyServer = createMcpDispatcher(service, { actions, readOnly: true, actor: person });
  assert.equal((await rpc(readOnlyServer, 'propose_transaction', { transaction: title(service, 'RO', 'm2') })).result.isError, undefined);
  assert.equal((await rpc(readOnlyServer, 'resolve_proposal', { proposalId: 'm2', decision: 'reject' })).result.isError, true);
  assert.equal(box.get('m2')!.state, 'pending');
});

test('an action list may not mark a read action or a bad value readOnlyOk', () => {
  const base = proposalActions(createProposalBox(createReportService(createResearchExample())))[1]!;
  assert.throws(() => resolveActions([{ ...base, readOnlyOk: true }]), /readOnlyOk/);
  assert.throws(() => resolveActions([{ ...base, access: 'write', readOnlyOk: 'yes' as never }]), /readOnlyOk/);
});
