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

Development rollout receipt pending. Production is outside this deployment.
The compatibility mirror remains blocked by its previously documented storage
capacity and inode exhaustion; no cleanup or reserve bypass was performed.
