# Exterior engine, version 2

The editor keeps its current controls and project format. Its geometry now passes
through a shared planar kernel and an explicit operation boundary. Existing wall
drafts, surface records and base records remain serialization adapters; they are
not independent boolean implementations.

## Responsibilities

| Module | Responsibility |
| --- | --- |
| `exterior_geometry.js` | Polygon union/difference/intersection, holes, triangulation, plane frames, shared vertex/edge incidence, and planar sketch partitioning. No editor state or DOM. |
| `exterior_model.js` | Clone command inputs, prepare extrusion topology once, build/validate candidate results, and explicitly reconcile chimney foundation changes. |
| `wall_solid_geometry.js` | Extrusion/movement constraints and adapters between world faces and the planar kernel. |
| `base_sketch_geometry.js` | Persistent drawing anchors and edges; resolve base levels on separate supporting planes. Wall drafts use the same partitioner in local coordinates. |
| `wall_chimneys.js` | Source volume, exposed envelope and provenance. `compose` and visibility queries are read-only. `syncFoundation` is an explicit construction/edit operation. |
| `wall_face_draft.js`, `base_editor.js` | Input, transient preview, selection and history. Rendering reads the result; it does not repair saved geometry. |

## Extrusion path

1. Capture the original face, adjoining faces, retained points and base. Build a
   shared incidence index, including points partway along another face's edge.
2. Translate the cap by the signed distance. Construct returns along attached
   edges and fit ground contacts to the relevant base plane. Clip horizontal
   wall sweeps below visible roof surfaces, adding planar roof-contact returns
   and first-contact corners. Roof constraints also apply to typed distances.
3. Use polygon difference to remove swept material from neighbors. Union
   coplanar returns, retaining explicit hole rings. Roof volume intersections use convex triangular prisms internally; their
   patches are unioned on each supporting plane before publication so internal
   triangulation edges never become model seams.
4. Apply the corresponding union/difference to ground-contacting base edges.
   An overhanging upper face does not keep the old foundation perimeter alive.
5. Validate finite coordinates, planarity and area before publishing the
   candidate. Placement creates one history entry. Undo/redo restores snapshots
   without running geometry cleanup on them.

Moving a connected face uses shared-vertex constraints. When a contained region
cannot move out of its plane while keeping its neighbor planar, the editor uses
the same sweep operation to create connecting returns. It must not silently
detach the region and leave its parent unchanged.

## Geometry rules

- World geometry is in metres. The polygon grid is `1e-6 m`; geometric contact
  tolerance is `1e-5 m`. Pixel snap radii and user-facing pick tolerances are
  separate interaction settings. Axis cuts use the geometric contact tolerance
  when deciding whether a hit is still the starting boundary.
- A planar region consists of an outer ring and hole rings. A base currently
  serializes holes as simple pieces for compatibility with the existing editor.
- Triangles and simplified polygon corners do not own user drawing points.
  Retained anchors survive merging and clipping whenever they still belong to
  the resulting region. Intentional deletion is separate from simplification.
- A shared XY position does not imply a shared vertex: different step heights
  remain distinct. Base sketch partitioning groups coplanar faces before walking
  their edges.
- Rendering and picking must not regenerate chimneys, merge faces, remove
  points, alter outlines or write history. An uninitialized base sketch has a
  read-only derived view until an editing command initializes it.
- Invalid placement restores the starting edit snapshot and clears the transient
  gesture. New commands should use `ExteriorModel.transaction` and validate
  before publication. Never turn a failed boolean into silent missing material.

## Extending the editor

Add a feature's dimensions, anchors, label and metadata in `wall_features.js`.
Use the existing in-plane drawing/movement commands for its shape. For a new
geometry operation, put the pure transformation in the geometry/model layer,
return all affected faces and anchors together, and add a thin input adapter.
Do not add another polygon clipper or a render-time repair path.

The incidence graph is derived from saved faces for each command; it is not a
new on-disk CAD format. The engine handles planar polygonal building surfaces.
Curved B-reps, arbitrary volumetric booleans and overlapping foundation levels
would require explicit additional model contracts.

## Verification

Run from the workspace root:

```powershell
node --test dev/*.test.cjs
node dev/exterior-engine-replay.cjs
node dev/exterior-engine-replay.cjs dev/fixtures/exterior-engine-reloaded.json
php -l public/measure/internal/editor.php
```

The two saved-house fixtures replay 160 inward/outward previews, including small
offsets and five-foot offsets. The broader suite covers shared moves, cuts,
features, steps, deletion, selection, typing, cancellation, loading and history.

With the isolated server running, open
`/measure/internal/editor_tests/engine_rebuild_check.html` in the browser holding
the saved test house. It works on a copy and checks that browser storage stays
unchanged. Run the extrusion checks and the combined grading check. The sequence uses a real retained shared boundary
point, applies H, types an inward extrusion and checks two exact undo/redo steps.
The drawing callback also rejects non-finite buffer coordinates and any model
mutation during rendering. Finally inspect the full editor and select its base.

Timing reports distinguish synchronous preview work from animation-frame waits;
background browser tabs can throttle frame scheduling. These checks cannot prove
every possible model is valid. Keep a new failing saved shape as a regression
fixture when extending the engine.

## Rebuild verification, 2026-09-09

