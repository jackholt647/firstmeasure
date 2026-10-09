# Additional development test phones - October 9, 2026

The approved development voice destinations now include +12068590917 and
+15099600721 alongside +14259700671. Approved numbers are preserved at the
carrier boundary; all other valid PSTN destinations still route to +14259700671.
Dial and transfer share the same policy, including conference participant legs.
Invalid targets and untrusted SIP domains remain blocked; production routing
and SMS policy are unchanged.

The development-only call status reports the configured test phones. Add person
offers a test-phone selector under Phone number, and the tray's test banner
describes the direct-approved/default-fallback behavior.

Local TypeScript check, nine development/provider tests and two browser tests
pass. The conference browser test also passes against the merged live UI.
Tests use mocked provider requests; no calls or messages were sent.

## Deployment

Baseline: c0fa1e6f8020d99d0151df9ee394ef8139880ed8 on all three development roles.
The five changed runtime source files are patched over that baseline, preserving
newer conference/supervision code and compatibility's unrelated manifest values.
Only TELNYX_VOICE_DEVELOPMENT_ALLOWED_NUMBERS changes in server configuration;
existing values are retained and the two user-approved numbers are appended.
The previous configuration is backed up on each server for rollback.

## Activated Release

Release `aa9311887b3111267421c692e984e4c76236188b` was pushed and activated on
development web, pool and compatibility. Linux TypeScript check/build and all
nine development/provider tests passed. The merged UI passed the conference
browser flow, and the mobile test-phone picker screenshot was reviewed.

All three restarted services passed readiness with development outbound safety
enforced. A read-only audit loaded each running process's actual environment and
verified that all three approved numbers are preserved, an unrelated number
maps to +14259700671, Telnyx SIP stays unchanged, and untrusted SIP is rejected.
The audit never contacted the provider. Public readiness reported this release
healthy at 2026-10-09 15:46 UTC.

Only the voice allowlist changed in
`/etc/firstmeasure/development-voice-sandbox.env`. Its original is retained as
`development-voice-sandbox.env.before-aa9311887b3111267421c692e984e4c76236188b`
on each server. Rollback must restore that configuration as well as the prior
release symlink. Production and SMS settings were not changed.

The common source/runtime archive SHA-256 is
`1e186299c9bf16a057a94531227a2e5c96c2cb6c6d9f012bfa0f3926fc0a6bb0`.
Each release has `test-phones-runtime.sha256`; all entries match after
activation. The publicly served calling runtime matches
`ef4dc052310a23f523ee85ed2b6cc35120e08dee70b42f8e07a1ba5f1f57a034`.
The web/pool manifest is
`b1ec7f6781f3d8d6be1780934ddbc4b6fa2c72b8ab944e5ebb9fb70999fbd141`;
compatibility's preserved variant is
`d53711ab4ddced01d983ed1f959144f8bb9e30e9fac2dee7227d337a3472e9d2`.
