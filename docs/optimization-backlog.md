# Optimization backlog

The one place that lists work deferred on purpose to a later optimization pass. Each entry says what is slow or
wasteful today, where the change goes, and why it can wait. None of these changes what any feature computes: an
optimization here must return exactly the same results.

Add an entry when you knowingly ship something that reads more than it needs, repeats work, or will not scale, and
link the entry from the architecture doc's "Not built" section. Remove an entry when it is done.

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
