import regionData from "./region-data.json" with { type: "json" };
import { TERRITORY_DEFAULTS } from "./territory-defaults.js";
import { TIME_ZONE_COUNTRIES } from "./timezone-countries.js";
import { SUPPORTED_LOCALES } from "../platform/localization/core.js";

// Policy regions are independent of UI language and the currency of a visitor's card.
export const DOMESTIC_COUNTRIES = new Set(regionData.domestic_countries);
export function isDomesticCountry(country: string) { return DOMESTIC_COUNTRIES.has(country); }
export const EU_COUNTRIES = new Set(regionData.eu_countries);
/** The countries the platform operates in (1M8-240, Ben's list): the phone calling codes offered. One source, in the region data. */
export const OPERATING_COUNTRIES = new Set(regionData.operating_countries);
export function isOperatingCountry(country: string) { return OPERATING_COUNTRIES.has(country); }
const AMERICAS = new Set("US CA MX GT BZ SV HN NI CR PA CU DO HT JM BS BB TT AG DM GD KN LC VC AR BO BR CL CO EC FK GF GY PE PY SR UY VE PR VI AW CW SX BQ BM KY TC VG AI MS GP MQ BL MF GL PM".split(" "));
const LANGUAGES: Record<string,string> = {
  US:"en-US",CA:"en-CA",GB:"en-GB",IE:"en-IE",AU:"en-AU",NZ:"en-NZ",ZA:"en-ZA",
  FR:"fr-FR",BE:"nl-BE",LU:"fr-LU",DE:"de-DE",AT:"de-AT",CH:"de-CH",ES:"es-ES",PT:"pt-PT",IT:"it-IT",NL:"nl-NL",
  DK:"da-DK",SE:"sv-SE",NO:"nb-NO",FI:"fi-FI",IS:"is-IS",PL:"pl-PL",CZ:"cs-CZ",SK:"sk-SK",HU:"hu-HU",RO:"ro-RO",BG:"bg-BG",
  GR:"el-GR",CY:"el-CY",HR:"hr-HR",SI:"sl-SI",EE:"et-EE",LV:"lv-LV",LT:"lt-LT",MT:"mt-MT",UA:"uk-UA",TR:"tr-TR",
  MX:"es-MX",AR:"es-AR",CL:"es-CL",CO:"es-CO",PE:"es-PE",BR:"pt-BR",EC:"es-EC",UY:"es-UY",PY:"es-PY",BO:"es-BO",VE:"es-VE",
  GT:"es-GT",CR:"es-CR",PA:"es-PA",DO:"es-DO",SV:"es-SV",HN:"es-HN",NI:"es-NI",CU:"es-CU",PR:"es-PR",
  JP:"ja-JP",KR:"ko-KR",CN:"zh-CN",TW:"zh-TW",HK:"zh-HK",IN:"hi-IN",ID:"id-ID",TH:"th-TH",VN:"vi-VN",MY:"ms-MY",PH:"fil-PH",
  SG:"en-SG",IL:"he-IL",SA:"ar-SA",AE:"ar-AE",EG:"ar-EG",NG:"en-NG",KE:"sw-KE",PK:"ur-PK",BD:"bn-BD"
};
const CURRENCIES: Record<string,string> = {
  US:"USD",CA:"CAD",GB:"GBP",JP:"JPY",AU:"AUD",NZ:"NZD",CH:"CHF",NO:"NOK",SE:"SEK",DK:"DKK",PL:"PLN",CZ:"CZK",HU:"HUF",RO:"RON",
  MX:"MXN",BR:"BRL",AR:"ARS",CL:"CLP",CO:"COP",PE:"PEN",IN:"INR",CN:"CNY",TW:"TWD",HK:"HKD",SG:"SGD",KR:"KRW",ID:"IDR",MY:"MYR",
  TH:"THB",PH:"PHP",VN:"VND",ZA:"ZAR",TR:"TRY",IL:"ILS",SA:"SAR",AE:"AED",EG:"EGP",NG:"NGN",KE:"KES",PK:"PKR",BD:"BDT",UA:"UAH"
};
export function countryCode(value: unknown) {
  const code=String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code) || ["XX","ZZ","T1"].includes(code)) return "";
  try { return new Intl.DisplayNames(["en"],{type:"region",fallback:"none"}).of(code) ? code : ""; } catch { return ""; }
}
export function preferredLanguage(country:string) { return LANGUAGES[country] || TERRITORY_DEFAULTS[country]?.locale || (AMERICAS.has(country)?"en-US":"en-GB"); }
export function regionLanguage(country:string, available:readonly string[]=SUPPORTED_LOCALES) {
  const preferred=preferredLanguage(country), base=preferred.split("-")[0];
  const alternate=base!=="en" ? TERRITORY_DEFAULTS[country]?.alternates?.map(locale=>available.find(l=>l===locale)||available.find(l=>l.split("-")[0]===locale.split("-")[0])).find(Boolean) : undefined;
  return available.find(l=>l===preferred) || (base!=="en"?available.find(l=>l.split("-")[0]===base):undefined)
    || alternate || (AMERICAS.has(country)?"en-US":"en-GB");
}
export function localCurrency(country:string) { return CURRENCIES[country] || TERRITORY_DEFAULTS[country]?.currency || (EU_COUNTRIES.has(country)?"EUR":"USD"); }

