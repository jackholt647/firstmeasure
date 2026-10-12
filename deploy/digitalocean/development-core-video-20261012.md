# Core Views video and compact file navigation — October 12, 2026

The Resources toolbar now begins with Files, Upload and Core Views. Files toggles
the sidebar; Core Views retains its selected state independently. The redundant
Project files heading and sidebar Core Views button are removed. QA, Tech and
Customer sections have full-width headers, no outer card margins, and compact
two-column media grids.

Videos appear in a dedicated first section. Core Views replaces the center house
diagram with an inline video player, preserving the eight surrounding directional
photo slots. Multiple videos can be selected in the center tile. Open video carries
the current playback position into the full viewer. Leaving Resources or opening
another file pauses the inline player. Projects without video show No video.

Six browser checks passed: toolbar order and state, sidebar width and full-width
sections, video priority, center placement, playback, video switching, playhead
handoff, pause on exit, no-video layout, file reopening, markup, frame jumps and
uploads. A browser screenshot was inspected at 1200×800; existing responsive
layout checks also cover 700px width.

Development preparation audits all four live roles and overlays only
project_resources.js and project_resources.css from the immutable commit.
Evidence, manifests and rollback paths: ignored output/core-video-20261012/.
