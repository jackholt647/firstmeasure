# Closed soffits — October 8, 2026

From Roof now has an opt-in Closed soffits checkbox below the custom depth.
It materializes editable underside faces for surviving eave/rake wall spans
with nonzero setbacks. Walls stop at the underside instead of the roof plane.
The underside meets the fascia bottom (or roof edge when fascia depth is zero),
is horizontal across the overhang, and follows the edge along sloping rakes.
Adjacent runs share outer corner joins. Parapets and zero-soffit glass/flat
edges remain excluded. Generated roof and wall sources stay unchanged.

Undersides are tagged as roof-layer soffit material and shown in a distinct
light green shade. Roof visibility controls their faces and drawing geometry,
independently of wall visibility. They use the existing face drawing/deletion
controls. Deletion restores the generated wall to the original roof height;
remaining partial panels limit only their covered wall intervals. Existing
wall drafts reflow when a full bound underside is removed. Undo and persisted
drafts retain the binding and visibility ownership.

Validation: five geometry tests, 73 wall-mode tests, and focused face-editor
checks for deletion/undo and independent roof visibility. The broader editor
suite passed 432/433 tests before the visibility test was added; its previously
recorded chimney-support selection failure remains unchanged. The saved
three-layer house generated 25 valid panels without changing its 76 generated
wall identities or count. No customer data was changed.

Development rollout pending. Overlay only the six editor runtime files on web,
pool and compatibility; worker receives the five JavaScript files and retains
its older unused PHP entrypoint (reviewed differences are unrelated customer
mode and color-picker loading). Production is not part of this rollout.