- 334 Node regression tests passed, including both saved-model replays.
- 160 extrusion previews passed across the two captured house states.
- All 41 editor JavaScript files and inline diagnostic scripts passed syntax checks;
  `editor.php` passed PHP lint.
- The final browser sequence passed H on a saved shared edge anchor, a typed
  inward extrusion, placement, and two exact undo/redo steps. H took 50.1 ms.
- The full editor loaded the saved house and a normal click selected its base.
- A browser extrusion profile measured 22 ms to enter E and roughly 31–97 ms
  per synchronous preview update; these are observed timings, not frame-rate guarantees.


## Base ownership corrections, 2026-09-09

Base edits now call `BaseSketchGeometry.rebind` to reconstruct the graph from
current face boundaries. Construction segments are clipped per supporting face,
anchors are lifted onto that face's plane, and T junctions are split before edge
deduplication. Coincident XY locations at distinct step heights have distinct
node IDs. Renderers read node coordinates directly instead of looking up the
first face with a matching ID. Legacy version-1 graphs are upgraded at load.

`WallBaseBinding` transfers only anchors within the wall region being converted.
Bottom-edge anchors follow their support, and intersections shorter than the
contact tolerance cannot leave a numerical stub at an old height. Loading also
removes unrelated anchors copied into old base-bound surface records. It does
not infer a replacement shape for an already deformed wall face.

The clipping kernel no longer enables Clipper's StrictlySimple scanline join,
which split the real fixture's shared sloping chimney edge into two regions.
Actual repeated vertices are separated explicitly. Generated chimney foundation
provenance stays outside the editable graph; reserved legacy foundation IDs are
recognized when old sketch resolution discarded their metadata.

Verification: 340 regression tests passed, including the captured faulty base
and the cut/recess/pitch/raise sequence. All 41 editor scripts, diagnostic inline
JavaScript and PHP entrypoints passed syntax checks. The browser check used the
real wall and base editors, typed a 10 degree pitch and a 1.5 metre raise after H
and inward extrusion, verified both grade undos, checked every graph edge against
its support, and left browser storage unchanged. Final observed grading previews
were about 28 and 37 ms. The resulting walls and chimney were inspected visually.

## Line selection and sweep remnants, 2026-09-09

The outer viewport marquee dispatcher now defers clearing line selection until
its inner click picker decides the selection type. Shift/Ctrl/Meta additions
survive both event layers; a real marquee or a non-line click still clears them.

Generated wall sweeps discard a newly clipped remnant only when its area/longest
edge is at most 3 mm, its source width exceeds 30 mm, and it retains less than 1%
of the source area. Typed features and independent solid drafts are excluded.
This is a measured roof-seam tolerance, not an increase to the kernel's contact
or vertex welding tolerance. Load repair requires a swept surface with a known
consumed source region, and preserves other faces unchanged.

344 tests pass. Browser checks verified three additive Shift-clicks through the
viewport dispatcher and visually inspected the captured corner after remnant
repair. The saved project was read through a copy, without overwriting storage.


## Foundation step patterns

Select a sloped base face and press S. Each press adds a riser; mouse position
sets the phase, click/Enter commits, Escape restores both base and wall edits.
A flat base needs a pitch before it can define a stepped elevation range. The
Auto-step button routes to the active base or wall editor without switching
layers. Repeated keydown events do not accidentally add steps.

`WallSteps.basePattern` clips the current footprint into bands perpendicular to
the source gradient, materializes horizontal treads, and rebinds the base graph.
`stepPatterns` retains the source plane and pattern settings; `baseStepId` groups
treads so reopening a pattern recomputes the group using its current footprint.
Independent base cuts and neighboring base faces remain separate. Wall attachment
uses the same binding operation during preview and commit. Explicit wall-line
steps store `stepOverrides`; their segments retain their own elevation instead
of inheriting subsequent base changes. Other edges continue to follow the base.

Validation includes slope reversal, reopening a saved pattern after a footprint
edit, independent wall overrides, exact Escape/undo, plus a browser check on the
saved house after cut/extrude/pitch/raise. Three risers produced four horizontal
treads, with live wall attachment, exact cancellation and undo.


### Step width wheel control

Both line and foundation stepping use S for riser count, mouse position for the reference offset, and the wheel for horizontal tread width (up enlarges, down reduces). The wheel is captured only in an active stepping viewport; normal zoom and panel scrolling remain available elsewhere. Width is computed from the original geometry, not accumulated previews, and saved in step metadata. Fixed endpoints retain their elevations; residual first/last treads absorb the width change. With one riser there is no interior tread spacing to change; the chosen width takes effect as more steps are added. Width limits retain nondegenerate end treads and stop at the available run. Escape and undo restore the original geometry.

Browser smoke checks in step_fixture.html and engine_rebuild_check.html cover live wheel resizing, unchanged counts, wall attachment, placement, cancellation, and undo.


### Exact undo snapshots and point reselection

History captures the generated wall stages and chimney state together with base and wall edits. Undo/redo restores this snapshot without regenerating merged wall identities, since draft ownership refers to those identities. Base history completes after wall regeneration so redo includes the resulting geometry.

Point arrow nudges choose a connected segment by screen direction, use the existing line movement transaction, and reselect the resulting visible point. Edited surface points are picked before falling back to their original generated wall. Consumed draft points cannot win post-edit selection. The isolated browser point check exercises create, nudge, deselect/reselect, nudge, and exact undo/redo.

