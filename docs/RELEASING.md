# Controlled npm releases

The reset release line starts at stable **0.1.0** on the npm dist-tag **latest**, for all eight packages. `@supersolutions/super-editor-chat-plugin` also depends on the Apache-2.0 `@supersolutions/super-protocol` (published from the super-chat repository): publish that first, then regenerate `package-lock.json` with `npm install --package-lock-only --ignore-scripts` before the release check. Later prereleases (`X.Y.Z-next.N`) use the `next` tag. This does not assert that any npm package has already been published.

Licenses: `core`, `ui`, `react`, `element`, `chat-plugin` and `cli` are GPL-3.0-or-later; `api` and `mcp` are AGPL-3.0-or-later. The texts live in `LICENSES/`; `scripts/release-contract.mjs` maps packages to licenses and `scripts/package-build.mjs` copies the matching text into each package. `release:check` fails if a tarball carries the wrong text.

| Package | Direct runtime dependencies | Purpose |
| --- | --- | --- |
| @supersolutions/super-editor-core | none | documents, operations, revisions, schemas, shared service |
| @supersolutions/super-editor-ui | core | DOM renderers and CSS |
| @supersolutions/super-editor-react | core, ui; React peer | React components and subscription hook |
| @supersolutions/super-editor-element | core, ui | `<super-editor>` web component (view or edit, any framework) |
| @supersolutions/super-editor-chat-plugin | core, ui, @supersolutions/super-protocol | super-chat plugin: research documents as chat cards |
| @supersolutions/super-editor-api | core | HTTP adapter, OpenAPI document, typed client |
| @supersolutions/super-editor-mcp | core | MCP server (stdio binary `super-editor-mcp`) and dispatcher |
| @supersolutions/super-editor-cli | core | local JSON CLI (`super-editor`) |

Core has no DOM, React, network or filesystem imports. API, MCP and CLI reuse Core's `createReportService`; they do not copy the operation engine or depend on each other. The earlier `@super-editor/*` names were never published and are replaced, not maintained as aliases.

## Prerequisites still owned by the organization

Configure Trusted Publishing separately for each of the eight packages in the table above:
GitHub organization Super-Solution, repository super-editor, workflow filename
publish.yml, environment empty, and allow direct npm publish. An npm maintainer
must complete account 2FA for this one-time setup. Setting trust does not change or
republish existing versions. Configure near the next planned release: a new trust
configuration expires if unused for two days.

The manual release uses GitHub-hosted runners and npm OIDC authentication without
an npm token. Existing token-based tag-repair/authentication maintenance workflows
are separate from publishing and are not migrated by this change; do not revoke a
shared organization token until those remaining consumers are accounted for.
No paid usage or secret changes are part of this setup.

## Verification before publication

```sh
npm ci --ignore-scripts
npm run check
npm run build:demo
npm run example
npm run release:check
```

`release:check` performs `npm pack --dry-run --json --ignore-scripts` and actual pack for every package, compares file lists, then reads the tarballs without extracting them. It enforces a strict package file allowlist, checks all public export/type/bin targets, preserves the root owner LICENSE exactly, and rejects common credential patterns and user home paths. Pattern scanning is a guard, not proof that arbitrary sensitive data cannot exist; review the allowlisted code and README files as well.

The check installs all eight tarballs into a separate consumer project, checks ESM imports, Core conflicts, HTTP, MCP, React SSR, emitted declarations, CLI binary and the CSS asset. This consumer resolves tarball dependencies rather than workspace source aliases. The verification phase needs no token. Artifacts and a checksum/integrity manifest are written under ignored `artifacts/release/`. CI additionally requires a clean tracked source tree.

## Bumping the version

All eight packages move together, so a version change touches the root workspace, eight manifests, every internal exact dependency and the `publishConfig.tag`. `scripts/bump-version.mjs` does exactly that and nothing else:

