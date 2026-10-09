# Base leveling at a single shared edge - October 8, 2026

Source `2a4a948a4049fd87fc110dc71d724dca2ee54726` changes L for purple
base faces. Exactly one neighbouring base sharing a nonzero, horizontal 3D
boundary anchors the flattened face at that edge height. Partial overlaps and
subdivided edges count as contact with the same neighbour. The neighbour and
all XY coordinates remain unchanged. Existing attachment following moves only
supported wall bottoms; undo restores base and wall edits together.

Zero or multiple neighbours, corner-only contact, vertically separated edges,
and a shared edge which slopes retain the center pivot. A horizontal face
cannot preserve every height along a sloping shared edge. Y's manual pitch and
H's existing multi-face alignment behavior are unchanged.

51 focused base geometry, editor and ownership tests pass. New cases cover both
ends of a slope, partial/subdivided contact, excluded contacts, attachment
following and undo. Commit `32006c52` adds a joined-chimney regression through
pitch about both axes, leveling, serialization and reload. Syntax and whitespace
checks passed.

The user reported a separate chimney patch after base rotation but confirmed
that continued testing had removed that exact state. The current saved project
contains one joined base with both chimney footprints, and rotation/reload
replays preserve it. This release does not claim a fix for the unreproduced
chimney symptom and did not modify the user's saved geometry.

The deployment uses a two-file immutable overlay, preserving each role's
independently audited live baseline. Public browser inspection after compatibility
activation returned the editor successfully with base_geometry hash prefix
`7798b3f263348fe8` and base_editor prefix `dc99b7afa83cc333`; no console errors
were captured. A transient Not found response during web activation cleared
on reload after activation. Local audit and deployment evidence is under
`output/base-contact-level-20261008/`. Production is untouched.

All four development roles passed final owned-file hashes, runtime identity, readiness and isolation checks for source 2a4a948a. Public asset bytes also matched the committed source.
