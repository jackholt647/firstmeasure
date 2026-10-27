# Optimization backlog

The one place that lists work deferred on purpose to a later optimization pass. Each entry says what is slow or
wasteful today, where the change goes, and why it can wait. None of these changes what any feature computes: an
optimization here must return exactly the same results.

Add an entry when you knowingly ship something that reads more than it needs, repeats work, or will not scale, and
link the entry from the architecture doc's "Not built" section. Remove an entry when it is done.

## The price book setup sends its options once per step

**Today.** The roofing price book setup's steps share one guided source (`pricebook.roofing_setup`,
`public/v1/guided-experiences/definitions/materials.ts`), and `resolve` in `guided-experiences/service.ts` fills each
step's `options` with its own copy: about 58 KB (every manufacturer's products, the generic items, the kinds of roof and
the suppliers) five times in the experiences list, about 290 KB, each time the list is fetched while the setup is
unfinished.

**Where the change goes.** Resolve each source once per response and let steps name it (`options_ref`), or send the
source once beside the steps; the widgets read the same data.

**Why it can wait.** The list is fetched only while the setup is unfinished for someone who may run it, which is once
or twice per organization, and the payload compresses well.

## The Labor column reads every material list when nobody does labor

**Today.** For an organization whose Labor column waits for someone to do labor (`shown: when_configured` in Operations setup, or legacy `shown: with_assignees`, saved when the
price book setup's labor step is skipped) and that has no group, outside company or pay sheet yet,
`laborColumnShown` (`public/v1/materials/resource-types.ts`) reads every material list to see whether a labor list
exists, each time the resource types are listed (opening the Materials tab, generating).

**Where the change goes.** Keep a count of non-archived labor lists per organization, updated by the material list
writer, or answer it from an indexed query on `resource_type`; the answer stays the same.

**Why it can wait.** Only organizations that skipped the step and still have nobody to do labor reach the read, and
those are new organizations with few lists. Every other case answers before it.

## Projects map loads every project and geocodes addresses in the browser

**Today.** My Projects > Map (`public/libraries/apps/projects/map-view.js`) asks `list_projects` for every project
(`limit: 0`, as Stages and the board list already do) and places each one from its stored pins or lat/lng. A project
with only an address is geocoded in the viewer's browser with the Google Maps geocoder, one at a time (at most 250 a
session), and the result is cached in that browser's localStorage (`fm_projects_map_geocode_v1`), so every person and
device geocodes the same addresses again and nothing is shared.

**Where the change goes.** Store a geocoded point on the platform project when its address is written (lead intake,
`createProject`, address edits) and backfill existing projects once; the map then reads the point from the project
record like it does pins today, and the browser geocoder and its cache go away. For very large organizations, a
bounds-limited projects query (only what is in view, clustered on the server) replaces loading every project. The pins
shown stay the same.

**Why it can wait.** Organizations have hundreds of projects, most FirstMeasure orders already carry pins, and the
cache means an address is looked up once per browser; Google's geocoder allows far more than this per second.

## Website forum search reads every thread file

**Today.** Forum search (`website-next/forum/index.php`, `?q=`) opens every thread's JSON file and scans each post body
for the query, newest first, stopping at 50 matches.

**Where the change goes.** Keep a small lowercase word index (word to thread ids) in the forum data directory, updated
by the same locked writers, and open only the candidate threads; the matches and their order stay the same.

**Why it can wait.** The forum is new and holds a handful of threads; a full scan of a few hundred small files takes
milliseconds.

## Session replay search for people and organizations scans their tables

**Today.** "Who is recorded" finds people and organizations with `ILIKE '%text%'` over `platform_identities` and
`platform_organizations` (`searchIdentities`, `searchOrganizations` in `platform/storage_postgres.ts`), which reads
every row and returns the first page.

**Where the change goes.** A `pg_trgm` GIN index on the email, name and id expressions makes the same query use the
index; the results stay the same.

**Why it can wait.** Only platform administrators search, a few times a session, and tens of thousands of rows scan in
milliseconds. (docs/architecture/session-replay.md, "Who is recorded")

## Session replay chunk bodies live in the database

**Today.** Every replay chunk body (gzip JSON, a few KB each, one every 20 seconds per active person) is a `BYTEA` row
in `session_replay_chunks` (`session-replay/storage.ts`), and the viewer reads them back through the platform API as
base64.

**Where the change goes.** Write chunk bodies and blobs to object storage (Spaces) under
`<org>/<session>/<page>/<seq>.json.gz`, keep only the metadata rows, and let the viewer fetch signed URLs. The bytes
stored and replayed stay the same.

