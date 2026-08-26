import { fetchJson, sourceNow } from "./http.js";
import type { CodeReportDesignValues, CodeReportProperty, CodeReportSource } from "./types.js";

type UsgsDesignMapsResponse = {
  request?: { status?: string; url?: string };
  response?: {
    data?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
};

type FemaQueryResponse = {
  features?: Array<{
    attributes?: Record<string, unknown>;
  }>;
  error?: { message?: string };
};

export async function fetchPublicDesignValues(input: {
  property: CodeReportProperty;
  referenceCode: string;
  riskCategory: string;
  siteClass: string;
  timeoutMs: number;
}): Promise<{ design: CodeReportDesignValues; sources: CodeReportSource[] }> {
  const sources: CodeReportSource[] = [];
  const [seismic, flood] = await Promise.all([
    fetchSeismic(input).catch((error) => {
      sources.push(unavailableSource("usgs-designmaps", "USGS Design Maps", "https://earthquake.usgs.gov/ws/designmaps/", error));
      return null;
    }),
    fetchFlood(input.property, input.timeoutMs).catch((error) => {
      sources.push(unavailableSource("fema-nfhl", "FEMA National Flood Hazard Layer", "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer", error));
      return null;
    })
  ]);

  if (seismic?.source) sources.push(seismic.source);
  if (flood?.source) sources.push(flood.source);

  return {
    design: {
      reference_code: input.referenceCode,
      risk_category: input.riskCategory,
      site_class: input.siteClass,
      seismic: seismic?.values ?? emptySeismic(),
      flood: flood?.values ?? emptyFlood(),
      climate: estimateClimateValues(input.property)
    },
    sources: [
      ...sources,
      climateSource(input.property)
    ]
  };
}

async function fetchSeismic(input: {
  property: CodeReportProperty;
  referenceCode: string;
  riskCategory: string;
  siteClass: string;
  timeoutMs: number;
}) {
  const version = input.referenceCode.toLowerCase();
  const url = new URL(`https://earthquake.usgs.gov/ws/designmaps/${version}.json`);
  url.searchParams.set("latitude", String(input.property.lat));
  url.searchParams.set("longitude", String(input.property.lon));
  url.searchParams.set("riskCategory", input.riskCategory);
  url.searchParams.set("siteClass", input.siteClass);
  url.searchParams.set("title", input.property.matched_address ?? "Code report site");
  const data = await fetchJson<UsgsDesignMapsResponse>(url.toString(), input.timeoutMs);
  const values = data.response?.data ?? {};
  const metadata = data.response?.metadata ?? {};
  return {
    values: {
      ss: numberOrNull(values.ss),
      s1: numberOrNull(values.s1),
      sds: numberOrNull(values.sds),
      sd1: numberOrNull(values.sd1),
      sdc: stringOrNull(values.sdc),
      pgam: numberOrNull(values.pgam),
      tl: numberOrNull(values.tl),
      model_version: stringOrNull(metadata.modelVersion)
    },
    source: {
      id: "usgs-designmaps",
      name: `USGS Design Maps ${input.referenceCode}`,
      url: data.request?.url ?? url.toString(),
      status: "ok" as const,
      retrieved_at: sourceNow()
    }
  };
}

async function fetchFlood(property: CodeReportProperty, timeoutMs: number) {
  const url = new URL("https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query");
  url.searchParams.set("f", "json");
  url.searchParams.set("where", "1=1");
  url.searchParams.set("outFields", "*");
  url.searchParams.set("returnGeometry", "false");
  url.searchParams.set("geometry", `${property.lon},${property.lat}`);
  url.searchParams.set("geometryType", "esriGeometryPoint");
  url.searchParams.set("inSR", "4326");
  url.searchParams.set("spatialRel", "esriSpatialRelIntersects");
  const data = await fetchJson<FemaQueryResponse>(url.toString(), timeoutMs);
  if (data.error) throw new Error(data.error.message ?? "FEMA query failed");
  const attrs = data.features?.[0]?.attributes ?? {};
  return {
    values: {
      zone: stringOrNull(attrs.FLD_ZONE ?? attrs.FLD_AR_ID),
      subtype: stringOrNull(attrs.ZONE_SUBTY),
      panel: stringOrNull(attrs.FIRM_PAN),
      effective_date: formatFemaDate(attrs.EFF_DATE),
      nearest_feature_distance_meters: null
    },
    source: {
      id: "fema-nfhl",
      name: "FEMA National Flood Hazard Layer",
      url: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28",
      status: "ok" as const,
      retrieved_at: sourceNow()
    }
  };
}

function estimateClimateValues(property: CodeReportProperty) {
  const state = String(property.state ?? "").toUpperCase();
  const place = String(property.place ?? "").toLowerCase();
  const county = String(property.county ?? "").toLowerCase();
  if (state === "WA" && (place.includes("snohomish") || county.includes("snohomish"))) {
    return {
      ground_snow_psf: 25,
      wind_speed_mph: 110,
      roof_live_load_psf: 20,
      frost_line_inches: 18,
      source: "city_of_snohomish_design_criteria"
    };
  }
  const lat = property.lat;
  const coastal = ["FL", "SC", "NC", "GA", "LA", "TX", "AL", "MS"].includes(state);
  const western = ["CA", "OR", "WA", "NV", "AZ", "NM", "UT", "CO", "ID", "MT", "WY"].includes(state);
  const northern = lat >= 42 || ["ME", "VT", "NH", "MA", "NY", "MI", "MN", "ND", "SD", "WI"].includes(state);
  return {
    ground_snow_psf: northern ? 30 : western && lat > 38 ? 25 : 20,
    wind_speed_mph: coastal ? 140 : western ? 110 : 115,
    roof_live_load_psf: 20,
    frost_line_inches: northern ? 42 : western ? 24 : 12,
    source: "screening_estimate"
  };
}

function climateSource(property: CodeReportProperty): CodeReportSource {
  const state = String(property.state ?? "").toUpperCase();
  const place = String(property.place ?? "").toLowerCase();
  const county = String(property.county ?? "").toLowerCase();
  if (state === "WA" && (place.includes("snohomish") || county.includes("snohomish"))) {
    return {
      id: "snohomish-design-criteria",
      name: "City of Snohomish local design criteria",
      url: "https://www.snohomishwa.gov/667/Building-Code-Information",
      status: "ok",
      note: "Local published criteria used for design wind speed, snow load, roof drainage rainfall, frost line, and seismic zone.",
      retrieved_at: sourceNow()
    };
  }
  return {
    id: "climate-prescriptive-table",
    name: "Model-code climate screening defaults",
    url: "local-table",
    status: "ok",
    note: "Used only where a jurisdiction-specific source has not yet been mapped.",
    retrieved_at: sourceNow()
  };
}

function emptySeismic() {
  return { ss: null, s1: null, sds: null, sd1: null, sdc: null, pgam: null, tl: null, model_version: null };
}

function emptyFlood() {
  return { zone: null, subtype: null, panel: null, effective_date: null, nearest_feature_distance_meters: null };
}

function unavailableSource(id: string, name: string, url: string, error: unknown): CodeReportSource {
  return {
    id,
    name,
    url,
    status: "unavailable",
    note: error instanceof Error ? error.message : String(error),
    retrieved_at: sourceNow()
  };
}

function numberOrNull(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringOrNull(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function formatFemaDate(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString().slice(0, 10);
  }
  return stringOrNull(value);
}