The 3D toolbar translucency toggle defaults on. Opaque display applies depth testing to exterior lines/points and full opacity/depth writing to surfaces across roof, walls, base, and grade; toggling back restores material settings. This is display-only and persists with the project.


### Fine step resizing without reference jumps

Wheel scaling uses exp(-pixelDelta * 0.0001), about 1.2% per 120-pixel wheel notch. The reference riser index is derived from the original count/phase, not the resized spacing. This prevents a whole-tread jump when scrolling crosses an integer reference index or passes through the default width. Original line and base anchors retain their run/plan coordinates; only their elevation follows the supporting tread. Focused regressions cover both sides of unit scale and base-to-wall anchor following.


### Deleted faces and chimney display clipping

Draft visibility must be checked on the authoritative source polygon before conversion to chimney-clipped display fragments. Converting points to world coordinates and back drops sketch node IDs, so checking deletedFaces/removedPoints against those fragments previously resurrected deleted faces visually while picking still rejected their source. Source filtering now covers consumed regions and deleted defining corners, including saved projects; rendering requires no data migration. The browser deleted-face check uses an actual corner deletion with a chimney present and verifies reload does not restore the phantom surface.


### Rectangle selection and sticker commands

Q resolves selected draft or edited-surface points into a common supporting draft. Its transaction retains the original pre-conversion snapshot for undo/cancel and preserves the active tool on placement failure. The trailing double-click cannot insert an extra point. Double-clicking during an H/V cycle commits the cut before inserting the new point.

Both classification and rendering use whole-region containment for holes. A corner touching an adjoining region is insufficient: the complete opening must fit inside its parent. This prevents a rectangle starting on a cut from becoming a hole in the region on the opposite side.

Plain W/D starts a new hovered-face sticker; Ctrl+W/D types the selected face, then cycles preset sizes on subsequent presses. The exterior sticker library and selected-feature controls belong to the bottom-right of the 3D pane and are excluded from geometry pointer handling.


### Signed face distances

Face move/extrude tools keep geometric distances in face-normal coordinates internally. The numeric input adapter maps positive distances inward and negative distances outward using the base footprint on either side of the wall. Where a footprint cannot determine interior, positive points away from the camera. The sign is captured once per operation; lateral/upward move modes keep their own existing axes.


### Point insertion after extrusion

Sketch resolution preserves solidId ownership for unchanged or subdivided consumed regions, using complete region containment when point insertion changes node signatures. Losing this metadata restored the original face after an extrusion. Explicitly merging a cap back into its source clears that cap ownership only in the restored regions. The browser check covers a recessed lower wall followed by upper-edge and shared-edge point insertion.


### H/V cut transitions

Repeating the same axis cycles preview candidates. Switching axis commits the current cut and starts the other axis at the captured source position. Left pointer-down commits the preview before normal picking, so that same click selects a point, line, or face. Escape still cancels only the pending cut. Other editing commands finish the cut before normal command dispatch.


## Finish regions and textures

`wall_trim.js` partitions planar wall faces into finish regions using the shared
polygon kernel. The default strip width is 0.1524 m (six inches). Corner edges
receive that width on each incident wall. Coplanar dividers cycle first side,
opposite side, and half-width on both sides. Every preview starts from the same
snapshot; click commits one undo item, and Escape restores the snapshot. Trim
must preserve total area, holes, and the supporting plane, and stop at existing
face boundaries. It adds no thickness.

`material` identifies the surface treatment; optional `finishColor` is a separate
hex color. Both survive subdivision, clipboard transforms and sweeps. Face
merging also compares color. Existing `siding` assignments mean horizontal
siding; `siding-vertical`, `trim-horizontal`, and `trim-vertical` are distinct.

`displayMode` is translucent, opaque, or textured. The legacy `translucent`
boolean remains synchronized for visibility-aware picking. `exterior_finishes.js`
creates shared procedural maps and metric UVs in world metres. Curved walls use
arc length for horizontal texture spacing; texture evaluation creates no model
points. Rendering does not modify the stored geometry or finish assignments.


## Roof perimeter trim

`roof_trim.js` derives fascia from the roof face incidence graph. Shared ridges
and split internal edges do not receive panels. Collinear perimeter anchors are
one panel. Each panel extends vertically down by six inches unless an edge-keyed
`roofTrim.edges` override supplies another height; zero means explicitly deleted.
The source roof loops never change. Height edits and deletes share exterior undo
history, persist through From Roof, and are saved separately as
`exteriorsRoofTrim` when no wall model has been generated yet.

`roof_trim_editor.js` owns edge/face selection, Shift additions, inch entry,
preview cancellation and commit. Its controls reattach after 3D toolbar rebuilds.
The fascia renderer also runs when roof faces first resolve in roof mode. Roof
visibility owns trim visibility; trim is excluded from wall extrusion bounds.

Textured mode retains muted, depth-tested boundary lines and hides point and sprite overlays. Selected faces receive a light blue tint while retaining their texture. Material and color commands apply immediately to a selected wall face; without a face selection they start the paint tool. Roof shingles use metric
coordinates along roof contours and up the slope; rake trim grain follows the
edge. Unassigned walls use matte gray. Leaving textured mode restores the prior
handle visibility and any pre-existing material maps.

