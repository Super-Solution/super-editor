// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright 2026 SUPER SOLUTION LABS INC
import type { AgentActionContext, AgentActionResult } from './actions.js';
import { InputIssue, check, plainCopy, type Schema } from './input-check.js';
import { withHints } from './issues.js';
import { reviewProposal, type ProposalChange } from './proposal.js';
import { transactionInputSchema } from './schemas.js';
import type { AsyncReportService } from './store.js';
import type { ReportService } from './service.js';
import type { TransportAction } from './transport-actions.js';
import type { Actor, EditorIssue, ResearchDocument, Transaction } from './types.js';

/**
 * A proposal is an agent's transaction that has not been applied: the transaction, who made it, and what a person decided. It lives in a
 * `ProposalBox` that the host creates next to its service. **It is not part of the document**: the document format, the schemas, the
 * Go and Python ports and the shared `AGENT_ACTIONS` are unchanged, and a transport serves the three actions only when the host passes
 * `proposalActions(box)` in its `actions` list. The box is in memory: a restart forgets it. See docs/AGENT-GUIDE.md.
 */
export type ProposalState = 'pending' | 'accepted' | 'rejected';
export type ProposalRecord = {
  /** The transaction's id. */
  id: string;
  state: ProposalState;
  /** The transaction's own actor: who the revision will name if the proposal is accepted. */
  proposedBy: Actor;
  /** The actor of the call that proposed it, when the transport knows one (MCP: the server's actor; HTTP: the `actor` option). */
  submittedBy?: Actor;
  proposedAt: string;
  baseRevision: number;
  summary: string;
  note?: string;
  transaction: Transaction;
  resolved?: { by: Actor; at: string; decision: 'accept' | 'reject'; reason?: string; /** The document revision the accepted proposal created. */ revision?: number };
};
export type ProposalBoxOptions = {
  /** Who may accept or reject. Default: an actor whose `kind` is `human`. Actor kinds are provenance, not authentication: see the guide. */
  canResolve?: (actor: Actor) => boolean;
  /** Pending proposals at most. Default 100; a further proposal is refused until one is resolved. */
  maxPending?: number;
  /** Resolved proposals kept for `list_proposals`, newest. Default 200; older ones are forgotten (the document's revision history keeps what was accepted). */
  maxResolved?: number;
  now?: () => string;
};
export const PROPOSAL_LIMITS = Object.freeze({ maxPending: 100, maxResolved: 200, note: 1000, reason: 1000, page: 100, changes: 50, changeText: 300 });
export interface ProposalBox {
  readonly service: ReportService | AsyncReportService;
  /** A copy of one record, or undefined. */
  get(id: string): ProposalRecord | undefined;
  /** Copies of the records, oldest first. */
  list(state?: ProposalState): ProposalRecord[];
  /** Called after every change (propose, accept, reject). A listener that throws is ignored. Returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** @internal The actions use these; a host has no reason to. */
  readonly internals: { records: Map<string, ProposalRecord & { resolving?: boolean }>; options: Required<Omit<ProposalBoxOptions, 'now'>> & { now: () => string }; changed(): void };
}

/** The box for one service. Pass the same service to `createHttpHandler` / `createMcpDispatcher` so the proposals and the document agree. */
export function createProposalBox(service: ReportService | AsyncReportService, options: ProposalBoxOptions = {}): ProposalBox {
  const limit = (value: number | undefined, fallback: number, name: string): number => {
    if (value === undefined) return fallback;
    if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) throw new TypeError(`${name} must be a whole number from 1 to 10000.`);
    return value;
  };
  if (options.canResolve !== undefined && typeof options.canResolve !== 'function') throw new TypeError('canResolve must be a function (actor) => boolean.');
  const records = new Map<string, ProposalRecord & { resolving?: boolean }>(), listeners = new Set<() => void>();
  const copy = (record: ProposalRecord & { resolving?: boolean }): ProposalRecord => { const { resolving: _resolving, ...rest } = record; return structuredClone(rest); };
  const settings = {
    canResolve: options.canResolve ?? ((actor: Actor) => actor.kind === 'human'),
    maxPending: limit(options.maxPending, PROPOSAL_LIMITS.maxPending, 'maxPending'), maxResolved: limit(options.maxResolved, PROPOSAL_LIMITS.maxResolved, 'maxResolved'),
    now: options.now ?? (() => new Date().toISOString()),
  };
  return {
    service,
    get: id => { const record = records.get(id); return record ? copy(record) : undefined; },
    list: state => [...records.values()].filter(record => state === undefined || record.state === state).map(copy),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    internals: { records, options: settings, changed() { for (const listener of [...listeners]) { try { listener(); } catch { /* a listener cannot break the action */ } } } },
  };
}

