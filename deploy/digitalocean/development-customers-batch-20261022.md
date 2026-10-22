# Customers tab: batched summary reads and per-batch compaction (1M8-225), development rollout 2026-10-22

Branch `claude/customers-batch-reads-20261022`, cut from `codex/release-20261022b` (`6bf1ec24`, production `f7fd3fc8`
plus its release record) so it can follow as a hotfix. Not on production.

| Commit | Change |
| --- | --- |
| `318f799d` | A customer page reads each batch of up to 250 organizations with two queries (global, user and project documents; indexed projects with the same filter, order and per-organization limit) instead of about eight per organization. A failed batch falls back to the per-organization reads. |
| `1e995038` | Full summaries (column sorts other than name/created, most filters, stats) are compacted per batch instead of after every organization's full row is built; concurrent requests for the same summary share one build. |
| `e3db0de0` | The batched document query breaks equal `updated_at` by `ctid`, the order `platform_documents_list_idx` returns, so users and projects keep `listDocuments`' order. |

Files: `public/v1/internal/api.ts`, `public/v1/firstmeasure/project_index.ts`, `public/v1/firstmeasure/project_index_postgres.ts`,
`public/v1/tests/customer-summary-batch-postgres.test.ts` (new), `docs/optimization-backlog.md` (remaining cost).

## Production evidence (read-only, 2026-10-22 22:58-23:22 UTC, release `f7fd3fc8`)

- Customers request (`customer_org_dashboard_data`, page 1, 200 rows, name sort) replayed on the compatibility host:
  12.7 s, 10.2 s, 24.5 s and 10.8 s; 6.2 s on `8c908166` at 04:50 UTC.
- Compatibility workers have a 4-connection PostgreSQL pool; per-minute pool maximum waits of 2-10 s throughout
  18:00-23:06 while the database itself was idle (2 active of 148 connections). Two replayed requests took about
  11,800 pool acquisitions.
- The host (2 vCPU, 3.9 GB, no swap) ran two workers near their 2 GB heap: kernel OOM kill at 20:30:46, another
  worker killed at 23:00:22, and at 23:00:51 the worker this session had attached a CPU profiler to aborted with
  "JavaScript heap out of memory" (heap already 1.95 GB; the profile capture tipped it). Each restarted within a second.

## Development verification (legacy role)

| Request | Before (`ca31b276`) | After (`e3db0de0`) |
| --- | --- | --- |
| Page 1, name sort | 3.7 s | 2.8-3.3 s |
| Country sort (full summary, 5,666 orgs) | worker aborted, heap out of memory, after 61 s | 200 in 50-55 s, peak worker RSS 1.3 GB; 0.25 s from cache |

- Rows: on dev, `buildOrganizationSummaryRows` equals per-organization `buildOrganizationSummaryRow` for the first 200
  organizations (0 differing; 136 of 1,200 user/project lists differed in tie order before `e3db0de0`).
- Tests: `node tests/run-embedded-postgres.mjs tests/customer-summary-batch-postgres.test.ts`, `customer-country`,
  `organization-country`, `customer-email-search`, `legacy-dispatch`, `portal-regressions-20261021` pass; `tsc` clean.
  `internal-permissions` and `internal-teams` fail only on Windows EBUSY while deleting their temp SQLite files.
- Rollout: `output/customers-batch-20261022/ship.sh` (3-way merge onto live files), all four roles, `verify_exit=0`
  twice (`1e995038`, then `e3db0de0` with commit-base `1e995038`). Another session's release `772f66fb` activated at
  23:42 UTC and kept these files identical to `e3db0de0` on all roles.

## Not addressed here

- Each full row still carries every order's manifest (about 260 MB for 200 rows on dev); see the backlog entry.
- The customer-portal project list (`POST /v1/firstmeasure/projects/list`) on web node 64.23.240.81: p95 181 ms
  before 22:38 UTC, 12 s after (max 30 s, 22:58-23:22), with the web node mostly idle and the database idle.
  `f7fd3fc8`'s `core.js` sends organizations without expanded access straight to paged `projects/list`
  (up to 5 pages of 200, `refresh: true`) instead of the platform list. Not diagnosed further.
