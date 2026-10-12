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

Development rollout evidence is in ignored `output/editor-resource-tiles-20261011/`.
The release overlays only the three owned editor assets onto freshly audited
role baselines, preserving all unrelated live content. Production is unchanged.
Rollback uses each recorded `previous_path` and the existing role service.
