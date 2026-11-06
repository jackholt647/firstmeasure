# Production release 440abec4: remove the full-house review checkboxes from QA (FM-345), November 5, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan was written on production-live
`0f659ba7` (release `dbd819a0`); FM-344 (`306c2f3d`) was released after it, so the plan's two commits were
cherry-picked onto `306c2f3d`. Both picks were clean and each diff is identical to its plan commit:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-345 Remove review checkboxes | `25bbc76e`, `ab93a6df` (`claude/fm-345-remove-review-checkboxes-prod`) | `c71a3307`, `440abec4` | `platform-20261105223107-e365c836` (canonical `a75b3ae9`), `measure-internal-20261105223145-5e0fb893` (lane `d18f21ec`) |

production-live records it as a merge of `371fb872` (FM-344's record) into `440abec4`, then this record; the tree is
`440abec4` plus the two records.

## Change

- Node `public/v1/firstmeasure/full_house_workflow.ts`, `api.ts`: QA approval (both paths) and manager approval no
  longer require the seven full-house checks (`assertFullHouseReview` and `FULL_HOUSE_REVIEW_FIELDS` are gone).
  Approval still stamps `qa_full_house_review` / `manager_full_house_review` with the approved PDF revision, reviewer
  and time, and delivery still sends only a completed project whose stamp names the current PDF revision; it no longer
  reads check fields, so stamps written before this release still deliver. Qualification, PDF checksum checks and the
  bulk-approve exclusion are unchanged. A `full_house_review` field from an old browser is ignored.
- Editor (compatibility) `public/measure/internal/portal_scripts/qa.js`, `editor_scripts/report.js`: the "Full-house
  review" fieldset in portal QA and on the embedded QA PDF page, its approve gating and its postMessage are removed.
  The "Full house" type label stays.
- Tests and docs (not served): `dev/full-house-review-ui.browser.cjs`, `dev/full-house-embedded-qa.browser.cjs`, three
  v1 tests, `docs/full-house-workflow.md`.
- Roles: worker, web, compatibility. No database, environment, configuration, flag, dependency, nginx/PHP-FPM or data
  change.

## Checks before release

- Build on the dev worker (`npm run check` included), 282 s. Archive sha256
  `5e166ee4b8a509b8bd55a647f66cf2cb2163df2c701599f0270a2ebb4421214a`, verified on fm-agents, compatibility, the worker
  and each web node. Every assert in `web_activate.py` (FM-335 to FM-344, cad6a00b, plus the new FM-345 one: no
  `assertFullHouseReview` in `dist/firstmeasure/api.js`, no `full_house_review_required` in
  `dist/firstmeasure/full_house_workflow.js`, no checklist ids in `qa.js`/`report.js`) passes on the archive.
- Control: the plan's two browser harnesses fail against production's served `306c2f3d` editor files.

## Rollout (scripts: fm-agents /srv/agents/work/fm-345-prodrun-scripts)

- Rollback target before activation: `306c2f3d59961d6db6d285f57a9c87253c6d7583`, every host's `current` at 23:14 UTC;
  recorded on FM-345.
- Worker at 23:23:53 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `e79b0de6…` (306c2f3d's archive); all six web nodes downloaded
  `440abec4` / `5e166ee4` from it.
- Six web nodes one at a time behind the load balancer, 23:24:53–23:38:39 UTC (about 2.3 min each), each asset-checked
  plus the FM-345 assert.
- Compatibility last (it serves the new editor files, which need the new Node), at 23:46:02 UTC at a calm minute
  (`legacy-action` 392/min, load 1.68). No Node 500s and no worker exits in the first 20 s.

## After activation

- All eight hosts point `current` at `440abec4` with the expected service active. Public readiness answered
  `440abec4`, `ok`, on 32 of 32 at 23:47 and 10 of 10 at 00:06.
- Served files: `https://app.1m8.ai/measure/internal/portal_scripts/qa.js` and `editor_scripts/report.js` are
  byte-identical to the release commit; `qaFullHouseReview` and `qaPdfFullHouseReview` occur 0 times.
- The plan's harnesses `dev/full-house-review-ui.browser.cjs` and `dev/full-house-embedded-qa.browser.cjs`, run in
  headless Chromium with production's served files: 2 of 2 pass (no checklist in portal or embedded QA, approval and
  the manager decision work without it, the "Full house" label stays, roof page unchanged). Control with 306c2f3d's
  files: 0 of 2.
- Web nodes from 23:47 (after the compatibility restart) to 00:07: 5xx 0.01–0.11 % (about 6,600–7,100 requests each)
  against 0.12–0.17 % in the 30 minutes before; compatibility 0.46 % against 0.62 %. All but two are
  `top_view_reroll_proxy.php` (failing before this release); one `/measure/internal/` each on a web node and compat.
- Worker, 23:23:52–00:06: 479 jobs completed (57 `imagery.process`, 276 `pdf.sync`, 65 `report.delivery`, 82
  `report.release`), 0 failed. 283 `report.release` queued, none due (scheduled holds, as before).
- Compatibility, 23:46:25–00:06 (20 min): cluster watchdog **0 kills**, 0 Node 500s; load 1–6; `legacy-action` about
  350–600/min.

## Rollback

`306c2f3d59961d6db6d285f57a9c87253c6d7583` is still installed on every host: activate it on compatibility first, then
the web nodes one at a time and the worker with `activate-release.sh` (`fm-345-prodrun-scripts/rollback/`), and
republish the channel with 306c2f3d's archive against `5e166ee4…`. Code only; this release writes no data. Stamps
written by this release carry no check fields, so after a rollback a full-house project approved meanwhile but not yet
delivered would need re-approval with the checklist before the old code delivers it; nothing is lost.
