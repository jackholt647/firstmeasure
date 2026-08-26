import { badRequest } from "./errors.js";
import { env } from "../src/config/env.js";
import { INSTANT_STRUCTURE_INSIGHTS_FILE_NAME } from "./instant.js";
import { ensureInstantPdfArtifact } from "./instant_pdf.js";
import {
  patchManifest,
  readArtifact,
  readBrandingDefaults,
  readManifest,
  saveArtifact,
  type ProjectManifest
} from "./storage.js";

type ProcessingInput = {
  address?: string;
  lat?: number | null;
  lng?: number | null;
  radius_meters?: number | null;
};

type ProcessingResult = {
  project: ProjectManifest;
  generated_files: string[];
};

type ResolvedProjectLocation = {
  address: string;
  lat: number;
  lng: number;
};

type ResolvedProjectArea = ResolvedProjectLocation & {
  radius_meters: number;
  bounds: LatLngBox;
};

type LatLng = {
  latitude: number;
  longitude: number;
};

type LatLngBox = {
  sw: LatLng;
  ne: LatLng;
};

type InstantStructureArtifactEntry = {
  pin_index: number;
  label: string;
  pin: {
    lat: number;
    lng: number;
  };
  status: "ok" | "no_coverage" | "duplicate_match" | "error";
  coverage_at_pin: boolean;
  insights: Record<string, unknown> | null;
  matched_structure_id: string | null;
  duplicate_of_pin_index: number | null;
  duplicate_of_label: string | null;
  coverage_note: string | null;
  error: string | null;
};

type CollectedStructureInsights = {
  primaryInsights: Record<string, unknown>;
  primaryText: string;
  artifact: {
    version: number;
    generated_at: string;
    primary_index: number | null;
    structures: InstantStructureArtifactEntry[];
  };
  hasCoverageAtAnyPin: boolean;
  segmentCount: number;
};

const DEFAULT_SOLAR_RADIUS_METERS = 60;
const MIN_SOLAR_RADIUS_METERS = 20;
const MULTI_PIN_PADDING_RATIO = 0.2;
const MULTI_PIN_PADDING_METERS = 20;
const STRUCTURE_SUPPLEMENTAL_PADDING_RATIO = 0.15;
const STRUCTURE_SUPPLEMENTAL_PADDING_METERS = 12;
const STRUCTURE_SUPPLEMENTAL_MAX_RADIUS_METERS = 100;

function requireGoogleKey(purpose: "server" | "solar" | "maps_static" = "server") {
  const key = String(
    purpose === "solar"
      ? env.googleSolarApiKey
      : purpose === "maps_static"
        ? env.googleMapsStaticApiKey
        : env.googleMapsApiKey
  ).trim();
  if (!key) {
    throw badRequest("missing_google_api_key", `The server Google ${purpose} credential is not configured.`);
  }
  return key;
}

function toNullableNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value && typeof value === "object" && !Array.isArray(value))
    ? value as Record<string, unknown>
    : {};
}

function normalizeProjectPins(manifest: ProjectManifest) {
  if (!Array.isArray(manifest.pins)) {
    return [];
  }

  return manifest.pins
    .map((entry) => ({
      lat: toNullableNumber(entry?.lat),
      lng: toNullableNumber(entry?.lng)
    }))
    .filter((entry): entry is { lat: number; lng: number } => entry.lat != null && entry.lng != null);
}

function pointHasInstantStructureCoverage(
  pin: { lat: number | null; lng: number | null },
  insights: Record<string, unknown>
) {
  const pinLat = toNullableNumber(pin?.lat);
  const pinLng = toNullableNumber(pin?.lng);
  if (pinLat == null || pinLng == null) {
    return false;
  }

  const boundingBox = normalizeLatLngBox(insights.boundingBox);
  if (boundingBox && pointInsideLatLngBox(pinLat, pinLng, boundingBox)) {
    return true;
  }

  const segments = Array.isArray(asRecord(insights.solarPotential).roofSegmentStats)
    ? asRecord(insights.solarPotential).roofSegmentStats as unknown[]
    : [];
  for (const entry of segments) {
    const segmentBounds = normalizeLatLngBox(asRecord(entry).boundingBox);
    if (segmentBounds && pointInsideLatLngBox(pinLat, pinLng, segmentBounds)) {
      return true;
    }
  }

  return false;
}

function buildStructureLabel(index: number) {
  let remainder = index;
  let label = "";
  do {
    label = String.fromCharCode(65 + (remainder % 26)) + label;
    remainder = Math.floor(remainder / 26) - 1;
  } while (remainder >= 0);
  return label;
}

function countRoofSegments(insights: Record<string, unknown> | null) {
  if (!insights) {
    return 0;
  }
  const segments = asRecord(insights.solarPotential).roofSegmentStats;
  return Array.isArray(segments) ? segments.length : 0;
}

function matchedStructureId(insights: Record<string, unknown> | null) {
  const name = String(insights?.name ?? "").trim();
  return name || null;
}

