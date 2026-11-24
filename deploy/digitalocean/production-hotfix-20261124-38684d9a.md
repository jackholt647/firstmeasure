# Production release 38684d9a (FM-635 rejection email copy), November 24, 2026

Production runs `38684d9a93da6e9ff72ee759d3a2f358b6393776` on all 8 hosts (compatibility, worker, 6 web nodes).
Rollback target: `7c913b3982bf6bc644028c572147c24932a4ddfc` (FM-634), recorded on FM-635 before activation.

## What changed

Branch `claude/fm-635-rejection-email-copy-prod` = release 7c913b39 plus one commit, released as is:

- `38684d9a` (cherry-pick of dev `7d358ca84`, platform-20261124214303-8aa902c0): the no-coverage rejection copy in
  `buildRejectionMessageParagraphs` (`firstmeasure/api.ts`) drops "We currently cover 95% of all buildings in the
  United States and we are actively working on increasing our area to cover more of the remaining buildings." That
  copy is the rejection email body (text and HTML) and the stored `customer_rejection_message` for new rejections.
  Title, address and credit line are unchanged. The project rejection banner (`libraries/apps/projects/viewer.js`)
  drops the same sentence; apps manifest viewer bundle version `20261124-fm635-coverage-copy`. Regression test
  `tests/exterior-rejection.test.ts`.

The archive (sha256 `61d2be2c7fba8aae24cb1b2704644085e5972878b251f27603140a327bdeba86`) differs from 7c913b39's only in
those files plus their compiled `dist/` output and `release.env`. No data, environment, flag, NGINX or config-library
change. Rejection messages already stored keep their old text. Not in this release: the staff reject dialog preview in
the measure editor (`measure/internal/portal_scripts/projects.js`), which ships on another lane.

## Rollout (full path: Node code changes)

Scripts: `/srv/agents/work/fm-635-prodrun-scripts` on fm-agents-1 (FM-634's set, base 7c913b39; rollback set in `rollback/`).

- Built on the dev worker (`build.sh`, 294 s). Plan test `tests/exterior-rejection.test.ts` from the extracted archive
  (tsx; the compiled copy reads the source `.ts`): 21/21 pass. Every web_activate.py file assert (150) passed against
  the extracted tree first. `release.sh install` on compatibility and worker.
- Worker activated 22:00:19 UTC (no running jobs). Web channel published with previous sha256 `decc41ef…` (7c913b39).
- Web nodes one at a time 22:01–22:14 UTC, each drained, activated and checked before the next (file asserts for every
  release through FM-635; FM-635's: `cover 95% of all` count 0 and the new paragraph count 1 in
  `dist/firstmeasure/api.js`; served `projects/viewer.js` equals the file, no "95% of all", no `m_93f718cb51bafd`;
  manifest viewer version). Repins: `projects/viewer.js` sha256 (FM-532 round 3, FM-625) and manifest sha256 (FM-457),
  FM-625 manifest needle counts 2/1 to 1/0 (its viewer version was replaced).
- Compatibility through the gate: waited 16 min (437–761 legacy-action/min), opened 22:30:17; rolling replace,
  0 500s, 0 exits in the first 20 s.

## Checks

- `readlink -f /opt/firstmeasure/current` = 38684d9a on all 8 hosts; `/v1/health/ready` 10/10 ok on 38684d9a.
- Installed release on all 8 hosts: `cover 95% of all` count 0 and "coverage for this address. We've logged your
  interest" count 1 in `dist/firstmeasure/api.js`.
- `https://app.1m8.ai/libraries/apps/projects/viewer.js` (3 requests): no "95% of all", sha256 `821cfb3b…`; the
  served manifest names `20261124-fm635-coverage-copy`.
- 5xx: web nodes 0.04–0.07 % from 22:14:35 vs 0.04–0.07 % in the 30 min before; compatibility 0.76 % from 22:31:28
  vs 0.81 % before. Every 5xx but three `editor.php`/`/measure/internal/` is the long-standing
  `top_view_reroll_proxy.php`. Web Node error lines are client "premature close" at the pre-release rate.
- Worker since activation: 398 jobs completed, 0 failed, 0 worker journal errors; queued jobs are future
  `report.release` timers (0 due).
- Compatibility watch 22:31–22:51 UTC: 10 polls, 0 watchdog kills, 0 OOM, 0 Node 500s, 0 pool timeouts,
  same MainPID throughout, 2.2–2.5 GB available, 438–1,026 legacy-action/min.
- No real order was rejected to test the email.
