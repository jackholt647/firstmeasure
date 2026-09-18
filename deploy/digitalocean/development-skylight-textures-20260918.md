# Textured roof skylights — development

Release: `919a83512067fade4929148a1fd34db73493251c`.
Baseline: `b77f3943131657b76e10429c2082ed1cb25fdd52` (complete local exterior editor sync).

Closed roof outlines classified as skylights produce presentation-only glazing in Textured mode. They reuse window rendering with dark frames, a single glass pane, and no wall-window sill or interior floor detail. Match textured uses the corresponding opening texture. Existing roof feature geometry, measurement data, undo data and reports are untouched. Hiding the roof hides skylights; opaque/translucent retain their existing drawing behavior.

The display derives closed loops from roof connections, ignores incomplete/branched/invalid outlines, preserves roof slope, and cuts only display surfaces on the matching roof plane. Roofs underneath are not cut. Existing holes remain valid. Render-cache keys include the derived skylight faces so mode/roof changes dispose or rebuild their presentation meshes normally.

Local verification preceded deployment at `http://127.0.0.1:8031/measure/internal/`. The sandbox serves the three scripts from the canonical checkout. Each served response matched the tested source after newline normalization. Changes were applied to canonical files only after checking them against the shared baseline, preserving other work. A synthetic preview at `/measure/internal/skylight-texture-preview.html` verified two skylights with glass/dark frames, switching to roof geometry and back, unchanged measurements, and no browser errors. No user project was edited or saved. The preview is local-only and is not in the deployment delta.

Validation: the skylight/finish suite passed 22 tests, including sloped openings, separate glass meshes/UVs, no lower-roof cuts, existing holes, duplicate/reversed edges, malformed outlines, multiple skylights and source immutability. Existing persistent WebGL rendering and wall-mode tests passed (54 additional tests). All three changed JavaScript files pass syntax checks.

The runtime delta contains only `exterior_finishes.js`, `exterior_rendered.js` and `wall_mode.js`. Production activation is not authorized.

All three development roles staged and activated this exact release. Staging verified 18,098 other runtime files unchanged; activation verified development isolation and a quiet worker queue.

Public dev readiness recovered on the exact release with outbound isolation enforced. All three scripts served by `dev.1m8.ai` match the tested local files after newline normalization. Production is unchanged.
