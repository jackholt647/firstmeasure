# September 14 staff Tracking production rollout (1M8-184)

Completed: all eight production roles run
`b976d07a3830c26e3e4fe7e7f75057c9f14f1ad3`, also selected by the signed
replacement channel. The chronology below records intermediate candidates and
the issues caught before final fleet activation; they are not the current release.

Jack authorized production deployment after local Done in Dev. Initial candidate:
`29476bed3ef94715470680a2faefe7c69ebd3610`; previous production `678cc85`.

## Preparation and rehearsal

All 1,269 selected public-source files on all eight production hosts matched the
previous Git baseline exactly. The existing dirty development source checkout
was left untouched; a separate clean Linux worktree built the candidate.
TypeScript check/build, the five focused application tests (including real PHP
exam submissions), and the isolated PostgreSQL integration test passed on Linux.
The existing four production dependency audit findings remain (two moderate,
two high); no dependency version changes are part of this release.

The same Linux runtime archive was installed on all three isolated development
roles. Their outbound/data-isolation readiness checks passed. Live development
API rehearsal through dev.1m8.ai passed Admin access, ungranted manager/QA denial,
grant/revoke enforcement, and real-IP activity collection for ungranted QA.
Synthetic development staff were disabled after the successful test; no
production users, grants, campaigns, prices, orders or exam records were edited.
The single development web node briefly returned LB 503 during restart/reentry;
production rolls one of six web nodes at a time.

Archive size: 249485621 bytes. SHA-256:
`aacb1cbce3bef8ac1c2445ac5d84c45e08ae19a080be9d70021ad9fd3715988d`.
The compatibility controller published and read back the signed channel against
the verified previous artifact SHA
`68814a255739ee28a98c40f8077f2b24ef8f2521fab68a7e0e0e2400a4433f07`.
All other production roles downloaded and verified that same signed archive;
there is no per-host rebuild. No template/image/capacity/DNS change is involved.

## Additive schema and configuration

Four new PostgreSQL tables: staff_tracking_events, staff_tracking_grants,
staff_tracking_reviews and staff_tracking_audit; four event lookup indexes.
They were initialized once with the production application connection under
explicit deployment authorization, before any enabled application process.
Pre-migration database sample: 66 connections of max100; no existing data imported
or rewritten. Normal POSTGRES_AUTO_MIGRATE remains unchanged.

Each role has a protected /etc/firstmeasure/tracking184.env and a scoped
zzzzz-tracking184.conf service drop-in. Collection is enabled for authenticated
active staff; only viewing is individually permissioned. No initial non-Admin
grants were created. The verified production VPC is 10.124.0.0/20; trusted
proxies are that VPC plus loopback, walked from the actual socket peer.

Compatibility alone holds a new random PHP/Node receipt-signing secret. Its
PHP-FPM pool receives the settings via /etc/php/8.3/fpm/pool.d/zz-tracking184.conf;
curl and FPM configuration were validated. The bridge targets loopback port3101.
No secret was stored in Git, public assets, the bootstrap overlay or this record.

The controller's private production-cutover.env overlay now contains only the
non-secret Tracking enablement/trusted-proxy settings for future replacements.
Its original ownership/mode/ACL were preserved and the authenticated bootstrap
fetch was verified from a web node. The protected pre-change backup is
/etc/firstmeasure/production-cutover.env.before-tracking184.

## Rollout and verification

The initial rollout paused after two web nodes. Tracking's fail-open collector
logged generic warnings, and one public readiness request returned 503 during
the rollout. That single response does not establish a sitewide outage or prove
the collector caused it. Other nodes and subsequent public checks were healthy.
Collection was disabled on all eight roles and in the replacement overlay before
continuing investigation. The other six roles had not changed code.

Diagnostic release `97ce3e4fcafd2b654f2343665cf0978ee82fbb18` passed isolated
development tests and ran on one production canary. It identified TypeErrors
outside authentication, staff lookup and insertion. A deterministic regression
then reproduced the socket-detach race: the collector accessed remoteAddress
after awaiting authentication/database work, by which time the response socket
could be null. This drops an observation but does not reject the completed
request. No SQL-write failure was identified by the diagnostic canary.

Corrected candidate `42b65c0c7ac9ab253046b5a690a517a7198edf0a` captures immutable
connection provenance before any await, including training/exam start receipts.
The new failing-before/passing-after regression and PHP submission suite passed
on Windows and Linux. Diagnostic logs contain only allowlisted error categories,
not messages, IPs, cookies or staff details.

Corrected artifact: 249487921 bytes, SHA-256
`34dcfad7c4bfabac4d8ac5c9be834a781217eab291abf6f429b2965749735bd8`.
This intermediate candidate was not accepted as the final fleet release.

The `42b65c0` canary eliminated exceptions but exposed incomplete provenance:
40 new observations included only 15 resolved IPs. Some proxy connections were
already detached before onResponse began. This was not accepted as completion.
A second deterministic regression failed before the ingress snapshot change.
Candidate `b976d07a3830c26e3e4fe7e7f75057c9f14f1ad3` captures peer, forwarded chain,
browser and timestamp in onRequest using a request-scoped WeakMap, before proxy
or response teardown. Both detach-timing tests and fail-open storage tests passed
on Windows and Linux. It does not substitute a guessed IP when provenance is
missing. Earlier partial/unknown-IP rollout observations remain explicitly gaps.

