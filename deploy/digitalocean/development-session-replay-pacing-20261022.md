# Session replay upload pacing — development, October 22, 2026

Release `01f2acc53075a5c30da9466e5553b1fc101079ae` (parent `f090c6c9`).
[Architecture](../../docs/architecture/session-replay.md#what-it-costs).

**Why.** Jack asked what recording costs in CPU, bandwidth and disk, and to bring down anything that is not
negligible next to the application itself. The recorder's CPU already was. Its uploads were not as lean as they
could be: one request every 5 seconds, with 1.2 KB of HTTP/1.1 headers on each (a third of what it sent; dev
serves HTTP/1.1), and a gzip body re-encoded as base64 inside JSON.

**What changed.**
- Chunks and blobs go up as one binary frame (`application/vnd.firstmate.replay-frame`): a 4-byte header length, the
  header JSON, then the gzip bytes. The JSON forms are still accepted.
- The recorder uploads every 20 seconds. The first chunk still goes after 1 second, and hidden or closing tabs still
  send at once. Nothing is sent while nothing happens.
- Each reply names the next interval. While a platform administrator has the session open live, the viewer polls
  with `watch=1` (`watched_until`, held 15 s), and the interval drops to 2 seconds. Starting to watch also publishes
  `session_replay.watch` to the recorded person. A page that already holds the platform event stream then sends at
  once; the recorder never opens a stream itself.
- Storing a chunk takes four statements instead of six, because the page and session totals are upserts.
  `session_replay` store schema version 3.

**Measured on dev.** Pilot customer portal, the same scripted 85-second session: two page loads, continuous mouse
movement, clicks, typing and scrolling. Runs were three with replay off and three on before the change, then three
on after it. Script: `output/session-replay-cost-20261022/measure.cjs`, logs `ab2.log` and `after.log`.

| Per session (about 85 s) | Before | After |
|---|---|---|
| Chunk uploads | 17 requests, 63.6 KB (21.0 KB headers) | 6–7 requests, 37.2 KB (8.1 KB headers) |
| Gzip recording | 28.1 KB | 26.0 KB |
| Recorder main-thread time | 92–154 ms (mean 119) | 77–98 ms (mean 90) |
| Long tasks caused | 0 | 0 |
| Recorder memory | 125 KB | 125 KB |
| Chunk ingest on the server (mean / p95) | 66 / 134 ms | 56 / 71 ms |

- **Requests.** The test forces extra flushes. Steady state is 3 chunk requests a minute for an active person and
  none for an idle tab, apart from one diagnostic sample a minute.
- **The application in the same session** sent about 615 requests (365 KB up, 4.4–6.9 MB down). The page's own
  main-thread time was 620–1,235 ms, a run-to-run spread larger than the recorder's whole cost.
- **Ingest timing.** About 50 ms of every replay request is sign-in and feature resolution: the config and blob
  checks take as long as a chunk.
- **Batch work on the worker.** Indexing measured 43 ms of CPU per recorded minute. Archiving took 3.5 s of wall time
  for 17 sessions (0.91 MB), with verification included.

**Found along the way (not replay).** Dev's nginx has `gzip on` with `gzip_types` commented out. It therefore
compresses HTML only and sends JavaScript and CSS at full size, without cache headers. `platform-api.js` is 169 KB
on every cold load; it would be 33 KB gzip. Most of the application's 4–7 MB per session is probably this. Changing it
is an nginx configuration change on the hosts and was not made here.

**Live follow, checked on dev** (`output/session-replay-pacing-20261022/follow.sh`):
- The pilot page uploaded at 1 s and 20 s, each reply saying `next_ms` 20000.
- A host script then marked the session watched, as the viewer's polls do. The next upload (40 s) was answered with
  2000, and the page sent every 2 s until watching lapsed.
- About 15 s after the last mark, a reply said 20000 again, and the page went back to 20 s.
- The customer portal page does not hold the platform event stream, so the nudge did not apply there, as designed.
  The nudge itself is covered by `tests/session-replay.test.ts` (the event is published once) and
  `tests/session-replay-browser.test.mjs` (`hurry()` sends at once); it was not exercised on a dev staff page.

**Tests.**
- `tests/session-replay.test.ts` adds the frame route, which checks identity and gzip frames, malformed frames, a
  stray field, non-gzip data, another person's write, blob frames, the upserted page and session totals, and pacing
  with the watch event.
- `tests/session-replay-archive.test.ts` and `tests/session-replay-agent-access.test.ts` pass.
- `tests/session-replay-browser.test.mjs` adds pacing.
- `tests/session-replay-e2e-browser.test.mjs` and `tests/session-replay-insights-browser.test.mjs` pass. Their test
  proxies now forward raw request bodies; they had forwarded `postData()` as text, which mangled binary frames.
- `tests/realtime-single-stream.test.ts` passes.
- `tests/access-gates.test.ts` reports 34 differences in the shared checkout. All are stats, payments, assistant and
  exterior routes from other sessions' uncommitted work; no session replay route changed.

**Rollout.**
- All four roles had settled on `51384eaa` (`settle.sh`, two audits 60 s apart), with no drift in this release's
  files.
- Payloads applied cleanly with no merges.
- Each role was staged and then activated as a separate command, in the order worker, legacy, web, pool.
- Every role reports `01f2acc5`, and every shipped file equals its payload (`verify-live.py`).
- `firstmeasure-development-platform-worker` was restarted onto the release.
- Replay was switched on for the pilot organization only for the measurement runs; it is off again for every
  organization.
- Scripts: `output/session-replay-pacing-20261022/`.
