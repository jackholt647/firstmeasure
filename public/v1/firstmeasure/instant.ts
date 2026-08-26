import { badRequest } from "./errors.js";
import type { ProjectManifest } from "./storage.js";

type LatLng = {
  latitude: number;
  longitude: number;
};

type LatLngBox = {
  sw: LatLng;
  ne: LatLng;
};

type InstantAssetUrls = {
  preview_image_url: string | null;
  solar_rgb_url: string | null;
  height_map_url: string | null;
  mask_url: string | null;
  insights_url: string | null;
  structure_insights_url?: string | null;
  instant_pdf_url?: string | null;
};

type InstantRoofAreaSummary = {
  total_roof_area_meters2: number | null;
  source: string | null;
  whole_roof_area_meters2: number | null;
  whole_roof_ground_area_meters2: number | null;
  building_area_meters2: number | null;
  building_ground_area_meters2: number | null;
};

type InstantStructurePayload = {
  structure_id: string;
  label: string;
  pin_index: number;
  pin: LatLng | null;
  center: LatLng | null;
  bounding_box: LatLngBox | null;
  bounding_box_points: Array<{ label: string; latitude: number; longitude: number }>;
  padded_bounding_box: LatLngBox | null;
  padded_bounding_box_points: Array<{ label: string; latitude: number; longitude: number }>;
  project_extent_bounds: LatLngBox | null;
  normalized_padded_bounds: {
    left: number;
    right: number;
    top: number;
    bottom: number;
  } | null;
  has_coverage: boolean;
  coverage_status: string;
  coverage_message: string | null;
  refund_eligible: boolean;
  refund_amount: number | null;
  refund_state: "none" | "pending" | "issued";
  mask_area: {
    roof_area_meters2: number | null;
    ground_area_meters2: number | null;
    source: string | null;
  };
  roof_area: InstantRoofAreaSummary;
  roof_segments: Array<Record<string, unknown>>;
  imagery_date: { year: number; month: number | null; day: number | null } | null;
  imagery_processed_date: { year: number; month: number | null; day: number | null } | null;
};

type InstantBillingSummary = {
  amount_charged: number | null;
  per_structure_charge: number | null;
  missing_structure_count: number;
  refundable_missing_structure_count: number;
  refundable_missing_amount: number | null;
};

export const INSTANT_STRUCTURE_INSIGHTS_FILE_NAME = "instant-structures.json";

const DEFAULT_CROP_PADDING_RATIO = 0.2;

export function projectHasInstantArtifacts(manifest: ProjectManifest) {
  const artifacts = asRecord(manifest.artifacts);
  return Boolean(artifacts.has_insights && artifacts.has_dsm_tif && artifacts.has_mask_tif);
}

