# Production hotfix tooling as of October 29, 2026

These are the scripts the PM session used for the Oct 22–29 production hotfixes. They're saved here so the release can resume when pushing moves to one central host.

## Pending release: `ef3f183f` (1M8-255 pitch in degrees, 1M8-256 summary card overlap)

- **Release commit:** `ef3f183f` on `codex/hotfix-20261029dd`. It is production `3d1fdb12` plus `c9cd1c4e` (`claude/pitch-degrees-20261029`) plus a manifest key bump. Tests pass and the type-check is clean.
- **Archive:** already built on the dev worker (137.184.44.82) at `/var/tmp/fm-prod-release-20261020/release-ef3f183f.tar.gz`, sha256 `55250d9b317d87b199a127572110d2925d3a3b1bc73365b6fc7826e3ad1eef67`.
- **Not started:** the Oct 29 rollout was stopped while the archive was still being copied to compatibility. Nothing was installed or activated, and the partial copy was removed. Every production role still runs `3d1fdb12`.
- **Editor half:** already on dev's `measure-internal` lane (`a238d8c9`).

## Running `release-dd.sh`

It was written for Git Bash on Jack's PC:
- `$R` is a local scratch folder holding the `p30_*.py` helpers (copied here).
- SSH goes `-J dev-sync-droplet` with `~/.ssh/id_ed25519_firstmeasure_cluster_v2`.
- `scp -3` relays the 360 MB archive through the machine running it.

From the central host, point `$R` at this folder and the key at that host's cluster key. Better still, copy the archive straight from the dev worker to the production hosts.

## The sequence

1. Install the archive on compatibility (144.126.222.110) and the worker (146.190.169.59).
2. Activate compatibility (`activate-release.sh <sha> firstmeasure-legacy.service`), then check 20 s of the journal for 500s.
3. Run the worker activation (`p30_worker_activate.py`).
4. Publish the signed web channel against the previous archive's sha256 (`4e370cd7…`, for `3d1fdb12`).
5. Install and activate each of the six web nodes one at a time (`p30_web_install.py`, `p30_web_activate.py`).
6. Expect public readiness to return the new release 10 out of 10 times.

## Rollback

Every role keeps `3d1fdb12`. Republish it (`4e370cd7…`) to the channel before rolling back a web node.

## Records

Each release has a `deploy/digitalocean/production-hotfix-*.md` record on `production-live`.

## Fast path: releases that don't change Node (FM-388, November 11)

The scripts above are the October recipe. Runs since November take theirs from the previous run's folder
(`/srv/agents/work/fm-<issue>-prodrun-scripts/` on fm-agents-1: `release.sh`, `web_rollout.sh`,
`web_activate.py`, `worker_activate.py`, `compat_gate.sh`), which restart Node everywhere and wait at the
compatibility gate. A release whose Node side is identical to the running one skips all of that:
`fastpath/` switches `current` and reloads PHP-FPM on each host. The procedure, and why comparing only the
built server is not enough, is in DEPLOYMENT.md on canonical, "Production run fast path (no Node change)".

From the run's folder on fm-agents-1 (after `release.sh fetch`):

    F=<this checkout>/deploy/digitalocean/release-tooling-20261029/fastpath
    export NEW=<full release id> OLD=<full rollback target id>
    bash $F/fastpath.sh decide        # exit 0: fast path; exit 3: full procedure (lists the Node files)
    bash release.sh install; bash release.sh publish   # the run's own copies, as for a full release
    bash $F/fastpath.sh web-install   # web_install.py on the six nodes; never web_rollout.sh (restarts Node)
    bash $F/fastpath.sh tools         # copies the two host scripts to /root/fm-fastpath on all 8 hosts
    bash $F/fastpath.sh check         # every host must say "fast path possible"; else full procedure
    bash $F/fastpath.sh switch        # compat, web x6, worker; prints ACTIVATED=HH:MM:SS
    bash $F/fastpath.sh verify        # current on 8 hosts, readiness 10/10, served sha256 over HTTPS
    ACTIVATED=HH:MM:SS bash $F/fastpath.sh watch   # after 10+ minutes: 5xx vs the 30 min before
    bash $F/fastpath.sh rollback      # same switch back; then republish the channel with the old archive

`release-node-fingerprint.py` and `switch-release-files.py` here are copies; the driver uses canonical's
`deploy/digitalocean/` (`/srv/agents/work/firstmeasure`) when it has them. `served.py` checks the changed
static files over HTTPS; `rates.py` is the runs' 5xx counter (optional day argument after midnight).
Readiness keeps reporting the release Node started in after a fast path: prove the switch with `current`
and the served files, not with `release_id`.
