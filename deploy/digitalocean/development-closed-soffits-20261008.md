# Closed soffits and construction wall areas — October 8, 2026

The Walls panel has a Closed soffits toggle. It applies to an existing model
without invoking From Roof or changing wall geometry, base, grade, or drawing
edits. The preference also applies on future From Roof rebuilds. Toggling off
preserves underside edits for toggling back on; individually deleted panels
remain deleted. The toggle is undoable and saved with the project.

Editable undersides meet the roof edge elevation, independently of fascia
height. They are horizontal across the overhang and follow the edge along
sloping rakes. Neighboring runs share outer corner joins; zero-setback flat,
glass and parapet boundaries are excluded. Their distinct light green finish
and roof ownership persist through drawing and save/reload. Roof visibility
hides their faces and drawing geometry independently of Walls visibility.

Walls retain their full structural height to the roof. A derived presentation
splits only their display/takeoff polygons at the underside: material enclosed
between the soffit and roof is gray and marked constructionOnly. It remains
selectable/editable but is excluded from siding totals. Deleting an underside,
including partial deletion, or switching the global toggle off immediately
restores the exposed area to normal siding classification. No wall reshaping
or regeneration is involved. Reports retain the construction polygons separately.

Validation: 79 geometry and wall-mode tests passed, 14 report/editor tests passed,
and three focused face-editor tests cover deletion, roof visibility and gray
construction rendering. Saved-house evaluation produced 25 panels and 53
construction display regions in about 104 ms, with wall coordinates unchanged.
The broader editor suite has a previously recorded chimney-support selection
failure; it is unrelated to this feature. Customer project data was read only.

Final development rollout verified on web, pool, and worker. The cumulative
release 2bcbffbe12b1778c330da572cb768e2a765bf9f0 preserves all seven editor files
on web and pool;
worker retains its older unused PHP entrypoint and has the six JS files.
Runtime readiness and development isolation passed on all three roles; the
customer project and internal-editor capability return HTTP 200 on both web
nodes. Full face-editor suite: 424/425 pass, with the known failure above.
Compatibility staging was blocked by storage: root has 563 MiB free (below the
1 GiB reserve), while the release volume has zero free inodes. No releases or
customer data were deleted and no reserve was bypassed. Production is untouched.
