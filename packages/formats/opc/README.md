# @supersolutions/super-editor-opc

Reads and writes ZIP files and Open Packaging Conventions (OPC) packages, the container behind Word (`.docx`), Excel (`.xlsx`) and PowerPoint (`.pptx`). It depends on nothing, not even Super Editor, so any code that needs an Office file can use it. It uses only web-standard APIs (`CompressionStream`, `TextEncoder`), so it runs unchanged in browsers and Node.js 22+.

```ts
import { createPackage, readZip, RELATIONSHIP_TYPES } from '@supersolutions/super-editor-opc';

const pkg = createPackage();
pkg.addPart('word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', xml);
pkg.addRelationship(null, { type: RELATIONSHIP_TYPES.officeDocument, part: 'word/document.xml' });
const bytes = await pkg.toBytes({ modified: '2026-01-01T00:00:00Z' });   // same input, same bytes

const files = await readZip(bytes);                                      // Map<path, Uint8Array>
```

## What it does

- **`writeZip(entries, { modified?, compress? })`** writes a ZIP with STORE or DEFLATE entries. The output is deterministic: the stored time defaults to 1980-01-01, so the same input gives the same bytes. File names may be in any script (UTF-8 names are flagged as such). It refuses what it cannot write correctly: ZIP64-size archives, unsafe or duplicate names.
- **`readZip(bytes, limits?)`** reads every entry into memory and checks as it goes: size and CRC-32 of every entry, path safety (no absolute paths, no `..`), duplicates, entry count (default 5 000), entry size (32 MiB) and total size (128 MiB). Inflating stops the moment an entry exceeds what it declared, so a small file cannot expand without bound. Encryption, ZIP64 and methods other than STORE and DEFLATE are refused. Problems are a `ZipError` with a `code` to branch on (`not-a-zip`, `corrupt`, `unsupported`, `too-large`, `unsafe-path`, `duplicate`, `invalid-input`); nothing is half read.
- **`createPackage()`** collects parts with content types and relationships and writes `[Content_Types].xml` and every `.rels` file, with relative targets. `toBytes` refuses an inconsistent package (a relationship to a part that does not exist, a bad content type) instead of writing a file Word would "repair". Relationship ids are `rId1`, `rId2`, … per source, in the order added, so a caller can know them before writing the body.
- **`xmlText(text)`** returns text that XML 1.0 can hold (XML-invalid characters become U+FFFD) and says how many it replaced; `escapeXmlText` and `escapeXmlAttribute` escape. A host that writes XML should report the count rather than hide it.
- `crc32`, `pathProblem` and `RELATIONSHIP_TYPES` are exported for tools of your own.

## What it does not do

No ZIP64, no encryption, no streaming (everything is in memory, bounded by the limits), no XML parsing and no knowledge of any one Office format: what goes inside the parts is the caller's. Writing an archive that real Word, Excel or PowerPoint accept is the caller's responsibility; this package guarantees a correct container.

## Verification

`tests/opc.test.ts`: the CRC check value; round trips in STORE and DEFLATE with names in several scripts; refusal of truncated, corrupt, unsafe, duplicate and oversized archives; a zip-bomb case; archives written here tested by `unzip` and Python's `zipfile`, and an archive made by Info-ZIP `zip` read here (those two tests skip when the tool is not installed); XML character handling; package consistency.

GPL-3.0-or-later; the license text is included. See [docs/FORMATS.md](../../../docs/FORMATS.md) for where this package sits among the format packages.