export function buildProjectInstantPayload(input: {
  manifest: ProjectManifest;
  insights: unknown;
  structureInsights?: unknown;
  assetUrls: InstantAssetUrls;
}) {
  const manifest = input.manifest;
  const insights = asRecord(input.insights);
  const solarPotential = asRecord(insights.solarPotential);
  const wholeRoofStats = asRecord(solarPotential.wholeRoofStats);
  const buildingStats = asRecord(solarPotential.buildingStats);
  const manifestPins = normalizePinsFromManifest(manifest);
  const baseStructures = resolveStructurePayloads({
    manifest,
    insights,
    structureInsights: input.structureInsights,
    manifestPins
  });
  const projectCenter = normalizeLatLngFromManifest(manifest)
    ?? deriveCenterFromPins(manifestPins)
    ?? normalizeLatLng(insights.center)
    ?? deriveCenterFromStructures(baseStructures);
  const radiusMeters = toNullableNumber(manifest.radius_meters);

  if (!projectCenter) {
    throw badRequest("instant_location_missing", "Instant data requires a project center or lat/lng coordinates.");
  }

  const projectExtent = radiusMeters != null
    ? buildFallbackBounds(projectCenter, radiusMeters)
    : deriveBoundsFromStructures(baseStructures, "padded_bounding_box")
      ?? deriveBoundsFromStructures(baseStructures, "bounding_box");
  const structures = baseStructures.map((structure) => ({
    ...structure,
    project_extent_bounds: projectExtent,
    normalized_padded_bounds: structure.padded_bounding_box && projectExtent
      ? normalizeBoxWithinBox(structure.padded_bounding_box, projectExtent)
      : null
  }));
  const billing = buildInstantBillingSummary(manifest, structures);
  const roofArea = aggregateRoofAreaSummary(
    structures,
    resolveRoofAreaSummary(wholeRoofStats, buildingStats)
  );

  return {
    project_id: manifest.id,
    instant_enabled: Boolean(manifest.instant_enabled),
    instant_only: Boolean(manifest.instant_only),
    status: String(manifest.status ?? ""),
    address: String(manifest.address ?? ""),
    center: projectCenter,
    pins: Array.isArray(manifest.pins) ? manifest.pins : [],
    radius_meters: radiusMeters,
    imagery_date: normalizeDateParts(insights.imageryDate) ?? firstDefinedDate(structures, "imagery_date"),
    imagery_processed_date: normalizeDateParts(insights.imageryProcessedDate) ?? firstDefinedDate(structures, "imagery_processed_date"),
    rendering: {
      apply_mask_client_side: true,
      height_map_scope: "whole_area",
      preview_image_scope: "whole_area",
      crop_padding_ratio: DEFAULT_CROP_PADDING_RATIO
    },
    assets: input.assetUrls,
    billing,
    roof_area: roofArea,
    structure_count: structures.length,
    structure_count_with_coverage: structures.filter((structure) => structure.has_coverage).length,
    structures
  };
}

export function buildPendingProjectInstantPayload(input: {
  manifest: ProjectManifest;
  assetUrls: InstantAssetUrls;
}) {
  const manifest = input.manifest;
  const manifestPins = normalizePinsFromManifest(manifest);
  const center = normalizeLatLngFromManifest(manifest) ?? deriveCenterFromPins(manifestPins);
  const placeholderPins = manifestPins.length ? manifestPins : (center ? [center] : []);
  const structures = (placeholderPins.length ? placeholderPins : [null]).map((pin, index) => (
    buildEmptyStructurePayload({
      manifestId: manifest.id,
      label: buildStructureLabel(index),
      pinIndex: index,
      pin,
      center: pin ?? center,
      coverageStatus: "pending",
      coverageMessage: null
    })
  ));

  return {
    project_id: manifest.id,
    instant_enabled: Boolean(manifest.instant_enabled),
    instant_only: Boolean(manifest.instant_only),
    status: String(manifest.status ?? ""),
    address: String(manifest.address ?? ""),
    center,
    pins: Array.isArray(manifest.pins) ? manifest.pins : [],
    radius_meters: toNullableNumber(manifest.radius_meters),
    imagery_date: null,
    imagery_processed_date: null,
    rendering: {
      apply_mask_client_side: true,
      height_map_scope: "whole_area",
      preview_image_scope: "whole_area",
      crop_padding_ratio: DEFAULT_CROP_PADDING_RATIO
    },
    assets: input.assetUrls,
    billing: buildInstantBillingSummary(manifest, structures),
    roof_area: emptyRoofAreaSummary(),
    structure_count: structures.length,
    structure_count_with_coverage: 0,
    structures
  };
}

