# Shared terminology and settings — development, September 26, 2026

Source commits `a49ff93` and `bffa6ef` are pushed on `codex/terminology-dev-20260926`.
The release is active on dev.1m8.ai. Production is unchanged.

## Behavior

384 shared terminology keys, locale-specific names, inherited phrases, legacy
work/workforce mapping compatibility, protected user-authored content, public portal
projection, and frozen document/report terminology use the shared language engine.
The Configuration editor adds search, ordering, section tooltips, inherited-default
resets, and a focused FirstMate conversation that produces drafts without saving.
The desktop assistant remains alongside the list at the actual settings width;
small screens use the list/assistant switch.

All 17 installed web language packs were preserved. The background and compatibility
language runtime now has those same installed packs. Newly catalogued strings fall
back to English where translations are absent. The protected internal measurement
editor is outside this source migration.

## Active releases

| Role | Release |
|---|---|
| web | `7cd30733636f08b33188a300da29e79265893308` |
| pool | `d273a4d8e413a50cea272b24429421f8fc1ae9c4` |
| worker | `adb3aa510384b02362448a8d5c3707d71431231a` |
| legacy | `ab389b7f53cff5329c157a4a15de9d947fd04ef7` |

The initial web terminology releases were `548ea6f` and `8e67443`. The final web
releases above add only the desktop layout breakpoint correction. Worker and
compatibility retain their verified terminology releases.

## Verification and preservation

- Isolated release reconciliation retained current notification, language, brand-kit,
  billing and other deployed changes; the dirty canonical workspace was not bulk staged.
- All four role sources passed TypeScript check and build on Linux using the installed
  runtime dependencies and an isolated compiler/type package. Installed dependencies,
  service configuration and provider credentials were not changed.
- 16 terminology checks and 38 API checks passed. The release baseline publication
  suite passed 47 tests with one PostgreSQL test skipped. Catalog migration/checks passed.
- Each stage/activation verified predecessor identity, affected file hashes, development
  environment and enforced outbound restrictions, with guarded rollback. Worker activation
  waited for no running jobs. Both web nodes were activated sequentially.
- All four roles passed final readiness and terminology composition checks. Public asset
  hashes and all 92 catalog files were verified.
- Authenticated live testing verified 17 language choices, search, draft/discard,
  mobile assistant access, and a real FirstMate draft response. Stored terminology was
  identical before and after. The temporary session was revoked.
- The actual Configuration layout was checked with browser-only visibility overrides
  for `platform.configuration` and `platform.terminology_settings`, which remain disabled
  on the test account. No stored capability flags were changed.
- A pre-existing `/libraries/payments-setup/payments-setup.js` HTML response still produces
  `Unexpected token '<'`. It is documented in the earlier company-settings repair and
  is unrelated to this release. Terminology interactions passed despite that existing error.

No database migration, customer naming change, production activation, native release,
or autoscale topology/template change was performed. The previously documented
replacement-image provisioning limitation remains.

## Evidence and rollback

Local receipts, hashes, Linux build output and browser screenshots are under
`output/terminology-deploy/`; the final UI-only web delta is under
`output/terminology-layout/`. These directories are ignored and can contain private
verification-session material; publish only the non-secret reports/screenshots.

Rollback through the guarded development activation workflow to the per-role predecessor
recorded in each manifest, checking any subsequent deployment before switching. The web
layout predecessor already contains the full terminology implementation. No data rollback
is required because this release does not migrate or save terminology settings.
