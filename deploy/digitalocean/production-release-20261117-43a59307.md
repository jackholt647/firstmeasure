# Production release 43a59307: FM-523 (Trainee Exteriors QA), November 17, 2026

Released from fm-agents-1 by the FM-523 production run, under the "FirstMeasure bug fixes" workspace's standing
authorization for issues set to "Testing in prod" once verified on dev.

The release is the plan commit as is: `43a59307` on `claude/fm-523-trainee-exterior-qa-prod`, whose parent `4c9e9eb3`
is a direct child of production-live `faa0df05` (record of release `4fb31733`, FM-402, production at the start of the
run). Its two commits' patches equal canonical `2ad92d80` (server + test) and editor commit `27bce1d7` (shipped as
`0ad07a70` on the lane tip) line for line; verified on dev in `platform-20261117034434-5cb334f4` and
`measure-internal-20261117034521-ae791acc`.

## Change

- New per-user field `is_qa_trainee_exteriors` on the internal user record (`internal/storage.ts`, default false,
  existing value kept). `save_user` (`internal/api.ts`, `/v1/internal/legacy-action`) changes it only when the body
  carries it, so an older editor can't clear it.
- At QA approval (`firstmeasure/api.ts`): when the QA user has the flag (and not the existing Trainee QA flag) and the
  project is a customer full exterior (`isCustomerFullHouse`, the `exteriors_` check), the project requires manager
  review with reason `qa_trainee_exteriors` and `qa_reviewer_was_trainee: true`. VIP, Trainee QA and every other
  project behave as before.
- Users editor (compat, `public/measure/internal/index.php` + `portal_scripts/users.js`): a switch under QA Review Level,
  "Trainee Exteriors QA — send every approved full exterior project to manager review", loaded and saved.
- Test (not served): `public/v1/tests/firstmeasure-qa-trainee-manager-review.test.ts`.
- No database migration, environment, flag, nginx, dependency or config-library change, and no data repair. Every user
  has the flag off until a manager turns it on.

## Checks before release

- At 03:52 UTC `current` was `4fb31733` on all 8 hosts, readiness reported it, root disks had 74 GB+ free, and no other
  run was live. Rollback target `4fb31733` was recorded on FM-523 before anything was built or activated.
- Built `43a59307` on the dev worker. Archive sha256
  `81239095038f3d6f66ae506d4e9c5cf10c166c453cb4a6f9d6d0c2e7b22a3270`. The archive's five changed source files are
  byte-identical to the commit. Node code changed, so this is the full procedure (no fast path).
- `web_activate.py` keeps every earlier assert, and adds FM-523's: `qa_trainee_exteriors` and
  `isCustomerFullHouse(manifest)` in `dist/firstmeasure/api.js`, `is_qa_trainee_exteriors` in `dist/internal/storage.js`
  and `dist/internal/api.js`, one `id="uQaTraineeExteriors"` in `index.php`, and 3 `uQaTraineeExteriors` plus 2
  `is_qa_trainee_exteriors` in `users.js`. All 83 file asserts pass on the archive.
- Read-only probe on the worker (`probe523.mjs`, read-only Postgres session, counts only): `listInternalUsers` on
  `4fb31733` gave 282 users with the field absent. On the installed, inactive `43a59307` it gave 282 users, all
  `is_qa_trainee_exteriors: false`.

## Rollout (scripts: fm-agents /srv/agents/work/fm-523-prodrun-scripts)

- Compatibility and the worker were installed by 04:00. The worker was activated at 04:01:21 UTC, with no running jobs.
- Channel published against `4fb31733`'s archive (`a87e8de8…`).
- Web nodes one at a time, 04:02:27–04:16:31 UTC. Each passed every assert and came back behind the load balancer.
- Compatibility: the gate opened at its second check (04:16 at 861/min, then 351/min at 04:17:47). Rolling replace at
  04:17:50; both slots were replaced by 04:18:42, with 0 Node 500s and 0 exits in the 20 s after. Two watchdog kills
  at 04:17:20 and 04:17:40 hit the old release's workers before activation (3 h before: 2), so they are the baseline.

## Verification

- `current` is `43a59307` on all 8 hosts. Readiness reports `43a59307` 10/10. Compat's HTTP workers run from
  `43a59307` (the primary keeps its start-up release by design).
- `https://app.1m8.ai/measure/internal/portal_scripts/users.js`: sha256 `8546e1097f45…` 12/12, equal to
  `git show 43a59307:…`, with 3 `uQaTraineeExteriors`. Compat's installed `index.php` has the switch once.
- The same probe on the live worker release: 282 users, all `is_qa_trainee_exteriors: false`. There was no production
  test approval, because nobody has the flag on.
- 5xx from 04:19:30 UTC (after compatibility settled), excluding health probes:
  - web nodes: 0.00–0.03 % (0–2 of ~7k each), against 0.06–0.09 % in the 30 minutes before; all
    `/measure/internal/top_view_reroll_proxy.php`.
  - compatibility: 0.34 % (5 of 1,480), against 0.65 % before; all `top_view_reroll_proxy.php`.
- Compatibility, 04:17:47–04:38: 0 watchdog kills, 0 Node 500s, 0 pool timeouts, one MainPID throughout (legacy-action
  633–837/min, load under 2).
- Worker, 04:01:21–04:38: 122 jobs completed (53 `pdf.sync`, 54 `report.release`, 12 `report.delivery`, 3
  `imagery.process`), 0 failed, and no "Worker stopping", browser-closed, pool-timeout or heartbeat errors. Queued
  `report.release` jobs are scheduled and not yet due.

## Rollback

`/srv/agents/work/fm-523-prodrun-scripts/rollback/`: `release.sh worker`, `publish` (republishes `4fb31733`'s archive),
`web_rollout.sh` (FM-402's forward asserts with base `43a59307`), `release.sh compat`. Rolling back is safe: the old code
ignores a stored `is_qa_trainee_exteriors`, and projects already sent to manager review stay there for a manager to sign
off as usual.