/**
 * The shipped language pack for a language tag (1M8-240): the exact pack, else the pack for the same language, so
 * regional variants land on the language we have (es-MX -> es-ES, pt-PT -> pt-BR, de-AT -> de-DE, nn -> nb-NO).
 * English outside the Americas is en-GB. "" when we have no pack for the language.
 */
export function supportedLanguage(value:unknown, available:readonly string[]=SUPPORTED_LOCALES) {
  const raw=String(value ?? "").trim().replace(/_/g,"-");
  if(!raw || raw==="*")return "";
  let tag="";
  try { tag=Intl.getCanonicalLocales(raw)[0] || ""; } catch { return ""; }
  const exact=available.find(l=>l.toLowerCase()===tag.toLowerCase());
  if(exact)return exact;
  const [language="",...rest]=tag.toLowerCase().split("-");
  const region=(rest.find(part=>/^[a-z]{2}$/.test(part)) || "").toUpperCase();
  if(language==="en"){
    const british=region && region!=="US" && !AMERICAS.has(region);
    return (british?available.find(l=>l==="en-GB"):undefined) || available.find(l=>l==="en-US") || "";
  }
  const base=({no:"nb",nn:"nb"} as Record<string,string>)[language] || language;
  return available.find(l=>(l.split("-")[0] || "").toLowerCase()===base) || "";
}

/**
 * The language a signup is shown and created in (1M8-240): the language the visitor already saw (the hand-off,
 * `lang`), then the edge country's regional language, then the browser's languages, then the time zone's country,
 * else English (US). Never asked: the visitor does not choose it.
 */
export function resolveSignupLanguage(headers:Record<string,unknown>, input:Record<string,unknown>={}) {
  const handoff=supportedLanguage(input.lang) || supportedLanguage(input.signup_language);
  if(handoff)return {language:handoff,source:"handoff"};
  for(const name of ["cf-ipcountry","x-vercel-ip-country","x-appengine-country"]) {
    const country=countryCode(headers[name]); if(country)return {language:regionLanguage(country),source:name};
  }
  const browser=[input.signup_locale,...String(input.signup_locales || "").split(","),...String(headers["accept-language"] || "").split(",")]
    .map(value=>String(value || "").split(";")[0]!.trim()).filter(Boolean);
  for(const value of browser){ const language=supportedLanguage(value); if(language)return {language,source:"browser_language"}; }
  const zone=String(input.signup_time_zone || "");
  if(TIME_ZONE_COUNTRIES[zone])return {language:regionLanguage(TIME_ZONE_COUNTRIES[zone]!),source:"browser_time_zone"};
  return {language:"en-US",source:"default"};
}

/** Used once during registration. Never called on login or when changing a branch. */
export function detectSignupCountry(headers:Record<string,unknown>, input:Record<string,unknown>={}) {
  // The country the person chose at signup wins. Choosing a non-domestic country only
  // raises prices, and property-market pricing still applies to every order.
  const chosen=countryCode(input.signup_country);
  if(chosen)return {country:chosen,source:"signup_choice"};
  for(const name of ["cf-ipcountry","x-vercel-ip-country","x-appengine-country"]) {
    const country=countryCode(headers[name]); if(country)return {country,source:name};
  }
  // Browser hints are a fallback when the edge has no country data. Neither is an
  // anti-fraud signal. Incoming edge headers must be overwritten by the proxy.
  const zone=String(input.signup_time_zone || "");
  if(TIME_ZONE_COUNTRIES[zone])return {country:TIME_ZONE_COUNTRIES[zone]!,source:"browser_time_zone"};
  const language=(String(input.signup_locale || headers["accept-language"] || "").split(",")[0] || "").split(";")[0] || "";
  const country=countryCode(language.split(/[-_]/)[1]);
  if(country)return {country,source:"browser_locale"};
  // A local ten-digit phone is the existing US/Canada signup convention.
  const raw=String(input.phone || ""),digits=raw.replace(/\D/g,"");
  if((!raw.startsWith("+")&&digits.length===10)||/^1\d{10}$/.test(digits))return {country:"US",source:"north_american_phone"};
  // 1M8-240: a signup is never refused for its location. Without any location signal, the region of the language the
  // visitor saw (es-ES -> Spain), else the domestic default.
  const fromLanguage=countryCode(String(input.signup_language || input.lang || "").split(/[-_]/)[1]);
  if(fromLanguage)return {country:fromLanguage,source:"signup_language"};
  return {country:"US",source:"default"};
}
