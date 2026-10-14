# Project custom fields on the right of Overview, photo fields as tiles (development, October 14)

Release `2489dce7e9568b18bc48c796906a1c94653ffb28` on the canonical branch, built on
`35fbae23`. Frontend only: legacy (compatibility), web and pool. The worker serves no
library files and was not touched.

## What changed

- Project custom fields (including the built-in Cover photo) moved out of the Overview
  details column into the right-hand Project Overview panel, below the summary cards.
  When the map fills the tab, they show as a card over the map's top-right corner. The
  Overview app (`project-map/app.js`) provides the `[data-overview-fields]` slot and asks
  the project window to place the fields there (`placeProjectCustomFields` host call); the
  node returns to the details form whenever the slot is not mounted, so the header
  dropdown keeps mirroring it.
- `photo`, `media` and `video` custom fields render as thumbnail tiles instead of a
  dropdown. A click opens the project media picker (`Portal.PhotoFeed.openProjectMediaPicker`);
  the tile's x clears it. An empty Cover photo shows "Satellite image (default)". In the
  project window, the picker's upload button adds to the project's photos.
- The Photos app's Set/Remove cover repaints the tile through
  `FirstMateCustomFields.setMediaValue`.
- Docs: `docs/architecture/project-content-layout.md` and `docs/architecture/custom-fields.md`.

## Checks

From a scratch `git archive` of the release with `public/v1/node_modules` junctioned in:
`project-cover-browser`, `custom-fields-surfaces-browser`, `project-overview-workflow-browser`
pass. `custom-fields-ui-contract` passes except its existing `close({ skipHistory:true })`
contacts assertion, which also fails on `35fbae23`.

`custom-fields-surfaces-browser` now lets its no-fetch stub answer `PlatformAPI` URL
builders (names ending in `Url`) with a string: `media.thumbnailUrl` spells an image
address and makes no request.

## Rollout

All three roles were on `35fbae23`. The hosts' `firstmate-apps-manifest.js` and
`project-request/app.js` carried other sessions' deployed edits. `project-request/app.js`
3-way merged cleanly; the manifest bundle versions were re-applied to the live text
(`output/cover-photo-tile-20261014/replay.py`). Bundles bumped to
`20261014-cover-photo-tile-v1`: custom fields, project map, project request.

Staged, then activated legacy, web, pool one at a time; each exited 0, public readiness
returned, and `verify` confirmed `2489dce7` on every role. The public files serve the
new code.

Not verified in a signed-in browser session.

## Follow-up: the cover shows the project's cover (commit `2f4d30d3`)

- The cover photo field shows the project's current cover as its value: the chosen photo, or the
  photo the project shows without one, its satellite image (the same image the project list uses).
- The Photos app's `projectCoverDefault` supplies that image, and the project window passes it as
  `defaultMedia`.
- The cover photo picker lists it first, selected when nothing else is chosen. Choosing it clears
  the reference.
- Gone: the "Satellite image (default)" tile and icon, the "Choose a photo" line, and the picker's
  "Clear it to use the satellite image" hint.
- The picker used to list only uploaded library photos, so a project with no uploads showed an
  empty picker even though it had a satellite image.
- `docs/architecture/custom-fields.md` and `tests/project-cover-browser.test.mjs` are updated.
- Activated on legacy, web and pool on top of `3d8e0039`; `verify` passed on all three.
