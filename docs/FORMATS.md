# Formats: exporting and importing documents

A document leaves the editor as Markdown, HTML, plain text or a Word file, and (for Markdown) comes back in. Every format answers to the same contract, so a host, an HTTP route or an agent can offer "export as …" without knowing the formats, and **a loss is never silent**: each result carries `warnings` that say what the format could not hold and what to do about it.

This page is the reference for the contract in `@supersolutions/super-editor-core` (`formats.ts`, `formats-builtin.ts`) and for the packages `@supersolutions/super-editor-opc` and `@supersolutions/super-editor-docx`. Per package details: [opc](../packages/formats/opc/README.md), [docx](../packages/formats/docx/README.md).

## The contract

```ts
interface Exporter<Options> {            // also SyncExporter, whose export() never waits
  id: string; label: string; mime: string; ext: string;
  capabilities: FormatCapability[];      // what it carries in full, beyond running text
  fidelity: FidelityTable;               // what it cannot carry, per document feature
  export(document: ResearchDocument, options?: Options): ExportResult | Promise<ExportResult>;
}
interface Importer<Options extends ImportBaseOptions> {   // also SyncImporter
  id: string; label: string; mime: string; extensions: string[];
  losses: Record<string, string>;        // warning code -> hint, published before any import
  import(input: string | Uint8Array, options: Options): ImportResult | Promise<ImportResult>;
}
type ExportResult = { ok: true; data: string | Uint8Array; mime; ext; warnings: FormatWarning[] } | { ok: false; issues: EditorIssue[] };
type ImportResult = { ok: true; document: ResearchDocument; warnings: FormatWarning[] } | { ok: false; issues: EditorIssue[] };
```

Rules every format follows (and `tests/formats.test.ts` checks for the built-in ones):

- **Never throws on bad input.** A bad document, unknown or mistyped option, or bytes that are not valid for the format come back as `issues`, each with a `path` and a `hint`. Unknown option names are refused, not ignored.
- **Never silently loses.** Anything the output cannot carry is a warning. The text formats and Word list the same table in `fidelity`, so a host can show the limits before exporting.
- **Never changes the document.** An exporter does not mutate its input. The same document and options give the same output (the DOCX bytes are identical run to run).
- **Text is carried exactly.** Valid Unicode (Chinese, emoji, any script) is written as is. Text that cannot be written in the format (XML control characters in Word) is replaced and **counted in a warning**; invalid UTF-8 on import is refused, not repaired.

### Warnings

```ts
type FormatWarning = { code: string; message: string; hint: string; feature?: DocumentFeature; count?: number; blockIds?: string[]; path?: string };
```

One warning per affected feature, not one per block, so a long document gets a short list of causes. `count` says how many uses there are, `blockIds` lists the first 20 in document order, `path` points at the first use. Match on `code`; `message` and `hint` are for people and agents (the hint is always the same words for the same cause, so one fix covers every instance).

| Code | Raised by | Meaning |
| --- | --- | --- |
| `feature-degraded` | every exporter, from its fidelity table | The feature is present in another form (a chart as its data table). |
| `feature-dropped` | every exporter, from its fidelity table | The feature is not in the output at all. |
| `chart-rows-omitted` | Markdown, HTML, text and Word exporters | A chart's data table was cut to `chartRows` rows. |
| `invalid-xml-characters` | Word exporter | Control characters Word files cannot hold were replaced by U+FFFD; `count` says how many. |
| `markdown-html-kept-as-text` | Markdown importer | A line that starts with an HTML tag or comment is kept as literal text. |
| `markdown-setext-heading-kept-as-text` | Markdown importer | A heading underlined with `===` or `---` is not read as a heading. |
| `markdown-heading-level-clamped` | Markdown importer | Headings deeper than level 3 become level 3. |
| `markdown-footnotes-kept-as-text` | Markdown importer | Footnotes stay as text; no citation is invented. |
| `markdown-inline-formatting-flattened` | Markdown importer | Bold, italic, code and links inside list items and table cells become plain text (link targets stay in parentheses). |
| `markdown-image-kept-as-text` | Markdown importer | Only `https` images are imported. |
| `redline-block-replaced` | Word redline | A changed table, list, chart or other non-text block is shown as the old block deleted and the new one inserted. |
| `redline-move-not-tracked` | Word redline | A moved block is shown at its new position without a tracked change. |
| `redline-format-not-tracked` | Word redline | A change of page size, font, font size or line height is not shown. |
| `redline-no-changes` | Word redline | The two documents are the same; the file has no tracked changes. |

