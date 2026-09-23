# Development: compact measurement display buttons

Release: `be04d368ac308b4ea533dbfd1402078fdf43576e`.
Baseline: `bd46f13dda3bfcc183c9cfeecfb224e78275fc49`.

The measurement dropdown is replaced with three connected buttons: All, Moving and Off. The 3D toolbar uses a dark, compact 26 px control with a gold active state, descriptive tooltips, accessible names, pressed states and a visible keyboard focus outline. Existing saved display preferences and measurement behavior are preserved.

Validation: all 64 wall-mode tests passed. An isolated Chrome layout check verified labels, tooltips, active state, equal height and adjoining button edges; the screenshot was visually reviewed. Evidence is in `output/measurement-buttons-20260923/`.

Deployment uses a two-script immutable delta with baseline guards and unchanged-file verification, preserving the concurrent FOV and nudge releases. Production is unchanged.

All three development roles passed release/readiness verification, and both public asset hashes match the immutable commit. The initial public request returned 503 during activation; the final check passed after all roles were ready.
