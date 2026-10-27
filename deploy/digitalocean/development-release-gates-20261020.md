# Development rollout: production release gates — October 20, 2026

These changes keep the October 20 production release limited to what existing
FirstMeasure customers already use. Only the change from `b9e0ddc7` to `067deb12`
was merged onto each dev role's live files. Everything else on dev stayed as it was.

## What changed

- **Roof 3D viewer.** The Reports tab's Model & photos viewer is shown only for
  Full House reports, or for roof reports in an organization that turns on
  `firstmeasure.roof_model_viewer`. That setting is off by default, and internal
  admins can set it in the flag editor (`measure/internal/index.php`). Until it is
  on, roof customers land on the Standard PDF tab, as before. The measurements
  bundle cache key is `20261020-model-viewer-gate-v1`.
- **Signup sandbox.** `fm_signup_sandbox_available()`
  (`portal/signup-sandbox/available.php`) allows only local hosts and
  `dev.1m8.ai`. Every other host, production included, gets:
  - a 404 for `/portal/signup-sandbox/`;
  - no dev bar script on the portal, login and landing pages.
  The `/v1/signup-sandbox` API already answered 404 in production.
- **Smoke checks.** `test:smoke` no longer syntax-checks two files the forms
  rebuild deleted.
- **Optimization backlog.** The full-house JSON filter in the drafting queue is
  now an entry in `docs/optimization-backlog.md`.

## Verification

- The TypeScript check passes. All 18 smoke syntax checks pass, and PHP lint
  passes on the changed files.
- The host check allows localhost, `127.0.0.1`, `*.localhost` and `dev.1m8.ai`.
  It refuses `app.1m8.ai`.
- `capabilities.test.ts` has one failure ("registry is structurally valid"). It
  fails the same way without this change.
- All four roles (worker, compatibility, web, pool) were staged, activated and
  verified on `067deb12`. The worker received only `capability_defs.ts`.
- On dev, the sandbox page and dev bar still load, because dev is an allowed host.

## Rollback

Previous releases:

- worker: `42ca4abc`
- compatibility, web and pool: `7c49b06e`

Tooling is in the ignored `output/release-gates-20261020/` directory.
