# Production release 31f87be5 — October 20, 2026

Jack authorized the activation. This was the first production release built from
the canonical branch. Staging is recorded in
[production-release-staging-20261020.md](production-release-staging-20261020.md).

## Activation (UTC)

Team leads paused technicians before the compatibility switch.

| Time | Role | Result |
| --- | --- | --- |
| 23:01:38 | Compatibility (`firstmeasure-legacy`) | Activated in 9 s. Readiness passed. Production environment unchanged: heartbeat owner `PLATFORM_HEARTBEAT_DISABLED=0`. |
| 23:02:24 | Worker | Waited for 0 running jobs, then activated in 4 s. Settings unchanged: 8 job workers, all job types, email on, heartbeat off. |
| ~23:03 | Signed web channel | Published from the compatibility controller, with previous `3f128a0d…` (`15ed3851`) compared before swapping. |
| — | Web nodes (all six) | Downloaded from the channel and installed. |
| 23:05–23:13 | Web nodes, one at a time | Each was drained (the NGINX health route returns 503; at least 3 load-balancer probe failures confirmed), then activated by `activate-release.sh` (which checks the signed channel), restored and verified. About 94 s per node. |

Each web node after activation:

- **Health.** Readiness on `31f87be5`.
- **Settings.** Pool 4, 8 workers, platform heartbeat off.
- **Served assets.** `portal/scripts/core.js` and `measurements/project.js` match the release.
- **Signup sandbox.** `/portal/signup-sandbox/` returns 404.

Tooling: `web_install.py` and `web_activate.py` in `/var/tmp/firstmeasure-release-31f87be5/` on each node. `web_activate.py` is adapted from `output/production-protection-20261012/activate.py`.

## Verification

- **Public readiness.** All sampled nodes answer `31f87be5`.
- **Signup sandbox.** The page, the dev bar on login and `/v1/signup-sandbox` all return 404 or are absent.
- **Errors.** No `level 50` application errors on the worker or the web nodes, apart from 3 "premature close" lines on one node.
- **Compatibility errors that are not new:**
  - It logs `UNIQUE constraint failed: referral_events…` from `/v1/private/referrals/trackAcquisitionEvent`. That started before the switch (from 22:54) and is not caused by this release.
  - `/v1/platform/acquisition/event` returns 503 and `top_view_reroll_proxy.php` returns 500 at the same rate on nodes still running the old code.
- **Worker.** It completes report releases, deliveries and PDF syncs with the new recipe. Nothing is stuck in the queue.

## Changeover issue: PDF syncs rejected for 10 minutes

A PDF sync carries the editor's `pdf_render_recipe_version`. The new worker
requires `2026-10-06.1`; production editors used `2026-08-16.1`.

- Between 23:03 and 23:13, technicians on old editor pages saved through web nodes that had not switched yet.
- Those nodes accepted the old version. The new worker then refused 33 jobs across 14 projects with "missing required payload fields".
- The refusal happens before any write, so no file was changed.
- Since every node switched, an old editor gets "reload the editor" when it saves instead.

At 23:21:

- **Delivery.** None of the 14 projects had been sent.
- **Resynced.** Nine have synced since, including the three "ready" projects.
- **Still waiting.** Five still had the sync marked waiting, and need a save after a refresh:
  - awaiting review: `b1fa8397`, `8758e6ad`;
  - in progress: `85ff3987`, `070d6e4a`, `1a7c3d2d`.
  QA approval waits for the sync, so these cannot be approved with an out-of-date PDF.

**Next time:** switch the web nodes before the worker, or keep accepting the previous recipe for one release, so mixed-version saves are not refused.

## Rollback

Every role keeps its previous release on disk:

- web: `15ed3851`
- compatibility and worker: `3d424a69`

To roll a role back, point `/opt/firstmeasure/current` at the previous release and restart its service. For the web nodes, first republish the `15ed3851` manifest from the channel history. No database rollback is needed; this release only adds:

- `platform_expanded_orgs_idx`;
- `platform_control_documents`;
- the artifact catalog table, created on first use.

## Not changed

- **Switches.** The platform, Full House and `firstmeasure.roof_model_viewer` stay off.
- **Autoscale image.** It still has the old release installer. A newly booted web node would refuse this release until the image is updated, which is a separate decision.
- **Older nodes.** `146.190.174.15` is gone from the pool.
