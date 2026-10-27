import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { readDocument, readGlobal } from "../platform/storage.js";
import { TIME_ZONE_COUNTRIES } from "./timezone-countries.js";
import { readInternalDocument } from "../internal/storage.js";
import { countryCode, detectSignupCountry, isDomesticCountry, localCurrency, preferredLanguage, regionLanguage } from "./regions.js";
import { conflict } from "../platform/errors.js";

const currencyCode=z.string().regex(/^[A-Z]{3}$/);
const timeZone=z.string().max(100).refine(value=>{try{new Intl.DateTimeFormat("en-US",{timeZone:value});return true;}catch{return false;}},"Unsupported time zone");
/** Report prices outside the US and Canada, in euros, as charged (VAT included). Operators change them on the Prices page. */
export const internationalPricesSchema=z.object({
  residential:z.number().positive().max(1000),
  per_structure:z.number().positive().max(1000),
  gutters:z.number().min(0).max(1000),
  vat_included:z.boolean(),
  /** Expedite workload and delivery windows run on this clock when neither the property nor the organization gives one. */
  expedite_time_zone:timeZone
}).strict();
export const DEFAULT_INTERNATIONAL_PRICES:z.infer<typeof internationalPricesSchema>={residential:25,per_structure:40,gutters:5,vat_included:true,expedite_time_zone:"Europe/London"};
export const commercialPolicySchema=z.object({
  /** Retired: international expediting is always offered (Europe pricing, 2026-10-21). Accepted so saved policies still load. */
  international_expedite_enabled:z.boolean().optional(),
  international_prices:internationalPricesSchema.default(DEFAULT_INTERNATIONAL_PRICES),
  multipliers:z.object({domestic:z.literal(1),international:z.number().positive().max(20)}).strict(),
  currencies:z.record(currencyCode,z.object({minor_digits:z.number().int().min(0).max(3),report_multiplier:z.number().positive().max(10000)}).strict())
}).strict().refine(p=>p.currencies.USD?.minor_digits===2 && p.currencies.EUR?.minor_digits===2,"USD and EUR must remain supported");
export type CommercialPolicy=z.infer<typeof commercialPolicySchema>;
export const DEFAULT_COMMERCIAL_POLICY:CommercialPolicy={international_prices:{...DEFAULT_INTERNATIONAL_PRICES},multipliers:{domestic:1,international:2},currencies:{USD:{minor_digits:2,report_multiplier:1},EUR:{minor_digits:2,report_multiplier:1}}};
export const profileSchema=z.object({
  version:z.literal(1),country:z.string(),source:z.string(),assigned_at:z.string(),
  tier:z.enum(["domestic","international"]),currency:currencyCode,local_currency:currencyCode,
  credit_display:z.enum(["currency","credits"]),locale:z.string(),preferred_locale:z.string(),measurement_system:z.enum(["imperial","metric"]),
  minor_digits:z.number().int().min(0).max(3),policy_revision:z.number().int().min(0)
}).strict();
export type CommercialProfile=z.infer<typeof profileSchema>;
export const LEGACY_PROFILE:CommercialProfile={version:1,country:"US",source:"legacy",assigned_at:"",tier:"domestic",currency:"USD",local_currency:"USD",credit_display:"currency",locale:"en-US",preferred_locale:"en-US",measurement_system:"imperial",minor_digits:2,policy_revision:0};
export async function commercialPolicy() {
  const saved=await readInternalDocument("pricing_config","commercial");
  return {config:saved?commercialPolicySchema.parse(saved.data):structuredClone(DEFAULT_COMMERCIAL_POLICY),revision:Number(saved?.revision||0)};
}
export function profileForCountry(value:string,source="operator",policy=DEFAULT_COMMERCIAL_POLICY,revision=0):CommercialProfile {
  const country=countryCode(value),domestic=isDomesticCountry(country),local=localCurrency(country);
  const desired=domestic?"USD":"EUR";
  const currency=policy.currencies[desired]?desired:"USD";
  return {version:1,country,source,assigned_at:new Date().toISOString(),tier:domestic?"domestic":"international",currency,local_currency:local,
    credit_display:"currency",locale:regionLanguage(country),preferred_locale:preferredLanguage(country),
    measurement_system:country==="US"?"imperial":"metric",minor_digits:policy.currencies[currency]!.minor_digits,policy_revision:revision};
}
export async function signupCommercialProfile(headers:Record<string,unknown>,input:Record<string,unknown>) {
  const detected=detectSignupCountry(headers,input),policy=await commercialPolicy();
  const profile=profileForCountry(detected.country,detected.source,policy.config,policy.revision);
  return profile;
}
export function profileFromGlobal(data:Record<string,unknown>):CommercialProfile {
  return data.commercial_profile===undefined?{...LEGACY_PROFILE}:profileSchema.parse(data.commercial_profile);
}
export async function organizationProfile(org:string) { return profileFromGlobal((await readGlobal(org)).data); }
export const commerceContext=new AsyncLocalStorage<{profile:CommercialProfile;policy:CommercialPolicy;revision:number;time_zone?:string}>();
export function currentProfile(){ return commerceContext.getStore()?.profile || LEGACY_PROFILE; }
/** Verified property country can raise a domestic account's report rate, never lower an international account's rate. */
export const reportPropertyCountry = new AsyncLocalStorage<string>();
export const reportEuroExchange = new AsyncLocalStorage<{rate:number;date:string}>();
export function internationalPrices() { return commerceContext.getStore()?.policy.international_prices || DEFAULT_INTERNATIONAL_PRICES; }
/** Euro prices for USD accounts use the reference rate: whole dollars for base prices, cents for rush fees. */
function internationalEuroPrice(euros:number,cents=false) {
  if(currentProfile().currency !== "USD")return euros;
  const fx=reportEuroExchange.getStore();
  if(!fx || !Number.isFinite(fx.rate) || fx.rate<=0)throw conflict("exchange_rate_unavailable","International prices are temporarily unavailable. Refresh the quote before ordering.");
  return cents?Math.round(euros*fx.rate*100)/100:Math.round(euros*fx.rate);
}
export function reportMarketRevision() {
  if(!internationalReportMarket())return 0;
  if(currentProfile().currency!=="USD")return 3; // 3: configured VAT-included prices and euro expedite tiers.
  internationalEuroPrice(internationalPrices().residential); // A USD international quote requires a verified reference rate.
  return 200000000+Math.round(reportEuroExchange.getStore()!.rate*1000000);
}
/** Expediting is offered in every market; outside the US and Canada it is priced in euros on a European clock. */
export function reportExpeditingAllowed() { return true; }
const DOMESTIC_EXPEDITE_TIME_ZONE="America/Los_Angeles";
/** A country's own zone, preferring its European mainland zone (Europe/Lisbon over Atlantic/Azores). */
function countryTimeZone(country:string) {
  const zones=Object.entries(TIME_ZONE_COUNTRIES).filter(([,code])=>code===country).map(([zone])=>zone);
  return zones.find(zone=>zone.startsWith("Europe/")) || zones[0] || "";
}
/**
 * The clock for expedite workload, cut-offs and delivery windows. Domestic: Pacific, as before.
 * International: the property's country, else the organization's configured zone, else its
 * country's, else the operator default (Europe/London).
 */
