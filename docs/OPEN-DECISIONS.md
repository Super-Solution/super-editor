# Open decisions

What this repository does not decide on its own. Each item says what is true now, what the options are and what each costs, so the owner can decide without re-reading the code. Nothing here is a commitment; nothing listed as "not done" is hidden elsewhere. Written for the 0.8.0 pull request.

## 1. Retired block IDs: when may a deleted ID be reused?

**Now.** A deleted block's ID is reserved for good (`retiredBlockIds`), so an old reference can never point at new content. The list is capped at 100,000 (`RETIRED_LIMIT`). Snapshots share one immutable list, so an edit costs the same however long it is; at 80% of the cap an edit result carries a `retired-ids-near-limit` warning, and at the cap the refusal says how to recover. Go and Python enforce the same cap and say the same words.

**Options.**
- Keep forgetting nothing (today). Safe; a document that churns blocks for years eventually hits the cap, and the only recovery is to start a new document from the live blocks.
- Forget the oldest IDs after N revisions or N days. Keeps documents alive; an agent holding a very old ID could then collide with a new block, which defeats the guarantee the list exists for.
- Compact on an explicit action by a person (`compact_retired_ids`), which records what was dropped in the revision history. Keeps the guarantee as a choice, costs a new action, a schema-free change in all three languages and a conformance update.

**Decision needed:** which policy, and the number. Changing it is a behaviour change across TypeScript, Go and Python and the private Rust implementation.

## 2. Inline content in lists and tables, and comments

**Now.** List items, table cells and titles are plain strings; only paragraphs, quotes and callouts carry `InlineRun`s (bold, links, citation markers). There are no comments in the document model, and nothing in the repository writes or reads one.

**Option A, inline content union** (`items: (string | InlineRun[])[]`, the same for table rows, headings and toggle titles; a string stays a valid shorthand). Non-breaking for existing documents. Touches the schema, validation, Markdown, HTML, Word, rendering, the interactive editor fields, Go, Python and every conformance file.

**Option B, comments** (a thread anchored by a run mark, `commentIds` like `citationId`, and `add_comment` and `resolve_comment` actions). A schema change with the same reach as A, and it makes the document hold review state that today lives only in a proposal.

**Decision needed:** agree (or not) to schema changes of this size, and the order. Both need Go and Python in step; until then this repository will not change the document schema. The in-memory proposal slice in this release is deliberately outside the document so that this decision is not forced.

## 3. Verification in Microsoft Word (and a real screen reader, a real input method)

**Now.** Word exports (tables, numbering, headers and footers, pictures, tracked changes) are checked as well-formed XML, a complete package and Word's schema element order, and open in python-docx and LibreOffice; pictures were checked to be found by python-docx and drawn by LibreOffice. **Nobody has opened a file in Microsoft Word**, so "Word offers to repair it" and "the tracked changes look right" are unverified. The accessibility tests use axe-core, keyboard events and a DevTools-driven composition; no screen reader (NVDA, JAWS, VoiceOver, TalkBack, Narrator), no real IME (Zhuyin, Japanese, Korean, mobile) and only Chromium were used.

**Decision needed:** whether to provide a Word machine for a release gate (a script that opens the sample exports and a person looks), and whether someone who uses a screen reader daily should walk the editor. Neither can be done from a sandbox.

## 4. Licence facts (recorded, not decided)

- This repository: GPL-3.0-or-later for the core, ui, react, element, cli, opc, docx and chat-plugin packages; AGPL-3.0-or-later for the API and MCP servers and the Go and Python server components; a commercial licence is offered by SUPER SOLUTION LABS INC (see the README). The private Rust implementation tests against the same conformance files.
- From the npm registry, as recorded in the competitive review of 2026-11-26: BlockNote's core is MPL-2.0 and its `xl-*` packages are "GPL-3.0 OR PROPRIETARY" (a dual-licence model close to ours); Lexical, Tiptap, ProseMirror, Slate, Milkdown, Plate, Yoopta, Yjs and Hocuspocus are MIT; Quill is BSD-3-Clause; Novel, Univer and Liveblocks are Apache-2.0; CKEditor has its own licence. None of their code is used here; they are design references only. For people who want to embed an editor in a closed-source product, a GPL-3.0-or-later core next to an MPL-2.0 one is a known adoption barrier.
- `axe-core` is MPL-2.0, a `devDependency` pinned exactly, used only by the end-to-end tests and never shipped.
- Copying code or text between GPL-3.0-or-later and MPL-2.0 sources, and what the commercial licence can promise when a contribution came from a GPL-only source, is a question for a lawyer, not for this file.

**Decision needed:** none by this PR; listed so the facts are in one place.

## 5. A vanilla interactive element

**Now.** `<super-editor mode="edit">` mounts the classic editor (a textarea per block). It says so (`data-editor="basic"`, one console warning per page, the docs). The interactive `ReportEditor` is React only. The interaction store in `-ui` does not depend on React, so a DOM layer that reuses it is feasible (about the size of the React layer, roughly 1,100 lines); it would make the element the full editor, and Vue and Svelte hosts could use it without a wrapper.

**Decision needed:** build it (a large change in `-ui` and the element, with its own axe and keyboard tests), or keep `ReportEditor` as the one interactive surface and keep the element for display and basic edits.

## 6. Word import

**Now.** There is no `.docx` importer. `-opc` can read ZIP and OPC packages with limits against zip bombs; what is missing is a small, safe WordprocessingML reader (no new dependency, with warnings for what it drops: comments, tracked changes, fields, embedded objects) and the mapping to blocks.

**Decision needed:** whether Word import is wanted, and which constructs must round trip. mammoth (BSD-2-Clause) is a reference for what is hard, not a dependency.

## 7. Smaller things this release leaves open

- **Proposals.** Held in memory, so a restart forgets them. Accepting is the whole transaction; per-change accept needs splitting a transaction into independent operations with their own guards. Word-level diff exists only in the Word redline, not in core. `ProposalReview` (React) is not bound to the box. Go and Python do not serve the proposal or format actions. Whether `resolve_proposal` should also require a second factor beyond the actor kind is a host question (the docs say actor kinds are provenance, not authentication).
- **Format actions.** Served only when a host passes them; the Go and Python servers have no exporters. A `GET /export.docx` route would need the same in all three languages.
- **Read view.** `withIds` is on the action only, not on `GET /export.md`; there is no size-based chunking (sections are the chunks); the chat plugin has no `getSelection` hook.
- **Embed providers** and the retired-ID policy are closed lists that could become registries like blocks, formats and shortcuts.
- **Right-to-left interface.** Text direction is automatic; the interface (gutter, toolbars, list markers) is not mirrored.
- **Other browsers.** Everything automated runs in Chromium; Firefox and Safari were not run.
