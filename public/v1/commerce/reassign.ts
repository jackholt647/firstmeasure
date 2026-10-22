import { readGlobal, saveGlobal } from "../platform/storage.js";
import { badRequest, conflict } from "../platform/errors.js";
import { records } from "../platform-billing/storage.js";
import { commercialPolicy, profileForCountry, profileFromGlobal } from "./profile.js";
import { countryCode } from "./regions.js";
import { countryRecord, storedOrganizationCountry } from "../platform/organization_country.js";

type JsonObject = Record<string, unknown>;
const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const count = (value: unknown) => Array.isArray(value) ? value.length : Object.keys(asObject(value)).length;

/** Platform billing records that mean money has been charged or committed in the current currency. */
const CHARGE_RECORD_KINDS = ["purchase", "invoice", "stripe-invoice", "subscription", "adjustment"];

/**
 * Why an organization's commercial profile can no longer be reassigned, or "" when it can.
 * The credits ledger stores amounts without a currency, so any ledger entry, balance or
 * Stripe charge fixes the profile for good.
 */
export async function commercialProfileLock(orgId: string) {
  const data = asObject((await readGlobal(orgId)).data);
  if (count(data.credits_ledger) || Number(data.credits_balance || 0) !== 0) return "credits_ledger";
  if (count(data.stripe_fulfilled_sessions) || count(asObject(data.billing).events)) return "stripe_charges";
  for (const kind of CHARGE_RECORD_KINDS) if ((await records(orgId, kind)).length) return "stripe_charges";
  return "";
}

/** Operator-only: assign the commercial profile a signup in `country` would have received. */
export async function reassignCommercialProfile(orgId: string, country: unknown, operatorEmail: string) {
  const code = countryCode(country);
  if (!code) throw badRequest("invalid_country", "Choose a valid country.");
  const lock = await commercialProfileLock(orgId);
  if (lock) {
    throw conflict("commercial_profile_in_use", lock === "credits_ledger"
      ? "This organization has credit history. Its billing profile can no longer be reassigned."
      : "This organization has Stripe charges. Its billing profile can no longer be reassigned.", { reason: lock });
  }
  const global = await readGlobal(orgId), data = asObject(global.data);
  const previous = profileFromGlobal(data), policy = await commercialPolicy();
  const profile = profileForCountry(code, "operator_reassigned", policy.config, policy.revision);
  // The country of record follows unless staff set it directly (an explicit staff record is kept).
  const countryOfRecord = storedOrganizationCountry(data)?.source === "staff" ? null : countryRecord(code, "operator", operatorEmail);
  const appFlags = asObject(data.app_flags), firstmeasure = asObject(appFlags.firstmeasure);
  const nextFlags = {
    ...appFlags,
    firstmeasure: {
      ...firstmeasure,
      // A non-US account always offers report language and units; existing choices are kept.
      ...(code !== "US" ? { report_localization: true } : {}),
      metric_measurements: profile.measurement_system === "metric"
    }
  };
  await saveGlobal(orgId, {
    expected_revision: global.revision,
    data: { commercial_profile: profile, app_flags: nextFlags, ...(countryOfRecord ? { country: countryOfRecord } : {}) },
    metadata: { commercial_profile_reassigned_by: operatorEmail, commercial_profile_reassigned_at: new Date().toISOString(), previous_commercial_profile: previous }
  });
  return { previous, profile };
}
