# Production hotfix cad6a00b: Resources tab on customer Full House orders, November 5, 2026

Jack, after release 4132aeda: "the scrubber still doesn't work, saving frames doesn't work, and the upload
button is still grayed out ... We're all supposed to be fixed and pushed with that, but there are still
problems on prod." Released from Jack's PC through fm-agents-1.

It is release `6249b30a` (tracker FM-336, what every host ran) plus five commits on
`hotfix/resources-customer-orders-20261105`, cherry-picked unchanged:

- `b219d5f2` (canonical `3b022cc7`, on dev as `platform-20261105041200-a80d69fb`): Node.
- `bc980493`, `64d8f15f`, `db444581`, `cad6a00b` (lane `aeb4b58d`, `8880df9b`, `0b9679a6`, `e2e628ff`; on dev as
  `measure-internal-20261105041235-0add41a7` … `-20261105042636-820f08fc`): editor and Resources PHP.
  Production's copies of the five lane files equalled the lane base before, so no other lane work comes along.

## Cause

- **Save Frame** answered 404 on every customer order (six on compatibility in two days, all on
  "Structure 1 video walkaround"): `project_resources.php` served only internal `fullhouse_` drafts and
  training projects. Frames could also not name a customer's walkthrough (`customer-reference-N.webm`) as
  their source, and the job read the whole video into PHP (128 MB limit; the failing walkthrough is 78.5 MB).
- **Upload** was disabled for every `exteriors_` order in `project_resources.js` since September 21, and the
  Resources list was forced empty for them. Node also refused `internal-resource`/`internal-markup` files on
  anything but `fullhouse_` drafts.
- **Scrubber**: release 4132aeda added byte ranges (prod logs show 206s and the whole download), but was
  verified with MP4s only. The failing walkthrough (`exteriors_6e0db661…`, `customer-reference-0.webm`) is
  muxed by LibWebM with no Cues and an Info Duration of 0.0. Chrome then reports an infinite duration
  (reproduced with a synthetic file of the same shape), the seek bar was disabled and showed 0:00 / 0:00.

## Change

- **Node** (`firstmeasure/api.ts`): on a customer Full House order (`exteriors_<32 hex>`) the internal
  Resources files are listed and readable for a staff principal (session or signed PHP request); a customer
  session or a signed file link still gets 403. Routes and their access declarations are unchanged.
- **PHP** (`project_resources.php`, `_resource_frames.php`, `_full_house.php`): customer orders are served for
  staff, every call checked by Node as that staff member. Save Frame accepts `customer-reference-N` videos,
  checks the source exists from the listing, and streams a plain stored video to disk once (cached by size
  and update time) instead of reading it into memory.
- **Editor** (`project_resources.js`): Upload and the Resources list work on customer orders; customer files
  keep their stored name so a saved frame links back to its walkthrough. A video whose duration is infinite
  is sought past its end once so Chrome reads its length, then returns to the time asked for; a drag or Play
  during that is kept; the downloaded copy takes over from a stream still reading the length.
- No database, migration, dependency, environment or config change. No production data changed.

## Checks before release

- `tests/full-house-customer-resources.test.ts` (new) and `tests/full-house-access.test.ts` pass;
  `tests/route-access.test.ts` fails only the project-list assertion (line 132) recorded as pre-existing in
  release 4132aeda. `dev/resource-frame-extract.test.cjs` passes on fm-agents (PHP and ffmpeg), including a
  customer order through the real `project_resources.php`. `dev/resource-catalog.test.cjs` passes.
- Dev, headless Chrome as the pilot technician with editor saves blocked: Upload enabled and a 22.5 MB
  synthetic recorder WebM (no Cues, Duration 0) uploaded; it shows 1:29 and seeks; at 3 MB/s it settles on
  the downloaded copy and seeks; Save Frame on it and on a customer walkthrough (`exteriors_9182bb21…`) saves
  the frame with its "Jump to video" link.
- Build on the dev worker in 270 s (`npm run check` included): archive sha256
  `8aaa1b1224d896bd9546f93e7eefccb22ba24dcf65dfa18d6cf5ce22f9aaaef1`, verified there, on compatibility and on
  the worker. The five lane files and `api.ts` are byte-identical to what ran on dev.

## Rollout

- Waited for the tracker's FM-336 production rollout to finish (ROLLOUT_DONE 04:38:26 UTC), then stopped
  `tracker-router@bugs` with nothing in flight.
- Compatibility at 04:47 UTC from `6249b30a`: ready on `cad6a00b`.
- Worker at 04:48:02 UTC after no running jobs: 8 slots, production, heartbeat off.
- Signed channel published from the release directory against `8a369599…` (6249b30a's archive); a web node
  downloads `cad6a00b` / `8aaa1b12`.
- Six web nodes one at a time behind the load balancer, 04:49:22–05:02:19 UTC, each back behind the load balancer
  on the new release before the next.

## After activation

- Public readiness answered `cad6a00b` on 12 of 12 requests; all eight hosts point `current` at `cad6a00b`, and
  each carries the built Node change, the editor's length probe and the PHP customer-order gate.
- Not exercised on production by me: an upload or a saved frame would write into a customer's order. The first
  technician's Save Frame on a customer order should answer 202 on compatibility (it answered 404 before).
- Tracker router started again after this record was pushed.

Rollback target: `6249b30a`.

Note: the tracker's FM-335 release (`ab5e8a9f`, rolled out 03:49 UTC) is not an ancestor of `6249b30a`, so
FM-336's release may have replaced FM-335's change on production; neither had a record on production-live
when this was written.