### Features and fidelity

`scanFeatures(document)` lists which of these a document uses; `lossWarnings(document, table)` turns a table into warnings.

`underline`, `highlight`, `strike`, `inline-code`, `hyperlink`, `citations`, `toggle`, `todo-list`, `nested-list`, `table-alignment`, `table-header-column`, `chart`, `card`, `embed`, `image`, `callout`, `metrics`, `timestamp`, `toc`, `page-break`, `page-format`.

Plain paragraphs, headings, sections, lists, tables, code and quotes are not listed because every format has them. A feature missing from a format's table is carried in full.

| Feature | Markdown | HTML | Plain text | Word (.docx) |
| --- | --- | --- | --- | --- |
| `underline`, `highlight` | dropped | carried | dropped | carried (highlight as shading) |
| `strike`, `inline-code` | carried | carried | dropped | carried |
| `hyperlink` | carried | carried | dropped (text only) | carried |
| `toggle` | degraded (bold title, content below) | carried | degraded (title line) | degraded (bold title, content below) |
| `todo-list` | carried | carried | carried | degraded (☐ and ☑ characters) |
| `table-alignment` | carried | carried | dropped | carried |
| `table-header-column` | dropped | carried | dropped | carried |
| `chart` | degraded (data table) | degraded (table in a figure) | degraded (data listing) | degraded (title and data table) |
| `card` | degraded (alt text) | degraded (alt text in a figure) | degraded (alt text) | degraded (title and alt text) |
| `embed` | degraded (link) | degraded (link) | degraded (title and URL) | degraded (link) |
| `image` | carried | carried | degraded (`[Image: alt]`) | degraded (`[Image: alt]` and a link; **no picture is embedded**) |
| `callout` | degraded (GitHub alert) | carried | degraded (tone and title) | carried |
| `metrics` | degraded (table) | carried | degraded (one line each) | degraded (table) |
| `timestamp` | degraded (`label: time`) | carried | carried | degraded (`label: time`) |
| `toc` | degraded (fixed outline list) | carried | degraded (indented list) | degraded (fixed list of links, no page numbers) |
| `page-break` | carried | carried | degraded (a rule) | carried |
| `page-format` | dropped | dropped | dropped | carried (paper size; fonts by option) |

The tables themselves (`MARKDOWN_FIDELITY`, `HTML_FIDELITY`, `TEXT_FIDELITY`, `DOCX_FIDELITY`) are the source of truth and each has a test that compares it with what the output really contains. If this page and a table differ, the table wins; report the page.

## The registry

```ts
const formats = createFormatRegistry();
formats.addExporter(markdownExporter); formats.addExporter(htmlExporter); formats.addExporter(textFormatExporter);
formats.addExporter(docxExporter); formats.addImporter(markdownImporter);

formats.exporters();                                   // id, label, mime, ext, capabilities, fidelity
const out = await formats.export('docx', document, { footer: '{page} / {pages}' });
formats.importerForFile('report.MD');                  // the Markdown importer
```

Ids: exporters `markdown`, `html`, `text` (all in core) and `docx` (the Word package); importer `markdown`.

Registration is explicit: nothing is registered for you, because a host decides which formats it offers and an optional package (Word) must not be pulled in by core. Duplicate ids throw. `export` validates the document first, always resolves, and turns an unknown id (with the list of registered ids in the hint) or an implementation that throws into `issues`. A format id is lowercase letters, digits and hyphens.

## Packages

```text
core  <-  docx  ->  opc          (arrows point at the dependency; core and opc import nothing from this repository)
```

| Package | Responsibility | Depends on |
| --- | --- | --- |
| `@supersolutions/super-editor-core` | The contract above, the registry, and Markdown, HTML and plain-text export and Markdown import | nothing |
| `@supersolutions/super-editor-opc` | Zip and Office Open XML package reading and writing (parts, content types, relationships) | nothing |
| `@supersolutions/super-editor-docx` | The Word exporter | core, opc |

**Why Markdown, HTML and text stay in core.** The Go and Python ports reproduce their renderings and test them against `conformance/render.v1.json`; moving them out would split that one conformance contract across packages. They need nothing core does not already have. Word is different: it needs a package writer and has its own release cadence, so it is its own pair of packages, and **opc has no Super Editor dependency** so anything else that reads or writes an OOXML package (xlsx, pptx) can use it without Word code.