async function fetchBuildingInsightsText(
  location: { lat: number; lng: number },
  key: string
) {
  const url = `https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${location.lat}&location.longitude=${location.lng}&requiredQuality=LOW&key=${encodeURIComponent(key)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw badRequest("insights_fetch_failed", `Building insights request failed with status ${response.status}.`);
  }
  return await response.text();
}

function parseInsightsText(text: string) {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw badRequest("insights_parse_failed", "Building insights response could not be parsed.");
  }
}

function solarImageryQualityPatchFromSolarResponse(response: Record<string, unknown> | null) {
  const quality = String(response?.imageryQuality ?? "").trim().toUpperCase();
  const patch: Record<string, unknown> = {};
  if (quality) {
    patch.solar_imagery_quality = quality;
    patch.height_map_quality = quality;
  }
  if (response?.imageryDate) patch.solar_imagery_date = response.imageryDate;
  if (response?.imageryProcessedDate) patch.solar_imagery_processed_date = response.imageryProcessedDate;
  return patch;
}

function resolveRequestedStructurePins(
  manifest: ProjectManifest,
  fallbackLocation: ResolvedProjectLocation
) {
  const pins = normalizeProjectPins(manifest);
  if (pins.length) {
    return pins;
  }
  return [{ lat: fallbackLocation.lat, lng: fallbackLocation.lng }];
}

async function collectStructureInsights(input: {
  manifest: ProjectManifest;
  fallbackLocation: ResolvedProjectLocation;
  key: string;
}) : Promise<CollectedStructureInsights> {
  const requestedPins = resolveRequestedStructurePins(input.manifest, input.fallbackLocation);
  const structures: Array<InstantStructureArtifactEntry & { text: string | null }> = await Promise.all(
    requestedPins.map(async (pin, index) => {
      const label = buildStructureLabel(index);
      try {
        const text = await fetchBuildingInsightsText(pin, input.key);
        const parsed = parseInsightsText(text);
        const coverageAtPin = pointHasInstantStructureCoverage(pin, parsed);
        return {
          pin_index: index,
          label,
          pin,
          status: coverageAtPin ? "ok" as const : "no_coverage" as const,
          coverage_at_pin: coverageAtPin,
          insights: parsed,
          matched_structure_id: matchedStructureId(parsed),
          duplicate_of_pin_index: null,
          duplicate_of_label: null,
          coverage_note: coverageAtPin ? null : "No usable instant structure was found at this selected pin.",
          error: null,
          text
        };
      } catch (error) {
        if (requestedPins.length === 1) {
          throw error;
        }
        return {
          pin_index: index,
          label,
          pin,
          status: "error" as const,
          coverage_at_pin: false,
          insights: null,
          matched_structure_id: null,
          duplicate_of_pin_index: null,
          duplicate_of_label: null,
          coverage_note: "Building insights could not be retrieved for this selected pin.",
          error: String((error as Error)?.message ?? "Building insights request failed."),
          text: null
        };
      }
    })
  );

  const seenStructureIds = new Map<string, { pinIndex: number; label: string }>();
  for (const entry of structures) {
    if (!entry.coverage_at_pin) continue;
    const structureId = entry.matched_structure_id;
    if (!structureId) continue;
    const existing = seenStructureIds.get(structureId);
    if (!existing) {
      seenStructureIds.set(structureId, { pinIndex: entry.pin_index, label: entry.label });
      continue;
    }
    entry.status = "duplicate_match";
    entry.coverage_at_pin = false;
    entry.duplicate_of_pin_index = existing.pinIndex;
    entry.duplicate_of_label = existing.label;
    entry.coverage_note = `This selected pin resolved to the same solar structure as Structure ${existing.label}, so it was excluded.`;
  }

  let primaryIndex = structures.findIndex((entry) => entry.coverage_at_pin && entry.insights);
  if (primaryIndex < 0) {
    primaryIndex = structures.findIndex((entry) => entry.insights);
  }
  if (primaryIndex < 0) {
    throw badRequest("insights_fetch_failed", "Building insights could not be retrieved for any selected structure.");
  }

  const primary = structures[primaryIndex];
  if (!primary?.insights || !primary.text) {
    throw badRequest("insights_fetch_failed", "A usable primary structure insight could not be determined.");
  }

  return {
    primaryInsights: primary.insights,
    primaryText: primary.text,
    artifact: {
      version: 1,
      generated_at: new Date().toISOString(),
      primary_index: primaryIndex,
      structures: structures.map(({ text, ...entry }) => entry)
    },
    hasCoverageAtAnyPin: structures.some((entry) => entry.coverage_at_pin),
    segmentCount: structures.reduce(
      (sum, entry) => sum + (entry.coverage_at_pin ? countRoofSegments(entry.insights) : 0),
      0
    )
  };
}

function normalizeLatLngBox(value: unknown) {
  const record = asRecord(value);
  const sw = asRecord(record.sw);
  const ne = asRecord(record.ne);
  const swLat = toNullableNumber(sw.latitude);
  const swLng = toNullableNumber(sw.longitude);
  const neLat = toNullableNumber(ne.latitude);
  const neLng = toNullableNumber(ne.longitude);
  if (swLat == null || swLng == null || neLat == null || neLng == null) {
    return null;
  }
  return {
    sw: { latitude: swLat, longitude: swLng },
    ne: { latitude: neLat, longitude: neLng }
  };
}

function deriveLatLngBoxFromSegments(value: unknown): LatLngBox | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const boxes = value
    .map((entry) => normalizeLatLngBox(asRecord(entry).boundingBox))
    .filter((box): box is LatLngBox => box !== null);
  return unionLatLngBoxes(boxes);
}

function deriveStructureBoundsFromInsights(insights: Record<string, unknown> | null): LatLngBox | null {
  if (!insights) {
    return null;
  }
  return normalizeLatLngBox(insights.boundingBox)
    ?? deriveLatLngBoxFromSegments(asRecord(insights.solarPotential).roofSegmentStats);
}

function pointInsideLatLngBox(lat: number, lng: number, bounds: { sw: { latitude: number; longitude: number }; ne: { latitude: number; longitude: number } }) {
  return (
    lat >= Math.min(bounds.sw.latitude, bounds.ne.latitude)
    && lat <= Math.max(bounds.sw.latitude, bounds.ne.latitude)
    && lng >= Math.min(bounds.sw.longitude, bounds.ne.longitude)
    && lng <= Math.max(bounds.sw.longitude, bounds.ne.longitude)
  );
}

function computeComplexityRating(segmentCount: number) {
  if (segmentCount <= 0) return 3;
  if (segmentCount <= 5) return 1;
  if (segmentCount <= 10) return 2;
  if (segmentCount <= 20) return 3;
  if (segmentCount <= 35) return 4;
  return 5;
}

function pointValueForComplexity(complexity: number) {
  switch (complexity) {
    case 1:
      return 2;
    case 2:
      return 3;
    case 3:
      return 4;
    case 4:
      return 6;
    case 5:
      return 10;
    default:
      return null;
  }
}

function usesMultiStructurePointRollup(manifest: ProjectManifest) {
  const projectType = String(manifest.project_type ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return projectType === "commercial" || projectType === "multifamily" || projectType === "multi_family";
}

function buildMultiStructurePointPatch(
  manifest: ProjectManifest,
  artifact: CollectedStructureInsights["artifact"]
) {
  const structures = Array.isArray(artifact.structures) ? artifact.structures : [];
  if (!usesMultiStructurePointRollup(manifest) || structures.length <= 1) {
    return {};
  }

  const usableStructures = structures.filter((entry) => entry.coverage_at_pin && entry.insights);
  if (usableStructures.length <= 1) {
    return {};
  }

  const structureComplexities = usableStructures.map((entry) => {
    const segmentCount = countRoofSegments(entry.insights);
    const complexity = computeComplexityRating(segmentCount);
    const points = pointValueForComplexity(complexity) ?? 0;
    return {
      pin_index: entry.pin_index,
      label: entry.label,
      segment_count: segmentCount,
      complexity,
      points
    };
  });
  const rawPoints = structureComplexities.reduce((sum, entry) => sum + entry.points, 0);
  if (rawPoints <= 0) {
    return {};
  }

  return {
    point_value: Math.max(1, Math.round(rawPoints * 0.8)),
    point_calculation: {
      mode: "multi_structure_rollup",
      multiplier: 0.8,
      raw_points: rawPoints,
      structures: structureComplexities
    }
  };
}

function usesPerStructureInstantPricing(manifest: ProjectManifest) {
  const projectType = String(manifest.project_type ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const reportMode = String(manifest.report_mode ?? "").trim().toLowerCase();
  return (
    (projectType === "commercial" || projectType === "multifamily" || projectType === "multi_family")
    && reportMode === "instant"
  );
}

function resolvePartialInstantRefundAmount(
  manifest: ProjectManifest,
  structureCount: number,
  missingStructureCount: number
) {
  if (!usesPerStructureInstantPricing(manifest)) {
    return 0;
  }
  if (structureCount < 1 || missingStructureCount < 1) {
    return 0;
  }
  const chargedAmount = toNullableNumber(manifest.amount_charged);
  if (chargedAmount == null || chargedAmount <= 0) {
    return 0;
  }
  const perStructureAmount = Math.round(chargedAmount / structureCount);
  return perStructureAmount > 0 ? perStructureAmount * missingStructureCount : 0;
}

function buildPartialInstantRefundPatch(
  manifest: ProjectManifest,
  artifact: CollectedStructureInsights["artifact"]
) {
  const structures = Array.isArray(artifact.structures) ? artifact.structures : [];
  const missingStructureCount = structures.filter((entry) => entry.status !== "ok").length;
  const refundAmount = resolvePartialInstantRefundAmount(manifest, structures.length, missingStructureCount);
  if (refundAmount < 1) {
    return {};
  }

  if (Boolean(manifest.refund_issued)) {
    return {
      refund_amount: refundAmount,
      refund_reason: "instant_partial_no_coverage",
      refund_pending: false
    };
  }

  return {
    refund_amount: refundAmount,
    refund_reason: "instant_partial_no_coverage",
    refund_pending: true
  };
}

function normalizeSolarGeoTiffUrl(url: string) {
  const parsed = new URL(url);
  parsed.searchParams.set("alt", "media");
  return parsed.toString();
}

async function fetchJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url);
  if (!response.ok) return null;
  return await response.json() as T;
}

async function fetchBinary(url: string, headers?: Record<string, string>) {
  const response = await fetch(url, { headers });
  if (!response.ok) return null;
  return new Uint8Array(await response.arrayBuffer());
}

async function geocodeProjectAddress(requestedAddress: string, key: string): Promise<ResolvedProjectLocation> {
  if (!requestedAddress) {
    throw badRequest("missing_address", "address is required when lat/lng are not available.");
  }

  const geo = await fetchJson<{
    results?: Array<{
      formatted_address?: string;
      geometry?: { location?: { lat?: number; lng?: number } };
    }>;
  }>(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(requestedAddress)}&key=${encodeURIComponent(key)}`
  );
  const first = geo?.results?.[0];
  const location = first?.geometry?.location;
  if (!location || typeof location.lat !== "number" || typeof location.lng !== "number") {
    throw badRequest("geocode_failed", "Unable to geocode project address.");
  }

  return {
    address: String(first?.formatted_address ?? requestedAddress),
    lat: location.lat,
    lng: location.lng
  };
}

