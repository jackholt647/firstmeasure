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

## Follow-up: compact List, project organization, and activity filters

Code commit `a28ddbc60535e5644fa0562c18d3e20c77472578` adds List header controls to expand or collapse every row and organize each day's activities by time or project. Expanded/time remains the default. Collapsed rows show a smaller avatar, one activity line and time, plus only the project name at right. Project organization shows one right-side project card per project for that day, with its activities in a timeline on the left. The choice is retained in the Feed URL. Expanded notes use up to two lines of preview to fit the project-cover height. Photo thumbnails fill one available row; the remaining-media button says “Show more” at the same font size as the note control and opens project Photos.

The Feed's top-right “Shown” control is now “Filter.” Its menu has a “Filters” title and only the nine existing activity choices. Media, media tags, and document controls were removed; all media and document types remain available in the Feed. The manifest cache version is `20261009-feed-list-organize-v8`.

The browser regression passed against both repository source and the development overlay. It covers desktop and phone layouts, compact rows, project organization, fitted photo thumbnails, note expansion, and the activity-only filter. All three development roles passed local readiness and outbound-safety checks after sequential activation. The public Feed asset returned HTTP 200 with SHA-256 `3472e0154d939c674aa9478e2f2e2f5f64dd709b111bd1d353cb19c95c15a0ef`; the public login page returned HTTP 200. In the signed-in Pioneer Puffin sandbox, the compact first row measured 42px high, project grouping showed one project card for multiple events, and Filter showed only the nine activity choices.

Development web and pool serve `/opt/firstmeasure/releases/a28ddbc60535e5644fa0562c18d3e20c77472578`. Compatibility serves `/opt/firstmeasure/releases-root-archive/a28ddbc60535e5644fa0562c18d3e20c77472578`. The previous release on all roles was `31c6fcc5f16d7050952c6c507a8da0db13c5cbbf`. Recheck active symlinks before rollback because other development deployments may supersede these paths. Compatibility staging used a 768 MiB free-space floor for this lightweight overlay because its root volume had just under 1 GiB free; the other capacity and health checks remained in place.

## Follow-up: expanded project timeline and 40-photo sample

Code commit `df46b1bfe76e111afe07e3c297ba1e5fe4632f94` removes the Collapse All control, compact-row styles, and saved compact setting. List activities are always expanded. Organize by Project retains the vertical timeline between avatars but removes the horizontal separators between that project's entries. The Feed asset cache version is `20261009-feed-list-project-cleanup-v9`.

The idempotent [`seed-pioneer-puffin-40-photo-batch.mjs`](../../public/v1/scripts/seed-pioneer-puffin-40-photo-batch.mjs) created 40 actual project-owned media records and 40 matching gallery entries in the newest full Pioneer Puffin test org (`org_983c8e17cd313149`). All 40 belong to Cooper — Roof and gutter replacement, were attributed to Chris Bennett, and share one October 9 upload timestamp and one batch identifier. Verification found 40 catalog photos, 40 media records, 40 authorized Feed sources, and one Feed group key; a second dry run found zero remaining items.

The browser regression passed against both repository source and the development overlay. All three development roles passed local readiness and outbound-safety checks after sequential activation. The public Feed asset returned HTTP 200 with SHA-256 `af34371f7575fb5b3c41369b3bba9c349097af56ae2650b9173be459984488eb`; public login returned HTTP 200. In the signed-in Pioneer Puffin Feed, Today showed one “Chris Bennett uploaded 40 photos” entry, the Collapse All control was absent, and project-grouped entries had zero-width top borders.

Development web and pool serve `/opt/firstmeasure/releases/df46b1bfe76e111afe07e3c297ba1e5fe4632f94`. Compatibility serves `/opt/firstmeasure/releases-root-archive/df46b1bfe76e111afe07e3c297ba1e5fe4632f94`. The serving release before activation was `1177eb4cc3dfbfe81dd6249d64eb7b8703279170` on all roles; this Feed overlay was applied to that release to retain its unrelated changes.

## Follow-up: nested replies, Posts controls, and List project navigation

