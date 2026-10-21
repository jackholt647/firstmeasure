# Exterior report fixes — development, October 21, 2026

Source `a6f649b31dd440db6de16b5cd4b55ba7ef982964`.

- **Cover and exterior summary angle.**
  - Cause: `exterior_pdf.js` `coverView` ignored the configured front; it took the largest wall's direction and turned
    it 45°.
  - Fix: both views now look from the configured front.
- **Readable elevations.** Faces were drawn in the dark default finish colour on a fixed grey panel, with thin pale
  edges. Faces are now a light, angle-shaded tint of their finish with dark 2 px edges on white.
- **Openings column.**
  - "Open ft²" is the opening area; it is renamed "Openings ft²", and faces without openings show "-".
  - Cause of the zeros: an opening matched its wall only through its first edge, and door or garage notches start
    on the ground.
  - Fix: any shared edge now matches. On the pilot house, openings go from 0 to 2 (80.4 sq ft).
- **One face, one elevation, always labelled.**
  - Before: any face showing 20 or more pixels was listed, including slivers and faces seen from behind, and listed
    again on every elevation that showed it. Labels were drawn only for faces of at least 150 pixels.
  - Now each face is counted on exactly one elevation. Among the views where it faces the viewer within 60° and at
    least 25% of it is visible, it goes to the most head-on one; failing that, to the view showing the most of it.
  - Faces no view shows go on a "Hidden Wall Faces" page. Faces under 1 sq ft merge into one "Small pieces" row.
  - Every listed face is labelled, using a smaller font or a leader line rather than dropping the label, and every
    label is listed.
  - The roof is drawn as a blocker, and chimney face normals are corrected.
  - Elevation totals plus hidden faces equal the gross wall area (4,511.14 sq ft on the pilot house).
- **Unassigned materials.** Report configuration shows a warning on every page with the count, "Show faces" and
  "Assign in Walls". "Unassigned" is the material the editor labels "Smooth".
- **Configuration tray.**
  - Cause: the pane layout's 60% non-shrinking slot pushed the tray mostly off screen.
  - Fix: the tray opens at 36% of the workspace, can be resized by dragging its left edge (double-click resets), and
    remembers its width per user.

**Tests.** Eight new tests in `exterior-pdf-layout` and `exterior-report`. The full suite has 1,682 of 1,686 passing,
with the known exterior-ai and resource-media-viewer failures.

**Rollout.** `exterior_pdf.js`, `exterior_report_model.js`, `exterior_report.js` and `report.js` were overlaid on web,
legacy and pool. All roles verified, and the served files match. Wall IDs differ from earlier reports, because the
corrected chimney normals change the sort order.
