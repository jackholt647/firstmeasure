# Selected soffit editing

In wall mode, Resoffit is between From Roof and Merge faces. Roof-contact soffit edges are red-orange. Open Resoffit, click one or more eligible lines (click again to remove), enter an absolute depth in feet or choose a preset, and Apply. Done or Escape leaves the tool. Each application is one normal undo step and survives save/reload.

The engine translates the selected wall planes and solves their intersections with fixed neighboring planes. Shared corners slide along the unchanged neighbor, including oblique corners; the original roof stays fixed. Attached base boundaries and trim follow through the existing edit pipeline. Connected coplanar fragments move together. Finite roof sampling updates sloped tops, near-coincident survey seams follow the same junction, and shortened neighbors clip intermediate roof vertices at the new corner. Original source references persist for repeated absolute depths, and selection endpoints are rebound to the final projected face vertices.

Generated lower-layer clearance is a minimum. An impossible edit that reverses or collapses a connected wall is rejected atomically with guidance to select adjoining soffits together or use a smaller change. The tool does not silently replace the entire building or alter the requested roof.

Shift-clicking empty space preserves existing wall point and line selections. Soffit picking tolerates near-surface occlusion while ordinary hidden geometry remains depth-tested.

## Verification

- Right-angle and 45-degree corners, multiple adjacent selections, fixed neighboring planes and unrelated geometry.
- Repeated absolute depths, lower-layer minimums, finite roof eligibility and intermediate roof-vertex clipping.
- Real layered-house turret seams, almost parallel surveyed junctions and lower-return rejection with exact rollback.
- Editor selection, attached base, one undo commit, saved-edit reload, roof-contact picking and Shift-empty selection.
- A 53-edge house sweep at 0.5 ft applies 49 edits; four lower-roof returns reject safely because the requested movement would reverse/collapse their connected faces.