Chimneys are initialized as persisted editable wall surfaces plus a flat cap.
The cap starts 0.3048 m above the highest roof/footprint intersection, including
ridge crossings. Ordinary face movement stretches its shared side vertices.
A per-chimney initialization marker preserves cap edits and deletions on reload.
Existing edited lower shafts are preserved and receive only their upper section.
Roof openings are derived from the current chimney footprints, shared by the
2D/3D roof renderer and extrusion bounds; original roof source data is retained.

Wall trim follows finite connected collinear line runs through intermediate
points and intersections; it never extends over a gap or beyond the run ends.
Auto trim applies the default 6-inch strips to convex exterior wall corners
in one undo item. Shell occupancy determines convexity independently of face
winding. Coplanar dividers, recessed corners, existing trim, and portions along
roof/base boundaries are excluded; merely touching a boundary at an endpoint
does not exclude a vertical corner. Repeat Auto trim is a no-op once covered.

Manual trim side cycling uses a shared world-space side convention across
coplanar faces, independent of polygon winding and local frame origin.
Horizontal runs cycle above (6 in), below (6 in), centered (3 in each side).

Auto trim includes convex wall/underside edges above grade. Roof and base
boundaries remain excluded. Trim faces carry trimData with their source run,
underlying finish and overlapping strip ownership. T (or Delete/Backspace) on
a trim face removes that run, unions regions with matching remaining ownership
and finish, and selects the source for immediate reapplication. Generated
boundaries disappear while boundaries needed by another strip remain. The
metadata persists in drafts and follows geometry transforms. Legacy trim can
recover source edges from consumed draft regions and shared corner boundaries.

From Roof regeneration records a complete building-state and stage snapshot in
shared undo history after canceling live geometry previews. Undo/redo restores
those snapshots without regenerating topology and retains earlier edit entries.
Failed regeneration restores the previous building without adding an undo item.

Default finishes are inherited through state.finishDefaults (material, color,
trimColor). Missing material is the legacy representation of Default; explicit
Default assignments use material="default". Missing finishColor inherits the
building color, or trimColor for trim. Rendering and reports resolve inheritance
without stamping individual faces, so later defaults affect current and future
faces while explicit overrides survive. Defaults are saved, undoable, and survive
From Roof. Roof shingles retain their roof-specific presentation.

Coplanar chimney/wall merges keep joinedChimneys ownership on the resulting
face. That face and its boundary points bypass only those joined source chimney
cutters; unrelated chimneys still clip normally. Delete-line merges preserve
finish metadata, and global Merge faces accepts matching finishes across chimney
ownership. Merged faces no longer act as a single chimney footprint driver;
global merges preserve the existing footprint before consuming source surfaces.

Soffit is the automatic finish for unassigned downward-facing return faces;
explicit face materials/colors override it. Base reference faces keep Default.
In textured wall mode each roof is drawn with an upward-facing shingle side and
a downward-facing soffit side, with independent UVs. Triangle orientation is
checked in rendered coordinates, preserving holes and both input windings. This
adds no model faces and does not enable roof selection or roof-mode trim tools.

Shared-edge deletion also checks coplanar faces whose interiors contain a
positive-length part of the selected segment. This handles overlapping chimney
and wall surfaces, not only boundary-to-boundary joins. A valid coplanar merge
takes precedence over deleting perpendicular faces on the same seam. Only the
interior portion of the wire is erased; portions on the union's outer boundary
(such as a chimney edge above the roof) remain. The captured regression is
fixtures/chimney-overlapping-wall.json and is exercised through the Delete handler.

Chimney volume schema 2 stores the upper shaft from roof contact to its editable
cap. Lower exposed chimney walls are composed separately from the foundation up
to the same roof contact, excluding house-interior spans. Roof contact follows
actual roof faces and includes edge/ridge crossing anchors. Version 1 shaft
records upgrade in place, retaining face IDs, finishes, deletion flags and cap
height; upper-only records keep existing edited lower drafts.

V on three or more selected coplanar points creates a validated face using only
those points. A complete selected edge cycle determines boundary order when
available; otherwise angular order forms a simple candidate loop. Nonplanar and
zero-area selections are rejected without editing. Covered existing regions are
consumed to avoid duplicate fill faces. V remains the flip-axis control during an
active transform and the single-point vertical cut shortcut.
Deleting a shared boundary point unions compatible touching coplanar regions,
removes the point from their resulting perimeter and retains a valid face. This
runs inside the existing point-deletion transaction and preserves undo.

### Point and rectangle selection (2026-09-14)
Canvas rectangle gestures now start before roof-trim picking, so a drag beginning on trim can still select points. A completed marquee consumes its trailing click/double-click instead of invoking face placement. Point-first picking also applies within the wall and surface entry paths, while preserving the chosen drawing plane for shared endpoints. Selecting a base edge no longer silently changes the shared selection dropdown to Lines. Visibility/occlusion checks remain in force.
Validation: 617 tests pass, including rectangle completion, trailing double-click suppression, endpoint/line priority, shared-plane drafting, and selection-mode retention.

