# Paste without double lines, K toggles pitches — development, October 21, 2026

Source `a8154fde09534e17df99717e70f43656bd3c48e0`, on session branch `claude/upbeat-almeida-37f1dd` (a child of
canonical `9344c0ec`; not yet on the canonical branch).

## 1M8-226 Double lines when pasting

**Cause.** When pasted geometry is placed, its points merge onto existing points within the snap radius
(`finalizeMoveLogic` → `mergePoints` in `interaction_2d.js`). `mergePoints` rewired every connection from the pasted
point to the existing one but never removed connections that now joined the same two points. Pasting a facet beside
an existing one, sharing an edge, left two stacked lines on that edge. They draw as one, so QA cannot see them, but
both are measured. The line-split path could produce the same duplicate.

**Fix.**
- `removeDuplicateConnections` keeps the earliest (existing) connection between two points and drops later copies. It
  runs after every merge and after the move's splits.
- Pasted lines in line selection mode now merge onto existing points too (before, they stayed separate overlapping
  points and lines).
- A held or repeated Ctrl+V, or a second one while the clipboard read is pending, no longer stacks an identical copy.

**Test.** A Node harness running the shipped `finalizeMoveLogic` on a square pasted against an existing square: the
previous code leaves 8 lines with 1 duplicate; the new code leaves 7 lines, no duplicates, in point and line modes.
It also passes against the file served by dev.

## 1M8-191 Keyboard shortcut for pitches

**K** toggles pitch labels, the same as the 3D PITCH button (`window.togglePitchLabels`). K was unbound. It is
`KB_MAP.PITCHES`, it is listed in the help bar as "Pitches", and the button tooltip names it. It is ignored in wall mode,
where the PITCH button is hidden.

## Rollout

`interaction_2d.js`, `main.js` and `scene_3d.js` were 3-way merged onto live release `8c908166` on legacy, web and
pool (`output/paste-pitch-20261021/ship.sh`). Every role staged, activated and verified. The served files contain the
change. Editor scripts are cache-busted by `fm_editor_asset_version`, so no key changed. Worker and production were not
changed. Not checked in a signed-in browser.
