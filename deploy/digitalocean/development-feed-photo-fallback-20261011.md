# Development Feed photo thumbnail fallback — October 11, 2026

Source commit: `388e91e39cf229977cb3ca8fc5a1154c916deb93` on `codex/feed-department-posts-dev`.

## Cause and fix

The Reed upload `media_4f45c8b5939b3af0` has an intact original image measuring 733 × 598. Its requested `thumb_320` failed in the feed while the gallery loaded the original. The upload processor defaults to generating thumbnails only for images with a dimension of at least 1024 pixels. Feed ignored the media reference's available variants and requested the missing thumbnail anyway.

The shared thumbnail loader had a second defect: after the original-file fallback loaded, it cached the missing thumbnail URL as merely "loaded". A subsequent render (including switching between list and Posts) restored the missing URL, marked the tile loaded, and suppressed fallback based on that CSS class.

Feed now uses the original when declared media variants contain no 320-pixel thumbnail. When fallback is needed, it caches the URL that actually loaded and reuses it on subsequent renders. Retry decisions depend on the image's actual load state rather than the tile's CSS class. This applies to list, Posts and other feed thumbnails. Original photo data is unchanged.

## Files and workspace

Checkout: `C:/Users/bharb/.codex/.chatgpt-projects/g-p-6ac66060172881919ac68396b1472698/firstmeasure-feed-release`.

- `public/libraries/apps/photos/feed.js`
- `public/libraries/apps/firstmate-apps-manifest.js`
- `public/v1/tests/feed-browser.test.mjs`

Ignored deployment artifacts: `output/feed-list-right-project/v23/`.

## Validation

Passed `node public/v1/tests/feed-browser.test.mjs` against local and current dev merged Feed code. A fixture with only an original variant verifies that no thumbnail URL is used. A second fixture returns 404 for its thumbnail but serves a valid original; it remains visible after rerendering in list and Posts. Existing gallery, image batching, layout, comments, rich editing, mentions, GIF and audio checks passed. JavaScript syntax and whitespace checks passed.

## Deployment

Source pushed to GitHub. Immutable release `388e91e39cf229977cb3ca8fc5a1154c916deb93` activated on development web, pool and compatibility. All three readiness checks passed with development data and outbound safety enforced; each active Feed asset and the public HTTPS file matched the runtime hash below.

Only Feed and its role-specific manifest versions are overlaid on each audited current release. Other active changes are preserved.

Runtime Feed SHA-256: `60c459cbffcacc2122ff11b97861b4f094d40babe41b8e58f3dce5a48308f980`.

Live sandbox verification: after a refresh, the exact Reed image loaded from its original variant with natural dimensions 733 × 598 in list, then Posts, then list again. No broken thumbnail remained. The user-owned browser tab was left on list view with the image visible. No photo or project records were modified.
