import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { customerDashboardRowMatches, organizationCountry, sortCustomerDashboardRows } from "../internal/api.js";
import { profileForCountry } from "../commerce/profile.js";

// 1M8-228: staff see each customer's country (from the commercial profile chosen at signup) and order countries.
test("a customer's country comes from its commercial profile, else its orders or address", () => {
  const chosen = { ...profileForCountry("FR", "signup_choice") };
  assert.deepEqual(organizationCountry({ commercial_profile: chosen }), { country: "FR", country_name: "France", country_source: "signup_choice", currency: "EUR" });
  assert.equal(organizationCountry({ commercial_profile: profileForCountry("DE", "browser_time_zone") }).country_source, "signup_detected");
  assert.equal(organizationCountry({ commercial_profile: profileForCountry("IE", "operator_reassigned") }).country_source, "operator");
  // The profile wins over order properties: a US account ordering in France is still a US customer.
  assert.equal(organizationCountry({ commercial_profile: profileForCountry("US", "signup_choice") }, [{ manifest: { report_property_country: "FR" } }]).country, "US");

  // Accounts from before commercial profiles: the most common verified order country, then the contact address.
  const orders = [{ property_country: "GB" }, { manifest: { report_property_country: "GB" } }, { report_property_country: "us" }];
  assert.deepEqual(organizationCountry({}, orders), { country: "GB", country_name: "United Kingdom", country_source: "orders", currency: "USD" });
  assert.equal(organizationCountry({ contact: { address: { country: "ES" } } }).country, "ES");
  assert.deepEqual(organizationCountry({}), { country: "US", country_name: "United States", country_source: "legacy_default", currency: "USD" });
});

test("staff filter and sort customers by country", () => {
  const rows = [
    { id: "a", name: "Atlas Roofing", country: "US", country_name: "United States" },
    { id: "b", name: "Bordeaux Toitures", country: "FR", country_name: "France" },
    { id: "c", name: "Cork Roofing", country: "IE", country_name: "Ireland" },
    { id: "d", name: "Dublin Slate", country: "IE", country_name: "Ireland" }
  ];
  const match = (needle: string) => rows.filter((row) => customerDashboardRowMatches(row, { country: needle }, "")).map((row) => row.id);
  assert.deepEqual(match("fr"), ["b"], "a two-letter code matches exactly");
  assert.deepEqual(match("IE"), ["c", "d"]);
  assert.deepEqual(match("irel"), ["c", "d"], "names match by substring");
  assert.deepEqual(match("united"), ["a"]);
  assert.deepEqual(sortCustomerDashboardRows(rows, "country", "asc").map((row) => row.id), ["b", "c", "d", "a"]);
  assert.deepEqual(sortCustomerDashboardRows(rows, "country", "desc").map((row) => row.id), ["a", "d", "c", "b"]);
});

test("the internal customer list, detail and queue show countries", async () => {
  const customers = await readFile(new URL("../../measure/internal/portal_scripts/customers.js", import.meta.url), "utf8");
  assert.match(customers, /<th data-col="country">Country/);
  assert.match(customers, /<input type="text" data-col="country"/);
  assert.match(customers, /id="detailOrgCountry"/);
  assert.match(customers, /<th>Property country<\/th>/);
  assert.equal((customers.match(/<th data-col=/g) || []).length, (customers.match(/<th><div class="cust-filter-wrap">/g) || []).length, "every column has a filter cell");
  const projects = await readFile(new URL("../../measure/internal/portal_scripts/projects.js", import.meta.url), "utf8");
  const start = projects.indexOf("    propertyCountryTag(p){"), end = projects.indexOf("    complexityBadgeHtml(", start);
  const tag = new Function("Portal", `return ({${projects.slice(start, end)}});`)({ escapeHtml: (value: string) => value }).propertyCountryTag;
  assert.match(tag({ report_property_country: "fr", report_currency: "EUR" }), />FR</);
  assert.equal(tag({ report_property_country: "US" }), "");
  assert.equal(tag({}), "");
});
