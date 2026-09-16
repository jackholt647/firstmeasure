# Exterior editor update — development only

User authorized deployment of the local editor changes to `dev.1m8.ai`.
Runtime release: `24cdfbafda2e7b9f0433ed4964476d36625136ec`, pushed to
`codex/internal-exteriors`. Previous runtime on all three development roles:
`6eed8c8a0b0f2d02673176a0dda205d2bfc6a685`.

## Scope and artifact

Includes the accumulated exterior geometry, plane mode, sticker placement,
selection history, toolbar, Resources, overlay, and performance changes.
See `dev/EXTERIOR_PERFORMANCE.md` for measured CPU improvements and remaining
performance limits. This rollout does not establish browser FPS on large models.

Nineteen runtime source files changed, all beneath `public/measure/internal/`.
Node source and dependency manifests match the previous runtime. TypeScript was
rebuilt on Linux using the existing Linux dependency installation.

- Build checkout: `/home/dev/code/internal-exteriors-build-20260916` on the dev worker.
- Artifact: `/home/dev/exteriors-24cdfba.tar.gz`; manifest: `.tar.json`.
- Size: 249,915,921 bytes.
- SHA256: `f748e0c906a2158af3b6de01c522bc53bd28e08488df39fd09c76b12ef32bc75`.
- Artifact packaging retains the existing generic production/web manifest fields;
  deployment was explicitly guarded to development services and environment.

## Activation and safeguards

| Role | Verified host | Service |
| --- | --- | --- |
| Web | `143.198.68.11` | `firstmeasure-development-web.service` |
| Worker | `137.184.44.82` | `firstmeasure-development-worker.service` |
| Compatibility/PHP | `137.184.229.145` | `firstmeasure-development-legacy.service` |

All three staged the same checksum-verified artifact before activation. Each
stage compared 1,317 unchanged public source files to its live baseline. The
development deployment helper was copied to `deploy-dev-exteriors-20260916.py`
with the expected baseline updated to `6eed8c8`; all development, allowlist,
readiness, outbound-safety, and rollback guards were retained. Copies and the
delta allowlist remain in `/home/dev` on the worker and `/tmp` on the other roles.

Activation order: worker, web, compatibility/PHP. The worker had zero running
jobs before restart. PHP FPM was restarted with the compatibility role.
Fresh verification confirmed the exact new release in the service environments,
development data isolation, healthy readiness, and enforced outbound safety.

All three retain `FIRSTMEASURE_FULL_HOUSE_ENABLED=1` and the exact allowlist
`FIRSTMEASURE_FULL_HOUSE_EMAILS=jack@1m8.ai`. Browser provider-key configuration
and the separate PHP full-house signing override were preserved. No production
host, release pointer, replacement channel, environment configuration, or project
geometry was changed. The local sandbox project was not copied to development.

## Validation

- Windows: all 774 editor tests passed, including browser tests.
- Linux: 768 editor tests passed; six browser tests could not launch because
  Chromium is absent on the host. Those six passed on Windows.
- Linux TypeScript build passed; all 84 PHP files linted successfully.
- Three full-house PHP/address/access tests passed, including feature gating.
- All three live service checks passed after activation. Public readiness
  returned the new release and enforced development outbound safety after the
  expected restart/reentry interval.
- All 18 changed JavaScript/CSS assets served through `dev.1m8.ai` matched the
  committed source after line-ending normalization.
- Unauthenticated full-house entry returns 404. Unauthenticated editor access
  redirects to `backend_login.php` (302); the subsequent login page returns 200.
- Signed-in browser loaded the existing synthetic private draft and verified the
  revised wall toolbar, Solar/G/B/A controls, sticker library, Resources categories,
  and enabled roof trimming/selection undo settings. No geometry was edited.

The synthetic draft has no measured walls and uses a checkerboard at the origin;
it does not verify imagery acquisition or a complete measurement/PDF workflow.
Its legacy short-name Tech fixtures display blank labels (the filename fallback
is unchanged from the previous release). Browser diagnostics also reported an
unavailable Google Geocoding API and two keydown errors in unchanged
`interaction_2d.js` where an event lacked `key`; these were not addressed by this
deployment. Do not describe this smoke check as an error-free full workflow.

## Access and rollback

Open `https://dev.1m8.ai/measure/internal/full_house.php` with the allowlisted
account and choose an existing development measurement. Reload an already-open
editor to load the new versioned assets.

The prior release remains installed on all three roles. If rollback is needed,
verify the active release/environment, wait for zero running worker jobs, then
atomically restore all three development release pointers to `6eed8c8` and
restart their corresponding services (plus PHP FPM on compatibility). Repeat
readiness, release, access, and outbound-safety checks. Preserve privacy filters,
allowlist, signing overrides, and development isolation. No rollback or promotion
to production is authorized by this record.