async function resolveProjectLocation(manifest: ProjectManifest, input: ProcessingInput): Promise<ResolvedProjectLocation> {
  const key = requireGoogleKey("server");
  const requestedAddress = String(input.address ?? manifest.address ?? "").trim();
  const pins = normalizeProjectPins(manifest);
  const firstPin = pins[0];

  if (firstPin) {
    return {
      address: requestedAddress || manifest.address,
      lat: firstPin.lat,
      lng: firstPin.lng
    };
  }

  const existingLat = toNullableNumber(input.lat) ?? toNullableNumber(manifest.lat);
  const existingLng = toNullableNumber(input.lng) ?? toNullableNumber(manifest.lng);

  if (existingLat != null && existingLng != null) {
    return {
      address: requestedAddress || manifest.address,
      lat: existingLat,
      lng: existingLng
    };
  }

  return await geocodeProjectAddress(requestedAddress, key);
}

function resolveProjectImageryArea(
  manifest: ProjectManifest,
  input: ProcessingInput,
  fallbackLocation: ResolvedProjectLocation,
  structureArtifact?: CollectedStructureInsights["artifact"] | null
): ResolvedProjectArea {
  const pins = normalizeProjectPins(manifest);
  const baseRadiusMeters = Math.max(
    MIN_SOLAR_RADIUS_METERS,
    Number(input.radius_meters ?? manifest.radius_meters ?? DEFAULT_SOLAR_RADIUS_METERS)
  );

  const center = resolveProjectAreaCenter(pins, fallbackLocation, structureArtifact);
  const bounds = resolveProjectAreaBounds(pins, center, structureArtifact);
  const paddedBounds = padLatLngBox(bounds, MULTI_PIN_PADDING_RATIO, MULTI_PIN_PADDING_METERS);
  const requiredRadiusMeters = Math.ceil(maxDistanceFromPointToBoxCorners(center, paddedBounds));

  return {
    address: fallbackLocation.address,
    lat: center.latitude,
    lng: center.longitude,
    radius_meters: Math.max(baseRadiusMeters, requiredRadiusMeters),
    bounds: buildFallbackBounds(center, Math.max(baseRadiusMeters, requiredRadiusMeters))
  };
}