**Why it can wait.** It only records organizations a platform administrator switched on, and dev volumes are small.
Database storage costs about five times object storage, so it matters before replay is on for many organizations.
(docs/architecture/session-replay.md, "Not built")

## Session replay seeks back by rebuilding the page

**Today.** Seeking backwards in the viewer rebuilds the page from its snapshot and re-applies every event up to the
new time (`applyTo` in `public/libraries/session-replay/session-replay-player.js`).

**Where the change goes.** Keep a cloned keyframe of the mirror (DOM plus id map) every minute of a page and start a
backwards seek from the nearest one. The replayed DOM stays the same.

**Why it can wait.** Rebuilding takes tens of milliseconds for the pages recorded so far; it matters for hour-long
single-page sessions. (docs/architecture/session-replay.md, "Replay and the viewer")

## Session replay asks for its configuration on every page load

**Today.** Every signed-in page load sends one `GET /v1/platform/session-replay/config`
(`session-replay-loader.js`), which resolves the organization's capabilities, even when replay is off.

**Where the change goes.** Put the flag in the page bootstrap (`window.__APP` in `portal/index.php` and the other
shells) and only fall back to the request where the bootstrap does not carry it. The decision stays the same.

**Why it can wait.** One small authenticated request per page load next to the dozens a page already makes.
(docs/architecture/session-replay.md, "How a page is recorded")

## Session replay flows scan steps

**Today.** `replay_flows` reads a screen's click steps (up to 200,000, ordered by session) and counts paths in memory
(`flows` in `public/v1/session-replay/insights/query.ts`). At 5,000 sessions that is 250 ms.

**Where the change goes.** Count paths of length 2 to 4 per screen and day at index time, next to the transitions,
and read longer paths from a random sample of sessions. The paths and counts reported stay the same for the lengths
kept.

**Why it can wait.** It answers in a quarter of a second at today's volumes and is not on any page.
(docs/architecture/session-replay-search.md, "Not built")

## Session replay friction groups error messages per call

**Today.** `replay_friction` reads up to 20,000 error steps of the period and groups messages in memory.

**Where the change goes.** A per-day aggregate of error messages (normalised key, screen, count, sessions) kept with
the other aggregates in `insights/store.ts`. The lists returned stay the same.

**Why it can wait.** About 100 ms at 5,000 sessions. (docs/architecture/session-replay-search.md, "Not built")

## Session replay indexing lists sessions newest first

**Today.** Each minute the index job pages through recordings newest first, up to 2,000, to find sessions that are
new or changed since they were indexed (`indexPendingReplaySessions` in `insights/jobs.ts`).

**Where the change goes.** Keep a watermark of the newest fully indexed `last_at` and read only past it, plus a queue
for re-indexing after an `INDEX_VERSION` change. The sessions indexed stay the same.

**Why it can wait.** Two small queries a minute at today's volumes.

||||||| parent of fe90d4bb (Session replay archives: re-tokenize finished sessions across sessions, losslessly)
## Session replay archives decode a whole session to serve one page

**Today.** The chunks endpoint restores every page of an archived session to serve one page's chunks
(`readArchivedPageChunks` in `session-replay/archive.ts`) and keeps the last six decoded sessions in memory for ten
minutes.

**Where the change goes.** Compress each page as its own zstd frame in the archive, with a small index of frame
offsets, so one page is decompressed on its own. The restored chunks stay the same.

**Why it can wait.** Archived sessions are opened rarely, and a session of a few hundred KB decodes in milliseconds.
(docs/architecture/session-replay.md, "Archives")

## Session replay vocabulary versions are read whole

**Today.** Loading a pinned vocabulary reads every token blob of its generation up to that version
(`readTokens` in `session-replay/archive.ts`), even when the version before it is already in memory, and an archive run
reloads the newest organization version from its rows.

**Where the change goes.** Extend a cached earlier version with only the newer blobs, and keep each generation's
token list once per process. The vocabulary read stays the same.

**Why it can wait.** A generation is capped at 500 versions and 60,000 tokens, and the result is cached per pinned
version. (docs/architecture/session-replay.md, "Archives")

## Session replay archive runs hold a whole session in memory

**Today.** The archive task reads one session's chunks, its canonical form and its archive into memory at once, and
skips sessions over 48 MB as recorded (`maxSessionBytes`), which then stay live.

**Where the change goes.** Archive page by page into separate frames (as above) so memory follows the largest page,
and lift the limit. The archive bytes per page stay the same.

**Why it can wait.** Recorded sessions are tens to hundreds of KB; a session stops accepting chunks at 256 MB.
(docs/architecture/session-replay.md, "Archives")

