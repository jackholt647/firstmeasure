# Development rollout: FirstMeasure storage and refresh changes — October 19, 2026

Dev is the system being tested, so this rollout adds one change to what dev
already runs instead of redeploying dev from Git. Only commit `3a85b3fe`
([the October 12 storage scaling change](development-firstmeasure-storage-scaling-20261012.md))
was merged onto each role's live files, with `3a85b3fe^` as the merge base.
Every other file on dev was left as it was.

Release `70770aae` is the canonical commit that also bumps the project viewer's
cache key (`20261019-storage-refresh-v1`), so browsers refetch `projects/viewer.js`.
The portal's `core.js` is versioned by content hash and needs no bump.

## Why

Production's storage hotfixes (`codex/production-portal-storage-hotfix-20261012`)
were re-implemented in canonical by `3a85b3fe`, but that commit never reached dev.
Canonical would otherwise have shipped to production with storage code that dev never ran.

## What shipped

- 25 code and test files from `3a85b3fe` plus the apps manifest. On every role,
  23 files were exactly the pre-change version and took the change whole.
  `firstmeasure/api.ts`, `projects/viewer.js` and `portal/scripts/core.js` had
  newer dev edits and were 3-way merged without conflict. The manifest had only
  the viewer key replaced.
- The worker received only `public/v1/**`.
- Roles were activated in the order worker, compatibility, web, pool. The worker
  activated first because it must accept `imagery.process` before web enqueues it.
  `FIRSTMEASURE_JOB_TYPES` is empty on the dev worker, so the worker takes every job type.
- `FIRSTMEASURE_ARTIFACT_CATALOG_READS` stays unset. The dev workers read from a
  `SPACES_READ_FALLBACK_PREFIX` overlay, so authoritative catalog reads are not
  available on dev in any case. The `firstmeasure_artifact_catalog` table is
  created on first use.

## Verification

- Each staged clone passed the Linux TypeScript check, the compiled-output
  comparison and the syntax checks. All four roles passed readiness and file-hash
  verification on `70770aae`.
- Service logs showed no errors after activation. The new
  `firstmeasure_database_pool` and `firstmeasure_storage_operations` metrics are
  being emitted.
- A read-only check on dev web ran `getProjectDetail` on six recent full-house
  projects (26–269 files each). Each returned the full response shape, with
  optional JSON present only where the file exists.
- The new code has not been tested in a browser (cards, refresh, thumbnails) or
  with a live imagery order. Test those on dev before a production release.

## Rollback

Each role's previous release directory is retained:

- worker: `d63d657f`
- compatibility, web and pool: `3e6e03c0`

Point `/opt/firstmeasure/current` back at the previous release and restart the
role's service. The catalog table and any queued `imagery.process` jobs are
additive. Check pending imagery jobs before rolling the worker back.

Tooling is in the ignored `output/storage-scaling-20261019/` directory.
