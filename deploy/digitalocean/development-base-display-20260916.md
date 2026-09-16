# Base appearance and report exclusion — development only

Release `7eb21f3ae0020980c50513d0c662391bfe85d009` follows development release
`13a21682c9ae26a53a7e0f4569a28230ffd5c31a`.

The base previously inherited the global wall finish in textured mode. A default
or unassigned base now uses plain concrete gray (`#b3afa7`) with no texture map.
Explicit base colors/materials remain available. Wall and roof finishes and the
drafting display modes are unchanged.

The exterior PDF omits the base from house diagrams and removes foundation/grade
pages. Base geometry remains in the editor and report calculation model where it
is needed to determine outward wall directions. Wall takeoffs are unchanged.

All 18 focused finish/report tests passed locally and on Linux. Checks cover a
siding default applied to walls while the base stays untextured, explicit base
color, and identical PDF drawing/page commands with or without base geometry.

Only `exterior_finishes.js` and `exterior_pdf.js` changed at runtime. The verified
Linux Node build/dependencies were reused. The guarded helper is
`/home/dev/deploy-base.py` on the worker and `/tmp/deploy-base.py` on web/compatibility,
with expected baseline `13a2168` and the existing development isolation,
allowlist, outbound safety, readiness and rollback checks.

Build: `/home/dev/code/internal-exteriors-build-7eb21f3` on the dev worker.
Artifact: `/home/dev/exteriors-7eb21f3.tar.gz`, 249,925,268 bytes, SHA256
`6275cca1ff0a3fc581c3c292b4259cc7719fa3c921ef885e687f960266723ef2`.

## Deployment verification

All three development roles staged and activated this release, with 1,335
unchanged public source files verified on each host. Activation verified service
readiness, development isolation and the existing exact owner allowlist. PHP FPM
restarted with compatibility. Public readiness reports this release with outbound
safety enforced, and both changed assets served through `dev.1m8.ai` match Git.

No project geometry, access settings or production services were changed.
The prior development release `13a2168` remains installed for guarded rollback.
