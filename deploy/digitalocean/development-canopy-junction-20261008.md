# Development: continuous upper wall at a skewed awning — October 8, 2026

Source/runtime release: `8c3e0c356058a87c085377eba79eb3b7fcf7690a`.

Replayed the Lake Washington Boulevard saved roof/grade geometry (saved October 8 at 11:18:52 PM Central). The generated upper wall behind roof 21 was shifted independently at each support interval midpoint. Its slightly skewed back edge produced an 8.097 mm internal seam and displaced corner endpoints. Generation now intersects both interval ends with the same measured entry-edge line. The captured house and two rotated versions align continuously and reach both awning corners.

Validation:
- Three captured-project regressions fail against the previous implementation and pass with the fix.
- Existing base and layered-roof suites: 67 pass; total with new regressions: 70 pass.
- JavaScript syntax and scoped diff checks passed.
- Local before/after geometry and alignment plot: `output/canopy-junction-20261008/`.

This is a generation correction, not a saved-project migration. No project metadata, roof drawing, grade or manual edits were written. Reload alone does not regenerate persisted wall arrays. The larger canopy-derived footprint projections remain a separate concern; this release does not infer wallless status from roof shape or claim to eliminate every pictured artifact.

Only `public/measure/internal/editor_scripts/base_geometry.js` was deployed, preserving each freshly audited role baseline. Compatibility, web, pool and worker have matching asset hashes, runtime identity, readiness and development isolation. Public asset hash and public readiness verified. Production unchanged. Verification evidence is in the output directory above.
