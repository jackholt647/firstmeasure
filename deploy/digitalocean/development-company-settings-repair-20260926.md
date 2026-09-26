# Company settings dependency repair — September 26, 2026

Development release: `4950c7556d60cf77a096f9578738683e4f304a1f`.
Both development web nodes serve this release. Production was not changed.

## Fault and repair

The Company settings mount threw `Cannot read properties of undefined (reading
'markup')` at `PlatformBrandKit.markup`. The deployed company settings source
referenced the shared Brand Kit, but its JS/CSS assets and portal registration
were missing. The same incomplete dependency existed in the pre-translation
baseline `07146b6`; the language packs themselves did not cause this exception.

Restored the matching shared assets from `7ef6621`, registered the script before
Company settings in the portal, and declared it before the company bundle in the
embeddable app manifest. No company settings, language preferences or catalog
content were changed. The targeted dependency patch was also applied to the
dirty canonical checkout without staging or replacing unrelated changes.

## Rollout and verification

- Previous primary web release: `9bf675b2b153888ed2a5d929b25b0da0ffdceab6`.
- Previous pool release: `9a0bbd4af1a07f71581f02ae21294e8f61465a01`.
- The two previous source trees were identical; the new commit changes only the
  two restored assets, their two registrations, and one regression test.
- Both Linux release installations passed TypeScript check and build. Release
  roots were made traversable by the static web server before activation.
- Activated sequentially with exact previous-release checks, development-only
  environment checks, outbound-safety verification and rollback protection.
- The new dependency regression passes, including both loading paths, required
  Brand Kit controls, helper methods and CSS URL resolution.
- Authenticated browser verification: Company information, Brand Kit, and all
  17 company language options render. My Settings also renders its interface
  language and message-translation controls. The previous company mount error
  no longer occurs. No settings were saved during verification.
- Eight public readiness requests passed, reaching both development web nodes.
  Public JS, CSS and app-manifest hashes match the committed source.

Evidence: `output/company-settings-repair/` in the attached
`translation-sets-current-dev` checkout, including staged/activated receipts and
`live-verification.json`.

An unrelated existing console error remains: the payments-setup script URL
returns HTML. It was present before this repair and does not prevent the
verified Company or My Settings pages from rendering.

Rollback: restore each node's previous immutable release above through the
guarded development activation workflow, then verify readiness and static
serving. This would also restore the original missing-dependency defect.
