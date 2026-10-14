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
