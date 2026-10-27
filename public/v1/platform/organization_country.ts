import { mutateGlobal, readGlobal, type JsonObject } from "./storage.js";
import { profileFromGlobal } from "../commerce/profile.js";
import { countryCode } from "../commerce/regions.js";
import CALLING_CODES from "../commerce/calling-codes.json" with { type: "json" };

/**
 * An organization's country of record (1M8-228), stored on the global document as
 * `country: { code, source, updated_at, updated_by }`. It is set at signup from the same country as the
 * commercial profile, backfilled for older organizations (scripts/backfill-organization-country.ts) and
 * edited by staff in the internal portal. Feature-flag country rules (capabilities.ts) and future
 * country-specific behaviour read it through `organizationCountryCode`. Report pricing and currency
 * follow the commercial profile, which staff edits keep in step while the organization has no credit
 * history or Stripe charges (commerce/reassign.ts).
 */
export type CountrySource = "signup_choice" | "signup_detected" | "operator" | "staff" | "orders" | "contact" | "legacy_default";
export type CountryRecord = { code: string; source: CountrySource; updated_at: string; updated_by?: string };

const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const SOURCES = new Set<CountrySource>(["signup_choice", "signup_detected", "operator", "staff", "orders", "contact", "legacy_default"]);

export function countryRecord(code: unknown, source: CountrySource, updatedBy?: string): CountryRecord | null {
  const valid = countryCode(code);
  return valid ? { code: valid, source, updated_at: new Date().toISOString(), ...(updatedBy ? { updated_by: updatedBy } : {}) } : null;
}

/** The stored country record, when present and valid. */
export function storedOrganizationCountry(globalData: JsonObject): CountryRecord | null {
  const record = asObject(globalData.country), code = countryCode(record.code);
  if (!code) return null;
  return { code, source: SOURCES.has(record.source as CountrySource) ? record.source as CountrySource : "staff", updated_at: String(record.updated_at || ""), ...(record.updated_by ? { updated_by: String(record.updated_by) } : {}) };
}

/** How a commercial profile's country was set, in country-record terms. */
export function profileCountrySource(source: string): CountrySource {
  return source === "signup_choice" ? "signup_choice" : source.startsWith("operator") ? "operator" : "signup_detected";
}

const REGION_NAMES = (() => {
  const names = new Map<string, string>([["usa", "US"], ["united states of america", "US"], ["uk", "GB"]]);
  try {
    const display = new Intl.DisplayNames(["en"], { type: "region" });
    // Current countries only: retired codes (DD, FX, SU) display as today's names.
    for (const code of Object.keys(CALLING_CODES)) {
      const name = countryCode(code) ? display.of(code) : "";
      // First code wins: FR before the deprecated FX ("Metropolitan France" also reads "France").
      if (name && name !== code && !names.has(name.toLowerCase())) names.set(name.toLowerCase(), code);
    }
  } catch { /* Intl without region names: only the aliases above. */ }
  return names;
})();

/** The country named at the end of a formatted address ("…, Paris, France" or "…, CA 90210, USA"). */
export function addressCountry(address: unknown) {
  const text = typeof address === "string" ? address : String(asObject(address).formatted || asObject(address).formatted_address || "");
  const last = text.split(",").map(part => part.trim()).filter(Boolean).at(-1)?.toLowerCase() || "";
  return REGION_NAMES.get(last) || "";
}

/** The country an order's property is in: the verified market country, else its formatted address. */
export function orderPropertyCountry(order: JsonObject) {
  const manifest = asObject(order.manifest);
  return countryCode(order.property_country ?? order.report_property_country ?? manifest.report_property_country)
    || addressCountry(order.address ?? order.property_address ?? manifest.address);
}

/**
 * An organization's country: the stored record, else the commercial profile (orgs created since profiles
 * exist), else evidence from its orders' properties or company address, else the US default for
 * pre-launch accounts with no evidence (legacy_default, flagged for staff review).
 */
export function organizationCountry(globalData: JsonObject, orders: JsonObject[] = []) {
  const name = (code: string) => { try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) || code; } catch { return code; } };
  const currency = profileFromGlobal(globalData).currency;
  const result = (country: string, source: CountrySource) => ({ country, country_name: country ? name(country) : "", country_source: source, currency });
  const stored = storedOrganizationCountry(globalData);
  if (stored) return result(stored.code, stored.source);
  return result(...derivedOrganizationCountry(globalData, orders));
}

/** The country derivable without a stored record (used by organizationCountry and the backfill). */
export function derivedOrganizationCountry(globalData: JsonObject, orders: JsonObject[] = []): [string, CountrySource] {
  if (globalData.commercial_profile !== undefined) {
    const profile = profileFromGlobal(globalData), code = countryCode(profile.country);
    if (code) return [code, profileCountrySource(profile.source)];
  }
  const counts = new Map<string, number>();
  for (const order of orders) { const code = orderPropertyCountry(order); if (code) counts.set(code, (counts.get(code) || 0) + 1); }
  const fromOrders = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (fromOrders) return [fromOrders, "orders"];
  const contact = asObject(globalData.contact), address = contact.address;
  const fromContact = countryCode(contact.country ?? asObject(address).country ?? asObject(address).country_code) || addressCountry(address);
  if (fromContact) return [fromContact, "contact"];
  return ["US", "legacy_default"];
}

/** The two-letter country code used for country-targeted behaviour. */
export async function organizationCountryCode(orgId: string) {
  return organizationCountry(asObject((await readGlobal(orgId)).data)).country;
}

/** Store a country record; returns the saved record. */
export async function saveOrganizationCountry(orgId: string, record: CountryRecord) {
  await mutateGlobal(orgId, () => ({ data: { country: record } }));
  return record;
}

/**
 * Store a derived country record on every organization that has none (dry run unless `write`). Each org's
 * orders come from the FirstMeasure project index. Returns counts by source and the organizations changed.
 */
export async function backfillOrganizationCountries(options: { write?: boolean; orgIds?: string[] } = {}) {
  const { listOrganizations } = await import("./storage.js");
  const { queryIndexedProjectManifests } = await import("../firstmeasure/project_index.js");
  const organizations = options.orgIds ? options.orgIds.map(id => ({ id })) : await listOrganizations();
  const bySource: Record<string, number> = {}, changed: Array<{ org_id: string; code: string; source: CountrySource }> = [];
  let skipped = 0;
  for (const org of organizations) {
    const orgId = String((org as JsonObject).id || "");
    if (!orgId) continue;
    const data = asObject((await readGlobal(orgId).catch(() => null))?.data);
    if (storedOrganizationCountry(data)) { skipped++; continue; }
    const orders = await queryIndexedProjectManifests({ organization_id: orgId, limit: 2000, includeInstantOnly: true })
      .then(result => result.projects as unknown as JsonObject[]).catch(() => []);
    const [code, source] = derivedOrganizationCountry(data, orders);
    bySource[source] = (bySource[source] || 0) + 1;
    changed.push({ org_id: orgId, code, source });
    // Never overwrite a record written meanwhile (signup or a staff edit).
    if (options.write) await mutateGlobal(orgId, current => storedOrganizationCountry(asObject(current.data)) ? {} : { data: { country: { code, source, updated_at: new Date().toISOString(), updated_by: "backfill" } } });
  }
  return { write: !!options.write, organizations: organizations.length, already_set: skipped, by_source: bySource, changed };
}
