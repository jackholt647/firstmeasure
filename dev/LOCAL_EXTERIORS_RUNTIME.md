# Local exteriors runtime � September 15, 2026

The user's existing editor at http://127.0.0.1:8031 is served by the PHP
sandbox in `C:/Users/jackh/Code/2026/FirstMeasure Exteriors Tests`, not directly
by this canonical checkout. Its projects and runtime stay in that sandbox.

The sandbox's `dev/exteriors-router.php` now serves these exact static asset
paths from this canonical checkout:

- `public/measure/internal/editor_scripts/exterior_geometry.js` (face-boundary normalization and deletion shape checks)
- `public/measure/internal/editor_scripts/exterior_model.js` (shared commit validation)
- `public/measure/internal/editor_scripts/wall_mode.js` (plane shortcut and pointer routing)
- `public/measure/internal/editor_scripts/wall_face_draft.js`
- `public/measure/internal/editor_scripts/wall_editor.js` (alignment guide display)
- `public/measure/internal/editor_scripts/wall_features.js`
- `public/measure/internal/editor_scripts/wall_solid_geometry.js`
- `public/measure/internal/editor_scripts/resource_3d_overlay.js` (per-image photo alignment and restore)
- `public/measure/internal/editor_scripts/project_resources.js`
- `public/measure/internal/editor_scripts/project_resources.css`

The route retains the existing CLI-server, loopback, and EXTERIORS_SANDBOX
guards. It uses an exact allowlist, sends `Cache-Control: no-store`, and fails
with 503 if a canonical file is missing. Other routes and sandbox project data
are unchanged. Original prototype JavaScript files remain preserved.

Original router backup in the prototype:
`.local-runtime/exteriors/exteriors-router.before-canonical-sticker-assets.php`.
Restoring that router removes the bridge. No service restart was needed.

Verification: all three served responses matched the canonical files byte for
byte. The supplied local project loaded in a temporary browser tab without
console errors; no measurement edits were saved. The canonical development
suite passed 674 tests. Existing browser tabs must refresh to load changes.

Continue code development here. This asset bridge does not turn the prototype
into a complete canonical application runtime or authorize any remote deployment.

Boundary cleanup validation: 696 development tests passed, including eight new
regressions for merged-line remnants, safe point deletion, holes, tilted planes,
shared edge ownership, equal-area shape changes, disconnected surface components,
and collapsed-move rollback. The four affected served scripts matched canonical
source. The supplied local editor loaded with the new kernel and no page errors.
No project geometry was changed by this verification.

## Face working plane

Select a flat face and press P to show its working plane in the 3D view.
Double-click creates a point, C connects selected points in order, and N places
one new point connected to every selected point. Click selects points; Shift adds
and Ctrl/Cmd subtracts. Drag a rectangle to select through other geometry, limited
to coplanar points. Coplanar model edges are highlighted and available for snapping.
Closed regions become ordinary saved faces. Regions inside existing wall faces
partition their owner; regions outside add new faces. Horizontal base partitions
retain base ownership. P exits while keeping all drawn geometry. Other geometry
can be Normal, Faint (default), or Hidden using the plane toolbar control.
The grid and active mode are transient and are not report or saved geometry.

Validation: 708 development tests passed. Tests include extension beyond wall
bounds, detached faces, inside-face partitioning, tilted and horizontal planes,
snapping isolation, persistence, rendering, and actual shortcut/pointer routing.
The supplied local editor was checked with real face selection and P on/off.
Served wall_mode, wall_editor, and wall_face_draft sources matched this checkout.
No production deployment or user-project geometry edit was performed.

Plane interaction update: 710 development tests pass, including C closure, N with
multiple selected points, rectangle selection, plane-only selection, and transient
visibility settings. The local page was browser-checked for the Faint/Hidden/Normal
control, guide rendering, and P exit with no page errors. No project geometry was
changed during the browser check.

