# Session replay search — development, October 22, 2026

Release `59106e510e719454fe2b98ecc960756155faf08d` (parent `88476a5f`).
[Architecture](../../docs/architecture/session-replay-search.md).

**What it is.** The platform worker's new `session-replay-index` job runs every minute. It indexes each recording 10
minutes after the session goes quiet, by replaying it into a virtual DOM on the server
(`public/libraries/session-replay/session-replay-model.js`) and storing behaviour steps, a catalogue of screens and
elements with stable ids, day-level aggregates and on-screen text (store `session_replay_insights`, schema 1).
Platform administrators get a tool manifest and one call endpoint for a language model:
`GET /v1/platform/session-replay/insights/tools` and `POST /v1/platform/session-replay/insights/call`.

**Rollout.**
- Shipped to all four roles: the seven `insights/*.ts` files, the route line in `platform/api.ts`, the job line in
  `src/platform_worker.ts`, and `session-replay-model.js`. The worker also got `session-replay-model.js` and
  `session-replay-codec.js`, because its job loads them; no earlier rollout had sent library files to the worker.
- Three sessions deployed at once. The archive session took the worker to `db5f246c`, which is built on this commit,
  and another session took web, compatibility and pool to `450c3003`. Two activations were refused by the release
  guard. After the roles held steady across two audits a minute apart, the candidate was rebuilt on the live files
  and three-way merged. Each shared file gained exactly this task's lines.
- Compatibility's first staging failed its host TypeScript check with no output and passed unchanged on retry.
  Pool changed under the activation once, and was re-audited, rebuilt, restaged and activated on its own.
- A chained command activated the worker after compatibility's staging had failed. The worker had staged cleanly,
  so the roles were never inconsistent, but stage and activate should be separate checked commands.
- Every role reports `59106e51`, and every shipped file on every role equals its payload byte for byte
  (`verify-live.py`). `firstmeasure-development-platform-worker` was restarted on the release. Dev serves
  `session-replay-model.js`, and the tools route answers 401 without a session. Scripts:
  `output/session-replay-search-20261022/`.

**Checked on dev.** The job had already indexed all 23 recordings: 5 people, 0.69 hours, 197 clicks and 44 field edits.
- `replay_screens` ranked the viewer (`/portal/?tab=viewer`, 22 sessions, 21.8 s per visit) and the project list and
  tiles views. It also found settings → people → users.
- `replay_targets` on the viewer listed the List and Tiles toggles, the account switcher and Settings, each with what
  followed.
- `replay_friction` found a real script error, "ResizeObserver loop completed with undelivered notifications", in 6
  sessions, all on the reports screen.
- `replay_find_sessions` by text, `replay_session_timeline` and `replay_screen_at` all answered on pilot sessions.

**Tests.** `tests/session-replay-insights-browser.test.mjs` passes against this commit and again against the archive
commit on top of it (`db5f246c`).
