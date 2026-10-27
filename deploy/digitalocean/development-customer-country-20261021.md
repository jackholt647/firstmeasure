# Customer country tracking (1M8-228) — development, October 21, 2026

Source `39e25f28` on branch `claude/lucid-yonath-777e5b`. It is not on the canonical branch yet. The Linear issue has no
description beyond its title.

**Internal portal.**
- The customer list has a Country column (code and name; the tooltip shows the source and currency). It can be filtered:
  an exact two-letter code matches that country, otherwise part of a name matches. It can also be sorted.
- Balances on the list and in the detail view show in the organization's currency instead of always `$`.
- The customer detail shows the country, where it came from and the currency. Its orders tab has a Property country
  column.
- Queue cards tag orders for properties outside the US and Canada with the property's country, with the billed currency
  in the tooltip.

**One source of truth.** `organizationCountry` in `internal/api.ts` reads the commercial profile: the country chosen or
detected at signup, or reassigned by an operator. Accounts from before commercial profiles fall back to their orders'
verified `report_property_country`, then the company contact's address country, then the legacy US default. Orders use
the manifest's `report_property_country` and `report_currency`. Nothing new is stored.

**Tests.** New `tests/customer-country.test.ts` (3) passes, along with customer-dashboard-search and internal-api (12).
`npm run check` passes.

**Rollout** (`output/customer-country-20261021/`). The release was three-way merged onto the live releases `f759aa31` (legacy,
web, pool) and `78a839d1` (worker), with no conflicts. All four roles were activated and verified.

**Checked on dev.** The served `customers.js` and `projects.js` contain the change. Running the deployed
`organizationCountry` on the web host (read-only, `output/customer-country-20261021/remote.py`) returned `FR / France /
signup_choice / EUR` for the France test organization, and the country filter matched `fr` but not `us`. The Europe
signup and pricing changes are still live (€25 / €40 per multifamily structure, VAT included). The staff console needs a
staff login, so the page itself was not viewed. Production was not changed.
