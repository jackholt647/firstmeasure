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

function normalizeCompensationPlan(value: unknown) {
  const input = asObject(value);
  const type = cleanText(input.type || input.pay_type || "hourly").toLowerCase();
  return {
    id: cleanText(input.id || generatedId("comp")),
    name: cleanText(input.name || "Default compensation"),
    type: ["hourly", "piece_rate", "salary", "hybrid"].includes(type) ? type : "hourly",
    hourly_rate_cents: moneyCents(input.hourly_rate_cents),
    salary_rate_cents: moneyCents(input.salary_rate_cents),
    salary_period: cleanText(input.salary_period || "week"),
    piece_rates: asArray(input.piece_rates).map((rate) => {
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

function normalizeMember(value: unknown) {
  const input = asObject(value);
  const id = cleanText(input.id || input.user_id || input.email || generatedId("member"));
  return {
    id,
    user_id: cleanText(input.user_id || id),
    name: cleanText(input.name || input.email || "Crew member"),
    email: cleanText(input.email).toLowerCase(),
    phone: cleanText(input.phone),
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
  return {
    id,
    name: cleanText(input.name || "Crew"),
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
  return {
    schema_version: 1,
    terminology: {
      compensation_plan_label: "Compensation plan",
      compensation_plan_description: "Labor pay rules for hourly, piece-rate, salary, or hybrid crew compensation."
    },
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
  const crews = asArray(settings.crews).filter((item) => cleanText(asObject(item).id) !== crew.id);
  crews.push(crew);
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
