# Planar drawing movement — September 23, 2026

Development runtime: `ccc45af009b25a99af8ce46315f624dc42442c1b`.
Previous runtime: `90c6a3c9831c4935bc9b0d64a5f67e995e26146a`.

A Q edge crossing a slightly sloping wall boundary could refer to a resolved
intersection that was not connected in the stored sketch. Moving it retained
the original long construction edge and produced a diagonal. An independent
old-outline containment check could also block nudging before M changed ownership.

Straight intersections are now connected before affected edits. Ordinary planar
line M/nudge share one graph edit; they retain sketch ownership and derive the
updated faces and outline. General face resizing no longer uses sticker placement
constraints. Arrow keys during M finish an exact step, and returning a move to zero
restores the original state without an undo entry.

See [the engine audit](../../docs/editor-planar-editing-audit-20260923.md) for
scope, invariants, tests and limits.

## Verification

- 1,032 wall/roof/base/exterior tests pass, including sloping-top Q reproduction,
  both nudge directions, repeated mixed M/nudge sequences, cancel/reload, outline
  expansion, no-op commit and stable graph normalization.
- Only `wall_face_draft.js` and `base_sketch_geometry.js` were deployed as an
  explicit delta from the prior runtime. Architecture `4a3c46c` remains undeployed.
- All three development roles staged and activated successfully. More than
  23,000 unchanged public files per role were verified against the live baseline.
- Web, worker and compatibility runtime verification passed with development data
  and outbound isolation enforced. Public readiness reports the exact release;
  both served JavaScript SHA-256 checksums match the immutable commit.
- A separate authenticated editor tab loaded and rendered the saved house with
  95 sources, 54 faces and three chimneys. The original user tab was untouched;
  no rebuild or save was performed.
- Public HTTP briefly returned 503 during restart recovery, then recovered and
  passed the public readiness, asset and editor-route checks.

Evidence: `C:/Users/jackh/Code/2026/FirstMeasure/output/planar-editing-20260923/`.
Full test log: `output/quad-full.log`.

Production and saved project geometry are unchanged. Rollback uses the previous
runtime above with the existing role-specific activation procedure and PHP-FPM
refresh on web and compatibility roles.
