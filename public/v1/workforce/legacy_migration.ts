import type { JsonObject } from "../compensation/service.js";
import { createOrganizationConnection, patchOrganizationConnection, readOrganizationConnection } from "../connections/storage.js";
import { readBranchModule, readDocument } from "../platform/storage.js";
import {
  createResourceGroup,
  organizationConnectionRecordExists,
  patchResourceGroup,
  readResourceGroup,
  resourceGroupRecordExists
} from "./storage.js";

const migrations = new Map<string, Promise<void>>();

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

async function existingUserMemberships(orgId: string, crew: JsonObject) {
  const foremanId = cleanText(crew.foreman_member_id || crew.default_contact_member_id);
  const memberships: JsonObject[] = [];
  for (const value of asArray(crew.members)) {
    const member = asObject(value);
    const userId = cleanText(member.user_id || member.id);
    if (!userId || member.active === false) continue;
    const user = await readDocument(orgId, "users", userId).catch(() => null);
    if (!user || cleanText(asObject(user.data).status) === "disabled") continue;
    memberships.push({
      user_id: userId,
      role: cleanText(member.role || "member"),
      is_lead: member.is_foreman === true || cleanText(member.id) === foremanId,
      status: "active"
    });
  }
  return memberships;
}

function legacyContacts(crew: JsonObject) {
  return asArray(crew.members).map((value, index) => {
    const member = asObject(value);
    return {
      id: cleanText(member.id) || `contact_${index + 1}`,
      name: cleanText(member.name),
      email: cleanText(member.email).toLowerCase(),
      phone: cleanText(member.phone),
      role: cleanText(member.role),
      primary: member.is_foreman === true || cleanText(member.id) === cleanText(crew.foreman_member_id || crew.default_contact_member_id)
    };
  }).filter((contact) => contact.name || contact.email || contact.phone);
}

function legacyCompensationProfile(value: unknown, allowSalary: boolean) {
  const plan = asObject(value);
  const type = cleanText(plan.type || "hourly").toLowerCase();
  const components: JsonObject[] = [];
  if (plan.default_hourly === true || type === "hourly" || type === "hybrid") {
    components.push({ kind: "hourly", rate_cents: Number(plan.hourly_rate_cents || 0), period: "hour" });
  }
  if (allowSalary && (plan.default_salary === true || type === "salary" || type === "hybrid")) {
    components.push({ kind: "salary", rate_cents: Number(plan.salary_rate_cents || 0), period: cleanText(plan.salary_period || "week") });
  }
  const pieceRates = asArray(plan.piece_rates).map(asObject);
  if ((plan.default_piece_rate === true || type === "piece_rate" || type === "hybrid") && !pieceRates.length) {
    components.push({ kind: "piece_rate", label: "Piece rate", unit: "unit", rate_cents: 0 });
  }
  for (const piece of pieceRates) {
    components.push({
      kind: "piece_rate",
      label: cleanText(piece.label || piece.name || "Piece rate"),
      unit: cleanText(piece.unit || "unit"),
      rate_cents: Number(piece.rate_cents || 0),
      capability_scope_ids: []
    });
  }
  return {
    name: cleanText(plan.name || "Legacy compensation"),
    currency: cleanText(plan.currency || "USD"),
    notes: cleanText(plan.notes),
    components
  };
}

async function runMigration(orgId: string, branchId: string) {
  const legacyDocument = await readBranchModule(orgId, branchId, "labor_crews").catch(() => null);
  const crews = asArray(asObject(legacyDocument?.data).crews).map(asObject);
  for (const crew of crews) {
    const id = cleanText(crew.id);
    if (!id) continue;
    const metadata = {
      ...asObject(crew.metadata),
      migrated_from: "labor_crews",
      legacy_record_id: id,
      legacy_migration_version: 2
    };
    if (cleanText(crew.employment_type || crew.worker_type || crew.classification).toLowerCase() === "subcontractor") {
      if ((await organizationConnectionRecordExists(orgId, id))) {
        const current = (await readOrganizationConnection(orgId, id));
        if (cleanText(asObject(current.metadata).migrated_from) === "labor_crews" && Number(asObject(current.metadata).legacy_migration_version || 0) < 2) {
          (await patchOrganizationConnection(orgId, id, {
            expected_revision: current.revision,
            compensation_profile: legacyCompensationProfile(crew.compensation_plan, false),
            metadata
          }));
        }
        continue;
      }
      (await createOrganizationConnection(orgId, {
        id,
        name: cleanText(crew.name || "Subcontractor"),
        status: cleanText(crew.status || (crew.archived_at ? "archived" : "active")),
        branch_ids: [branchId],
        contacts: legacyContacts(crew),
        capability_scope_ids: [],
        compensation_profile: legacyCompensationProfile(crew.compensation_plan, false),
        metadata
      }));
      continue;
    }
    if ((await resourceGroupRecordExists(orgId, id))) {
      const current = await readResourceGroup(orgId, id);
      if (cleanText(asObject(current.metadata).migrated_from) === "labor_crews" && Number(asObject(current.metadata).legacy_migration_version || 0) < 2) {
        await patchResourceGroup(orgId, id, {
          expected_revision: current.revision,
          compensation_profile: legacyCompensationProfile(crew.compensation_plan, true),
          metadata
        });
      }
      continue;
    }
    const members = await existingUserMemberships(orgId, crew);
    await createResourceGroup(orgId, {
      id,
      branch_id: branchId,
      name: cleanText(crew.name || "Crew"),
      status: cleanText(crew.status || (crew.archived_at ? "archived" : "active")),
      members,
      primary_member_user_id: cleanText(members.find((member) => member.is_lead === true)?.user_id),
      capability_scope_ids: [],
      compensation_profile: legacyCompensationProfile(crew.compensation_plan, true),
      attributes: asObject(crew.attributes),
      metadata
    });
  }
}

export async function migrateLegacyLaborCrews(orgId: string, branchId = "default") {
  const key = `${orgId}:${branchId}`;
  const existing = migrations.get(key);
  if (existing) return await existing;
  const migration = runMigration(orgId, branchId).catch((error) => {
    migrations.delete(key);
    throw error;
  });
  migrations.set(key, migration);
  await migration;
}
