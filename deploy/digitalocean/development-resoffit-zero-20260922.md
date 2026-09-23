# Zero-depth chimney Resoffit — September 22, 2026

Runtime release: `1730b0ea934dfca700e1f246738868f57e10e2e3`.
Baseline and rollback target: `9aa47ca76f3411dc2f6b5c69e9078177f970310a`.

## Cause and correction

Selecting both contact edges of chimney-side roof 34 on the saved house and setting Resoffit to zero rejected the edit as reversing a neighboring wall. A narrow exposed chimney return legitimately collapses when its adjoining boundaries meet, but survey drift left a reversed strip approximately 0.0094 mm wide and 0.94 m high. Its area exceeded the old area-only degeneracy threshold.

Changed vertical returns now also use the geometry kernel's existing contact tolerance (0.01 mm) for their horizontal width. A collapsed neighbor receives the existing deletion marker so its editable draft is consumed. A selected wall that disappears is still rejected, and the normal reversal check remains in place for nondegenerate faces. There is no special substitution of a small positive depth for zero.

## Validation

- 902 editor and geometry tests pass.
- Eight new integration cases cover four chimney-side roofs starting at 18 and 24 inches. Each sets zero twice, increases to six inches, then returns to zero, reloading edited geometry between operations.
- Checks cover selected contact continuity, absolute depth, face and foundation validity, complete undo snapshots and reload preservation.
- Two of these cases reproduce the original reversal error with the correction disabled; all eight pass with it enabled.
- The exact saved-house roof-34 selection also reproduced the error before the correction and succeeded afterward.

## Scope

Only `wall_resoffit.js` is included in the runtime delta. The changed asset baseline hash and all unchanged public files are checked on each development role before activation. Source and tests are synced to the primary local workspace after checking for divergence.

All three development roles activated successfully. Public readiness reports the new release with development isolation enforced, and the HTTP asset checksum matches.

In a separate live editor tab, both contact edges of the lower chimney-side roof were selected and Resoffit was set to 0 ft. Apply succeeded with the status “Selected soffits updated; neighboring wall planes preserved.” Both contact lines remained selected and the visible overhang was removed. The original user tab and its selection were not modified; no server-side save was made.

Production was not changed.