### Selection, boundary deletion, and V integration repair (2026-09-14)
Edited-surface point/face picks now activate the walls layer even when they have no generated wall owner. V also reads the wall point selection before falling back to layer-specific commands. Point selection clears explicit face selection; selecting base entities clears the old base face. Successful V clears all previous point/line selections and reports the number of selected anchors used.
Deleting a common edge merges coplanar faces only when that edge is internal to their union. A shared outer edge of duplicate faces remains load-bearing: deleting it removes the faces instead of recreating the same polygon with hidden wire.
Validation: 623 automated tests pass, including the captured seven-point wall, activation from base, duplicate-face deletion, and deletion followed by V reconstruction. Browser checks in `public/measure/internal/dev-selection-test.html` exercise the real wall editor and Three.js renderer: face -> rectangle points (zero face highlights) -> V (one complete face) -> boundary Delete (zero faces) -> V (one complete face), plus point-click highlight clearing and direct duplicate-boundary deletion. This sandbox has no project persistence and does not touch the user's model.

### Chimney roof-contact consistency

Wall cuts, visible face boundaries, and selectable segments use the same actual roof intersection as the upper chimney. Contact evaluation anchors sub-contact XY rounding drift to chimney footprint corners before choosing a roof plane. Loading and edit reconciliation repair legacy vertical surface/draft vertices that lie on the chimney footprint and exactly match the former reference-plane clipping height; this is not a larger global weld tolerance. The captured merged-corner regression reproduces two selected positions 2.47 mm apart, verifies one after repair/reload, and preserves nearby intentionally different heights.

### Explicit fills override generated chimney cutouts

V records intersecting chimney IDs in joinedChimneys on the new face before committing. This preserves an intentional patch through face rendering, edge picking, drafting, and reload, while ordinary generated walls still clip. Existing filled-face records receive the same repair during volume synchronization. Regression tests verify a previously fully clipped four-point patch emits a rendered mesh, retains visible edges, survives reload, and remains undoable.

### Intricate roof returns and chimney openings

Auto setback is shared across collinear connected fascia runs, including two roof pitches meeting at a gable ridge. Internal roof holes do not interrupt a perimeter source; chimney composition supplies the cut and exposed replacement. Gap routing may extend a short flashing guide by at most half a metre at either end to matching open wall columns on its supporting line; ordinary wall tops, mismatched heights, and offset guides cannot bridge arbitrary openings. Deduplication fragments own unique IDs before merging. Roof opening boundaries use their measured edge elevations instead of fitted face heights so upper and lower chimney parts meet. The captured complex-roof-corner fixture exercises the full source/extrusion/dedupe/gap/foundation/chimney pipeline with a closed ground perimeter and one back-gable plane.

### Generated flashing plane alignment

Generated walls retain their source roof ID. Before deduplication, flashing terminating on that roof aligns to an overlapping perimeter plane when the discrepancy is below 5 mm and the directions agree. Shared columns and nearby perpendicular returns from those same roofs follow the junction. Roof-contact heights differing by less than 5 cm reconcile to the perimeter's contact, preventing a thin residual ledge. Larger offsets, unrelated roofs, real short returns, and edited geometry remain distinct. The captured corner now has only its two exterior full-height back-wall boundaries; regression coverage also checks repeatability and preservation of intentional offsets. Validation: 637 tests pass, plus a rendered before/after comparison of the saved model.

### Stage 6: clean nested rake returns

`wall_rake_cleanup.js` builds a graph of generated ground-contact wall runs. It collapses collinear subdivisions, then searches short return chains between two substantial wall runs. A candidate requires an inner rake parallel to an outer rake, on its inward side, with every intervening edge and the new corner within the outer rake's actual soffit setback. The main wall extends to its geometric intersection with the outer rake wall; both share the same top and ground column. Only the related short return faces and flashing are removed, and the changed walls merge again. The roof itself is unchanged. Branches, zero soffits, larger returns, unrelated directions and protected edited walls do not qualify.

The same local replacement updates the foundation. Generated boundary subdivisions are rebuilt while independent sketch geometry is retained. Developer stages exposes **6 Clean rake returns** after **5 Merge faces**, and From Roof ends at stage 6. Stage 5 and stage 6 retain separate foundation snapshots for comparison; all cleanup caches and snapshots participate in undo, invalidation and persistence. Chimney foundation cache keys ignore sub-micrometre projection roundoff so stage switching does not regenerate node IDs. Validation: 643 tests, including the captured model, oblique planes, sloped ground, bounds/protection, stage switching, save/reload and full rebuild undo/redo.

### Re-infer soffits after removing their supporting flashing

Auto setback sources record the flashing IDs that supplied their inferred distance, including collinear continuations across a gable ridge. When stage 6 removes that flashing, it re-infers the affected run from surviving flashing, falling back to the normal 18-inch auto setback. Explicit soffit choices remain unchanged. The entire run moves to the corrected plane, both neighboring walls intersect it again, and the foundation receives matching strip corrections. The captured corner previously retained an 8.57-inch inference from a 19 cm flashing segment; it now has 18 inches along both rake sides with no ground gaps. Stage 6 source details report the final setback. Validation: 644 tests, including measured post-cleanup offsets, surviving inference evidence, explicit settings, foundation alignment, and the existing stage/undo/reload regressions.


### Stage 7: align nearly flush chimney sides

`wall_chimney_cleanup.js` follows the rake cleanup. It finds connected generated
wall runs and overlapping chimney sides with matching inward normals (within
2 degrees). The entire run must fit the authoritative chimney plane within six
inches. Only inward wall shifts qualify, increasing the soffit; outward chimney
projections, conflicting candidate planes, disconnected runs, collapsed corners,
and protected wall/foundation edits remain unchanged. Adjoining walls intersect
the new plane, roof heights and ground slopes are retained, and the foundation
gets matching strip corrections. The measured roof and chimney never move.
After chimney clipping, compatible lower chimney/wall pieces share a merged
boundary while retaining their editable IDs and distinct assigned finishes.

