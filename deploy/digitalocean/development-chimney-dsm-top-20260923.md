# Development: chimney tops from DSM maxima

Runtime: `5fc5918fc042ebabd1ea67defab50a2861025de7`.
Previous runtime: `4588f07769e7a995b1042c93bbafd19e66e65538`.

This is a one-file browser delta to `wall_chimneys.js`, preserving the
publication architecture, manual DSM grade sampling and other editor work.
Production is unchanged. No schema or data migration is needed.

## Behavior

From Roof scans every DSM pixel center inside the finalized chimney footprint
and saves its highest valid elevation. The generated cap is horizontal at that
elevation, and all upper sides meet it. Polygon containment excludes pixels
outside nonrectangular footprints, even when inside their bounding boxes.
The scan respects the saved coordinate origin and image bounds. It ignores
missing and invalid values and preserves valid zero and negative elevations.

When no sampled height exceeds the highest roof contact, generation retains
the existing one-foot extension. It also falls back when a footprint is too
small to contain any valid raster pixel center. A measured extension smaller
than one foot is used exactly. There is deliberately no averaging or tree
filter: the requested maximum inside the footprint drives the cap.

Sampling happens only when generating chimney definitions with loaded DSM
data. Saved heights and subsequent manual cap edits are not resampled on
selection, stage changes or reload. From Roof generates new definitions.

## Validation

All 1,058 relevant geometry/editor tests passed. An additional assertion in
the existing captured-house From Roof test verifies the actual generated cap
matches the saved DSM maximum; all 59 wall-mode tests passed after adding it.
Regressions cover isolated peaks, outside-footprint peaks, nonrectangular
footprints, missing/coarse data, sub-foot extensions, negative elevations,
origin changes, matching side heights and persistence of manual edits.

Evidence and guarded deployment helpers are under
`output/chimney-dsm-top-20260923/`. Test logs are
`output/chimney-dsm-top-tests.log` and `output/chimney-dsm-top-ui-tests.log`.

## Deployment

Staging verified 24,498 unchanged public files on web and compatibility and
24,512 on worker. All three roles activated successfully and report the exact
release with development data and enforced outbound isolation. Worker
activation required no running jobs; PHP-FPM was refreshed on web and
compatibility.

Public readiness confirms the new release and outbound isolation, and the
served chimney script matches the committed SHA-256. A transient public 503
during load-balancer health convergence cleared without configuration changes.

## Recovery

Retain the previous complete runtime for rollback. Use the existing
development-role readiness and outbound-isolation guards, wait for an idle
worker and refresh PHP-FPM on web and compatibility after switching releases.
No saved customer geometry is modified by the deployment.
