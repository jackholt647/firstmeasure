# Session replay — development, October 22, 2026

Release `21521b99d1440248125b2169a233c7dbb42f4c2d` (parent `77ec2925`).

**What it is.** A standalone recorder and viewer (`public/libraries/session-replay/`,
[architecture](../../docs/architecture/session-replay.md)). `platform-api.js` loads a small loader on every signed-in
page; the loader asks `GET /v1/platform/session-replay/config` whether the organization has
`platform.session_replay` on, and only then loads the recorder. Recordings are a DOM snapshot plus MutationObserver
deltas, the pointer path, clicks, keys, inputs (passwords and card fields masked), scroll, focus, hover, URL changes,
errors and the recorder's own cost, tokenized with repeated subtrees as templates, stylesheets stored once per
organization, sent as gzip chunks every 5 seconds.

**Off by default.** `platform.session_replay` defaults to off, needs no expanded access, is excluded from every preset
and is off for FirstMeasure signups. Platform administrators (full internal admins, for example `jack@1m8.ai` on dev)
switch it per organization in the viewer at `https://dev.1m8.ai/libraries/session-replay/viewer.html`. Only they can
read replays.

**Storage.** New `openSqlStore` store `session_replay` (schema version 1): sessions, pages, chunks (gzip `BYTEA`),
blobs (per organization, by content address) and the switch audit. Tables are created on first use.

**Tests.**
- `tests/session-replay-browser.test.mjs`: a scripted session in Chrome replays to the same DOM, computed styles and
  scroll at all 24 checkpoints, forward and seeking back (hover dropdowns, typing, masked password, list re-renders,
  moves, shadow roots, iframe navigation, stylesheet edits, scrolling, SVG, focus, pushState). 3/3 runs pass.
- `tests/session-replay.test.ts`: switch, admin-only reading, chunk storage and retries, conflicts, blob addresses,
  presets. 3/3 pass.
- `tests/session-replay-e2e-browser.test.mjs`: a page loading `platform-api.js` records through the real routes after
  an administrator switches the organization on, and the viewer lists and plays it. Passes.
- `tests/crm-app-browser.test.mjs` (loads `platform-api.js`) still passes with the loader present.
- `tests/capabilities.test.ts`: 13/14; "registry is structurally valid" fails on HEAD before this change too
  (`platform.collaboration missing catalog_stub`).

**Rollout.**
- `21521b99` went to all four roles (worker, compatibility, web, pool), which were on `77ec2925` (worker on
  `066c6953`). The three shared platform files (`api.ts`, `capabilities.ts`, `capability_defs.ts`) were three-way
  merged onto each host's live copy, which added exactly this change. Host TypeScript checks passed, and verify passed on
  every role. `firstmeasure-development-platform-worker` was restarted so its capability registry knows the new
  switch. Scripts: `output/session-replay-20261022/`.
- Another session then built `e7cb1bf8` on top of `21521b99` and restarted web and pool while a test recording was
  uploading. The recorder retried its three 502s and lost nothing.
- Follow-up `49241e4a` (recorder: chunk timers and the upload loop never surface errors to the page; loader and
  recorder `?v` bumped) went to compatibility, web and pool. The first activation was refused because another session
  deployed between staging and activation. The candidate was rebuilt and restaged on `45d01e14` once all three roles
  reported that release, then activated and verified. Scripts: `output/session-replay-fix-20261022/`.
- Dev serves the committed bytes of every library file, `platform-api.js` loads `session-replay-loader.js?v=20261022-2`,
  and `GET /v1/platform/session-replay/config` answers `{"enabled":false,"reason":"signed_out"}` without a session.

**Checked on dev.** Replay was switched on for the full-house pilot organization (`org_301b0d762ed917ba`) through the
same writer the viewer uses. The pilot customer then browsed the real portal for 22 seconds: the snapshot took
12.3 ms for 743 nodes, and the recorder used 0.21% CPU (52 ms in total). It sent 6 chunks, 11.5 KB gzip (35.2 KB raw).
The 16 stylesheets were 323 KB raw and 66 KB gzip, stored once for the organization. The stored chunks and blobs were
read back and replayed: the portal rebuilt with its layout, images and pointer trail, and the diagnostics overlay was
not recorded. Replay was then switched off again. That session is kept as an example in the viewer under "All
organizations".

**Not done.** The viewer could not be opened as a platform administrator from this session (no administrator sign-in
in the browser pane). The viewer itself is covered by `session-replay-e2e-browser.test.mjs` against the real routes.

**Cost calculator (`ca31b276`).** Browser-only release to compatibility, web and pool, which were on `d12a4c71`.
Storage now shows the cost of a page load (its first 15 seconds) apart from the cost per minute after it, and the
organization's per-hour rate says how much recording it is based on. The monthly cost is average concurrent users ×
730 hours × (loads per user-hour × KB per load + 60 × KB per minute after loading), with retention and an optional
archive ratio. Verify passed on all three roles, and dev serves the committed files.

**Compression baseline (2026-10-22).** Scripts and data are in `output/session-replay-compression-20261022/`.
- Jack's first session (60 s, full platform portal, 79.2 KB): 82% of the bytes were the first 15 seconds. That is the
  snapshot (17.9 KB) and the portal rendering its UI right after it. The remaining 45 seconds cost about 14 KB. The
  raw JSON was 42% string table, 35% added subtrees and 11% attribute changes; the pointer, clicks, hover and
  diagnostics were under 4%.
- Five pilot-org sessions (FirstMeasure-only portal, scripted, 0.4–3.2 minutes) cost 11–12 KB per page load and 9–13
  KB per minute after loading, idle time included.
- After the fact, each session re-packed alone is 1.3–1.6× smaller (brotli 11 is best). With the organization's
  earlier sessions as a zstd-19 dictionary it is 1.7× smaller after one session of history, 3.0× after two, and
  4.1–4.3× after three or four. Over all five that is 2.54× against 1.32× for zstd alone. Jack's session, from
  another organization, was still 1.7× smaller with the pilot sessions as the dictionary. The scripted sessions
  resemble each other, so real gains will be lower.
- The dev hosts' Node (v22.23.2) has zstd with dictionaries, so an archive job needs no new dependency.