Code commit `ac8953cf0525d85386240c68c6cd347bcd383ea4` counts every descendant under a comment's Show/Hide replies control. The Posts header places Manual posts only and Post beside the Feed title, with audience, view options, and Filter at the right. Clicking a project card in List opens the project Overview tab (`map` internally); the photo batch Show more button still opens Photos. The Feed asset cache version is `20261009-feed-post-replies-v10`.

The Feed browser regression passed against repository source and the development overlay, including a three-level comment thread, desktop and mobile header layouts, and both project navigation targets. All three development roles passed local readiness and outbound-safety checks after sequential activation. The public Feed script returned SHA-256 `e8d6aeefc7be0f4686e4f41af0c77ca819705df87e0763081926b7420f9d91fc`, and public login returned HTTP 200. In the signed-in Pioneer Puffin Feed, the nested parent displayed “Hide 2 replies”; a List project card opened with `projectTab=map`.

Development web and pool serve `/opt/firstmeasure/releases/ac8953cf0525d85386240c68c6cd347bcd383ea4`. Compatibility serves `/opt/firstmeasure/releases-root-archive/ac8953cf0525d85386240c68c6cd347bcd383ea4`. The previous release on all roles was `df46b1bfe76e111afe07e3c297ba1e5fe4632f94`.

## Follow-up: curated Posts and audience controls

Code commit `32cfaa66b705030d42966e0b6a54b19e71b1fefd` moves Post to the left edge of the right-hand Feed controls and removes the Manual posts only toggle. Company admins choose which automatic activity types appear in Posts under Settings > Feed. Organizations without saved choices start with media uploads, notes, project creation, scheduled and completed events, completed crew checklists, signed proposals and contracts, and received payments. Explicitly saved selections override that default. Manual posts continue to appear in Posts.

Posts no longer show an empty-comments prompt or project addresses. The Show menu now has All company activity, My departments, and a searchable department list; Company board was removed. List organization uses a labeled Time/Project segmented control. The Feed and company settings asset cache versions are `20261009-feed-post-controls-v11` and `20261009-feed-post-settings-v3`.

The focused browser regression passed against repository source and the development overlay, including the department search not filtering Feed content. Syntax and diff checks passed. All three development roles passed local readiness with development data and enforced outbound safety after sequential activation. Public login returned HTTP 200 between roles and after completion. The public Feed and company settings assets returned SHA-256 `79b2161712e4be12bf781d7eb002760cc9ef85d87faade29274094770fda9859` and `3d76b72729e6a1112efe59bc1d7d5c688558392fcab45a119f405a8c02dbc734`. In the signed-in Pioneer Puffin Feed, the custom Show menu omitted Company board, a project post showed only its name, and opening zero comments showed the composer without an empty-comments prompt.

Development web and pool serve `/opt/firstmeasure/releases/32cfaa66b705030d42966e0b6a54b19e71b1fefd`. Compatibility serves `/opt/firstmeasure/releases-root-archive/32cfaa66b705030d42966e0b6a54b19e71b1fefd`. The overlay was staged from the then-serving `80ffae0533ce180f92b205a3acda2142d951738d` release, replacing only Feed JavaScript, company settings JavaScript, and manifests so that release's unrelated changes remained. Recheck active symlinks before rollback because other development deployments may supersede these paths.

## Follow-up: typed Feed summaries and hover previews

Code commit `449e8316f6cc94c9190a896c11829ca1f7b634d5` lets List request a typed summary for an activity when the type is registered and authorized. It recognizes explicit `summary_widget` hints, future `summary.<event.type>` registrations, and current project, contact, and document summaries. A successfully mounted widget replaces the existing row preview. If no widget exists or rendering fails, the note, media, document icon, or ordinary text remains. The document preview retains its generic document icon when no specific icon is available. Project hover targets in Posts and List request `summary.project`; author avatars request `summary.user`. Project clicks continue to open the project modal. The Feed cache version is `20261009-feed-typed-summaries-v12`.

The focused Feed browser regression passed against repository source and the deployed overlay. In the signed-in Pioneer Puffin List, three typed summaries mounted; two document summaries rendered while three document activities retained their existing previews. The page exposed 14 project and 14 user hover targets. User preview visibility follows the summary library's current `manage_company_users` publication permission; users without that permission will not see the hover widget.

