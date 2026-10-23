# Session replay archives — development, October 22, 2026

Release `db5f246cd87670277621e789d65618e2f7d3a975` (parent `59106e51`). Design and contracts:
[session replay, "Archives"](../../docs/architecture/session-replay.md).

**What it is.** A finished session (no chunk for 7 days) is re-packed on the server by the platform worker's hourly
`session-replay-archive` task. Each page is decoded with the wire format's rules, its per-page string ids are renumbered
onto vocabularies shared across sessions (platform: strings seen in 3+ organizations; organization: strings seen in 2+
of its sessions), DOM node ids are delta coded, and the stream is compressed with zstd and the organization's dictionary
(its newest page loads, canonical, literal text blanked). Vocabularies are append-only versioned token lists and every
archive pins the versions it used. Every page must restore to its exact original chunk JSON or is kept verbatim, and
the whole archive is decoded with the stored vocabulary and dictionary and compared with every chunk before the chunk
bodies are emptied. The chunks endpoint restores archived sessions, so the recorder and player did not change. Store
`session_replay` is at schema version 2 (new tables `session_replay_archives`, `session_replay_vocab_versions`,
`session_replay_string_counts`, `session_replay_archive_runs`, `session_replay_archive_lock`; new columns
`archived_at`/`archive_bytes` on sessions and `archived` on chunks).

## Measured before building

Scripts and data: `output/session-replay-archive-20261022/` (`measure.mjs`, `experiments.mjs`, `sim-dict.mjs`,
`sim-struct.mjs`, `sim-final.mjs`, `harness.mts`; the sessions in `data/sessions.json`, fetched read-only).

**Sessions.** The six sessions already on dev plus 17 read-only browsing sessions recorded for this (`wander.cjs`
through the pilot Playwright driver) as the four full-house pilot accounts, each its own organization
(`org_301b0d762ed917ba`, `org_0135d26805207644`, `org_298f0a0acc40b3c7`, `org_0af2dae32e770315`). Replay was switched
on for those four organizations for the recording (16:01–16:13 PDT) and switched off again. 23 sessions in five
organizations, 1.19 MB as recorded (4.67 MB raw JSON), 0.4–3.2 minutes each, 1–5 page loads.

