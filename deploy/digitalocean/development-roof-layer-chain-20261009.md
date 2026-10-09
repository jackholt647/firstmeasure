# Development nearest roof-layer contacts — October 9, 2026

Source: `c967b5cb0e1ffc7cc71e8602e24eed260c38974a`.

The captured Lake Washington Boulevard junction has three roof levels. The lowest roof's R86 flashing is approximately 10.94 mm outside the middle roof's side boundary. Strict containment missed that middle roof, so flashing either reached the main roof or vanished where the main roof ended. The middle roof also extended past the lower roof rather than stopping at it. A later roof-top clipping pass independently erased corrected contact spans by capping them at the lowest roof.

Generation now resolves finite, near-parallel flashing contacts within the existing 20 mm construction tolerance before selecting the nearest target roof. Each interval selects its next roof by elevation. Target metadata is retained only for those resolved contact spans and is honored by roof clipping. Coalescing keeps different contact targets separate. Original roof and ground geometry are not modified. Existing dedupe and coplanar merging combine the resulting wall sections.

## Verification

- Retrieved saved project read-only and confirmed its roof matches the captured canopy-junction fixture.
- Seven new tests cover exact contact, the 11 mm survey gap, a larger gap that must not be bridged, three rotated captured-junction cases, finite contact limits, and absence of flashing evidence.
- Tests check nearest-layer target identity and the captured wall surviving the full generation/cleanup pipeline. Four of the first six tests fail with the previous geometry module.
- Full relevant suite: 308 tests passed, zero failures.
- Replayed the actual 2-foot From Roof handler and inspected oblique renders from both sides. Corrected result: 63 sources, 45 rendered wall faces, zero ground-reaching open perimeter edges. Before had 46 faces; the resolved contact joins the side plane.

Evidence: ignored `output/layer-chain-20261009/` contains metadata, test logs, generated geometry, and comparison screenshots. The browser preview uses actual production topology from an isolated handler replay; the user's saved walls are not overwritten.

## Deployment preparation

The immutable overlay contains only `wall_geometry.js` and `base_geometry.js`. Existing live changes from the concurrent development release are preserved by fresh per-role baseline audits. No production, database or configuration changes.

Compatibility staging initially failed its 1 GiB reserve check. The existing release volume had 12 GiB free but no available inodes. Cleared 88 MiB of downloaded apt package cache on development compatibility (installed packages, code and rollback releases untouched), then resumed the original hardlink staging workflow on root with its reserve check intact. No activation occurred during failed staging attempts.

Served-asset verification: both JavaScript modules downloaded from dev.1m8.ai match the immutable overlay hashes. Replayed the actual From Roof handler with those downloaded modules, reran all seven new regressions successfully, and inspected the resulting corner. Screenshot: deployed-after.png.

Rollout complete: all four development roles verified on the source release above, including file hashes, runtime identity, readiness and development isolation. Public readiness and asset hashes passed. Existing saved walls need refresh and an explicit From Roof rebuild. Per-role rollback paths remain in the ignored deployment manifest.
