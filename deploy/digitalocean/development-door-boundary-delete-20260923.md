# Development: preserve opening wires on edge deletion

Release: `6fce7d7f2cadb8454c154afb86e11fe5796ad160`.
Baseline: `66c0cd14f12afa8b8a673bb97530f8ecc98ba071`.

Deleting an opening edge could union its feature face into the underlying untyped wall, consuming the other opening boundaries. Feature faces no longer merge with untyped faces through this operation. When the outline is open, only the selected wire and invalid fill disappear; the remaining wire, including its analytic spline identity, survives.

Invalidated faces are rebuilt through the shared planar arrangement using their surviving boundaries and coplanar loose/construction wires. Candidate regions must overlap the source and share surviving boundary. Unrelated isolated loops and off-plane paths cannot become replacements. Rebuilt faces retain feature metadata, holes and analytic curves, including a copied spline that closes the new outline. Draft curve IDs are qualified by their owner during reconstruction.

All 459 wall drafting, solid geometry and base sketch checks passed. New regressions cover open and closed arched doors in ordinary and plane modes, preserved supporting walls, surviving boundaries after serialization, two analytic curves on the replacement door, one history snapshot, and unrelated/off-plane alternatives.

The two-script immutable delta preserves the complete baseline runtime. Evidence: `output/door-boundary-delete-20260923/`; tests: `output/door-boundary-delete-tests.log`. Production is unchanged.

All three roles passed exact-release readiness checks. Both public asset hashes match the immutable release; development outbound isolation is enforced. A transient public 503 after restart settled on retry. The editor requires login, so public verification does not constitute an authenticated test of the user's model.
