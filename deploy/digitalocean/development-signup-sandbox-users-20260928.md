# Signup sandbox users and full org defaults — development, September 28, 2026

Source commit `da57ae845c6ee1eb70662332c7e39e0ae8f5b1dd` adds a roster to
each signup sandbox test organization. A sandbox administrator can add an active
user with a role and explicit permission overrides, then open a portal session
as any listed user. It also grants sandbox-launched owner/admin sessions access
to their own organization's Features & Apps settings in development. Global
rollout controls retain their operator gate. Fresh instant full organizations
use the selector mode for the portal New menu.

## Development rollout

Both development web nodes had the exact source parent of the sandbox commit
for every affected file, after line ending normalization. The patch archive was
built from an isolated checkout at the source commit, following `npm ci`,
`npm run check`, `npm run build`, and the sandbox behavior test. It contained
only the affected source, portal, documentation and compiled API files. The
archive SHA-256 was
`93d4ce9604926aa1f865d2eb617ed7c31602f9efa278437a248bddaacade97f3`.

The patch was overlaid on each node's then-current release
`330470f3712f69c53c3bb14f36c112232df14d48`, preserving unrelated files.
Both nodes now serve immutable release
`cf0ae5624a3b91bcebe2527be86a79c0ff016ae2`. Each node passed its local
readiness check with development data and outbound safety enforced. The public
readiness endpoint reported the same release; the sandbox page served the v3
script with the user roster actions. Production was not changed.

Rollback: restore each node's own `current` symlink to its predecessor release
`330470f3712f69c53c3bb14f36c112232df14d48`, restart
`firstmeasure-development-web.service` and `php8.3-fpm.service`, and verify
local readiness. The development autoscale image remains historical; future
replacement nodes need this source change.