export function reportExpediteTimeZone() {
  if(!internationalReportMarket())return DOMESTIC_EXPEDITE_TIME_ZONE;
  const orgZone=commerceContext.getStore()?.time_zone||"",property=reportPropertyCountry.getStore()||"";
  if(property && !isDomesticCountry(property))return TIME_ZONE_COUNTRIES[orgZone]===property?orgZone:(countryTimeZone(property)||internationalPrices().expedite_time_zone);
  if(orgZone && !isDomesticCountry(TIME_ZONE_COUNTRIES[orgZone]||""))return orgZone;
  return countryTimeZone(currentProfile().country)||internationalPrices().expedite_time_zone;
}
export function internationalReportMarket() {
  const profile = currentProfile();
  const property = reportPropertyCountry.getStore();
  return profile.tier === "international" || (!!property && !isDomesticCountry(property));
}
/** Residential (domestic base 7) or one commercial/multifamily structure (domestic base 12). */
export function reportBasePrice(domesticBase: number) {
  return internationalReportMarket() ? internationalEuroPrice(domesticBase===7?internationalPrices().residential:internationalPrices().per_structure) : reportPrice(domesticBase);
}
/** Rush fees use the US tiers' numbers; outside the US and Canada those numbers are euros. */
export function reportRushPrice(domesticSurcharge: number, _domesticBase=7) {
  return internationalReportMarket() ? Math.round(internationalEuroPrice(domesticSurcharge,true)*100)/100 : reportPrice(domesticSurcharge);
}
export function reportGutterPrice() { return internationalReportMarket()?internationalEuroPrice(internationalPrices().gutters):2; }
/** Whether report prices are shown as "VAT included" (international market only). */
export function reportPricesIncludeVat() { return internationalReportMarket() && internationalPrices().vat_included; }

