# People-first Tracking rollout — 1M8-184

Authorized by Jack; UTC September15 (local September14). Candidate
`dcb8064af9f521d408974aa328da36d3393d533c`, branch codex/september-14-bugfixes.
Previous active release `8a5e84f9348e3f8a4f44eda5b40076acd252cc83`.
Only application delta: people-first Tracking UI, people/network APIs and SQL
summaries. Universal collection, Admin/default viewing and explicit grants remain
unchanged. No migration, configuration, capacity or image changes. 185 retained.
177 and187 are subsequent development work, not included in this candidate.

Linux artifact: 249503674 bytes, SHA256
`0f0bf02acac1f5a4908361a2e48221608d4b97a0536186cdb24ebb728165729b`.
Previous artifact SHA256
`0474ac7ebad751ea649874f67b73001a7df87b63e4b105677ec36b438988febe`.
Built in clean /home/dev/code/people184-build on isolated development worker.
npm ci, typecheck/build, real Tracking API tests and isolated PostgreSQL tests passed.
Prior local browser regression covers people list, navigation and mobile layout.
No dependencies changed; existing audit findings remain outside this release.

Provider inventory was reverified: same six webs, worker and compatibility as the
185 record. All eight active source trees match1,601 packaged non-dependency files
from8a5e84f; runtime settings and no-new-Tracking-warning checks passed.
Database sample70/max100. The two previously deferred185 orders were already
rejected_no_coverage before this rollout; this task did not change them.

Plan: rehearse identical artifact on three isolated development roles and verify
live authenticated people/network APIs and access revocation with synthetic users.
Publish signed replacement channel with previous-SHA compare-and-swap. Stage all
roles; roll six webs individually with guard/drain/readiness/reentry, then worker
after zero-running-job guard, compatibility/PHP last. Preserve existing provider,
pool, readiness, heartbeat and Tracking configuration. Known PHP500/referral503
baseline remains explicitly distinguished from new errors.

Rollback: republish retained8a5e84f artifact against the new SHA, then roll roles
back using the guard. No schema rollback or data deletion. Collection history and
grants remain intact. Always invoke release-channel.mjs by concrete release path,
not current symlink, to execute its CLI entrypoint.

All three development roles activated the identical artifact and passed runtime
and outbound-isolation checks. Following the single dev web's LB reentry, live
authenticated API tests verified directory search, per-person known IPs, Admin
access, ungranted denial, grant/revoke, immediate revocation on the new endpoints,
and collection with resolved IPs for three synthetic users. Synthetic staff were
disabled in cleanup. No production grants or people records were changed.

Production rollout completed 02:17 UTC. All six web nodes passed sequential
signed-target, drain, readiness and LB reentry checks (three ready probes each,
9–19 successful routed requests, zero unexplained routed 5xx). Worker activated
after both idle-gap and zero-running-job checks. Compatibility/PHP activated last.
Final audit matched all 1,602 packaged non-dependency files on every role; all
eight runtime checks passed with no Tracking warnings since activation. Signed
replacement target independently verified. Provider UI, refreshed after its
initial stale final-node status, reported Healthy and all six nodes Active.

Authenticated production Admin UI verified in Jack's account: default People
directory showed 1–25 of 183 users, search narrowed to Jack, and the detail page
loaded known IPs and activity with zero collection errors/drops reported by that
API process. Admin/default and explicit-grant viewing policy is unchanged.
No production grants, exams, review decisions or customer projects changed.
1M8-184 is ready for Testing in Prod/team acceptance. Existing PHP memory failures
remain 1M8-187; 177's new missing-notes kickback is subsequent development work.
