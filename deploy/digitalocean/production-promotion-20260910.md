# September 10 production promotion — rollout in progress

Jack authorized production promotion of 1M8-152, 178, 179, 180 and 181.
The tested application release is `e35b8847eb42d390ba01d734f4b32bb5abe5611c`.
Compatibility and worker are active on this release. Web replacement is underway;
the historical preparation/checkpoint sections below describe earlier states.

## Verified access and baseline

Trusted host keys and Juliet's root authentication work on all eight hosts.
Authenticated DigitalOcean inventory confirms the six existing web members,
compatibility `144.126.222.110` and worker `146.190.169.59`.
Compatibility runs `0406b37c54534ff9c2719f9d2bed0a0cbbcfb315`; web and worker
run `61b0626cf07c07dab302ad2e95ddf84f4ee34fee`.

Normalized source hashes were compared against the corresponding Git versions.
The compatibility editor session-lock patch is already in the candidate.
Compatibility/worker lock-file differences only remove optional Sharp package
libc selectors; package versions are unchanged. All six web source comparisons
match their recorded Git baseline. Preserve the runtime configuration separately.

The compatibility controller now has a dedicated Ed25519 release-signing key at
the documented private path, mode 0600. Only its public key was pinned on the six
web hosts and worker. The signed private channel has now been published and
verified; no existing service restarted.

## Runtime artifact and bootstrap preparation

A clean Linux development worktree passed TypeScript checking and compilation.
A separate staging copy was pruned to production dependencies. Packaging exposed
two previously untested real-tree cases: the required compiled `src/storage`
module and registry dependency test fixtures containing keys/archives. The
packager now permits only the two exact source/compiled module paths and omits
otherwise forbidden dependency test assets. Runtime storage and secret paths
remain rejected. Four archive tests pass on Windows and Linux; seven release
channel tests pass. The artifact was built with the reviewed updated packager;
its selected application source remains the exact tested e35b884 commit.

Artifact on development worker:
`/home/dev/code/followups-e35b884-runtime-v2.tar.gz`, 249430211 bytes,
SHA-256 `5912483f4dd22f7a785104f44a6ed568eaef2164f67b57a1f799387ccc47f25a`.
Transfer to the controller and independent checksum/archive verification passed.
Large SSH uploads reset; a resumable transfer retained verified matching chunks.
The controller published the initial signed manifest using the `none` previous
target guard and its single-publisher lock. Upload readback validation passed.

The exact artifact is installed but **inactive on all eight production hosts** at
`/opt/firstmeasure/releases/e35b8847eb42d390ba01d734f4b32bb5abe5611c`.
Web/worker downloaded from the private channel and verified signatures/checksums;
their staged artifact receipts match the signed channel. Compatibility installed
the independently verified same archive. Every `current` link still points to
its previous September 9 release. The public production readiness check remains
healthy on `61b0626cf07c07dab302ad2e95ddf84f4ee34fee`.

Prepared files `firstmeasure-release-bootstrap.service`,
`web-release-boot-dependency.conf` and `production-web-user-data.sh` prevent the
web service starting before cloud-final and verified release installation.
User-data queues service startup without waiting, avoiding an ordering deadlock.
It fetches the existing private production overlay and preserves web heartbeat
isolation. The live overlay is partial, so validation merges it with the base
configuration. Two executable Python bootstrap tests pass on Windows and Linux,
covering that case and rejecting cross-environment/heartbeat overrides. CI also
runs these checks. The Linux activation guard regression and two asymmetric
connection-budget tests pass. Shell syntax and systemd unit validation pass.
These boot files have not
been installed on production or tested on a newly provisioned node yet.

The image must already include the pinned helpers/public key, boot dependency,
reconciled NGINX forwarding, production base configuration, Chromium and instance
identity service. Do not use the new user-data with the historical unguarded image.
Keep helper code outside the replaceable application tree. The packaged e35b884
application includes the older helper source; use the reviewed external packager
and bootstrap installer for the real storage module path.

## Capacity and remaining gates

Current pool: six nodes, autoscale range 6–8, eight web processes per node.
A fresh read-only production query found max_connections 100, reserved 3 and
67 current connections. The documented conservative six-plus-six replacement
budget estimates 119 connections before ten slots of headroom, so a full
eight-process overlap is unsafe.

A proposed bounded transition freezes the pool at six during replacement and
limits new nodes to two processes: 6×8 + 6×2 + 23 non-web = 83, plus ten headroom
= 93 of 97 usable connections. Recheck actual load and configuration before
applying. Restore normal process counts and autoscale range only after old nodes
have drained. This is a proposed transition, not an applied setting or load test.

Jack approved up to $10 temporary compute and up to $6/month retained image
storage in the subsequent “Go for it” reply. The candidate must be
excluded from the public load balancer, and its connection budget bounded.

Still required: image preparation, real new-node rehearsal,
snapshot/template rollout, PHP tutorial-root permissions, application activation
and workflow verification. Preserve the previous runtime and retained tutorial
sources. Keep the five fixes Done in Dev until production verification; 1M8-173
is In Progress. Do not bypass the release-channel guard.

