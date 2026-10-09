# Merged chimney editing - October 8, 2026

Joining upper and lower sections of the same chimney side now preserves chimney
identity and its drafting color. The merged face remains a local edit and does
not drive the entire shaft footprint. Mixed house/chimney merges retain their
existing joined-region behavior.

A saved-project replay reproduced the planar-region error after merging chimney
faces and extruding through an adjacent roof. The trimmed neighbor had a hole
touching its outer edge; world-to-face projection displaced the contact by
floating-point roundoff, confusing Earcut. Triangulation stabilizes hole/outer
edge contacts within one nanometer in its input only. Original coordinates,
indices, planarity checks and area-conservation checks remain unchanged.

Validation: 91 kernel/chimney/chamfer tests passed, including a minimized 2.6 KB
saved-geometry extrusion regression and winding reversal of the touching-hole
case. The broader suites passed 479/480; the previously recorded generated
chimney-support selection test remains failing. M/E previews over 64 combinations
of merged face, direction and distance, with snapping enabled, returned no errors.
The user's current failing state was unavailable. The exact null.dx exception
was not independently reproduced; no speculative plane fallback was added.

Deployed source commit 386ba83e100408e04cdc1cb3825ce7c5fa5c822d to development
web, pool, and worker. Both JavaScript hashes match on every role. Runtime
readiness and development isolation passed. Internal editor capability and the
saved project returned HTTP 200 on both web nodes. Customer metadata was read only.
Production is untouched. The compatibility mirror remains excluded because its
storage reserve/inode capacity blocked staging; no cleanup or bypass was made.
