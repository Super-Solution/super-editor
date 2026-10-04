import { serializeDocument, toHTML, toMarkdown, toPlainText, type ResearchDocument } from '@super-solution/editor-core';

export type ExportFormat = { label: string; extension: string; type: string; render(report: ResearchDocument): string };

/** Every export is a pure function of the document snapshot, so it works the same in a browser, a server and the CLI. */
export const EXPORTS: readonly ExportFormat[] = [
  { label: 'JSON (lossless)', extension: 'json', type: 'application/json', render: serializeDocument },
  { label: 'Markdown', extension: 'md', type: 'text/markdown', render: (report) => toMarkdown(report) },
  { label: 'HTML (standalone)', extension: 'html', type: 'text/html', render: (report) => toHTML(report, { standalone: true }) },
  { label: 'Plain text', extension: 'txt', type: 'text/plain', render: (report) => toPlainText(report) },
];

/** Saves the document as a file named after its title. */
export function download(report: ResearchDocument, format: ExportFormat): void {
  const name = report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'document';
  const url = URL.createObjectURL(new Blob([format.render(report)], { type: `${format.type};charset=utf-8` }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `${name}.${format.extension}` });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
