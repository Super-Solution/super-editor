# Library scorecard

Scores are 1 to 10 and are only moved when a round produced evidence (a test, a measurement, a differential run). A score
without a reason in the "Evidence" column is a guess and should be lowered. Newest round last.

| Objective | Baseline (before round 1) | Latest | Evidence for the latest score |
| --- | --- | --- | --- |
| Correctness | 8 | 8 | Randomised editor fuzz (6,300 runs of 25 steps; every snapshot revalidates, pre-order holds, undo restores, full unwind reaches the empty document) found no defect. A Markdown round-trip fuzz found two (fixed in round 1) and two rarer ones still open (see log) |
| Performance | 7 | 7 | Not measured yet |
| Simplicity | 7 | 7 | Not assessed yet |
| Extensibility | 7 | 7 | Not assessed yet |
| Composability | 8 | 8 | Not assessed yet |
| Customizability | 7 | 7 | Not assessed yet |
| Consistency | 8 | 8 | TypeScript, Go and Python share generated conformance data; a change to an export has to land in all three |
| Developer experience | 6 | 6 | A fresh clone cannot `npm ci` until `@supersolutions/super-protocol` is published (documented in `docs/RELEASING.md`) |
| Reliability | 8 | 8 | Not re-measured |
| Maintainability | 7 | 7 | Not assessed yet |

## Round history

| Round | Area | Result |
| --- | --- | --- |
| 1 | Markdown export fidelity | Correctness 8 (two defects fixed, two open) |
