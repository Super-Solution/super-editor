import { documentSchema, getBlock, getOutline, stats, toMarkdown, descendantsOf, transactionSchema, type ReportService } from '@super-solution/editor-core';
import { AGENT_GUIDE } from './guide.js';

export type McpResource = { uri: string; name: string; title: string; description: string; mimeType: string };
export type McpResourceTemplate = { uriTemplate: string; name: string; title: string; description: string; mimeType: string };
export type McpResourceContents = { uri: string; mimeType: string; text: string };

const JSON_TYPE = 'application/json';
export const RESOURCES: readonly McpResource[] = Object.freeze([
  { uri: 'super-editor://document', name: 'document', title: 'Document (JSON)', description: 'The whole versioned document: blocks with versions, citations, revision.', mimeType: JSON_TYPE },
  { uri: 'super-editor://document.md', name: 'document-markdown', title: 'Document (Markdown)', description: 'The document rendered as Markdown. Charts appear as data tables.', mimeType: 'text/markdown' },
  { uri: 'super-editor://outline', name: 'outline', title: 'Outline', description: 'Sections and headings as a nested tree.', mimeType: JSON_TYPE },
  { uri: 'super-editor://stats', name: 'stats', title: 'Statistics', description: 'Word count, reading time and block counts.', mimeType: JSON_TYPE },
  { uri: 'super-editor://citations', name: 'citations', title: 'Citations', description: 'Every source in the document.', mimeType: JSON_TYPE },
  { uri: 'super-editor://schema/document', name: 'document-schema', title: 'Document JSON Schema', description: 'JSON Schema 2020-12 for the document.', mimeType: 'application/schema+json' },
  { uri: 'super-editor://schema/transaction', name: 'transaction-schema', title: 'Transaction JSON Schema', description: 'JSON Schema 2020-12 for transactions, operations and every block type.', mimeType: 'application/schema+json' },
  { uri: 'super-editor://guide', name: 'guide', title: 'Agent quick guide', description: 'How to read and edit this document safely.', mimeType: 'text/markdown' },
]);
export const RESOURCE_TEMPLATES: readonly McpResourceTemplate[] = Object.freeze([
  { uriTemplate: 'super-editor://block/{id}', name: 'block', title: 'One block', description: 'A single block as JSON, with its version.', mimeType: JSON_TYPE },
  { uriTemplate: 'super-editor://section/{id}.md', name: 'section-markdown', title: 'One section as Markdown', description: 'A section, toggle or any block with its descendants rendered as Markdown.', mimeType: 'text/markdown' },
]);

const BLOCK = /^super-editor:\/\/block\/([A-Za-z0-9][A-Za-z0-9._:-]*)$/;
const SECTION = /^super-editor:\/\/section\/([A-Za-z0-9][A-Za-z0-9._:-]*?)\.md$/;

/** Returns the contents of `uri`, or `undefined` when it is not a known resource. */
export function readResource(service: ReportService, uri: string): McpResourceContents | undefined {
  const json = (value: unknown): McpResourceContents => ({ uri, mimeType: JSON_TYPE, text: JSON.stringify(value, null, 2) });
  const document = service.read();
  switch (uri) {
    case 'super-editor://document': return json(document);
    case 'super-editor://document.md': return { uri, mimeType: 'text/markdown', text: toMarkdown(document) };
    case 'super-editor://outline': return json({ revision: document.revision, title: document.title, outline: getOutline(document) });
    case 'super-editor://stats': return json({ revision: document.revision, ...stats(document) });
    case 'super-editor://citations': return json({ revision: document.revision, citations: document.citations });
    case 'super-editor://schema/document': return { uri, mimeType: 'application/schema+json', text: JSON.stringify(documentSchema, null, 2) };
    case 'super-editor://schema/transaction': return { uri, mimeType: 'application/schema+json', text: JSON.stringify(transactionSchema, null, 2) };
    case 'super-editor://guide': return { uri, mimeType: 'text/markdown', text: AGENT_GUIDE };
  }
  const block = BLOCK.exec(uri);
  if (block) {
    const found = getBlock(document, block[1]!);
    return found ? json({ revision: document.revision, block: found }) : undefined;
  }
  const section = SECTION.exec(uri);
  if (section) {
    const root = getBlock(document, section[1]!);
    if (!root) return undefined;
    const scoped = { ...document, blocks: [{ ...root, parentId: null }, ...descendantsOf(document, root.id)] };
    return { uri, mimeType: 'text/markdown', text: toMarkdown(scoped, { title: false }) };
  }
  return undefined;
}
