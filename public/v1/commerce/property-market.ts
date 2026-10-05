import { env } from "../src/config/env.js";
import { badRequest } from "../platform/errors.js";
import { countryCode, isDomesticCountry } from "./regions.js";
import { reportPropertyCountry } from "./profile.js";

const cache = new Map<string, { country: string; expires: number }>();
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function countryFromGeocode(payload: unknown) {
  const data = object(payload);
  if (data.status !== "OK" || !Array.isArray(data.results)) return "";
  for (const result of data.results) {
    const components = object(result).address_components;
    if (!Array.isArray(components)) continue;
    const component = components.map(object).find(c => Array.isArray(c.types) && c.types.includes("country"));
    const country = countryCode(component?.short_name);
    if (country) return country;
  }
  return "";
}
export function countryFromAzureGeocode(payload: unknown) {
  const features = object(payload).features;
  if (!Array.isArray(features)) return "";
  for (const feature of features) {
    const address = object(object(object(feature).properties).address);
    const country = countryCode(object(address.countryRegion).ISO);
    if (country) return country;
  }
  return "";
}

/** Client country fields never authorize a domestic discount. Resolve the actual order location at the server. */
export async function resolveReportPropertyCountry(input: Record<string, unknown>, required = true): Promise<string> {
  let pins: unknown = input.pins;
  if (typeof pins === "string") { try { pins = JSON.parse(pins); } catch { pins = []; } }
  if (Array.isArray(pins) && pins.length > 1) {
    if (pins.length > 10) throw badRequest("invalid_structures", "Too many property locations in one report.");
    const countries = await Promise.all(pins.map(pin => resolveReportPropertyCountry({ ...input, pins: [pin] }, required)));
    if (countries.some(country => isDomesticCountry(country) !== isDomesticCountry(countries[0]!))) {
      throw badRequest("property_market_mismatch", "Order US/Canadian and international properties separately.");
    }
    return countries[0]!;
  }
  const pin = object(Array.isArray(pins) ? pins[0] : null);
  const rawLat = pin.lat ?? input.lat;
  const rawLng = pin.lng ?? input.lng;
  const lat = Number(rawLat), lng = Number(rawLng);
  const hasCoordinates = rawLat != null && rawLat !== "" && rawLng != null && rawLng !== "" && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && (lat !== 0 || lng !== 0);
  const address = String(input.address || "").trim();
  if (!hasCoordinates && !address) {
    if (!required) return "";
    throw badRequest("property_country_required", "Choose the property address before ordering a report.");
  }
  const cacheKey = hasCoordinates ? `coordinates:${lat},${lng}` : `address:${address.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.country;
  const key = env.googleMapsApiKey;
  let country = "";
  if (key) {
    const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
    url.searchParams.set(hasCoordinates ? "latlng" : "address", hasCoordinates ? `${lat},${lng}` : address);
    url.searchParams.set("key", key);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (response.ok) country = countryFromGeocode(await response.json());
    } catch { /* Try the configured alternate geocoder before rejecting the order. */ }
  }
  // Azure Maps is already configured for server-side mapping. Google Geocoding
  // may be disabled independently of the browser Maps/Places APIs.
  if (!country && env.azureMapsSubscriptionKey) {
    const url = new URL(hasCoordinates ? "https://atlas.microsoft.com/reverseGeocode" : "https://atlas.microsoft.com/geocode");
    url.searchParams.set("api-version", "2025-01-01");
    url.searchParams.set(hasCoordinates ? "coordinates" : "query", hasCoordinates ? `${lng},${lat}` : address);
    try {
      const response = await fetch(url, { headers: { "subscription-key": env.azureMapsSubscriptionKey }, signal: AbortSignal.timeout(10000) });
      if (response.ok) country = countryFromAzureGeocode(await response.json());
    } catch { /* Fail before charging; never guess the lower price. */ }
  }
  if (!country) throw badRequest("property_country_unavailable", "We could not verify the property's country. Check the address and try again.");
  if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
  cache.set(cacheKey, { country, expires: Date.now() + 300000 });
  return country;
}
export async function withReportPropertyMarket<T>(input: Record<string, unknown>, callback: (country: string) => T, required = true): Promise<Awaited<T>> {
  const country = await resolveReportPropertyCountry(input, required);
  return await reportPropertyCountry.run(country, () => callback(country));
}