## Exterior PDF dimension drawings rasterize the whole house per face

**Today.** With house context on, each Wall/Trim Dimensions drawing rasterizes every house face (walls, roof,
chimney tops, trim) behind the measured face (`drawDiagram` with `context` in
`public/measure/internal/editor_scripts/exterior_pdf.js`), so the work grows with faces times house size. On the
pilot house that is about 12 ms more per face.

**Where the change goes.** Cull context faces to the drawing's frame and to the region behind the face plane before
meshing them (or cache each face's mesh across drawings) in `rasterScene`. The pixels drawn stay the same.

**Why it can wait.** About a second on a 66-face house, inside a PDF that takes several seconds anyway.
(dev/EXTERIOR_REPORT.md, "House context behind wall dimension drawings")

## Contact date rules read every contact

**Today.** A rule on a date on each contact (`schedule.contact_date`) reads every contact of the organization when its
time of day comes (`emitContactDateEvents` in `work/scheduler.ts`), once per rule per day, and compares the date in
code.

**Where the change goes.** An index on the contact date (the birthday in `extra_json`, or a date custom field) as
month-day and full date in the contacts store, and a query for the target day in `emitContactDateEvents`. The events
it emits stay the same.

**Why it can wait.** One read per rule per day; it matters only for organizations with very many contacts and several
date rules. (docs/architecture/automation-authoring.md, "Rules that start from a contact")

## Indexed selections and change feeds for pay refresh

**Today.** A pay rule declares its inputs as selections (`platform/publication/select.ts`). Every selection is
answered by reading the whole published collection and filtering it, up to 50,000 rows, so pricing one person's June
hours reads every shift. Every refresh selects all inputs again; unchanged results are skipped by digest, but the
reads still happen.

**Where the change goes.** Both halves are centralized and are drop-in:

- *Indexes:* a provider adds the optional `select` hook already declared in `platform/publication/providers.ts`.
  `selectPublishedData` uses it when present and falls back to the scan otherwise (`selectionSupport` reports which).
  The hook must return exactly the rows the scan would, so no rule, plan or setup changes. Add a test per provider
  that runs the same selections both ways and compares.
- *Change feeds:* a source publishes "rows changed since revision N". A refresh then starts from those rows and uses
  `pay_rule_evidence` (already stored, keyed by source row) to find the earnings they affect, instead of selecting
  everything. This lives in `payroll/pay-refresh.ts` only.

**Why it can wait.** Results are identical either way; only cost changes. Worth doing when a real organization's time
clock, projects or commitments make a refresh noticeably slow, starting with the time clock.
(docs/architecture/pay-rules.md, data-publication.md "Declared selections")

## Pay previews and projections run every payee's rules

**Today.** Previewing a rule, plan or default change, and the managers' projected earnings totals, evaluate every
affected payee's rules on demand, capped at 200 payees (results say `truncated` beyond that). The projected totals
only run when someone presses the button for that reason.

**Where the change goes.** `payroll/pay-rules.ts` previews and `projectPayeeEarnings` in `payroll/pay-refresh.ts`:
reuse stored unit digests, and run payees in batches in the background with progress instead of one request.

**Why it can wait.** Organizations on the platform are far below 200 payees.

## Payroll bills and payment routes read whole collections

**Today.** Payees paid through payables (`payroll/payables.ts`): working out how each payee is paid reads every user
document and every outside company once per pay run draft, reopen and upcoming preview; the bills list
(`payroll.bills`), the reconcile action and every pay run action's bill sync read every payable and keep the payroll
bills, then read each bill's pay run. Export templates that show branches or departments resolve the whole
organization structure, and approved hours read the pay period's shifts (up to 1,000).

**Where the change goes.** Payables stored with an index by kind and by `source.batch_id` in `payments/storage.ts`
(a Money change), and a payee lookup by id in place of the user list in `paymentRoutes`. Results do not change.

**Why it can wait.** Pay runs hold tens of payees and an organization has hundreds of payables, not thousands.
(docs/architecture/pay-rules.md "Paid with payroll or through payables")

## Labor commitments are listed by reading the whole collection

**Today.** Commitments for a project or an assignee are found by reading every commitment and filtering
(`labor/commitments.ts`; the published `labor_commitments` source does the same).

**Where the change goes.** An index by project and by assignee in the labor store, and the `select` hook on the
published source (see the first entry).

**Why it can wait.** Fine until an organization has many thousands of commitments. (docs/architecture/assignees.md)

## Assignee directory and roster read everything on every request

**Today.** The assignee directory reads every assignee, and each user's custom fields one at a time, on every read.
The roster's conflict check reads every project's schedule events.

**Where the change goes.** `public/v1/assignees/directory.ts` (batch the field reads; cache per request) and
`roster.ts` (read events for the window and the assignees involved only, through an index on schedule events).

**Why it can wait.** Small organizations; the cost grows with users times fields and with total events.
(docs/architecture/assignee-base.md)

## Schedule roster reads every project

**Today.** `schedule-roster.events` (`public/v1/scheduling/roster.ts`) answers up to 200 events per read. It reads
every project and calendar event once per read to find the other work in the window the events cover, keeping only
events in that window that name an assignee, and `assessAssigneeOverlap` reads them all again for the overlap check.
Time off and the scheduling settings' days off are read once per read. Each event still runs `checkAssignment`, which
loads the assignee directory (with the fields of only the people involved) and the base records, so a read of a busy
week does that once per event.

**Where the change goes.** An index on schedule events by time and by assignee key, read by both `scheduledWork` in
`assignees/roster.ts` and `scheduledEvents` in `scheduling/occupancy.ts`, so one bounded query serves the window.
For the per-event directory load, `checkAssignment` / `loadRoster` would take an already loaded directory as one more
`sources` entry (an assignee-base change: the contract itself is unchanged).

**Why it can wait.** The views ask only for the events on screen, in one read per render, and cache the answer for a
minute. Cost grows with the total number of events and with events on screen.
(docs/architecture/schedule-events.md, "Roster and warnings")

## Payroll work roster reads every scheduled event

**Today.** `payroll.work_roster` and the time clock's projected reading (`public/v1/payroll/roster-sources.ts`,
`workRosterRows` and `projectedShiftRows`) read every project to find the schedule events that name an assignee, then
ask `readEventRosters` for each of them in batches of 200, each batch paying the schedule roster's own cost (see
[Schedule roster reads every project](#schedule-roster-reads-every-project)). A split rule that reads the roster selects
it once per group refresh, and a projection of a rule that reads the time clock selects the projected reading once per
payee, so a refresh of many groups reads every event's roster once per group.

**Where the change goes.** `workRosterRows` only: take the window from the selection (the earliest and latest earned
day the refresh can touch) instead of reading every event, and keep one answer for a whole organization refresh
rather than one per group. With an index on schedule events by time and assignee (the schedule roster entry), the window
becomes one bounded query.

**Why it can wait.** Organizations on the platform schedule a few hundred events, a roster read is milliseconds per
event, and an unchanged refresh skips the formulas by digest; only the reads repeat.
(docs/architecture/pay-rules.md, "Split rules" and "Projected earnings")

## Stats datasets over full scans and fast-changing sources

**Today.** Stats materializations accept sources that can only be fully scanned; very high-cardinality or
continuously changing sources still need an indexed or snapshot adapter.

**Where the change goes.** A provider-specific adapter per such source. (docs/architecture/stats-materializations.md)

**Why it can wait.** No current dataset hits these limits.

## Generation outcomes read one query per run

**Today.** `history/outcomes.ts` answers `project-history.generations` and `generation-outcomes` by listing runs,
then, for each run, reading the next run of the same list and that list's changes in between. Reading 500 runs
across an organization is about 1,000 small queries.

**Where the change goes.** `generationsWithOutcomes` only: read the runs and the `project_changes` rows of their
subjects in one ranged query each, then pair them in memory. The outcome must stay exactly the same, so compare both
ways in `tests/project-history.test.ts`.

**Why it can wait.** It is read only by an agent looking for patterns, on demand, and is fast for the run counts a
company has today. (docs/architecture/project-history.md, "Known limits")

## Contact options and projection fan-out

**Today.** `contactOptions` (`contacts/service.ts`), which fills typed contact pickers, pages through every contact
(up to 5,000) and returns them all. A contact edit rewrites `project.contacts` on every linked project, one document
write each (`refreshProjections` in `contacts/records.ts`). Contact file import (`buildExistingContactIndex` in
`platform/contact_import/api.ts`) and the partner-sharing contact list (`sharingOptions` in
`collaboration/resources.ts`) page through every contact to match or list them.

**Where the change goes.** Pickers call `contacts.records` with a text query instead of loading options, and options
is removed; import matches each row with `findExactMatches` plus a name query and sharing pages with a cursor. The
fan-out goes away when readers use the contacts client instead of the projection.

**Why it can wait.** An organization has few contacts per project, and pickers stay fast below a few thousand
contacts. (docs/architecture/contacts.md)

## CRM views build every row on every query

**Today.** A CRM query (`crm/records.ts`, `crm/views.ts` `runQuery`) reads every project, plan, contact link and user
of the organization, builds a row for each, then filters, sorts and groups in memory; the opportunities collection
also reads every open actionable node for next follow-ups, every result for last touch, and (`crm/funnel.ts`
`projectMilestones`) every work event of the funnel's types, plus every node when a step names a scope step. The rail
counts run one such query per pinned view, and the funnel report builds the whole opportunities collection.

**Where the change goes.** Keep the row builders as the one definition of a row, and make them incremental: a
`crm_rows` table per collection refreshed from the domain events that change a row (project and plan writes,
`work_events`, results), with an index on the fields views filter and sort on most (state, stage, source, dates). A
query whose filter only names indexed fields selects from the table; anything else falls back to today's scan. The
milestone read becomes a per-project milestone table written when a matching work event is processed. Add a test that
runs every preset view both ways and compares rows.

**Why it can wait.** Organizations on the platform have hundreds to a few thousand projects; a query takes tens of
milliseconds there. Worth doing when a view takes over half a second, starting with the rail counts.
(docs/architecture/crm.md, "Views")

## Sticker hover copies the wall edits

**Today.** Hovering with a sticker (window, door, feature) tool must not change the saved model, but finding the host
face and its snap scene materializes a draft for every wall. Each preview frame therefore deep-copies the project's
wall edits, previews against the copy and drops it (`perf_previewFeature` in
`public/measure/internal/editor_scripts/wall_face_draft.js`).

**Where the change goes.** Give `placementHost` and `stickerPlacement` a read-only scene: the derived wall drafts
built once per tool session and reused until the wall edits change, with the same faces and snap targets the
materializing scene produces. Add a test that compares placements made both ways.

**Why it can wait.** Previews already run at most once per animation frame, and building the scene costs more than
the copy. Worth doing if sticker hover is slow on a large saved house.
(dev/EXTERIOR_ENGINE.md, "Saved-model safety, 2026-10-18")

## Base previews rebuild the whole sketch graph per pointer move

**Today.** Every face drag, height and pitch preview in the base editor calls `BaseSketchGeometry.rebind` on the whole
base for each pointer move (`base_editor.js` `move` and `preview`). `rebind` now narrows its searches spatially and
reuses the plan outline when only heights change, but a plan drag still recomputes the outline union of every face,
and the kernel's curve matching (`annotateCurveGraph`) still scans a curve's samples for each edge near it. A base
with four arcs (about 1,000 face points) previews in roughly 50-70 ms.

**Where the change goes.** Rebind only the faces the preview changes plus their neighbours, keeping the rest of the
graph, and give `curveEdgeRange` a spatial index of each curve's samples in `exterior_geometry.js`. Compare the
partial result with a full `rebind` in a test, as `dev/base-editing-regressions.test.cjs` does for the curve test.

**Why it can wait.** Bases without curves preview in a few milliseconds, and the curved case is several times faster
than before the 2026-10-18 changes. Worth doing if a heavily curved foundation stutters while dragging.
(dev/EXTERIOR_ENGINE.md, "Base editing, 2026-10-18")

## Signing ledger appends share one lock

**Today.** Every signing write that appends to the ledger (`documents/signing/ledger.ts`) takes one global lock,
`platform-store:document_signing:ledger`, inside its document's transaction, because the chain is a single sequence
across all organizations. Signing is serialized platform-wide for the duration of that transaction.

**Where the change goes.** Give each organization its own chain (prev_hash per organization) and anchor all chain
heads together in one Merkle root per interval. Verification then checks the organization's chain and the Merkle
path. Entries and their hashes stay the same; only how they link changes.

**Why it can wait.** Signing is a few writes per agreement, so the lock is held for milliseconds and contention
needs thousands of concurrent signers. (docs/architecture/document-signing.md, "Seal, timestamp and signing ledger")

## Wall drafting redraws serialize the whole project to validate their caches

**Today.** Every draw pass serializes the project state and composed walls (`beginRenderCache` in
`wall_face_draft.js`) to decide whether derived geometry is still valid; wall mode serializes only the composition's
inputs (`wallSceneInputs`, about a quarter of the state) to reuse composed walls. On a 420 KB house the full
serialization is about 1 ms, several per frame. Frames whose model
changed (a preview that moved, undo) also rebuild every face's parts, the wire graph and support faces.

**Where the change goes.** Compute one value signature per redraw in wall mode and give it to the drafting editor
through its host, in place of its own serialization (walls and visibility flags appended as today). Finer reuse on
changed frames needs per-face dependencies: chimney clipping reads the whole building, so only faces whose inputs are
known can be reused by content.

**Why it can wait.** Correct invalidation depends on the full key; it is a fixed few milliseconds per frame.
(dev/EXTERIOR_PERFORMANCE.md, "Draw memos")

## The 2D wall view rebuilds every SVG element each redraw

**Today.** Wall mode clears the SVG and `draw2D` emits every wire, draft edge, point and line-center tick again on
each redraw, about 3.5 ms per frame on a large house even when nothing moved.

**Where the change goes.** Retain SVG elements keyed like the 3D render parts and update only changed attributes,
in `wall_mode.js` `render2DContent` with the drafting editor's `draw2D`.

**Why it can wait.** The output is correct and the cost is bounded by the number of visible elements.
(dev/EXTERIOR_PERFORMANCE.md, "Draw memos")

## Exterior selection rebuilds the whole scene

**Today.** Clicking a face, line or point in the full-house editor runs a full exterior render: the face-draft
objects, labels and the 2D plan are rebuilt to show the new highlight. On a heavily drafted house (about 1,200 points,
171 surfaces) a click costs roughly 40-50 ms (`wall_mode.js` `render`, `wall_face_draft.js` `draw3D`/`draw2D`). Only
point markers have an in-place highlight path (`redrawSelection`).

**Where the change goes.** Give faces and lines the same treatment as point markers: keep the built objects and
recolour the previously and newly selected ones, falling back to a full render when the selection changes geometry
(previews, guides). Compare the recoloured scene with a full rebuild in a WebGL test.

**Why it can wait.** A click is a single frame, and the 2026-10-19 speed pass removed the shader recompiles and
occlusion work that made it longer. Worth doing if selection still feels late on large houses.
(dev/EXTERIOR_PERFORMANCE.md, "Speed pass, 2026-10-19")

## Each committed exterior edit copies the state several times

**Today.** Placing, undoing or redoing an exterior edit snapshots the history keys with `JSON.parse(JSON.stringify())`
in `recordEdit` and again in `finishEdit`, compares the two snapshots as strings, then `persist` reads, parses and
rewrites the whole local backup (`wall_mode.js`). On a 420 KB state that is about 10-20 ms per commit.

**Where the change goes.** Build the after-snapshot once and share unchanged subtrees with the before-snapshot (as
`EditorHistory.share` already does for stored history), and keep the last written backup timestamp in memory so
`persist` only reads storage when another tab may have written it. Keep the existing reload and multi-tab tests.

**Why it can wait.** It runs once per commit, not per frame, and is a small part of an undo (about 60 ms in total).

## Textured mode redraws its shadow map while idle

**Today.** In textured display the editor re-renders the lit presentation scene, including a 4096 x 4096 soft shadow
map, at the 100 ms idle interval even when nothing moved (`scene_3d.js` `_animate3D`, `exterior_rendered.js`
`render`). The shadow map depends only on the shadow casters and the sun, not on the camera.

**Where the change goes.** Turn `shadowMap.autoUpdate` off for the presentation scene and request a shadow update from
`update`, `lighting` and any visibility change of a caster; a test should compare a frame drawn with the reused map
against one with a fresh map after each of those changes.

**Why it can wait.** Drafting happens in the translucent and opaque modes; textured mode is for review. Worth doing if
textured review drains laptops or slows other tabs.

## Exterior point projection reads layout per point

**Today.** `host.screen` in `wall_editor.js` and `wall_mode.js` reads `renderer.domElement.getBoundingClientRect()` for
every projected point during previews and snapping, a few hundred times per frame on a large house (about 1 ms per
frame). Inside `renderer.render` these reads already share one rectangle (`exteriorRendererRect`).

**Where the change goes.** Cache the rectangle per animation frame and invalidate it from a `ResizeObserver` and any
pane-layout change; prove the canvas cannot move during a frame before reusing the value outside rendering.

**Why it can wait.** The reads are cheap once layout is clean; the cost is mostly call overhead.

## Face-move previews rebuild the scene topology every frame

**Today.** Moving a whole face (M, or E on a draft region) recomputes the vertex/edge topology of the gesture's
entire snap scene on every pointer move (`moveSurface` and `moveFabric` in `wall_solid_geometry.js` call
`ExteriorGeometry.topology`, whose edge chaining scans every vertex for every edge). On the 420 KB benchmark house
that is roughly a quarter of a face-move frame (about 15 of 60 ms, CPU only).

**Where the change goes.** Build the topology once per tool session from the tool's scene and pass it in, and give
`topology` a spatial index for its edge chaining. Before caching, the tool scene must really be read-only:
`applyRoofMoves` writes heights into whatever `edits.$surfaces` holds, and `moveFabric` returns unchanged faces by
reference, so a roof fit can currently write through to scene faces. Compare cached and rebuilt previews with
`dev/exterior-preview-equivalence.test.cjs`.

**Why it can wait.** Line moves and extrusions (the common drags) do not use it; face moves are slower but stay
interactive on typical houses. (dev/EXTERIOR_PERFORMANCE.md, "Preview interaction, 2026-10-19")

## Geometry moves retry hundreds of full previews when the requested move is invalid

**Today.** When a geometry transform (M on selected points or a face) cannot move as far as the cursor asks,
`validTranslation` searches for the nearest valid translation by building complete candidate previews: up to about
700 builds per pointer move, each copying the wall edits, transforming the selection, following trim and validating.
On the benchmark house that is seconds per pointer move while the cursor is past the limit.

**Where the change goes.** `previewGeometry` in `wall_face_draft.js` and `validTranslation` in
`wall_solid_geometry.js`: validate a candidate translation without building and copying the whole result (a check
that answers exactly what `build` answers), or remember the last valid limit for the gesture and search only when
the cursor crosses it. The search's answer must not change.

**Why it can wait.** It only happens while dragging beyond a valid position; valid moves preview in one build.
(dev/EXTERIOR_PERFORMANCE.md, "Preview interaction, 2026-10-19")

## Preview frames still deep-copy the wall edits and reconcile chimneys

**Today.** Each line, entity and face preview frame copies the gesture's snapshot of the wall edits (and line moves
also copy their snap scene), then `prepareEdits` copies the result again before publishing it and re-fits every
vertical face to chimney roof contacts (`reconcileChimneys`, `WallChimneys.alignRoofContacts`). The extrude and face
move tools also copy the shown preview for rollback. The copies are now an exact non-text clone (about 5 times faster
than the JSON round trip), but on the 420 KB house each is still 0.5-1 ms, and the chimney fit is about 2-3 ms.

