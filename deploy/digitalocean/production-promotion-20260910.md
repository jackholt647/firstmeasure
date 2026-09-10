# September 10 production promotion — preparation in progress

Jack authorized production promotion of 1M8-152, 178, 179, 180 and 181.
The tested application release is `e35b8847eb42d390ba01d734f4b32bb5abe5611c`.
No production application activation has occurred in this preparation.

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
web hosts. No signed channel has been published. No existing service restarted.

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
Transfer to the controller and independent archive verification remain pending.

Prepared files `firstmeasure-release-bootstrap.service`,
`web-release-boot-dependency.conf` and `production-web-user-data.sh` prevent the
web service starting before cloud-final and verified release installation.
User-data queues service startup without waiting, avoiding an ordering deadlock.
It fetches the existing private production overlay and preserves web heartbeat
isolation. Shell syntax and systemd unit validation pass. These files have not
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

Temporary rehearsal compute and a retained boot image require a spending limit;
Jack was asked for up to $10 temporary compute and up to $6/month image storage.
Do not create charged resources without the answer. The candidate must be
excluded from the public load balancer, and its connection budget bounded.

Still required: image preparation, signed publication, real new-node rehearsal,
snapshot/template rollout, PHP tutorial-root permissions, application activation
and workflow verification. Preserve the previous runtime and retained tutorial
sources. Keep the five fixes Done in Dev until production verification; 1M8-173
is In Progress. Do not bypass the release-channel guard.
