import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import { authContextFromRequest, hashPassword, requirePlatformAuth } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { badRequest, forbidden, PlatformError, notFound, unauthorized } from "../platform/errors.js";
import { createPlatformLead } from "../platform/api.js";
import {
  addIdentityMembership,
  createIdentity,
  findIdentityByEmail,
  listDocuments,
  readBranchModule,
  saveBranchModule,
  upsertDocument,
  type JsonObject
} from "../platform/storage.js";
import { env } from "../src/config/env.js";
import { isFirstMeasurePostgresEnabled } from "../src/database/postgres.js";
import { listSharedDocuments, mutateSharedDocument, readSharedDocument } from "../src/database/shared_documents.js";
import { emitWorkEvent } from "../work/engine.js";

const objectBodySchema = z.object({}).passthrough();
const CANVASSING_MODULE_ID = "canvassing";
const DEFAULT_BRANCH_ID = "default";
const CANVASSING_MANAGER_ROLES = ["canvassing_manager", "canvassing_admin"];
const CANVASSING_USER_ROLES = ["canvasser", ...CANVASSING_MANAGER_ROLES];

export function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

export function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

export function nowIso() {
  return new Date().toISOString();
}

function sanitizeId(value: unknown, fallback = "item") {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || `${fallback}_${randomBytes(6).toString("hex")}`;
}

function generatedId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
}

function storageRoot() {
  return path.resolve(process.cwd(), env.canvassingStorageRoot);
}

function pinDir(orgId: string, branchId: string) {
  return path.join(storageRoot(), "organizations", sanitizeId(orgId, "org"), "branches", sanitizeId(branchId || DEFAULT_BRANCH_ID, "branch"), "pins");
}

function pinPath(orgId: string, branchId: string, pinId: string) {
  return path.join(pinDir(orgId, branchId), `${sanitizeId(pinId, "pin")}.json`);
}

function pinKey(orgId: string, branchId: string, pinId: string) {
  return {
    namespace: "canvassing",
    scope: `${sanitizeId(orgId, "org")}:${sanitizeId(branchId || DEFAULT_BRANCH_ID, "branch")}`,
    collection: "pins",
    id: sanitizeId(pinId, "pin")
  };
}

