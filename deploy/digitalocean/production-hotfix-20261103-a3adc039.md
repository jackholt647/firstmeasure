# Production hotfix a3adc039: staff requests no longer read every staff user in full, November 3, 2026

Released on Jack's request ("Prod started running really slow this morning ... figure out what's going on and fix it", no rollback). Run from this PC through fm-agents-1.

It is production-live `6e7571cd` (release `e7a0f853`) plus one commit, `a3adc039` on `hotfix/auth-structure-fields-20261103`. 4 files, +41/−2. The same commit is on canonical through the platform lane (`platform-20261103201305-d46b9a18`, live on dev).

## What was wrong

Since `ac09d330` (request security), every staff request from PHP to compatibility's Node (`/v1/internal/*`, `legacy-action`) is authenticated from the session: `principal.ts` → `authContextFromRequest` → `buildAuthContext`, which calls `resolveOrganizationStructure` for the staff organization `legacy_internal`. That read all 394 staff user documents in full (about 1.5 MB of JSON) on every request. At afternoon staff traffic the two compatibility workers spent their time parsing rows: in 20 s one worker ran that query 181 times (about 100 MB). Measured 19:20–19:40 UTC against the same window on November 2:

- `POST /v1/internal/legacy-action`: median 9 ms → 4,160 ms (p95 361 ms → 19,460 ms).
- `GET /v1/internal/users`: 33 ms → 4,357 ms; `GET /v1/internal/me`: 2 ms → 714 ms.
- HTTP workers killed for missing their heartbeat: 0 on Oct 31 and Nov 1, 2 on Nov 2, 31 on Nov 3 before the fix. Pool timeouts ("timeout exceeded when trying to connect") and PHP-FPM at `pm.max_children` (20).

The database was idle throughout (218 of 800 connections, no waiting queries). Traffic was the same as the day before. `e7a0f853` (FM-322, editor only) was not involved.

## Change

- `listDocumentFields(orgId, collection, fields)` (`platform/storage.ts`, `platform/storage_postgres.ts`): `id` and only the named `data` fields, in `listDocuments` order. Postgres builds the object, so only those fields cross the wire.
- `resolveOrganizationStructure` reads users with it (`status`, `branch_id`, `branch_ids`, `roles`, `access_role_ids`, the only fields it uses). The structure is identical: on production, the projected rows matched the full documents' fields for all 15,300 user documents (0 mismatches). For `legacy_internal` the read is 41 kB instead of 1.2 MB (stored size).
- `docs/optimization-backlog.md`: the per-request structure resolve is recorded as a known cost.

## Configuration change (compatibility only)

`POSTGRES_POOL_MAX` 4 → 12 in `/etc/firstmeasure/production-cutover.env` (backup `production-cutover.env.before-pool12-20261103`), service restarted 20:12:01–20:12:18 UTC. Each staff request now makes about ten auth reads before its handler, and with 4 connections per worker requests queued 1–2 s for a connection even after the code fix. Two workers × 12 = 24 connections; the database had 187 of 800 in use and no per-role limit. No systemd reload was needed (the file is read at service start); the unit's stale "changed on disk" warning predates this and comes from the October 19 PHP package and snap units.

## Checks before release

- `npm run check` (tsc) passes; `tests/organization-structure.test.ts` and `tests/branches.test.ts` 19/19.
- Build on the dev worker in 314 s: archive sha256 `75bb0b0880383738f45856ce91781e7797a169a6ede16431aad44b06049fb1c7`, verified there and on compatibility and the worker.

## Rollout

- Tracker bug-fix router stopped at 19:57:54 UTC (it was idle; FM-321 was Done in Dev).
- Compatibility 19:59:08–19:59:45 UTC from `e7a0f853`, ready on `a3adc039`.
- Worker 20:02:26 UTC after no running jobs: 8 slots, production, heartbeat off.
- Signed channel published against `94a2c8c5…` (e7a0f853's archive) from the release's real path; a web node downloads `a3adc039` / `75bb0b08`.
- Six web nodes from 20:08:26 to 20:21:22 UTC, one at a time behind the load balancer, each ready in about 95 s with served assets matching, pool 4, 8 workers, full house on. Public readiness then answered `a3adc039` from four instances on 12 of 12 requests; all eight hosts point `current` at `a3adc039`.
- Tracker router started again at 20:21:47 UTC.

## After activation

Compatibility, 20:13–20:16 UTC, against the same minutes on November 2:

| | Nov 2 median | Before fix (19:20–19:40) | After code + pool |
|---|---|---|---|
| `legacy-action` | 8 ms | 4,160 ms | 116 ms (p95 2.4 s) |
| `GET /v1/internal/users/:id` | 2 ms | 408 ms | 11 ms |
| `GET /v1/internal/me` | 2 ms | 714 ms | 15 ms |
| `GET /v1/internal/users` | 27 ms | 4,357 ms | 205 ms |

No heartbeat kills or pool timeouts since the pool change. Node workers about 50% idle in a CPU profile; the host stays near its 2-CPU limit with PHP-FPM.

An analysis script of mine read two days of journal on compatibility at 20:06 and was OOM-killed at 20:07:53; the memory pressure likely caused the 20:08:24 worker restart. Run only bounded journal windows there.

## Still slower than before request security

Every staff request still builds a full auth context (session, identity, organization, user, capabilities, organization structure) where it used to trust headers, so `legacy-action` is about 100 ms above its old median. Also seen, older than this release: `technician_leaderboard` (cached per worker, about 3.8 s per miss, reads the day's manifests twice) and the capacity monitor page (one read of 80,446 minute buckets, 46 MB). Compatibility is a 2-CPU, 4 GB host running PHP-FPM and two Node workers.

## Rollback

Every role keeps `e7a0f853`. Republish its archive (`94a2c8c5…`) to the channel from `/opt/firstmeasure/releases/e7a0f853…/deploy/digitalocean/`, then `activate-release.sh e7a0f853… <service>` on each role. Code only: this release writes nothing. The pool change is independent: restore the backup env file and restart `firstmeasure-legacy`.