function resolveStructurePayloads(input: {
  manifest: ProjectManifest;
  insights: Record<string, unknown>;
  structureInsights?: unknown;
  manifestPins: LatLng[];
}) {
  const structureInsightRecord = asRecord(input.structureInsights);
  const artifactEntries = Array.isArray(structureInsightRecord.structures)
    ? structureInsightRecord.structures
    : [];
  const totalCount = Math.max(
    artifactEntries.length,
    input.manifestPins.length,
    Object.keys(input.insights).length ? 1 : 0
  );

  if (totalCount === 0) {
    return [
      buildEmptyStructurePayload({
        manifestId: input.manifest.id,
        label: "A",
        pinIndex: 0,
        pin: null,
        center: normalizeLatLngFromManifest(input.manifest),
        coverageStatus: "pending",
        coverageMessage: null
      })
    ];
  }

  return Array.from({ length: totalCount }, (_, index) => {
    const entry = asRecord(artifactEntries[index]);
    const pin = normalizePin(
      entry.pin,
      input.manifestPins[index] ?? input.manifestPins[0] ?? normalizeLatLngFromManifest(input.manifest)
    );
    const label = normalizeStructureLabel(entry.label, index);
    const coverageStatus = normalizeCoverageStatus(entry.status, entry.coverage_at_pin);
    const coverageMessage = normalizeCoverageMessage(entry.coverage_note, coverageStatus, entry.duplicate_of_label);
    const entryInsights = asRecord(entry.insights);

    if (coverageStatus === "ok" && Object.keys(entryInsights).length) {
      return buildStructurePayloadFromInsights({
        manifestId: input.manifest.id,
        label,
        pinIndex: index,
        pin,
        insights: entryInsights,
        coverageStatus,
        coverageMessage
      });
    }

    if (index === 0 && Object.keys(input.insights).length && artifactEntries.length === 0) {
      return buildStructurePayloadFromInsights({
        manifestId: input.manifest.id,
        label,
        pinIndex: index,
        pin,
        insights: input.insights,
        coverageStatus: Object.keys(entry).length ? coverageStatus : "ok",
        coverageMessage
      });
    }

    return buildEmptyStructurePayload({
      manifestId: input.manifest.id,
      label,
      pinIndex: index,
      pin,
      center: pin,
      coverageStatus,
      coverageMessage
    });
  });
}

function buildStructurePayloadFromInsights(input: {
  manifestId: string;
  label: string;
  pinIndex: number;
  pin: LatLng | null;
  insights: Record<string, unknown>;
  coverageStatus: string;
  coverageMessage: string | null;
}): InstantStructurePayload {
  const insights = input.insights;
  const solarPotential = asRecord(insights.solarPotential);
  const wholeRoofStats = asRecord(solarPotential.wholeRoofStats);
  const buildingStats = asRecord(solarPotential.buildingStats);
  const center = normalizeLatLng(insights.center) ?? input.pin;
  const boundingBox = normalizeLatLngBox(insights.boundingBox)
    ?? deriveBoundsFromSegments(solarPotential.roofSegmentStats)
    ?? (center ? buildFallbackBounds(center, 8) : null);
  const paddedBounds = boundingBox ? padLatLngBox(boundingBox, DEFAULT_CROP_PADDING_RATIO) : null;
  const roofArea = resolveRoofAreaSummary(wholeRoofStats, buildingStats);
  const hasCoverage = input.coverageStatus === "ok";

  return {
    structure_id: String(insights.name ?? `${input.manifestId}-${input.label.toLowerCase()}`),
    label: input.label,
    pin_index: input.pinIndex,
    pin: input.pin,
    center,
    bounding_box: boundingBox,
    bounding_box_points: boundingBox ? latLngBoxToPoints(boundingBox) : [],
    padded_bounding_box: paddedBounds,
    padded_bounding_box_points: paddedBounds ? latLngBoxToPoints(paddedBounds) : [],
    project_extent_bounds: null,
    normalized_padded_bounds: null,
    has_coverage: hasCoverage,
    coverage_status: input.coverageStatus,
    coverage_message: input.coverageMessage,
    refund_eligible: false,
    refund_amount: null,
    refund_state: "none",
    mask_area: {
      roof_area_meters2: toNullableNumber(buildingStats.areaMeters2),
      ground_area_meters2: toNullableNumber(buildingStats.groundAreaMeters2),
      source: "solar_api_building_stats"
    },
    roof_area: roofArea,
    roof_segments: normalizeRoofSegments(solarPotential.roofSegmentStats),
    imagery_date: normalizeDateParts(insights.imageryDate),
    imagery_processed_date: normalizeDateParts(insights.imageryProcessedDate)
  };
}

