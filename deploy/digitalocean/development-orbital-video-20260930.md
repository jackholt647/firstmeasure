# Full Structure orbital video ordering — development rollout, September 30, 2026

Source release: `680346769fd7de2f2d77f236768a2c25fc8d3055` on
`codex/consolidated-firstmeasure-20260923`. The user authorized deployment to
`https://dev.1m8.ai` for testing. Production activation was not authorized; no
production host, service, autoscale image/template, DNS or provider setting was
touched.

## Behavior

- **Default capture is an orbital video.** The Full Structure capture step opens
  on an animated explainer (a figure walking one circle around the house), then
  a recorder with start, pause, resume and stop. Each stop saves a segment;
  any number of segments and uploaded videos are allowed per structure. No
  microphone is requested.
- **Supplemental media.** After the video, additional photos and videos can be
  added, then the order is submitted as before.
- **Photo fallback.** "Can't take a video?" routes to the existing eight guided
  angles behind a notice that anything not clearly visible may not be
  measurable and the project may be rejected. Additional uploads there accept
  video as well. Either mode can switch to the other.
- **Desktop.** The same explainer with video upload (no recorder), supplemental
  uploads, and the eight-view grid as the fallback.
- **Server.** `exteriors_upload` accepts MP4, MOV and WebM up to 120 MB
  (photos stay at 8 MB). A structure is valid with an orbital video or all
  eight views. The stored upload, not the client, decides whether a reference
  is a video. Queued orders save videos as `customer-reference-N.*` artifacts
  listed in the manifest's `exterior_reference_videos`; `elevation_photos`
  stays image-only. No schema or data migration.

## Limits

- **The technician editor does not show videos yet.** It renders
  `elevation_photos` as images and was left untouched. A video-only order
  reaches the queue with its videos stored, but a technician cannot view them
  in the editor until it reads `exterior_reference_videos`. Do not promote to
  production before that exists.
- Each video upload is one request, capped at 120 MB. The in-app recorder
  targets 5 Mbps and rolls into a new segment at 2.5 minutes to stay under it.
  Videos from a phone's own camera app can exceed the cap; chunked upload is
  not implemented.
- New strings are plain English. `npm run localization:check` already failed
  before this change (stale terminology contract), so the catalogs were not
  rebuilt.

## Validation

- TypeScript check passed in the workspace and on every staged role.
- `tests/exteriors-order.test.ts` passes, including video upload, video-only
  validation, kind spoofing, and queued artifacts.
- `tests/exteriors-orbital-video.test.mjs`: 9 of 9 (state tests plus Chrome
  with a fake camera: explainer, record/pause/resume/stop, upload progress,
  denied camera, fallback, multiple structures, too-short tap).
- Existing suites unchanged in outcome: guided camera 10/10, photo workflow
  9/9, order draft, mobile order sequence, mobile draft.
- The flow was exercised in an isolated browser harness, not inside the
  signed-in order window on `dev.1m8.ai`, and not on a physical phone.

## Deployment

The commit contains only this task's files and hunks, committed through a
temporary index; other sessions' uncommitted edits (including the Feedback
changes in `platform/api.ts`) remain in the working tree. `exteriors.js` is
loaded with the portal's per-request version, so no bundle token changed.

All four development roles were inventoried, staged and activated one at a time
(worker, compatibility, web, pool). Web and pool matched the baseline. The
worker and compatibility payloads were 3-way merged onto their live files
without conflicts and kept their role-specific lines. On each role the service
is active, deployed source and compiled hashes match the payload, the runtime
release and data environment are development, and outbound safety is enforced.
Public readiness reports the release, the served `exteriors.js` matches the
payload hash, and an unauthenticated upload is refused.

Artifacts are in the ignored `output/orbital-video-20260930/`.

## Rollback

Each release directory has a `channels-release.json` receipt recording its
previous release and deployed file hashes. To roll back a role:

1. Confirm `/opt/firstmeasure/current` still points to `68034676…`, so no later
   release is overwritten.
2. Point the symlink back to the receipt's `previous_path`
   (`2e553bf6…` on web, pool and compatibility; `fb692b6b…` on the worker).
3. Restart that role's development service, plus `php8.3-fpm` on
   web/pool/compatibility.
4. Check development readiness and outbound isolation.

On the web and compatibility nodes, do not edit files inside either release in
place: unchanged files are shared hardlinks between releases.