The PHP permission issue is confirmed on production: Node uses
`/var/lib/firstmeasure-legacy-production/current/tutorials`, and its retained
source exists, but PHP's www-data cannot write the primary root and the FPM pool
has no tutorial-root environment assignment. Preserve `pm.max_children=20` and
back up the pool configuration/ACLs before applying the scoped tutorial repair.
No tutorial data or permissions have been changed during preparation.

## September 10 live rollout checkpoint (20:11 UTC)

Approved spending: up to $10 temporary compute and $6/month retained image.
Production pool is temporarily fixed at six nodes. Controller bootstrap overlay
now sets V1_WEB_WORKERS=2 for new nodes; current six serving nodes remain at eight.
The original overlay is backed up privately on the controller. Restore normal
process counts and autoscale 6–8 only after overlap ends.

Snapshot 244892331 (`firstmeasure-production-web-signed-e35b884-20260910`,
SFO3, 100 GB minimum, 17.01 GB stored) contains pinned external helpers,
public verification key and web boot dependency. Created from 134.199.216.71
without restarting its serving process. Estimated image storage is $1.03/month.
Temporary rehearsal droplet 599439596, 143.198.231.177 / 10.124.0.4, c-8-intel,
was created at about 20:04 UTC at $0.324/hour. It has only the admin firewall tag
and a unique rehearsal tag, never the firstmeasure-web load-balancer tag.
Temporary compatibility firewall rules allow only that rehearsal tag on 80/3101;
remove after destroying the candidate. Provider inventory was verified before
pinning its new SSH public host key; strict host checking remains enabled.

The first boot caught HTTP 403 from the controller's bootstrap endpoint: NGINX
could not read the root-only environment file. A scoped www-data read ACL fixes
that while retaining private VPC, firewall and header authentication restrictions.
Preserve that ACL when changing the overlay. After rerunning the startup script,
the candidate was healthy on e35b884, with V1_WEB_WORKERS=2, pool max 1 and
heartbeat disabled. An invalid pinned signing key blocked web startup; restoring
the original public key restored verified startup. Reboot verification is underway.
No production application activation or pool template submission yet.

Before replacing old web hosts, online SQLite backups of all six referral ledgers
were copied into controller /root/followups-ledger-preservation-20260910,
mode 0700 directory / 0600 files. All six source/destination SHA-256 values match
and quick_check passes. No ledger merge or customer write was performed.

Compatibility PHP configuration is prepared: FPM tutorial-root environment points
to the same primary root as Node, scoped www-data traversal/write/default ACLs
are installed, and FPM configuration validation passes. pm.max_children=20 is
preserved. Private config/ACL backups are under
/root/followups-tutorial-config-backup. FPM has not restarted; activation will
apply its environment change. No tutorial data was changed.

## Corrected boot image and production activation (20:20 UTC)

Reboot testing caught a real systemd cycle: cloud-final runs after multi-user,
while web was wanted by multi-user and ordered after cloud-final. Move web's
install target to cloud-init.target and run systemctl reenable after the drop-in.
The corrected candidate rebooted with cloud-final, signed bootstrap and web all
active, exact release readiness passing, and no ordering cycle. Chromium rendered
a 7241-byte PDF as firstmeasure. This is a runtime smoke test, not a customer
report replay. The initial image 244892331 is superseded and must not be used.

Corrected image: 244899309,
firstmeasure-production-web-signed-v2-e35b884-20260910, 16.97 GB, SFO3.
Compatibility activated at approximately 20:14 UTC, followed by worker. Actual
FPM FastCGI probe confirms the configured tutorial root exists and is writable;
probe script was removed. Compatibility heartbeat remains the sole owner.

At about 20:16 UTC the pool template was changed to corrected image 244899309
and reviewed production-web-user-data.sh, preserving its VPC, c-8-intel plan,
SSH provider key, production tags and fixed target six. Conservative budget
using 26 non-web connections estimates 86 plus ten headroom within 97 usable.
Observed connections were 72 before replacement and 81 during full overlap.
All six new members independently passed signed receipt, release identity,
production readiness, two-process limit, heartbeat-disabled and boot-target checks:

| Droplet | Public IP | Private IP |
| --- | --- | --- |
| 599442759 | 64.23.240.81 | 10.124.0.16 |
| 599442763 | 137.184.88.252 | 10.124.0.17 |
| 599442764 | 137.184.187.218 | 10.124.0.18 |
| 599442766 | 146.190.150.235 | 10.124.0.19 |
| 599442768 | 143.198.137.97 | 10.124.0.5 |
| 599442769 | 143.198.104.224 | 10.124.0.6 |

Load balancer shows all twelve overlapping members Active / overall Healthy.
Wait for old-member retirement before restoring eight processes and autoscale6–8.
Temporary rehearsal 599439596 was stopped and destroyed after about ten minutes;
its temporary compatibility firewall rules have been removed. Retained snapshots
remain within the $6/month approved incremental storage budget.
