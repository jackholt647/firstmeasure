# Exteriors integration and export 188 — production promotion

Completed: all eight production roles and the signed replacement channel run
`6eed8c8a0b0f2d02673176a0dda205d2bfc6a685`. Exteriors remain disabled.

Jack authorized production promotion after testing on development. The overlap
with export fix 1M8-188 was explicitly disclosed before activation; Jack replied
"continue" and the exact combined development release was promoted.
Exteriors remain disabled in production, including for the owner account.

Runtime: `6eed8c8a0b0f2d02673176a0dda205d2bfc6a685`.
Previous production: `42ab264b13fcc953bed4688bf112b12adbcb781d`.
Artifact size: 249,867,150 bytes. SHA256:
`6b23d56fbfb6f6e6e4803c656eee0dfcce579ad1b501bd95959e846de6149b28`.
Previous artifact SHA256:
`83d9bdeeda9c917f7923a7c1e280f8fe0e789208c9f9fb54004f4193046f3c6f`.

The same Linux archive was tested on all three development roles. See
[exteriors validation](development-exteriors-20260915.md),
[address follow-up](development-exteriors-address-20260915.md), and
[export 188 verification](development-export188-20260915.md).

## Production preparation

DigitalOcean inventory was refreshed: the same six web droplets, worker and
compatibility host remain active. All eight deployed trees matched 1,356 tracked
source files against Git and 1,609 packaged non-dependency files against the
retained previous archive, including compiled code. The previous signed
replacement target matched the active release.

All eight actual process environments had full-house enablement absent/off and
an empty allowlist. The replacement bootstrap overlay also leaves them off.
Normal production provider credentials, Tracking, database pools, eight web
children, worker slots, heartbeat ownership, drain/readiness settings and PHP
configuration are preserved. No development flags, allowlist, browser-key file,
or full-house signing override is copied to production.

Database sample before fleet rollout: 73 connections of max 100, zero private
full-house projects. No schema migration, dependency, provider, image, autoscale
capacity, DNS or application-data change is part of this deployment.

The pre-activation 15-minute sample recorded existing reroll HTTP500 and
acquisition-event HTTP503 errors, plus isolated project/organization/queue HTTP500
responses. These are a baseline observation, not claimed fixed by this release.
No Tracking collection warnings appeared in that sample. Reentry checks permit
only the previously reviewed exact reroll/Apple500 and acquisition503 pairs;
other routed 5xx require review. Editor500 is not exempted.

## Release procedure

The compatibility controller verified and installed the exact development
archive, then published it through the locked signed channel with the previous
SHA guard. The remaining seven roles downloaded, verified and staged that signed
archive. No host rebuilds its own application.

Web servers roll individually through the checked-in activation script, including
the signed-target guard, graceful drain, restart, readiness and rollback handler.
Each must pass at least three LB readiness probes and successful routed traffic
before the next server rolls. Actual process environments are compared across
restart; only release/process identifiers may change. Compiled full-house
authorization must report disabled and owner access denied.

The worker had zero running jobs and 303 queued jobs immediately before restart;
this was not an empty-queue assertion. Compatibility and PHP-FPM activated last.

## Completed fleet and verification

All starts are September 15, 2026 UTC. Each web reentry window had at least three
successful LB probes, the routed successes listed below, and zero unexplained
5xx. The known-error exemptions were not used in these reentry windows.

| Role | Host | Service start | Reentry routed successes |
| --- | --- | --- | --- |
| Web 1 | 64.23.240.81 | 21:58:17 | 64 |
| Web 2 | 137.184.88.252 | 21:59:57 | 9 |
| Web 3 | 137.184.187.218 | 22:01:23 | 37 |
| Web 4 | 146.190.150.235 | 22:02:42 | 45 |
| Web 5 | 143.198.137.97 | 22:04:19 | 42 |
| Web 6 | 143.198.104.224 | 22:05:46 | 19 |
| Worker | 146.190.169.59 | 22:06:21 | — |
| Compatibility | 144.126.222.110 | 22:08:14 | — |

PHP-FPM started at 22:08:15 UTC. Every role passed actual runtime configuration
checks with full-house disabled, owner authorization false, and zero Tracking
warnings since activation. The full-house capability returned 404 on each HTTP
role; the compatibility probe used the existing outer proxy authentication to
reach the application gate. The final file audit matched all 1,668 packaged
non-dependency files on every host, including compiled output and PHP/assets.

The worker environment comparison initially flagged the expected systemd
`WATCHDOG_PID` change. Its new value was verified against the active main PID;
the checker now treats it as a process identifier. No second worker restart or
application configuration change was needed.

Public readiness returned the exact new release and production data environment.
The signed replacement target was independently verified again. Post-rollout DB
sample: 72 connections of max100 and zero private full-house projects.
DigitalOcean's refreshed LB page showed Healthy and all six members Active.

Normal main and summary PDFs rendered through the production PDF runtime from
the existing validation fixture: 1,129,628 and 1,129,711 bytes, respectively.
Both had valid PDF headers; rendering took 2.706 seconds with upload, persistence
and status updates disabled. No email, charge or production project edit was
performed for validation.

After Jack refreshed the staff login, the actual production roofing editor
rendered its ordinary tools and the shared swap/resize controls. A view swap and
restore worked. DOM inspection found zero exterior scripts and zero Resources
buttons. The signed-in full-house page displayed "Not found"; unauthenticated
access also returned 404 with private/no-store caching. No measurement was
created. The browser was returned to the production dashboard.

Export 188 is included in this release; it does not need a second production
activation. Its full-data completeness and browser download evidence are in the
linked development record; a second full customer export was not run in production.
The production release source is on `codex/internal-exteriors`; future releases
must preserve this baseline. Documentation-only commits do not change runtime.

## Rollback

The retained previous archive is available on the controller as
`/root/tracking184-42ab264.tar.gz`. To roll back, first republish its signed target
against this release's SHA, then roll the fleet through the guarded activation
workflow. Reconcile the global channel if any node independently rolls back.

The production private-project count was zero and creation remains disabled, so
the previous binary remains a viable code rollback for this rollout. If private
projects are enabled/created later, retain the privacy filters in any rollback.
Do not apply a pre-integration rollback to development, where private drafts exist.
Code rollback never reverses customer activity.
