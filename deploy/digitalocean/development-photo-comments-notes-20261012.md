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
