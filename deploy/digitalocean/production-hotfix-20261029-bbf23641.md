# Production hotfix bbf23641: the Full Exterior Wall Notes page is always blank on the customer PDF (FM-311), October 29, 2026

Released under Jack's standing approval for the "FirstMeasure bug fixes" tracker workspace (FM-311 set to Testing in prod, verified on dev). Run from Jack's laptop, right after FM-300's `9af332be`.

It is production-live `87dc2e1a` (code `9af332be`, which contains FM-302 `784b7bd0`) plus one commit:
- `bbf23641` FM-311: Full Exterior Wall Notes card is always blank on the customer PDF.

Branch `claude/fm-311-notes-page-messages-prod`. The issue's production plan built the same commit on `3e902d1d` (`f78161a1`, a cherry-pick of canonical `6927c842`); as the plan said, it was rebased onto the newer production-live so this release keeps FM-302 and FM-300. The diff from `87dc2e1a` is the plan's diff line for line.

## Cause

`exterior_pdf.js` `drawExteriorNotes` wrote the report model's warnings onto the customer Wall Notes card as "Review: …" lines (for example "Review: An opening has no matching supporting wall and is excluded from totals."), plus any stored `exteriorSettings.notes`, and added "Wall Notes - continued" pages when they overflowed.

## Fix

- `public/measure/internal/editor_scripts/exterior_pdf.js`: the notes card is drawn with no text, like Roof Notes (`drawPdfNotesCard(doc,notes,[],colors)`). The four elevation reference images are unchanged; the warnings stay in the report model for the editor. Browser PDFs (compatibility) and server-rendered PDFs (worker and web, from the release's `measure/internal/editor_scripts`) both use this file.
- Test `dev/exterior-notes-blank.test.cjs`; one sentence in `dev/EXTERIOR_REPORT.md`.

## Checks

- **Dev:** live and verified in `measure-internal-20261029200926-d8ac92a8` (lane `32275964`): headless Chromium with dev's jsPDF, `pdf.js` and `exterior_pdf.js` drew a blank NOTES card from a model with warnings and a stored note.
- **Production branch (`bbf23641`):** `node --check exterior_pdf.js`; `exterior-notes-blank` 2 of 2.
- **Pre-existing:** `exterior-pdf-layout`'s "eight elevations use one diagram each…" fails the same way without this commit (noted in the plan).

**Build:** on the dev worker (npm ci, check, build), archive `bb0e16b9…`, verified, and its sha256 rechecked on compatibility and the worker after copying.

## Not changed

No migration, configuration, environment or data change. PDFs already generated keep their text; new renders are blank.

## Rollout

- Compatibility at 21:15:23Z, from `9af332be`, with 0 Node 500s and 0 crashes in the next 20 s.
- Worker after no running jobs; 8 slots, production, email on, heartbeat off.
- Signed channel, published against `914b0eca…`.
- Six web nodes, 21:17 to 21:27 UTC, one at a time, each drained from the load balancer, ready, with matching assets (including `measure/internal/editor_scripts/exterior_pdf.js`).

Public readiness returned `bbf23641` 20 out of 20 times. Production serves `exterior_pdf.js` with `drawPdfNotesCard(doc,notes,[],colors)` and no "Review: " text (5 of 5 fetches).

After activation: compatibility 0 5xx of 6,779 requests; web nodes 14 to 43 5xx per ~5,000 requests (the existing `/v1/internal/legacy-action` and `/v1/internal/me` 500s), below the same node's 1.6% in the half hour before; no HTTP worker exits. The worker completed 19 jobs with 0 failed. A Full Exterior PDF for a real production project was not generated: this run has no production session and touched no production data.

## Rollback

Every role keeps `9af332be`. Republish it (`914b0eca…`) to the channel before rolling back a web node. Code only.