**The three approaches on the same sessions, in recording order** (× smaller than today's per-chunk gzip; the
dictionary of each session is the organization's earlier sessions, and what it costs to keep is left out):

| | all 23 | 18 with history | each org's first |
| --- | --- | --- | --- |
| (a) gzip per 5-second chunk (today) | 1.00× | 1.00× | 1.00× |
| zstd-19, the session alone | 1.71× | 1.73× | 1.60× |
| (b) zstd-19 with earlier sessions as a raw dictionary (1 MB) | 3.04× | 3.83× | 1.60× |
| (c) canonical, vocabularies only | 2.73× | 3.14× | 1.72× |
| (c) canonical, vocabularies and a canonical history dictionary | 4.14× | 6.06× | 1.72× |
| (c) same, platform strings admitted at 2 organizations | 4.57× | 7.04× | 1.80× |

Renumbering is what makes (c) work: with no vocabulary the canonical history dictionary gives 3.01× (what (b) gives),
because the same markup only becomes the same bytes once string ids no longer depend on what else a page interned.
Delta-coding node ids added 5%. Upper bounds measured by discarding information (lossy, measurement only): all node ids
would be worth at most 1.4× more, page template numbers 2%, a platform dictionary of shared subtrees under 10% on an
organization's first session. Dictionary size barely mattered (256 KB ≈ 1 MB).

**What a real archive costs.** The table above leaves out the dictionaries. Stored as one dictionary per session, they
cost more than the archives (honest ratio 1.85×; 3.17× stored as deltas). Recurring canonical fragments as vocabulary
tokens (dictionary derived from them, nothing else stored) gave 3.06× with everything counted. The design built keeps
token versions cheap and frequent and stores a small page-load dictionary only when the organization has archived 32×
its size since the last one: 2.79× with everything counted on this history (simulated), and the job as built gives
the same.

## Dry run over the dev sessions (after rollout, on the dev web host)

`runReplayArchive({ dryRun: true, olderThanMs: 0 })` over all 23 sessions, 2.6 s, run `bc37f819` in
`session_replay_archive_runs`: 1,192 KB as recorded → 341.3 KB of archives (**3.49×**) + 87.6 KB of vocabulary
(5 platform versions with 2,294 tokens, 19 organization versions with 2,055 tokens, 9 dictionaries of 10–45 KB; 51.7 KB
of tokens and 36.0 KB of dictionaries stored) = **2.78×** with every stored byte counted. No page was kept verbatim.
By history in the organization:

| sessions | as recorded | archived | ratio | each |
| --- | --- | --- | --- | --- |
| an organization's first (5) | 220.2 KB | 121.8 KB | 1.81× | 1.07–4.88× |
| one or two earlier (8) | 518.3 KB | 117.6 KB | 4.41× | 1.65–6.95× |
| three or more earlier (10) | 453.5 KB | 101.9 KB | 4.45× | 2.24–10.06× |

A first session pays for its organization's vocabulary; 4.88× is an organization whose first session found 95% of its
strings in the platform vocabulary. The scripted sessions resemble each other, so real sessions will compress less per
session, and longer histories spread the vocabulary over more sessions.

The same dry run run locally over the same sessions (`harness.mts`) gave the identical bytes, and a local real run
matched its dry run exactly and read all 473 chunks back identical.

## Real archive on dev

The 17 sessions recorded for this were archived for real (`POST`-equivalent `runReplayArchive({ olderThanMs: 0,
sessionIds })`, run `39710cb4`, 3.5 s): 956.9 KB → 222.0 KB (4.31×) + 68.7 KB of vocabulary (3.29×), all `archived`.
Every chunk of all 23 sessions (473: 17 archived sessions and 6 live ones) was then read back on dev through
`readReplayChunks`, the path the viewer's chunks endpoint uses, and its JSON hashed: 473 identical, none missing.
Jack's session (`mn6y3xy3`) and the five earlier pilot sessions stay live until the worker reaches them on October 29.
The archived sessions are in the viewer under "All organizations" (pilot organizations), marked "archived" in the list.

## Rollout

- The worker took `db5f246c` first (built on `88476a5f`); `firstmeasure-development-platform-worker` was restarted and
  its `session-replay-archive` task ran at 00:12 UTC, archived nothing (nothing on dev is 7 days old) and logged no
  error.
- Legacy refused activation twice because other sessions activated in between, and its staging failed twice because
  the 4 GB compatibility host ran out of memory with three sessions' `tsc` checks at once (an empty "Linux TypeScript
  check failed"; `dmesg` shows the kill). Meanwhile web, legacy and pool ran other releases; nothing could be archived
  in that window, so mixed roles were harmless. The release was then shipped one role at a time (audit, build, wait
  until no role is staging, move this release's half-staged directory aside, stage, activate):
  `output/session-replay-archive-20261022/ship-each.sh legacy web pool`. Legacy, web and pool activated on top of
  `d35e275f` and verified; the worker then took `d35e275f` from another session with these files kept.
- Every role serves the committed files (`platform/storage.ts` with host-only differences around the change), dev
  serves `session-replay-viewer.js?v=20261022-3`, and `GET /v1/platform/session-replay/admin/archive` answers 401
  without a session.
- Moved aside on hosts (staging leftovers of this release, not active): legacy `…/releases/db5f246c…-oom-killed`,
  `-staged-88476a5f`, `-aside-1792716557`; web and pool `…-aside-…`.

## Tests

- `tests/session-replay-archive.test.ts` (new, SQLite and embedded Postgres): every event type round-trips
  canonically, unknown pages stay verbatim and restore, a dry run writes nothing and predicts the real run's bytes, the
  chunks endpoint serves the original JSON, an archived session refuses chunks, versions are append-only and every
  pinned version keeps decoding across generation rollovers, a late chunk keeps the session live, deleting an
  organization removes its replays, vocabulary and statistics and leaves the platform vocabulary unchanged. 6/6 on both.
- `tests/session-replay-browser.test.mjs`: the recorded session is archived and the replay plays the restored chunks,
  matching the live page at all 24 checkpoints.
- `tests/session-replay-e2e-browser.test.mjs`: after the viewer plays the recording, the session is archived through
  the admin route and the viewer reloads and plays it to the same state with the same events; the Storage panel shows
  it archived. The test now waits for the organization switch's PUT before reloading (it raced before).
- `tests/session-replay.test.ts` and the sibling `tests/session-replay-insights-browser.test.mjs` pass. `tsc --noEmit`
  is clean on `HEAD` plus this change. `tests/signup-sandbox-samples.test.ts` fails the same way without this change (a
  temp-path module lookup).

## Not done

- The viewer could not be opened as a platform administrator from this session; the e2e test covers it.
- Nothing collects unpinned vocabulary versions or dictionaries yet, and old archives are not re-packed onto newer
  vocabularies (architecture doc, "Not built"). Shortcuts are in `docs/optimization-backlog.md`.
- The commit message of `db5f246c` says sessions with three or more earlier ones archive at "4-10x"; measured, they are
  2.2–10× each and 4.45× together.

## Follow-up: token-level reads (`cb33d4c3`)

For the session replay search index (`session-replay/insights/`, another session): `readVocabulary(scope, pin?)`,
`organizationVocabulary(orgId)` and `readArchiveCanonical(sessionId)` in `session-replay/archive.ts`, and
`pageTableIds(page)` in `archive-codec.ts`. A token keeps its index for the life of its generation, so
(scope, generation, index) is a stable key. Search reads every session through `readReplayChunks`, which returns the
original chunk JSON for live and archived sessions alike (verified above on all 473 dev chunks).

Shipped one role at a time to worker, legacy, web and pool (`ship-each.sh`, files `archive.ts`, `archive-codec.ts` and
the archive test); legacy's first activation was refused by another session's activation and the retry went through.
The final `verify` stopped at web because another session had activated web since. An audit of all four roles then
found this change's files identical to the commit everywhere (`platform/storage.ts` with host-only differences around
the change). An earlier version of this record said the search session's `viewer.html` (`177d54df`) was not live:
that compared a stale copy saved by the first rollout's audit. Dev serves it (`session-replay-viewer.css?v=20261022-2`
and `session-replay-agent-access.js`, which answers 200), as the search session confirmed on each host.
