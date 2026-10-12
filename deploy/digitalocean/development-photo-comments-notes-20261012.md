# Photo comments using Project Notes — October 12, 2026

Feature commits d599eb7a, bc3f98b1 and 9055e5a8. Deployed source/runtime
`9055e5a86dc81c17263b93d54ef81f306790324d` on development only.

The shared media viewer mounts the existing Project Notes workspace for each saved
photo/media item. Comments now have the same rich formatting, Enter sending and
Shift+Enter newline, mentions/user previews, GIFs, files, dictation/audio, audience
choices, author/search/archive filters, pinned cards, edit history, archive/restore
and rich threaded replies. Photo navigation retains each mounted workspace and its
draft; switching closes its floating pickers. Closing the viewer destroys all
mounted workspaces. New comment activity continues through the existing photo
activity reporter. Existing Project Notes behavior is unchanged.

The adapter reuses the Notes message services in a dedicated project-type channel
with no project_id, a unique organization-scoped photo discussion key and a
server-owned photo_media_id setting. Ordinary project channels and their Notes
stores remain separate. Photo discussions are excluded from the Channels list.
Every direct channel/message/upload operation rechecks media read/write and
receipt/department access; settings cannot be used to change the media boundary.
Realtime announces stubs so media-restricted text is only returned by authorized
reads. Reply audience inheritance, active counts and editing/authorship rules
remain owned by the Notes service.

The first authorized open imports the existing photo_comments layer once under a
channel-row transaction lock. Authors and timestamps are retained, unknown authors
receive a stable historical identity, and old mentions are not resent. The original
markup list remains intact. No schema migration or bulk customer-data rewrite was
run. New comments are stored in Channels, not the old markup list.

## Validation

- Local TypeScript check passed.
- Thirteen photo/Notes authorization and behavior tests passed; all three final
  Linux stages compiled TypeScript and passed the three photo adapter tests.
- Both photo integration and full Notes composer browser checks passed locally
  and again using development-hosted assets. They use fixture APIs and do not
  post customer comments. Narrow photo layouts were inspected.
- Publication suite: 81 passed, one skipped, zero failed. The initial concurrent
  run exhausted local memory; the complete sequential run passed.
- Focused existing navigation checks passed photo handoff, markup resize and
  thumbnail preservation. The pre-existing customer-sharing source assertion
  still fails on unchanged photos/project.js; it expects an unlocalized literal.

## Development rollout

Each immutable candidate clones its own current role baseline, applies only the
reviewed patch, retains unrelated deployed source and manifest entries, compiles
backend modules into a separate build directory and installs only the three
changed compiled modules. No worker, infrastructure or production changes were
made. Activation guards the prior current path and runtime, verifies hashes,
atomically switches the release and restarts only the development web/legacy
service with PHP-FPM reload. Failures restore the prior path while the candidate
is still current.

All three roles passed source/compiled hashes, exact release identity, readiness,
development environment and enforced outbound-safety checks. Public dev assets
and readiness matched the release. Evidence, role-specific payloads and receipts
are retained under ignored output/photo-comments-deploy.

