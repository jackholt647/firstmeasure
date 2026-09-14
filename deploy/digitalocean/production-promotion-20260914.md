# September 14 production promotion

Jack authorized production deployment of 1M8-176, 177, 178, 182, 183, 185 and 186.
Candidate release: `678cc85b8f13325e0b0142c9b7f65b646881c1ee`.
Application source is identical to development-tested `e36c4d5`; subsequent
commits add documentation and a test-harness newline fix for LF checkouts.
See development-followups-20260914.md, development-ui-20260914.md and
prices-workload-20260914.md for scope, test boundaries and acceptance criteria.

## Preparation

A clean, isolated Linux x64 worktree passed npm installation, TypeScript checking,
compilation and 35 focused regression tests. Four archive tests, seven signed
channel tests and the activation guard test passed. Existing dependency audit
findings remain: production dependencies report two moderate and two high
vulnerabilities; no dependency upgrade was attempted in this release.

All 1,263 selected public-source files were compared on all eight production
hosts with the previous e35b884 Git baseline. The only difference on every host
was the same lockfile: npm removed 16 optional Sharp libc selectors, without
changing package versions. No application-only server repair was omitted.
External mail credentials, heartbeat ownership, job slots, database pool limits,
web worker counts, drain and readiness overrides were checked without dumping
secrets. No host configuration was replaced.

Artifact: 249454661 bytes; SHA-256
`68814a255739ee28a98c40f8077f2b24ef8f2521fab68a7e0e0e2400a4433f07`.
The controller independently verified archive structure, identity and checksum,
then published through the single-publisher lock and expected-previous guard.
Previous artifact SHA was
`5912483f4dd22f7a785104f44a6ed568eaef2164f67b57a1f799387ccc47f25a`.
All seven non-controller hosts downloaded the signed artifact from private
Spaces and installed the same runtime; compatibility installed the verified
identical archive. No rebuild occurs per node.

## Rollout

The existing September 10 signed bootstrap/image 244899309 remains unchanged.
Routine publication changes its code target, so future replacements fetch the
new release. No pool template change, replacement overlap, size change, database
migration, DNS change or new infrastructure purchase is part of this rollout.
Provider inventory confirmed the same six web members and autoscale range 6–7.
Preflight database activity was 74 of 100 connections (three reserved).

Web nodes are activated sequentially. The signed-target guard runs before
stopping each node; SIGTERM withdraws readiness while the existing 40-second
grace period lets active requests finish. After stop, guarded activation verifies
readiness, exact release identity and eight HTTP children. Before proceeding,
NGINX must show at least three successful provider readiness probes and successful
routed application requests after startup, with no routed 5xx in that window.
Worker and compatibility are activated separately; compatibility is last so
the expanded Prices UI is not exposed before pricing consumers are updated.

## Data and rollback constraints

Saved pricing/workload configuration, revisions, customer records, credits,
charges and historical QA/geometry records are not changed by this deployment.
The new workload fields default only in memory for older saved configurations.
Once an admin saves the expanded configuration, rollback to the old strict
schema is not code-only safe: use a forward fix or an explicitly reviewed
configuration rollback. Do not silently restore defaults.

Retain e35b884 and its verified signed artifact. A web rollback must first
republish that artifact against the current channel SHA, then roll nodes back
with the guard; do not bypass it. Single-node activation failure halts the
rollout and requires global channel reconciliation. Code rollback does not undo
customer activity. Reporting-team acceptance and documented provider/fixture
limitations remain separate from release verification.

## Final result

All eight roles are active on 678cc85. Web activation/reentry completed in order:
64.23.240.81, 137.184.88.252, 137.184.187.218, 146.190.150.235,
143.198.137.97, 143.198.104.224. Each retained eight HTTP children, passed the
signed-channel match, and served successful load-balancer requests before the
next web restart. The worker activated at 18:11 UTC after a no-running-jobs
sample; it has eight job slots, a fresh watchdog and no restart/error-level
entries in the observed post-start window. Compatibility/PHP activated at
18:15 UTC. All runtime configuration checks passed; exactly one heartbeat owner
remains. Public readiness and all nine changed served JavaScript assets match
the approved release. DigitalOcean subsequently reports Healthy and all six
members Active. Final database sample: 67 connections, max100/reserved3.

Authenticated production verification after Jack signed back in confirms Prices
loads all eight new workload/schedule fields with the original values and a
populated 24-hour Pacific preview. No settings were edited or saved; revision
remains zero. QA Quality Results visibly shows range labels in the summary,
team and QA tables. Unauthenticated Prices access returns 401. The public
customer quote endpoint succeeds at revision0 with the existing standard/rush
defaults. Save/rework/export/provider-specific acceptance still relies on the
focused regressions plus reporting-team testing; no real customer workflow was
mutated merely to test the release.

The compatibility restart caused a brief window of web-to-compatibility
ECONNREFUSED errors; these ceased after recovery. A subsequent fleet log sample
found no error-level entries on five webs and one `premature close` on the
sixth; that same host had five premature-close errors in the pre-release
17:50–18:10 window. Do not describe this as a globally error-free application. Compatibility
still logs the known referral_events uniqueness error: 179 instances were
observed before its activation (17:50–18:15 UTC), and it remains afterward.
That is deferred 174 work, explicitly excluded by Jack, not repaired here.

The seven issues were moved to Testing in Prod at approximately 18:20 UTC with the above evidence and
issue-specific limitations. Final completion remains with the reporting team.
