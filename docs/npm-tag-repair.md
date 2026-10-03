# Prerelease tag repair

This fixed-scope manual workflow removes only `latest` pointing to `0.1.0-next.0` from `@super-solution/editor-{core,ui,react,api,mcp,cli}`. It does not publish, unpublish, change package versions, move `next`, or modify credentials/permissions. All six packages must contain the expected version and have `next` pointing to it; any other `latest` aborts before writes. An already absent `latest` is skipped, allowing a partial run to resume.

After review and merge to main, open **Actions → Repair prerelease latest tags → Run workflow**, selecting main. The workflow uses the existing organization `NPM_TOKEN` through setup-node, with the same concurrency group as publication. No local npm login or new secret is needed. Download the `npm-tag-repair-<run-id>` audit artifact: it records source commit, public tags, version tarball descriptors, per-package readbacks, and a final six-package readback. A failure stops further removal and preserves an audit of completed work.

Every removal has an immediate public registry reread. npm's dist-tag removal API has no compare-and-swap precondition, so a separate owner changing tags between that read and removal remains a race. Avoid concurrent external tag administration during this short workflow; the shared concurrency group serializes this repository's publish and repair workflows. Unexpected state is reported, never automatically retagged or rolled back.

Exact-version consumers remain pinned to `0.1.0-next.0`; all version entries, integrity/shasum/tarball descriptors, `next` and unrelated tags must match the baseline. Tag removal does not remove a published tarball. The audit verifies registry metadata preservation, rather than redownloading tarballs or rerunning consumer installation.

Future prerelease publication has read-only checks before publication, immediately before each write, and after the release: `latest` must initially be absent or stable and must retain its baseline, while `next` must match the released candidate. A failed tag check does not move tags or undo already published immutable versions; investigate and authorize any remediation separately.
