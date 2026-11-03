# Production hotfix 800a3887: Glass in the sticker placement menu, and customer photos preview in Files, November 3, 2026

Released on Jack's request: the glass box ("just fix this and push it to prod") and the customer photos ("fix this bug where the images aren't loading from customers"). Run from this PC through fm-agents-1.

It is production-live `56dec596` (release `a3adc039`) plus two editor commits on `hotfix/placement-glass-20261103`: `42b628b2` (glass) and `800a3887` (photos, cherry-picked from `3147dc79`). Editor only (`public/measure/internal`, `dev/` tests); no Node code, migration, configuration or data change. Both are also on the measure-internal lane (dev): `b9d66fd3` + tests, and `3147dc79`.

## Changes

**Glass in the placement menu** (`wall_features.js`, `wall_face_draft.js`, `wall_mode.js`). The Glass option was only in Face type, for a selected door, so technicians placing a glass door had to place it and then find the option. The size menu that opens from the Door or Garage door tile now has a Glass box. While it is ticked, every door or garage door placed in that placement session is glass (Shift-click keeps placing; switching between Door and Garage door keeps it). Windows have no box, being always glass. It resets when the menu closes, like the trim width. The lane version also applies it on curved faces; production has no curved-face placement.

**Customer photos in Files** (`project_resources.js`). Full House customer references are labelled "Structure 1 · front-left" (`firstmeasure/api.ts`) but stored as `customer-reference-N.jpg`. The Resources viewer took the file type from the label alone, so every customer photo showed "Preview is unavailable", had no thumbnail, and the walkaround video never reached Core Views. The type now comes from the first of label, name and stored URL that has an extension, and Download original adds the extension to the saved name. This was not caused by the November 3 release: the same code was in `51c70f90`. Production logs showed the photos themselves served with 200 (2.6–8.3 MB) from the Core Views grid, which finds them by slot and was the workaround.

## Checks before release

- On the release commit: `dev/wall-face-draft.test.cjs`, `dev/wall-mode.test.cjs` and `dev/glass-doors.test.cjs` 716/716 (including real-Chromium tests of the Face type switch and the new placement box); `dev/trim-typed-width.test.cjs` 5/5; `dev/resource-catalog.test.cjs`, `dev/resource-core-views.test.cjs` and `dev/resource-media-viewer.test.cjs` 5/5.
- Dev: lane releases `measure-internal-20261103211457-63f3ab04`, `-211642-2628e47c` (tests) and `-211953-77c28068` (photos); dev serves the new files. The signed-in editor was not opened on dev (the dev login isn't staff).
- Build on the dev worker in 349 s: archive sha256 `835491f7b5b7550311f5fe0100b26623e5cdadadd68b9e8172beb6c626ea8ed4`, verified there and on compatibility.

## Rollout

- Tracker bug-fix router stopped at 21:30:20 UTC (idle since 20:21).
- Compatibility 21:31:49–21:32:13 UTC from `a3adc039`: ready on `800a3887`, pool 12 kept (`production-cutover.env`).
- Worker at 21:33:08 UTC after no running jobs: 8 slots, production, heartbeat off.
- Signed channel published against `75bb0b08…` (a3adc039's archive) from the release's real path; a web node downloads `800a3887` / `835491f7`.
- Six web nodes one at a time behind the load balancer, 21:34–21:47:33 UTC, each back behind the load balancer on the new release before the next.
- Tracker router started again at 21:48:07 UTC.

## After activation

- Public readiness answered `800a3887` on 12 of 12 requests; all eight hosts point `current` at `800a3887`.
- `https://app.1m8.ai/measure/internal/editor_scripts/wall_features.js` and `project_resources.js` match the commit (`8e0e2184…`, `6cc42e18…`) on 6 of 6 requests each; they contain the "Place as glass" box and `fileExtension`.

## Not checked

Neither change has been tried in the signed-in production editor by me (no staff login). Confirmation is a technician: the Door tile's size menu shows Glass, and a Full House project's Files › Customer photos open with thumbnails.

## Rollback

Every role keeps `a3adc039`. Republish its archive (`75bb0b08…`) to the channel from `/opt/firstmeasure/releases/a3adc039…/deploy/digitalocean/`, then `activate-release.sh a3adc039… <service>` on each role. Code only: this release writes nothing.