**Where the change goes.** Share unchanged members of the snapshot instead of copying them, as line moves already do
(`shareWithDrafts`), once each writer that changes edits in place is known; and restrict `alignRoofContacts` to faces
and draft points near a chimney footprint (a bounding-box test that keeps its exact contact tests).

**Why it can wait.** Rendering dominates the frame time on large houses. (dev/EXTERIOR_PERFORMANCE.md,
"Preview interaction, 2026-10-19")

## Resources frame extraction reads the whole video

**Today.** To save one video frame, `public/measure/internal/_resource_frames.php` copies every stored part of the
video from artifact storage into a temporary file on the PHP host, then runs ffmpeg on it. The copy is reused for an
hour on that host, so saving several frames from one walkthrough fetches it once, but a different host, or the first
frame, reads the whole video (about 25 requests for a 200 MB walkthrough) to decode a few seconds of it.

**Where the change goes.** Only `fm_resource_frame_video_file`: give ffmpeg a byte-range source instead of a full copy
(a local range endpoint or an `ffmpeg -i` URL backed by the part index), so only the container index and the parts
around the frame are read. The frame chosen must stay exactly the same (the extraction test checks frame identity).

**Why it can wait.** It is server-to-storage traffic in the background; the browser sends no image and the UI never
waits on it. Worth doing if frame saves on long videos feel slow or storage egress matters. (dev/RESOURCES_UI.md,
"Server-side frame saving")
## Payment checkouts and refunds scan collections

