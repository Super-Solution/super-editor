# Library scorecard

Scores are 1 to 10 and are only moved when a round produced evidence (a test, a measurement, a differential run). A score
without a reason in the "Evidence" column is a guess and should be lowered. Newest round last.

| Objective | Baseline (before round 1) | Latest | Evidence for the latest score |
| --- | --- | --- | --- |
| Correctness | 8 | 9 | Round 5: previews and titles no longer emit lone surrogates; word selection handles non-BMP letters. Randomised editor fuzz (6,300 runs of 25 steps; every snapshot revalidates, pre-order holds, undo restores, full unwind reaches the empty document) found no defect. A Markdown round-trip fuzz found two (fixed in round 1) and two rarer ones still open (see log) |
| Performance | 7 | 8 | `npm run bench`: one edit to a 5,000-block document 82 ms to 38 ms, validation 58 ms to 29 ms (profile-guided). Undo plus redo is still 122 ms. Per-field path strings are still built eagerly |
| Simplicity | 7 | 7 | Not assessed yet |
| Extensibility | 7 | 7 | Not assessed yet |
| Composability | 8 | 8 | Not assessed yet |
| Customizability | 7 | 7 | Not assessed yet |
| Consistency | 8 | 8 | TypeScript, Go and Python share generated conformance data; a change to an export has to land in all three |
| Developer experience | 6 | 7 | `require()` of the packages works and bundlers can tree-shake (tests pin both). A fresh clone cannot `npm ci` until `@supersolutions/super-protocol` is published (documented in `docs/RELEASING.md`) |
| Reliability | 8 | 9 | Round 6: no writer (CLI, MCP, Go, Python) loses permissions or breaks a symlink on save; tests pin it |
| Maintainability | 7 | 7 | Not assessed yet |

## Round history

| Round | Area | Result |
| --- | --- | --- |
| 1 | Markdown export fidelity | Correctness 8 (two defects fixed, two open) |
| 2 | Validation hot path | Performance 7 to 8 |
| 3 | Copy-on-write commits | Performance stays 8 (82 to 38 ms per edit at 5,000 blocks) |
| 4 | Package metadata | Developer experience 6 to 7 |
| 5 | Unicode at the edges | Correctness 8 to 9 (three text-cutting sites, one selection bug) |
| 6 | Saving to disk | Reliability 8 to 9 |
| 7 | HTTP client | Reliability stays 9 (a documented timeout now holds; abort signal added) |
