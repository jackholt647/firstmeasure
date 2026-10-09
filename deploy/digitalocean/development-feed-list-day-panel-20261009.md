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
