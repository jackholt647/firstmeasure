# Production release 217f1691: rate-limit claim next project per person (FM-387), November 11, 2026

Released from fm-agents-1 by the tracker's "FirstMeasure bug fixes" production run, under that workspace's standing
authorization for issues set to "Testing in prod" once verified on dev. The plan branch
`claude/fm-387-rate-limit-claim-next-project-per-person-prod` is one commit on release `99853722` (FM-386), so the
release is its tip as is:

| Commit | Change | Same diff as (verified on dev) |
| --- | --- | --- |
| `217f1691` | rate-limit claim next project per person | `a8aed84d`, in `platform-20261111042101-7806c6fc` |

## Change

- New `public/v1/firstmeasure/claim-rate-limit.ts`, checked first on every claim path: the legacy actions
  `claim_next_for_me` and `execute_hot_swap` (`internal/api.ts`, before the queue status read) and
  `POST /v1/firstmeasure/queue/claim-next` and `/queue/claim-next/compat` (`firstmeasure/api.ts`).
- Keyed on the verified caller (session or signed PHP staff member), never on `actor`/`actor_email` from the body.
  The in-process `/queue/claim-next/compat` call the legacy action makes runs as the system principal and is not
  counted twice.
- More than 10 attempts in any 5 s window blocks for 5 s; a block that starts within 60 s of the previous block's end
  lasts 60 s. A block has a fixed end; refused attempts are not counted and do not extend it. A refused attempt gets
  exactly the empty-queue answer (404 `queue_empty`, same body) with no queue or database work.
- Shared across processes and hosts: one row per person in the unlogged PostgreSQL table
  `firstmeasure_claim_rate_limits` (created at runtime on the first claim, under an advisory transaction lock), one
  atomic upsert per allowed attempt. Each process remembers the blocks it has seen, so refused attempts make no query.
  If the store fails, claims are allowed and it is not asked again for 10 s.
- One warning per block: `claim_rate_limit: {email, block_seconds, attempts, window_seconds, blocked_until}`.
- Also in the commit: `docs/architecture/request-security.md` ("Rate limits"), `tests/claim-rate-limit.test.ts`,
  `tests/claim-rate-limit-postgres.test.ts` (not served).
- Diff from `99853722`: 6 files, +464/−1. Node only. No PHP, browser file, environment, flag, nginx, dependency or
  config-library change; no data migration or repair. The only database change is the runtime
  `CREATE UNLOGGED TABLE IF NOT EXISTS` above.

## Checks before release

- At 04:29 UTC every host's `current` was `99853722` and readiness reported it 10/10. The rollback target `99853722`
  was recorded on FM-387 before anything was activated.
- The plan commit's diff equals the dev commit (`217f1691` = `a8aed84d`, line for line).
- Build on the dev worker (`npm run check` included) took 278 s, from a bundle `217f1691 ^99853722`. Archive sha256
  `d6c096103c865683df437f1a81ae89478dcbad6fd39618a81db074fac749fdee`, verified on fm-agents, compatibility, the
  worker and each web node.
- Fast path (`fastpath.sh decide`, FM-388): full procedure (10 Node files changed, all from this commit).
- `web_activate.py` keeps every earlier assert and adds FM-387: `dist/firstmeasure/claim-rate-limit.js` holds
  `firstmeasure_claim_rate_limits`, `CREATE UNLOGGED TABLE IF NOT EXISTS` and `export async function
  admitClaimAttempt(` once each; `admitClaimAttempt` appears 3 times in both `dist/firstmeasure/api.js` and
  `dist/internal/api.js`, and `legacyQueueEmptyResult()` twice in `dist/internal/api.js`. All 43 file asserts passed
  on the extracted archive and on the installed trees on compatibility and the worker; the FM-387 one fails on
  `99853722`'s tree (control).
- Baselines: compatibility 04:30–04:36 ran 640–760 `legacy-action`/min and 380–480 in-process
  `/queue/claim-next/compat`/min, with 0 watchdog kills and 0 pool timeouts since FM-386's activation. The worker's 72 h
  failed `pdf.sync`/`report.delivery` history matched FM-386's record.

## Rollout (scripts: fm-agents /srv/agents/work/fm-387-prodrun-scripts)

- Worker first, at 04:39:20 UTC (no running jobs; 8 slots, production, heartbeat off, outbound email on).
- The signed channel was published from compatibility against `b1015bb6…` (`99853722`'s archive) at 04:39, and the
  six web nodes went one at a time behind the load balancer, 04:40:13–04:53:13 UTC. Each passed every assert and
  returned behind the load balancer on `217f1691`.
- Compatibility went last (it serves the claim paths), at 04:53:30 UTC; the gate opened at once (279
  `legacy-action`/min, load 0.5). In the 20 s after: 0 Node 500s, 0 HTTP worker exits.

## Verification

- `current` is `217f16916ed388e8bc83b2ee8c77d4358822e99c` on all 8 hosts; readiness reports `217f1691` 10/10 (state
  ready) after the web rollout and after compatibility.
- The table exists and is unlogged: `relpersistence` `u` (it did not exist before compatibility activated; web and
  worker never created it, so claims are served on compatibility as planned). It held 2 rows at 04:55.
- Read-only proof on the worker with the deployed `dist` against the production database: the limiter rule and the
  deployed upsert, replayed for a synthetic identity inside one transaction that was rolled back, give the same
  answers: 10 allowed, the 11th starts a 5 s block (11 attempts), attempts inside it refused with its end fixed, 10
  allowed after it, the next 11th starts a 60 s block, refused inside it, allowed after it. No probe row was left.
  The refused legacy body is `{"ok":false,"success":false,"status_code":404,"error":"queue_empty",
  "message":"No eligible project was found in the queue.","details":null}`.
- The flood stopped by itself before compatibility activated: in-process `/queue/claim-next/compat` fell from
  ~470/min (04:30) to 0–25/min from 04:43, while compatibility still ran `99853722`. So no block fired in
  the watch window (0 `claim_rate_limit` warnings to 05:29), and the table held 5 rows (people claiming at normal
  speed), none blocked. The blocked accounts are to be listed on FM-387 once the loop comes back.
- Compatibility watch from 04:53:30 to 05:29 (35 min): 0 watchdog kills, 0 Node 500s, 0 pool timeouts, 0 limiter
  store warnings; `legacy-action` 146–290/min, load 0.4–1.5. Worker from 04:39:20 to 05:30: 120 jobs completed, 0
  failed; queued only `report.release` scheduled for later (0 due); no "Worker stopping", "browser has been closed" or
  pool acquisition failures. Readiness `217f1691` 10/10 at 05:30.
- 5xx from 04:55 (compatibility settled) against the 30 min before: web 0–0.18 % per node against 0.15–0.19 %;
  compatibility 0.5 % against 0.61 %, all `top_view_reroll_proxy.php` (long-standing).

## Rollback

`/srv/agents/work/fm-387-prodrun-scripts/rollback/` (the same scripts reversed to `99853722`; the channel republishes
`99853722`'s archive from `/var/tmp/firstmeasure-release-99853722/` on compatibility, against `d6c09610…`). Rolling
back removes the limit. The leftover unlogged table `firstmeasure_claim_rate_limits` is harmless and can stay.
