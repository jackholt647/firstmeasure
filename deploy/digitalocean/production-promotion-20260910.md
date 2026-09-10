# September 10 production promotion — deployed

Jack authorized production promotion of 1M8-152, 178, 179, 180 and 181.
The tested application release is `e35b8847eb42d390ba01d734f4b32bb5abe5611c`.
Compatibility, worker and all six new web members are active on this release.
All six web nodes have eight verified HTTP child processes. Linear 1M8-152,
178, 179, 180, 181 and replacement-node issue 173 are Testing in Prod.
Autoscale is 6–7 (CPU50%, RAM60%, five-minute cooldown) to preserve database
planning headroom. The historical checkpoints below describe earlier states.

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

## Capacity restoration and final verification

The old fleet retired after the provider's fixed-size cooldown; fresh inventory
contains only the six 5994427xx members above. Database activity dropped to 38.
The controller's future-node overlay was restored to eight web processes with
its NGINX read ACL preserved. Current nodes are being restored sequentially,
allowing graceful drain and confirming readiness after each restart.

The safe autoscale range is now **6–7**, CPU 50%, RAM 60%, cooldown five minutes.
This deliberately differs from the old maximum eight: a fresh client audit found
four worker connections, up to nine compatibility/audit connections, and sixteen
provider/hidden activity rows. Budgeting 29 non-web slots conservatively gives
7×8+29=85 with 12 of 97 usable slots left; the ten-slot reserve passes. Eight
nodes would not meet that reserve under this estimate. Review actual database
capacity/dedicated clients before raising the maximum. Normal six-node process
capacity remains eight per node. No database resize or credential change occurred.

Production checks so far: all three public changed JavaScript assets match the
approved source; unauthenticated QA CSV action returns 401; actual FPM confirms
the shared tutorial root exists and is writable; worker has eight job slots,
all job types, production PDF URL and disabled heartbeat. After activation the
worker completed 50 normal PDF syncs in the observed window, with zero error-level
entries. These are observations of normal jobs, not agent-created orders/sends.
Customer-specific geometry/progress repair and reporting-team acceptance remain
subject to the limitations in followups-20260910.md.

Cleanup verified: temporary droplet 599439596 destroyed, both temporary firewall
rules removed, and superseded image 244892331 deleted. Retained image 244899309
uses 16.97 GB (~$1.02/month). Temporary compute overlap/rehearsal is estimated
below $1, subject to the provider's actual billing, within the approved $10.

## Final result (20:35 UTC)

All six web nodes completed sequential restoration and independently passed
signed-channel/receipt validation, production/legacy readiness and an actual
count of eight HTTP child processes. Compatibility and worker match e35b884.
Public health returns that release. Final database sample: 74 activity rows,
max_connections100 / reserved3. No database migration or DNS change was made.
Linear 1M8-152,178,179,180,181 and173 are Testing in Prod with evidence and limits.

The last web restart finished at 20:33:50 UTC. NGINX shows uninterrupted successful
provider health probes from 20:33:58 onward after the intentional drain. The
provider dashboard subsequently confirmed **Healthy**, with all six new members
**Active**, at approximately 20:36 UTC.

Rollback: retained previous source/runtime remains in the new image/hosts and
on fixed roles; old image 244502867 is retained. Web rollback requires packaging
and publishing the reviewed previous runtime through the signed channel before
activation. Do not bypass the guard or republish an unreviewed workspace.
Compatibility/worker prior targets remain 0406b37 and 61b0626 respectively.
Code rollback does not undo tutorial recovery or other live customer writes.
Retained tutorial roots and private referral backups remain intact.
