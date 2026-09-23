# Priority Linear fixes — development only

Runtime release: `c76965cac1ee91e4f22ab5e7f8ba82f98f3194a5`.
Verified baseline: `81f6dc35b1954aa4fa49b7c6deba753ffc882ce7`.
Isolated branch: `codex/linear-193-189-190-192`.

- 1M8-193 (`0c30625`): complete customer credit ledger TSV, one transaction per row, paid/bonus split where supported by stored metadata, ID/ordinal pagination, explicit unknown split, no ledger mutations. Existing customer export remains intact.
- 1M8-189 (`b959ba4`): address search no longer inherits an implicit 90-day window. Explicit dates and actor visibility remain enforced.
- 1M8-190 (`1644b80`): project Work History displays the stored manager name/email for manager approval, separate from QA attribution.
- 1M8-192 (`4455c4e`): fallback PDF label generation uses the shared obstacle-face check instead of excluding any facet touching a chimney corner or sharing an endpoint X coordinate. Actual obstacle faces and excluded duplicates remain hidden. The original Slack evidence is inaccessible; Ben was mentioned in Linear and asked to attach screenshots and the affected project URL.
- `c76965c`: test-only fetch BodyInit compatibility correction for existing reference-upload test.

All three development roles were staged and activated. The nine-file runtime delta preserved 18,081 other public files on each role. Source before-hashes came from the verified Git baseline; compiled before-hashes were checked against the running baseline. No dependency, database, environment, feature-gate, or production changes. Full-house remains enabled for jack@1m8.ai only. Worker activation required zero running jobs. Runtime readiness confirms development outbound isolation, test Stripe, restricted email and blocked SMS. Public load-balancer readiness recovered after restart.

Delta retained on each dev host: `/home/linear-bugs-delta.tar.gz`, `/home/linear-bugs-delta.json`. Archive SHA-256: `6cdfb7efce664cbbcc52c562b657971c4707daf3cf15e7c15bde9572646279b2`. Guarded activation helper: `/home/deploy-linear-bugs.py`. Baseline release retained for rollback.

Validation: TypeScript check/build pass; 12 targeted export, browser pagination, manager-history and PDF tests pass; historical-search integration passes against SQLite and embedded PostgreSQL; export integration passes against embedded PostgreSQL while global rows are locked; real PHP reference-upload regression passes. Read-only dev API verification finds all three addresses from 189. Full dev ledger export returns 60,344 distinct transactions in 265 pages, exactly matching independent database count. All 9,622 purchase/top-up records have reconciled paid/bonus amounts; 995 other/manual entries retain an explicitly unknown split. No real order, credit adjustment, or report submission was made.

Do not bulk deploy the canonical dirty internal-exteriors checkout. These fixes were isolated specifically to preserve concurrent, unreleased PDF/editor/trim work. Before any later dev activation, verify the current release again. Production promotion is not authorized by this development task.

Final browser checks: Jefferson search displays the April report; a saved manager-approved project displays the manager identity in Work History; Export Credit Ledger downloads a TSV with 60,344 transaction rows plus its header. All three changed browser scripts match the tested source served through dev.1m8.ai. Linear 193, 189 and 190 are Done in Dev with verification notes. 192 remains In Progress: the concrete fallback-path bug is fixed in development, but Ben's original case still needs accessible evidence before claiming full resolution.
