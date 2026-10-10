# Development: combined selected-line length — October 10, 2026

Source: `f718a0e40225324c1129fee780023080f4793c43`; base regression update: `647d918e`.

The main-header readout now sums every selected line in roof, wall, base and drawing-plane modes. Wall/base curves retain their sampled 3D arc length. Roof horizontal coordinates are converted from image pixels to metres before combining with elevation. Drawing previews keep their existing measurement behavior; an empty selection hides the readout. Unit formatting is unchanged and applied after summation.

Validation: the wall suite passed 441 tests. The base suite initially identified its old expectation that multiple selections hide the readout; after updating that expectation, all 28 base tests passed. Direct execution of the roof header calculation verified two sloped lines measuring 5 m and 13 m total 18 m, then clear to null. JavaScript syntax checks passed.

Deployment overlays only `wall_face_draft.js`, `base_sketch_editor.js`, and `wall_mode.js` onto each audited development baseline. Production is unchanged.

All four development roles verified the exact three asset hashes, runtime readiness and enforced development isolation. Public HTTPS assets and health also passed. Records: `output/selected-length-20261010/verified-deployment.json` and `http-verification.json`.

| Role | Previous release path |
| --- | --- |
| web | `/opt/firstmeasure/releases/5dc8e29f9103401970c65a63c3ec3532d4decd7d` |
| worker | `/opt/firstmeasure/releases/5dc8e29f9103401970c65a63c3ec3532d4decd7d` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/43583b571140330bf75a41231b01230f56af9660` |
| pool | `/opt/firstmeasure/releases/5dc8e29f9103401970c65a63c3ec3532d4decd7d` |

Rollback: re-audit current roles and reverse only the three owned assets if subsequent releases have landed. Full previous paths above are safe only when no later changes must be retained.