function buildEmptyStructurePayload(input: {
  manifestId: string;
  label: string;
  pinIndex: number;
  pin: LatLng | null;
  center: LatLng | null;
  coverageStatus: string;
  coverageMessage: string | null;
}): InstantStructurePayload {
  return {
    structure_id: `${input.manifestId}-${input.label.toLowerCase()}`,
    label: input.label,
    pin_index: input.pinIndex,
    pin: input.pin,
    center: input.center,
    bounding_box: null,
    bounding_box_points: [],
    padded_bounding_box: null,
    padded_bounding_box_points: [],
    project_extent_bounds: null,
    normalized_padded_bounds: null,
    has_coverage: false,
    coverage_status: input.coverageStatus,
    coverage_message: input.coverageMessage,
    refund_eligible: false,
    refund_amount: null,
    refund_state: "none",
    mask_area: {
      roof_area_meters2: null,
      ground_area_meters2: null,
      source: null
    },
    roof_area: emptyRoofAreaSummary(),
    roof_segments: [],
    imagery_date: null,
    imagery_processed_date: null
  };
}

function normalizeRoofSegments(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry, index) => {
      const segment = asRecord(entry);
      const stats = asRecord(segment.stats);
      const boundingBox = normalizeLatLngBox(segment.boundingBox);
      const center = normalizeLatLng(segment.center);
      const pitchDegrees = toNullableNumber(segment.pitchDegrees);
      if (pitchDegrees == null) {
        return null;
      }

      return {
        segment_index: index,
        pitch_degrees: pitchDegrees,
        azimuth_degrees: toNullableNumber(segment.azimuthDegrees),
        plane_height_at_center_meters: toNullableNumber(segment.planeHeightAtCenterMeters),
        roof_area_meters2: toNullableNumber(stats.areaMeters2),
        ground_area_meters2: toNullableNumber(stats.groundAreaMeters2),
        center,
        bounding_box: boundingBox,
        points: boundingBox ? latLngBoxToPoints(boundingBox) : []
      };
    })
    .filter((value) => value !== null);
}

function resolveRoofAreaSummary(
  wholeRoofStats: Record<string, unknown>,
  buildingStats: Record<string, unknown>
): InstantRoofAreaSummary {
  const wholeRoofArea = toNullableNumber(wholeRoofStats.areaMeters2);
  const wholeRoofGroundArea = toNullableNumber(wholeRoofStats.groundAreaMeters2);
  const buildingArea = toNullableNumber(buildingStats.areaMeters2);
  const buildingGroundArea = toNullableNumber(buildingStats.groundAreaMeters2);

  let totalRoofAreaMeters2 = wholeRoofArea;
  let source = wholeRoofArea != null ? "solar_api_whole_roof_stats" : null;

  if (
    wholeRoofArea != null
    && wholeRoofGroundArea != null
    && buildingGroundArea != null
    && wholeRoofGroundArea > 0
  ) {
    totalRoofAreaMeters2 = wholeRoofArea * (buildingGroundArea / wholeRoofGroundArea);
    source = "scaled_from_google_solar_ground_area_ratio";
  } else if (buildingArea != null) {
    totalRoofAreaMeters2 = buildingArea;
    source = "solar_api_building_stats";
  }

  return {
    total_roof_area_meters2: totalRoofAreaMeters2,
    source,
    whole_roof_area_meters2: wholeRoofArea,
    whole_roof_ground_area_meters2: wholeRoofGroundArea,
    building_area_meters2: buildingArea,
    building_ground_area_meters2: buildingGroundArea
  };
}

