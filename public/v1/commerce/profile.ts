import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { readGlobal } from "../platform/storage.js";
import { readInternalDocument } from "../internal/storage.js";
import { countryCode, detectSignupCountry, EU_COUNTRIES, localCurrency, preferredLanguage, regionLanguage } from "./regions.js";
import { conflict } from "../platform/errors.js";

const currencyCode=z.string().regex(/^[A-Z]{3}$/);
export const commercialPolicySchema=z.object({
  multipliers:z.object({domestic:z.literal(1),international:z.number().positive().max(20)}).strict(),
  currencies:z.record(currencyCode,z.object({minor_digits:z.number().int().min(0).max(3),report_multiplier:z.number().positive().max(10000)}).strict())
}).strict().refine(p=>p.currencies.USD?.minor_digits===2 && p.currencies.EUR?.minor_digits===2,"USD and EUR must remain supported");
export type CommercialPolicy=z.infer<typeof commercialPolicySchema>;
export const DEFAULT_COMMERCIAL_POLICY:CommercialPolicy={multipliers:{domestic:1,international:2},currencies:{USD:{minor_digits:2,report_multiplier:1},EUR:{minor_digits:2,report_multiplier:1}}};
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
  const country=countryCode(value),domestic=country==="US"||country==="CA",local=localCurrency(country);
  const desired=domestic?"USD":EU_COUNTRIES.has(country)?"EUR":local;
  const currency=policy.currencies[desired]?desired:"USD";
  return {version:1,country,source,assigned_at:new Date().toISOString(),tier:domestic?"domestic":"international",currency,local_currency:local,
    credit_display:domestic||EU_COUNTRIES.has(country)||(desired!=="USD"&&policy.currencies[desired])?"currency":"credits",locale:regionLanguage(country),preferred_locale:preferredLanguage(country),
    measurement_system:country==="US"?"imperial":"metric",minor_digits:policy.currencies[currency]!.minor_digits,policy_revision:revision};
}
export async function signupCommercialProfile(headers:Record<string,unknown>,input:Record<string,unknown>) {
  const detected=detectSignupCountry(headers,input),policy=await commercialPolicy();
  const profile=profileForCountry(detected.country,detected.source,policy.config,policy.revision);
  if(!detected.country)profile.credit_display="credits";
  return profile;
}
export function profileFromGlobal(data:Record<string,unknown>):CommercialProfile {
  return data.commercial_profile===undefined?{...LEGACY_PROFILE}:profileSchema.parse(data.commercial_profile);
}
export async function organizationProfile(org:string) { return profileFromGlobal((await readGlobal(org)).data); }
export const commerceContext=new AsyncLocalStorage<{profile:CommercialProfile;policy:CommercialPolicy;revision:number}>();
export function currentProfile(){ return commerceContext.getStore()?.profile || LEGACY_PROFILE; }
export async function withOrganizationCommerce<T>(org:string,fn:()=>T) {
  const [profile,policy]=await Promise.all([organizationProfile(org),commercialPolicy()]);
  return commerceContext.run({profile,policy:policy.config,revision:policy.revision},fn);
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
    report_prices:{residential:reportPrice(7),commercial:reportPrice(12),multifamily:reportPrice(12),gutters:reportPrice(2),weather:reportPrice(5),instant_residential:reportPrice(2),instant_commercial:reportPrice(4),instant_multifamily:reportPrice(4)}};
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