function resolveProjectAreaCenter(
  pins: Array<{ lat: number; lng: number }>,
  fallbackLocation: ResolvedProjectLocation,
  structureArtifact?: CollectedStructureInsights["artifact"] | null
): LatLng {
  const structureBounds = unionLatLngBoxes(extractStructureCaptureBounds(structureArtifact));
  if (pins.length <= 1 && structureBounds) {
    return centerOfLatLngBox(structureBounds);
  }

  const pinBounds = unionLatLngBoxes(pins.map((pin) => pointToLatLngBox(pin.lat, pin.lng)));
  if (pinBounds) {
    return centerOfLatLngBox(pinBounds);
  }

  if (structureBounds) {
    return centerOfLatLngBox(structureBounds);
  }

  return { latitude: fallbackLocation.lat, longitude: fallbackLocation.lng };
}

function resolveProjectAreaBounds(
  pins: Array<{ lat: number; lng: number }>,
  center: LatLng,
  structureArtifact?: CollectedStructureInsights["artifact"] | null
): LatLngBox {
  const boxes: LatLngBox[] = [
    ...pins.map((pin) => pointToLatLngBox(pin.lat, pin.lng)),
    ...extractStructureCaptureBounds(structureArtifact)
  ];
  return unionLatLngBoxes(boxes) ?? buildFallbackBounds(center, MIN_SOLAR_RADIUS_METERS);
}

