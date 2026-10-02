# Metric reports — October 1, 2026

## Local change

Metric roof and full-house PDF generation excludes steep/flat Roof Materials,
Roof Ventilation and exterior Material Allowances. The exclusion applies after
organization settings, saved PDF settings and per-export overrides, in both
full and summary exports. Measurement pages and their metric conversion remain:
roof summary, pitch/area diagrams, enabled elevations/layers/gutters, wall
measurements, opening schedules and measured exterior quantities. Measured net
wall areas grouped by material remain measurements, not product estimates.
Imperial output retains its existing sections.

Metric editor configuration skips the ventilation page and its background
automation; the legacy finalization checklist no longer requires ventilation.
Saved ventilation preferences and underlying geometry/takeoffs are preserved.
No database, permission, provider or infrastructure configuration change.
Existing generated report files are not rewritten by this source change.

## Validation

- 22 report/localization/exterior tests pass (including the added configuration
  regression); TypeScript `npm run check` passes.
- Browser generation of 14 PDFs covers roof/full-house, steep/flat, metric/US,
  and full/summary output, with both unsupported sections explicitly enabled in
  export overrides. Assertions confirm exclusion and retained measurements.
- Default and explicit imperial full PDF output are byte-identical.
- Extracted PDF text confirms excluded sections are absent. Metric roof summary
  and exterior quantity pages were rendered with Poppler and visually checked.
- JavaScript syntax and scoped whitespace checks pass.
- Test artifacts: ignored `output/report-localization/` and
  `output/metric-reports-20261001/`.

## Development deployment: activated and verified

Source release: `19f22a0983b91a53fd043a0373b27b0a89fead71`, pushed on the
canonical branch and activated on all four development roles. Production was
not changed. The initial attempt was blocked by SSH timeouts. On retry,
per-command `IPQoS=none` restored access; the user's SSH configuration was not
modified. The ignored deployment SSH config includes the existing SSH config
and adds only that transport option. Private keys stayed local.

The three live report scripts on every role matched the pre-change source
commit. Immutable role-specific releases preserve each role's unrelated live
baseline and runtime assets; only `pdf.js`, `exterior_pdf.js` and `report.js`
were overlaid. Worker PDF assets are included. Hardlinked files and release
metadata were detached before writing. Source syntax, readiness, runtime
release identity, development data and outbound isolation passed on all roles.
PHP-FPM was reloaded on the compatibility and web roles.

| Role | Previous release | New release |
| --- | --- | --- |
| Web | `9775015b23df8db33b479508c8057f185d7a70de` | `19f22a0983b91a53fd043a0373b27b0a89fead71` |
| Worker | `1e0858b281c905950e7d6476d67357d77f37e123` | `19f22a0983b91a53fd043a0373b27b0a89fead71` |
| Compatibility | `9775015b23df8db33b479508c8057f185d7a70de` | `19f22a0983b91a53fd043a0373b27b0a89fead71` |
| Web pool | `9775015b23df8db33b479508c8057f185d7a70de` | `19f22a0983b91a53fd043a0373b27b0a89fead71` |

Public readiness confirms the new development release and enforced isolation.
All three public editor scripts and the server PDF runtime endpoint match the
tested source hashes. The 14 fixture PDFs were regenerated using the downloaded
development report scripts: all metric exclusions and retained-measurement
assertions passed, and default/explicit imperial output remains byte-identical.
This verifies deployed rendering code with synthetic fixtures; it does not
rewrite existing customer reports or submit a customer project.

Deployment manifest, per-role payloads, SSH config, public verification and
rendered fixture output are in ignored `output/metric-reports-20261001/`.
Each installed release has `channels-release.json` recording the actual prior
path and hashes. Compatibility is staged under
`/opt/firstmeasure/releases-root-archive/`; the other roles use
`/opt/firstmeasure/releases/`.

## Rollback

Check that the role still runs this release before rolling it back. Restore
`/opt/firstmeasure/current` to that role's receipt `previous_path`, restart its
`firstmeasure-development-{web,worker,legacy}.service`, and reload PHP-FPM for
web/compatibility. Verify readiness, previous runtime release, development data
and outbound isolation. Do not modify shared hardlinked release files in place.