```sh
node scripts/bump-version.mjs 0.3.0-next.0
npm install --package-lock-only --ignore-scripts   # refresh the lockfile
npm run check && npm run release:check
```

It accepts only a stable version (`1.2.3`, channel `latest`) or a prerelease of the form `1.2.3-next.N` (channel `next`), the same rule `scripts/release-contract.mjs` enforces; anything else (`1.2.3-rc.0`, `01.2.3`, `latest`, a version with extra arguments) exits non-zero before a file is written. It sets `publishConfig.tag` from the version and leaves the registry, access level, `files` allow-list, exports, bin entries and dependencies' names alone. It does not read or write tokens, workflows or the lockfile. Running it twice with the same version changes nothing. `tests/bump-version.test.mjs` runs it on a scratch copy of the manifests and then loads the result through `releasePackages`, so a bump that the release workflow would refuse fails the test suite first. Commit the result in a reviewed change; the publish workflow still takes the exact committed version as its input.

## Manual release

After reviewed code is merged to `main`, an authorized repository operator runs **Publish npm packages** using `workflow_dispatch`, selecting `main`, the exact committed version, and its matching channel. There is no push/PR publication trigger. An input cannot change the package version: a new version requires a reviewed commit updating all eight manifests, internal exact dependency versions, root version, publishConfig tag and lockfile.

The workflow checks out the exact requested commit and runs the complete checks itself. The same job publishes its locally verified eight tarballs and manifest; no Actions artifact upload/download is needed. Publication verifies the source SHA, manifest identity, package order, byte size, SHA256 and SHA512 integrity before any npm write. Release order is core -> ui -> react -> element -> chat-plugin -> api -> mcp -> cli. All registry preflights finish before the first publish.

A version already on npm with different bytes causes an error; it is never overwritten. On retry after a partial release, an existing version with identical integrity is skipped. Missing versions are published in order. There is no unpublish, force, permission-bypass or automated rollback. A partial release can happen if the registry/authentication fails mid-run; correct the external problem and re-run the same verified commit, or review a new version. Published immutable bytes cannot be edited in place.

All actions are pinned to verified full commit SHAs. The workflow uses `contents: read` and `id-token: write`; npm validates the separately configured trusted publisher identity. Future stable releases use `latest` only when the committed version has no prerelease suffix and all publishConfig tags match.

## Consumer migration

Once the candidate is actually available:

```sh
npm install @supersolutions/super-editor-core @supersolutions/super-editor-react
npm install @supersolutions/super-editor-api @supersolutions/super-editor-mcp
```

Import `createReportService`, `documentSchema`, `transactionSchema`, `createTemplate` and `AGENT_ACTIONS` from super-editor-core, `createHttpHandler` and `createHttpClient` from super-editor-api, `createMcpDispatcher` from super-editor-mcp, and `runCli` from super-editor-cli. The `super-editor` (super-editor-cli) and `super-editor-mcp` (super-editor-mcp, from 0.3.0-next.0) binaries run through `npx -p <package>@next <binary>`; `release:check` installs the packed tarballs and starts both. UI CSS is `@supersolutions/super-editor-ui/styles.css`. Report schema v1 and guarded operations remain unchanged. SuperChat/SuperChart official contracts, complete MCP server initialization, Word compatibility and real-time collaboration remain outside this release.
## Tag maintenance

For the fixed `0.1.0-next.0` latest-tag repair and its guarded manual workflow, see [npm-tag-repair.md](npm-tag-repair.md). Publication checks now also verify the candidate channel and preserve the latest baseline without automatically changing tags. While that repair is deferred, a `next` publication over a prerelease `latest` (today `0.1.0-next.0`) is allowed with a warning: it records that `latest` as the baseline and fails if the publication moves it, so `latest` stays exactly where it was. npm answers a publish before its metadata shows the new tag, so the post-publish check retries a channel that has not caught up yet (up to 20 reads, 30 s apart); a moved `latest` fails at once.