export async function withOrganizationCommerce<T>(org:string,fn:()=>T) {
  const [profile,policy]=await Promise.all([organizationProfile(org),commercialPolicy()]);
  // International organizations' expedite clock follows their configured company time zone.
  const time_zone=profile.tier==="international"?await readDocument(org,"branch","default").then(b=>String((b?.data?.localization as Record<string,unknown>|undefined)?.time_zone||""),()=>""):"";
  return commerceContext.run({profile,policy:policy.config,revision:policy.revision,time_zone},fn);
}
export function reportPrice(amount:number) {
  const ctx=commerceContext.getStore(),profile=ctx?.profile||LEGACY_PROFILE,policy=ctx?.policy||DEFAULT_COMMERCIAL_POLICY;
  const rate=policy.multipliers[profile.tier]*(policy.currencies[profile.currency]?.report_multiplier||1);
  // The existing prepaid ledger stores hundredths of a credit. A currency may
  // have finer Stripe precision, but report prices must remain ledger-exact.
  const digits=Math.min(2,profile.minor_digits);
  return Math.round(amount*rate*10**digits)/10**digits;
}
export function customerCommercialView(profile=currentProfile()) {
  return {currency:profile.currency,minor_digits:profile.minor_digits,credit_display:profile.credit_display,local_currency:profile.local_currency,pricing_revision:commerceContext.getStore()?.revision??0,
    vat_included:reportPricesIncludeVat(),
    report_prices:{residential:reportBasePrice(7),commercial:reportBasePrice(12),multifamily:reportBasePrice(12),gutters:reportGutterPrice(),weather:reportPrice(5),instant_residential:reportPrice(2),instant_commercial:reportPrice(4),instant_multifamily:reportPrice(4)}};
}
export function assertCommercialRevision(input:{commercial_pricing_revision?:unknown}) {
  const revision=commerceContext.getStore()?.revision??0;
  if(revision>0 && Number(input.commercial_pricing_revision??-1)!==revision)throw conflict("pricing_changed","Prices changed. Reload the page and review the price before ordering.");
}
export function creditLabel(amount:number,profile=currentProfile()) {
  const value=Number(amount.toFixed(2)).toString();
  return profile.credit_display==="credits"?`${value} credits`:profile.currency==="USD"?`$${value}`:profile.currency==="EUR"?`€${value}`:`${value} ${profile.currency}`;
}
export function creditMinorAmount(credits:number,profile=currentProfile()) {
  const amount=Math.round(credits*10**profile.minor_digits);
  if(!Number.isSafeInteger(amount)||amount<0)throw new Error("Invalid credit purchase amount");
  return amount;
}

/** Request-scoped prices: authenticated organization only, never actor/body hints. */
export function installCommerceContext(app:FastifyInstance) {
  app.addHook("preHandler",(request,_reply,done)=>{
    if(!/^\/v1\/(platform(?:\/|$)|firstmeasure(?:\/|$)|public\/firstmeasure(?:\/|$))/.test(request.url)||request.url.includes("/auth/"))return done();
    void (async()=>{
      let org="";
      if(request.url.startsWith("/v1/public/firstmeasure/") && request.headers.authorization)org=(await (await import("../public-firstmeasure/keys.js")).authenticatePublicFirstMeasureRequest(request)).orgId;
      else org=(await (await import("../platform/auth.js")).authContextFromRequest(request))?.orgId||"";
      if(!org)return done();
      await withOrganizationCommerce(org,()=>done());
    })().catch(done);
  });
}
