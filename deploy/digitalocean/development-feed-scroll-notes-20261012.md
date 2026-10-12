# Development Feed scroll position and Posts notes — October 12, 2026

Source commit: `dd889abfc1c16ff169ddd645271e07e895638218` on `codex/feed-department-posts-dev`.

## Changes

- Loading a page uses the dynamic feed renderer and retains the existing scroll element. The scroll position and first visible activity offset are restored after adding the next page.
- Full header/background renders preserve the reading position and expanded notes when the view and filters have not changed. Intentional view/filter changes start their own view at the top.
- Detached pagination observers cannot advance a newer render. Refreshing an already loaded feed retains the number of displayed entries.
- After all available entries are visible and loading has completed, one status message says: “You’ve reached the end of the available activity.” The sentinel is removed.
- Long project notes in Posts use the same measured two-line preview, Show more/Show less controls and expansion animation as list. Short notes remain plain text.
- During regression testing against current dev, preserved typed appointment labels rather than the generic scheduling fallback. Current Scope/event presentation, permissions and the updated GIF draft-selection workflow are retained.

The end status refers to the available feed catalog. This change does not alter the backend's existing event catalog limit.

## Source and workspace

Checkout: `C:/Users/bharb/.codex/.chatgpt-projects/g-p-6ac66060172881919ac68396b1472698/firstmeasure-feed-release`.

- `public/libraries/apps/photos/feed.js`
- `public/libraries/apps/firstmate-apps-manifest.js`
- `public/v1/tests/feed-browser.test.mjs`

Ignored deployment artifacts: `output/feed-list-right-project/v24/`.

## Verification

Passed the existing feed browser suite and a new 82-entry paging test against the merged current dev Feed, Channels and picker assets. The regression checks reading position during header rendering and successive pages, retained scrolling-element identity, preserved expanded notes, all entries reachable, a single end status, and long/short notes in Posts. Existing media fallback, gallery, grouped uploads, comments, editor, GIF selection and audio checks passed. JavaScript syntax and whitespace checks passed.

## Development rollout

GitHub source pushed. Immutable release `dd889abfc1c16ff169ddd645271e07e895638218` activated on web, pool and compatibility. All three readiness checks passed with development data and outbound safety enforced. Active Feed files and the public HTTPS file matched the runtime hash below. Web/pool releases are under `/opt/firstmeasure/releases`; compatibility is under `/mnt/firstmeasure_dev_releases/releases`. Each was cloned from its audited `e4d64cf044420bd67eb4f457913f589a690eeb52` baseline.

Only Feed and its bundle versions are overlaid on each audited current release, preserving other tasks' deployed changes.

Runtime Feed SHA-256: `64a92d9a4d3f317c16fc59d6ff637dae210fb42bcf7289c6158e7a1c288a6e5b`.