| Role | Activated release | Previous release |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/9055e5a86dc81c17263b93d54ef81f306790324d-photo-comments` | `/opt/firstmeasure/releases/bb108b6258a926e5534ea9f01576413bae898d22` |
| pool | `/opt/firstmeasure/releases/9055e5a86dc81c17263b93d54ef81f306790324d-photo-comments` | `/opt/firstmeasure/releases/bb108b6258a926e5534ea9f01576413bae898d22` |
| compat | `/mnt/firstmeasure_dev_releases/releases/9055e5a86dc81c17263b93d54ef81f306790324d-photo-comments` | `/mnt/firstmeasure_dev_releases/releases/bb108b6258a926e5534ea9f01576413bae898d22` |

Rollback must preserve intervening work and all discussion records. The older
viewer reads only the legacy markup list and cannot display comments written to
Channels after this rollout; prefer a forward repair over reverting the storage
interface. Do not delete imported messages or completed-import markers.

## GIF picker above photo modals

Frontend feature d03517c5 corrects the shared picker's layering. An ancestor-based
z-index alone cannot overtake a browser top-layer modal. Supported browsers now
show the picker as a manual native popover, retaining its anchor positioning,
Escape/outside dismissal and cleanup. Pickers opened inside native dialogs remain
children of that dialog so its inertness rules do not block interaction. Older
browsers retain the measured z-index fallback. Picker, Channels and widget-loader
cache versions are refreshed.

The photo regression previously stubbed the picker. It now loads the real picker
and checks clickable GIF selection in ordinary and top-layer photo modals, reply
composers and a native dialog. It confirms staged attachment, Escape preserving
the photo viewer and close cleanup. Both photo and full Notes browser checks passed
locally and using dev-hosted assets. Seven shared GIF/Feed tests passed locally.
The GIPHY provider and delivery endpoints are fixtures; no customer comments were
sent.

All three role-specific immutable frontend stages preserve their live baselines,
backend runtime and unrelated manifest entries. Activation reloads PHP-FPM only.
Source hashes, retained runtime identity, readiness, development isolation and
outbound safety passed on every role. Public hashes for all five frontend files
matched the reviewed payload. Evidence is in ignored output/photo-picker-deploy.

| Role | Activated frontend path | Retained runtime |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/d03517c586b851b4727295275f55ca0893a9cfb8-photo-picker` | `b1f079ed3899d318ff135c6b20f5943b01d4b1f1` |
| pool | `/opt/firstmeasure/releases/d03517c586b851b4727295275f55ca0893a9cfb8-photo-picker` | `b1f079ed3899d318ff135c6b20f5943b01d4b1f1` |
| compat | `/mnt/firstmeasure_dev_releases/releases/d03517c586b851b4727295275f55ca0893a9cfb8-photo-picker` | `b1f079ed3899d318ff135c6b20f5943b01d4b1f1` |

## Compact posted GIFs and attribution overlay

Frontend features 21e3da97 and 14db37dc remove the empty rich-text row from
GIF-only posts and Notes/replies, reduce shared figure and draft spacing, and
place the attribution inside the GIF's bottom-right corner. The caption uses
9px white text on a dark backing with a 3px inset, no extra caption row and no
interference with clicking the GIF. The shared renderer applies to photo comments,
Project Notes and Channels, including replies. Text accompanying a GIF retains
its own content and a small separation.

GIPHY requires visible Powered by GIPHY attribution where its API is used:
https://developers.giphy.com/docs/api/#attribution . The label remains readable;
no new provider calls or media modifications are introduced.

Photo/Notes/Channels browser regressions pass locally and with dev-hosted assets.
They verify absence of an empty text row, bounded header/GIF/footer gaps,
attribution positioned within the image and unchanged sending, drafts and picker
behavior. The photo layout was visually inspected at narrow width. Tests use
fixture data and do not post customer messages.

The three frontend-only role stages retain their own live baselines and backend
runtime. Source syntax, hashes, public asset hashes, readiness, runtime identity
and development isolation/outbound safety passed. Only PHP-FPM was reloaded;
backend, worker and production were not changed. Payloads and receipts are under
ignored output/gif-spacing-deploy.

| Role | Activated frontend path | Retained runtime |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/14db37dcfb340615a9f6c585048554b59d4ad54d-gif-spacing` | `cfab7338fc60bd1275ab24f915160135b6c8140b` |
| pool | `/opt/firstmeasure/releases/14db37dcfb340615a9f6c585048554b59d4ad54d-gif-spacing` | `cfab7338fc60bd1275ab24f915160135b6c8140b` |
| compat | `/mnt/firstmeasure_dev_releases/releases/14db37dcfb340615a9f6c585048554b59d4ad54d-gif-spacing` | `cfab7338fc60bd1275ab24f915160135b6c8140b` |

## Supplied GIPHY attribution graphic

Frontend feature c0ac0dcc replaces the text caption with the user-supplied
100×36 transparent white Powered by GIPHY graphic. The original PNG is preserved
at public/images/giphy/powered-by-giphy.png and displayed 70px wide, with its
aspect ratio intact, in the existing bottom-right overlay. A small dark backing
keeps the supplied white lettering readable. The mark does not add a caption row
or intercept clicks. Photo comments, Notes, Channels and their replies share the
renderer; source and loader cache versions are refreshed.

All three browser regressions passed locally and using dev-hosted assets. The
photo test decodes the actual PNG, checks its 70px rendered width and confirms
that it stays inside the GIF's bottom-right corner. Narrow-width rendering was
visually inspected. Test APIs are fixtures and do not send customer messages.

Every frontend-only role passed staging syntax/hashes, retained backend identity,
readiness, development isolation and outbound safety. Public hashes of the PNG,
Channels renderer and app manifest match the reviewed payload. Only PHP-FPM was
reloaded. Evidence is under ignored output/gif-mark-deploy.

| Role | Activated frontend path | Retained runtime |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/c0ac0dccf39f71743d098e43fa33aa4bc554a41c-gif-mark` | `eca7774aa21513a9138891f11a2aafc8bd5512cc` |
| pool | `/opt/firstmeasure/releases/c0ac0dccf39f71743d098e43fa33aa4bc554a41c-gif-mark` | `eca7774aa21513a9138891f11a2aafc8bd5512cc` |
| compat | `/mnt/firstmeasure_dev_releases/releases/c0ac0dccf39f71743d098e43fa33aa4bc554a41c-gif-mark` | `eca7774aa21513a9138891f11a2aafc8bd5512cc` |