function extractStructureCaptureBounds(
  structureArtifact?: CollectedStructureInsights["artifact"] | null
): LatLngBox[] {
  if (!structureArtifact || !Array.isArray(structureArtifact.structures)) {
    return [];
  }

  const bounds: LatLngBox[] = [];
  for (const entry of structureArtifact.structures) {
    if (!entry.coverage_at_pin || !entry.insights) continue;
    const structureBounds = deriveStructureBoundsFromInsights(entry.insights);
    if (structureBounds) bounds.push(structureBounds);
  }
  return bounds;
}

function pointToLatLngBox(lat: number, lng: number): LatLngBox {
  return {
    sw: { latitude: lat, longitude: lng },
    ne: { latitude: lat, longitude: lng }
  };
}

function centerOfLatLngBox(bounds: LatLngBox): LatLng {
  return {
    latitude: (bounds.sw.latitude + bounds.ne.latitude) / 2,
    longitude: (bounds.sw.longitude + bounds.ne.longitude) / 2
  };
}

function unionLatLngBoxes(boxes: LatLngBox[]): LatLngBox | null {
  if (!boxes.length) {
    return null;
  }

  let minLat = Number.POSITIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;

  for (const bounds of boxes) {
    minLat = Math.min(minLat, bounds.sw.latitude, bounds.ne.latitude);
    minLng = Math.min(minLng, bounds.sw.longitude, bounds.ne.longitude);
    maxLat = Math.max(maxLat, bounds.sw.latitude, bounds.ne.latitude);
    maxLng = Math.max(maxLng, bounds.sw.longitude, bounds.ne.longitude);
  }

  return {
    sw: { latitude: minLat, longitude: minLng },
    ne: { latitude: maxLat, longitude: maxLng }
  };
}

function padLatLngBox(bounds: LatLngBox, paddingRatio: number, minPaddingMeters: number): LatLngBox {
  const centerLat = (bounds.sw.latitude + bounds.ne.latitude) / 2;
  const heightMeters = Math.max(
    latitudeDegreesToMeters(bounds.ne.latitude - bounds.sw.latitude),
    minPaddingMeters
  );
  const widthMeters = Math.max(
    longitudeDegreesToMeters(bounds.ne.longitude - bounds.sw.longitude, centerLat),
    minPaddingMeters
  );
  const paddingMeters = Math.max(
    minPaddingMeters,
    Math.max(heightMeters, widthMeters) * paddingRatio
  );
  const latPad = metersToLatitudeDegrees(paddingMeters);
  const lngPad = metersToLongitudeDegrees(paddingMeters, centerLat);
  return {
    sw: {
      latitude: Math.min(bounds.sw.latitude, bounds.ne.latitude) - latPad,
      longitude: Math.min(bounds.sw.longitude, bounds.ne.longitude) - lngPad
    },
    ne: {
      latitude: Math.max(bounds.sw.latitude, bounds.ne.latitude) + latPad,
      longitude: Math.max(bounds.sw.longitude, bounds.ne.longitude) + lngPad
    }
  };
}

function maxDistanceFromPointToBoxCorners(center: LatLng, bounds: LatLngBox) {
  return Math.max(
    latLngDistanceMeters(center, bounds.sw),
    latLngDistanceMeters(center, { latitude: bounds.sw.latitude, longitude: bounds.ne.longitude }),
    latLngDistanceMeters(center, bounds.ne),
    latLngDistanceMeters(center, { latitude: bounds.ne.latitude, longitude: bounds.sw.longitude })
  );
}

function latLngDistanceMeters(a: LatLng, b: LatLng) {
  const meanLat = (a.latitude + b.latitude) / 2;
  return Math.hypot(
    latitudeDegreesToMeters(b.latitude - a.latitude),
    longitudeDegreesToMeters(b.longitude - a.longitude, meanLat)
  );
}

function buildFallbackBounds(center: LatLng, radiusMeters: number): LatLngBox {
  const latDelta = metersToLatitudeDegrees(radiusMeters);
  const lngDelta = metersToLongitudeDegrees(radiusMeters, center.latitude);
  return {
    sw: {
      latitude: center.latitude - latDelta,
      longitude: center.longitude - lngDelta
    },
    ne: {
      latitude: center.latitude + latDelta,
      longitude: center.longitude + lngDelta
    }
  };
}

function resolveSolarPixelSizeMeters(radiusMeters: number) {
  if (radiusMeters <= 100) {
    return 0.1;
  }
  if (radiusMeters <= 500) {
    return 0.5;
  }
  return Math.ceil(radiusMeters / 1000);
}