function aggregateRoofAreaSummary(
  structures: InstantStructurePayload[],
  fallback: InstantRoofAreaSummary
): InstantRoofAreaSummary {
  const covered = structures.filter((structure) => structure.has_coverage);
  if (covered.length <= 1) {
    return covered[0]?.roof_area ?? fallback;
  }

  return {
    total_roof_area_meters2: sumNullableNumbers(covered.map((structure) => structure.roof_area.total_roof_area_meters2)),
    source: "aggregated_structures",
    whole_roof_area_meters2: sumNullableNumbers(covered.map((structure) => structure.roof_area.whole_roof_area_meters2)),
    whole_roof_ground_area_meters2: sumNullableNumbers(covered.map((structure) => structure.roof_area.whole_roof_ground_area_meters2)),
    building_area_meters2: sumNullableNumbers(covered.map((structure) => structure.roof_area.building_area_meters2)),
    building_ground_area_meters2: sumNullableNumbers(covered.map((structure) => structure.roof_area.building_ground_area_meters2))
  };
}

function emptyRoofAreaSummary(): InstantRoofAreaSummary {
  return {
    total_roof_area_meters2: null,
    source: null,
    whole_roof_area_meters2: null,
    whole_roof_ground_area_meters2: null,
    building_area_meters2: null,
    building_ground_area_meters2: null
  };
}

function buildInstantBillingSummary(
  manifest: ProjectManifest,
  structures: InstantStructurePayload[]
): InstantBillingSummary {
  const amountCharged = toNullableNumber(manifest.amount_charged);
  const perStructureCharge = resolvePerStructureCharge(manifest, structures.length);
  const missingStructureCount = structures.filter((structure) => !structure.has_coverage).length;
  const refundableMissingStructureCount = structures.filter((structure) => (
    !structure.has_coverage && perStructureCharge != null && perStructureCharge > 0
  )).length;
  const refundableMissingAmount = perStructureCharge != null && refundableMissingStructureCount > 0
    ? perStructureCharge * refundableMissingStructureCount
    : null;

  for (const structure of structures) {
    const refundEligible = !structure.has_coverage && perStructureCharge != null && perStructureCharge > 0;
    structure.refund_eligible = refundEligible;
    structure.refund_amount = refundEligible ? perStructureCharge : null;
    structure.refund_state = refundEligible
      ? resolveRefundState(manifest)
      : "none";
  }

  return {
    amount_charged: amountCharged,
    per_structure_charge: perStructureCharge,
    missing_structure_count: missingStructureCount,
    refundable_missing_structure_count: refundableMissingStructureCount,
    refundable_missing_amount: refundableMissingAmount
  };
}

function sumNullableNumbers(values: Array<number | null>) {
  let sum = 0;
  let found = false;
  for (const value of values) {
    if (value == null) continue;
    sum += value;
    found = true;
  }
  return found ? sum : null;
}

function normalizePinsFromManifest(manifest: ProjectManifest) {
  if (!Array.isArray(manifest.pins)) {
    return [];
  }

  return manifest.pins
    .map((entry) => normalizePin(entry))
    .filter((value): value is LatLng => value !== null);
}

function normalizePin(value: unknown, fallback: LatLng | null = null): LatLng | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const latitude = toNullableNumber(record.latitude ?? record.lat);
    const longitude = toNullableNumber(record.longitude ?? record.lng);
    if (latitude != null && longitude != null) {
      return { latitude, longitude };
    }
  }
  return fallback;
}

function deriveCenterFromPins(pins: LatLng[]) {
  if (!pins.length) {
    return null;
  }

  const latitude = pins.reduce((sum, pin) => sum + pin.latitude, 0) / pins.length;
  const longitude = pins.reduce((sum, pin) => sum + pin.longitude, 0) / pins.length;
  return { latitude, longitude };
}

