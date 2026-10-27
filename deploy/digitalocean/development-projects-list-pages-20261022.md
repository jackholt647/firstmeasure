# Project list pages read only their own manifests (1M8-225), development rollout 2026-10-23

Branch `claude/portal-projects-list-20261022`, cut from `codex/release-20261022b` (`6bf1ec24`, production `f7fd3fc8`
plus its release record) so it can follow as a hotfix. Not on production.

| Commit | Change |
| --- | --- |
| `b5da9acd` | `searchPostgresProjectsForLegacyList` picks the page's ids in a sorted subquery, then joins only those rows for their manifests, in the same order. The filters, count, order and tie-breaks are unchanged. |

Files: `public/v1/firstmeasure/project_index_postgres.ts`, `public/v1/tests/legacy-list-page-postgres.test.ts` (new).

## Production evidence (read-only, release `f7fd3fc8`)

The slow `POST /v1/firstmeasure/projects/list` requests came from the internal staff app, not the customer portal.
Web node `64.23.240.81`: the journal's per-request times were matched to nginx (referrer, size) by completion second,
keeping only seconds where every request came from the same app.

| Caller | Before 22:58 UTC | 22:58-23:22 UTC | After 23:22 UTC |
| --- | --- | --- | --- |
| Internal (`/measure/internal/`) | p50 205 ms, p95 836 ms (59) | p50 10.2 s, p95 22.1 s, max 29.6 s (63) | p50 144 ms, p95 4.4 s (32) |
| Customer portal (`/portal/`) | p50 40 ms, p95 150 ms (2,412) | p50 65 ms, p95 216 ms (377) | p50 30 ms, p95 79 ms (530) |

- The internal callers page through every project: Stats (`fetchStatsProjectsFromFirstMeasure`: `filter: 'all'`,
  `include_all`, `include_instant_only`, 200 a page, about 526 pages, 10 at a time) and the Customers order-history
  fallback (`fetchOrgOrdersFromProjectsApi`, up to 250 pages in sequence). Their responses were about 100 KB
  compressed; portal responses about 5 KB.
- The release did not cause it. `f7fd3fc8` changed only the account-guard lines in `public/portal/scripts/core.js`
  and the refresh organization check; the `platformExpandedAccess` routing was already in `9398c0ad`.
- Web pool waits stayed small (per-minute maximum under 80 ms).
- `EXPLAIN (ANALYZE, BUFFERS)` in a read-only transaction: the list query selected
  `manifest_json - 'language_snapshot'` in the sorted query, so Postgres de-TOASTed every matching manifest
  (519k buffers) before sorting. Over all 105,168 projects, page 1 took 2,796 ms and offset 80,000 took 7,830 ms,
  with a 1.2 GB external merge sort. Reading the ids first took 69 ms and 222 ms. The md5 of the page's
  `id:revision` list was identical. The largest customer organization (835 rows in 90 days) took 65 ms for page 5
  either way.

## Development verification (web role, loopback, 51,216 projects)

The same requests three times each on `88476a5f` (before) and `b5da9acd` (after). The SHA-256 of each response's
`projects` array was identical before and after.

| Request | Before | After |
| --- | --- | --- |
| Stats (`view: 'stats'`, all, `include_instant_only`) page 1 | 1.8-2.7 s | 136-196 ms |
| Stats page 128 | 4.2-5.3 s | 189-230 ms |
| Stats page 257 | 3.8-4.2 s | 106-138 ms |
| Customers order history page 1 | 116-150 ms | 120-130 ms |
| Customers order history page 257 | 2.9-4.0 s | 170-174 ms |

- Tests: `node tests/run-embedded-postgres.mjs tests/legacy-list-page-postgres.test.ts` (every page of all, org,
  processing and search lists equals the previous single query), `project-historical-search`, `firstmeasure-postgres`
  pass; `tsc` clean.
- Rollout: `output/portal-projects-list-20261022/ship.sh` (copy of `customers-batch-20261022`, 3-way merge onto live
  files), all four roles, `verify_exit=0`, merged onto live `59106e51`. The merged file keeps the live
  `queryPostgresProjectManifestsByOrganization` from `e3db0de0`. Two attempts stopped before activating anything
  because other sessions' releases (`450c3003`, `59106e51`) activated during staging.

## Remaining cost

The Stats tab still downloads every project in about 526 requests. A server-side aggregate or a narrower stats row
would reduce that further.