function resolveStructureSupplementalCapture(entry: InstantStructureArtifactEntry) {
  const structureBounds = deriveStructureBoundsFromInsights(entry.insights);
  const fallbackBounds = pointToLatLngBox(entry.pin.lat, entry.pin.lng);
  const padded = padLatLngBox(structureBounds ?? fallbackBounds, STRUCTURE_SUPPLEMENTAL_PADDING_RATIO, STRUCTURE_SUPPLEMENTAL_PADDING_METERS);
  const center = centerOfLatLngBox(padded);
  const radiusMeters = Math.max(
    MIN_SOLAR_RADIUS_METERS,
    Math.min(
      STRUCTURE_SUPPLEMENTAL_MAX_RADIUS_METERS,
      Math.ceil(maxDistanceFromPointToBoxCorners(center, padded))
    )
  );
  return { center, radiusMeters };
}

async function generateStructureSupplementalImagery(input: {
  projectId: string;
  key: string;
  structureArtifact: CollectedStructureInsights["artifact"];
  generated: Set<string>;
}) {
  const structures = Array.isArray(input.structureArtifact.structures)
    ? input.structureArtifact.structures
    : [];
  if (structures.length <= 1) {
    return;
  }

  const statuses: Array<{
    structure_index: number;
    label: string;
    status: "ready" | "skipped" | "error";
    radius_meters?: number;
    center?: LatLng;
    files?: string[];
    reason?: string;
  }> = [];

  for (const entry of structures) {
    const structureIndex = entry.pin_index + 1;
    if (!entry.coverage_at_pin || !entry.insights) {
      statuses.push({
        structure_index: structureIndex,
        label: entry.label,
        status: "skipped",
        reason: entry.coverage_note ?? entry.error ?? "No usable structure coverage was found at this pin."
      });
      continue;
    }

    try {
      const capture = resolveStructureSupplementalCapture(entry);
      const layersUrl = "https://solar.googleapis.com/v1/dataLayers:get"
        + `?location.latitude=${capture.center.latitude}&location.longitude=${capture.center.longitude}`
        + `&radius_meters=${capture.radiusMeters}`
        + "&view=IMAGERY_AND_ANNUAL_FLUX_LAYERS"
        + "&requiredQuality=LOW"
        + "&pixelSizeMeters=0.1"
        + `&key=${encodeURIComponent(input.key)}`;
      const layers = await fetchJson<{
        rgbUrl?: string;
        dsmUrl?: string;
        maskUrl?: string;
      }>(layersUrl);
      const downloads: Array<{ suffix: string; rawUrl?: string }> = [
        { suffix: "rgb", rawUrl: layers?.rgbUrl },
        { suffix: "dsm", rawUrl: layers?.dsmUrl },
        { suffix: "mask", rawUrl: layers?.maskUrl }
      ];
      const savedFiles: string[] = [];
      for (const download of downloads) {
        if (!download.rawUrl) continue;
        const bytes = await fetchBinary(
          normalizeSolarGeoTiffUrl(`${download.rawUrl}&key=${encodeURIComponent(input.key)}`),
          { Accept: "image/tiff,application/octet-stream,*/*" }
        );
        if (!bytes) continue;
        const fileName = `structure-${structureIndex}-${download.suffix}.tif`;
        await saveArtifact(input.projectId, fileName, bytes);
        input.generated.add(fileName);
        savedFiles.push(fileName);
      }

      if (!savedFiles.includes(`structure-${structureIndex}-dsm.tif`)) {
        throw new Error("The supplemental Solar response did not include a usable height map.");
      }

      statuses.push({
        structure_index: structureIndex,
        label: entry.label,
        status: "ready",
        radius_meters: capture.radiusMeters,
        center: capture.center,
        files: savedFiles
      });
    } catch (error) {
      statuses.push({
        structure_index: structureIndex,
        label: entry.label,
        status: "error",
        reason: String((error as Error)?.message ?? "Supplemental structure imagery could not be generated.")
      });
    }
  }

  await saveArtifact(input.projectId, "structure-supplemental-status.json", JSON.stringify({
    version: 1,
    generated_at: new Date().toISOString(),
    structures: statuses
  }, null, 2));
  input.generated.add("structure-supplemental-status.json");
}

function latitudeDegreesToMeters(degrees: number) {
  return Math.abs(degrees) * 111_320;
}

function longitudeDegreesToMeters(degrees: number, latitude: number) {
  const cos = Math.cos((latitude * Math.PI) / 180);
  const safeCos = Math.max(Math.abs(cos), 0.000001);
  return Math.abs(degrees) * 111_320 * safeCos;
}

function metersToLatitudeDegrees(meters: number) {
  return meters / 111_320;
}

function metersToLongitudeDegrees(meters: number, latitude: number) {
  const cos = Math.cos((latitude * Math.PI) / 180);
  const safeCos = Math.max(Math.abs(cos), 0.000001);
  return meters / (111_320 * safeCos);
}

