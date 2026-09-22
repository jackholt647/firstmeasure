import { randomBytes } from "node:crypto";

import { badRequest } from "../platform/errors.js";
import {
  compensationProfileInputSchema,
  type CompensationComponent,
  type CompensationProfileInput,
  type CompensationSubjectType
} from "./schemas.js";

export type JsonObject = Record<string, unknown>;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function boolValue(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = cleanText(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return fallback;
}

function cents(value: unknown) {
  const amount = Number(value);
  return Number.isFinite(amount) ? Math.max(0, Math.round(amount)) : 0;
}

function generatedComponentId(kind: string) {
  return `${kind}_${randomBytes(6).toString("hex")}`;
}

function uniqueIds(value: unknown) {
  return [...new Set((Array.isArray(value) ? value : []).map(cleanText).filter(Boolean))];
}

function normalizeCanonicalComponent(value: unknown, index: number): CompensationComponent {
  const input = asObject(value);
  const rawKind = cleanText(input.kind || input.type).toLowerCase();
  const kind = rawKind === "piece" ? "piece_rate" : rawKind;
  if (!["hourly", "salary", "piece_rate"].includes(kind)) {
    throw badRequest("invalid_compensation_component", `Compensation component ${index + 1} has an unsupported kind.`);
  }
  return {
    ...input,
    id: cleanText(input.id) || generatedComponentId(kind),
    kind: kind as CompensationComponent["kind"],
    label: cleanText(input.label || (kind === "piece_rate" ? "Piece rate" : kind === "salary" ? "Salary" : "Hourly")),
    rate_cents: cents(input.rate_cents),
    period: cleanText(input.period || (kind === "salary" ? "week" : kind === "hourly" ? "hour" : "")),
    ...(kind === "salary" && Number(input.hours_per_period) > 0 ? { hours_per_period: Number(input.hours_per_period) } : {}),
    ...(kind === "salary" && Number.isFinite(Number(input.hourly_equivalent_rate_cents)) ? { hourly_equivalent_rate_cents: cents(input.hourly_equivalent_rate_cents) } : {}),
    unit: cleanText(input.unit || (kind === "piece_rate" ? "unit" : "")),
    capability_scope_ids: uniqueIds(input.capability_scope_ids || input.scope_ids),
    metadata: asObject(input.metadata)
  };
}

function componentsFromLegacy(input: CompensationProfileInput) {
  const type = cleanText(input.type || "").toLowerCase();
  const hourlyEnabled = input.default_hourly === true || type === "hourly" || type === "hybrid";
  const salaryEnabled = input.default_salary === true || type === "salary" || type === "hybrid";
  const pieceRates = Array.isArray(input.piece_rates) ? input.piece_rates : [];
  const pieceEnabled = input.default_piece_rate === true || type === "piece_rate" || type === "hybrid" || pieceRates.length > 0;
  const components: CompensationComponent[] = [];
  if (hourlyEnabled || input.hourly_rate_cents !== undefined) {
    components.push(normalizeCanonicalComponent({ kind: "hourly", rate_cents: cents(input.hourly_rate_cents), period: "hour" }, components.length));
  }
  if (salaryEnabled || input.salary_rate_cents !== undefined) {
    components.push(normalizeCanonicalComponent({ kind: "salary", rate_cents: cents(input.salary_rate_cents), period: cleanText(input.salary_period || "week") }, components.length));
  }
  if (pieceEnabled && pieceRates.length === 0) {
    components.push(normalizeCanonicalComponent({ kind: "piece_rate", rate_cents: 0, unit: "unit" }, components.length));
  }
  for (const rate of pieceRates) {
    const row = asObject(rate);
    components.push(normalizeCanonicalComponent({
      ...row,
      kind: "piece_rate",
      rate_cents: cents(row.rate_cents),
      label: cleanText(row.label || row.name || "Piece rate"),
      unit: cleanText(row.unit || "unit")
    }, components.length));
  }
  return components;
}

export function normalizeCompensationProfileInput(value: unknown) {
  const parsed = compensationProfileInputSchema.parse(value ?? {});
  const components = Array.isArray(parsed.components)
    ? parsed.components.map(normalizeCanonicalComponent)
    : componentsFromLegacy(parsed);
  const componentIds = new Set<string>();
  for (const component of components) {
    const id = cleanText(component.id);
    if (componentIds.has(id)) throw badRequest("duplicate_compensation_component", `Compensation component '${id}' is duplicated.`);
    componentIds.add(id);
  }
  return {
    name: cleanText(parsed.name || "Compensation profile") || "Compensation profile",
    status: parsed.status || "active",
    currency: cleanText(parsed.currency || "USD").toUpperCase() || "USD",
    effective_from: cleanText(parsed.effective_from),
    effective_to: cleanText(parsed.effective_to),
    components,
    notes: cleanText(parsed.notes),
    metadata: asObject(parsed.metadata),
    ...(Number(parsed.expected_revision || 0) > 0 ? { expected_revision: Number(parsed.expected_revision) } : {})
  };
}

export function assertCompensationAllowed(subjectType: CompensationSubjectType, profile: { components: CompensationComponent[] }) {
  if (subjectType === "organization_connection" && profile.components.some((component) => component.kind === "salary")) {
    throw badRequest("connection_salary_not_allowed", "Organization connections cannot use salary compensation components.");
  }
}

export function compensationPlanProjection(profileValue: unknown) {
  const profile = asObject(profileValue);
  const components = Array.isArray(profile.components) ? profile.components.map(asObject) : [];
  const hourly = components.find((component) => cleanText(component.kind) === "hourly");
  const salary = components.find((component) => cleanText(component.kind) === "salary");
  const pieces = components.filter((component) => cleanText(component.kind) === "piece_rate");
  const enabledKinds = [hourly ? "hourly" : "", salary ? "salary" : "", pieces.length ? "piece_rate" : ""].filter(Boolean);
  return {
    id: cleanText(profile.id),
    name: cleanText(profile.name || "Compensation profile"),
    type: enabledKinds.length > 1 ? "hybrid" : enabledKinds[0] || "none",
    default_hourly: !!hourly,
    default_salary: !!salary,
    default_piece_rate: pieces.length > 0,
    hourly_rate_cents: cents(hourly?.rate_cents),
    salary_rate_cents: cents(salary?.rate_cents),
    salary_period: cleanText(salary?.period || "week"),
    salary_hours_per_period: Number(salary?.hours_per_period || 0),
    salary_hourly_equivalent_rate_cents: cents(salary?.hourly_equivalent_rate_cents),
    piece_rates: pieces.map((piece) => ({
      id: cleanText(piece.id),
      label: cleanText(piece.label || "Piece rate"),
      unit: cleanText(piece.unit || "unit"),
      rate_cents: cents(piece.rate_cents),
      capability_scope_ids: uniqueIds(piece.capability_scope_ids)
    })),
    notes: cleanText(profile.notes),
    currency: cleanText(profile.currency || "USD")
  };
}

export function effectiveCompensation(directValue: unknown, groupValue: unknown) {
  const direct = asObject(directValue);
  const group = asObject(groupValue);
  if (cleanText(direct.id) && cleanText(direct.status || "active") === "active") {
    return { profile: direct, source: "organization_user" as const };
  }
  if (cleanText(group.id) && cleanText(group.status || "active") === "active") {
    return { profile: group, source: "resource_group" as const };
  }
  return { profile: null, source: null };
}

export function compensationInputPresent(value: unknown) {
  const input = asObject(value);
  return Object.keys(input).length > 0 && boolValue(input.remove, false) !== true;
}
