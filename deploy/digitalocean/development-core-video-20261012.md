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

## Release verification

Immutable release: `3b9873ba98c0854beef7856b4f8d6884449afb72`.

All four development roles activated successfully and passed final asset-hash
and readiness verification. Production was unchanged.

Public asset hashes match the committed JavaScript and CSS. Public readiness
reports the release with development data and enforced outbound isolation.

Rollback baselines:

- web: `/opt/firstmeasure/releases/f4305636e601a4c4a519aeced958813346691b1d`
- worker: `/opt/firstmeasure/releases/f4305636e601a4c4a519aeced958813346691b1d`
- legacy: `/mnt/firstmeasure_dev_releases/releases/f4305636e601a4c4a519aeced958813346691b1d`
- pool: `/opt/firstmeasure/releases/f4305636e601a4c4a519aeced958813346691b1d`

Rollback atomically restores the recorded current-link target and restarts the
role service; PHP-serving roles also reload PHP-FPM.