async function generateInsights(projectId: string, manifest: ProjectManifest, input: ProcessingInput) {
  const key = requireGoogleKey("solar");
  const location = await resolveProjectLocation(manifest, input);
  const collected = await collectStructureInsights({
    manifest,
    fallbackLocation: location,
    key
  });
  const projectArea = resolveProjectImageryArea(manifest, input, location, collected.artifact);
  await saveArtifact(projectId, "insights.json", collected.primaryText);
  await saveArtifact(projectId, INSTANT_STRUCTURE_INSIGHTS_FILE_NAME, JSON.stringify(collected.artifact, null, 2));
  const complexity = computeComplexityRating(collected.segmentCount);

  const updated = await patchManifest(projectId, {
    address: location.address,
    lat: projectArea.lat,
    lng: projectArea.lng,
    radius_meters: projectArea.radius_meters,
    complexity,
    ...buildMultiStructurePointPatch(manifest, collected.artifact),
    ...solarImageryQualityPatchFromSolarResponse(collected.primaryInsights),
    ...buildPartialInstantRefundPatch(manifest, collected.artifact)
  });

  return {
    manifest: updated,
    generatedFile: "insights.json"
  };
}

async function generateMask(projectId: string, manifest: ProjectManifest, input: ProcessingInput) {
  const key = requireGoogleKey("solar");
  const location = await resolveProjectLocation(manifest, input);
  const collected = await collectStructureInsights({
    manifest,
    fallbackLocation: location,
    key
  });
  const projectArea = resolveProjectImageryArea(manifest, input, location, collected.artifact);
  const radiusMeters = projectArea.radius_meters;
  const pixelSizeMeters = resolveSolarPixelSizeMeters(radiusMeters);
  const layersUrl = "https://solar.googleapis.com/v1/dataLayers:get"
    + `?location.latitude=${projectArea.lat}&location.longitude=${projectArea.lng}`
    + `&radius_meters=${radiusMeters}`
    + "&view=IMAGERY_AND_ANNUAL_FLUX_LAYERS"
    + "&requiredQuality=LOW"
    + `&pixelSizeMeters=${pixelSizeMeters}`
    + `&key=${encodeURIComponent(key)}`;
  const layers = await fetchJson<{
    maskUrl?: string;
    imageryQuality?: string;
    imageryDate?: unknown;
    imageryProcessedDate?: unknown;
  }>(layersUrl);
  if (!layers?.maskUrl) {
    throw badRequest("mask_url_missing", "Mask data was not returned for this property.");
  }
  const bytes = await fetchBinary(normalizeSolarGeoTiffUrl(`${layers.maskUrl}&key=${encodeURIComponent(key)}`), {
    Accept: "image/tiff,application/octet-stream,*/*"
  });
  if (!bytes) {
    throw badRequest("mask_download_failed", "Unable to download mask.tif.");
  }
  await saveArtifact(projectId, "mask.tif", bytes);
  const updated = await patchManifest(projectId, {
    address: location.address,
    lat: projectArea.lat,
    lng: projectArea.lng,
    radius_meters: radiusMeters,
    ...solarImageryQualityPatchFromSolarResponse(layers ?? null)
  });
  return {
    manifest: updated,
    generatedFile: "mask.tif"
  };
}