**Today.** `findCheckoutByPaymentId` (`payments/intake.ts`) derives the checkout id from the payment id and only
falls back to reading every `payment_checkouts` record for payment ids it did not mint. `refundsOf`
(`payments/provider_refunds.ts`) reads every payment transaction to find one payment's refunds, as `refundPayment`
already did.

**Where the change goes.** Store the checkout id in the payment's metadata lookup index and list refunds through a
`related_payment_id` metadata query in the storage layer.

**Why it can wait.** Both run once per refund or per unmatched processor event, on one organization's records.
(docs/architecture/payments.md "Not built")


## Typing into a document as sent resolves it twice

**Today.** `editDocumentAsSent` (`public/v1/documents/service.ts`) runs a full traced resolution of the document to
check that every written path is an input the document shows, then saves and resolves it again to return the
recomputed page. Each resolution reads the template, the project entities, sources and widget data.

**Where the change goes.** Validate the paths against the traced bindings the editor already has (cached per document
revision on the server), so only the post-write resolution runs. The paths accepted and the page returned stay the
same.

**Why it can wait.** It runs once per typed value, by one person, on one draft; a resolution takes well under a second
on dev. (docs/architecture/document-as-sent-editing.md, "Writing an input")

## A roof change after wall work runs the wall generator twice

