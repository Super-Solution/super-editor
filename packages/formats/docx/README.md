# @supersolutions/super-editor-docx

Exports a Super Editor document as a Word file (`.docx`: Office Open XML for Word 2013 and later; also opens in LibreOffice and Google Docs). Works in browsers and Node.js 22+, no native code. Depends on `@supersolutions/super-editor-core` (the contract and the document type) and `@supersolutions/super-editor-opc` (the package writer).

```ts
import { createFormatRegistry } from '@supersolutions/super-editor-core';
import { docxExporter, exportDocx } from '@supersolutions/super-editor-docx';

const result = await exportDocx(document, { footer: '{title} · {page} / {pages}', language: 'zh-TW' });
if (result.ok) { save(result.data /* Uint8Array */, `report.${result.ext}`); show(result.warnings); }
else show(result.issues);

// or through the registry, next to the other formats
const formats = createFormatRegistry(); formats.addExporter(docxExporter);
```

`exportDocx` always resolves: a bad document or option comes back as `issues` (every problem at once, each with a `path` and a `hint`), losses come back as `warnings`. The same document and options give identical bytes. The document is never modified.

## How a document maps to Word

| Document | Word |
| --- | --- |
| Title | Title style (omit with `title: false`) |
| Section, heading | Heading 1 to 6: a top-level section is Heading 1, a section inside a section one level deeper, and a heading's level is pushed down by the sections around it (capped at 6); bookmarks for the table of contents |
| Paragraph, quote, code, divider, page break | Normal, Quote, a monospace code style, a rule, a page break |
| Bold, italic, underline, strike, code, links | Run properties and hyperlinks; highlight is shading |
| Bullet and numbered lists, indent | Word numbering (`numbering.xml`); every numbered list restarts at its own number |
| To-do list | Characters ☐ and ☑ (degraded) |
| Table | Real table, fixed layout, header row repeats across pages, alignment, header column |
| Callout | Shaded, bordered paragraphs by tone |
| Citations | Superscript `[n]` links and a **Sources** section at the end |
| Chart | Its title and data table (degraded; no picture) |
| Card, embed, metrics, timestamp, table of contents, toggle | Alt text, link, table, "label: time", a fixed list of links, a bold title with the content below (all degraded) |
| Image | `[Image: alt text]` and a link; **nothing is downloaded or embedded** (degraded) |
| Page format | A4 or letter from the document (a `screen` document is written on A4); options override |

`DOCX_FIDELITY` lists the degraded rows in code, and each use is a warning (`feature-degraded`) with the affected block ids. Other warnings: `chart-rows-omitted` (a chart cut to `chartRows` rows), `invalid-xml-characters` (control characters that a Word file cannot hold were replaced, with a count). Valid text of any script, emoji, tabs and line breaks is written exactly.

## Tracked changes: `exportDocxRedline` and `exportProposalDocx`

```ts
const result = await exportProposalDocx(document, transaction, { changeAuthor: 'research-agent' });   // reviews it, applies nothing
const result2 = await exportDocxRedline({ before, after, actor });                                     // two versions of one document
```

The file is the new document with the differences as Word tracked changes: inserted and deleted blocks, a new title, new or removed sources, and text blocks (paragraphs, headings, sections, quotes, callouts, toggles) changed **word by word**. Accepting all gives the new document and rejecting all gives the old one (tested by resolving the XML both ways). Other changed blocks (tables, lists, charts) are shown as the old block deleted and the new one inserted (`redline-block-replaced`); moves and page-format changes are not tracked (warnings). `REDLINE_LIMITS` lists these warnings. Extra options: `changeAuthor` (default: the proposal's actor), `changeDate` (default: the review time, or the new document's `updatedAt`), `trackChanges` (default true: Word keeps tracking later edits). A stale or invalid proposal returns the review's issues. See [docs/FORMATS.md](../../../docs/FORMATS.md#tracked-changes-word-redline).

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `title` | `true` | Start with the document title |
| `author` | none | Stored as the file's author; never guessed |
| `language`, `eastAsiaLanguage` | `en-US`, none | BCP 47 tags for spell checking and line breaking |
| `fonts` | Calibri, Times New Roman, Consolas | Fonts for `sans`, `serif`, `mono`, and an East Asian font (`eastAsia`) |
| `page` | the document's own | `size` (`A4`, `letter` or millimetres), `orientation`, `marginsMm` |
| `header`, `footer` | none | Text on every page; `{page}`, `{pages}`, `{title}` become Word fields; `align` optional |
| `labels` | English | "Sources", "accessed", "Image", metric table headings, "more rows omitted" |
| `chartRows` | 100 | Data rows kept for a chart table |
| `compress` | `true` | Deflate the parts |

Unknown option names are refused, with the list of valid ones.

## What it does not do

- **No comments**, and plain `exportDocx` writes no tracked changes: the document has no revision history. Use the redline below to show what a proposal or a newer version changes.
- **No pictures.** Images and charts are not drawn or embedded.
- **No import.** There is no `.docx` importer yet.
- **Not verified in Microsoft Word.** (This includes how Word draws the tracked changes; LibreOffice reads and shows them.) The output is checked for well-formed XML, a complete package, Word's schema element order, and opens in python-docx and LibreOffice. Open an export in Word before relying on it.
- Page numbers in a table of contents, live fields other than the page number, and Word styles beyond the built-in set are out of scope.

GPL-3.0-or-later; the license text is included. A commercial license is available from SUPER SOLUTION LABS INC (see the repository README).