From Roof now ends at **7 Align chimney walls**. Stages 5, 6 and 7 retain separate
foundation snapshots for comparison, persistence and full undo/redo. The captured
model aligns the gable by 8.18 mm (0.32 inches), removes the shared chimney seam,
and retains the deliberate projecting side. Validation: 649 automated tests,
including six-inch bounds, angular drift, sloped ground, edit protection,
conflicting chimneys, material boundaries, repeatability, stage switching and
save/reload. An isolated browser comparison verifies the rendered corner.


### Clip ordinary walls against the full chimney shaft

The roof contact remains the boundary between generated lower chimney sides and
editable upper sides. Ordinary wall occlusion now extends to the current chimney
cap instead of ending at that roof contact. Generated wall strips, drafted face
fills, edges and point visibility share this cutoff. Cap edits (including face
drafts) update it; deleting only the cap retains the shaft-side height. Geometry
above the cap and intentional joined-chimney fills remain intact. The captured
aligned corner no longer retains the two diagonal wall strips inside the shaft.
Validation: 651 tests passed in the full suite, plus the added cap-draft regression
and all 35 chimney tests passed. A before/after browser comparison confirmed the
wall edges stop at the chimney, followed by refresh/save of the current model
without rebuilding or discarding edits.


### Merged wall rendering is independent of selection

The initial 3D wall renderer builds topology before assigning wall/chimney colors,
instead of separating those source categories and reintroducing their shared
seam. Mixed groups use the ordinary wall presentation regardless of source order.
Selecting either source creates the same complete editable plane, with the joined
chimney recorded so face/wire clipping cannot remove its included portion.
Existing mixed drafts receive that identity repair when the project loads and
before editing commands; drawing does not apply it. No merge command
or geometry undo item is produced by selection. Validation: 655 tests pass,
including the actual initial renderer's single mesh and outer-only uprights,
selection from either side, identical selected/deselected face extent, and reload.

The chimney ownership loader also recognizes mixed groups before applying its
legacy per-side filter, restoring source IDs from the saved group key when an
older reload pruned them. Saved face loops and user edits remain unchanged.
The user's model was saved, refreshed and repaired after restarting the stopped
isolated local server; the final snapshot verifies unchanged roof and draft outlines within 0.5 micrometres (the existing roof-contact normalization restores rounded coordinates).


### Merged outlines follow their replacement face

Deleting a coplanar seam now records `mergedSources` on the resulting surface.
The replaced draft regions retain a `solidId` link, and replaced standalone
surfaces retain `replacedBy`; their obsolete wire is excluded from rendering and
picking. Ordinary face deletion still leaves editable wire. This prevents the
source outline reappearing when the merged surface is drafted or extruded.

The ownership loader repairs older line-merge results by matching deleted source
regions against the original merged surface, including drafted hosts. Matching
requires coplanarity and full coverage and respects holes. Repair changes only
ownership metadata, is idempotent, and preserves current face/base coordinates.
`dev/fixtures/merged-wall-extrusion-wire.json` reproduces the saved regression.
Validation: 658 tests, including the captured outline before/after repair,
selection and reload, fresh draft/standalone merges followed by extrusion,
Escape/undo, and preservation of unrelated deleted geometry.


### Draft-to-engine face contract

A recess can replace a long perpendicular neighbor when it trims the adjoining
end. That replacement must retain the neighbor's appearance and joined-plane
ownership, including the untouched end of a chimney/wall merge. The old editor
scene adapter and model collector omitted draft-level `joinedChimneys`; the
Boolean operation correctly preserved its input, but that input was incomplete.
Subsequent chimney clipping therefore reopened the far seam.

`ExteriorModel.draftFace` is now the shared conversion for operation scenes,
selected regions, model collection, seam deletion, point-healing inputs and
structural/render clipping. It maps local geometry and analytic curves, inherits
joined ownership and retains region metadata. Boolean replacement geometry keeps
these fields. Geometry-only support queries do not materialize persisted faces.

`restoreDraftFaceOwnership` repairs legacy replacements only when their stored
`draftKey`, `regionId` and consumed `solidId` prove source ancestry. It restores
missing join metadata, without rewriting coordinates or overriding finishes.
The loader runs it through wall draft normalization; new operations need no
repair. The captured `remote-indent-chimney.json` fixture tests the original
failure through the engine and editor, preservation of remote corners and
unrelated drafts, deterministic preview, cancel/undo and reload. Adapter contract
tests also cover appearance, analytic curves, and inherited ownership. Full
suite: 662 tests passed.

### Saved-model safety, 2026-10-18

Fixes for the data-loss and wrong-measurement items of the 2026-10-16 full-house
audit (items 1-4, 19 and 26-28).

- A changed roof rebuilds walls on wall-mode entry or a stage click only when
  nothing would be lost. `generatedEditsKey` fingerprints the wall edits From
  Roof produced; when the current edits differ, the editor asks first and names
  what the rebuild discards (Undo restores it). Cancel, or no dialog, keeps the
  walls and records `keptRoofSignature`, so the same roof is not asked about
  again. Rebuild from roof still rebuilds.
