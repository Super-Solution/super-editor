import { createBlockId, reservedIds, transaction, type Actor, type ApplyResult, type Editor, type ResearchDocument } from '@super-solution/editor-core';

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Same title, format, citations and blocks (content, citations and nesting by position). Block ids are ignored, since restored blocks get new ones. */
export function sameContent(a: ResearchDocument, b: ResearchDocument): boolean {
  const flat = (report: ResearchDocument): unknown => {
    const position = new Map(report.blocks.map((block, index) => [block.id, index]));
    return [report.title, report.format, report.citations, report.blocks.map((block) => [block.content, block.citationIds, block.parentId === null ? null : position.get(block.parentId)])];
  };
  return same(flat(a), flat(b));
}

/**
 * Restores an earlier revision as one new revision, attributed to `actor`. The editor has no "replace document" operation on purpose:
 * this is an ordinary guarded transaction (title, format, citations, then each block updated, moved, inserted or deleted), so an edit that
 * lands in between is refused instead of overwritten. Deleted block ids stay reserved forever, so blocks deleted since come back under
 * fresh ids (`<old id>-restored-<n>`).
 */
export function restoreRevision(editor: Editor, target: ResearchDocument, actor: Actor): ApplyResult {
  const current = editor.getSnapshot();
  if (sameContent(current, target)) return { ok: false, issues: [{ code: 'validation', message: 'That revision already matches the document.' }], currentRevision: current.revision };
  const tx = transaction(editor, actor);
  if (current.title !== target.title) tx.setTitle(target.title);
  if (!same(current.format, target.format)) tx.setFormat(target.format);
  for (const citation of target.citations) {
    const have = current.citations.find((entry) => entry.id === citation.id);
    if (!have) tx.addCitation(citation); else if (!same(have, citation)) tx.updateCitation(citation);
  }

  // Walk the target in reading order and place every block right after its previous sibling; `order` mirrors the sibling order as it will be.
  const live = new Map(current.blocks.map((block) => [block.id, block]));
  const kept = new Set(target.blocks.filter((block) => live.has(block.id)).map((block) => block.id));
  const order = new Map<string | null, string[]>();
  const siblings = (parent: string | null): string[] => order.get(parent) ?? order.set(parent, []).get(parent)!;
  for (const block of current.blocks) if (kept.has(block.id)) siblings(block.parentId).push(block.id);
  const ids = reservedIds(current), placed = new Map<string, string>(), previous = new Map<string | null, string>();
  const slotAfter = (list: string[], afterId: string | null): number => afterId === null ? 0 : list.indexOf(afterId) + 1;
  for (const block of target.blocks) {
    const parentId = block.parentId === null ? null : placed.get(block.parentId) ?? block.parentId;
    const afterId = previous.get(parentId) ?? null, list = siblings(parentId), existing = live.get(block.id);
    if (!existing) {
      const id = createBlockId(`${block.id.replace(/-restored-\d+$/, '')}-restored`, ids);
      tx.insert({ id, parentId, content: block.content, citationIds: block.citationIds }, afterId);
      list.splice(slotAfter(list, afterId), 0, id); placed.set(block.id, id); previous.set(parentId, id);
      continue;
    }
    placed.set(block.id, block.id); previous.set(parentId, block.id);
    if (!same([existing.content, existing.citationIds], [block.content, block.citationIds])) tx.update(block.id, block.content, block.citationIds);
    if (existing.parentId !== parentId || list[slotAfter(list, afterId)] !== block.id) {
      const from = siblings(existing.parentId);
      from.splice(from.indexOf(block.id), 1);
      list.splice(slotAfter(list, afterId), 0, block.id);
      tx.move(block.id, parentId, afterId);
    }
  }
  // Blocks that are gone from the target. Anything worth keeping was moved out of a deleted container above.
  const gone = current.blocks.filter((block) => !kept.has(block.id) && (block.parentId === null || kept.has(block.parentId)));
  if (gone.length) tx.remove(...gone.map((block) => block.id));
  for (const citation of current.citations) if (!target.citations.some((entry) => entry.id === citation.id)) tx.removeCitation(citation.id);

  return tx.commit();
}
