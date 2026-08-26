export type ReportExpediteProjectType = "residential" | "commercial" | "multifamily";

export type ReportExpediteOption = {
  key: string;
  label: string;
  window_label: string;
  start_minutes: number | null;
  end_minutes: number | null;
  base_start_minutes: number | null;
  base_end_minutes: number | null;
  structure_count: number;
  additional_structure_minutes: number;
  due_window_start: string | null;
  due_window_end: string | null;
  production_deadline_minutes: number | null;
  production_deadline_at: string | null;
  estimated_wait_minutes?: number | null;
  busy_label?: string;
  residential_price: number;
  rush_delta: number;
  unit_price: number;
  expedited: boolean;
};

export const REPORT_EXPEDITE_STANDARD_KEY = "standard_3_6";
export const REPORT_EXPEDITE_UNDER_1_KEY = "rush_under_1";
export const REPORT_EXPEDITE_1_3_KEY = "rush_1_3";

const STANDARD_WAIT_DELAY_MINUTES = 60;
const EXPEDITE_FEE_PERCENT = 115;

type ReportExpediteDefinition = {
  key: string;
  label: string;
  startMinutes: number | null;
  endMinutes: number | null;
  productionDeadlineMinutes: number | null;
  expedited: boolean;
  legacyKeys?: string[];
};

const REPORT_EXPEDITE_DEFINITIONS: ReportExpediteDefinition[] = [
  { key: REPORT_EXPEDITE_STANDARD_KEY, label: "4-7 hrs", startMinutes: 240, endMinutes: 420, productionDeadlineMinutes: 240, expedited: false, legacyKeys: ["rush_3_4", "no_rush"] },
  { key: REPORT_EXPEDITE_UNDER_1_KEY, label: "Less than 1 hr rush", startMinutes: 50, endMinutes: 60, productionDeadlineMinutes: 50, expedited: true, legacyKeys: ["rush_1_2", "rush_1_1_5"] },
  { key: REPORT_EXPEDITE_1_3_KEY, label: "1-3 hr rush", startMinutes: 60, endMinutes: 180, productionDeadlineMinutes: 120, expedited: true, legacyKeys: ["rush_2_3"] }
];

const REPORT_EXPEDITE_ALIAS_KEYS = new Map(
  REPORT_EXPEDITE_DEFINITIONS.flatMap((option) => (option.legacyKeys || []).map((key) => [key, option.key] as const))
);

export function normalizeReportExpediteKey(key: unknown) {
  const raw = String(key ?? "").trim().toLowerCase();
  if (!raw) return REPORT_EXPEDITE_STANDARD_KEY;
  return REPORT_EXPEDITE_ALIAS_KEYS.get(raw) || raw;
}

export function normalizeReportExpediteProjectType(value: unknown): ReportExpediteProjectType {
  const key = String(value ?? "").trim().toLowerCase();
  if (key === "commercial" || key === "multifamily") return key;
  return "residential";
}

export function reportExpediteDefinition(key: unknown) {
  const normalized = normalizeReportExpediteKey(key);
  return REPORT_EXPEDITE_DEFINITIONS.find((option) => option.key === normalized) || null;
}

export function isReportExpediteOptionKey(key: unknown) {
  return !!reportExpediteDefinition(key);
}

export function isExpeditedReportExpediteKey(key: unknown) {
  return reportExpediteDefinition(key)?.expedited === true;
}

export function reportExpeditePriorityLevel(key: unknown, expeditedFallback = false) {
  const normalized = normalizeReportExpediteKey(key);
  if (normalized === REPORT_EXPEDITE_UNDER_1_KEY) return 1;
  if (normalized === REPORT_EXPEDITE_1_3_KEY) return 2;
  return expeditedFallback ? 2 : 3;
}

function roundCurrency(value: number) {
  return Math.round(value * 100) / 100;
}

function roundToDime(value: number) {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

type ReportExpeditePricing = {
  residentialPrice: number;
  rushDelta: number;
};

function previousRush13Delta(waitMinutes: number) {
  const busyRatio = clamp((waitMinutes - 240) / 180, 0, 1);
  return roundToDime(8 + busyRatio * 2) - 7;
}

function increasedExpediteFee(previousFee: number) {
  const previousFeeCents = Math.round(previousFee * 100);
  return Math.round(previousFeeCents * EXPEDITE_FEE_PERCENT / 100) / 100;
}

function reportExpeditePricingForWait(optionKey: unknown, waitMinutes: number): ReportExpeditePricing {
  const option = reportExpediteDefinition(optionKey);
  const key = option?.key || REPORT_EXPEDITE_STANDARD_KEY;
  const base = 7;
  if (key === REPORT_EXPEDITE_1_3_KEY) {
    const rushDelta = increasedExpediteFee(previousRush13Delta(waitMinutes));
    return {
      residentialPrice: roundCurrency(base + rushDelta),
      rushDelta
    };
  }
  if (key === REPORT_EXPEDITE_UNDER_1_KEY) {
    const rushDelta = increasedExpediteFee(previousRush13Delta(waitMinutes) * 3);
    return {
      residentialPrice: roundCurrency(base + rushDelta),
      rushDelta
    };
  }
  return {
    residentialPrice: base,
    rushDelta: 0
  };
}

export function reportExpediteBaseUnitPrice(projectType: unknown, optionKey: unknown, waitMinutes = 180) {
  const type = normalizeReportExpediteProjectType(projectType);
  const standardBase = type === "commercial" || type === "multifamily" ? 12 : 7;
  const pricing = reportExpeditePricingForWait(optionKey, waitMinutes);
  return type === "commercial" || type === "multifamily"
    ? roundCurrency(standardBase * (pricing.residentialPrice / 7))
    : pricing.residentialPrice;
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60_000);
}

