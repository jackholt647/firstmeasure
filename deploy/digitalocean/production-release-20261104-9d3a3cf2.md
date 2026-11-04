# Production release 9d3a3cf2: cover photos, measurements expand and Holiday Lights tab, Operations setup, November 4, 2026

Released on Jack's request ("fix both of those and then push them to prod"), run from his PC through fm-agents-1. The tracker router was stopped at 19:25 UTC with nothing in flight (FM-331's rollout had finished) for the length of this release.

It is production-live `f9388bbb` (release `e3bb233d`, FM-331) plus one commit on `release/prod-cover-measure-ops-20261104`: `9d3a3cf2`, the combined diff of canonical `3688a52d`, `ade8b876`, `5f13a7bf`, `d38938d1`, `5821948d`, `ca05316b` and `fd0e4be5` (on dev as `platform-20261104185252-42c55e66`). Every app file it changes is byte-identical to dev's; the language catalogs were rebuilt from the release's own sources. Production's money terminology ("Take a Collected Payment") is kept: dev's later edit of that entry is not part of this release.

## Change

- **Cover photos:** the Photos tab has no special cover section; the cover tile carries a Cover pill and a photo is set as cover from its viewer. My Projects' map card shows the cover photo between the colour line and the details.
- **Measurements widget:** Holiday Lights is a sub-tab beside Line types, Pitches and Summary (only for reports ordered with it); an Expand button grows the widget to the project window and shrinks it back. The toolbar leaves room for the button; the lights view has no nested card, and side by side its counts sit in the left column.
- **Financials:** the six summary tiles stay on one row until the panel is really narrow.
- **Operations setup and documents:** landscape first page with less text, no hint box, a fixed half-width live preview after the step list with its drag handle, review footer that fits, the proposal path as its own tutorial (also on the first proposal built in Docs), real default lines from "What does this project need?", and the proposal preview resolving once there are lines (rows no longer carry an undefined `children`, which the published action refused).
- **Measurement step (all document workflows):** one section per structure with a toggle, Total under them, compact three-column rows, Add a structure, Reload from project.
- **Setup sheets** fit their first step in a landscape sheet.
- **Config library snapshot:** Docs, Photos and proposal tutorials; Docs FAQs; the shorter checklists setup; the MVP signup sandbox configuration (Photos and Docs on, Scheduling global and per-project tab).
- `development_reports.ts` keeps the Holiday Lights add-on on dev's instant reports (dev only; production orders were already right).
- No migration, dependency or environment change.

## Checks before release

- `npm run check` on the candidate; 54 area tests (51 pass, 3 skipped, 0 fail): operations scope generation and proposal resolve, signup sandbox MVP, config library guided kinds, guided tab tours (unit and browser), apps overlay, Operations setup and measurements browser tests, setup steps, project cover, measurements roof viewer.
- Headless layout check of the widget (330 px widget, expanded side by side): no overlap of Expand and Reset view, lights legend below Reset view, counts in the left column and still updating, no page errors.
- Build on the dev worker in 295 s (npm ci, type check, build, prune): archive sha256 `778f9e1ae0c258dbf1b934f879e12b05e493eef5f87f70cb66508626254cced5`, verified there and on compatibility and the worker.

## Rollout

- Rollback target: `e3bb233d024a500d22b8bcfba3f716489d68d6bc` (every role's `current` before activation).
- Compatibility 19:33:57 UTC: active on `9d3a3cf2`, no 500s and no exits in the first 20 s.
- Worker 19:34:49 UTC after no running jobs: 8 slots, production, heartbeat off, outbound email on.
- Signed channel published against `5822d50e…` (e3bb233d's archive) from the release's real path; a web node downloads `9d3a3cf2` / `778f9e1a`.
- Six web nodes one at a time behind the load balancer, 19:36–19:49:38 UTC, each withdrawn, activated, asset-checked (roof viewer, Holiday Lights, project widgets, apps manifest, photos, map view and document workflow served = `current` with this round's markers; FM-326 to FM-331 still present) and back behind the load balancer on the new release before the next.

## After activation

- Public readiness answered `9d3a3cf2` on 12 of 12 requests; all eight hosts point `current` at `9d3a3cf2`.
- `https://app.1m8.ai/libraries/apps/measurements/roof-viewer.js` has the Expand and lights-panel code, `photos/project.js` the cover action, and the apps manifest loads `roof-viewer.js` `20261104-lights-panel`.
- Errors: worker and compatibility logged no error-level lines since activation. Compatibility legacy-action 500s on the web nodes all fall inside its restart window 19:33:57–19:34:05 (as at FM-328 to FM-331). Other 5xx are the withdrawal probes and `top_view_reroll_proxy.php`, which was failing before this release.
- Jobs since 19:07 UTC: 673 completed, none failed, 1 running.
- Not done: walking the changes signed in on production. They were reviewed on dev; the confirmation here is a person using them.

## Rollback

Every role keeps `e3bb233d`. Republish its archive (`5822d50e…`) to the channel from `/opt/firstmeasure/releases/e3bb233d…/deploy/digitalocean/`, then `activate-release.sh e3bb233d… <service>` on each role. Code and config snapshot only: this release writes no data.
