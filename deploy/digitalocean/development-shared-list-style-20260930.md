# Compact shared-resource panels — development

Release: `f18a958008fd0d425640402f6c289ec345fdde52`.
Target: https://dev.1m8.ai, following screenshots of Contacts and Channels.

Both screens were mounting the same shared-resource widget open by default.
It inherited oversized body text, used browser-default select controls, and
pushed the app workspace below a large empty sharing panel. This was separate
from the previously corrected shared-header selector collision.

The widget now has scoped 13px typography, styled selects/buttons, compact
spacing, responsive wrapping and a bounded nonshrinking host. It starts
collapsed; opening it exposes the existing direction/organization filters and
resource links. Projects reuse the same correction. Sharing APIs, permissions
and navigation remain unchanged.

A browser check covers Contacts and Channels at desktop and mobile widths,
collapsed height, available workspace height, control styling, overflow,
filter requests and opening a shared contact. API responses are mocked.
Deployment changes only the shared-list component and its loader cache version,
with role-specific existing manifests preserved. Immutable hardlink staging
uses atomic replacements and verifies that the active source is unchanged.
No database, provider, worker, production or topology changes.

Per-role predecessor: `ba65a2f75fe938599c3f44d3acb48de92518cdab`.
Evidence: ignored `output/shared-list-style-20260930/` and the deployed
`channels-release.json`. Before rollback, check for subsequent releases; restore
the recorded prior symlink and restart only that development service and
PHP-FPM. Verify development identity, readiness and enforced outbound safety.

Completed: all three serving hosts verified f18a9580 and development readiness/outbound safety. Public component and manifest hashes matched on three fetches each. The desktop/mobile Contacts and Channels regression passed again using the downloaded served component. Reload the portal to apply the compact panels.
