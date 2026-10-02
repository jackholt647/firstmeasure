# Residential scope choice and map help — October 2, 2026

Development release `0f0774d4241a51dd22b2b7ff36cfa69ce5cf09b3` is active on
both web nodes, compatibility and worker at dev.1m8.ai. Production is unchanged.

Commercial and multifamily now use roof-only ordering without a scope choice,
even if legacy exterior capability flags are enabled. Residential keeps Roof Only
and Full Structure. Switching type clears exterior state. Both ordinary exterior
ordering and instant development sample/copy validation reject non-residential
full-house requests on the server.

Scope buttons no longer open hover help. Their info icons retain hover/focus help
and click details. The popout is bounded by the actual map rectangle, instead of
the whole project panel, so it cannot obscure the ordering column. Narrow layouts
retain click details when there is no separate map area for hover help.

## Verification

- Three targeted browser/state tests and the development copy service test pass.
- All 28 existing photo, guided camera and orbital video tests pass.
- Local TypeScript, JavaScript syntax and scoped whitespace checks pass.
- Linux TypeScript, compiled parity and syntax checks passed on staged roles.
- All roles passed runtime release, hashes, readiness and development isolation.
- Public readiness and all three changed frontend asset hashes passed.
- Browser regression repeated with JavaScript fetched from dev.1m8.ai: both
  residential choices remain clickable, info stays inside the map, and switching
  to either non-residential type bypasses the scope choice, even with flags on.
- Read-only deployed service checks confirm ordinary and instant full-house
  requests are rejected for commercial/multifamily and roof criteria remain valid.

An initial staging attempt stopped on a concurrent release change before writing.
The inventory was refreshed and payloads rebuilt against the new live baseline.
The early public browser attempt during rolling activation hit old code and
reproduced the tooltip obstruction; after all nodes activated, it passed.
No customer report, charge or delivery was created for verification.

## Deployment and rollback

Only task-specific files were committed; other staged/unstaged workspace changes
were preserved. Each role's unrelated deployed files were retained. Current
serving baseline before this release was `d0d196f2da0b1092c693ae5910a48e438e2e67ac`;
the worker baseline was `667433e375ed90daf07d7f74b206018bac12ae5a`.
No database, provider or environment configuration changes were required.
The historical development autoscale replacement-image limitation remains.

Ignored `output/measurement-scope-help-20261002/` retains inventories, payloads,
hashes and verification scripts. Each installed `channels-release.json` records
its exact prior path. To roll back, first confirm this release is still active,
atomically restore that prior symlink, restart the role's development service,
and reload PHP-FPM on web/compatibility. Verify prior runtime identity, readiness
and isolation. Never edit hardlinked release files in place.