export async function processProjectImagery(projectId: string, input: ProcessingInput): Promise<ProcessingResult> {
  const key = requireGoogleKey("solar");
  let manifest = await readManifest(projectId);
  const location = await resolveProjectLocation(manifest, input);
  const generated = new Set<string>();

  const collectedInsights = await collectStructureInsights({
    manifest,
    fallbackLocation: location,
    key
  });
  const projectArea = resolveProjectImageryArea(manifest, input, location, collectedInsights.artifact);
  const radiusMeters = projectArea.radius_meters;
  const pixelSizeMeters = resolveSolarPixelSizeMeters(radiusMeters);
  await saveArtifact(projectId, "insights.json", collectedInsights.primaryText);
  generated.add("insights.json");
  await saveArtifact(projectId, INSTANT_STRUCTURE_INSIGHTS_FILE_NAME, JSON.stringify(collectedInsights.artifact, null, 2));
  generated.add(INSTANT_STRUCTURE_INSIGHTS_FILE_NAME);

  const complexity = computeComplexityRating(collectedInsights.segmentCount);
  const parsedInsights = collectedInsights.primaryInsights;

  if (manifest.instant_enabled || manifest.instant_only) {
    if (!collectedInsights.hasCoverageAtAnyPin) {
      const nowSql = new Date().toISOString().slice(0, 19).replace("T", " ");
      const rejectionPatch: Record<string, unknown> = {
        instant_status: "rejected_no_coverage",
        instant_rejection_reason: "no_structure_at_pin",
        refund_pending: true,
        refund_issued: false,
        refund_amount: typeof manifest.amount_charged === "number" ? manifest.amount_charged : 0,
        refund_reason: "instant_no_coverage",
        timestamps: {
          rejected_at: nowSql
        }
      };
      if (manifest.instant_only) {
        rejectionPatch.status = "rejected_no_coverage";
      }
      manifest = await patchManifest(projectId, rejectionPatch) as ProjectManifest;
      return {
        project: manifest,
        generated_files: Array.from(generated).sort()
      };
    }
  }

  const layersUrl = "https://solar.googleapis.com/v1/dataLayers:get"
    + `?location.latitude=${projectArea.lat}&location.longitude=${projectArea.lng}`
    + `&radius_meters=${radiusMeters}`
    + "&view=IMAGERY_AND_ANNUAL_FLUX_LAYERS"
    + "&requiredQuality=LOW"
    + `&pixelSizeMeters=${pixelSizeMeters}`
    + `&key=${encodeURIComponent(key)}`;
  const layers = await fetchJson<{
    rgbUrl?: string;
    dsmUrl?: string;
    maskUrl?: string;
    imageryQuality?: string;
    imageryDate?: unknown;
    imageryProcessedDate?: unknown;
  }>(layersUrl);

  const downloads: Array<Promise<void>> = [];
  const queueDownload = (fileName: string, rawUrl?: string) => {
    if (!rawUrl) return;
    downloads.push((async () => {
      const bytes = await fetchBinary(
        normalizeSolarGeoTiffUrl(`${rawUrl}&key=${encodeURIComponent(key)}`),
        { Accept: "image/tiff,application/octet-stream,*/*" }
      );
      if (!bytes) return;
      await saveArtifact(projectId, fileName, bytes);
      generated.add(fileName);
    })());
  };
  queueDownload("rgb.tif", layers?.rgbUrl);
  queueDownload("dsm.tif", layers?.dsmUrl);
  queueDownload("mask.tif", layers?.maskUrl);
  await Promise.all(downloads);

  await generateStructureSupplementalImagery({
    projectId,
    key,
    structureArtifact: collectedInsights.artifact,
    generated
  });

  const googleStaticMapKey = requireGoogleKey("maps_static");
  const googleStaticMap = await fetchBinary(
    `https://maps.googleapis.com/maps/api/staticmap?center=${projectArea.lat},${projectArea.lng}&zoom=20&size=640x640&scale=2&maptype=satellite&key=${encodeURIComponent(googleStaticMapKey)}`
  );
  if (googleStaticMap) {
    await saveArtifact(projectId, "google.png", googleStaticMap);
    generated.add("google.png");
  }

  const azureMap = env.azureMapsSubscriptionKey ? await fetchBinary(
    "https://atlas.microsoft.com/map/static"
      + `?subscription-key=${encodeURIComponent(env.azureMapsSubscriptionKey)}`
      + "&api-version=2024-04-01"
      + "&tilesetId=microsoft.imagery"
      + "&zoom=19"
      + `&center=${encodeURIComponent(`${projectArea.lng},${projectArea.lat}`)}`
      + "&width=800&height=800&language=en-US"
  ) : null;
  if (azureMap) {
    await saveArtifact(projectId, "azure.png", azureMap);
    generated.add("azure.png");
  }

  if (!generated.has("dsm.tif")) {
    throw badRequest("dsm_missing", "The model data response did not produce a usable height map.");
  }

  manifest = await patchManifest(projectId, {
    status: "ready",
    address: location.address,
    lat: projectArea.lat,
    lng: projectArea.lng,
    complexity,
    ...buildMultiStructurePointPatch(manifest, collectedInsights.artifact),
    ...solarImageryQualityPatchFromSolarResponse({ ...parsedInsights, ...(layers ?? {}) }),
    radius_meters: radiusMeters,
    ...buildPartialInstantRefundPatch(manifest, collectedInsights.artifact),
    timestamps: {
      processed_at: new Date().toISOString().slice(0, 19).replace("T", " ")
    }
  }) as ProjectManifest;

  const brandingDefaults = await readBrandingDefaults(projectId).catch(() => null);
  const instantPdf = await ensureInstantPdfArtifact({
    projectId,
    manifest,
    brandingDefaults,
    insights: parsedInsights,
    structureInsights: collectedInsights.artifact,
    rgbContent: generated.has("rgb.tif") ? (await readArtifactBytes(projectId, "rgb.tif")) : null,
    heightMapContent: generated.has("dsm.tif") ? (await readArtifactBytes(projectId, "dsm.tif")) : null,
    maskContent: generated.has("mask.tif") ? (await readArtifactBytes(projectId, "mask.tif")) : null
  }).catch(() => null);
  if (instantPdf?.fileName) {
    generated.add(instantPdf.fileName);
  }

  return {
    project: manifest,
    generated_files: Array.from(generated).sort()
  };
}

export async function processProjectMask(projectId: string, input: ProcessingInput): Promise<ProcessingResult> {
  const manifest = await readManifest(projectId);
  const result = await generateMask(projectId, manifest, input);
  return {
    project: result.manifest,
    generated_files: [result.generatedFile]
  };
}

export async function processProjectInsights(projectId: string, input: ProcessingInput): Promise<ProcessingResult> {
  const manifest = await readManifest(projectId);
  const result = await generateInsights(projectId, manifest, input);
  return {
    project: result.manifest,
    generated_files: [result.generatedFile]
  };
}

async function readArtifactBytes(projectId: string, fileName: string) {
  try {
    const artifact = await readArtifact(projectId, fileName);
    return artifact.content;
  } catch {
    return null;
  }
}
