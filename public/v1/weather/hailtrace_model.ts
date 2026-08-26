import { round } from "./math.js";
import type { GeoPoint, WeatherModeledHistoryEvent, WeatherRecord } from "./types.js";

const CONVECTIVE_DAY_OFFSET_MS = 12 * 60 * 60 * 1000;
const HAIL_RADAR_NEAR_MILES = 2.25;
const HAIL_LSR_NEAR_MILES = 4;
const HAIL_LSR_MODERATE_NEAR_MILES = 6;
const WIND_NEAR_MILES = 8;

type Peril = WeatherModeledHistoryEvent["event_type"];

type ModeledEvidence = {
  record: WeatherRecord;
  date: string;
  peril: Peril;
  observedAt: Date | null;
  magnitude: number | null;
  unit: string | null;
  distanceMiles: number | null;
  sourceClass: "radar" | "mrms" | "lsr" | "warning";
  basis: string;
};

type EvidenceGroup = {
  date: string;
  peril: Peril;
  evidence: ModeledEvidence[];
};

export function buildHailTraceStyleHistory(property: GeoPoint, records: WeatherRecord[]): WeatherModeledHistoryEvent[] {
  const evidence = records.flatMap((record) => evidenceFromRecord(record)).filter((item) => item.date !== "unknown");
  const grouped = groupEvidence(evidence);
  const candidates = grouped
    .map((group) => summarizeModeledGroup(group))
    .filter((candidate): candidate is WeatherModeledHistoryEvent & { score: number } => candidate != null);

  return resolveSameDayPerils(candidates)
    .sort((a, b) => b.date.localeCompare(a.date) || eventWeight(b.event_type) - eventWeight(a.event_type))
    .map(({ score: _score, ...event }) => event);
}

function evidenceFromRecord(record: WeatherRecord): ModeledEvidence[] {
  const observedAt = parseObservedAt(record.observed_at);
  const date = convectiveDate(observedAt);
  const evidence: ModeledEvidence[] = [];
  const dataset = record.dataset.toLowerCase();
  const eventType = String(record.event_type ?? "").toLowerCase();
  const haystack = `${dataset} ${eventType} ${JSON.stringify(record.raw)}`.toLowerCase();
  const distanceMiles = record.distance_miles ?? null;

  const hailMagnitude = hailMagnitudeForRecord(record);
  if (
    hailMagnitude != null
    && (dataset === "nx3hail" || dataset === "mrms_mesh" || eventType.includes("hail") || record.raw.hailtag || record.raw.max_hail_size)
  ) {
    evidence.push({
      record,
      date,
      peril: "Hail",
      observedAt,
      magnitude: hailMagnitude,
      unit: "in",
      distanceMiles,
      sourceClass: dataset === "mrms_mesh" ? "mrms" : dataset === "nx3hail" ? "radar" : dataset === "iem_warning" || dataset === "warn" ? "warning" : "lsr",
      basis: basisLabel(record, "hail", hailMagnitude, "in")
    });
  }

  const windMagnitude = windMagnitudeForRecord(record);
  if (windMagnitude != null || haystack.includes("wind") || haystack.includes("wnd") || record.raw.windtag) {
    evidence.push({
      record,
      date,
      peril: "Wind",
      observedAt,
      magnitude: windMagnitude,
      unit: "mph",
      distanceMiles,
      sourceClass: dataset === "iem_warning" || dataset === "warn" ? "warning" : "lsr",
      basis: basisLabel(record, "wind", windMagnitude, "mph")
    });
  }

  if (haystack.includes("tornado")) {
    evidence.push({
      record,
      date,
      peril: "Tornado",
      observedAt,
      magnitude: record.magnitude ?? null,
      unit: record.magnitude_unit ?? null,
      distanceMiles,
      sourceClass: dataset === "iem_warning" || dataset === "warn" ? "warning" : "lsr",
      basis: basisLabel(record, "tornado", record.magnitude ?? null, record.magnitude_unit ?? null)
    });
  }

  return evidence;
}

