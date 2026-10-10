# Development: plane overlays and sloped edge extrusion â€” October 10, 2026

Sources: `1905d4c8c124bb776bc6c23ce7dc463b14ad7ddb` and `5dc8e29f9103401970c65a63c3ec3532d4decd7d`, reachable from the canonical branch.

## Fixes

The drawing plane combined the normal wire graph with base/draft segments and raw roof references. Those later additions bypassed the deleted-edge masks, restoring lines already removed from the wall view. The combined graph now applies the masks to full and partial edge runs, including the final roof-reference union.

Plane points previously joined a global point batch containing off-plane vertices. Plane display dimmed the whole batch. Plane anchors now have a separate `planeGuide` batch, seven-pixel cyan markers, eleven-pixel selected markers, and dark halos above the grid.

Along-wall edge extrusion translated both endpoints at a fixed height. The saved wall has a pitched lower boundary, so either direction separated the endpoint from that boundary. Extrusion now intersects the displaced edge with its adjoining boundary directions; the geometry kernel checks the actual endpoint displacement when retaining neighboring connections.

Replacement world-space faces retain `draftKey` as ancestry after moving or resizing. Point/line placement incorrectly treated that field as live edit ownership, projecting preview coordinates into the old consumed draft. Placement now routes by the explicit `draft` discriminator, imports a current solid frame otherwise, and verifies the world/local round trip before insertion. Other scene mutation paths were audited: they already discriminate drafts; mesh picking uses render-owner metadata. An associated retained-anchor test used a projection that always returned zero normal distance; it now checks the unflattened coordinate before import. Existing misplaced saved anchors are not guessed at or automatically relocated.

## Validation

502 tests passed in `wall-face-draft.test.cjs`, `wall-plane-move.test.cjs`, and `wall-solid-geometry.test.cjs`. Regressions cover removed base/roof references and partial runs, separate full-opacity plane markers and selection sizes, and both signed extrusion directions using saved geometry in `dev/fixtures/sloped-base-edge-extrusion.json`.

Retrieved the user's saved project after confirmation and tested it in a local browser harness with the real editor, geometry modules, Three.js, camera rays, and plane-display filtering. Inspected old and fixed plane rendering, and inward/outward extrusion previews. The fixed endpoint remains on the saved sloped base within contact tolerance in both directions. This was a local replay of the saved project, not a write to its stored geometry.

Evidence: `output/plane-line-20261010/`: `plane-before.png`, `plane-after.png`, `plane-detail.png`, `inward-after.png`, `outward-before.png`, `outward-after.png`, and `tests.txt`.

Saved resized chimney fixture `dev/fixtures/resized-chimney-point.json` reproduces the one-foot sideways error. Regression checks cover three successive placements with serialization/reload, exact cancellation, and unchanged consumed source draft. A second test rejects off-plane retained anchors. Browser replay of the same chimney face fails on the original code and places the fixed point within 0.00000002 m of preview. Evidence: `chimney-before.png`, `chimney-after.png`, `chimney-detail.png`, `tests-chimney.txt` in the same output directory.

## Deployment

Only `wall_face_draft.js` and `wall_solid_geometry.js` are overlaid onto freshly audited development role baselines. Production is unchanged. Concurrent development releases were re-audited before overlays. One prior deployment uses a descriptive directory name rather than RELEASE_ID; preparation verifies the process working directory and release.env identity instead of assuming the basename equals RELEASE_ID. Activation still checks the exact audited path, runtime identity and source hashes.

The first plane-editing release reached compatibility, worker and primary web; the secondary pool receives the combined follow-up directly. The final rollout preserves concurrent project-preview/contact changes through per-role overlays.

### Verified serving state

All four roles passed exact owned-asset SHA-256 checks, runtime readiness, development identity, and enforced outbound isolation. Public HTTPS asset hashes and readiness passed. Compatibility was subsequently advanced by the concurrent release to `43583b571140330bf75a41231b01230f56af9660`; both corrected editor assets were preserved and verified there.

| Role | Verified release | Previous path at our activation |
| --- | --- | --- |
| web | `5dc8e29f9103401970c65a63c3ec3532d4decd7d` | `/opt/firstmeasure/releases/43583b571140330bf75a41231b01230f56af9660` |
| worker | `5dc8e29f9103401970c65a63c3ec3532d4decd7d` | `/opt/firstmeasure/releases/1905d4c8c124bb776bc6c23ce7dc463b14ad7ddb` |
| legacy | `43583b571140330bf75a41231b01230f56af9660` | `/mnt/firstmeasure_dev_releases/releases/project-contact-icons-5069afe0-r2-firstmeasure-development-compatibility` |
| pool | `5dc8e29f9103401970c65a63c3ec3532d4decd7d` | `/opt/firstmeasure/releases/43583b571140330bf75a41231b01230f56af9660` |

Verification records: `output/chimney-placement-20261010/verified-deployment.json` and `http-verification.json`. Rollback must preserve subsequent concurrent changes: re-audit current baselines and reverse only these two editor assets, or use the recorded full prior path only if no later release must be retained. Production was not changed.
