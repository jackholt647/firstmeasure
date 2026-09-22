import { randomBytes } from "node:crypto";

import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";

const MODULE_ID = "labor_crews";
const DEFAULT_BRANCH_ID = "default";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function generatedId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

function nowIso() {
  return new Date().toISOString();
}

function moneyCents(value: unknown) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.round(number));
}

function boolFrom(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = cleanText(value).toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return fallback;
}

function normalizeCompensationPlan(value: unknown) {
  const input = asObject(value);
  const type = cleanText(input.type || input.pay_type || "hourly").toLowerCase();
  const existingPieceRates = asArray(input.piece_rates);
  const defaultHourly = Object.prototype.hasOwnProperty.call(input, "default_hourly")
    ? boolFrom(input.default_hourly)
    : type === "hourly" || type === "hybrid";
  const defaultSalary = Object.prototype.hasOwnProperty.call(input, "default_salary")
    ? boolFrom(input.default_salary)
    : type === "salary" || type === "hybrid";
  const defaultPieceRate = Object.prototype.hasOwnProperty.call(input, "default_piece_rate")
    ? boolFrom(input.default_piece_rate)
    : type === "piece_rate" || existingPieceRates.length > 0;
  const normalizedType = defaultHourly ? "hourly" : defaultSalary ? "salary" : defaultPieceRate ? "piece_rate" : "hourly";
  return {
    id: cleanText(input.id || generatedId("comp")),
    name: cleanText(input.name || "Default compensation"),
    type: normalizedType,
    default_hourly: defaultHourly,
    default_salary: defaultSalary,
    default_piece_rate: defaultPieceRate,
    hourly_rate_cents: moneyCents(input.hourly_rate_cents),
    salary_rate_cents: moneyCents(input.salary_rate_cents),
    salary_period: cleanText(input.salary_period || "week"),
    piece_rates: existingPieceRates.map((rate) => {
      const row = asObject(rate);
      return {
        id: cleanText(row.id || generatedId("piece")),
        label: cleanText(row.label || row.name || "Piece rate"),
        unit: cleanText(row.unit || "unit"),
        rate_cents: moneyCents(row.rate_cents)
      };
    }),
    notes: cleanText(input.notes)
  };
}

function normalizeRoleDefault(value: unknown) {
  const input = asObject(value);
  const id = cleanText(input.id || input.key || input.role || input.label || generatedId("role")).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || generatedId("role");
  const label = cleanText(input.label || input.name || id.replace(/_/g, " ")) || "Role";
  return {
    id,
    label,
    can_run_jobs: input.can_run_jobs === true,
    can_operate_vehicle: input.can_operate_vehicle === true,
    default_for_new_member: input.default_for_new_member === true,
    compensation_plan: normalizeCompensationPlan(input.compensation_plan || input.compensation || input.rate_schedule)
  };
}

function defaultRoleDefaults() {
  return [
    { id: "foreman", label: "Foreman", can_run_jobs: true, can_operate_vehicle: true, default_for_new_member: false, compensation_plan: normalizeCompensationPlan({ type: "hourly" }) },
    { id: "driver", label: "Driver", can_run_jobs: false, can_operate_vehicle: true, default_for_new_member: false, compensation_plan: normalizeCompensationPlan({ type: "hourly" }) },
    { id: "laborer", label: "Laborer", can_run_jobs: false, can_operate_vehicle: false, default_for_new_member: true, compensation_plan: normalizeCompensationPlan({ type: "hourly" }) }
  ];
}

function normalizeMember(value: unknown) {
  const input = asObject(value);
  const id = cleanText(input.id || input.user_id || input.email || generatedId("member"));
  const employmentType = cleanText(input.employment_type || input.worker_type || input.classification || "employee").toLowerCase();
  return {
    id,
    user_id: cleanText(input.user_id || id),
    name: cleanText(input.name || input.email || "Crew member"),
    email: cleanText(input.email).toLowerCase(),
    phone: cleanText(input.phone),
    employment_type: employmentType === "subcontractor" ? "subcontractor" : "employee",
    role: cleanText(input.role || "laborer"),
    is_foreman: input.is_foreman === true,
    compensation_plan: normalizeCompensationPlan(input.compensation_plan || input.compensation || input.rate_schedule),
    active: input.active !== false,
    added_at: cleanText(input.added_at || nowIso())
  };
}

