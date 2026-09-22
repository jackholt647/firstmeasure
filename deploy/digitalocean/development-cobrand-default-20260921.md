# Development co-branding default — September 21, 2026

Runtime `9ee0e68ba5c8671468d121629ac97be00e7336c6`; previous runtime and rollback
target `2325b63c541aec4eb785a8998f2d11a752755d47`.

`platform.cobrand_sidebar_logo` belongs to the standard FirstMeasure capability
set. Its existing true registry default now takes effect without requiring
`platform.expanded_access`. The sidebar shows the FirstMate logo in the company's
primary color beside its company logo. Explicit per-organization false values
remain opt-outs; no bulk organization settings were changed. Signup defaults
remain true. Other expanded apps retain their rollout gate.

The main older local checkout's backend/default map and settings fallback were
also changed from false to true. The integration preview was restarted and
Flow Roofing (Local review) was visually verified with both logos and the
company's primary color. Its saved metric/language preferences were preserved.

Validation: TypeScript build and three targeted default/rollout tests passed.
The compiled JavaScript was compared with the deployed baseline and differs
only by the additional standard capability. Each development role was staged
with checksums for the two source/test files and compiled module; all remaining
public files were verified unchanged. Staging verified co-branding true with
expanded access false using the compiled runtime.

Activated on development worker 137.184.44.82, web 143.198.68.11 and compatibility
137.184.229.145 using their existing firstmeasure-development services. Readiness
and development outbound isolation were checked on activation. Production and
runtime configuration were unchanged. The earlier complete local release and
its other application changes are retained.

Rollback: restore the previous current symlink on all three development hosts
and restart their respective services (also PHP-FPM on compatibility), waiting
for worker jobs to be idle first. No database rollback is necessary.