**Today.** `smartRebuild` (`public/measure/internal/editor_scripts/wall_mode.js`) runs the full wall generator on the
roof the walls were built from and again on the changed roof, then applies only the difference
(`wall_roof_rebuild.js`). The first run repeats work that was done when the walls were built; about 0.25 s each on
the pilot house.

**Where the change goes.** Keep the edit-free generator output of the last build or rebuild with the wall state
(keyed by the roof signature and base) and reuse it as the "before" run. The walls and edits produced stay the same.

**Why it can wait.** It runs once per switch back to wall mode after a roof edit, not per edit or per frame.
(docs/architecture/exterior-roof-rebuild.md, "When it still falls back")
## Document history payloads are plain gzip JSON

**Today.** Each document revision's payload (a whole state at a checkpoint, a structural patch otherwise) is JSON
gzipped on its own (`json-gzip-1` in `documents/versions/codec.ts`). Small patches repeat the same keys and paths
(`params`, `scope_items`, `props.blocks`) and gzip has too little input to find them.

**Where the change goes.** Add an encoding in `codec.ts` (a token dictionary over document vocabulary and paths, or
a compressor with a shared dictionary) and make it `CURRENT_ENCODING`. Rows name their encoding, so older rows keep
decoding and nothing else changes; reconstruction and checksums are unaffected.