function groupEvidence(evidence: ModeledEvidence[]): EvidenceGroup[] {
  const groups = new Map<string, EvidenceGroup>();
  for (const item of evidence) {
    const key = `${item.date}|${item.peril}`;
    const group = groups.get(key) ?? { date: item.date, peril: item.peril, evidence: [] };
    group.evidence.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function summarizeModeledGroup(group: EvidenceGroup): (WeatherModeledHistoryEvent & { score: number }) | null {
  if (group.peril === "Hail") return summarizeHailGroup(group);
  if (group.peril === "Wind") return summarizeWindGroup(group);
  return null;
}

function summarizeHailGroup(group: EvidenceGroup): (WeatherModeledHistoryEvent & { score: number }) | null {
  const radar = group.evidence.filter((item) => item.sourceClass === "radar" || item.sourceClass === "mrms");
  const lsr = group.evidence.filter((item) => item.sourceClass === "lsr");
  const warnings = group.evidence.filter((item) => item.sourceClass === "warning");
  const nearestRadar = minDistance(radar);
  const nearestLsr = minDistance(lsr);
  const groupMaxMagnitude = maxEvidenceMagnitude(group.evidence);
  const maxNearRadarMagnitude = maxEvidenceMagnitude(radar.filter((item) => item.distanceMiles != null && item.distanceMiles <= HAIL_RADAR_NEAR_MILES));
  const maxLsrMagnitude = maxEvidenceMagnitude(lsr);
  const maxWarningMagnitude = maxEvidenceMagnitude(warnings);
  const radarQualifies = radar.length > 0 && nearestRadar != null && nearestRadar <= HAIL_RADAR_NEAR_MILES && (maxNearRadarMagnitude ?? 0) >= 0.75;
  const lsrNearQualifies = lsr.length > 0 && nearestLsr != null && nearestLsr <= HAIL_LSR_NEAR_MILES && (maxLsrMagnitude ?? 0) >= 1;
  const lsrModerateQualifies = lsr.length >= 2 && nearestLsr != null && nearestLsr <= HAIL_LSR_MODERATE_NEAR_MILES && (maxLsrMagnitude ?? 0) >= 1.25;
  const warningQualifies = warnings.length > 0 && (maxWarningMagnitude ?? 0) >= 1 && warningTouchesProperty(warnings);
  if (!radarQualifies && !lsrNearQualifies && !lsrModerateQualifies && !warningQualifies) return null;

  const score =
    (radarQualifies ? 45 : 0)
    + (lsrNearQualifies ? 35 : 0)
    + (lsrModerateQualifies ? 20 : 0)
    + (warningQualifies ? 18 : 0)
    + Math.min(20, group.evidence.length)
    + (groupMaxMagnitude ?? 0) * 6
    - Math.max(0, (minDistance(group.evidence) ?? 12) - 2) * 2;

  return {
    date: group.date,
    event_type: "Hail",
    duration_minutes: durationMinutes(group.evidence),
    magnitude: modeledHailMagnitude(group.evidence),
    magnitude_unit: "in",
    basis: compactBasis(group.evidence),
    score: round(score, 2) ?? score
  };
}

function summarizeWindGroup(group: EvidenceGroup): (WeatherModeledHistoryEvent & { score: number }) | null {
  const lsr = group.evidence.filter((item) => item.sourceClass === "lsr");
  const warnings = group.evidence.filter((item) => item.sourceClass === "warning");
  const maxWind = maxEvidenceMagnitude(group.evidence);
  const nearest = minDistance(group.evidence);
  const warningWindQualifies = warnings.some((item) => (item.magnitude ?? 0) >= 58 && warningTouchesProperty([item]));
  const measuredWindQualifies = (maxWind ?? 0) >= 58 && (warningWindQualifies || (nearest != null && nearest <= 1 && lsr.length >= 4));
  const damageClusterQualifies = warningWindQualifies && lsr.length >= 3 && nearest != null && nearest <= WIND_NEAR_MILES;
  if (!measuredWindQualifies && !damageClusterQualifies && !warningWindQualifies) return null;

  const score =
    (measuredWindQualifies ? 40 : 0)
    + (damageClusterQualifies ? 24 : 0)
    + (warningWindQualifies ? 22 : 0)
    + Math.min(20, group.evidence.length)
    + Math.max(0, (maxWind ?? 50) - 50) * 0.8
    - Math.max(0, (nearest ?? 12) - 3) * 1.5;

  return {
    date: group.date,
    event_type: "Wind",
    duration_minutes: durationMinutes(group.evidence),
    magnitude: round(maxWind, 0),
    magnitude_unit: "mph",
    basis: compactBasis(group.evidence),
    score: round(score, 2) ?? score
  };
}

function resolveSameDayPerils(events: Array<WeatherModeledHistoryEvent & { score: number }>) {
  const byDate = new Map<string, Array<WeatherModeledHistoryEvent & { score: number }>>();
  for (const event of events) {
    const list = byDate.get(event.date) ?? [];
    list.push(event);
    byDate.set(event.date, list);
  }
  const resolved: Array<WeatherModeledHistoryEvent & { score: number }> = [];
  for (const list of byDate.values()) {
    const hail = list.find((event) => event.event_type === "Hail");
    const wind = list.find((event) => event.event_type === "Wind");
    if (hail && wind) {
      const hailIsSubstantial = (hail.magnitude ?? 0) >= 1 || hail.basis.some((item) => item.includes("radar") || item.includes("mrms") || item.includes("lsr"));
      const windDominates = (wind.magnitude ?? 0) >= 70 && (hail.magnitude ?? 0) < 1;
      resolved.push(hailIsSubstantial && !windDominates ? hail : wind);
      continue;
    }
    resolved.push(...list);
  }
  return resolved;
}

function modeledHailMagnitude(evidence: ModeledEvidence[]) {
  const propertyEvidence = evidence
    .filter((item) => item.distanceMiles == null || item.distanceMiles <= 3 || item.sourceClass === "warning")
    .map((item) => item.magnitude)
    .filter((value): value is number => value != null);
  const values = propertyEvidence.length ? propertyEvidence : evidence.map((item) => item.magnitude).filter((value): value is number => value != null);
  if (!values.length) return null;
  const max = Math.max(...values);
  if (max < 1) return 0.75;
  return round(max, 2);
}

function hailMagnitudeForRecord(record: WeatherRecord) {
  const rawMagnitude = readNumber(record.raw.hailtag)
    ?? readNumber(record.raw.issue_hailtag)
    ?? readNumber(record.raw.max_hail_size)
    ?? readNumber(record.raw.MAXSIZE)
    ?? readNumber(record.raw.maxsize);
  if (rawMagnitude != null) return rawMagnitude;
  if (record.magnitude != null && (record.magnitude_unit === "in" || record.magnitude_unit == null)) return record.magnitude;
  return null;
}

function windMagnitudeForRecord(record: WeatherRecord) {
  const rawMagnitude = readNumber(record.raw.windtag)
    ?? readNumber(record.raw.issue_windtag)
    ?? readNumber(record.raw.max_wind_gust);
  if (rawMagnitude != null) return rawMagnitude;
  if (record.magnitude != null && record.magnitude_unit === "mph") return record.magnitude;
  return null;
}

function warningTouchesProperty(evidence: ModeledEvidence[]) {
  return evidence.some((item) => {
    const raw = item.record.raw;
    if (raw.property_in_polygon === "true" || raw.mentions_address_city === "true") return true;
    const polygonDistance = readNumber(raw.polygon_nearest_distance_miles);
    return polygonDistance != null && polygonDistance <= 2;
  });
}

function durationMinutes(evidence: ModeledEvidence[]) {
  const dates = evidence.map((item) => item.observedAt).filter((value): value is Date => value != null);
  if (dates.length < 2) return null;
  const start = Math.min(...dates.map((date) => date.getTime()));
  const end = Math.max(...dates.map((date) => date.getTime()));
  const minutes = Math.round((end - start) / 60_000);
  return minutes > 0 ? minutes : null;
}

function compactBasis(evidence: ModeledEvidence[]) {
  return evidence
    .sort((a, b) => sourceWeight(b.sourceClass) - sourceWeight(a.sourceClass) || (b.magnitude ?? 0) - (a.magnitude ?? 0))
    .map((item) => item.basis)
    .filter((value, index, all) => all.indexOf(value) === index)
    .slice(0, 8);
}

function basisLabel(record: WeatherRecord, peril: string, magnitude: number | null, unit: string | null) {
  const source = record.dataset === "nx3hail" ? "radar" : record.dataset === "mrms_mesh" ? "mrms" : record.dataset === "iem_warning" || record.dataset === "warn" ? "warning" : "lsr";
  const distance = record.distance_miles != null ? ` ${record.distance_miles} mi` : "";
  const value = magnitude != null ? ` ${magnitude}${unit === "in" ? "\"" : unit ? ` ${unit}` : ""}` : "";
  return `${source} ${peril}${value}${distance}`.trim();
}

function parseObservedAt(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function convectiveDate(date: Date | null) {
  if (!date) return "unknown";
  return new Date(date.getTime() - CONVECTIVE_DAY_OFFSET_MS).toISOString().slice(0, 10);
}

function minDistance(evidence: ModeledEvidence[]) {
  const distances = evidence.map((item) => item.distanceMiles).filter((value): value is number => value != null);
  return distances.length ? Math.min(...distances) : null;
}

function maxEvidenceMagnitude(evidence: ModeledEvidence[]) {
  const values = evidence.map((item) => item.magnitude).filter((value): value is number => value != null);
  return values.length ? Math.max(...values) : null;
}

function readNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sourceWeight(source: ModeledEvidence["sourceClass"]) {
  if (source === "mrms") return 4;
  if (source === "radar") return 3;
  if (source === "lsr") return 2;
  return 1;
}

function eventWeight(type: Peril) {
  if (type === "Hail") return 4;
  if (type === "Wind") return 3;
  if (type === "Tornado") return 2;
  return 1;
}
