import { createHash } from "node:crypto";
import { badRequest } from "../platform/errors.js";
import type { Price } from "../platform-billing/model.js";
import { commercialPolicy, organizationProfile, type CommercialPolicy, type CommercialProfile } from "./profile.js";

/** Catalog prices and billing currency are independent. Accepted snapshots never re-rate. */
export function resolveRegionalPrice(price:Price, profile:CommercialProfile, policy:CommercialPolicy):Price {
  const { regional_prices, ...base }=price;
  const explicit=regional_prices?.[profile.tier]?.[profile.currency];
  if(!explicit && !["USD","EUR"].includes(profile.currency))throw badRequest("billing_currency_price_missing","This product does not yet have a price in your billing currency.");
  const multiplier=policy.multipliers[profile.tier];
  const resolved:Price={...base,currency:profile.currency,minor_digits:profile.minor_digits,
    monthly_cents:explicit?.monthly_cents ?? Math.round(price.monthly_cents*multiplier),
    rates:explicit?.rates ?? price.rates.map(r=>({...r,unit_price_micros:Math.round(r.unit_price_micros*multiplier)}))};
  if(resolved.currency!==price.currency || resolved.monthly_cents!==price.monthly_cents || JSON.stringify(resolved.rates)!==JSON.stringify(price.rates)) {
    resolved.billing_price_key=`${price.id}_${createHash("sha256").update(JSON.stringify([resolved.currency,resolved.monthly_cents,resolved.rates])).digest("hex").slice(0,16)}`;
  }
  return resolved;
}
export async function priceForOrganization(org:string, price:Price) {
  const [profile,policy]=await Promise.all([organizationProfile(org),commercialPolicy()]);
  return resolveRegionalPrice(price,profile,policy.config);
}
export function stripePriceKey(price:Price) { return price.billing_price_key || price.id; }
