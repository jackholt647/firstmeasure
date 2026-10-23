// International calling codes by country, generated from libphonenumber-js metadata (not a runtime dependency).
import CALLING_CODES from "./calling-codes.json" with { type: "json" };
import { LANGUAGE_PACKS, SUPPORTED_LOCALES } from "../platform/localization/languages.js";
import { countryCode, detectSignupCountry, DOMESTIC_COUNTRIES, OPERATING_COUNTRIES, regionLanguage, resolveSignupLanguage, supportedLanguage } from "./regions.js";
import { commerceContext, DEFAULT_COMMERCIAL_POLICY, profileForCountry, reportBasePrice, reportPricesIncludeVat, type CommercialPolicy, type CommercialProfile } from "./profile.js";

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

/**
 * The company language a signup creates (1M8-240): the language the form was shown in (sent as `signup_language`,
 * or the `lang` hand-off), else detection from the request, else the billing profile's regional language.
 */
export function signupLanguage(body: Record<string, unknown>, profile: CommercialProfile, headers: Record<string, unknown> = {}) {
  const sent = supportedLanguage(body.signup_language) || supportedLanguage(body.lang);
  if (sent) return sent;
  const detected = resolveSignupLanguage(headers, body);
  return detected.source === "default" ? profile.locale : detected.language;
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


/**
 * Everything a signup form needs to offer country, phone calling code and language choices,
 * prefilled from the same detection registration uses when nothing is chosen.
 */
export function signupOptions(headers: Record<string, unknown>, query: Record<string, unknown> = {}, policy: CommercialPolicy = DEFAULT_COMMERCIAL_POLICY) {
  const hints = { signup_time_zone: query.time_zone, signup_locale: query.locale, signup_locales: query.locales, lang: query.lang };
  const language = resolveSignupLanguage(headers, hints);
  const detected = detectSignupCountry(headers, { ...hints, signup_language: language.language });
  // Country names in the language the signup is shown in (1M8-240).
  const display = language.language;
  const names = regionNames(display);
  const countries = Object.keys(CALLING_CODES).map(code => {
    const valid = countryCode(code), name = valid ? names.of(valid) : "";
    return valid && name ? { code: valid, name, calling_code: callingCode(valid), language: regionLanguage(valid) } : null;
  }).filter(Boolean) as { code: string; name: string; calling_code: string; language: string }[];
  countries.sort((a, b) => a.name.localeCompare(b.name, display));
  // The calling-code picker offers the countries the platform operates in (1M8-240), plus the detected country when it is
  // not one of them, since nobody is refused: the detected one first, then the domestic market, then the rest by name.
  const rank = (code: string) => code === detected.country ? 0 : DOMESTIC_COUNTRIES.has(code) ? 1 : 2;
  // The account country offers the same countries, by name (1M8-240).
  const operatingCountries = countries.filter(country => OPERATING_COUNTRIES.has(country.code));
  const phoneCountries = countries
    .filter(country => OPERATING_COUNTRIES.has(country.code) || country.code === detected.country)
    .map(({ code, name, calling_code }) => ({ code, name, calling_code }))
    .sort((a, b) => rank(a.code) - rank(b.code) || (rank(a.code) === 1 ? [...DOMESTIC_COUNTRIES].indexOf(a.code) - [...DOMESTIC_COUNTRIES].indexOf(b.code) : a.name.localeCompare(b.name, display)));
  return {
    ok: true,
    // The phone picker's default: the detected country (the list is not a signup gate).
    country: phoneCountries.some(country => country.code === detected.country) ? detected.country : "",
    detected_country: detected.country,
    source: detected.source,
    // The language the signup is shown and created in (1M8-240).
    language: language.language,
    language_source: language.source,
    // The residential report price an account from the detected country pays, for the page's offer line.
    report_price: (() => {
      const profile = profileForCountry(detected.country, "signup_options", policy);
      return commerceContext.run({ profile, policy, revision: 0 }, () => ({ amount: reportBasePrice(7), currency: profile.currency, vat_included: reportPricesIncludeVat() }));
    })(),
    domestic_countries: [...DOMESTIC_COUNTRIES],
    countries,
    operating_countries: operatingCountries,
    phone_countries: phoneCountries,
    languages: signupLanguages()
  };
}
