# 1M8-188 customer TSV export — development only

Final runtime: `4e7390e1daabdaca361294ce35809fac91590a3b`, branch
`codex/customer-export-188`. Built on the exteriors integration's `ce18864`
documentation / `c5834ea` runtime, not a replacement with the older main checkout.
All three development roles activated and verified. Production was not changed.

## Fix

The old export requested 1,000 enriched dashboard organizations at once, using
global reads that acquire PostgreSQL row locks. The new dedicated action uses
25-organization immutable-ID pages, direct SQL directory pagination and read-only
document reads. Progress is displayed; failed/malformed/nonadvancing responses
abort instead of downloading partial data. Existing TSV columns and scope remain
unchanged (all customer organizations, including test organizations; not internal).
No schema, dependency, configuration, image or capacity changes.

Source-only equivalents on `codex/september-14-bugfixes`: `b01d841`, `1155307`.
Do not deploy that branch over development: it lacks the exteriors privacy guards.

## Verification

- TypeScript check/build passed on Linux; 9 focused tests and 5 embedded-PostgreSQL
  tests passed, including exteriors access/PHP/editor-transport regressions.
- PostgreSQL test holds global documents `FOR UPDATE` with pool size 1; export
  still completes without waiting on the account locks.
- Cursor coverage test includes 1,003 organizations; frontend tests cover progress,
  all pages, later-page failure and malformed responses.
- Final running dev HTTP export: **5,723 organizations, 6,389 users, 229 pages**;
  **54.756 seconds total**, slowest page **1.599 seconds**. All organization IDs
  and user counts match independent reads from dev storage.
- Real authenticated Jack browser TSV download on the initial `46aa043` release:
  **6,389 rows, 62 columns, 3,068,154 bytes**; all composite user IDs unique and
  none missing. Final `4e7390e` only optimizes backend directory paging; the full
  running HTTP export was repeated after that update as described above.
- Source preservation checks: 1,330 unrelated public files on initial combined
  staging; 1,333 on the final one-file optimization. Exteriors source unchanged.
- Public readiness returned healthy/development with enforced outbound safety.
  All three roles retain full-house enabled and exact Jack allowlist. PHP signing
  override untouched. Unauthenticated access to the existing private draft is 404.

Artifact on dev worker: `/home/dev/export188-4e7390e.tar.gz` plus `.tar.json`.
SHA256: `2e361fe8aacca84d846801451da19445187372dd5b6fded65c7d27961e9210da`.
Size: 249,862,713 bytes. Initial dev baseline `46aa043` remains a safe rollback
for this optimization; never roll back below the exteriors privacy guards.

The exteriors task was handed the final baseline after verification. It has a
subsequent combined address-autocomplete release prepared (`6eed8c8`); verify
current dev state before another deployment. No production promotion authorized.
