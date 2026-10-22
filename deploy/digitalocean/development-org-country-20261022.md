# Organization country of record (1M8-228) — development, October 22, 2026

Source `a41a95c3` on branch `claude/lucid-yonath-777e5b`. It is not on the canonical branch yet. This follows the customer
country columns (`development-customer-country-20261021.md`).

Linear description: "track which country an org is from … so we can selectively manipulate feature flags, pricing, etc."

**Stored on every organization.** The global document carries `country: { code, source, updated_at, updated_by }`
(`platform/organization_country.ts`). Sources:
- `signup_choice` / `signup_detected`: set at registration from the same country as the billing profile;
- `operator`: billing profile reassigned on the Prices page (a staff-set record is kept);
- `staff`: edited on the customer detail;
- `orders` / `contact` / `legacy_default`: written by the backfill.

**Backfill.** `backfillOrganizationCountries` (`scripts/backfill-organization-country.ts`) is a dry run unless `--write`,
and never overwrites a stored record. Its order of evidence:
1. the billing profile;
2. the most common order property country (the verified market country, else the formatted address's last part);
3. the company address;
4. US, flagged `legacy_default`.

On dev it wrote all 5,820 organizations: US from orders 2,865, US default 2,918, Canada from orders 14, France from orders 1,
France chosen at signup 2, US detected at signup 20. A second dry run found none left. Production needs the same
backfill run as part of its release (with `--write`, after a dry run).

**Staff edit.** The customer detail has a country picker (`org_set_country`). Report pricing and currency follow the new
country while the organization has no credit history or Stripe charges. After that the billing profile is kept, and the
response says why.

**Conditions.**
- Feature flags: operator country rules (platform configuration `capability_country_rules`, edited as JSON on the
  Feature Flags page) set capability values for organizations in the listed countries. They are applied in
  `capabilityValuesForUser`, cost nothing when there are no rules, are cached for 15 s, and skip saved rules that no
  longer validate.
- Other country-specific behaviour reads `organizationCountryCode(orgId)`.
- Report pricing already selects by the billing profile country (international prices, VAT, expedite clock).

**Tests.** New `tests/organization-country.test.ts` (5) and `customer-country` (3) pass, as do signup-region,
europe-pricing, regional-commerce, internal-api, platform-rollout-audience, firstmeasure-rollout,
customer-dashboard-search and pricing-admin. `capabilities` (1) and `platform-app-flag-defaults` (2) fail identically on
the previous commit. `npm run check` passes.

**Rollout** (`output/org-country-20261021/`). The first attempt (`9ab4a9f5`) stopped at worker staging and activated
nothing: one scripted edit had left a stray CR, so git stored `api.ts` with CRLF and the host's normalised hash check
refused it. Its unused staging directory stays on the worker. The fixed `a41a95c3` was activated on worker, legacy and
web. Pool's first activation hit an SSH banner timeout; the retry activated it. All four roles verify.

**Checked on dev.** A new signup choosing Ireland stored `{code: IE, source: signup_choice}`. The earlier France test
organization reads FR via `organizationCountryCode`. No country rules were saved on dev. Production was not changed.
