# Compact development report control and portal viewer load — October 2, 2026

Development source release `7637a0020d22b8428e789c8c371af2f7cfb085e5` is active
and verified on both serving web nodes and compatibility. The worker was not
changed; this release contains only frontend/PHP changes. Production is unchanged.

The developer option is a single 32px row: a small switch labeled Instant dev
report and a compact Use report action. The explanation and large addon-card
styles are removed. Hidden/disabled states and explicit opt-in behavior remain.
The action is outside the switch label, avoiding accidental label activation.

The blank Model & photos view was traced to the portal's direct script list:
it registered Measurements without loading roof-viewer.js. The manifest bundle
alone did not cover this already-registered static path. The portal now loads
the renderer before Measurements. A missing renderer displays a visible refresh
message instead of an empty pane. Existing reports need no regeneration.

## Checks

The existing development ordering browser test passes. The roof viewer browser
test passes, including a regression check that the portal preloads the renderer
before Measurements. Synthetic saved XML/solar data validates modes and media.
A screenshot render of the actual new control confirms a 32px row at 320px width
without horizontal overflow. That check was repeated using the JavaScript served
from dev.1m8.ai. This does not claim a signed-in end-to-end test of the user's
specific report. Server syntax checks, deployed hashes, runtime identity,
readiness and enforced development isolation passed on all three serving roles.

## Rollout and rollback

Only task-owned hunks were committed. Concurrent releases changed compatibility
and pool baselines during staging; baseline checks stopped the affected steps,
and refreshed role-specific packages preserved those changes. Final prior
releases were `e662cfd26ac154ed2a7ef5fd7d7086f25531486b` on web,
`02cbae1bf38f0b3534d36c5087edfeeec828f61a` on compatibility, and
`1816ea57f501e65a19659b5ad7517a1171981506` on pool.
No data, permissions or provider configuration changed. The historical development
autoscale replacement-image limitation remains.

Ignored `output/compact-dev-report-20261002/` contains inventories, payloads,
source selection, screenshots and verification scripts. To roll back, confirm the
role still runs this release and restore the `previous_path` in its installed
`channels-release.json`, restart the development service, reload PHP-FPM and
verify the previous release, readiness and isolation. Never modify shared
hardlinked release files in place.
