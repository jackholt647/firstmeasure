# Session replay pages, event jumps, idle and kept stylesheets — development, October 23, 2026

Release `05ea7fc3e10e87b08c142d9d7bdd25266537f9fa`.
[Architecture](../../docs/architecture/session-replay.md#who-is-recorded).

**What changed.**
- **Pages never recorded.** Platform administrators add page rules: a pattern over the path and hash, exclude only.
  Recording pages receive them with the config. On such a page the recorder pauses, dropping changes not yet written,
  and leaves a "Recording paused" marker. It resumes as a new page when the person leaves.
- **Sessions by page.** Each chunk carries the pages reached, stored in `session_replay_page_paths` (store schema 5).
  The viewer has a page filter with suggestions, and opens a session a second before the person reached the page.
- **Player.**
  - Previous and next event buttons, also on the `,` and `.` keys.
  - Skip idle no longer counts pointer moves under 12 px, or changes the page makes by itself, as activity.
- **Fix: stylesheets lost when a page closed.** Jack saw the "More credit needed" dialog replay unstyled on
  production. Its stylesheet was first seen just before the page left for checkout, and stylesheets went up only with
  the next chunk, so it never arrived. A read-only audit of 40 production sessions found 5 of 870 stylesheet
  references missing, in 2 sessions. Stylesheets now go up as soon as they are seen, and any still waiting are sent
  uncompressed on page exit. Recordings made before this fix stay as they are.

**Tests.**
- All replay suites pass: server, archive, agent access, browser, end to end and insights.
- New checks cover:
  - page rules: exclude only, invalid patterns refused, the config, and removal by `?target=`;
  - paths, the page filter and its jump time, and the page list;
  - pause and resume, with nothing kept from the excluded page;
  - a stylesheet sent on page exit;
  - the credit dialog's way of adding its stylesheet.
- `tests/realtime-single-stream.test.ts` fails on `src/server.ts`. That comes from commit `5bd18dc2` in another
  session (worker shutdown), not this change.

**Rollout.**
- Worker, legacy and web. Pool is gone from dev.
- The first worker activation was refused because another session's release landed between stage and activate.
  Nothing changed. Re-audited on `712de6b4`, rebuilt, then staged and activated each role.
- All three report `05ea7fc3`, and every shipped file equals its payload.
- The served viewer has the page filter and the event buttons; `platform-api.js` loads loader `20261023-1`.
- Production is unchanged.
