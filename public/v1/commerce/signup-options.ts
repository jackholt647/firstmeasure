// International calling codes by country, generated from libphonenumber-js metadata (not a runtime dependency).
import CALLING_CODES from "./calling-codes.json" with { type: "json" };
import { LANGUAGE_PACKS, SUPPORTED_LOCALES } from "../platform/localization/languages.js";
import { countryCode, detectSignupCountry, DOMESTIC_COUNTRIES, regionLanguage } from "./regions.js";
import type { CommercialProfile } from "./profile.js";

/** International calling code for a country, without the plus sign; "" when unknown. */
export function callingCode(country: unknown) {
  const code = countryCode(country);
  return code ? (CALLING_CODES as Record<string, string>)[code] || "" : "";
}

/**
 * The phone a signup form sent, as E.164 when a calling code is known. A national number
 * typed after a chosen calling code drops its trunk prefix 0 (020 7946 0000 -> +44 20 7946 0000).
 * Numbers that already start with + are left alone.
 */
export function signupE164(value: unknown, code: unknown) {
  const raw = String(value ?? "").trim(), dial = String(code ?? "").replace(/\D/g, "");
  if (!raw || raw.startsWith("+") || !dial) return raw;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("00" + dial)) digits = digits.slice(2 + dial.length);
  else if (dial === "1" && digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits ? `+${dial}${digits.replace(/^0+/, "")}` : "";
}

/** The phone to validate for a signup: the chosen phone country, else the chosen account country. */
export function signupPhoneInput(body: Record<string, unknown>) {
  return signupE164(body.phone, callingCode(body.phone_country || body.signup_country));
}

/** The company language chosen at signup, or the commercial profile's regional language. */
export function signupLanguage(body: Record<string, unknown>, profile: CommercialProfile) {
  const chosen = String(body.signup_language ?? "");
  return (SUPPORTED_LOCALES as readonly string[]).includes(chosen) ? chosen : profile.locale;
}

function regionNames(locale: string) {
  try { return new Intl.DisplayNames([locale, "en"], { type: "region", fallback: "none" }); }
  catch { return new Intl.DisplayNames(["en"], { type: "region", fallback: "none" }); }
}

/**
 * Everything a signup form needs to offer country, phone calling code and language choices,
 * prefilled from the same detection registration uses when nothing is chosen.
 */
export function signupOptions(headers: Record<string, unknown>, query: Record<string, unknown> = {}) {
  const hints = { signup_time_zone: query.time_zone, signup_locale: query.locale };
  const detected = detectSignupCountry(headers, hints);
  const display = String(query.locale || "en-US");
  const names = regionNames(display);
  const countries = Object.keys(CALLING_CODES).map(code => {
    const valid = countryCode(code), name = valid ? names.of(valid) : "";
    return valid && name ? { code: valid, name, calling_code: callingCode(valid), language: regionLanguage(valid) } : null;
  }).filter(Boolean) as { code: string; name: string; calling_code: string; language: string }[];
  countries.sort((a, b) => a.name.localeCompare(b.name, display));
  return {
    ok: true,
    country: detected.country,
    source: detected.source,
    language: detected.country ? regionLanguage(detected.country) : "en-US",
    domestic_countries: [...DOMESTIC_COUNTRIES],
    countries,
    languages: LANGUAGE_PACKS.map(pack => ({ code: pack.code, label: pack.label }))
  };
}
