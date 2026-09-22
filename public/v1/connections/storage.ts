import { randomBytes } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { SqlStore } from "../platform/sql_store.js";

import { compensationPlanProjection, type JsonObject } from "../compensation/service.js";
import { badRequest, conflict, notFound } from "../platform/errors.js";
import {
  assertCapabilityScopesExist,
  assertCompensationCapabilityScopes,
  getWorkforceDatabase,
  readCompensationProfile,
  upsertCompensationProfileRecord,
  withWorkforceTransaction
} from "../workforce/storage.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function parseJson(value: unknown, fallback: unknown = {}) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

function json(value: unknown) {
  return JSON.stringify(value ?? {});
}

function nowIso() {
  return new Date().toISOString();
}

function cleanId(value: unknown, label = "id") {
  const id = cleanText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!id) throw badRequest(`invalid_${label}`, `${label} must contain at least one letter or number.`);
  return id;
}

function generatedId(prefix: string) {
  return `${prefix}_${randomBytes(9).toString("hex")}`;
}

function uniqueIds(value: unknown) {
  return [...new Set(asArray(value).map((item) => cleanId(item)).filter(Boolean))];
}

function normalizeContacts(value: unknown) {
  return asArray(value).map((entry, index) => {
    const contact = asObject(entry);
    return {
      ...contact,
      id: cleanText(contact.id) || `contact_${index + 1}`,
      name: cleanText(contact.name),
      email: cleanText(contact.email).toLowerCase(),
      phone: cleanText(contact.phone),
      role: cleanText(contact.role),
      primary: contact.primary === true
    };
  });
}

function validateLink(orgId: string, linkedOrganizationId: string, linkStatus: string) {
  if (linkedOrganizationId && linkedOrganizationId === orgId) {
    throw badRequest("connection_self_link", "An organization connection cannot link to its owning organization.");
  }
  if (linkStatus === "linked" && !linkedOrganizationId) {
    throw badRequest("connection_link_target_required", "A linked organization connection requires linked_organization_id.");
  }
  if (linkStatus === "unlinked" && linkedOrganizationId) {
    throw badRequest("connection_link_status_invalid", "An unlinked organization connection cannot have linked_organization_id.");
  }
}

async function connectionBranchIds(orgId: string, connectionId: string) {
  return (await getWorkforceDatabase().prepare(`SELECT branch_id FROM organization_connection_branches
    WHERE organization_id=? AND connection_id=? ORDER BY branch_id ASC`).all(orgId, connectionId))
    .map((row) => cleanText(asObject(row).branch_id));
}

async function connectionCapabilityIds(orgId: string, connectionId: string) {
  return (await getWorkforceDatabase().prepare(`SELECT scope_id FROM organization_connection_capabilities
    WHERE organization_id=? AND connection_id=? ORDER BY scope_id ASC`).all(orgId, connectionId))
    .map((row) => cleanText(asObject(row).scope_id));
}

async function connectionRowView(rowValue: unknown) {
  const row = asObject(rowValue);
  const orgId = cleanText(row.organization_id);
  const id = cleanText(row.id);
  const compensation = (await readCompensationProfile(orgId, "organization_connection", id));
  const capabilityScopeIds = (await connectionCapabilityIds(orgId, id));
  const paymentMetadata = asObject(parseJson(row.payment_metadata_json));
  return {
    id,
    organization_id: orgId,
    name: cleanText(row.name),
    legal_name: cleanText(row.legal_name),
    status: cleanText(row.status || "active"),
    relationship_type_ids: asArray(parseJson(row.relationship_type_ids_json, [])),
    contacts: asArray(parseJson(row.contacts_json, [])),
    address: asObject(parseJson(row.address_json)),
    payment_metadata: paymentMetadata,
    payment_terms: asObject(paymentMetadata.payment_terms),
    branch_ids: (await connectionBranchIds(orgId, id)),
    capability_scope_ids: capabilityScopeIds,
    linked_organization_id: cleanText(row.linked_organization_id) || null,
    link_status: cleanText(row.link_status || "unlinked"),
    compensation_profile: compensation,
    compensation_plan: compensation ? compensationPlanProjection(compensation) : null,
    project_types: capabilityScopeIds,
    metadata: asObject(parseJson(row.metadata_json)),
    revision: Number(row.revision || 1),
    created_at: cleanText(row.created_at),
    updated_at: cleanText(row.updated_at),
    archived_at: cleanText(row.archived_at)
  };
}

