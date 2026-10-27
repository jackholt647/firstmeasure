# Development project reports and measurement ordering — October 26, 2026

## Follow-up: independent document sources

Release `17d6a18ed3146fe4277a7c355126d20c126f367d` corrects a missing-report
case found on `project_mvqa1qau_mw3x74u9`. Request logs confirmed that its
legacy `/v1/platform/.../documents` list returned 403 while the report PDF and
customer PDF were accessible (200). The shared Promise.all previously threw
away the report asset results when that independent list failed.

Documents now handles a legacy list failure within that source and waits for
the independent report, invoice and receipt results. No access gates changed.
The new browser regression reproduced the failure before the fix and passed
afterward, along with the delivered-report/deduplication/hold and desktop-header
checks (three tests). Only Docs JavaScript and its gzip companion changed on
web and legacy; their backend digests remained unchanged. The prior release
for this follow-up is `a730ce84c08cd841c944ee67de53295d62845efe`.

The browser session available to the agent belongs to a different sandbox
organization, so the exact project was diagnosed through read-only development
record/request-log inspection rather than a claimed live visual verification.

## Initial rollout

Activated release `a730ce84c08cd841c944ee67de53295d62845efe` on development web
and legacy, replacing `943d95420d8fb9fdd2e9982c7f85e33e9aeb1bd3` on both.
The worker and production were not changed.

## Behavior

- Documents lists available customer roof report PDF, roof measurements PDF and
  roof report XML through the existing Reports asset loader, including its hold
  rules. It does not create duplicate document instances.
- Documents defaults to large, loose gallery icons when there is no saved view
  preference. Existing saved preferences remain effective.
- An empty Operations Measurements panel offers Order measurement report and
  Add measurements manually. Ordering opens the existing configured FirstMeasure
  Overview/map workflow and focuses the address when missing. Overview keeps its
  ordering entry. Manual entry requires a scope with a measurement schema.

## Release construction

Only four browser scripts and their regenerated gzip companions changed:

- `public/libraries/apps/docs/project.js`
- `public/libraries/apps/materials/project.js`
- `public/libraries/apps/materials/scope-of-work.js`
- `public/libraries/apps/project-request/app.js`

Each host's active release was cloned into a new immutable release directory.
The task changes were merged onto its actual files, preserving existing
role-specific differences. The Documents live-layer mobile-search improvement
was included; its overlay retired after activation. Other live-layer files were
left in place. No backend files, data, migrations or infrastructure changed.
The former pool address is now the NAT gateway and was not a rollout target.

## Verification

- Original implementation: 21 document/manual-measurement/order browser tests
  passed. Following reconciliation, focused Documents/report and desktop-header
  checks passed, and the shared ordering host tests passed again.
- All updated scripts passed syntax checks locally and on staged hosts.
- Both hosts passed staging baseline/hash checks and activation readiness.
- Public `https://dev.1m8.ai/v1/health/ready` reported the new release, development
  data environment, enforced outbound safety and `ok: true`.
- All four public scripts, requested with gzip, matched the manifest's decoded
  hashes and had no live-layer response header.
- The authenticated project portal loaded successfully. The selected Gutters
  board had no projects, so no live report/order transaction was exercised.

Local rollout manifests, per-role payloads and public verification receipt are
under the task checkout's ignored `output/project-reports-dev/` directory.

## Rollback

The previous immutable release remains on each host. Follow the standard
development rollback procedure to restore its current symlink, restart the
role service and reload PHP, then verify readiness and served asset hashes.
Web releases live under `/opt/firstmeasure/releases`; legacy releases live under
`/mnt/firstmeasure_dev_releases/releases`. Both use `/opt/firstmeasure/current`.
