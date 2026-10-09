# Development Feed list day panels — October 9, 2026

Source branch: `codex/feed-department-posts-dev`. Code commits: `f68a9490bcefaf1cec40ebd5fb81e6131f4cb352` and `e128ec4983363fca9e0d2d9336b2b2b315478988`.

## File locations

- `public/libraries/apps/photos/feed.js`: Feed event wording, day panels, list rows, project cards, cover-image placeholder, time formatting, and inline note controls.
- `public/libraries/apps/firstmate-apps-manifest.js`: Feed asset cache version `20261009-feed-list-day-panel-v2`.
- `public/v1/tests/feed-browser.test.mjs`: desktop and mobile Feed browser regression.
- `public/v1/scripts/seed-pioneer-puffin-activity.mjs`: existing synthetic appointments, project notes, grouped photos, and other Feed examples. No reseeding was needed for this change.

## Behavior and validation

`project.event.started` and `project.event.completed` already carry `event_type_default_id` and usually the embedded event title. The Feed had hard-coded both labels as “scheduled event.” It now renders the type and available title, for example “started a sales appointment: Homeowner sales appointment.” No synthetic event fields were invented or changed.

In List, each day has one white panel with separators between activities. Each row shows only the time at its right edge, including on mobile. Its project name and address form one gray clickable card with an “Open project” tooltip and a square image placeholder. That placeholder reserves the position for the planned primary or cover image; choosing and displaying that image is future work. Long notes retain a one-line preview sized by the available width, with inline “Show more” text in place of the chevron.

The focused browser test passed against the repository source and the development overlay script. It covers event titles, daily panel/separators, time-only labels, project-card click target and placeholder, note expansion, and mobile alignment. Syntax and diff checks passed. The signed-in Pioneer Puffin sandbox showed the named appointment start/completion, white day panels, cover placeholders, and time on the right. The public Feed asset returned HTTP 200 with SHA-256 `d68dad5adadcde97f1d2f077d6a9492b8b50bb204cfde17b82abf158f01047bd`; public login returned HTTP 200.

## Development rollout

Development web and pool serve `/opt/firstmeasure/releases/e128ec4983363fca9e0d2d9336b2b2b315478988`. Compatibility serves `/opt/firstmeasure/releases-root-archive-sms-registration/e128ec4983363fca9e0d2d9336b2b2b315478988`. Each passed local readiness with development data and enforced outbound safety. The prior serving release on all three roles was `f68a9490bcefaf1cec40ebd5fb81e6131f4cb352`; the release before that was `70ddc9b70200a56f17c7f1bdf33aaa88c74eb03d`. Recheck current symlinks before a rollback because other dev deployments may supersede these paths.

The development overlay changed only the Feed script, each role's manifest, and release metadata. The repository Feed source also contains an inline media-picker extension that was not in the prior serving asset; the overlay applied this Feed list change to the serving baseline, preserving that separation. Production and worker were unchanged.

The first activation restarted all three serving roles together and the public load balancer briefly returned 503 while re-admitting them. The final mobile-correction rollout restarted one role at a time, with public login HTTP 200 between roles and after completion.

Open the [development Feed List](https://dev.1m8.ai/portal/?tab=photos_feed&feedDensity=list).

## Follow-up: time and project columns

Code commits `da5da69cbcf888e83bc9e5c92e2257354fead2ae` and `19b0cf9eee974520775c34fc8564a4e35b8cce7e` put the time before the activity sentence, keep note/photo/document previews below that sentence on the left, and move the single project card to the right. At widths below 560px, the project card stacks below the activity so the text remains readable. The final commit keeps the time and activity together on narrow screens. The current Feed manifest cache version is `20261009-feed-list-right-project-v4`.

The focused Feed browser test passed against the development overlay, including a long activity at mobile width, the project column at desktop and tablet widths, document preview opening, and project-card navigation. The signed-in Pioneer Puffin Feed showed the time inline with the activity at mobile width. At a 1100px viewport, live page geometry placed the activity at x=210px and the project card at x=743px. The public Feed script SHA-256 is `4dc84299070081cfd7add5bbc055e2d34529ff24398dc080e90bf05badfd201d`; public login returned HTTP 200.

Development web and pool now serve `/opt/firstmeasure/releases/19b0cf9eee974520775c34fc8564a4e35b8cce7e`. Compatibility serves `/opt/firstmeasure/releases-root-archive/19b0cf9eee974520775c34fc8564a4e35b8cce7e`. Each role passed local readiness with development data and enforced outbound safety. The prior release was `c7d9d4e28e65ba37973a47e2673fabc2d22a70d3` on web and `da5da69cbcf888e83bc9e5c92e2257354fead2ae` on pool and compatibility. Check active symlinks before any rollback because other development deployments may supersede these releases.

## Follow-up: project cover photos

Code commit `1524703ffc0f3d269a64dd9a5ec5b631d85c7400` removes the gray project-card fill and uses a 64 × 46 px rectangular cover. It displays the first available project gallery photo, retaining the image placeholder for projects without photos. The cover remains part of the single project button. The Feed manifest cache version is `20261009-feed-list-project-photos-v5`.

The newest Pioneer Puffin full test org (`Pioneer Puffin Test Co 6277ef`) has 16 stored synthetic projects. A live API audit found an address and at least four gallery photos on every one, so no duplicate media was added. The Feed browser test passed against both repository source and the development overlay. In the signed-in dev Feed, the cover images loaded at 320 px intrinsic width and appeared beside the project names and addresses. The public Feed script SHA-256 is `614c9dcd51e76a76683db677e61f57dbb53367793934126f176009002054d5d3`; public login returned HTTP 200.

Development web and pool now serve `/opt/firstmeasure/releases/1524703ffc0f3d269a64dd9a5ec5b631d85c7400`. Compatibility serves `/opt/firstmeasure/releases-root-archive/1524703ffc0f3d269a64dd9a5ec5b631d85c7400`. Each role passed local readiness with development data and enforced outbound safety. Recheck active symlinks before rollback because other development deployments may supersede these releases.

## Follow-up: right-aligned time, hover, and row-sized cover

Code commits `c3d40d4d87774fae95b0f2984a120375369601fe` and `31c6fcc5f16d7050952c6c507a8da0db13c5cbbf` place the activity time at the upper-right of the left column and highlight the full project button on hover or keyboard focus. The project-name underline is gone; the “Open project” tooltip remains. The cover is 96 × 80 px at desktop and narrow-phone widths, and 72 × 60 px at tablet widths where the project column is constrained. The Feed manifest cache version is `20261009-feed-list-larger-cover-v7`.

The Feed browser test passed against repository source and the development overlay at desktop, tablet, and narrow widths, including hover and project navigation. In the signed-in dev Feed at a 1200px viewport, an invoice row measured 118px high, the project cover measured 96 × 80 px, and the time was aligned to the right edge of the activity column. The public Feed script SHA-256 is `c516db2a281d732cbb7b94e58b5657875deda8ec7a1faa66b1c4f3c1b351a857`; public login returned HTTP 200.

Development web and pool now serve `/opt/firstmeasure/releases/31c6fcc5f16d7050952c6c507a8da0db13c5cbbf`. Compatibility serves `/opt/firstmeasure/releases-root-archive/31c6fcc5f16d7050952c6c507a8da0db13c5cbbf`. Each role passed local readiness with development data and enforced outbound safety. Recheck active symlinks before rollback because other development deployments may supersede these releases.