// ---------------------------------------------------------------------------------------------------- actions
const idS: Schema = { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]*$', description: 'Letters, digits and . _ : - ; starts with a letter or digit.' };
const objectOf = (properties: Record<string, Schema>, required: string[] = [], defs?: Schema): Schema => ({ type: 'object', properties, required, additionalProperties: false, ...(defs ? { $defs: defs } : {}) });
const failure = (revision: number, issues: EditorIssue[]): AgentActionResult => ({ ok: false, issues: withHints(issues), currentRevision: revision });
const revisionOf = async (box: ProposalBox): Promise<number> => { try { return (await box.service.read()).revision; } catch { return 0; } };
const clip = (text: string | undefined): { text: string; truncated?: true } | undefined => text === undefined ? undefined : text.length <= PROPOSAL_LIMITS.changeText ? { text } : { text: `${text.slice(0, PROPOSAL_LIMITS.changeText)}…`, truncated: true };
function describeChanges(changes: readonly ProposalChange[]): { changes: Record<string, unknown>[]; changesTruncated?: true } {
  const shown = changes.slice(0, PROPOSAL_LIMITS.changes).map(change => {
    const before = clip(change.before), after = clip(change.after);
    return { blockId: change.blockId, kind: change.kind, type: change.type, ...(before ? { before: before.text } : {}), ...(after ? { after: after.text } : {}), ...(before?.truncated || after?.truncated ? { truncated: true } : {}) };
  });
  return { changes: shown, ...(changes.length > shown.length ? { changesTruncated: true as const } : {}) };
}
/** JSON with the keys of every object in order, so two transactions that differ only in key order are the same. */
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);
const prepare = (schema: Schema, input: unknown): Record<string, unknown> => {
  const value = plainCopy(input ?? {}, 'input');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InputIssue({ code: 'validation', message: 'Input must be a JSON object.', hint: 'Send the arguments as an object.', path: 'input' });
  check(schema, value, 'input');
  return value as Record<string, unknown>;
};
const invalid = (revision: number, error: unknown): AgentActionResult => failure(revision, [error instanceof InputIssue ? error.issue : { code: 'validation', message: 'The action could not be completed safely.', hint: 'Check the input against the action schema and retry.' }]);
const entry = (record: ProposalRecord): Record<string, unknown> => ({
  proposalId: record.id, state: record.state, proposedBy: record.proposedBy, ...(record.submittedBy ? { submittedBy: record.submittedBy } : {}), proposedAt: record.proposedAt,
  baseRevision: record.baseRevision, summary: record.summary, ...(record.note ? { note: record.note } : {}), ...(record.resolved ? { resolved: record.resolved } : {}),
});

/**
 * `propose_transaction`, `list_proposals` and `resolve_proposal` for a box, to pass to a transport in its `actions` list:
 *
 *     const box = createProposalBox(service);
 *     createHttpHandler(service, { actions: [...AGENT_ACTIONS, ...proposalActions(box)] });
 *
 * An agent proposes a Core transaction (nothing changes); a person lists what is waiting, with what each would change and whether it is
 * still ready, and accepts or rejects it. Accepting applies the proposal's own transaction through the service, with every guard
 * (revision, block versions, validation) and the service's own conflict handling, so a proposal made against an older revision is
 * refused rather than rebased. `resolve_proposal` is for people only (`canResolve`), and no transport serves it on a read-only endpoint;
 * `propose_transaction` is served there because it never touches the document.
 */