async function readConnectionRow(orgId: string, connectionId: string) {
  return (await getWorkforceDatabase().prepare("SELECT * FROM organization_connections WHERE organization_id=? AND id=?").get(orgId, connectionId));
}

export async function readOrganizationConnection(orgIdValue: string, connectionIdValue: string) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const connectionId = cleanId(connectionIdValue, "connection_id");
  const row = (await readConnectionRow(orgId, connectionId));
  if (!row) throw notFound("organization_connection_not_found", "Organization connection was not found.");
  return (await connectionRowView(row));
}

export async function listOrganizationConnections(orgIdValue: string, options: JsonObject = {}) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const conditions = ["c.organization_id = ?"];
  const params: SQLInputValue[] = [orgId];
  const branchId = cleanText(options.branch_id || options.branchId);
  const scopeId = cleanText(options.scope_template_id || options.capability_scope_id);
  if (options.include_archived !== true && cleanText(options.include_archived) !== "1") conditions.push("c.status <> 'archived'");
  if (branchId) {
    conditions.push(`(
      NOT EXISTS (SELECT 1 FROM organization_connection_branches b0 WHERE b0.organization_id=c.organization_id AND b0.connection_id=c.id)
      OR EXISTS (SELECT 1 FROM organization_connection_branches b WHERE b.organization_id=c.organization_id AND b.connection_id=c.id AND b.branch_id=?)
    )`);
    params.push(cleanId(branchId, "branch_id"));
  }
  if (scopeId) {
    conditions.push(`EXISTS (SELECT 1 FROM organization_connection_capabilities cap
      WHERE cap.organization_id=c.organization_id AND cap.connection_id=c.id AND cap.scope_id=?)`);
    params.push(cleanId(scopeId, "scope_id"));
  }
  return (await Promise.all((await getWorkforceDatabase().prepare(`SELECT c.* FROM organization_connections c
    WHERE ${conditions.join(" AND ")} ORDER BY c.name ASC`).all(...params)).map(connectionRowView)));
}

async function replaceBranches(db: SqlStore, orgId: string, connectionId: string, branchIds: string[]) {
  (await db.prepare("DELETE FROM organization_connection_branches WHERE organization_id=? AND connection_id=?").run(orgId, connectionId));
  const insert = db.prepare(`INSERT INTO organization_connection_branches (organization_id, connection_id, branch_id, created_at)
    VALUES (?, ?, ?, ?)`);
  const now = nowIso();
  for (const branchId of branchIds) (await insert.run(orgId, connectionId, branchId, now));
}

async function replaceCapabilities(db: SqlStore, orgId: string, connectionId: string, scopeIds: string[]) {
  (await db.prepare("DELETE FROM organization_connection_capabilities WHERE organization_id=? AND connection_id=?").run(orgId, connectionId));
  const insert = db.prepare(`INSERT INTO organization_connection_capabilities (organization_id, connection_id, scope_id, created_at)
    VALUES (?, ?, ?, ?)`);
  const now = nowIso();
  for (const scopeId of scopeIds) (await insert.run(orgId, connectionId, scopeId, now));
}

