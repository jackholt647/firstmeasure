# Production release 306c2f3d: overlay any photo in Resources, customer references included (FM-344), November 5, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. It is production-live `0f659ba7` (release
`dbd819a0`, the FM-340–343 batch) plus the plan's production commit, with no cherry-pick needed:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-344 No option to overlay some images in the resources section | `306c2f3d` (`claude/fm-344-no-option-to-overlay-some-images-in-the--prod`) | `306c2f3d` | `measure-internal-20261105222645-8d5f790d` |

Its diff is identical to dev commit `cc992c15`.

## Change

- `public/measure/internal/editor_scripts/project_resources.js`: the toolbar Overlay button is enabled for any open
  still photo (it was disabled for every `reference: true` resource), and every photo tile gets the thumbnail overlay
  shortcut, so customer, resubmission and QA reference photos can be overlaid, not only the tech's uploads. A reference
  passes its URL to the overlay. Markup and notes stay off for references, as before.
- `public/measure/internal/editor_scripts/resource_3d_overlay.js`: alignment (position, size, rotation, opacity) is
  saved per reference name the same way as for uploads; the active-overlay record keeps the reference's URL so it
  comes back after a reload; a cross-site photo without CORS is shown from its own URL instead of failing.
- Regression test (not served): `dev/resource-reference-overlay.test.cjs`.
- Role: compatibility (editor files; web proxies `/measure/internal/` there). No Node, PHP, schema, environment,
  configuration, flag, dependency, nginx/PHP-FPM or data change. Existing uploads keep their alignment records.

## Checks before release

- `node --check` on both browser files. Build on the dev worker (`npm run check` included), 262 s. Archive sha256
  `e79b0de61e7cfe08d564aff5fb8f9a0801f05843b121f56b022cee035aa8639d`, verified on fm-agents, compatibility, the worker
  and each web node. The archive's two editor files are byte-identical to the commit, and every earlier release's
  asserts in `web_activate.py` (FM-335 to FM-343, cad6a00b) pass on the archive.

## Rollout (scripts: fm-agents /srv/agents/work/fm-344-prodrun-scripts)

- Rollback target before activation: `dbd819a06cf13ea74a04ef20e093423290d4bec2`, every host's `current` at 22:29 UTC;
  recorded on FM-344.
- Worker at 22:39:03 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `907732a0…` (dbd819a0's archive); all six web nodes downloaded
  `306c2f3d` / `e79b0de6` from it.
- Six web nodes one at a time behind the load balancer, 22:40:01–22:54:42 UTC (about 2.4 min each), each asset-checked
  as in dbd819a0's run plus the FM-344 strings.
- Compatibility last, at 22:55:01 UTC, at a calm minute (`legacy-action` 337/min, load 1.05). No Node 500s and no
  worker exits in the first 20 s.

## After activation

- All eight hosts point `current` at `306c2f3d` with the expected service active. Public readiness answered
  `306c2f3d`, `ok`, on 12 of 12 across all six instances after the web rollout, 32 of 32 at 22:56 and 10 of 10 at
  23:12.
- Served files: `https://app.1m8.ai/measure/internal/editor_scripts/` `project_resources.js`,
  `resource_3d_overlay.js` and `project_resources.css` are byte-identical to the release commit ("Any still photo can
  sit behind the model" 1, the old `!!current?.reference || !window.Resource3DOverlay` check 0, `const storedName=` 1).
- The plan's harness `dev/resource-reference-overlay.test.cjs`, run in headless Chromium with production's served
  files: 2 of 2 pass (shortcut on every customer photo, toolbar Overlay enabled, alignment kept per photo, restore after
  a fresh load, cross-site photo). Control with dbd819a0's files: 0 of 2.
- Web nodes from 22:56 (after the compatibility restart) to 23:06: 5xx 0.03–0.11 % against 0.21–0.26 % in the 30
  minutes before; compatibility 0.58 % against 0.83 %. All `top_view_reroll_proxy.php` (failing before this release).
- Worker, 22:39:03–23:12: 377 jobs completed (52 `imagery.process`, 240 `pdf.sync`, 60 `report.delivery`, 25
  `report.release`), 1 failed: a `pdf.sync` with "Shared PDF runtime failed: page.evaluate: Target page, context or
  browser has been closed", the same error as 2 failures at 15:00 and 2 at 16:00 today; this release changes no worker
  code. 312 `report.release` queued, none due (scheduled holds, as before).
- Compatibility, 22:55:01–23:12 (17 min): cluster watchdog **0 kills**, 0 Node 500s after the restart; load 1–4;
  `legacy-action` about 330–440/min.

## Rollback

`dbd819a06cf13ea74a04ef20e093423290d4bec2` is still installed on every host: activate it on the web nodes one at a
time, the worker and compatibility with `activate-release.sh` (`fm-344-prodrun-scripts/rollback/`), and republish the
channel with dbd819a0's archive against `e79b0de6…`. Code only; this release writes no data.