function normalizeCrew(value: unknown) {
  const input = asObject(value);
  const id = cleanText(input.id || generatedId("crew"));
  const members = asArray(input.members).map(normalizeMember);
  const foremanId = cleanText(input.foreman_member_id || input.default_contact_member_id || members.find((member) => member.is_foreman)?.id || "");
  const employmentType = cleanText(input.employment_type || input.worker_type || input.classification || "employee").toLowerCase();
  return {
    id,
    name: cleanText(input.name || "Crew"),
    employment_type: employmentType === "subcontractor" ? "subcontractor" : "employee",
    status: cleanText(input.status || (input.archived_at ? "archived" : "active")) || "active",
    archived_at: cleanText(input.archived_at),
    archived_by: cleanText(input.archived_by),
    members: members.map((member) => ({ ...member, is_foreman: foremanId ? member.id === foremanId : member.is_foreman })),
    foreman_member_id: foremanId,
    default_contact_member_id: foremanId,
    project_types: asArray(input.project_types || input.capabilities).map(cleanText).filter(Boolean),
    attributes: asObject(input.attributes),
    compensation_plan: normalizeCompensationPlan(input.compensation_plan || input.rate_schedule),
    notes: cleanText(input.notes),
    created_at: cleanText(input.created_at || nowIso()),
    updated_at: cleanText(input.updated_at || nowIso())
  };
}

function normalizeSettings(data: unknown) {
  const input = asObject(data);
  const crews = asArray(input.crews).map(normalizeCrew);
  const customRoles = asArray(input.role_defaults || input.roles || input.crew_roles).map(normalizeRoleDefault);
  const roleMap = new Map(defaultRoleDefaults().map((role) => [role.id, role]));
  customRoles.forEach((role) => roleMap.set(role.id, role));
  const roleDefaults = [...roleMap.values()];
  if (!roleDefaults.some((role) => role.default_for_new_member)) {
    const laborer = roleDefaults.find((role) => role.id === "laborer");
    if (laborer) laborer.default_for_new_member = true;
  }
  return {
    schema_version: 1,
    terminology: {
      compensation_plan_label: "Compensation plan",
      compensation_plan_description: "Labor pay defaults for hourly, salary, and piece-rate crew compensation."
    },
    role_defaults: roleDefaults,
    crews,
    updated_at: cleanText(input.updated_at || nowIso())
  };
}

export async function loadLaborSettings(orgId: string, branchId = DEFAULT_BRANCH_ID) {
  try {
    const module = await readBranchModule(orgId, branchId || DEFAULT_BRANCH_ID, MODULE_ID);
    return { module, settings: normalizeSettings(module.data) };
  } catch {
    const settings = normalizeSettings({});
    const module = await saveBranchModule(orgId, branchId || DEFAULT_BRANCH_ID, MODULE_ID, {
      data: settings,
      metadata: { kind: "branch_labor_crews", source: "labor_api" }
    }, { replace: true });
    return { module, settings };
  }
}

export async function saveLaborSettings(orgId: string, branchId: string, input: unknown) {
  const settings = normalizeSettings({ ...asObject(input), updated_at: nowIso() });
  const module = await saveBranchModule(orgId, branchId || DEFAULT_BRANCH_ID, MODULE_ID, {
    data: settings,
    metadata: { kind: "branch_labor_crews", source: "labor_api" }
  }, { replace: true });
  return { module, settings: normalizeSettings(module.data) };
}

export async function upsertCrew(orgId: string, branchId: string, crewInput: unknown) {
  const { settings } = await loadLaborSettings(orgId, branchId);
  const crew = normalizeCrew({ ...asObject(crewInput), updated_at: nowIso() });
  const crews = asArray(settings.crews).map(normalizeCrew);
  const index = crews.findIndex((item) => item.id === crew.id);
  if (index >= 0) crews[index] = crew;
  else crews.push(crew);
  return await saveLaborSettings(orgId, branchId, { ...settings, crews });
}

export async function archiveCrew(orgId: string, branchId: string, crewId: string, actor: JsonObject = {}) {
  const { settings } = await loadLaborSettings(orgId, branchId);
  const now = nowIso();
  const crews = asArray(settings.crews).map((entry) => {
    const crew = normalizeCrew(entry);
    if (crew.id !== crewId) return crew;
    return {
      ...crew,
      status: "archived",
      archived_at: now,
      archived_by: cleanText(asObject(actor).email || asObject(actor).user_id),
      updated_at: now
    };
  });
  return await saveLaborSettings(orgId, branchId, { ...settings, crews });
}

export function activeCrews(settings: JsonObject) {
  return asArray(settings.crews).map(normalizeCrew).filter((crew) => crew.status !== "archived" && !crew.archived_at);
}
