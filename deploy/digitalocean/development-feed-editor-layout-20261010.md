# Development Feed editor and picker fixes — October 10, 2026

Source commit: `a2cc8473a7c72836a0b6094bf8bb1aaf3fdf5efd` on `codex/feed-department-posts-dev`.

## Changes

- Feed draft mentions use the shared Channels mention highlighting. Posted mentions and comment mentions use the shared renderer.
- Clear Formatting unwraps selected bullet and numbered list items, including mixed selections, while retaining unselected items.
- Table borders have a fallback color outside the Channels container. Contextual controls show Insert (row above/below, column left/right) followed by Delete row, Delete column and Delete table.
- The mention button stays on the main formatting toolbar above table controls. The comment mention button sits with the attachment/audio/emoji icons, before the flexible spacer.
- Feed GIF pickers use the actual clicked button as their anchor and appear above the post modal. Emoji popup positioning tracks asynchronous widget loading and resizing.
- Preserved the newly deployed Platform Widgets picker implementation, including its loading timeouts and stable GIF grid scrollbar sizing. The local source now includes that shared library.

## Files and local workspace

Checkout: `C:/Users/bharb/.codex/.chatgpt-projects/g-p-6ac66060172881919ac68396b1472698/firstmeasure-feed-release`.

Owned source files:

- `public/libraries/apps/photos/feed.js`
- `public/libraries/channels-ui/channels-ui.js`
- `public/libraries/platform-tags/platform-tags.js`
- `public/libraries/platform-widgets/pickers.js`
- `public/libraries/apps/firstmate-apps-manifest.js`
- `public/v1/tests/feed-browser.test.mjs`

Local deployment artifacts: `output/feed-list-right-project/v21/`. This ignored directory contains the audited active files, merged runtime assets, role-specific manifests and guarded release helper.

## Verification

Passed `node public/v1/tests/feed-browser.test.mjs`, including actual editor selection, mixed/subset list clearing, all table operations, mention highlights and posted tokens, shared GIF selection, picker layering and viewport bounds, comments, photo batches and audio preview behavior. The test uses isolated mock data and a mock GIF service; it does not post to the sandbox.

Passed `node public/v1/tests/channels-mentions-ui.test.mjs`. JavaScript syntax checks and `git diff --check` passed.

## Deployment

GitHub source pushed. Activated immutable runtime release `a2cc8473a7c72836a0b6094bf8bb1aaf3fdf5efd` on development web, pool and compatibility. All three readiness checks passed with development data and outbound safety enforced.

The web and pool release paths were `/opt/firstmeasure/releases/a2cc8473a7c72836a0b6094bf8bb1aaf3fdf5efd`; compatibility used `/mnt/firstmeasure_dev_releases/releases-feed-editor-v21/a2cc8473a7c72836a0b6094bf8bb1aaf3fdf5efd` after a concurrent release required a fresh immutable copy. The unused first compatibility stage remains intact.

Each role was cloned from its current audited baseline. Concurrent GIF loading fixes were preserved. A later concurrent Feed permissions/settings release `f1b937fb0df64047007ed4290e589162210917c9` arrived on web during final verification; its Feed diff retains this patch and adds department permission/settings behavior. Do not roll back that newer work.

Initial runtime SHA-256 values:

| Asset | SHA-256 |
| --- | --- |
| Feed | `44583f2623944faec9918f544c7f1b956bb8d7f16ab454d6345bbe6b04774192` |
| Channels UI | `37e143f3bcc90583c9272797a6390de37d580c0c4befa09c74724eccb6ad83f9` |
| Platform Tags | `29fbceff876df948061a6994b97b68d46f23697828dfb48a634cacefe0921d9e` |
| Shared Pickers | `f617def4360bea27b438583b69d8e8c591875a693d9c319effdcc0d972c29150` |
| Web/pool manifest | `2d5e991d6ed52338cce1cc8f5c1a40846d8737110e81a109fdd4354c354588ac` |
| Compatibility manifest | `0886201cf52d0e56a19b8ef071780221257ed07338207e13f3a4fb8ff07fe5e2` |

Public HTTPS files initially matched the Feed/Channels/picker runtime hashes. After all nodes were ready, the logged-in dev browser loaded Channels `37e143f3bcc90583`, Platform Tags `29fbceff876df948` and the newer Feed `0af7fdb4dcf2dedc`.

Live browser verification: the real shared GIF picker loaded a two-column image grid, remained above the post modal, and fit the viewport (304 × 340 pixels). Choosing a teammate showed the red mention highlight in the draft. The test draft was closed without submitting posts or comments.