**Why opc is not the docx package.** It is a different responsibility with a different audience and heavy code (CRC, DEFLATE through `CompressionStream`, a hardened reader). It uses only web-standard APIs (`CompressionStream`, `TextEncoder`), so it runs unchanged in browsers and Node 22+.

Planned, not built: an importer for `.docx`, PDF export, and a patch mode that applies the editor's changes to a Word file someone else edited (the redline above makes a new file from two versions; it does not patch one). Each would be another package with the same contract.

## Tracked changes (Word redline)

A redline is not an `Exporter`: it needs two documents, so it lives in the Word package as two functions and is not in the registry.

```ts
import { exportDocxRedline, exportProposalDocx } from '@supersolutions/super-editor-docx';

// from an agent's proposed transaction, reviewed against the document as it is now (nothing is applied)
const out = await exportProposalDocx(document, transaction, { changeAuthor: 'research-agent' });
// or from any two versions of the same document
const diff = await exportDocxRedline({ before, after, actor });
```

- New blocks are inserted changes; removed blocks are deleted changes; a new title and new, changed or removed sources are marked.
- Paragraphs, headings, sections, quotes, callouts and toggles are compared **word by word** (each CJK character is its own unit), keeping bold, links and citation markers. Anything else that changed (a table, a list, a chart, ...) is the old block deleted and the new one inserted, with `redline-block-replaced`.
- **Accepting every change gives the new document and rejecting every change gives the old one.** The tests prove it by resolving the XML both ways and comparing with a plain export of each version. Source numbers follow the new document, so a rejected file can show different numbers than the old one when sources were added or removed.
- A stale or invalid proposal is refused with the review's issues. The author defaults to the proposal's actor and the date to the time of the review (or `now()`), so the same input gives the same bytes. `trackChanges` (default true) asks Word to keep tracking later edits.
- Not tracked, and said so in a warning: moves, page-format changes. Formatting-only changes (for example a word made bold) are shown as that word deleted and inserted, not as a formatting change.

## Adding a format

1. Write an `Exporter` or `Importer` in its own package; depend on core for the types and helpers only.
2. Put every loss in a `FidelityTable` and call `lossWarnings(document, table)`, plus `chartRowsWarning` if charts are written as tables. For raised-at-runtime situations use your own code with a stable hint, and list importer codes in `losses`.
3. Check options with `unknownOptionIssues` or your own validator and return issues with a `path` and a `hint`. Check the document with `checkDocument`. Do not throw.
4. Test: the output opens in an **independent** reader, the fidelity table matches the output, text round-trips exactly, bad input is refused with every problem at once, and a large document stays fast.
5. Add the format to the tables on this page; `tests/docs.test.ts` fails if an exporter, importer, feature or warning code is missing here.

## Evidence and limits

What the tests check (see `tests/formats.test.ts`, `tests/opc.test.ts`, `tests/docx.test.ts`):

- **Markdown round trip.** A document that uses only what Markdown carries exports with no warnings and comes back identical on a second pass. For a document that uses more, what the export warned about is exactly what the second pass no longer has.
- **Word files.** Every part is well-formed XML, every part has a content type and every relationship target exists. Child element order follows Word's schema for paragraph, run, table, cell, section, style, numbering and settings properties. The file opens in **python-docx** and in **LibreOffice** (text, structure and Chinese text read back correctly; a page render was inspected). Archives written here open with `unzip` and archives from another writer are read here.
- **Safety.** The zip reader enforces entry count, per-entry and total size, CRC, path safety and a zip-bomb limit; the writer refuses what it cannot write correctly (ZIP64, unsafe names).

What is **not** verified, plainly:

- **Microsoft Word itself was not available.** LibreOffice and python-docx are good evidence that the file is valid, but neither proves that Word shows it as intended or does not offer to "repair" it. Open an export in Word before relying on it.
- **Tracked changes are a comparison, not a stored history.** `exportDocxRedline` and `exportProposalDocx` write them from two documents or from a reviewed proposal (see below); the editor's document itself has no revision history to write, and **comments do not exist in the document model**, so none are written. How Word shows the changes was checked in LibreOffice only, and Microsoft Word was not available.
- **Pictures are not embedded.** `image` becomes alt text and a link, and a chart becomes its data table, because core holds no image bytes and fetching URLs is the host's decision. An image resolver option is the next step if hosts want pictures.
- **No transport yet.** HTTP, MCP, the CLI and the chat plugin do not offer these formats; wiring them changes the shared action table and the Go and Python conformance and needs its own change.
- Fonts are named, not embedded: a reader without the named font substitutes one.
