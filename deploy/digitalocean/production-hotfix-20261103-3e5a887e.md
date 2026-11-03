# Production release 3e5a887e: the November 3 round and the undeletable extra wall, November 3, 2026

Released on Jack's request after he reviewed the round on dev ("Can you get this fixed and then do the push for the bug fix and then all the other stuff we just did as one big push?"). Run from this PC through fm-agents-1.

It is production-live `2a8f113a` (release `800a3887`) plus eleven commits on `hotfix/round-20261103`: the ten commits of the round, cherry-picked unchanged from canonical (on dev since `platform-20261103224457-0156b95b` … `-230302-90448f0e`), and the wall fix `3e5a887e` (from `b6f59c99`; lane `6093be7f`, on dev as `measure-internal-20261103233035-92533f13`). Before release, the 18 files the round touches were byte-identical to dev's.

## Changes

- **Extra wall that couldn't be deleted** (Aaron, `exteriors_c0db6887…`, 16061 SE 172nd Pl, Renton). A chimney side moved onto a wall line cut generated wall `envelope-0-6-1` and made `envelope-0-6-1:chimney-cut-1`. The draft made before the cut listed only `envelope-0-6-1`, so wall mode drew the piece a second time as an unowned wall that no selection reached, and the report counted about 41.6 sq ft twice. `WallGeometry.draftOwnsWall` gives a draft the chimney pieces of its walls that lie inside its outline (`wall_geometry.js`, `wall_face_draft.js`, `exterior_model.js`, `wall_chimneys.js`). The saved project needs no change.
- **3D roof viewer:**
  - every displayed number matches the delivered report: face area in whole squares rounded up from the report's per-face figure; line labels, legend totals, pitch squares and summary rounded and summed as the report prints them;
  - the face card is thin and sits bottom right; the hint is an info button bottom left; the legend is restyled;
  - roof labels keep a constant size on screen;
  - flat faces on roof-only models get a membrane texture;
  - in a narrow model, the view switch moves above the tools.
- **Reports › 3D Model** shows on every finished report (no longer gated by `roof_model_viewer`).
- **Order from photos:** the angle dropdown always fits, the "photos alone may not be enough" line is gone, and photos open large with previous/next and Use as.
- **Project tiles:** tags read Roof / Roof & Gutters / Full Exterior.
- **Onboarding:** the "Add your company name" banner no longer flashes after a new account names itself, and the welcome page's name and company name are optional.
- **Holiday Lights on by default** for every organization; the order toggle still starts off. This is the config snapshot (`capability_defaults/platform`, revision 3), which production reads directly.

## Checks before release

- Dev: platform round with server regression (`npm run check` + mapped viewer suites), reviewed in the browser at 1600×1000 and 1280×800: Full Exterior project, left-column model, Reports › 3D Model, a new order showing Holiday Lights off.
- On the release commit: `dev/wall-face-draft.test.cjs`, `wall-mode`, `glass-doors` and `resource-catalog` 719/719. The agent's runs: wall and chimney suites 1272/1272, other modules 342/342. Viewer and report-tab browser tests 12/12 and 11/11 on the round.
- Build on the dev worker in 254 s: archive sha256 `bcbdc677dec81befccf1052ce10b86937068e3fa8ac867ea1088e5e91e2540b1`, verified there and on compatibility.

## Rollout

- Tracker bug-fix router stopped at 23:37:03 UTC. FM-323 (an `exterior_pdf.js` fix) had been dispatched at 23:37:02; its worker continues and its production step waits for the router. It touches no file in this release.
- Compatibility 23:38:11–23:38:23 UTC from `800a3887`: ready on `3e5a887e`, pool 12 kept, Holiday Lights default present in the served snapshot.
- Worker at 23:39:15 UTC after no running jobs: 8 slots, production, heartbeat off.
- Signed channel published against `835491f7…` (800a3887's archive) from the release's real path; a web node downloads `3e5a887e` / `bcbdc677`.
- Six web nodes one at a time behind the load balancer, 23:40–23:53:55 UTC, each back behind the load balancer on the new release before the next.

## After activation

- Public readiness answered `3e5a887e` on 12 of 12 requests; all eight hosts point `current` at `3e5a887e`.
- Served from app.1m8.ai, 6 of 6 requests each, matching the commit: `wall_geometry.js` (`0b2327a2…`), `roof-viewer.js` (`23d32ee2…`), `exteriors.js` (`2e9884e5…`).
- Flag console on production: `firstmeasure.holiday_lights` default true, on for 13,145 organizations.
- Not tried in the signed-in production editor (no staff login here): the confirmation is Aaron reopening the Renton project, where the extra wall is gone.

## Rollback

Every role keeps `800a3887`. Republish its archive (`835491f7…`) to the channel from `/opt/firstmeasure/releases/800a3887…/deploy/digitalocean/`, then `activate-release.sh 800a3887… <service>` on each role. Code and config snapshot only: this release writes no data.
