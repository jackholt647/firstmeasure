# SMS registration identity and address fields — October 11, 2026

Development-only update. Business type is first; sole proprietors/individuals
enter legal first/last name, while organizations enter their legal company name.
Brand Name / DBA can follow the legal name. The saved choice stays synchronized.
Individuals without an EIN use the existing sole proprietor mobile-verification
and campaign path. Changing business type now immediately rerenders the fields.
Company-only fields retained in a draft are excluded from individual provider payloads.

All 23 Telnyx industry categories are available, with readable labels including
Professional services. EIN input formats as 12-3456789 and flags extra/missing
digits without silently truncating. Existing masked EINs remain intact.
Websites normalize on blur, without the old technical submission hint.
Optional apartment/suite/unit persists separately and joins the street address
for Telnyx's single street field, subject to its 100-character limit.

Validation: TypeScript check, 39 messaging API tests, and four browser tests,
including type switches, name synchronization, formatting, saved units, mobile
layout and automatic status updates. Browser tests also pass against the merged
current development source. The landing-page test now installs its fake clock
before scheduling timers to remove a pre-existing timing failure.

Provider guidance:
https://developers.telnyx.com/api-reference/brands/create-brand
https://support.telnyx.com/en/articles/13545282-guide-to-sole-proprietor-10dlc-brand-and-campaign-registration

Deployment uses per-host guarded overlays of current source, preserving concurrent
Phone Settings/live-registration integrations. Worker receives only the backend
change. No applications, number purchases, or verification texts are sent by tests.

## Development activation verified

Release `cab8e056bad0ad1f18481af9e77375911197eb26` is active on development
web, pool, compatibility, and worker. All HTTP roles pass readiness and the
worker is active. The public settings asset matches the staged SHA-256.
Merged live source passes TypeScript checking and all four browser tests.
No production changes or provider submissions were made.