**Why it can wait.** Measured histories already store about a tenth of gzip whole copies (docs/architecture/document-history.md);
it matters once histories reach many thousands of revisions per organization.

## Document history keeps a head copy per document and lists recompute actor names

**Today.** `document_revision_heads` keeps the newest state and the one before it, gzipped, for every document,
template, theme and workflow, so a save diffs without replaying patches. Listing a document's revisions reads each
distinct user's record to show a name.

**Where the change goes.** Drop `parent_state` and rebuild it from the chain when a fold needs it; cache user names
per request or join them. Results stay the same.

**Why it can wait.** A head is two compressed copies per document, constant however long its history; a history list
names a handful of people. (docs/architecture/document-history.md, "Not built")

## A completed report scans every project to find the ones that link it

**Today.** When a FirstMeasure report becomes `completed`, `publishReportCompleted`
(`public/v1/firstmeasure/project-events.ts`) lists every project of the report's organization and publishes
`measurement.report.completed` on those whose `measurement_project` links the report. The report manifest keeps no
pointer back to its platform projects. The completed-report dataset projection
(`platform/publication/firstmeasure-datasets.ts`) makes the same scan.

**Where the change goes.** Record the platform project id on the report when the project links it (or keep a
report-to-project index updated by the project writer), and read the linked projects from it in both places. The
projects found, and so the events and datasets published, stay the same.