async function writeJsonAtomic(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`);
    try {
      await rename(tempPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EEXIST")) throw error;
      await rm(filePath, { force: true });
      await rename(tempPath, filePath);
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

async function readJson(filePath: string) {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as JsonObject;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound("pin_not_found", "The requested canvassing pin was not found.");
    throw error;
  }
}

export function defaultCanvassingSettings(existing: JsonObject = {}) {
  const labels = asObject(existing.labels);
  const pinStatuses = asObject(labels.pin_statuses);
  const statuses = Array.isArray(existing.statuses) && existing.statuses.length
    ? existing.statuses
    : [
      { id: "new", color: "#2563eb", order: 10, lead_eligible: true },
      { id: "no_answer", color: "#f59e0b", order: 20, lead_eligible: false },
      { id: "not_interested", color: "#64748b", order: 30, lead_eligible: false },
      { id: "follow_up", color: "#8b5cf6", order: 40, lead_eligible: true },
      { id: "appointment_set", color: "#16a34a", order: 50, lead_eligible: true },
      { id: "lead_created", color: "#0f766e", order: 60, lead_eligible: false },
      { id: "deleted", color: "#991b1b", order: 999, lead_eligible: false }
    ];
  return {
    schema_version: 1,
    enabled: existing.enabled !== false,
    canvasser_role_id: cleanText(existing.canvasser_role_id || "canvasser"),
    default_status_id: cleanText(existing.default_status_id || "new"),
    lead_stage_id: cleanText(existing.lead_stage_id || "new_lead"),
    statuses,
    labels: {
      ...labels,
      pin_statuses: {
        new: "New",
        no_answer: "No Answer",
        not_interested: "Not Interested",
        follow_up: "Follow Up",
        appointment_set: "Appointment Set",
        lead_created: "Lead Created",
        deleted: "Deleted",
        ...pinStatuses
      }
    }
  };
}

function labelForStatus(settings: JsonObject, statusId: string) {
  return cleanText(asObject(asObject(settings.labels).pin_statuses)[statusId]) || statusId.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

export function statusesWithLabels(settings: JsonObject) {
  return asArray(settings.statuses).map((entry) => {
    const status = asObject(entry);
    const id = cleanText(status.id);
    return id ? { ...status, id, label: labelForStatus(settings, id) } : null;
  }).filter(Boolean);
}

export async function ensureCanvassingSettings(orgId: string, branchId: string) {
  let current: JsonObject = {};
  try {
    current = asObject((await readBranchModule(orgId, branchId, CANVASSING_MODULE_ID)).data);
  } catch {
    current = {};
  }
  const settings = defaultCanvassingSettings(current);
  const module = await saveBranchModule(orgId, branchId, CANVASSING_MODULE_ID, {
    data: settings,
    metadata: { kind: "branch_canvassing_settings", source: "canvassing_api" }
  }, { replace: true });
  return { module, settings: { ...settings, statuses: statusesWithLabels(settings) } };
}

export async function ensureCanvassingEnabled(orgId: string, branchId: string) {
  if (!(await isAppFlagEnabled(orgId, "canvassing", "app"))) throw forbidden("app_flag_disabled", "Canvassing is not enabled for this organization.");
  const result = await ensureCanvassingSettings(orgId, branchId);
  if (result.settings.enabled === false) throw forbidden("canvassing_disabled", "Canvassing is disabled for this branch.");
  return result;
}

export async function requireCanvassingAppFlag(orgId: string) {
  if (!(await isAppFlagEnabled(orgId, "canvassing", "app"))) throw forbidden("app_flag_disabled", "Canvassing is not enabled for this organization.");
}

function statusExists(settings: JsonObject, statusId: string) {
  return statusesWithLabels(settings).some((status) => cleanText(asObject(status).id) === statusId);
}

function normalizeCoordinates(value: unknown) {
  const input = asObject(value);
  const lat = Number(input.lat ?? input.latitude);
  const lng = Number(input.lng ?? input.lon ?? input.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw badRequest("invalid_coordinates", "Pin coordinates require numeric lat and lng.");
  return { lat, lng };
}

export function normalizeContact(value: unknown) {
  const input = asObject(value);
  const phones = asArray(input.phones).map(cleanText).filter(Boolean);
  const phone = cleanText(input.phone || phones[0] || "");
  return {
    name: cleanText(input.name),
    email: cleanText(input.email).toLowerCase(),
    phone,
    phones: phones.length ? phones : (phone ? [phone] : [])
  };
}

export function actorFromContext(ctx: JsonObject) {
  const user = asObject(ctx.user);
  return {
    user_id: cleanText(ctx.userId || ctx.user_id),
    identity_id: cleanText(ctx.identityId || ctx.identity_id),
    name: cleanText(user.name || ctx.name),
    email: cleanText(user.email || ctx.email)
  };
}

function normalizeRoles(value: unknown, fallback: string[] = ["canvasser"]) {
  const roles = asArray(value).map(cleanText).filter(Boolean);
  return roles.length ? [...new Set(roles)] : fallback;
}

function canManageCanvassing(ctx: JsonObject) {
  const user = asObject(ctx.user);
  const permissions = asObject(ctx.permissions);
  const role = cleanText(ctx.role || user.role);
  const roles = normalizeRoles(user.roles, []);
  return permissions["*"] === true
    || permissions.manage_company_users === true
    || ["owner", "admin", "super_admin"].includes(role)
    || roles.some((item) => CANVASSING_MANAGER_ROLES.includes(item));
}

export async function requireCanvassingManager(request: Parameters<typeof authContextFromRequest>[0], orgId: string) {
  const ctx = await authContextFromRequest(request);
  if (!ctx) throw unauthorized("authentication_required", "Authentication required.");
  if (ctx.orgId !== orgId) throw forbidden("organization_forbidden", "This session cannot access the requested organization.");
  if (!canManageCanvassing(ctx as unknown as JsonObject)) throw forbidden("canvassing_manager_required", "Canvassing manager access is required.");
  return ctx;
}

function publicUserDocument(doc: JsonObject) {
  const data = asObject(doc.data);
  return {
    id: doc.id,
    ...data,
    roles: normalizeRoles(data.roles, []),
    permissions: asObject(data.permissions)
  };
}

function canvassingRolePreset(role: string) {
  const normalized = CANVASSING_MANAGER_ROLES.includes(role) ? "canvassing_manager" : "canvasser";
  if (normalized === "canvassing_manager") {
    return {
      role: "canvassing_manager",
      roles: ["canvasser", "canvassing_manager"],
      permissions: { manage_canvassing: true, manage_company_users: true }
    };
  }
  return {
    role: "canvasser",
    roles: ["canvasser"],
    permissions: { manage_canvassing: true }
  };
}

function normalizePin(input: JsonObject, existing: JsonObject | null, settings: JsonObject, actor: JsonObject) {
  const now = nowIso();
  const current = asObject(existing);
  const statusId = cleanText(input.status_id || input.status || current.status_id || settings.default_status_id || "new");
  if (!statusExists(settings, statusId)) throw badRequest("invalid_pin_status", `Unknown canvassing pin status '${statusId}'.`);
  const coordinates = input.coordinates ? normalizeCoordinates(input.coordinates) : normalizeCoordinates(current.coordinates || input);
  const previousStatus = cleanText(current.status_id);
  const history = Array.isArray(current.status_history) ? [...current.status_history] : [];
  if (!current.id || previousStatus !== statusId || input.note || input.status_note) {
    history.push({
      status_id: statusId,
      label: labelForStatus(settings, statusId),
      note: cleanText(input.note || input.status_note),
      actor,
      at: now
    });
  }
  return {
    schema_version: 1,
    id: cleanText(current.id || input.id || generatedId("pin")),
    organization_id: cleanText(current.organization_id || input.organization_id),
    branch_id: cleanText(current.branch_id || input.branch_id || DEFAULT_BRANCH_ID),
    coordinates,
    status_id: statusId,
    status_label: labelForStatus(settings, statusId),
    status_history: history,
    title: cleanText(input.title || current.title),
    address: cleanText(input.address || current.address),
    contact: normalizeContact(input.contact || current.contact),
    notes: cleanText(input.notes || current.notes),
    source: cleanText(input.source || current.source || "canvassing"),
    platform_project_id: cleanText(input.platform_project_id || current.platform_project_id),
    lead_created_at: cleanText(input.lead_created_at || current.lead_created_at),
    created_by: asObject(current.created_by).user_id ? current.created_by : actor,
    created_at: cleanText(current.created_at) || now,
    updated_at: now,
    metadata: { ...asObject(current.metadata), ...asObject(input.metadata) }
  };
}

export async function listPins(orgId: string, branchId: string) {
  if (isFirstMeasurePostgresEnabled()) {
    const key = pinKey(orgId, branchId, "list");
    const pins = await listSharedDocuments<JsonObject>({ namespace: key.namespace, scope: key.scope, collection: key.collection });
    return pins.filter((pin) => cleanText(pin.status_id) !== "deleted").sort((a, b) => cleanText(b.updated_at).localeCompare(cleanText(a.updated_at)));
  }
  const dir = pinDir(orgId, branchId);
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });
  const pins = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const pin = await readJson(path.join(dir, entry.name));
    if (cleanText(pin.status_id) !== "deleted") pins.push(pin);
  }
  return pins.sort((a, b) => cleanText(b.updated_at).localeCompare(cleanText(a.updated_at)));
}

export async function readPin(orgId: string, branchId: string, pinId: string) {
  if (isFirstMeasurePostgresEnabled()) {
    const pin = await readSharedDocument<JsonObject>(pinKey(orgId, branchId, pinId));
    if (!pin) throw notFound("pin_not_found", "The requested canvassing pin was not found.");
    return pin;
  }
  return await readJson(pinPath(orgId, branchId, pinId));
}

export async function savePin(orgId: string, branchId: string, input: JsonObject, actor: JsonObject) {
  const { settings } = await ensureCanvassingSettings(orgId, branchId);
  if (isFirstMeasurePostgresEnabled()) {
    const requestedId = cleanText(input.id) || generatedId("pin");
    return mutateSharedDocument<JsonObject>(
      pinKey(orgId, branchId, requestedId),
      (current) => normalizePin({ ...input, id: requestedId, organization_id: orgId, branch_id: branchId }, Object.keys(current).length ? current : null, settings, actor),
      { create: () => ({}) }
    );
  }
  let existing: JsonObject | null = null;
  const pinId = cleanText(input.id);
  if (pinId) {
    try {
      existing = await readPin(orgId, branchId, pinId);
    } catch {}
  }
  const pin = normalizePin({ ...input, organization_id: orgId, branch_id: branchId }, existing, settings, actor);
  await writeJsonAtomic(pinPath(orgId, branchId, cleanText(pin.id)), pin);
  return pin;
}

export async function listCanvassingUsers(orgId: string) {
  const docs = await listDocuments(orgId, "users");
  return docs
    .map(publicUserDocument)
    .filter((user) => normalizeRoles(user.roles, []).some((role) => CANVASSING_USER_ROLES.includes(role)))
    .sort((a, b) => cleanText(asObject(a).name || asObject(a).email).localeCompare(cleanText(asObject(b).name || asObject(b).email)));
}

export async function createOrInviteCanvassingUser(orgId: string, branchId: string, input: JsonObject) {
  const email = cleanText(input.email).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest("invalid_email", "A valid canvasser email is required.");
  const preset = canvassingRolePreset(cleanText(input.role || input.canvassing_role || "canvasser"));
  const password = cleanText(input.password);
  let identity: JsonObject | null = null;
  let createdIdentity = false;
  try {
    identity = await findIdentityByEmail(email);
  } catch {
    identity = await createIdentity({
      email,
      password_hash: password ? await hashPassword(password) : "",
      password_algo: password ? "bcrypt" : "pending-invite",
      name: cleanText(input.name),
      phone: cleanText(input.phone),
      status: "active",
      metadata: {
        source: "canvassing_invite",
        invite_pending: !password
      }
    });
    createdIdentity = true;
  }
  const identityId = cleanText(identity.id);
  const userId = cleanText(input.id || `user_${identityId.replace(/^identity_/, "")}`);
  const user = await upsertDocument(orgId, "users", {
    id: userId,
    data: {
      identity_id: identityId,
      email,
      name: cleanText(input.name || identity.name),
      phone: cleanText(input.phone || identity.phone),
      role: preset.role,
      roles: preset.roles,
      branch_id: branchId,
      status: cleanText(input.status || (password ? "active" : "invited")),
      permissions: preset.permissions,
      profile: {},
      metadata: {
        source: "canvassing_app",
        invite_pending: !password,
        invited_at: nowIso(),
        ...asObject(input.metadata)
      }
    },
    metadata: {
      kind: "organization_user",
      identity_id: identityId,
      source: "canvassing_app"
    }
  }, { replace: true });
  await addIdentityMembership(identityId, orgId, userId, preset.role);
  return { user: publicUserDocument(user), identity: { id: identityId, email }, created_identity: createdIdentity, invite_pending: !password };
}

export async function reverseGeocode(lat: number, lng: number, host = "local.firstmate") {
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(String(lat))}&lon=${encodeURIComponent(String(lng))}`;
  const response = await fetch(url, {
    headers: {
      "User-Agent": `FirstMateCanvassing/1.0 (${host})`,
      Accept: "application/json"
    }
  });
  if (!response.ok) throw badRequest("reverse_geocode_failed", "Reverse geocoding failed.");
  return await response.json();
}
