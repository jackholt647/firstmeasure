// International calling codes by country, generated from libphonenumber-js metadata (not a runtime dependency).
import CALLING_CODES from "./calling-codes.json" with { type: "json" };
import { LANGUAGE_PACKS, SUPPORTED_LOCALES } from "../platform/localization/languages.js";
import { countryCode, detectSignupCountry, DOMESTIC_COUNTRIES, OPERATING_COUNTRIES, regionLanguage } from "./regions.js";
import type { CommercialProfile } from "./profile.js";
import { badRequest } from "../platform/errors.js";

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
 * The signup languages: the language packs the operating countries use (each country's regional language, the same
 * choice the country makes in signup and the billing profile). Today that is every pack; a pack no operating country
 * uses would not be offered.
 */
export function signupLanguages() {
  const used = new Set([...OPERATING_COUNTRIES].map(country => regionLanguage(country)));
  return LANGUAGE_PACKS.filter(pack => used.has(pack.code)).map(pack => ({ code: pack.code, label: pack.label }));
}

/** A signup's chosen country must be one the platform operates in (1M8-240); signups that choose none keep detection. */
export function assertSignupCountry(body: Record<string, unknown>) {
  const chosen = countryCode(body.signup_country);
  if (chosen && !OPERATING_COUNTRIES.has(chosen)) {
    throw badRequest("signup_country_unavailable", "FirstMate is not available in that country yet. Choose one of the countries listed.");
  }
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
  // The calling-code picker offers only the countries the platform operates in (1M8-240): the detected one first, then
  // the domestic market, then the rest by name.
  const rank = (code: string) => code === detected.country ? 0 : DOMESTIC_COUNTRIES.has(code) ? 1 : 2;
  // The account country offers the same countries, by name (1M8-240).
  const operatingCountries = countries.filter(country => OPERATING_COUNTRIES.has(country.code));
  const phoneCountries = countries
    .filter(country => OPERATING_COUNTRIES.has(country.code))
    .map(({ code, name, calling_code }) => ({ code, name, calling_code }))
    .sort((a, b) => rank(a.code) - rank(b.code) || (rank(a.code) === 1 ? [...DOMESTIC_COUNTRIES].indexOf(a.code) - [...DOMESTIC_COUNTRIES].indexOf(b.code) : a.name.localeCompare(b.name, display)));
  return {
    ok: true,
    // A detected country outside the list is not preselected; the person chooses one.
    country: OPERATING_COUNTRIES.has(detected.country) ? detected.country : "",
    detected_country: detected.country,
    source: detected.source,
    language: detected.country ? regionLanguage(detected.country) : "en-US",
    domestic_countries: [...DOMESTIC_COUNTRIES],
    countries,
    operating_countries: operatingCountries,
    phone_countries: phoneCountries,
    languages: signupLanguages()
  };
}
