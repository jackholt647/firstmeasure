# September 10 production follow-ups — development candidate

Branch: `codex/september-10-production-followups`, based on `15e643a` from
`codex/september-8-bugfixes`. Production is held. Remote development deployment
and verification have not been performed: this workstation has no configured
`dev-sync-droplet` SSH alias/key. Do not treat local fixture tests as a remote
development acceptance or a recovery of live trainee data.

| Issue | Change | Local evidence |
| --- | --- | --- |
| 1M8-152 | Keep manager-review reasons and trainee flags in compact queue rows; combine partial legacy reasons with flags in the UI. | Approval/bootstrap regression failed before the fix; trainee, VIP and combined UI reason tests pass. |
| 1M8-178 | Initialize editor projection from saved dimensions and preserve it while provider previews load. | DSM-only projection test and three successive reopen cycles preserve points, vents and heights. |
| 1M8-179 | Add QA Quality CSV export for all rows matching applied filters, with existing viewer authorization. | API test exports 125 rows despite pagination, enforces QA self-view and filters, preserves multiline text and quotes. Actual Chrome UI downloaded 27 fixture rows across two pages, with note/severity intact. |
| 1M8-180 | Prefer latest rejection history over stale reviewer hints; reserve generic queued/PDF correction submissions too. | Repeated rejection, takeover, generic submission, unresolved-feedback rejection and idempotent hold tests pass. |
| 1M8-181 | Recover missing student progress, exam attempts and complete project folders into the configured writable root. PHP honors the same tutorial root environment variables as Node. | Legacy retained-tree recovery, preservation of primary progress/reset/project edits, artifact recovery, PHP read/write followed by Node read, and no resurrection after subsequent deletion all pass. |

Validation: TypeScript check/build and edited JavaScript/PHP syntax checks pass.
The full TypeScript run had 162 passes, 10 skipped integration tests and one
failure due to the missing CI test-only internal service secret. Both tests in
that authentication file pass when run with the configured test secret.
Changed routing/export/tutorial tests pass after final edits. The embedded
PostgreSQL cross-process QA/manager decision test passes with
`NODE_OPTIONS=--experimental-sqlite` on local Node 22.12.

## Development acceptance still required

Deploy the exact candidate to isolated development, including Node and the PHP,
editor and portal assets. Verify isolation/outbound restrictions as described
in `DEPLOYMENT.md` before using any fixtures there.

- Verify trainee-only, VIP-only and combined manager queue labels.
- Reopen and resubmit an affected geometry fixture several times, including a
  Google preview with a differently sized DSM. Confirm lengths and alignment.
  Existing incorrectly saved geometry is not automatically repaired by this fix.
- Download a filtered QA Quality CSV as manager and as QA; check all pages and
  QA self-view restrictions.
- Have QA A reject, allow QA B to take over and reject again, then submit the
  technician correction. Confirm B owns the return even with A offline.
- For tutorials, set the **same absolute** `MEASURE_INTERNAL_TUTORIALS_ROOT`
  (or `TUTORIALS_STORAGE_ROOT`) for Node and PHP-FPM and verify effective PHP
  environment visibility. The retained source is the existing sibling
  `public-storage/measure/internal/tutorials` tree. Verify recovered attempts,
  project opening, grading and subsequent saves on isolated copies of affected
  records. Existing primary progress is authoritative; conflicting old/new
  progress requires inspection rather than an automatic merge. Recovery writes
  a per-course marker to avoid resurrecting later intentional deletions.

No database schema migration is added. Tutorial recovery copies missing data
on access and leaves retained sources unchanged. Rolling back code does not
undo those copies; preserve the writable root and do not repeat the production
cutover import. Production release preparation must retain the existing
replacement-node release-channel guard and coordinated Node/PHP deployment.
