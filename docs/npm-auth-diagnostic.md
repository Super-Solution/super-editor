# Read-only npm authentication diagnostic

The existing successful publication and failed repair logs contain no `npm whoami` result. The displayed npm token is not expired (expires January 1, 2027), has `@super-solution` read/write access and Bypass 2FA enabled. This does not prove it is the credential stored in GitHub's organization `NPM_TOKEN` secret.

The proposed **Check npm authentication** manual workflow uses the same existing `secrets.NPM_TOKEN` reference, registry, scope, pinned setup-node action, and `NODE_AUTH_TOKEN` mapping as both release workflows. It declares no job environment. Repository secret metadata currently contains no repository-level secrets; the organization `NPM_TOKEN` is available to this repository.

The only authenticated command is `npm whoami` against the fixed public registry. It has a 20-second timeout, uses no shell, and captures rather than forwards npm output. Application output is only a validated account name plus success, or a generic failure. It does not print credentials, environment/configuration dumps, token fingerprints, or raw npm error output. GitHub may still automatically show variable names with masked secret placeholders in its standard runner log; this script does not control the runner's log format.

This diagnostic does not publish, delete/move tags, create credentials, change permissions, or automatically run the repair. No dependency installation is needed.

After separately authorized review/push/merge, the owner can open **Actions → Check npm authentication → Run workflow → main** and report the one-line result. Success confirms the stored credential authenticates as the displayed account; it does not prove DELETE permission or compliance with package policy. Failure remains deliberately generic and could include invalid/revoked credentials, network failure or policy restrictions. Continue diagnosis from that result rather than automatically retrying tag deletion.

This change is prepared locally only. No workflow dispatch or credential-bearing probe has been executed by the agent.