## Half-size attribution graphic

At the user's explicit request, frontend c4a7bcdf reduces the supplied mark from
70px to 35px wide, maintaining its aspect ratio, and halves the backing padding
and radius. The original PNG and bottom-right position remain unchanged. This
applies through the shared renderer to photo comments, Notes and Channels.
No claim of a GIPHY-approved numerical minimum is made; the user requested this
size after the published conspicuous-attribution rule was explained.

Local and dev-hosted photo browser checks pass, including exact 35px image width,
image decoding, overlay position and existing composer/picker behavior. Every
role and the public assets passed hashes, retained runtime identity, readiness,
development isolation and outbound safety. Frontend-only activation reloaded
PHP-FPM; backend, worker and production were unchanged. Evidence is under ignored
output/gif-half-deploy.

| Role | Activated frontend path | Retained runtime |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/c4a7bcdf3b593908bd830be9bf27fdc075bf4508-gif-half` | `eca7774aa21513a9138891f11a2aafc8bd5512cc` |
| pool | `/opt/firstmeasure/releases/c4a7bcdf3b593908bd830be9bf27fdc075bf4508-gif-half` | `eca7774aa21513a9138891f11a2aafc8bd5512cc` |
| compat | `/mnt/firstmeasure_dev_releases/releases/c4a7bcdf3b593908bd830be9bf27fdc075bf4508-gif-half` | `eca7774aa21513a9138891f11a2aafc8bd5512cc` |

## Shared Platform Widgets GIF component

Frontend 861c324f moves GIF cards, draft previews, attribution DOM and styling into
public/libraries/platform-widgets/gifs.js. FirstMateGifWidgets provides createCard,
renderCard, createDraft, renderDraft, renderDraftHtml and mount/update/destroy.
It has no Channels, Notes, Feed, session or delivery dependency. It owns approved
media URL validation, DOM escaping, bounded dimensions and the existing supplied
35px attribution overlay. Hosts own message delivery, draft state and placement.

Notes/photo comments now call the widget directly; Channels compatibility helpers
delegate to it. Feed manual posts, comment/reply bodies and both draft composers
use the same component, removing their duplicate image rendering. Existing legacy
CSS class aliases and Feed remove-button hooks are retained. The portal loads the
component before consumers, including outside expanded-assets mode. Common app
bundles, standalone Feed/Receipts bundles and the widget runtime also load it.
The widget README documents the reusable interface.

Eleven browser tests passed using dev-hosted assets, covering standalone rendering
without Channels/API, media URL rejection, escaping, update/destroy, exact 35px
attribution, posted Feed GIFs, draft removal, failed-send retention, Notes and
photo composers, Channels sending and the shared pickers. Corresponding local
checks passed; fixtures do not send customer messages. Staged JavaScript and PHP
syntax checks passed. All roles and public static assets passed hashes, retained
runtime identity, readiness, development isolation and outbound safety.

Immutable frontend stages preserve each live baseline and unrelated manifest
entries. Only PHP-FPM was reloaded. No backend, worker, data, permissions or
production changes were made. Evidence is under ignored output/gif-widget-deploy.

| Role | Activated frontend path | Retained runtime |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/861c324ff095ec7a32c6d62d2f68ce402b059557-gif-widget` | `eca7774aa21513a9138891f11a2aafc8bd5512cc` |
| pool | `/opt/firstmeasure/releases/861c324ff095ec7a32c6d62d2f68ce402b059557-gif-widget` | `eca7774aa21513a9138891f11a2aafc8bd5512cc` |
| compat | `/mnt/firstmeasure_dev_releases/releases/861c324ff095ec7a32c6d62d2f68ce402b059557-gif-widget` | `eca7774aa21513a9138891f11a2aafc8bd5512cc` |


