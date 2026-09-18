# Solid textured door backings — development

Release: `2d423723eea7289975173b05432b832a92ce71d6`.
Baseline: `919a83512067fade4929148a1fd34db73493251c`.

The detailed opening renderer replaced the double-sided source material with a front-sided door material. Backface culling could hide the flat backing while raised panel boxes stayed visible. Garage and regular door backings now use an opaque double-sided material. Geometry, measurements and saved projects are unchanged.

The browser regression raycasts the actual derived backing mesh from both directions and checks opacity for each door type. It failed before the fix and passed afterward. All 23 rendered, finish and skylight tests passed, including real WebGL rendering and 4K export; the visual fixture showed solid panels/backing. Port 8031 serves the exact tested renderer after a guarded update to the canonical local asset.

The development runtime delta contains only `public/measure/internal/editor_scripts/exterior_rendered.js`.

All three development roles staged and activated the release, verifying 18,100 other runtime files unchanged, a quiet worker queue, and enforced development isolation. Public readiness reports the exact release and the served renderer matches the tested local source. Production is unchanged.
