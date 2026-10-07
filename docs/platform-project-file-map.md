# Platform project file map

This map points to the FirstMeasure files used for the Pioneer Puffin feed and synthetic-data work. It is stored on branch `codex/pioneer-puffin-feed-photos`; use that branch when following these links.

| Purpose | File |
| --- | --- |
| Feed layout, actors, notes, photo grouping, project links | [`public/libraries/apps/photos/feed.js`](../public/libraries/apps/photos/feed.js) |
| Frontend asset versions | [`public/libraries/apps/firstmate-apps-manifest.js`](../public/libraries/apps/firstmate-apps-manifest.js) |
| Users tab profile photo behavior | [`public/libraries/apps/settings/company.js`](../public/libraries/apps/settings/company.js) |
| Synthetic feed activity seed | [`public/v1/scripts/seed-pioneer-puffin-activity.mjs`](../public/v1/scripts/seed-pioneer-puffin-activity.mjs) |
| Synthetic project media seed | [`public/v1/scripts/seed-pioneer-puffin-project-media.mjs`](../public/v1/scripts/seed-pioneer-puffin-project-media.mjs) |
| Feed browser test | [`public/v1/tests/feed-browser.test.mjs`](../public/v1/tests/feed-browser.test.mjs) |
| Deployment overview | [`DEPLOYMENT.md`](../DEPLOYMENT.md) |
| Latest dev deployment record | [`deploy/digitalocean/development-feed-notes-project-media-20261007.md`](../deploy/digitalocean/development-feed-notes-project-media-20261007.md) |
| Current list preview rollout record | [`deploy/digitalocean/development-feed-list-media-20261007.md`](../deploy/digitalocean/development-feed-list-media-20261007.md) |
| Current Feed follow-up rollout record | [`deploy/digitalocean/development-feed-note-toggle-project-photos-20261007.md`](../deploy/digitalocean/development-feed-note-toggle-project-photos-20261007.md) |

The dev feed is at <https://dev.1m8.ai/portal/?tab=photos_feed&feedDensity=list>. Replace `list` with `small`, `large`, `mosaic`, or `posts` to inspect other layouts. The readiness endpoint is <https://dev.1m8.ai/v1/health/ready>.

The latest verified feed code release on all three dev frontend roles is `65ab06c32fd91e688a6c12aed55a9fbc13abb419`. This map is documentation only and does not require a dev deployment.
