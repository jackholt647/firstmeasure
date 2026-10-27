# Production release 2703bab3: session replay, off for everyone, October 23, 2026 (~08:29–08:41 UTC)

## Approval and contents

Jack approved this in the session replay session: "Okay, can we go ahead and get this fully pushed to prod now that we have that updated? Just keep the feature flags off by default, and I'll set them via the UI when I'm ready, now that it's secure and updated." I confirmed the quote in that session's transcript.

The session replay session built the commit `2703bab3` (`codex/session-replay-prod-20261023`) on production `f4b74de0` (record commit `a171558d`). The release-lane session reviewed, built and released it.

It contains:

- the session replay library and server modules (new files);
- the `platform-api.js` loader tag;
- route registration in `platform/api.ts`;
- two jobs in `src/platform_worker.ts`;
- read-only search helpers for organizations and identities;
- removal of replay data when an organization is deleted;
- the regenerated `access-gates` snapshot.

## Before activation

- **Shared-file changes reviewed:** they are small and match the description.
- **No `platform_worker` process on production:** compatibility runs `dist/src/server.js`, the worker `dist/src/firstmeasure_worker.js`, web `firstmeasure-web`. The new replay jobs therefore never run. Recording is off: the mode is "listed" and nobody is listed.
- **Database:** the runtime role `firstmeasure_app` has CREATE on `public`, and `platform_sql_schemas` already records 17 stores created on first use. First-use creation of the replay tables is safe.
- **Build:** archive `e20d4718…`, verified. The source session's tests: `tsc` clean, 15 of 15 server tests, 3 of 3 browser tests, and `access-gates` against the regenerated snapshot.

## Rollout

- Compatibility activated with 0 errors and 0 crashes in the next 20 s.
- The worker activated.
- The signed channel was published against `cc525af4…` (`f4b74de0`).
- Six web nodes activated, 08:31–08:41.
- Public readiness returned `2703bab3` 10 out of 10 times.

## Verification

- `GET /v1/platform/session-replay/config` returns 200 `{"enabled":false}` for signed-out requests and on the web nodes' signed-in traffic.
- The loader is served (200), and `platform-api.js` carries the loader tag.
- The 13 `session_replay_*` tables exist in production Postgres.
- The replay routes produced no 500s. One 404 on a web node came before that node activated.

## Known for every release

While compatibility restarts, web nodes return 500 for a few seconds on requests they proxy to it (`ECONNREFUSED 10.124.0.9:3101`): at 08:29 here, and at 07:16 during `f4b74de0`. Earlier records only counted compatibility's own errors.

## Rollback

Every role keeps `f4b74de0`. Republish it (`cc525af4…`) to the channel before rolling back a web node. The replay tables are additive, and older code ignores them.
