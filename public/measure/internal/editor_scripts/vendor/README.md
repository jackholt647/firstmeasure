# Geometry dependencies

These pinned browser/CommonJS distributions are served locally. No geometry
package is downloaded when an editor loads.

| Package | Version | Upstream | License |
| --- | --- | --- | --- |
| clipper-lib | 6.4.2 | https://github.com/junmer/clipper-lib | Boost Software License 1.0 |
| earcut | 3.2.3 | https://github.com/mapbox/earcut | ISC; `earcut-3.2.3-LICENSE` |

Retrieved from the npm registry tarballs and verified against their published
SHA-512 integrity values before extracting the individual distribution files:

- clipper-lib: `sha512-knglhjQX5ihNj/XCIs6zCHrTemdvHY3LPZP9XB2nq2/3igyYMFueFXtfp84baJvEE+f8pO1ZS4UVeEgmLnAprQ==`
- earcut: `sha512-vnS4AVwp1KHAF13i1vp1/2D5evWy3k5u/iW/B81QVsUZtV8cv2tU0b2VNFlqvh4kYwrFMDdjPCfAmfyJW9y14Q==`

Keep upstream distributions unmodified. Adapt behavior in `exterior_geometry.js`.
When upgrading, run the geometry suite and both saved-building replays, followed
by the browser sequence in `editor_tests/engine_rebuild_check.html`.
