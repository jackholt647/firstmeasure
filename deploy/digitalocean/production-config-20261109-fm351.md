# Production configuration 2026-11-09: the TikTok Events API token (FM-351)

This was a configuration change only. Production stays on release `93c7a2fd1dfa3a1849dfcab8d893363f005629be` (FM-353),
which already holds FM-351's code (`dist/platform/tiktok-events.js`, released 11-06 as `5eb8b1db`). Nothing was
built or activated.

**Authorization:** Jack in FM-351 at 2026-11-09 19:58 UTC: "Go ahead and do whatever Ben asked on this one." Ben's
request (11-06 23:43 and 11-07 00:52) was to use the token he had already supplied, for now. He will rotate it
himself.

The run went out from fm-agents-1 as the tracker's "FirstMeasure bug fixes" production run. The plan is the
"Production plan: set the TikTok Events token on production" comment on FM-351. Its branch
`claude/fm-351-set-up-tiktok-events-api-prod` (`dec875bc`, a cherry-pick of canonical `b0539ace`) changes only
`DEPLOYMENT.md`: it says where the variable goes. This record sits on top of that branch.

## Change

- One line, `TIKTOK_EVENTS_ACCESS_TOKEN=<40 characters>`, was appended to `/etc/firstmeasure/production-cutover.env` on:
  - **compatibility** (`144.126.222.110`). This is also the overlay that new web pool nodes fetch at boot
    (`__firstmeasure_bootstrap_20260908/production.env`), so new nodes get the token without an image or user-data
    change;
  - **each of the six web nodes**.
- The value was piped host to host from dev web's `/etc/firstmeasure/development-runtime.env`. It never appeared in
  a command line, a log or this record.
- On each host, `env_set.sh`:
  - refuses if a `TIKTOK_` line is already there;
  - requires exactly one plain `KEY=value` line on stdin;
  - keeps `production-cutover.env.bak-20261109-fm351` (same mode and owner);
  - appends the line with `>>`, so the mode and owner stay as they were (compatibility 640, web 600, root);
  - parses the result with the web bootstrap's shlex rules.
- **`TIKTOK_EVENTS_TEST_EVENT_CODE` is on no production host**, in neither the files nor the processes.
- **Worker:** no change. It neither fulfils Stripe checkouts nor drains the TikTok outbox.
- No code, PHP, nginx (apart from the temporary per-node withdrawal), database, flag or config library change. No
  backfill: purchases recorded earlier as `skipped / missing_access_token` stay unsent.

## Rollout (UTC; scripts in fm-agents `/srv/agents/work/fm-351-config-prodrun-scripts`)

- **Before (20:0x).** All 8 hosts had `current` = `93c7a2fd`, and none had a `TIKTOK_*` variable in any file or
  process. Readiness was ok 10/10. The rollback target was recorded on FM-351, and the production lock was announced
  in the agent channel. The TikTok outbox and `tiktok_events_log` were both empty.
- **Compatibility file, 20:07:20.** Written; no restart yet. From a web node, the bootstrap overlay that new nodes
  fetch was read through compatibility's nginx. It parses with the user data's rules (23 keys) and carries the token
  and no test code.
- **Web nodes, 20:07:37–20:21:25, one at a time (`web_rollout.sh`, `web_restart.py`).** For each node:
  - write its file;
  - withdraw it with the NGINX health route (4–5 load-balancer probe failures seen);
  - `systemctl restart firstmeasure-web`, with the same release;
  - wait for Node's own readiness on `127.0.0.1:3101`, restore NGINX, and check readiness through NGINX;
  - check the new main process's environment: production, heartbeat off, token present, test code absent;
  - continue only after the load balancer served that node again.

  Order: `64.23.240.81`, `137.184.88.252`, `137.184.187.218`, `146.190.150.235`, `143.198.137.97`,
  `143.198.104.224`. Each took about 94 s.
- **Compatibility restart, 20:21:40.** It went through the calm-minute gate (`legacy-action` 410/min, load 1.36) and
  restarted `firstmeasure-legacy` only. `verify-node.sh` passed, the process environment has the token and no test
  code, and the first 20 s had 0 500s and 0 worker exits.

## Checks

- `https://app.1m8.ai/v1/health/ready` returned ok 10/10 on `93c7a2fd`.
- Stripe webhook negative-signature probe: `/measure/internal/server.php` answered 400 "Invalid signature". Real
  POSTs to `server.php` (the Stripe webhook endpoint) during the run were all 200: 8 on the web nodes, which pass
  them to compatibility, and the same 8 there. The only 400 was the probe itself.
- **Live purchases reached TikTok.** Two real paid checkouts arrived during the rollout, at 20:14:36 on
  `137.184.187.218` and at 20:15:53 on `64.23.240.81`, both already restarted. Each was queued and delivered on its
  first attempt: HTTP 200, TikTok `code: 0`, `test: false`. `tiktok_events_log` shows both as `delivered`, and the
  outbox is empty.
- There were no `tiktok_events_failed`, `tiktok_events_enqueue_failed`, `tiktok_events_delivery_error` or
  `tiktok_events_retry` lines on any web node or on compatibility.
- **Web 5xx.**
  - Baseline: about 200–235 per node over 19:22–19:52, the `/v1/internal/*` proxy errors that were already there.
  - During the run: the usual compatibility-restart spike (30–57 per node in 20:21).
  - From 20:23 to 20:38: 116–157 per node, about 7–10 a minute, in line with the baseline.
- **Compatibility watchdog:** 0 missed-heartbeat kills from the 20:21:40 restart to 20:38, against 2 between 19:00
  and 20:21. Load 2.0. No TikTok error lines.
- Worker unchanged.
- No test charge was made on production.

## Rollback

On every changed host (compatibility and the six web nodes), restore `production-cutover.env.bak-20261109-fm351`
over `production-cutover.env`. Then restart the same way: web nodes one at a time behind the load balancer with
`web_restart.py`'s withdrawal (drop its token asserts), and compatibility through the gate. Restore compatibility too,
so that new nodes stop getting the token. Rolling back only stops sending; it touches no data.

## Open

- **Rotate the token** (Ben). It can be read in an image on FM-351. After rotating it, update every copy:
  - dev web `development-runtime.env`;
  - dev compatibility;
  - production compatibility and each web node's `production-cutover.env`, each followed by the same restart.
