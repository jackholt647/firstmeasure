# Development AI sticker placements — September 23, 2026

Release `02ccd8a43ddd5e056618db2a2fa03be3ed98fb45`, baseline `27b499736c25dae868743ab10b55f459a922c405`.

Stickers now offers Counts only or Counts + placements, with either all-face or parallel per-face requests and the existing model/effort controls. Placement output uses left/top offsets and width/height as percentages of the full upright face bounds. The prompt receives the face outline, aspect ratio and projected bounding corners to distinguish face coordinates from image coordinates.

Accepted rectangles become normal editable window, door or garage geometry, persisted together in one undoable edit. Validation rejects malformed percentages, out-of-face boxes, holes, overlap and faces changed since capture. Curved/nonplanar faces return counts only. Results retain counts, placement coordinates, raw responses and application/skipping details in browser history; reopening history does not reapply geometry.

All 85 focused tests passed across `dev/exterior-ai-stickers.test.cjs`, `dev/wall-features.test.cjs` and `dev/wall-mode.test.cjs`. Coverage includes both request styles, persistence, percentage conversion for oblique faces and either winding, invalid/overlapping placements, stale geometry, and grouped undo/redo. PHP lint and JavaScript syntax checks passed. API responses were mocked; no live AI placement accuracy claim is made.

The runtime delta contains `exterior_ai_stickers.js`, `wall_features.js`, `wall_mode.js` and `exterior_ai_stickers.php`. All other public files were verified unchanged during staging on all three development roles. Activation, readiness and outbound isolation passed on all three roles; all three public script hashes matched the release manifest. Deployment evidence and manifests are in ignored `output/exterior-ai-placements-20260923/`. Production is unchanged.
