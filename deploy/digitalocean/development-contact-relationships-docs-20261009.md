# Linked contacts and contact Docs — October 9, 2026

The My Contacts follow-up is active at `https://dev.1m8.ai`. Production was not changed. Source commit `e27292caa896cb3493df7e867609ea1ddcb12cad` was pushed to `codex/consolidated-firstmeasure-20260923`.

Adding a spouse or employer now collects the related contact's name, primary and secondary phones and labels, email, address, notes, and (when enabled) time zone. It saves a separate `contact_only` record and links its contact reference to the current contact. The relationship card loads and shows that saved contact's phone, email, and address, opens its full profile, and offers a return to the original contact. Existing-contact selections use the same profile card. The contact window also has a Docs tab for viewing and uploading contact-owned documents; visual media remains in Photos & Media.

## Verification

- TypeScript check, JavaScript syntax checks, the contact browser fixture, and 11 window shell and manager browser checks passed locally.
- The browser fixture also passed using JavaScript fetched from the public dev site. It covers validation, separate contact creation, full details, employer and spouse profile navigation, return navigation, document upload and listing, and the existing phone and media flows.
- The public dev app manifest references `20261009-contact-window-v3`. The served contact modal SHA-256 is `afe95739b4a05f01c312d192b9e96c8f3d6fa9863f4dfc2ca5f3dcf8813ffce4`.
- Main, pool, and compatibility roles each returned `ok=true`, `data_environment=development`, and enforced outbound isolation after activation. Public readiness also passed.

## Release and rollback

Only the contact modal and three contact bundle references were overlaid on the verified current release of each development web role. Main and pool use `/opt/firstmeasure/releases/e27292caa896cb3493df7e867609ea1ddcb12cad-2e929f3b`, over `2959d8af3c25af6352b632c8f5c6f0db5bf0c982`. Compatibility uses `/opt/firstmeasure/releases-phone-group-ui/e27292caa896cb3493df7e867609ea1ddcb12cad-71bc1f20`, over `a06ad83b-user-summary-hover`. The background worker was not changed; it does not serve the contact UI or contact media API.

Each release contains `.contact-docs-manifest.json` with its exact previous path, previous release ID, and staged file checksums. Before rollback, verify `current` still points to the recorded contact release. Switch to the manifest's `previous_path`, restart the role's development service and `php8.3-fpm`, then verify local and public readiness and development isolation. Preserve all release directories and any later deployment.
