# Development textured finish color correction

- Runtime: `de6235dfdd1a7464c70349ebe887fe7855963a42`.
- Baseline: `3bf6dab5e60a1cf12b710e7afe357cad493b1803`.
- Branch: `codex/exterior-trim-controls`.
- Three.js r128 stores CSS material colors without converting sRGB to linear light. The editor switches output encoding when 3D tiles become visible. The original finish path therefore displayed the same orange (#ffb866) as RGB (255,184,102) without tiles and (255,221,170) with tiles in an unshaded WebGL fixture. Textured siding likewise changed from (174,125,70) to (215,186,143).
- Finish tints now convert to linear light before neutral texture/shading multiplication and use one sRGB output transform regardless of background mode. A material uniform disables that output override when leaving textured mode. No global renderer or roof-mode color change.
- Texture grain, directional shading, and selection highlighting remain active. Selected faces intentionally brighten; judge the finish on an unselected face.
- Public delta: `exterior_finishes.js` and `wall_editor.js`. Concurrent report, opening texture/trim and marker work was preserved in the shared checkout and excluded from this release.
- Validation: 327 focused shared-checkout tests; 320 isolated release tests (including real WebGL pixel tests and palette browser coverage); 318 non-browser checks on Linux. The new render test failed before the repair and passes afterward. It covers swatch RGB, textured siding with both output encodings, display-mode restoration and selection/deselection.
- Artifact: `/home/dev/exteriors-de6235d.tar.gz`, 249944876 bytes, SHA-256 `54d85415b302cafa22e0285d46c0a24f148a5f93842ff24b13cca574ab01ea5f`.
- All three development roles staged with 1335 unchanged public files verified, then activated successfully. Public readiness recovered after restart and reports the new development release; both public modules match tested Git source after newline normalization.
- Experimental access, outbound isolation, dependencies, database configuration, and production are unchanged.
