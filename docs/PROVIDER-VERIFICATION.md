# Verified upstream and provider evidence

Initial read-only investigation on 2026-10-03 used the authorized GitHub connector and an independent git clone. These initial results preceded the owner's license commit.

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

Subsequent read-only `git fetch` and `git ls-remote --symref origin HEAD` verified that the owner initialized `main` with commit [`549d85b6b00682f34452d6e97fc1b3ca1c8a1698`](https://github.com/Super-Solution/super-editor/commit/549d85b6b00682f34452d6e97fc1b3ca1c8a1698), "Add Apache License 2.0 to the project", at 2026-10-03 09:57:35 UTC. Its only file is LICENSE. The implementation was rebased locally onto this existing commit; the owner's LICENSE, including its appendix template, is preserved byte-for-byte. Workspace metadata now declares Apache-2.0. No remote branch, pull request, publication, or permission change was made by this implementation task.
