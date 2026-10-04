import type { OutlineItem } from '@super-solution/editor-core';

type Result = Record<string, unknown>;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
const first = (value: string, max = 100): string => { const line = value.split('\n')[0] ?? ''; return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

export function formatOutline(result: Result): string {
  const lines = [`${text(result.title)}  (revision ${text(result.revision)}, ${text(result.blockCount)} blocks)`];
  const walk = (nodes: OutlineItem[], depth: number): void => { for (const node of nodes) { lines.push(`${'  '.repeat(depth + 1)}${node.id}  [${node.type}${node.type === 'heading' ? ` h${node.level}` : ''}]  ${node.title}`); walk(node.children, depth + 1); } };
  walk(list(result.outline) as OutlineItem[], 0);
  return `${lines.join('\n')}\n`;
}

export function formatFind(result: Result): string {
  const blocks = list(result.blocks) as { id: string; type?: string; version: number; content?: { type: string }; parentId: string | null; text?: string }[];
  const lines = blocks.map(block => `${block.id}  ${block.type ?? block.content?.type ?? ''}  v${block.version}${block.parentId ? `  in ${block.parentId}` : ''}${block.text ? `  ${first(block.text, 80)}` : ''}`);
  lines.push(`${text(result.count)} of ${text(result.total)} block(s)${result.truncated ? `; more with --offset ${Number(result.offset) + Number(result.count)}` : ''}`);
  return `${lines.join('\n')}\n`;
}

export function formatGet(result: Result): string {
  const block = result.block as { id: string; version: number; parentId: string | null; citationIds: string[]; content: { type: string } };
  const ancestors = (list(result.ancestors) as { id: string }[]).map(entry => entry.id);
  return [`${block.id}  ${block.content.type}  version ${block.version}${block.parentId ? `  parent ${block.parentId}` : ''}`,
    ancestors.length ? `path: ${ancestors.join(' > ')} > ${block.id}` : '',
    `children: ${list(result.children).length ? list(result.children).join(', ') : '(none)'}`,
    block.citationIds.length ? `cites: ${block.citationIds.join(', ')}` : '',
    JSON.stringify(block.content, null, 2)].filter(Boolean).join('\n') + '\n';
}

export function formatWrite(result: Result): string {
  const blocks = (list(result.blocks) as { id: string; version: number }[]).map(block => `${block.id}@${block.version}`);
  const extras = ['blockId', 'citationId', 'idPrefix', 'matchedBlocks', 'mode'].filter(key => result[key] !== undefined).map(key => `${key}: ${text(result[key])}`);
  const head = result.dryRun ? `dry run (nothing saved): would reach revision ${text(result.revisionAfter)}` : result.duplicate ? `already applied (revision ${text(result.revision)})` : `ok, revision ${text(result.revision)}`;
  return [`${head}: ${text(result.summary)}`, blocks.length ? `blocks: ${blocks.join(' ')}${result.truncated ? ' …' : ''}` : '', list(result.removed).length ? `removed: ${list(result.removed).slice(0, 20).join(' ')}${list(result.removed).length > 20 ? ' …' : ''}` : '', ...extras].filter(Boolean).join('\n') + '\n';
}

export function formatStats(result: Result): string {
  const by = Object.entries((result.blocksByType ?? {}) as Record<string, number>).map(([type, count]) => `${type} ${count}`).join(', ');
  return [`title: ${text(result.title)}`, `revision: ${text(result.revision)}`, `words: ${text(result.words)}  characters: ${text(result.characters)}  reading: ${text(result.readingMinutes)} min`,
    `blocks: ${text(result.blocks)} (${by})`, `charts: ${text(result.charts)}  tables: ${text(result.tables)}  images: ${text(result.images)}  citations: ${text(result.citations)}`].join('\n') + '\n';
}

export function formatRevisions(result: Result): string {
  const rows = list(result.revisions) as { number: number; at: string; actor: { id: string; kind: string }; summary: string }[];
  if (!rows.length) return `${text(result.note) || 'No revisions recorded.'}\n`;
  return `${rows.map(row => `#${row.number}  ${row.at}  ${row.actor.id}:${row.actor.kind}  ${row.summary}`).join('\n')}\n`;
}

export function formatTemplates(result: Result): string {
  return `${(list(result.templates) as { kind: string; title: string; description: string }[]).map(entry => `${entry.kind.padEnd(11)} ${entry.title}: ${entry.description}`).join('\n')}\n`;
}

export function formatTools(result: Result): string {
  return `${(list(result.actions) as { name: string; access: string; destructive: boolean; description: string }[]).map(entry => `${entry.name.padEnd(20)} ${entry.access === 'read' ? 'read ' : entry.destructive ? 'write!' : 'write'}  ${first(entry.description.split('. ')[0] ?? entry.description, 90)}`).join('\n')}\n`;
}

export function formatValidate(result: Result): string {
  return `valid: ${text(result.blocks)} blocks, ${text(result.citations)} citations, revision ${text(result.revision)}${result.transaction ? `; transaction would reach revision ${text(result.revisionAfter)} (${text(result.summary)})` : ''}\n`;
}