**Why it can wait.** It runs once per report completion, not per request, and organizations have hundreds of projects.
(docs/architecture/automation-authoring.md, "Report, document and materials milestones")

## Global search lists every scope template to decide whether scopes are offered

**Today.** `GET /organizations/:orgId/search/types` (`public/v1/platform/search/result-types.ts`) calls
`listScopeTemplates`, which reads every template's current version, only to count the ones switched on.

**Where the change goes.** Count enabled templates from the scope flags and the `scope_templates` rows without reading
versions. The count, and so the offered types, stay the same.

**Why it can wait.** The top bar asks once per page load (and after a switch changes), and organizations have a handful
of scope templates. (docs/architecture/app-experience.md, "Global search")

## Operations setup checklist lists suppliers and equipment

**Today.** `operationsSetupStatus` in `public/v1/operations/onboarding.ts` lists the organization's suppliers and fleet to derive completion each time the hub refreshes. This is read-only and reports the same existing records users can open; the guide keeps no second setup-completion boolean for those resources.

**Where the change goes.** Add indexed existence/count queries to the supplier and equipment domain readers, preserving their authorization and exactly the same completion criteria.

**Why it can wait.** The checklist is opened during initial setup, when these collections are small. Revisit before large organizations use the hub frequently.


### Message notification bell fallback authorization

`platform/notifications/view.ts` rechecks each retained message through
`channels/service.ts:messageNotificationVisible`. This repeats channel, message,
read-state and collaboration preference reads for the same viewer. A future
request-scoped cache/batch must preserve media/project access, per-message audience,
thread/channel mute, deletion and read-sequence results exactly. See
[notifications](architecture/notifications.md).
