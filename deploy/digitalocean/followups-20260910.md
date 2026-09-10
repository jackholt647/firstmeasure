# September 10 production follow-ups — deployed to development

Branch: `codex/september-10-production-followups`, based on `15e643a` from
`codex/september-8-bugfixes`. Release
`e35b8847eb42d390ba01d734f4b32bb5abe5611c` was activated on all three development
roles on September 10, 2026. Production activation is pending. Linear 1M8-152, 178, 179, 180
and 181 are Done in Dev. Production promotion was subsequently authorized;
see [promotion preparation](production-promotion-20260910.md) for current status.
Synthetic recovery checks do not establish recovery of
the affected production trainees' records.

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

## Development deployment verified

| Role | Host | Service | Previous release retained |
| --- | --- | --- | --- |
| Web | 143.198.68.11 | firstmeasure-development-web | capacity-r1-20260907-web |
| Compatibility | 137.184.229.145 | firstmeasure-development-legacy | capacity-r1-20260907-legacy |
| Worker | 137.184.44.82 | firstmeasure-development-worker | capacity-r1-20260907-worker |

All three use `/opt/firstmeasure/releases/e35b8847eb42d390ba01d734f4b32bb5abe5611c`.
The running environments were checked before activation. Host-only source
differences were compared with both c97f876 and the candidate: the candidate
preserves their implemented claim-lock, email-safety, worker-drain, heartbeat,
artifact-listing and compatibility-dispatch fixes. Import placement, formatting,
and superseded earlier implementations explain the remaining differences.

New directories were staged from each host's prior runtime, overlaid with Git
source, and verified against the candidate's source hashes. Local configuration
stayed on its own host. Compatibility and worker passed dependency installation,
type checking and compilation. Web has no npm, so it received compatibility's
compiled JavaScript; package.json has no dependency changes from the baseline.
The initial web build attempt failed due to missing npm before activation.
No production activator or release-channel guard was bypassed.

Compatibility, web and worker activated in that order with rollback checks.
Public `https://dev.1m8.ai/v1/health/ready` confirms the exact release, development
data environment, all dependency checks, and enforced outbound safety. Worker
readiness and release identity were verified separately. Public `manager_review.js`,
`qa.js` and editor `main.js` match the candidate bytes.

All eight focused tests passed again against the deployed source with isolated
test storage. Live authenticated service requests additionally verified CSV
pagination, severity filtering and QA self-view. Retained tutorial progress,
an exam attempt and a project were recovered for a synthetic user through the
running API. Actual PHP-FPM found the recovered project and saved progress that
the Node API subsequently read. These synthetic records were removed afterward;
no customer message, charge or production write was made.

PHP-FPM's www pool now receives `MEASURE_INTERNAL_TUTORIALS_ROOT` matching Node.
Scoped ACLs permit www-data to traverse the development data ancestors and
read/write the tutorial root, with inherited access for new children. Existing
pool configuration was backed up as `/root/php-www-before-e35b884.conf`.
Activation evidence and test logs remain under `/root/followups-*` on each host.
No data import, DNS change, autoscale image or template update was performed.

## Production promotion checks

Promote the tested application source with the required PHP configuration and
storage permissions. Verify existing tutorial files as the PHP worker user;
inherited ACLs alone do not repair permissions on pre-existing children.
The release-channel/bootstrap prerequisite in REPLACEMENT_RELEASES.md remains
separate and unresolved by these bug fixes. A development replacement node
must also be checked for release identity; its old image was not rebuilt here.

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
