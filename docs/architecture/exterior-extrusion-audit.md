# Exterior extrusion architecture audit

The October 10 audit found reproducible failures between geometry calculation, editor state and visibility. The sampled sweep calculations do not support replacing the geometry kernel wholesale. The editor does need stronger shared contracts: a valid preview must survive placement, and geometry visible on a face must remain available to the next edit.

## Confirmed causes

### Preview and placement used different finalization

`wall_face_draft.js` assembled previews through several independent paths. Placement additionally ran chimney reconciliation and edit normalization. Single face previews ran chimney reconciliation only for faces explicitly driving a chimney footprint; line and group previews did not consistently run it. Thus validating a sweep did not validate the final model that placement would publish.

Source commit `b4057929502175324a6ad6c00b704eff2c5f9613` introduces `ExteriorModel.prepareEdits(state, edits, before)`. It reconciles and validates a private candidate. Single face extrusion, face sliding, line movement/extrusion and grouped face extrusion use it before publishing previews; the commit wrapper uses the same function. Rejection leaves the input unmodified. Machine precision differences can still occur on repeated geometric projection, so geometric equivalence must use tolerances rather than serialized floating point equality.

Chimney reconciliation also rebuilt base bookkeeping on models without chimneys. It now skips models with neither current chimneys nor foundation metadata requiring cleanup. Ordinary wall edits consequently leave their unrelated base untouched.

### A correctly committed point disappeared from the editable scene

The reduced fixture `dev/fixtures/chimney-visible-point.json` reproduces this using existing saved geometry. Extruding a boundary point downward by 0.1524 metres commits the correct coordinates, but the original editor hides it. Face rendering and point/segment visibility independently clip against chimney volumes and disagree at this boundary.

Making only the point visible is insufficient: the next extrusion cannot find its connected line. Explicit user anchors now retain support from the actual visible draft face, and their incident boundary segments retain the visible face boundary. Consumed source regions, deleted nodes and hidden faces continue to be excluded. Generated source points do not receive this fallback.

### Placement rejection discarded the interaction

The general pointer placement error handler restored the original model and cleared the tool. That made a commit rejection look like a canceled operation, even though a status message was set. Face, line and group extrusion placement now retains its preview and tool on rejection and reports that placement failed. Enter for grouped extrusion uses the same error boundary as pointer placement. A user can retry, adjust or cancel.

### Ancestry and live ownership were previously confused

The earlier resized-chimney fix corrected point placement that treated `draftKey` ancestry as current editable ownership. A replacement surface can preserve an old source key while owning different world coordinates. Live draft ownership uses the explicit draft relationship. The existing resized-chimney sequence regression remains in the suite; this audit preserves that distinction.

## Verification

- Eight editor/kernel/adapter/geometry suites passed 563 tests. A subsequent focused run passed four tests, including the added grouped Enter rejection test, for 564 distinct passing tests across those runs.
- Twelve nearby saved faces were replayed at four signed distances: all 48 valid previews committed. Comparing finalized preview and placement found only approximately 1.8e-15 metre coordinate changes in one case, with no topology or material changes.
- The new chimney fixture repeats extrusion, cancellation, placement, serialization/reload and undo snapshot restoration three times. It checks both selected coordinates and rendered point geometry. A hidden-face control prevents the visibility repair from exposing anchors inside a chimney volume. Existing turret tests check that consumed source points stay hidden.
- An actual Chrome replay of the reduced fixture shows the original point disappearing after Place. The corrected editor keeps it visible, with 0.00000059 metre distance from the preview. This is a local browser harness using the real editor and rendering modules, not a replay of the user's unsaved active project.
- A deliberately rejected finalizer tests recovery on click and Enter. This is an error-handling contract test, not evidence that the user's latest operation failed for that exact reason.

Local evidence is under `output/extrusion-audit-20261010/`, including `regressions-final.txt`, `commits-after.txt`, the mismatch comparison and `point-after.png`. Output files are working artifacts, not required runtime assets.

## Remaining architectural risks

The editor maintains world-space replacement surfaces, face-local sketches, consumed source regions, chimney volume metadata and derived display/picking geometry. Their ownership rules remain distributed across a large adapter. Several other tools still have separate preparation and placement implementations. The new finalizer covers the main face and line extrusion paths, not every editing tool.

`applyLineResult` also projects moved sketch anchors back into an existing draft frame. That merits a dedicated off-plane movement sequence test before changing its behavior; the audit did not establish it as another failure. Rendering accessors that compact stored surfaces deserve a separate purity audit. Neither observation is proof of the latest reported bug.

Future engine changes should test whole workflows, especially resize or move followed by extrusion, partial consumption, undo, reload and another edit. Enforce world/local round-trip consistency, explicit live ownership, preview/commit geometric equivalence, and agreement between visible geometry and editing paths. Keep numerical geometry tests alongside these checks; passing a polygon operation alone does not establish that the editor preserves its result.

The saved-fixture failure is confirmed and repaired. The exact last screenshot's disappearing operation is not conclusively identified, and these checks do not establish that every extrusion bug is eliminated. Reproduction should come from saved fixtures and generated operation sequences without requiring the user to stop active testing or preserve a transient state.