export function proposalActions(box: ProposalBox): readonly TransportAction[] {
  const { records, options, changed } = box.internals;
  const trim = (): void => {
    const resolved = [...records.values()].filter(record => record.state !== 'pending');
    for (const record of resolved.slice(0, Math.max(0, resolved.length - options.maxResolved))) records.delete(record.id);
  };
  const propose: TransportAction = Object.freeze({
    name: 'propose_transaction', title: 'Propose a change for review',
    description: 'Propose a Core transaction (the same object apply_transaction takes) for a person to review. NOTHING in the document changes: the proposal waits until a person accepts it. Use this instead of editing when you are not sure the change is wanted. The transaction is fully checked now (structure, guards, the resulting document) and refused with the issues if it is invalid or its baseRevision is not the current revision (read the document again and re-propose). Returns proposalId (the transaction id), a one-sentence summary and each change (block, kind, before and after text). Send the same transaction id again and you get the same proposal back (duplicate: true); a different transaction needs a new id. Use list_proposals to see its state.',
    access: 'write' as const, readOnlyOk: true, destructive: false, idempotent: true,
    inputSchema: { ...objectOf({ transaction: (transactionInputSchema.properties as Record<string, Schema>).transaction as Schema, note: { type: 'string', minLength: 1, maxLength: PROPOSAL_LIMITS.note, description: 'Why you propose this, for the reviewer.' } }, ['transaction']), $defs: transactionInputSchema.$defs },
    async run(_service, input, context: AgentActionContext = {}) {
      let values: Record<string, unknown>;
      try { values = prepare(this.inputSchema, input); } catch (error) { return invalid(await revisionOf(box), error); }
      const document: ResearchDocument = await box.service.read();
      const review = reviewProposal(document, values.transaction, { now: options.now });
      if (review.status !== 'ready' || !review.transaction) {
        return failure(document.revision, review.issues.length ? review.issues : [{ code: 'validation', message: 'The transaction is not valid.', hint: 'Check it against the transaction schema.' }]);
      }
      const transaction = review.transaction, existing = records.get(transaction.id);
      if (existing) {
        if (same(existing.transaction, transaction)) return { ok: true, revision: document.revision, duplicate: true, ...entry(existing), ...describeChanges(review.changes) };
        return failure(document.revision, [{ code: 'duplicate', message: `A proposal with the id "${transaction.id}" already exists and its content is different.`, path: 'input.transaction.id', hint: 'Use a new transaction id for a different change, or send the identical transaction to get the existing proposal back.' }]);
      }
      if ([...records.values()].filter(record => record.state === 'pending').length >= options.maxPending) return failure(document.revision, [{ code: 'validation', message: `There are already ${options.maxPending} proposals waiting.`, path: 'input', hint: 'Wait for a person to accept or reject some (list_proposals shows them), then propose again.' }]);
      const record: ProposalRecord = {
        id: transaction.id, state: 'pending', proposedBy: transaction.actor, ...(context.actor ? { submittedBy: context.actor } : {}), proposedAt: options.now(), baseRevision: transaction.baseRevision,
        summary: review.summary, ...(typeof values.note === 'string' ? { note: values.note } : {}), transaction,
      };
      records.set(record.id, record); changed();
      return { ok: true, revision: document.revision, ...entry(record), ...describeChanges(review.changes) };
    },
  });

  const list: TransportAction = Object.freeze({
    name: 'list_proposals', title: 'List proposals waiting for review',
    description: 'List proposals made with propose_transaction: oldest waiting first, with who proposed each, a one-sentence summary and, for a waiting proposal, review: "ready" (it applies to the document as it is now), "stale" (the document moved on; it must be proposed again) or "invalid". Pass proposalId, or detail: true, to include each change (block, kind, before and after text, shortened). state defaults to "pending"; "all" includes accepted and rejected ones that are still remembered. Read-only.',
    access: 'read' as const, destructive: false, idempotent: true,
    inputSchema: objectOf({
      proposalId: { ...idS, description: 'Only this proposal, with its changes.' },
      state: { enum: ['pending', 'accepted', 'rejected', 'all'], description: 'Default "pending".' },
      detail: { type: 'boolean', description: 'Include the changes of every proposal on the page.' },
      limit: { type: 'integer', minimum: 1, maximum: PROPOSAL_LIMITS.page }, offset: { type: 'integer', minimum: 0 },
    }),
    async run(_service, input) {
      let values: Record<string, unknown>;
      try { values = prepare(this.inputSchema, input); } catch (error) { return invalid(await revisionOf(box), error); }
      const document: ResearchDocument = await box.service.read();
      if (typeof values.proposalId === 'string') {
        const record = records.get(values.proposalId);
        if (!record) return failure(document.revision, [{ code: 'not-found', message: `No proposal "${values.proposalId}".`, path: 'input.proposalId', hint: 'list_proposals without proposalId shows the ones that exist. A restarted server forgets its proposals.' }]);
        return { ok: true, revision: document.revision, total: 1, offset: 0, count: 1, proposals: [describe(record, document, true)] };
      }
      const state = (values.state as string | undefined) ?? 'pending';
      const matching = [...records.values()].filter(record => state === 'all' || record.state === state);
      const offset = (values.offset as number | undefined) ?? 0, limit = (values.limit as number | undefined) ?? 20;
      const page = matching.slice(offset, offset + limit);
      return { ok: true, revision: document.revision, total: matching.length, offset, count: page.length, ...(offset + page.length < matching.length ? { truncated: true } : {}), proposals: page.map(record => describe(record, document, values.detail === true)) };
    },
  });
  function describe(record: ProposalRecord, document: ResearchDocument, detail: boolean): Record<string, unknown> {
    if (record.state !== 'pending') return entry(record);
    const review = reviewProposal(document, record.transaction, { now: options.now });
    return { ...entry(record), review: review.status, ...(review.status === 'ready' ? {} : { issues: withHints(review.issues) }), ...(detail ? describeChanges(review.changes) : {}) };
  }

  const resolve: TransportAction = Object.freeze({
    name: 'resolve_proposal', title: 'Accept or reject a proposal (people only)',
    description: 'Accept or reject a proposal. Only a person can: the call must come from a human actor, and an agent is refused. Accept applies the proposal\'s own transaction to the document (one revision, by the proposal\'s author) and needs expectedRevision, the document revision the reviewer looked at; if the document moved the call is refused as a conflict and nothing changes, so look again with list_proposals. A proposal that is no longer ready (stale or invalid) cannot be accepted and stays listed until rejected. Reject never touches the document. Repeating the same decision returns the same result (duplicate: true); the opposite decision is a conflict.',
    access: 'write' as const, destructive: true, idempotent: true,
    inputSchema: objectOf({
      proposalId: { ...idS, description: 'From list_proposals.' },
      decision: { enum: ['accept', 'reject'] },
      expectedRevision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: 'Required to accept: the document revision that was reviewed.' },
      reason: { type: 'string', minLength: 1, maxLength: PROPOSAL_LIMITS.reason, description: 'Recorded with the decision.' },
    }, ['proposalId', 'decision']),
    async run(_service, input, context: AgentActionContext = {}) {
      let values: Record<string, unknown>;
      try { values = prepare(this.inputSchema, input); } catch (error) { return invalid(await revisionOf(box), error); }
      const actor = context.actor;
      if (!actor || !options.canResolve(actor)) return failure(await revisionOf(box), [{ code: 'validation', message: 'Only a person can accept or reject a proposal.', path: 'actor', hint: actor ? `The caller is "${actor.id}" (${actor.kind}). Ask a person to review it, or give the call the person's actor ({ id, kind: "human" }) from your own sign-in.` : 'The call named no actor. The host must pass the signed-in person as the actor.' }]);
      const record = records.get(values.proposalId as string);
      if (!record) return failure(await revisionOf(box), [{ code: 'not-found', message: `No proposal "${values.proposalId as string}".`, path: 'input.proposalId', hint: 'list_proposals shows the ones waiting. A restarted server forgets its proposals.' }]);
      const decision = values.decision as 'accept' | 'reject', now = options.now();
      if (record.state !== 'pending') {
        const earlier = record.resolved!;
        if (earlier.decision === decision) return { ok: true, revision: await revisionOf(box), duplicate: true, ...entry(record) };
        return failure(await revisionOf(box), [{ code: 'conflict', message: `The proposal was already ${record.state} by ${earlier.by.id} at ${earlier.at}.`, path: 'input.decision', hint: 'A resolved proposal cannot be reversed. Propose the change again with a new transaction id.' }]);
      }
      if (record.resolving) return failure(await revisionOf(box), [{ code: 'conflict', message: 'Another call is resolving this proposal right now.', path: 'input.proposalId', hint: 'Call list_proposals to see the outcome.' }]);
      const reason = typeof values.reason === 'string' ? values.reason : undefined;
      if (decision === 'reject') {
        record.state = 'rejected'; record.resolved = { by: actor, at: now, decision, ...(reason ? { reason } : {}) }; trim(); changed();
        return { ok: true, revision: await revisionOf(box), ...entry(record) };
      }
      const expected = values.expectedRevision as number | undefined;
      if (expected === undefined) return failure(await revisionOf(box), [{ code: 'validation', message: 'Accepting needs expectedRevision.', path: 'input.expectedRevision', hint: 'Pass the document revision the reviewer looked at (list_proposals returns it as revision).' }]);
      record.resolving = true;
      try {
        const document: ResearchDocument = await box.service.read();
        if (document.revision !== expected) return failure(document.revision, [{ code: 'conflict', message: `The document is at revision ${document.revision}, not ${expected}: it changed after it was reviewed.`, path: 'input.expectedRevision', hint: `Call list_proposals to see whether the proposal is still ready, review it again, then retry with expectedRevision ${document.revision}.` }]);
        const applied = await box.service.apply(record.transaction);
        if (!applied.ok) return failure(applied.currentRevision, applied.issues.map(issue => issue.code === 'conflict' ? { ...issue, hint: issue.hint ?? 'The document moved on since the proposal was made. Reject it and ask the agent to propose again.' } : issue));
        record.state = 'accepted'; record.resolved = { by: actor, at: now, decision, revision: applied.document.revision, ...(reason ? { reason } : {}) };
        trim(); changed();
        return { ok: true, revision: applied.document.revision, ...entry(record) };
      } finally { delete record.resolving; }
    },
  });
  return Object.freeze([propose, list, resolve]);
}
