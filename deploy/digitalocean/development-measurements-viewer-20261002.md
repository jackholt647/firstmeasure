# Measurements viewer and development ordering — October 2, 2026

Deployed source release `667433e375ed90daf07d7f74b206018bac12ae5a` to
`https://dev.1m8.ai` on both web nodes, the worker and compatibility host.
Previous release on all four: `19f22a0983b91a53fd043a0373b27b0a89fead71`.
Production was not changed.

The portal includes the read-only roof model/media viewer, ordinary-project
Order Measurements entry, criteria-aware developer sample address button, and
explicit opt-in instant development report. See
[feature and sample inventory](../../docs/measurements-viewer-development.md).
No database migration or environment configuration change was required.

## Deployment and validation

Role-specific immutable releases preserve live changes through three-way merges.
Only seven runtime source files and two compiled backend files changed on serving
roles; the worker received the two backend source/compiled pairs. A compatibility
manifest conflict was limited to the order bundle cache version and resolved to
the new version. Shared hardlinks were detached before every write. The source
commit excludes unrelated staged and unstaged workspace work.

All four staged releases passed Linux TypeScript, JavaScript syntax and compiled
source parity checks. After activation, each role passed source hashes, process
release identity, readiness and enforced development data/outbound isolation.
Public readiness and all five frontend asset hashes passed. Browser fixture tests
loaded JavaScript from dev.1m8.ai and passed ordering controls, current criteria,
instant-off defaults, 3D geometry, modes, solar imagery and responsive media.

A read-only deployed-service check using the existing test-operator configuration
found reusable residential, commercial and multifamily roof samples and rejected
a non-developer identity. No completed residential full-house sample exists.
No customer order was submitted during deployment verification; actual signed-in
end-to-end copying remains a manual development check. Local service tests cover
copy authorization, signed selection, artifact copying and isolation.

The existing development autoscale image/template limitation remains: this rollout
updates current hosts, not the historical replacement image. No topology or
provider configuration changed.

## Rollback and evidence

Ignored `output/measurements-deploy-20261002/` contains per-role inventories,
payloads, hashes, deployment scripts and public/backend verification output.
Each installed release has `channels-release.json` with its actual previous path.
Compatibility uses `/opt/firstmeasure/releases-root-archive/`; other roles use
`/opt/firstmeasure/releases/`.

Confirm the role still runs this release, atomically restore its `current` link
to the receipt's `previous_path`, restart its development service, reload PHP-FPM
on web/compatibility, then verify prior release identity, readiness and isolation.
Never modify hardlinked release files in place.
