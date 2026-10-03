# Verified upstream and provider evidence

Read-only investigation on 2026-10-03 used the authorized GitHub connector and an independent git clone.

| Check | Observed result |
| --- | --- |
| [super-editor metadata](https://api.github.com/repos/Super-Solution/super-editor) | Public, size 0, default branch main, license null |
| [super-editor contents](https://api.github.com/repos/Super-Solution/super-editor/contents) | 404, `This repository is empty.` |
| [super-editor branches](https://api.github.com/repos/Super-Solution/super-editor/branches) | Empty array |
| Independent `git clone` | Succeeded with empty-repository warning |
| Repository rules | No files, LICENSE, AGENTS.md, or .agents in empty checkout; no applicable ancestor AGENTS.md found |
| Super-Solution/superchat, superchart, super-chat, super-chart | Authorized read calls returned 404 NOT_FOUND |

A 404 means the API could not be accessed or verified, not proof that a private product does not exist. Unrelated globally searched products with the same names were not used. No private source, product secrets, or copied business logic is included.

The `provider: 'superchart'` descriptor and renderer registry are **custom integration seams**, awaiting a verified SDK/embed contract and host-approved HTTPS origins. The example URL is a placeholder and defaults to a plain link. SuperChat can submit typed transactions through the shared service once its actual host API is supplied; no official SuperChat import is claimed.

The owner must supply the licensing decision and copyright attribution before an open-source release. Because the repository has no base commit or main branch, a development branch can be pushed under the current authorization, but a pull request against main requires owner-authorized initialization of main first. This implementation does not silently initialize or write main.
