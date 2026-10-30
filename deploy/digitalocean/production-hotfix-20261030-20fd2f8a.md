# Production hotfix 20fd2f8a: the shared color picker opens above the signup wizard (FM-316), October 30, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-316 set to Testing in prod, verified on dev). Run from fm-agents-1.

It is production-live `3768e79a` (code `fe9640e6`, FM-315) plus one commit, `20fd2f8a` (branch `claude/fm-316-prodrun`): 3 files, +91/−1. It is the plan's `2b8d1fb1` cherry-picked onto the newer production-live, with those three files identical. The plan was written before FM-315 shipped, so its base (`3cde46be`) and rollback target (`70c22b02`) were out of date. This release used `3768e79a` and `fe9640e6`. Canonical `aff309c4` is not an ancestor, so the config library gate does not apply.

## Cause

Reported from signup: clicking a brand color in the wizard didn't open the picker.

The picker did open, but behind the wizard. The shared picker's panel sat at z-index 2147483590 and the onboarding overlay at 2147483600.

## Fix

Browser code only:
- `public/libraries/color-picker/firstmate-color-picker.js`: the panel's z-index is now 2147483647, plus one comment line. This applies to every color field using the shared picker and only changes how the panel stacks.
- `public/v1/tests/onboarding-color-picker-browser.test.mjs`: regression test (not served).
- `docs/architecture/color-picker.md`: a note on the stacking rule.

## Checks

- **Dev:** verified in `platform-20261030220758-9cd7e1e9` in the real signed-in wizard, at desktop and phone sizes, for both colors. The color step with a real uploaded logo was not checked (from the production plan).
- **Release commit:** `tests/onboarding-color-picker-browser.test.mjs` and `tests/color-picker-browser.test.mjs` pass 5/5, and `node --check` passes on the picker. `npm run check` ran in the build.
- **Build:** on the dev worker (npm ci, check, build, prune), archive sha256 `b63396f3bea077fd8aa0893470a18fed235611f187c58bdf591eaa7b19629196`, verified, and rechecked on compatibility and the worker after copying.

## Not changed

No Node code, PHP, editor, migration, configuration, environment or data change.

## Rollout

- Compatibility at 22:39:37Z, from `fe9640e6`; activation took 11 s.
- Worker at 22:40:23Z, after no running jobs: 8 slots, production, email on, heartbeat off.
- Signed channel published against `f99527af…` (new archive `b63396f3…`), so new pool nodes get this release.
- Six web nodes from 22:41:32 to 22:51:05 UTC, one at a time. Each was drained from the load balancer and ready in about 94 s, with the picker file served from the node matching the release.

Public readiness returned `20fd2f8a` 40 out of 40 times, 10 out of 10, then 60 out of 60 with all six instances answering. All eight hosts run `20fd2f8a`.

`https://app.1m8.ai/libraries/color-picker/firstmate-color-picker.js` contains `position:fixed;z-index:2147483647`, and 8 out of 8 uncached requests had no trace of the old value. The portal versions this file by content hash, so signup pages load the new file straight away.

After activation:
- **Compatibility:** 28 of 5,372 nginx 5xx (0.52%) from 22:40:30: 27 the existing `top_view_reroll_proxy.php` and 1 `project_resources.php`, against 0.59% in the half hour before. No Node 500s from 22:40:30 and no HTTP worker exits.
- **Web nodes:** 0.04–0.10% 5xx after activation, only `top_view_reroll_proxy.php`, each below the same node's 0.13–0.18% before; no HTTP worker exits.
- **Worker:** 84 jobs completed and none failed since activation; 10 queued and 1 running when checked, about 11 minutes after activation.

**Not checked:** the picker in a real wizard on production. This run created no production organization or data. The real confirmation is Jack opening the signup Branding step, clicking each color and seeing the picker show and the color change.

## Open, not caused by this release

- **The panel on short screens** opens over the swatches rather than beside them, because it is kept inside the window. It stays usable (from the production plan).
- **Pages other than the portal** that load the picker through `platform-api.js` use a fixed `?v=20261005-1`, so a browser may keep its cached copy for a while. Those pages only gain the stacking change, and signup does not depend on them.

## Disk

After this release, compatibility is at 92% (9.3 GB free), five web nodes at 91–92% (about 8.6 GB free) and `64.23.240.81` at 94% (6.2 GB free). Each release adds about 1.2 GB. Nothing was deleted; old `/opt/firstmeasure/releases` directories and `/var/tmp/firstmeasure-release-*` archives need a cleanup soon.

## Rollback

Every role keeps `fe9640e6`. Republish it (`f99527af…`) to the channel before rolling back a web node. Code only: nothing this release writes needs the new code to read.
