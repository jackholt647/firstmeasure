# QA feedback and PHP memory rollout — 177/187

Jack authorized production promotion of the exact development-tested release
`42ab264b13fcc953bed4688bf112b12adbcb781d`. See
[development evidence](development-qa177-php187-20260915.md).

Artifact: 249,518,488 bytes; SHA256
`83d9bdeeda9c917f7923a7c1e280f8fe0e789208c9f9fb54004f4193046f3c6f`.
Previous release: `dcb8064af9f521d408974aa328da36d3393d533c`, artifact SHA256
`0f0bf02acac1f5a4908361a2e48221608d4b97a0536186cdb24ebb728165729b`.

No migration, dependency, configuration, memory-limit, image, capacity or DNS
change. Tracking and API coverage rejection fixes remain included. Only the
confirmed PHP bundle exhaustion / hidden QA-note failure is claimed addressed;
historical Apple/reroll errors have not been established to share that cause.

## Preparation

Provider inventory confirmed the same six web nodes, all Active / LB Healthy.
All eight active source trees matched 1,602 packaged non-dependency files from
the previous release. Runtime settings passed; one pre-existing nonfatal staff
Tracking collection warning was present on 137.184.187.218, with normal workflow
continuing and readiness passing. Existing reroll 500 and acquisition-event 503
errors were recorded before activation. Database sample: 71 connections/max100.

Development worker re-audit matched 1,609 packaged files and the expected release.
The controller independently verified the artifact SHA, installed it, and
published through the locked signed channel with expected previous SHA. Other
seven roles downloaded and installed the signed identical artifact.

## Rollout and verification

Web nodes roll individually with signed-target guard, graceful drain, readiness
and at least three successful LB probes plus routed traffic before proceeding.
Worker waits for zero running jobs; compatibility and PHP-FPM activate last.
Rollout completed at 03:03:41 UTC. All six webs passed three LB readiness probes
and 1–30 successful routed requests, with zero unexplained routed 5xx in each
reentry window. The worker's first activation attempt correctly refused while
a job was running; it subsequently activated after two zero-running checks.
Compatibility/PHP-FPM activated last. All eight roles then matched all 1,609
packaged non-dependency files and passed runtime/Tracking checks.

Read-only production verification of the original reported project succeeded:
46,707,350-byte JSON stream, both QA threads, PDF state present, HTTP200, with
4,194,304-byte PHP peak under a 32 MiB probe limit. The first CLI probe lacked
the web request's HTTPS context and hit a 307; correcting only that probe's
URL context resolved it. No production configuration was changed. The serialized
response is smaller than the 106,897,754-byte stored JSON artifact; don't equate
artifact bytes with response bytes. Synthetic development tests separately
verified exact image/geometry preservation and 110/140 MiB payloads.

Jack's actual production editor loaded the three structures and displayed
QA KICKBACK / two open issues. Expanding the first note showed its real feedback
text and Fixed/Dispute controls. No note status, geometry or customer submission
was edited. The team had already cancelled/split this original order. Browser
save/reload was exercised on the synthetic development fixture, not this order.
No editor memory/stream errors were found since compatibility activation.
The signed replacement target was independently rechecked after rollout.
Public unauthenticated feedback returned HTTP401. The refreshed provider UI
reported Healthy with all six web members Active. 177 and 187 were moved to
Testing in Prod with the evidence and limitations above; team acceptance remains.

## Rollback

Retain dcb8064 and its archive. Republish its signed target against the new SHA
before rolling web roles back with the guard; do not bypass it. No schema
rollback is necessary. Code rollback does not undo customer activity. Stop and
reconcile the global channel if a node activation rolls back independently.