Final candidate artifact: 249488605 bytes, SHA-256
`44f1c08045f92f69926c8560e241098beaf4189bf4d70eab0740c6528275ddf5`.
All three development roles activated this same artifact. Its live Admin/grant/
revoke/ungranted-collection rehearsal passed with resolved IPs and zero Node/PHP
collection warnings. The isolated PostgreSQL 500-staff/10,002-row bounding and
concurrent-deduplication/retention regression passed again. Provider inventory
was refreshed and confirmed the same eight production hosts before promotion.

The final production canary started at 20:12:06 UTC, passed three LB readiness
probes with 51 successful routed requests and zero routed 5xx at reentry. An
initial normal-traffic sample contained 19 new observations with 19 resolved IPs,
zero collection failures, and 73 database connections of max100. The private
replacement overlay was re-enabled and fetched successfully from the canary;
it contains no PHP receipt secret. The remaining roles then rolled sequentially.

The second final-release node's strict reentry check stopped on staff PHP 500s.
Investigation verified the compatibility code still ran unchanged `678cc85`,
and PHP-FPM had not restarted since 18:15:11 UTC (before this rollout). Its nginx
log contained 2,377 pre-19:27 PHP memory exhaustion errors with a 134217728-byte
limit, first seen at 00:00:48 UTC. Its actual php.ini memory_limit is 128M.
On that web node's pre-19:27 access log, editor.php had 408 HTTP500s,
top_view_reroll_proxy.php 251 HTTP500s, apple_endpoint.php 92 HTTP500s, and
/v1/platform/acquisition/event 1,182 HTTP503s, all starting shortly after midnight.
These are existing failures, not asserted resolved by 184. No PHP memory setting
or acquisition behavior was changed as part of this release.

After this baseline review, reentry verification explicitly reports those four
exact route/status pairs separately and still requires 3 ready probes, successful
routed traffic, zero other 5xx and zero tracking warnings. The signed-channel,
eight-child, runtime configuration and database checks are unchanged. This is
not a claim that production is free of existing application errors.

The PHP memory failure is recorded separately as high-priority Todo
[1M8-187](https://linear.app/1m8/issue/1M8-187/staff-editor-and-image-endpoints-hit-phps-128-mb-memory-limit).
It is not marked fixed by this release.

## Completed fleet and live verification

All six web nodes, worker and compatibility activated the exact final artifact
without per-node rebuilds. Final service starts on September 14 (UTC):

| Role | Droplet / host | Started |
| --- | --- | --- |
| Web 1 | 599442759 | 20:12:06 |
| Web 2 | 599442763 | 20:14:59 |
| Web 3 | 599442764 | 20:23:22 |
| Web 4 | 599442766 | 20:24:31 |
| Web 5 | 599442768 | 20:25:55 |
| Web 6 | 599442769 | 20:27:12 |
| Worker | 146.190.169.59 | 20:27:53 |
| Compatibility | 595495782 | 20:28:12 |

Every role passed release/configuration verification with collection enabled and
zero Tracking warnings since its final activation. Existing HTTP child counts,
database pools, job roles, provider settings and single compatibility heartbeat
were preserved. Worker restart was guarded by zero running jobs (200 queued jobs
were present; this was not an empty-queue assertion). Each web node passed LB
reentry checks under the explicitly reviewed baseline above.

Public readiness returned 200; unauthenticated Tracking access returned 401.
A post-fleet normal-traffic sample after 20:28:20 UTC contained 20 observations
from 16 staff, all 20 with resolved IPs. Database connections were 76 of max100.
These are bounded samples, not a guarantee of complete historical coverage.
Earlier incomplete canary observations remain identifiable gaps, not backfilled.
Compatibility PHP receipt logging showed zero Tracking warnings after activation.
Signed target and authenticated replacement overlay readback both passed.

After Jack signed in again, the production Admin Tracking tab was verified:
Activity history populated with IP observations and enabled pagination; Training
& exams rendered its explicit no-observations state; Review signals populated;
Viewing access showed automatic Admin access and explicit per-user switches.
The screen explicitly states collection covers all staff and IP matches are not
proof of impersonation. No production grants or review decisions were changed.
There are zero explicit viewing grants at release completion. Actual exam receipt
and grant/revoke mutations were tested only in isolated development, not production.

The runtime remains b976d07; the final documentation-only commit is not a new
application artifact. 1M8-184 moves to Testing in Prod for team acceptance.

## Rollback

Disable collection in the scoped role files **and** private replacement overlay,
then restart roles safely if the feature itself needs an immediate hold. Preserve
the unrelated readiness/provider/heartbeat settings and bootstrap ACL.
The previous code ignores the four additive tables. Retain their evidence and
grants; do not drop them or undo customer/training activity as part of rollback.
Any code rollback must republish the retained previous signed artifact against
the current SHA before rolling web nodes; do not bypass the signed-target guard.
The prior pricing/workload rollback constraint in production-promotion-20260914.md
still applies to older releases.
