# Editor face defaults and resource tiles — October 11, 2026

V-created faces now omit an explicit material, so ordinary wall-mode display uses
the same yellow fallback as generated walls. The change and regression assertion
were included by the concurrent canonical editor commit `745f994c`. Existing
painted faces retain their saved materials.

The internal Resources viewer's file pane grows from 224px to 336px. Each role
group shows media in two equal tile columns with lazy photo previews and video
icons. Notes and other files keep full-width rows. Group collapse, file opening,
3D background actions and saved-frame jumps retain their existing behavior.
The pane remains an overlay at narrow viewer widths and is bounded by available
width.

Validation: 515 geometry/editor/core-view checks and five resource browser checks
passed. The browser checks cover equal tile columns, pane width, file reopening,
group persistence, overlays, uploads, frame jumps, markup and history routing.
Markup width assertions now verify screen-pixel widths independently of changes
to the fitted image scale when opening or closing the wider pane.

The layout evidence is in ignored `output/editor-resource-tiles-20261011/`.
The pending deployment was combined with the wall-selection fixes in
`7c40900917d67d4b41c235cc037beda9a3f25aed`; see
[the selection release record](development-editor-selection-20261011.md).
Its six-asset overlay includes these three assets and preserves the audited
live baselines. Deployment evidence and rollback paths are in ignored
`output/editor-selection-20261011/`. Production is unchanged.
