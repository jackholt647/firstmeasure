import { buildReportExpediteOptions, normalizeReportExpediteKey, reportExpediteBaseUnitPrice } from "./expedite.js";

export type FirstMeasureReportPricingInput = {
  project_type?: unknown;
  report_mode?: unknown;
  report_expedite_option?: unknown;
  include_gutter_measurements?: unknown;
  include_weather_report?: unknown;
  pins?: unknown;
};

export type FirstMeasureReportChargeInput = FirstMeasureReportPricingInput & {
  free_expedite_uses?: unknown;
};

function text(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function enabled(value: unknown) {
  if (value === true || value === 1) return true;
  return ["1", "true", "yes", "on"].includes(text(value));
}

function money(value: number) {
  return Math.round(value * 100) / 100;
}

function projectType(value: unknown) {
  const normalized = text(value);
  return normalized === "commercial" || normalized === "multifamily" ? normalized : "residential";
}

function reportMode(value: unknown) {
  const normalized = text(value);
  return normalized === "instant" || normalized === "both" ? normalized : "full";
}

function pinCount(value: unknown) {
  return Math.max(1, Array.isArray(value) ? value.length : 1);
}

function standardWaitMinutes(type: string, structures: number) {
  const quote = buildReportExpediteOptions({ projectType: type, structureCount: structures });
  return Number(quote.options.find((option) => option.key === "standard_3_6")?.estimated_wait_minutes ?? 180);
}

export function firstMeasureInstantAddon(value: unknown) {
  const type = projectType(value);
  return type === "commercial" || type === "multifamily" ? 4 : 2;
}

export function firstMeasureReportAmount(input: FirstMeasureReportPricingInput) {
  const type = projectType(input.project_type);
  const mode = reportMode(input.report_mode);
  const structures = pinCount(input.pins);
  const waitMinutes = standardWaitMinutes(type, structures);
  const expediteKey = normalizeReportExpediteKey(input.report_expedite_option);
  const baseUnit = reportExpediteBaseUnitPrice(type, expediteKey, waitMinutes);
  const instantUnit = mode === "instant" || mode === "both" ? firstMeasureInstantAddon(type) : 0;
  const reportUnit = baseUnit + instantUnit;
  const report = type === "commercial" || type === "multifamily" ? reportUnit * structures : reportUnit;
  // Gutter measurements are a flat residential add-on in the customer portal.
  const gutters = type === "residential" && enabled(input.include_gutter_measurements) ? 2 : 0;
  const weather = enabled(input.include_weather_report) ? 5 * structures : 0;
  return money(report + gutters + weather);
}

export function firstMeasureReportExpediteDiscount(input: FirstMeasureReportPricingInput) {
  const type = projectType(input.project_type);
  const structures = pinCount(input.pins);
  const waitMinutes = standardWaitMinutes(type, structures);
  const standard = reportExpediteBaseUnitPrice(type, "standard_3_6", waitMinutes);
  const rushed = reportExpediteBaseUnitPrice(type, normalizeReportExpediteKey(input.report_expedite_option), waitMinutes);
  const unitDiscount = Math.max(0, money(rushed - standard));
  return money(type === "commercial" || type === "multifamily" ? unitDiscount * structures : unitDiscount);
}

export function firstMeasureReportCharge(input: FirstMeasureReportChargeInput) {
  const gross = firstMeasureReportAmount(input);
  const freeExpediteUses = Math.max(0, Math.round(Number(input.free_expedite_uses) || 0));
  const expediteDiscount = freeExpediteUses > 0 ? firstMeasureReportExpediteDiscount(input) : 0;
  return {
    gross_amount: gross,
    amount: money(Math.max(0.01, gross - expediteDiscount)),
    free_expedite_discount: expediteDiscount,
    free_expedite_applied: expediteDiscount > 0,
    free_expedite_uses_before: freeExpediteUses
  };
}
