# Production release 85f64c33: a qualified reviewer's regeneration of a completed full-house PDF approves it for delivery (FM-357), November 10, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan commit was already a child of
release `db67d858` (FM-355), so it was released as is, with no cherry-pick:

| Issue | Plan commit (branch) | In this release | Verified on dev in |
| --- | --- | --- | --- |
| FM-357 release email failure | `85f64c33` (= canonical `1fead012`) on `claude/fm-357-release-email-failure-prod` | `85f64c33` | `platform-20261110005012-6ce262dc` |

## Change

- `public/v1/firstmeasure/full_house_workflow.ts`: new `fullHouseRegenerationReview(manifest, principal, revision, at)`.
  On a **completed** customer full-house project, a PDF regeneration by a manager or admin, or by QA qualified for
  full-house QA (`fullHouseEligible(email, 'qa')`), returns `{ revision, reviewed_by, reviewed_at, source:
  "pdf_regeneration" }`; anyone else, any other status, or a system call gets `null`.
- `public/v1/firstmeasure/api.ts`: the PDF sync enqueue writes that stamp to the manifest as
  `full_house_regeneration_review` (the person comes from the verified request principal), and `sendProjectEmail`'s
  full-house gate accepts it beside `qa_full_house_review` and `manager_full_house_review`. Before, regenerating a
  completed report after QA made a revision nobody had approved, so the release email and every Re-send were refused
  with `full_house_qa_required`.
- Not served: `tests/full-house-workflow.test.ts`, `tests/full-house-delivery.test.ts`.
- Node only (web, worker, compatibility). No PHP, editor, environment, database, migration, flag, nginx, dependency or
  data change; no data repair.

## Checks before release

- The +/- lines of `85f64c33` equal canonical `1fead012` line for line.
- Build on the dev worker (`npm run check` included), 270 s. Archive sha256
  `857d4daa9b7aaae92bb8e38f47acbfee0aaf7b5ab45ff5ddb1753df3e8f860bc`, verified on fm-agents, compatibility, the
  worker and each web node. In the archive, `dist/firstmeasure/full_house_workflow.js` exports
  `fullHouseRegenerationReview` once and `dist/firstmeasure/api.js` holds `full_house_regeneration_review` twice.
- New assert in `web_activate.py` (FM-357), beside FM-324, FM-335 to FM-355 and cad6a00b: those counts on each node.
- Baseline: web 5xx 0.07–0.09 % over the 30 min before 01:03 UTC; compatibility 0.89 % over the 30 min before
  01:07, 6 cluster watchdog kills in the 3 h before. Worker: 22 failed `pdf.sync`/`report.delivery` jobs in the 72 h
  before (15 "customer report email failed to send", 7 "Shared PDF runtime failed"), about 0.3 an hour.

## Rollout (scripts: fm-agents /srv/agents/work/fm-357-prodrun-scripts)

- Rollback target before activation: `db67d858d4a482b555955b03636eab6f2d549726`, every host's `current` at 00:57 UTC;
  recorded on FM-357.
- Worker at 01:03:58 UTC (no job running): 8 slots, production, heartbeat off, outbound email on.
- Signed channel published from compatibility against `c55fef9a…` (db67d858's archive).
- Six web nodes one at a time behind the load balancer, 01:04:55–01:17:48 UTC; every node passed every assert,
  including FM-357's.
- Compatibility last at 01:37:49 UTC through the gate (`legacy-action` < 420/min and load < 10), which waited 20 min
  at 420–600/min and opened at 404/min, load 1.0. 0 Node 500s and 0 HTTP worker exits in the 20 s after.

## After activation

- All eight hosts point `current` at `85f64c33` and serve the FM-357 code in `dist` (1 export, 2 stamp references).
  Public readiness answered `85f64c33`, `ok`, on 10 of 10 after the web rollout and again after compatibility.
- Read-only in-process probe on the worker (the deployed `dist`, the worker's environment, a synthetic completed
  `exteriors_` manifest, nothing written; `probe.mjs`, `probe_qa.mjs`): admins and managers get a
  `pdf_regeneration` stamp; technicians, staff with no level, an admin on a project that isn't completed and a system
  call get none. Of 43 QA-level staff, the 2 qualified for full-house QA are stamped and the 41 others are not.
- 01:39–02:01 UTC (after compatibility settled): web 5xx 0.02–0.03 % on three sampled nodes (the 30 min before, which
  held the web rollout: 0.13–0.16 %); compatibility 0.37 % against 0.81 %. Every 5xx in that window was the existing
  `top_view_reroll_proxy.php`.
- Compatibility from 01:37:49 to 01:59: cluster watchdog **0 kills**, 0 Node 500s, 0 pool timeouts at
  348–729 `legacy-action`/min.
- Worker, 01:03:58–02:01: 525 jobs completed (47 `imagery.process`, 278 `pdf.sync`, 81 `report.delivery`,
  119 `report.release`), none failed and none retried. 379 `report.release` queued, none due (scheduled holds).

## Not covered

- No test email was sent. The stuck project `exteriors_e734a21ea05e7fc3ec412f6aa4ecbd7c` (9241 Fairway Dr, Orland
  Park) is released by an ordinary user action: an admin, a manager or full-house-qualified QA opens it in the
  editor, regenerates the PDF once, lets it sync, then clicks **Re-send PDF Email**. The proof is
  `delivery.email_state.report_email.sent_ok` becoming true on that project.
- A regeneration by anyone else still leaves the new revision unapproved, and delivery refuses it as before.

## Rollback

`db67d858d4a482b555955b03636eab6f2d549726` is still installed on every host: activate it on compatibility, the web
nodes one at a time and the worker (`fm-357-prodrun-scripts/rollback/`: `release.sh compat|worker|publish`,
`web_rollout.sh`), and republish the channel with db67d858's archive against `857d4daa…`. Code only: a
`full_house_regeneration_review` already written is ignored by the old code, so a report regenerated after QA is
again refused until QA approves it.
