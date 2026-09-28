# Development full-test organization sample data

Equipment was delivered first in `25377795bbb254d636b3afccc4354b0edd034b24`,
over web baseline `84ce2d2073a28a370d3e9e42980f4124079dc9c9`. The subsequent
`a292b51440e1f4f3bdb2601ecb21cc087a56c1bf` adds independent channels, projects,
and customers toggles and puts the button directly on each full-test org card.
All options default off. See [the sandbox spec](../../docs/signup-sandbox-spec.md).

The latest full-test organization at discovery was **Harbor Petrel Test Co
db8723**, `org_8dac97f2f423eed9`, instance `sbi_d7cdb870d37a5080`, created at
2026-09-28T20:43:00.865Z. Only equipment was added to that existing org: five
types, ten units, one yard, two maintenance orders/shared events, and one
reservation. Readback confirmed seven Available units, one Down, one Reserved,
and one Retired. Dates are relative to the first run and are preserved by
subsequent requests. The other data categories remain optional.

Both releases use checksummed deltas over verified live web source. No other
dirty workspace files were included. Compatibility retains older signup
source despite its matching release label; its hash guard rejected staging
before mutation. This route and its UI are served by the web nodes, so
compatibility and worker releases remain unchanged. Production, provider
settings, infrastructure topology, and organization permissions were untouched.
No schema migration is required. The historical development autoscale image
limitation remains; a replacement web node needs the current release.

The first activation reached readiness, then a CRLF at the end of the shell
script triggered its rollback trap. The previous web release was restored;
the script was normalized to LF and the rollout repeated successfully.

Verification includes TypeScript build and staged Linux checking, isolated
SQLite and embedded PostgreSQL fixture tests, concurrent repeat requests,
tenant isolation, disabled-app rejection, preservation of edits, independent
category selection, admin/origin authorization, and a Chromium modal test.
The modal starts with four unchecked options, rejects empty selection in the
UI, and sends the exact selected booleans.

Final verification: both serving web nodes (`do-598520065`, `do-603124965`)
passed local readiness on `a292b51` with development isolation enforced. A live
Chromium visit to dev.1m8.ai opened the target org's sample modal, confirmed all
four unchecked toggles, and submitted Equipment again successfully with zero
new types, units, yards, orders, or reservations. No page errors occurred. The
public script SHA-256 matched the deployed artifact. Twelve public readiness
requests passed on the same browser's sticky web connection.

Release evidence, manifests, staging/activation scripts, and live verification
are under ignored `output/test-org-samples-20260928/`.

Rollback: inspect each web node's current release first to account for later
work. Returning to `2537779` restores equipment-only sample controls; returning
to `84ce2d2` removes the feature. Use the preserved per-node release and existing
symlink/service workflow, one node at a time, and verify development isolation
and readiness. Code rollback does not delete sample data or undo user edits.
