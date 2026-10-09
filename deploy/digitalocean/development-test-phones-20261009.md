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

Release and final verification are recorded after activation below.
