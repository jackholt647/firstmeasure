# Development: base multi-selection editing — October 10, 2026

Source commit: `03143cf6383159826006d74c27a1437891df2e9f`.

## Behavior

- Base N previews and connects every selected anchor to one new endpoint, retaining shared guide/edge snapping. The supporting plane is chosen from the selected anchors. Cancel leaves geometry unchanged; placement is one undo action.
- Base M moves every selected face by the same elevation change. Height snapping excludes the moving faces and can use any selected face to find a fixed target.
- Base Y adjusts every selected face about a shared pivot. The common change in slope preserves shared seams and existing height differences. Numeric input still specifies the active face's resulting pitch. Unselected faces remain fixed.

## Validation

161 tests passed across base editor, sketch controls, sketch geometry, wall/base binding and wall mode. New tests cover 2/3/4-anchor fans in both views, pitched planes, visible overlay and SVG previews, anchor reuse, face partitioning, cancel/undo, and grouped M/Y with and without the sketch adapter.

Browser visual regression using the actual base sketch editor and geometry scripts confirmed four white preview segments over a filled pitched base with yellow guides, followed by four connected faces and one undo step. This was a focused browser fixture, not a visual check of the user's saved house.

Local evidence: `output/base-fan-20261010/` (`tests.txt`, `wall-tests.txt`, `preview.png`, `placed.png`, `visual.html`).

## Deployment

Only `base_editor.js` and `base_sketch_editor.js` are overlaid on each freshly audited development role baseline. Existing unrelated source and backend files are retained. Production was not changed.

Previous role paths:
- web: `/opt/firstmeasure/releases/f35602dd98df2c6487d6b50bd49ae63b25855171`
- worker: `/opt/firstmeasure/releases/1e0d09bbe3a57e5c62987430ae0f66da5c3dab52`
- legacy: `/mnt/firstmeasure_dev_releases/releases/f35602dd98df2c6487d6b50bd49ae63b25855171`
- pool: `/opt/firstmeasure/releases/f35602dd98df2c6487d6b50bd49ae63b25855171`

All four development roles verified at the source commit: running process identity, both editor asset hashes, readiness, and development isolation. Public HTTPS also served both exact JavaScript hashes and reported the same healthy release. Verification artifacts: `verified-deployment.json` and `http-verification.json`.

Rollback: use the existing guarded release workflow to reactivate the recorded previous role paths, verifying their current validity and preserving any subsequent concurrent releases.
