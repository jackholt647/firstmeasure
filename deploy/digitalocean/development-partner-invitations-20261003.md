# Named partner invitations — development, October 3, 2026

Feature source: `b63d6446e647ab099856c6d36300ba19c0c68598`.
Public email-origin correction: `01a9c235800aeaafea34c9150a6ab39abc12b625`.

## Behavior

Partners has a visible Invitations tab for outgoing invitation history. Add Partner uses the organization terminology and requires a name and email; the contact/client relationship selector is removed from this workspace. The onboarding endpoint fixes the relationship to partner while existing generic sharing endpoints remain compatible.

A new named invitation retains its recipient-bound link for authorized owner managers. Recoverable tokens are encrypted in invitation records; all collaboration API envelopes omit the encrypted recovery field. Acceptance still requires the invited, verified email and current organization permissions/privacy. Expired, accepted and revoked links cannot be recovered for resending.

The result card has responsive padding, a contained copy-link control, a large SVG QR, recipient details, and activity history. Send invitation email uses existing communications authorization, delivery safety and durable idempotency. Public email links accept only the known environment-specific FirstMate hostname as an override to the configured origin.

History distinguishes captured development email, provider-reported email status, an unverified first link open (which may include automated checks), verified recipient viewing, and acceptance. Public open tracking grants no access and records no visitor identity/IP. Older invitations remain visible, but their hash-only tokens cannot be recovered retroactively.

Only newly created Instant Full Org development sandbox organizations receive Subcontractor/Subcontractors terminology. Other terminology namespaces and existing organizations are preserved.

## Validation

- TypeScript checks passed locally and on staged Linux releases.
- Collaboration API suite: 10 tests passed on SQLite and 10 on isolated PostgreSQL.
- Public-origin correction: focused named-invitation test passed, including captured email content and idempotent replay.
- Five browser checks passed: partner onboarding/layout, assignments, shared content, continuation, and channel sharing.
- Publication regression: 50 passed, one environment-gated PostgreSQL test skipped.
- Hosted fresh sandbox: default terminology, named creation, link recovery, anonymous-open tracking, and desktop/mobile layout verified. Synthetic invitations were revoked and test organizations removed. No external email was sent.

## Rollout and rollback

Development only. No production activation, schema migration, new environment configuration, or topology changes. Owned files were overlaid onto each role's verified immutable live baseline, retaining concurrent changes and all unrelated local staged/unstaged work.

Initial role baseline was `c29425096933b102432e899c8dedf789fa7b0834`; the email-origin release builds on the feature release. Role manifests, hashes, rollback paths, readiness checks, and hosted screenshots are retained in `output/partner-invitations-20261003/` and `output/partner-invitations-origin-20261003/`.

For rollback, use each manifest's exact previous path and the established development activation workflow, restart that role's service, reload PHP only for static changes, and verify development data/cookie isolation and readiness. Preserve invitation records and audit history; do not reset data or overwrite unrelated source. Session-secret rotation preserves already issued links but makes the old encrypted recovery copy unavailable, so issue a new invitation if recovery is needed afterward.
