# Channels membership, messages and GIFs — development, September 29, 2026

Source/runtime release: `e515f117a35fe9f6201f0df60f0db419c0638d4a`.

Ordinary channels now have channel managers who control membership and manager
roles, moderate messages and end channel huddles without joining. Members edit
and delete their own messages. Deleted messages show an activity tombstone;
only the person who deleted a message can restore it. Deleted content and
revision history are withheld from other viewers. Last-manager and current
membership checks are enforced on the server. Project channels retain their
existing project/global permission model.

Creation offers public/private visibility. The searchable company channel
directory lists public channels with an explicit Join action; private channels
remain invitation-only. Joining does not reset existing manager roles.

Message menus include Copy message text and existing author-only editing, now
with Save changes and an edited marker after the body. Hover offers quick
thumbs-up. HTTP(S)/www links open in a new tab. Rich clipboard HTML is rebuilt
through an allowlist, retaining text, supported formatting and multiple tables
in order. Shift+Enter within lists makes a continuation line. Cropped tables
say how many additional rows are hidden and offer expansion.

The GIF picker uses the actual bundled official GIPHY JavaScript SDK, with
search, preview, explicit send and attribution. GIF-only messages have no
placeholder text. Server validation restricts media URLs to GIPHY media hosts.
Media remains provider-hosted. The bundle, pinned dependency manifest and
third-party licenses live in `public/libraries/gif-picker`.

With explicit user approval of the SDK agreement, the FirstMate Channels Web
application (GIPHY app 665255, work account jack@1m8.ai) was created with a beta
key. Beta access is limited to 100 API calls/hour; production access requires
GIPHY review/upgrade. The browser SDK key is supplied through the authenticated
GIF configuration endpoint. No key is committed to Git. Runtime configuration
uses `GIPHY_WEB_SDK_KEY` in `/etc/firstmeasure/development-runtime.env` on web
nodes and `/etc/firstmeasure/development.env` on compatibility. Worker needs no
GIF key. Preserve this configuration when replacing instances.

Validation: TypeScript check, 34 API/inbox tests, existing composer regressions
and the new `channels-members-paste-e2e.mjs` Chromium suite passed. Browser
coverage includes mixed rich paste, multiple tables, malicious markup removal,
list continuation, message editing/copying/reactions/restore, public discovery,
joining and manager selection. Live GIPHY results, preview, GIF-only sending and
rendering passed. Browser tests use isolated API fixtures with real UI code;
they do not send messages to customer channels. The same browser suite passed
using scripts served by dev.1m8.ai. Upstream vendor/license whitespace remains.

The immutable per-role overlay preserves unrelated live files and concurrent
Project window changes. It updates four frontend assets and six backend modules
with their compiled outputs: 16 files on each web/compatibility role and 12 on
worker. No database schema, installed server dependency or topology change.
Evidence, manifests and helper scripts are in ignored
`output/channels-members-paste-20260929/`. The existing autoscale replacement
image limitation remains. Production was not activated.

Rollback predecessors:

- Web and pool: `aba0e9c0aeedcf126a9735becea7a885af2a9203`.
- Worker: `c9824fa1168a6d407b8ba5a9ffc026bb2e94e23f`.
- Compatibility: `3cc4935019da836fc1474ae112267c1ac3acc671`.

Check for intervening releases before atomic symlink/service rollback. Roll
one role at a time and verify readiness, development session isolation and
outbound safety. The unused GIF environment setting may remain after rollback.

Final verification: activation completed on all four roles. During verification,
the concurrent My Projects rollout advanced web to
`4733be6b2b99fc7ae303b96bc72b6210c7910375`; worker, compatibility and pool were
still on `e515f117`. A follow-up read-only audit verified all owned Channels
module hashes on every role, the four Channels manifest version references,
active GIF configuration on each serving role, readiness and development
isolation. Public Channels UI/API/SDK hashes and JavaScript MIME types matched;
the shared manifest retained the Channels versions alongside the newer Projects
version. Six public readiness responses passed across both serving release IDs.
See `preserved-verification.json` in the evidence directory. Do not roll web
back to this release's predecessor without accounting for that newer rollout.
