# Development: visually verified wall junction generation — October 9, 2026

Runtime/source commit: `6314cedbfd073b468e5e9c8135a3f9397ce1ad63`.

The preceding contact fixes were tested numerically but did not remove the visible stepped returns in the Lake Washington Boulevard project. This change resolves a narrow lower roof's measured back boundary before generating the upper wall. Exterior skylight boundaries qualify only when they face the upper eave, cross its setback region, lie beneath its roof, and provide sufficient overlap. Explicit flashing takes precedence. The source follows the actual measured line, including survey skew, and contact repair cannot jump onto an unrelated lower roof at the end of that run. Small fallback-footprint miter spurs resolve to the existing source corner.

Validation:

- 259 tests across generation, foundation, contact, zero-soffit, extrusion, restoration and wall-mode suites passed; an additional From Roof/save/reload integration regression passed (260 distinct tests).
- Captured-project regressions run at three rotations and check both measured endpoints, absence of the narrow full-height front return, no contact jump to the neighboring roof, a closed perimeter, and immutable roof inputs.
- The regrade integration retains exact binding comparisons for all intermediate stages and count/ID/top/XY preservation for the visible final stage. Intermediate stages may split where they cross the final cleaned foundation.
- Read the live editor and visually confirmed the original defect. Used a separate local WebGL viewer to inspect the generated output at both corners, with roof visible and hidden. The viewer renders production topology from the captured project, not hand-authored replacement geometry.
- Executed the actual From Roof UI handler in the existing isolated wall-mode harness: 69 sources, 47 wall faces versus 51 previously, zero detected open perimeter edges. Save/reload retains the generated geometry.
- Downloaded the public development JavaScript, verified its commit hashes, reran that handler using those downloaded modules, then reloaded and inspected the resulting 3D view. Evidence is in `output/wall-junction-visual-20261009/`, including matching `corner-before.png` and `corner-after.png`.

This is a generation correction. It does not silently rebuild persisted wall edits on refresh and did not write project metadata or regenerate the user's working browser tab. Existing work requires an explicit From Roof rebuild to use the new generation, with the normal replacement/undo behavior.

Deployment stages only `base_geometry.js` and `wall_geometry.js`. A compatibility-host space guard initially stopped staging. Four old upload tarballs (44,010,205 bytes) were downloaded, SHA-256 verified, and retained locally before removing those exact server archive files. Active releases and rollback trees were retained; see `archive-backup/manifest.json` in the evidence directory.

All four development roles (compatibility, web, pool, worker) activated the source commit above and passed file-hash, release-identity, readiness and development-isolation verification. Public assets and public readiness match that release. Production was untouched.
