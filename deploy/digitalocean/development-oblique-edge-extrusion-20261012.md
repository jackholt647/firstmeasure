# Oblique edge extrusion — development, October 12, 2026

Source `2865671267fe691394a265a2c6e52148eddb41cb`, integrated through `ef102928`.

Edge extrusion previously inserted displaced vertices into adjoining face rings
when the displacement left their supporting plane. Normalization then rejected
the bent polygon, including at 80- and 100-degree corners. The extrusion now
preserves that adjoining face and creates separate planar returns. Existing
coplanar surfaces are subtracted from only the new returns to avoid duplicates;
source surfaces are not subtracted. Move behavior and plane validation remain.

661 geometry/editor tests passed. The 15 targeted oblique tests passed after
adding placement checks and two swept-area/no-overlap regressions. Tests cover
both signs, 80/90/100-degree corners, complete/partial edges, repeated E toggles,
immutable input, cancel, exact preview placement and one undo entry. Browser
replay at a 100-degree corner toggled E twice, entered one foot and placed once
with every face planar. This reproduces the reported error mechanism synthetically;
it does not require the user's transient project state.

## Verified development rollout

Only `public/measure/internal/editor_scripts/wall_solid_geometry.js` was overlaid
onto audited immutable frontend baselines. A concurrent backend rollout caused
the baseline guard to stop staging; after it completed, all roles were re-audited
and restaged, preserving that rollout. Backend runtime
`e0cd44a5db3f4100ed2047c61d48b7aba02cc088` and its PIDs were retained. Activation
reloaded PHP only. Worker and production were unchanged.

All three serving roles passed source hashes, JavaScript syntax, readiness,
runtime identity, development isolation and enforced outbound safety. The file
served over HTTPS from dev.1m8.ai matched the tested source SHA-256. Evidence,
role manifests, rollback baselines and browser capture are retained in
`output/oblique-edge-extrusion-20261012` and remote release receipts.

| Role | Frontend release | Previous frontend |
| --- | --- | --- |
| web | `/opt/firstmeasure/releases/2865671267fe691394a265a2c6e52148eddb41cb` | `/opt/firstmeasure/releases/e0cd44a5db3f4100ed2047c61d48b7aba02cc088` |
| legacy | `/mnt/firstmeasure_dev_releases/releases/2865671267fe691394a265a2c6e52148eddb41cb` | `/mnt/firstmeasure_dev_releases/releases/e0cd44a5db3f4100ed2047c61d48b7aba02cc088` |
| pool | `/opt/firstmeasure/releases/2865671267fe691394a265a2c6e52148eddb41cb` | `/opt/firstmeasure/releases/e0cd44a5db3f4100ed2047c61d48b7aba02cc088` |

Rollback only the owned kernel patch, preserving later work. With no subsequent frontend changes, restore the recorded previous symlink and reload PHP; retain backend runtime identity.
