# Wall and plane editing

Wall mode's **C** connects every selected point pair in 3D, matching the roof
editor. Connections may span different drafts and need not be coplanar.
Existing connections are not duplicated. **U** retains the existing wall
subdivision command.

For selected wall lines, **E** begins extrusion along the supporting wall.
Press **E** again to switch to extrusion perpendicular to that wall, and again
to switch back. Switching restores the gesture's original geometry before
previewing the new direction. **M** changes the supporting face. Typed signed
distances work in both directions; click commits one undo entry and Escape
restores the original geometry.

## Entering a drawing plane

- Select a flat face and press **P**, or select points/lines and press **P**.
- Three noncollinear points, two coplanar lines, or a larger coplanar selection
  determine a fixed plane. Every selected endpoint participates in validation.
- Collinear selections rotate around their common line.
- One selected point requires two confirmations. **P** cycles the model axes
  during rotation; the second stage uses either of the other two axes and
  preserves the first stage's orientation at zero degrees.
- Click or Enter confirms a rotation. Type an exact angle or use snapping to
  model axes, model points, and connected lines/faces. Escape cancels setup.
- Noncoplanar selections are rejected without changing model geometry.

Confirmation rebuilds plane membership using a two-screen-pixel tolerance
converted to model units at the plane origin. Membership ignores occlusion and
the sign of the plane normal. A line belongs only when **both** endpoints are
within tolerance; a line merely crossing the plane is excluded. Selecting or
snapping to an admitted point retains its original identity.

## Editing on the plane

| Control | Action |
| --- | --- |
| Click / Shift-click / Ctrl-click | Select, add, or subtract points/lines/faces |
| Drag / Shift-drag / Ctrl-drag | Select, add, or subtract points within the plane |
| Ctrl+A | Select the plane's points |
| Double-click / N | Place a point / extend from selected points |
| C / U | Connect all selected pairs |
| Q / S | Draw quadrilaterals / analytic arcs |
| M / R / T / Y | Move / rotate / flip / resize on the active plane |
| T during flip; X / V | Cycle flip orientation; choose horizontal / vertical |
| Ctrl+wheel during resize | Cycle the plane's width, height, and uniform scaling |
| Ctrl+C / Ctrl+V / Ctrl+X | Copy / paste / cut |
| Arrow keys | Nudge; Shift multiplies by six, Alt divides by four |
| Delete / Backspace | Delete the selected entity type |
| V / B | Create a face / subtract a selected region |
| L | Make selected lines parallel, using the longest as reference |
| Click / Enter / Escape | Commit / commit / cancel a transform |
| Ctrl+Z / Ctrl+Y | Existing unified editor undo / redo |
| P | Exit plane mode and keep committed geometry |

Plane transformations use one fixed coordinate frame, including single points
and lines. Pasting does not require an underlying face and can extend past the
original face boundary. Persisted geometry remains in the ordinary wall model;
the working plane itself is transient.

## Verification

`dev/wall-face-draft.test.cjs` covers selection, near-plane membership, point
identity, plane fitting, two-stage rotation, both extrusion directions,
transforms, clipboard, nudge, line/face deletion, analytic curve persistence,
parallel lines, and face subtraction. Existing plane drawing and wall tests
exercise subdivision, holes, constraints, undo snapshots, and serialization.

`dev/wall-plane-editor.browser.test.cjs` uses real Three.js camera rays and
headless Chrome WebGL, drives mouse and keyboard input, verifies geometry and
commit counts, and writes a screenshot to the temporary
`exterior-plane-editor/plane-edit.png` directory.