## Compact composers and explicit Channels mentions

October 12, 2026. Source feature `d0e4f744` was merged with the current canonical reply-participant work. Backend/composer release `e5fb6ee59b88b6af468181450d4e019a4dc419b6` adds compact composers and explicit mention handling. Frontend follow-up `171e9fedfba57c1e64146456ee0326f92e32a74b` keeps More before Send and uses an icon for table operations in narrow toolbars.

Notes, photo comments and their replies, Channels/DMs/threads, and Posts comments/replies now start with one text line and grow with content. Formatting has no bottom divider and stays in one row, with trailing commands under See more formatting. The final commands are Table, Quote, Code block. Tagging is in the bottom action row. Existing audio/video/screen recording actions share a compact More options menu, retaining the original handlers and disabled states. New manual posts retain their 300px editor and larger bottom spacing. Posts comments and inline edits use the shared rich editor.

Channels scheduling offers Tomorrow at 9:00 AM and Next Monday at 9:00 AM in browser-local time, with Custom time opening the existing full date/time picker. Upload validation, attachment handling, failure retention and GIF scheduling restrictions are preserved.

Channels highlights and submits recipients only after picker selection (mouse, Enter or Tab). Pending `@`, typed names and typed broadcasts stay plain. Removing a selected name clears its confirmation. Server mention resolution no longer infers `@channel` or `@here` from text. Server-authored `metadata.mention_broadcasts` retains explicit broadcast display across reload and edit; existing message display remains compatible. Existing conversation membership and presence authorization still apply.

Validation:

- All 14 browser checks passed against the published development assets (`DEV_ASSETS=1`), including one-line defaults, text growth, 240/280/360px Notes trays, formatting overflow, code and table operations, recording menus above native photo overlays, bottom tagging, scheduling presets/custom picker/failure retention, explicit mentions, draft/GIF behavior and participant summaries.
- `npm run check` passed locally; full TypeScript builds passed on all three Linux roles. Only owned compiled Channels service output was replaced.
- The original local Channels API suite passed all 36 checks. After canonical reconciliation, each Linux role passed all 36 server checks in the 37-check suite. The sole browser fixture could not launch its Windows Chrome path on Linux; that exact fixture passed locally against the merged source. Explicit broadcast/recipient regression was rerun successfully on each staged role.
- Publication checks were run sequentially after the parallel launcher exhausted host memory. The suite had 80 passes, one reused-database organization collision, and one optional PostgreSQL skip. Both custom-field checks passed on rerun with isolated storage; no publication contract change was required.
- Published JavaScript hashes, each role's complete owned source and compiled backend hashes, exact runtime identity, development environment, and enforced outbound safety were verified after activation.

Both releases were built from each role's current immutable release. Live Feed scrolling/event-label/eligibility changes and Feed administration authorization were preserved by three-way source reconciliation. No production, database migration, permission grants or worker activation was performed.

Final verified paths:

| Role | Current frontend release | Backend runtime |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/171e9fedfba57c1e64146456ee0326f92e32a74b-compact-composers-ui` | `e5fb6ee59b88b6af468181450d4e019a4dc419b6` |
| pool | `/opt/firstmeasure/releases/171e9fedfba57c1e64146456ee0326f92e32a74b-compact-composers-ui` | `e5fb6ee59b88b6af468181450d4e019a4dc419b6` |
| compat | `/mnt/firstmeasure_dev_releases/releases/171e9fedfba57c1e64146456ee0326f92e32a74b-compact-composers-ui` | `e5fb6ee59b88b6af468181450d4e019a4dc419b6` |

Previous runtime release on all roles was `152862f7ee8b4411f8d5cba112143dc0972e4751-reply-participants` (under `/opt/firstmeasure/releases` for web/pool and `/mnt/firstmeasure_dev_releases/releases` for compat). The final frontend-only activation retained runtime `e5fb6ee5`; rollback of that layout follow-up uses the prior `e5fb6ee5-compact-composers` release. Backend rollback requires the development service restart and readiness guard used in the recorded activation.
