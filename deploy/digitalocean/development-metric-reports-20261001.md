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

## Development deployment: blocked, not activated

The user authorized development deployment to `dev.1m8.ai`. No production
deployment is authorized.

Repeated SSH attempts to the configured `dev-sync-droplet` jump host time out;
the development inventory through that host and a direct connection to the
known development web host also time out. No remote files or services were
modified. The public development readiness endpoint remains healthy with
development data and outbound isolation enforced; it reported release
`9775015b23df8db33b479508c8057f185d7a70de` during this attempt.

Resume by restoring SSH connectivity, inventorying all development roles again,
and comparing the three changed editor/runtime scripts against their live
versions. Preserve role-specific baseline differences. Stage the exact scoped
commit using the existing immutable overlay workflow, including the worker's
PDF runtime assets. Activate roles sequentially, verify hashes/readiness and
generated metric output, and record each previous release for rollback.
No live-baseline assumptions or deployment payloads have been finalized while
SSH is unavailable.
