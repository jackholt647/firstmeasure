# Base leveling and resoffit-safe regrading - October 8, 2026

L levels one selected purple base plane in both axes at its center elevation,
using the existing base attachment and undo path. The Editing panel also has
an L Level button. Point selections, wall layers, and Ctrl/Meta/Alt+L do not
invoke it. Source commits: 5f715ff5 and 2814fedc.

The saved Lake Washington project exposed an identity bug during regrade:
two generated source walls, already replaced by edited resoffit faces, were
split into four grade fragments. Their new IDs escaped draft ownership and
rendered the obsolete walls again. Base updates now leave drafted generated
sources unchanged. Existing edited faces follow only their old base-contact
edges vertically. Loading and undoing older snapshots preserve draft ownership
of grade fragments. No roof extrusion, deduplication, or soffit rebuilding is
invoked by a base or reference-grade change; reference-grade changes without
Reground do not change existing geometry.

Validation: 106 base editor, base binding, and wall mode tests passed. A local
replay of saved undo entry 260 preserves all 79 generated IDs, every XY position,
and every roof contact. Loading the saved broken state hides all four stray
fragments behind their existing edited replacements. Customer data was read
only; no project save was performed by the deployment.

Development web, pool, and worker are verified at
2bcbffbe12b1778c330da572cb768e2a765bf9f0. Exact deployed hashes match the
closed-soffit, base-level, and regrade sources (8 files per web node; 7 on worker).
All three runtime readiness/isolation checks passed. The project and internal
editor capability returned HTTP 200 on both web nodes. Anonymous asset requests
redirect to the sign-in page; file verification was performed on the deployed
release directly. Production is outside this deployment.

Follow-up: N drawing now retains the supporting plane when started from a base
point selected by the shared 3D picker. Previously, hovering outside a boundary
could lose the face hit and measure edge snaps at Z=0. Two regression cases click
six screen pixels inside/outside an oblique edge of a raised, pitched base and
require an exact boundary endpoint and two resulting faces. All 60 base editor,
sketch control, and sketch geometry tests pass. Snap follow-up deployed and verified at
f5bce5c8d6a35b1d91949cfc1025758ec6f178f8 on web, pool, and worker. Cumulative
verification matched all 9 editor files on each web node and 8 on worker.
All readiness/isolation checks passed; the project and internal-editor
capability again returned HTTP 200 on both web nodes.
The compatibility mirror remains blocked by its previously documented storage
capacity and inode exhaustion; no cleanup or reserve bypass was performed.