Plane S/Q and guide lifecycle update: S uses the shared analytic arc kernel,
including center placement, sweep, closure, and Shift continuation. Q shares the
normal one-corner/rotation and two-edge-point quad construction. Construction arcs
are stored in unbounded plane sketches; closed regions retain arc metadata for
later curved extrusion. The sandbox also serves canonical base_sketch_geometry.js.
Idle mouse motion no longer snaps or displays the construction grid/hover marker;
N/S/Q show guides during placement and Escape/completion removes them. Plane entry
unwraps the base editor's {face,event} selection, including sloped base faces.
The 714-test suite passed, followed by an additional passing full-circle/Shift
continuation regression. Browser validation on the supplied project selected a
base point, activated S and Q, and verified idle/cancel grid removal and unchanged
project geometry on exit, with no page errors.

Grid visibility correction: the construction grid remains visible throughout plane
mode, including idle and after Escape. Only placement/snap previews are transient.
## Plane-face extrusion investigation

The saved triangle was a valid face. Its extrusion was clipped by the roof,
leaving construction wire and a supported return. The user confirmed this was
expected and requested reverting the proposed free-face extrusion policy.
That policy and its associated tests/fixture were removed. Roof clipping, base
constraints, and supported-side generation retain their previous behavior.
All earlier plane-mode controls and grid/snap-guide fixes remain in place.
User project geometry was not modified.

## Resources state and source roles
Resources restores the active tab, selected file, drawers and image view per project.
Customer order/resubmission notes, Tech submission sources and QA thread attachments
are listed by role. New uploads record tech/qa mode; older internal uploads default
to Tech. Tech uploads and saved notes merge into submission with resource_name deduplication.
The prototype resource PHP endpoint received the role fields only. Prototype report.js
received the three merge calls and source role/resource_name fields, without a wholesale
report bridge. Legacy local feedback falls back to the existing project_bundle route.
Validation: 722 development tests passed; browser tests include reload, leaving Resources,
QA uploads and Tech submission deduplication. User project data was not modified.
## Resources visual update

Resources now uses the report/config light palette, consistent outline toolbar
icons, and 28px single-line file rows. QA/Tech/Customer use amber/blue/green
collapsible groups with counts; collapse preferences persist per project. Empty
groups start collapsed. Image rows have an overlay icon with a pressed state;
a second click removes the active background. The toolbar shares this toggle.
Four Resources/catalog/overlay browser tests passed, including compact row height,
group collapse persistence and overlay on/off. The live 635px-wide Resources pane
was visually checked. No saved project files or model geometry were changed.

## Selection-aware wall undo (2026-09-16)

- Wall-mode history now keeps before/after selections for base, wall/draft,
  working-plane and roof-trim edits. Selection-only input steps share the same
  chronological undo/redo history; live drag previews are not selection steps.
- Advanced Settings > Undo selection changes defaults on and is saved with the
  project. Turning it off skips selection-only entries in either direction
  without deleting them; content edits always restore their selection.
- The local asset bridge also serves canonical `base_editor.js` and
  `base_sketch_editor.js` for their selection snapshot/restore adapters.
- Validation: 314 targeted editor/history tests passed. Isolated browser checks
  verified additive point selection undo/redo, the Undo button, the default-on
  setting and persistence after reload, with no page errors. No server-side
  project geometry was saved during validation.

## Trim sections and Reground (2026-09-16)

- Main Trim menu separates roof perimeter selection/height from wall corner
  trim. Wall Auto uses the selected 6/8-inch width; the preference is persisted
  with the project and retained through From Roof.
- Reground now maps edited/drafted wall attachments through WallBaseBinding
  before installing the new base. Base and wall edits share one undo snapshot;
  unattached walls and wall tops are preserved. Generated walls continue to
  rebuild against the changed base through the existing generation pipeline.
- Roof trim height writes normalize empty array metadata into objects so the
  chosen sizes survive JSON serialization. The local bridge includes roof_trim.js.
- Validation: 316 targeted tests passed, including flat/pitched Reground,
  attachment retention and undo, 6/8-inch Auto trim, and legacy roof settings.
  An isolated browser session verified the menu, 8-inch generation and Reground
  on the supplied local project without saving server-side project geometry.
