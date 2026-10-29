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