function deriveCenterFromStructures(structures: InstantStructurePayload[]) {
  const centers = structures
    .map((structure) => structure.center)
    .filter((value): value is LatLng => value !== null);
  return deriveCenterFromPins(centers);
}

function deriveBoundsFromStructures(
  structures: InstantStructurePayload[],
  key: "bounding_box" | "padded_bounding_box"
) {
  return unionLatLngBoxes(
    structures
      .map((structure) => structure[key])
      .filter((value): value is LatLngBox => value !== null)
  );
}

function unionLatLngBoxes(boxes: LatLngBox[]) {
  if (!boxes.length) {
    return null;
  }

  let minLat = Number.POSITIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;

  for (const bounds of boxes) {
    minLat = Math.min(minLat, bounds.sw.latitude);
    minLng = Math.min(minLng, bounds.sw.longitude);
    maxLat = Math.max(maxLat, bounds.ne.latitude);
    maxLng = Math.max(maxLng, bounds.ne.longitude);
  }

  return {
    sw: { latitude: minLat, longitude: minLng },
    ne: { latitude: maxLat, longitude: maxLng }
  };
}

function normalizeStructureLabel(value: unknown, index: number) {
  const text = String(value ?? "").trim().toUpperCase();
  return text || buildStructureLabel(index);
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

function normalizeCoverageStatus(status: unknown, hasCoverageFlag: unknown) {
  const text = String(status ?? "").trim().toLowerCase();
  if (text) {
    return text;
  }
  return Boolean(hasCoverageFlag) ? "ok" : "pending";
}

function normalizeCoverageMessage(note: unknown, coverageStatus: string, duplicateOfLabel: unknown) {
  const text = String(note ?? "").trim();
  if (text) {
    return text;
  }
  if (coverageStatus === "duplicate_match") {
    const label = String(duplicateOfLabel ?? "").trim().toUpperCase();
    return label
      ? `This selected pin resolved to the same solar structure as Structure ${label}, so it was excluded.`
      : "This selected pin resolved to a duplicate nearby solar structure, so it was excluded.";
  }
  if (coverageStatus === "no_coverage") {
    return "No usable instant data is available for this selected structure.";
  }
  if (coverageStatus === "error") {
    return "Instant data could not be retrieved for this selected structure.";
  }
  return null;
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

function resolvePerStructureCharge(manifest: ProjectManifest, structureCount: number) {
  if (!usesPerStructureInstantPricing(manifest) || structureCount < 1) {
    return null;
  }
  const amountCharged = toNullableNumber(manifest.amount_charged);
  if (amountCharged == null || amountCharged <= 0) {
    return null;
  }
  const amount = Math.round(amountCharged / structureCount);
  return amount > 0 ? amount : null;
}

function resolveRefundState(manifest: ProjectManifest): "pending" | "issued" | "none" {
  if (Boolean(manifest.refund_issued) && Number(manifest.refund_amount ?? 0) > 0) {
    return "issued";
  }
  if (Boolean(manifest.refund_pending) && Number(manifest.refund_amount ?? 0) > 0) {
    return "pending";
  }
  return "none";
}

function normalizeLatLng(value: unknown): LatLng | null {
  const record = asRecord(value);
  const latitude = toNullableNumber(record.latitude);
  const longitude = toNullableNumber(record.longitude);
  if (latitude == null || longitude == null) {
    return null;
  }
  return { latitude, longitude };
}

function normalizeLatLngFromManifest(manifest: ProjectManifest): LatLng | null {
  const latitude = toNullableNumber(manifest.lat);
  const longitude = toNullableNumber(manifest.lng);
  if (latitude == null || longitude == null) {
    return null;
  }
  return { latitude, longitude };
}

function normalizeLatLngBox(value: unknown): LatLngBox | null {
  const record = asRecord(value);
  const sw = normalizeLatLng(record.sw);
  const ne = normalizeLatLng(record.ne);
  if (!sw || !ne) {
    return null;
  }
  return { sw, ne };
}

function deriveBoundsFromSegments(value: unknown): LatLngBox | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  let minLat = Number.POSITIVE_INFINITY;
  let minLng = Number.POSITIVE_INFINITY;
  let maxLat = Number.NEGATIVE_INFINITY;
  let maxLng = Number.NEGATIVE_INFINITY;
  let found = false;

  for (const entry of value) {
    const bounds = normalizeLatLngBox(asRecord(entry).boundingBox);
    if (!bounds) continue;
    minLat = Math.min(minLat, bounds.sw.latitude);
    minLng = Math.min(minLng, bounds.sw.longitude);
    maxLat = Math.max(maxLat, bounds.ne.latitude);
    maxLng = Math.max(maxLng, bounds.ne.longitude);
    found = true;
  }

  if (!found) {
    return null;
  }

  return {
    sw: { latitude: minLat, longitude: minLng },
    ne: { latitude: maxLat, longitude: maxLng }
  };
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

function padLatLngBox(bounds: LatLngBox, paddingRatio: number): LatLngBox {
  const latSpan = Math.max(bounds.ne.latitude - bounds.sw.latitude, metersToLatitudeDegrees(2));
  const lngSpan = Math.max(
    bounds.ne.longitude - bounds.sw.longitude,
    metersToLongitudeDegrees(2, (bounds.ne.latitude + bounds.sw.latitude) / 2)
  );
  const latPad = latSpan * paddingRatio;
  const lngPad = lngSpan * paddingRatio;
  return {
    sw: {
      latitude: bounds.sw.latitude - latPad,
      longitude: bounds.sw.longitude - lngPad
    },
    ne: {
      latitude: bounds.ne.latitude + latPad,
      longitude: bounds.ne.longitude + lngPad
    }
  };
}

function normalizeBoxWithinBox(bounds: LatLngBox, extent: LatLngBox) {
  const width = extent.ne.longitude - extent.sw.longitude;
  const height = extent.ne.latitude - extent.sw.latitude;
  if (width <= 0 || height <= 0) {
    return null;
  }

  return {
    left: clamp01((bounds.sw.longitude - extent.sw.longitude) / width),
    right: clamp01((bounds.ne.longitude - extent.sw.longitude) / width),
    top: clamp01((extent.ne.latitude - bounds.ne.latitude) / height),
    bottom: clamp01((extent.ne.latitude - bounds.sw.latitude) / height)
  };
}

function latLngBoxToPoints(bounds: LatLngBox) {
  return [
    { label: "sw", latitude: bounds.sw.latitude, longitude: bounds.sw.longitude },
    { label: "se", latitude: bounds.sw.latitude, longitude: bounds.ne.longitude },
    { label: "ne", latitude: bounds.ne.latitude, longitude: bounds.ne.longitude },
    { label: "nw", latitude: bounds.ne.latitude, longitude: bounds.sw.longitude }
  ];
}

function firstDefinedDate(
  structures: InstantStructurePayload[],
  key: "imagery_date" | "imagery_processed_date"
) {
  for (const structure of structures) {
    if (structure[key]) {
      return structure[key];
    }
  }
  return null;
}

function normalizeDateParts(value: unknown) {
  const record = asRecord(value);
  const year = toNullableInt(record.year);
  if (year == null) {
    return null;
  }
  return {
    year,
    month: toNullableInt(record.month),
    day: toNullableInt(record.day)
  };
}

function metersToLatitudeDegrees(meters: number) {
  return meters / 111_320;
}

function metersToLongitudeDegrees(meters: number, latitude: number) {
  const cos = Math.cos((latitude * Math.PI) / 180);
  const safeCos = Math.max(Math.abs(cos), 0.000001);
  return meters / (111_320 * safeCos);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function toNullableNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toNullableInt(value: unknown) {
  const parsed = toNullableNumber(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