export async function createOrganizationConnection(orgIdValue: string, input: JsonObject) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const connectionId = input.id ? cleanId(input.id, "connection_id") : generatedId("organization_connection");
  const linkedOrganizationId = cleanText(input.linked_organization_id) ? cleanId(input.linked_organization_id, "linked_organization_id") : "";
  const linkStatus = cleanText(input.link_status || (linkedOrganizationId ? "pending" : "unlinked"));
  validateLink(orgId, linkedOrganizationId, linkStatus);
  const branchIds = uniqueIds(input.branch_ids);
  const capabilityScopeIds = (await assertCapabilityScopesExist(orgId, branchIds, input.capability_scope_ids || input.project_types));
  const compensationInput = input.compensation_profile || input.compensation_plan;
  const compensation = compensationInput && typeof compensationInput === "object"
    ? (await assertCompensationCapabilityScopes(orgId, branchIds, compensationInput))
    : null;
  const now = nowIso();
  try {
    (await withWorkforceTransaction(async (db) => {
      (await db.prepare(`INSERT INTO organization_connections
        (organization_id, id, name, legal_name, status, relationship_type_ids_json, contacts_json, address_json,
         payment_metadata_json, linked_organization_id, link_status, metadata_json, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
        .run(
          orgId,
          connectionId,
          cleanText(input.name),
          cleanText(input.legal_name),
          cleanText(input.status || "active"),
          json(uniqueIds(input.relationship_type_ids || ["work_provider"])),
          json(normalizeContacts(input.contacts)),
          json(asObject(input.address)),
          json({ ...asObject(input.payment_metadata), ...(Object.prototype.hasOwnProperty.call(input, "payment_terms") ? { payment_terms: asObject(input.payment_terms) } : {}) }),
          linkedOrganizationId || null,
          linkStatus,
          json(asObject(input.metadata)),
          now,
          now
        ));
      (await replaceBranches(db, orgId, connectionId, branchIds));
      (await replaceCapabilities(db, orgId, connectionId, capabilityScopeIds));
      if (compensation) {
        (await upsertCompensationProfileRecord(db, orgId, "organization_connection", connectionId, compensation));
      }
    }));
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed")) {
      throw conflict("organization_connection_exists", `Organization connection '${connectionId}' already exists.`);
    }
    throw error;
  }
  return (await readOrganizationConnection(orgId, connectionId));
}

export async function patchOrganizationConnection(orgIdValue: string, connectionIdValue: string, input: JsonObject) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const connectionId = cleanId(connectionIdValue, "connection_id");
  const current = (await readOrganizationConnection(orgId, connectionId));
  if (Number(input.expected_revision || 0) !== Number(current.revision || 0)) {
    throw conflict("organization_connection_revision_conflict", "Organization connection revision does not match.", { current_revision: current.revision });
  }
  const linkedOrganizationId = Object.prototype.hasOwnProperty.call(input, "linked_organization_id")
    ? (cleanText(input.linked_organization_id) ? cleanId(input.linked_organization_id, "linked_organization_id") : "")
    : cleanText(current.linked_organization_id);
  const linkStatus = Object.prototype.hasOwnProperty.call(input, "link_status") ? cleanText(input.link_status) : cleanText(current.link_status);
  validateLink(orgId, linkedOrganizationId, linkStatus);
  const nextBranchIds = Object.prototype.hasOwnProperty.call(input, "branch_ids") ? uniqueIds(input.branch_ids) : uniqueIds(current.branch_ids);
  const nextCapabilityScopeIds = Object.prototype.hasOwnProperty.call(input, "capability_scope_ids") || Object.prototype.hasOwnProperty.call(input, "project_types")
    ? (await assertCapabilityScopesExist(orgId, nextBranchIds, input.capability_scope_ids || input.project_types))
    : (await assertCapabilityScopesExist(orgId, nextBranchIds, current.capability_scope_ids));
  const compensationInput = input.compensation_profile || input.compensation_plan;
  const compensation = compensationInput && typeof compensationInput === "object"
    ? (await assertCompensationCapabilityScopes(orgId, nextBranchIds, compensationInput))
    : null;
  (await withWorkforceTransaction(async (db) => {
    const locked = await db.prepare("SELECT revision FROM organization_connections WHERE organization_id=? AND id=?").get(orgId, connectionId);
    if (!locked || Number(locked.revision) !== Number(current.revision)) throw conflict("organization_connection_revision_conflict", "This record changed elsewhere. Reload and try again.");

    const nextStatus = Object.prototype.hasOwnProperty.call(input, "status") ? cleanText(input.status) : cleanText(current.status);
    const now = nowIso();
    (await db.prepare(`UPDATE organization_connections SET name=?, legal_name=?, status=?, relationship_type_ids_json=?, contacts_json=?,
      address_json=?, payment_metadata_json=?, linked_organization_id=?, link_status=?, metadata_json=?, revision=revision+1,
      updated_at=?, archived_at=? WHERE organization_id=? AND id=?`)
      .run(
        Object.prototype.hasOwnProperty.call(input, "name") ? cleanText(input.name) : current.name,
        Object.prototype.hasOwnProperty.call(input, "legal_name") ? cleanText(input.legal_name) : current.legal_name,
        nextStatus,
        json(Object.prototype.hasOwnProperty.call(input, "relationship_type_ids") ? uniqueIds(input.relationship_type_ids) : current.relationship_type_ids),
        json(Object.prototype.hasOwnProperty.call(input, "contacts") ? normalizeContacts(input.contacts) : current.contacts),
        json(Object.prototype.hasOwnProperty.call(input, "address") ? asObject(input.address) : current.address),
        json({
          ...(Object.prototype.hasOwnProperty.call(input, "payment_metadata") ? asObject(input.payment_metadata) : asObject(current.payment_metadata)),
          ...(Object.prototype.hasOwnProperty.call(input, "payment_terms") ? { payment_terms: asObject(input.payment_terms) } : {})
        }),
        linkedOrganizationId || null,
        linkStatus,
        json(Object.prototype.hasOwnProperty.call(input, "metadata") ? { ...asObject(current.metadata), ...asObject(input.metadata) } : current.metadata),
        now,
        nextStatus === "archived" ? now : null,
        orgId,
        connectionId
      ));
    if (Object.prototype.hasOwnProperty.call(input, "branch_ids")) (await replaceBranches(db, orgId, connectionId, nextBranchIds));
    if (Object.prototype.hasOwnProperty.call(input, "capability_scope_ids") || Object.prototype.hasOwnProperty.call(input, "project_types")) {
      (await replaceCapabilities(db, orgId, connectionId, nextCapabilityScopeIds));
    }
    if (compensation) {
      (await upsertCompensationProfileRecord(db, orgId, "organization_connection", connectionId, compensation));
    }
  }));
  return (await readOrganizationConnection(orgId, connectionId));
}

export async function archiveOrganizationConnection(orgIdValue: string, connectionIdValue: string, expectedRevision: number) {
  const orgId = cleanId(orgIdValue, "organization_id");
  const connectionId = cleanId(connectionIdValue, "connection_id");
  const current = (await readOrganizationConnection(orgId, connectionId));
  if (expectedRevision !== Number(current.revision || 0)) {
    throw conflict("organization_connection_revision_conflict", "Organization connection revision does not match.", { current_revision: current.revision });
  }
  const now = nowIso();
  (await getWorkforceDatabase().prepare(`UPDATE organization_connections SET status='archived', archived_at=?, updated_at=?, revision=revision+1
    WHERE organization_id=? AND id=?`).run(now, now, orgId, connectionId));
  return (await readOrganizationConnection(orgId, connectionId));
}

export function organizationConnectionAssignableProjection(connectionValue: JsonObject) {
  const capabilities = uniqueIds(connectionValue.capability_scope_ids || connectionValue.project_types);
  const compensation = asObject(connectionValue.compensation_profile);
  const resourceId = cleanText(connectionValue.id);
  const resourceName = cleanText(connectionValue.name);
  return {
    resource_kind: "organization_connection",
    subject_type: "organization_connection",
    resource_id: resourceId,
    work_resource_ref: { kind: "organization_connection", id: resourceId, name: resourceName },
    branch_ids: Array.isArray(connectionValue.branch_ids) ? connectionValue.branch_ids : [],
    capability_scope_ids: capabilities,
    kind_ids: uniqueIds(connectionValue.relationship_type_ids),
    assignment_tag_ids: uniqueIds(asObject(connectionValue.metadata).assignment_tag_ids),
    linked_organization_id: connectionValue.linked_organization_id || null,
    link_status: cleanText(connectionValue.link_status || "unlinked"),

    // Compatibility projection while scheduling consumers move to typed refs.
    id: resourceId,
    name: resourceName,
    status: cleanText(connectionValue.status || "active"),
    compensation_plan: cleanText(compensation.id) ? compensationPlanProjection(compensation) : null,
    project_types: capabilities
  };
}
