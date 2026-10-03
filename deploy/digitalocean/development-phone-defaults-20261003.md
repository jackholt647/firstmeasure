# Instant development organization phone defaults — October 3, 2026

Source release: `11fe8fc5bc9596dd745c684b252cac7678e65565`. Development only.

Instant full org (dev) creation now invokes the existing development phone
onboarding after creating the owner session. When the verified shared transport
is available, the organization starts with voice enabled, the header Phone button,
and organization-scoped mock brand/campaign approval. Other signup workflows keep
their onboarding steps. Missing or ambiguous transport leaves setup pending;
unexpected errors still propagate. Existing organizations can use Development
tools → Skip to fully onboarded.

The shortcut does not buy numbers, submit carrier registrations, or alter provider
ownership. Production defaults remain unchanged. The user explicitly chose to
retain SMS capture mode: SMS is recorded locally with simulated delivery, not sent
to a handset. Development PSTN calls remain redirected to the designated recipient
and require that number in the server allowlist.

Validation: eight focused signup, phone-development and environment-safety tests
passed. The updated signup test and three provider tests passed afterward. The new
test covers ready transport, missing transport, mock approval, unique provider
ownership and production isolation. Workspace TypeScript validation encountered
unrelated concurrent `appointments/planning.ts` errors; deployment checks validate
the isolated backend on each role. No calls or SMS were sent during verification.

Release packages preserve each role's current source and only overlay the signup
service and compiled JavaScript. Concurrent Activity deployment was detected by
the baseline guard and re-audited before proceeding. Evidence and per-role rollback
paths are in ignored `output/phone-defaults-final-20261003/manifest.json`;
hosted verification evidence is in `output/phone-defaults-20261003/`.

All four development roles passed Linux TypeScript, compiled-source parity,
activation, readiness and outbound-isolation checks. A fresh hosted Instant Full
Org (`org_eea512c0823fc6e9`, instance `sbi_06852bc5c9c290ec`) returned enabled voice,
completed mock onboarding and mock-approved campaign status. The browser verified
the visible header Phone button; its screenshot was inspected. Live configuration
confirmed one verified transport, the designated-only voice allowlist and SMS
capture mode. Production was not changed.

Rollback: restore the manifest's `previous_path` and restart the corresponding
development service. Web, compatibility and pool were based on `ed1ab8d3`; worker
was based on `96267164`. Existing mock-onboarded test organizations keep their
stored settings after code rollback.