Development web and pool serve `/opt/firstmeasure/releases/449e8316f6cc94c9190a896c11829ca1f7b634d5`. Compatibility serves `/opt/firstmeasure/releases-root-archive/449e8316f6cc94c9190a896c11829ca1f7b634d5`. The overlay Feed SHA-256 is `951b9f36212edcad5b7900a81dfadffe66f1961bd2640e86ad14fba0d0a595ff`. Every role passed local readiness with development data and enforced outbound safety. Pool received another task's release during this rollout, so its overlay was restaged on that newer baseline before activation to retain those changes. Public login returned HTTP 200 after activation. Recheck active symlinks before rollback because other development deployments may supersede these paths.

## Follow-up: Posts composer and audience menu

Code commits `a780223ba3955d224bc78111aef666e49bd5c657` and `b5dff594442d6695458813120e0bd8b9bda72d42` remove the border from the Show audience selector and close its menu on an outside click or Escape. Posts comments now use a taller box with the attachment controls and send button inside its bottom edge. The Create a post dialog shows the author's avatar beside the audience, has a formatting bar and a taller message box, and places attachment controls and Post inside that box. The Cancel button is removed. Attached-image previews open in a named modal with a visible close button and backdrop dismissal. The Feed cache version is `20261009-feed-post-composer-v14`.

The focused browser regression passed against repository source and the deployment overlay, covering selector dismissal and border, comment controls, post formatting, avatar, and the image modal. Syntax and diff checks passed. A signed-in live browser check was attempted after deployment, but the in-app browser timed out; the public Feed asset returned HTTP 200 and its SHA-256 matched the overlay (`afe1cc1c9ab36dfc77f46a94c81de4b5cf1217ebc138c775092c90300d3871a0`). Public login returned HTTP 200 between role activations.

Development web and pool serve `/opt/firstmeasure/releases/b5dff594442d6695458813120e0bd8b9bda72d42`. Compatibility serves `/opt/firstmeasure/releases-root-archive/b5dff594442d6695458813120e0bd8b9bda72d42`. Each role passed local readiness with development data and enforced outbound safety. During rollout, another task combined the Feed and newer contact/Channels release on web and pool. The final overlay was staged from those combined active releases and preserved their manifests and assets. The compatibility overlay was staged from its then-active consolidated release. Recheck active symlinks before rollback because other development deployments may supersede these paths.

## Follow-up: Posts control order and compact composer

Code commit `2959d8af3c25af6352b632c8f5c6f0db5bf0c982` orders the Posts controls Show, Post, views, Filter. The Create a post modal shows the posting user's name beside the avatar and places the audience below the name. Empty attachment and audio mounts no longer create blank grid rows below the editor; attachments still appear when added. The Feed cache version is `20261009-feed-post-composer-v15`.

The focused browser regression passed against repository source and the deployment overlay, including control order, posting name, empty-state spacing, and attachment preview. All three development roles passed local readiness with development data and enforced outbound safety at activation. Subsequent development rollouts superseded the web and pool release paths while retaining the same Feed asset. A final SHA-256 audit found `269e77ff866f21300d33c9a100f64543251c526f58c44ec8e62532e19907aa6e` on web, pool, compatibility, and the public Feed asset; public login and the asset returned HTTP 200. The signed-in workspace showed a loading error during a final live browser check, so that visual check did not complete. Recheck active symlinks before rollback.

## Follow-up: Filter menu outside-click dismissal

Code commit `21d8efd903d029c8405163288748489572eaff57` closes the Feed Filter menu when a user clicks outside it or presses Escape. Clicking inside the menu keeps it open, and dismissal resets its expanded state. The Feed cache version is `20261009-feed-post-composer-v16`.

The focused browser regression passed against repository source and the deployment overlay, including inside clicks, outside clicks, and Escape. Syntax and diff checks passed. All three development roles passed readiness and outbound-safety checks during activation. A final SHA-256 audit found `2377ab324aa8448b72e377affd19759bd0a7fccc03b405fd98f36b90c3b53402` on web, pool, compatibility, and the public Feed asset. The public asset and login returned HTTP 200. Other development rollouts may supersede the active release paths, so recheck them before rollback.
