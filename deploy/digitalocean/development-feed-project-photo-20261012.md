# Feed photos in project windows — October 12, 2026

Source commit: `f1f3bc9e154c32127080e285b5b30f3c433fb085` on `codex/feed-department-posts-dev`.

Project-owned photos clicked in Feed now open their project window on Photos with the selected media ID. This reuses the existing embedded image viewer, photo navigation, tags and comments. The central click path covers list previews, tile layouts, mosaic and project-upload collages in Posts. Existing Feed photo deep links also resolve through this project path.

Project-name links still open Overview. Upload “Show more” still opens the project Photos library without selecting a photo. Unowned media retain their existing standalone viewer; manual-post attachments retain their image modal.

## Files

Checkout: `C:/Users/bharb/.codex/.chatgpt-projects/g-p-6ac66060172881919ac68396b1472698/firstmeasure-feed-release`.

- `public/libraries/apps/photos/feed.js`
- `public/libraries/apps/firstmate-apps-manifest.js`
- `public/v1/tests/feed-browser.test.mjs`

Ignored rollout artifacts: `output/feed-list-right-project/v26/`.

## Verification

Both Feed browser tests passed against the merged current dev assets. Checks cover first and non-first selected photos in list view, selected photos in mosaic and Posts, owning project identity, bypassing the standalone full-screen viewer, Overview links and the Photos-library overflow button. Existing layout, paging, notes, composer, comments and audio checks passed. JavaScript syntax and whitespace checks passed.

Runtime Feed SHA-256: `8d522b8a8080c4b1da750da58c362e16a50df11de34ea67fa929e7c7a7f41510`.

Only Feed and its manifest bundle versions are overlaid on the audited `3ca1145c9140aa56dcef0254d07ef1ba54e6bb6b` baselines.

## Rollout

GitHub source pushed. Immutable release `f1f3bc9e154c32127080e285b5b30f3c433fb085` activated on web, pool and compatibility. All three readiness checks passed with development data and outbound safety enforced. Active assets and the public HTTPS Feed file matched the runtime hash above.

Verified in the logged-in dev sandbox: clicking the second photo in Chen’s closeout upload opens the project Photos tab directly on that image (Photo 3 / position 2 of 10), with project tabs, navigation, tags and the photo comment sidebar. The image is inside the project window iframe rather than a standalone Feed gallery. Screenshot: `output/feed-list-right-project/v26/project-photo-live.jpg`.
