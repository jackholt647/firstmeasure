# Development: analytic spline invariants

Release: `1291c36f5f38012dad495c6d998e8db5695081f5`.
Baseline: `7138ad6b609eaf8f5c4af4da6f56057703eeabe2`.

Sticker face reconstruction rounded sampled curve endpoints onto the geometry grid. A fixed parameter tolerance failed on short intervals, exposing twenty evaluated sample vertices as editable points in the reproduced door case. Shared metric-tolerant curve recognition now preserves original controls and real junctions. Sketch creation/reload/rebind and imports restore analytic interval ownership; paste and merge paths retain mapped curve definitions. Missing analytic definitions are rejected instead of silently flattening edges. See [the audit and invariant contract](../../docs/architecture/spline-editing-invariants.md).

All 467 focused drafting, sketch, solid and invariant regressions passed. The separate curved-surface suite has 13 passing tests and the two previously documented eave-extrusion failures. Logs: `output/spline-invariant-tests.log` and `output/spline-curved-surfaces-tests.log`.

The immutable four-script delta preserves the current publication/AI runtime: staging verified 24,505 unchanged public files on web/legacy and 24,519 on worker. All three roles passed exact-release readiness verification. All four public script hashes match; fresh public readiness confirms this release, development data and enforced outbound isolation. Earlier public readiness responses returned an older release ID, and one asset read was interrupted; verification passed on retry. The public editor requires login, so validation did not exercise the user's authenticated model.

Deployment evidence: `output/spline-invariants-20260923/`. Production is unchanged.
