# Advanced app selector dismissal — development

Source commit `7ed4057` closes the advanced app selector when a valid app is
activated, including selecting the current app again. Initial tab rendering keeps
the selector open so background refreshes and pinning do not dismiss it.

The one-file artifact is taken from canonical commit
`a3d9ae9e67b2a58cc7476fca0140fbc8b2f09ddb`, which includes `7ed4057` and a
concurrent documentation commit. Each development web node inherits its exact
live predecessor `d3701c17d8c19a06e3a90e89e2df1122f9ec376d`; only
`public/portal/scripts/core.js` is overlaid. Live source matched the canonical
pre-change file on both nodes. Runtime assets and service configuration are
preserved. Production, worker and compatibility roles are outside this release.

JavaScript syntax and targeted activation checks pass for sidebar selection,
selector reselection, initial rendering and invalid targets. Broader navigation
and placement source-contract suites reported failures; this is not a full-suite
pass. Deployment evidence, hashes, inventory and guarded activation scripts are
under ignored `output/selector-close/`.

Rollback, after accounting for any later release, restores each web node's
`/opt/firstmeasure/current` link to its predecessor above and restarts
`firstmeasure-development-web.service` and `php8.3-fpm.service`. Verify readiness,
development data environment and enforced outbound isolation. No data rollback
is required.
