import { badRequest } from "./errors.js";
import { fetchText } from "./http.js";
import type { GeoPoint } from "./types.js";

type PropertyInput = {
  address?: string;
  lat?: number;
  lon?: number;
};

export async function resolveProperty(input: PropertyInput, timeoutMs: number): Promise<GeoPoint> {
  if (input.lat != null && input.lon != null) {
    return {
      lat: input.lat,
      lon: input.lon,
      address: input.address ?? null
    };
  }

  if (!input.address) {
    throw badRequest("Address or lat/lon is required.");
  }

  const url = new URL("https://geocoding.geo.census.gov/geocoder/locations/onelineaddress");
  url.searchParams.set("address", input.address);
  url.searchParams.set("benchmark", "Public_AR_Current");
  url.searchParams.set("format", "json");
  const body = JSON.parse(await fetchText(url.toString(), timeoutMs, { Accept: "application/json" })) as {
    result?: { addressMatches?: Array<{ matchedAddress?: string; coordinates?: { x?: number; y?: number } }> };
  };
  const match = body.result?.addressMatches?.[0];
  const lon = match?.coordinates?.x;
  const lat = match?.coordinates?.y;
  if (lat == null || lon == null) {
    throw badRequest("Unable to geocode the property address.", { address: input.address });
  }

  return {
    lat,
    lon,
    address: input.address,
    matched_address: match?.matchedAddress ?? null
  };
}