function normalizeStructureCount(value: unknown) {
  const count = Math.round(Number(value));
  return Number.isFinite(count) && count > 0 ? count : 1;
}

function expediteAdditionalStructureMinutes(projectType: ReportExpediteProjectType, option: ReportExpediteDefinition, structureCount: number) {
  if (projectType !== "commercial" && projectType !== "multifamily") return 0;
  return Math.max(0, structureCount - 1) * 30;
}

function formatTurnaroundTime(date: Date) {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Los_Angeles"
  });
}

function pacificDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute")
  };
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed: string) {
  return hashString(seed) / 0xffffffff;
}

function seededRange(seed: string, min: number, max: number) {
  return min + seededUnit(seed) * (max - min);
}

function smoothstep(value: number) {
  const x = clamp(value, 0, 1);
  return x * x * (3 - 2 * x);
}

function roundedToTenMinutes(minutes: number) {
  return Math.round(minutes / 10) * 10;
}

function estimatedStandardWait(now: Date) {
  const pacific = pacificDateParts(now);
  const dateSeed = `${pacific.year}-${String(pacific.month).padStart(2, "0")}-${String(pacific.day).padStart(2, "0")}`;
  const minutesSinceMidnight = pacific.hour * 60 + pacific.minute;
  const tenMinuteSlot = Math.floor(minutesSinceMidnight / 10);
  const hour = minutesSinceMidnight / 60;
  const dailyBias = seededRange(`${dateSeed}:bias`, -8, 8);
  const slotNoise = seededRange(`${dateSeed}:slot:${tenMinuteSlot}`, -1, 1);
  const waveA = Math.sin((tenMinuteSlot * 0.62) + seededRange(`${dateSeed}:phase:a`, 0, Math.PI * 2));
  const waveB = Math.sin((tenMinuteSlot * 1.17) + seededRange(`${dateSeed}:phase:b`, 0, Math.PI * 2));
  const noise = dailyBias + slotNoise * 8 + waveA * 10 + waveB * 5;
  let target = 180;

  if (hour < 6) {
    target = 180;
  } else if (hour < 10) {
    const progress = smoothstep((hour - 6) / 4);
    target = 180 + progress * 120 + noise * progress;
  } else if (hour < 14) {
    target = 285 + clamp(noise, -15, 15);
  } else if (hour < 17) {
    const progress = smoothstep((hour - 14) / 3);
    target = 285 - progress * 105 + noise * (1 - progress);
  } else {
    target = 180;
  }

  const loadWait = roundedToTenMinutes(clamp(target, 180, 360));
  const wait = loadWait + STANDARD_WAIT_DELAY_MINUTES;
  const busyLabel = loadWait >= 300
    ? "We are very busy"
    : (loadWait >= 225 ? "We are slightly busy" : "We aren't very busy");
  return { wait, busyLabel };
}

export function buildReportExpediteOptions(input: {
  projectType?: unknown;
  structureCount?: unknown;
  now?: Date;
} = {}) {
  const projectType = normalizeReportExpediteProjectType(input.projectType);
  const structureCount = normalizeStructureCount(input.structureCount);
  const now = input.now || new Date();
  const generatedAt = now.toISOString();
  const standardWait = estimatedStandardWait(now);
  const options = REPORT_EXPEDITE_DEFINITIONS.map((option): ReportExpediteOption => {
    const pricing = reportExpeditePricingForWait(option.key, standardWait.wait);
    const additionalMinutes = expediteAdditionalStructureMinutes(projectType, option, structureCount);
    const startMinutes = option.startMinutes == null ? null : option.startMinutes + additionalMinutes;
    const endMinutes = option.key === "standard_3_6"
      ? standardWait.wait + additionalMinutes
      : (option.endMinutes == null ? null : option.endMinutes + additionalMinutes);
    const productionDeadlineMinutes = option.productionDeadlineMinutes == null ? null : option.productionDeadlineMinutes + additionalMinutes;
    const start = startMinutes == null ? null : addMinutes(now, startMinutes);
    const end = endMinutes == null ? null : addMinutes(now, endMinutes);
    const productionDeadline = productionDeadlineMinutes == null ? null : addMinutes(now, productionDeadlineMinutes);
    const windowLabel = option.key === "no_rush" || !start || !end
      ? "No Rush"
      : `${formatTurnaroundTime(start)} - ${formatTurnaroundTime(end)}`;
    return {
      key: option.key,
      label: option.label,
      window_label: windowLabel,
      start_minutes: startMinutes,
      end_minutes: endMinutes,
      base_start_minutes: option.startMinutes,
      base_end_minutes: option.endMinutes,
      structure_count: structureCount,
      additional_structure_minutes: additionalMinutes,
      due_window_start: start ? start.toISOString() : null,
      due_window_end: end ? end.toISOString() : null,
      production_deadline_minutes: productionDeadlineMinutes,
      production_deadline_at: productionDeadline ? productionDeadline.toISOString() : null,
      estimated_wait_minutes: option.key === "standard_3_6" ? standardWait.wait + additionalMinutes : null,
      busy_label: option.key === "standard_3_6" ? standardWait.busyLabel : "",
      residential_price: pricing.residentialPrice,
      rush_delta: pricing.rushDelta,
      unit_price: reportExpediteBaseUnitPrice(projectType, option.key, standardWait.wait),
      expedited: option.expedited
    };
  });
  return {
    ok: true,
    success: true,
    algorithm: "wait_linked_v1",
    generated_at: generatedAt,
    project_type: projectType,
    structure_count: structureCount,
    options
  };
}