- A clicked 3D toolbar control or list keeps focus, but wall mode handles the
  key and roof shortcuts never receive it; Enter cannot click the control again.
  Only a control reached with Tab keeps Enter and Space, and a focused list its
  plain keys. Those are stopped at document bubble, before the roof's window
  handlers.
- Typed distances and arrow nudges replay the last pointer position with its
  buttons released. A re-anchor left pending by an orbit waits for the next real
  move, and a typed plane move keeps the last aimed direction.
- Rebuilding `$surfaces` from an operation result keeps deleted surface records,
  so their outline and Shift+F restore survive line moves, nudges, transforms and
  steps.
- Drawing and picking write nothing. Legacy draft repairs (merged identity,
  `generatedRoofContact`, source anchors, curved-surface compaction) run once at
  load (`repairStoredDrafts`, called by `WallMode.restore`) and through
  `ensure()` before editing commands. An empty saved draft draws as its generated
  walls until an edit builds it. A plain click only holds an existing drawing
  face; converting a surface or mounting a shared point belongs to the edit that
  follows (N mounts it in its own undo step). Sticker hover previews on a scratch
  copy, and placement materializes its host drafts inside its own undo step
  (see docs/optimization-backlog.md, "Sticker hover copies the wall edits").

Validation: regression tests in `wall-mode.test.cjs` and
`wall-face-draft.test.cjs` fail on the earlier code and pass now; the audit
repros show the corrected behavior; the audit's headless render harness reports
no render-time state change on the saved houses, with screenshots identical to
the earlier renderer.

### Planar kernel and extrusion, 2026-10-18

Fixes for the geometry-kernel items of the 2026-10-16 full-house audit (9, 10
and 29-36), in `exterior_geometry.js`, `exterior_model.js` and
`wall_solid_geometry.js`. There is still one clipper and no render-time repair.

- Booleans split a ring pinched at a repeated vertex, or at a vertex lying on
  its own edge, into simple loops. Orientation decides what a loop is: a hole
  touching its outline stays a hole of the region that contains it, rather
  than becoming a filled face plus a reversed one. A ring that collapses to
  zero area on the 1e-6 m grid bounds no material and is left out of the
  boolean; its retraced edges made Clipper's `Execute` fail.
- `triangles` resolves contacts before earcut: vertices of different rings
  within the grid are welded, and a vertex lying on another edge (a hole on its
  outline, two holes, a ring touching itself) is inserted into that edge. The
  result still indexes only input points and is checked against the resolved
  rings, which differ from the input by at most the grid at a contact.
- Splitting a face names each new region with the first `<id>~region-k` its
  collection does not use, and gives each region only the anchors on or inside
  it. `ExteriorModel.repairFaceIdentities` renames later duplicates in saved
  edits and history snapshots; the loader's ownership pass
  (`restoreDraftFaceOwnership`) runs it.
- A sweep within two degrees of horizontal (`WallSolidGeometry.horizontalSweep`)
  is roof-clipped and ground-fitted, so a measured wall's lean no longer skips
  the roof. Roof cutters sweep the source along its actual direction. A leaning
  cap's ground contact slides within the cap plane, keeping the cap planar.
  Vertical and zero-area roof faces bound nothing and are skipped.
- A zero-length edge (a repeated vertex) sweeps no return.
- An unhosted face still sweeps its whole boundary, except edges and curved
  boundaries resting on a base face (2 mm), which the base update owns; a face
  lying entirely on the ground sweeps every edge. Without a base every edge
  returns.
- Neighboring roof cutters trim each other's pieces with the contact tolerance,
  so the wall on a grid-rounded shared boundary (an eave between a roof triangle
  and the region beyond it) no longer survives as an upright curtain.
- The roof-seam remnant rule (at most 3 mm wide, under 1% of a source over
  30 mm wide) also removes the sweep's own clipped cap, side and roof-patch
  fragments, but only short ones (at most 10 cm); a long thin strip from a
  distance just past a boundary is kept. A roof patch counts only when it is
  also narrower than a tenth of the distance. Roof returns narrower than the
  contact tolerance are cutter seams and are dropped.
- A face needs three corners more than the contact tolerance apart (the
  incidence graph's vertex identity) and more than grid width.
  `createExtrusion` refuses a source that fails this ("The face has no area.")
  and `validateResult` rejects any result face that does.

Validation: `dev/exterior-kernel-audit.test.cjs` (fails on the earlier engine
files, passes now); the audit's kernel repros; the dense sweep (60 distances,
every face) over seven saved houses reports no failures, slivers, duplicate
vertices or validation errors (the earlier engine had 39-211 sliver previews
per house and failed at -1.6 m); both documented replays pass. Every
layered-turrets roof preview now completes (12 crashed before); one generated
wall there, 1.5 um wide, is refused as having no area. CPU time per
roof-clipped preview is unchanged. The `saved-curved-wall-eave` test now counts
upright returns: since `03caa748` an
unhosted face also returns along its top arc and, without a base, its ground
edge. The bridged-window cut test in `wall-face-draft.test.cjs` now checks
that both openings stay holes; its old `~region-` check matched the reversed
patches of item 10.

### Base editing, 2026-10-18

Fixes for the base and foundation items of the 2026-10-16 full-house audit (8,
11-14, 37, 64-66, 68-70 and 124), in `base_sketch_geometry.js`,
`base_sketch_editor.js`, `base_editor.js`, `base_geometry.js` and
`wall_base_binding.js`. Wall drafts (local `origin`/`frame` sketches) are
unchanged.

