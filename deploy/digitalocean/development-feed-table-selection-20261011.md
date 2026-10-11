# Development table insertion controls — October 11, 2026

Source commit: `b045f1906810b0395ba0c0cd98088938593a5ebb` on `codex/feed-department-posts-dev`.

The shared Channels rich editor no longer clears table context after adding a row or column. It selects the new cell in the corresponding column/row, focuses the editor, saves that caret, and keeps the table toolbar visible. Removing the selected cell or table still clears invalid table context.

## Files

Checkout: `C:/Users/bharb/.codex/.chatgpt-projects/g-p-6ac66060172881919ac68396b1472698/firstmeasure-feed-release`.

- `public/libraries/channels-ui/channels-ui.js`: shared table selection behavior.
- `public/libraries/apps/firstmate-apps-manifest.js`: Channels bundle cache version `20261011-table-selection-v22`.
- `public/v1/tests/feed-browser.test.mjs`: real browser selection and consecutive insertion regression.

Ignored rollout artifacts: `output/feed-list-right-project/v22/`.

## Validation

Passed `node public/v1/tests/feed-browser.test.mjs` against both local source and the merged current dev Channels asset. The regression inserts a row above, verifies the visible controls and caret in that new row, inserts another row below without clicking a cell again, then verifies column insertion also retains the controls. Existing table deletion, formatting, picker, mention, feed layout and comment checks remain green. Syntax and whitespace checks passed.

## Development rollout

Source pushed to GitHub. Release `b045f1906810b0395ba0c0cd98088938593a5ebb` activated on web, pool and compatibility. All three readiness checks passed with development data and outbound safety enforced. Public HTTPS served the verified Channels asset hash.

Only the Channels UI asset and its versions in each role's active manifest are replaced. Unrelated changes in the current release are retained. Web and compatibility were restaged from `75eef23291bac8bf850b67ec4d861d085c2aa3b7` after the deployment guard detected a concurrent update. Pool also changed to `75eef23291bac8bf850b67ec4d861d085c2aa3b7` before activation. It was restaged in `/opt/firstmeasure/releases-root-archive/b045f1906810b0395ba0c0cd98088938593a5ebb`; the unused earlier stage remains intact.

Runtime Channels SHA-256: `feb1093c71bc112bbeee432658f16e31db8ca9e6a1fb66377128683593fc29a4`.
