/**
 * 1M8-228: store a country of record on organizations that have none.
 * Dry run by default; pass --write to save. Run with the service's environment:
 *   node --experimental-sqlite --import tsx scripts/backfill-organization-country.ts [--write]
 */
const { backfillOrganizationCountries } = await import("../platform/organization_country.js");
const result = await backfillOrganizationCountries({ write: process.argv.includes("--write") });
console.log(JSON.stringify({ ...result, changed: result.changed.slice(0, 200) }, null, 2));
process.exit(0);