- A point dragged in plan stays on the faces it belongs to: it is lifted onto
  its one supporting plane, slides along the fold between two, and cannot leave
  the corner of three. A free anchor takes the plane under its new position.
- A vertical point edit (M, Shift-drag, H level) is a face edit
  (`BaseSketchGeometry.setHeights`). A face that stays planar with the new
  heights follows; any other face keeps its own vertex at the old height, as at
  a step, and the graph is rebound. A face vertex that no face can follow is
  refused with a message, never dropped. Free anchors and construction lines
  move as drawn. An invalid M preview is not committed.
- Removing the fold between faces on different planes is refused: those faces
  cannot merge, and before this both disappeared.
- Each base level is partitioned separately. A region tiled by faces of other
  levels and not by faces of its own level is the outline a raised section left
  behind, not a face. A region enclosed only by fixed (wall-defined) edges that
  no face covered is open ground (a courtyard or a deleted face), not new base.
- A loop enclosed in a region is a hole. The surround is serialized as simple
  pieces divided by `holeCut` edges: preferably one straight hole edge extended
  both ways to the region boundary, otherwise two rays from different hole
  points (corners before exact curve points). A cut never crosses another line.
  Cuts are derived: deleting one directly is refused, a cut whose hole is gone
  is removed, and rebinding keeps the marker.
- Reground (`BaseGeometry.reground`) and the DSM ground pick refit every face
  onto the grade under it instead of rebuilding one merged footprint. Faces
  keep their IDs, finishes, stickers and sketch (anchors, lines and curves are
  lifted with their face); a face over several grade planes is divided along
  them (`<id>~grade-k`). A reference grade is one unbounded plane, so the base
  may extend past the drawn grade tile. Base cuts follow their faces
  (`followCuts`). Step patterns are rebuilt from their refitted source slope
  with the same count, reference and width; when the grade cannot carry a
  pattern (a flat grade) the editor asks first and then removes only that
  pattern. Chimney foundations are still regenerated afterwards.
- From Roof leaves open courtyards open: a wall loop nested in another, or an
  open hole of the roof footprint at least 1 m^2 and 0.2 m wide (widened by the
  setback). The surround is divided into simple pieces. Roof slivers under the
  face minimum and zero-length eaves no longer stop generation.
- A base edit that would lift an attached wall bottom to or above its top is
  refused (`WallBaseBinding.check` for generated walls before commit, and the
  edited-face follow).
- Version 1 sketches upgrade without losing drawing: a node is supported by its
  face as recorded or as it stands now, points and lines no face used are kept
  as deliberate drawing, and a line crossing a step is lifted onto each face.
- Curved bases: the editors build one curve-sample test per draw or pick pass
  (`curveSampleTest`) instead of sampling every curve for every point, and the
  sketch editor reads the base once per read-only pass. `rebind` narrows its
  nearest-node, T-junction and curve-matching searches spatially, and the plan
  outline is reused when only heights change. These return the same results;
  the comparison harness matched `rebind` output byte for byte.

Validation: `dev/base-editing-regressions.test.cjs` (26 tests); the audit's
base repros r1-r14 and `kernel/basehole.cjs` show the corrected behavior (r1
and r8 now refuse with a message). Tests that encoded the overlapping inner
loop (two in `curved-surfaces.test.cjs`, one in `wall-solid-geometry.test.cjs`,
whose fixture is now a wall draft as in production) and the old Reground wipe
(`base-editor.test.cjs`) were updated.

### Copying and pasting curves, 2026-10-19

A face ring stores an analytic curve as tessellation vertices. Those vertices
are evaluation results, not points: `ExteriorGeometry.curveSamplePoint(face)`
identifies them (a ring vertex on a curve of the face, between two neighbors on
the same curve, that is not a curve end, spline control or authored point).
`copyGeometry` flags them `curveSample`, so paste and move snapping,
`planeAlignment`, `planeAlignmentGuides`, `stickerAlignmentTargets`, the move
markers and the post-placement selection use only defining points. Faces and
edges still carry the full ring. A paste gives each pasted curve a new id
(`paste-<op>-curve-k`), since draft import and the surface wire de-duplicate
curves by id; and sticker placement moves face curves with their points. Before
this, a pasted arched door kept the source curve id and an unmoved curve, so its
samples became explicit draft points and the region split into slivers.
Regression tests: the "arched" and "curved wall pastes" tests in
`wall-face-draft.test.cjs`.

### Plane-mode stickers and arcs, 2026-10-19

- Deleting an edge that opens a door/window leaves its lines (and arch) as wire
  on the plane; it is no longer a face or sticker. A plain face invalidated by
  the same delete is rebuilt from the remaining edges of the faces on its plane
  (`removeFaceEdges`), so the wall closes across the opened door instead of
  disappearing.
- A plane-mode paste whose wire (pasted lines or curves, not pasted faces)
  closes an outline makes that region a face, through the same
  `closePlaneRegions` step that drawing uses. Construction-draft curves attached
  to such faces are qualified by their draft key; surface curves, including a
  deleted door's preserved arch, attach too, and that arch can be copied.
- Arching a line with A no longer rewrites boundary edges of a consumed draft as
  "free" sketch segments, which used to resurrect a straight-topped region under
  the surfaces.
- Deleting a curve's end or control removes the whole curve from the surface
  wire, with the samples left on it; samples are never promoted to points.
