import { badRequest } from "./errors.js";
import { fetchJson, sourceNow } from "./http.js";
import type { CodeReportProperty, CodeReportSource } from "./types.js";

type CensusGeocodeResponse = {
  result?: {
    addressMatches?: Array<{
      matchedAddress?: string;
      coordinates?: { x?: number; y?: number };
      addressComponents?: {
        city?: string;
        state?: string;
        zip?: string;
      };
      geographies?: Record<string, Array<Record<string, unknown>>>;
    }>;
  };
};

export async function resolveCodeReportProperty(
  input: { address?: string; lat?: number; lon?: number },
  timeoutMs: number
): Promise<{ property: CodeReportProperty; source: CodeReportSource }> {
  if (input.address) {
    const url = new URL("https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress");
    url.searchParams.set("address", input.address);
    url.searchParams.set("benchmark", "Public_AR_Current");
    url.searchParams.set("vintage", "Current_Current");
    url.searchParams.set("format", "json");
    const data = await fetchJson<CensusGeocodeResponse>(url.toString(), timeoutMs);
    const match = data.result?.addressMatches?.[0];
    const x = Number(match?.coordinates?.x);
    const y = Number(match?.coordinates?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw badRequest("Unable to geocode the property address.", { address: input.address });
    }
    const geographies = match?.geographies ?? {};
    const county = firstGeo(geographies, "Counties");
    const place = firstGeo(geographies, "Incorporated Places") ?? firstGeo(geographies, "County Subdivisions");
    const tract = firstGeo(geographies, "Census Tracts");
    return {
      property: {
        input_address: input.address,
        matched_address: match?.matchedAddress ?? input.address,
        lat: y,
        lon: x,
        city: match?.addressComponents?.city ?? nameOf(place),
        state: match?.addressComponents?.state ?? stringOf(county?.STATE),
        postal_code: match?.addressComponents?.zip ?? null,
        county: nameOf(county),
        county_geoid: stringOf(county?.GEOID),
        place: nameOf(place),
        census_tract: nameOf(tract)
      },
      source: {
        id: "census-geocoder",
        name: "U.S. Census Geocoder",
        url: "https://geocoding.geo.census.gov/",
        status: "ok",
        retrieved_at: sourceNow()
      }
    };
  }

  if (input.lat != null && input.lon != null) {
    return {
      property: {
        input_address: null,
        matched_address: null,
        lat: input.lat,
        lon: input.lon,
        city: null,
        state: null,
        postal_code: null,
        county: null,
        county_geoid: null,
        place: null,
        census_tract: null
      },
      source: {
        id: "input-coordinates",
        name: "Input latitude/longitude",
        url: "local-input",
        status: "ok",
        retrieved_at: sourceNow()
      }
    };
  }

  throw badRequest("Address or latitude/longitude is required.");
}

function firstGeo(geographies: Record<string, Array<Record<string, unknown>>>, key: string) {
  return geographies[key]?.[0] ?? null;
}

function nameOf(value: Record<string, unknown> | null | undefined) {
  return stringOf(value?.NAME ?? value?.BASENAME);
}

function stringOf(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}
