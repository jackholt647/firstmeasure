import { randomBytes } from "node:crypto";
import type { SqlStore } from "../platform/sql_store.js";
import { badRequest, conflict, notFound } from "../platform/errors.js";
import { publishRealtimeEvent } from "../platform/realtime.js";
import type { JsonObject } from "../platform/storage.js";
import { contactStore } from "./store.js";
import { nameKey, normalizePoint, normalizeEmail, normalizePhone, type ContactPointKind } from "./normalize.js";
import { asObject, contactKind, text } from "./contracts.js";

// The one writer of contact records. See docs/architecture/contacts.md.

export type ContactPoint = { kind: ContactPointKind; value: string; normalized: string; label: string; primary: boolean };
export type ContactRecord = {
  id: string; contact_kind: "human" | "org"; name: string; first_name: string; last_name: string;
  email: string; phone: string; address: string;
  emails: ContactPoint[]; phones: ContactPoint[]; addresses: ContactPoint[];
  branch_ids: string[]; tags: string[]; time_zone: string; custom_field_values: JsonObject; profile_media_id: string;
  company: string; notes: string; birthday: string; imported_at: string; import_id: string; import_source: string;
  merged_into: string; revision: number; created_at: string; updated_at: string;
};
export type ContactLink = { contact_id: string; role: string; primary: boolean };

const EXTRA_KEYS = ["company", "notes", "birthday", "imported_at", "import_id", "import_source"] as const;
const POINT_KEYS: Record<ContactPointKind, { one: string; many: string }> = {
  email: { one: "email", many: "emails" }, phone: { one: "phone", many: "phones" }, address: { one: "address", many: "addresses" }
};
const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value ?? null);
const parse = (value: unknown, fallback: unknown) => { try { return JSON.parse(text(value)) ?? fallback; } catch { return fallback; } };
const strings = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];
const db = () => contactStore();

export function newContactId() { return `contact_${randomBytes(8).toString("hex")}`; }
function assertId(id: string) {
  // Older projects derived ids such as `project_x:contact:0`; those keep working.
  if (!/^[A-Za-z0-9_.:-]{1,160}$/.test(id)) throw badRequest("contact_id_invalid", "Contact ids use letters, numbers, -, _, . and :.");
  return id;
}

/** The point sets an input names. A kind the input does not mention is left as it is. */
function inputPoints(input: JsonObject): Partial<Record<ContactPointKind, ContactPoint[]>> {
  const result: Partial<Record<ContactPointKind, ContactPoint[]>> = {};
  for (const kind of ["email", "phone", "address"] as ContactPointKind[]) {
    const keys = POINT_KEYS[kind];
    const extra = kind === "address" ? ["default_address"] : kind === "phone" ? ["secondary_phone"] : [];
    if (!(keys.one in input) && !(keys.many in input) && !extra.some(k => k in input)) continue;
    const raw: unknown[] = [];
    if (text(input[keys.one])) raw.push({ value: input[keys.one], primary: true, label: kind === "phone" ? text(input.primary_phone_label) : "" });
    for (const entry of Array.isArray(input[keys.many]) ? input[keys.many] as unknown[] : []) raw.push(entry);
    if (kind === "phone" && text(input.secondary_phone)) raw.push({ value: input.secondary_phone, label: text(input.secondary_phone_label) });
    if (kind === "address" && text(input.default_address)) raw.push({ value: input.default_address });
    const seen = new Set<string>(), points: ContactPoint[] = [];
    for (const entry of raw) {
      const row = typeof entry === "string" ? { value: entry } : asObject(entry), value = text(row.value ?? row.email ?? row.phone ?? row.number ?? row.address);
      if (!value) continue;
      const normalized = normalizePoint(kind, value) || `raw:${value.toLowerCase()}`;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      points.push({ kind, value: kind === "email" ? normalizeEmail(value) || value : value, normalized, label: text(row.label).slice(0, 40), primary: row.primary === true });
    }
    if (points.length && !points.some(p => p.primary)) points[0]!.primary = true;
    let primarySeen = false;
    for (const p of points) { if (p.primary && primarySeen) p.primary = false; if (p.primary) primarySeen = true; }
    result[kind] = points;
  }
  return result;
}

async function loadRecords(store: SqlStore, org: string, ids: string[]): Promise<ContactRecord[]> {
  if (!ids.length) return [];
  const marks = ids.map(() => "?").join(",");
  const rows = await store.prepare(`SELECT * FROM contacts WHERE organization_id=? AND id IN (${marks})`).all(org, ...ids);
  const points = await store.prepare(`SELECT * FROM contact_points WHERE organization_id=? AND contact_id IN (${marks}) ORDER BY position`).all(org, ...ids);
  const branches = await store.prepare(`SELECT * FROM contact_branches WHERE organization_id=? AND contact_id IN (${marks}) ORDER BY branch_id`).all(org, ...ids);
  const byId = new Map(rows.map(row => [text(row.id), row]));
  return ids.flatMap(id => {
    const row = byId.get(id);
    if (!row) return [];
    const own = points.filter(p => text(p.contact_id) === id).map(p => ({ kind: text(p.kind) as ContactPointKind, value: text(p.value), normalized: text(p.normalized), label: text(p.label), primary: Number(p.is_primary) === 1 }));
    const of = (kind: ContactPointKind) => own.filter(p => p.kind === kind);
    const primary = (kind: ContactPointKind) => (of(kind).find(p => p.primary) || of(kind)[0])?.value || "";
    const extra = asObject(parse(row.extra_json, {}));
    const values = asObject(parse(row.custom_field_values_json, {}));
    return [{
      id, contact_kind: text(row.kind) === "org" ? "org" : "human", name: text(row.name), first_name: text(row.first_name), last_name: text(row.last_name),
      email: primary("email"), phone: primary("phone"), address: primary("address"), emails: of("email"), phones: of("phone"), addresses: of("address"),
      branch_ids: branches.filter(b => text(b.contact_id) === id).map(b => text(b.branch_id)),
      tags: strings(parse(row.tags_json, [])), time_zone: text(row.time_zone), custom_field_values: values,
      profile_media_id: text(asObject(values.profile_photo).media_id),
      ...Object.fromEntries(EXTRA_KEYS.map(k => [k, text(extra[k])])) as Record<typeof EXTRA_KEYS[number], string>,
      merged_into: text(row.merged_into), revision: Number(row.revision || 1), created_at: text(row.created_at), updated_at: text(row.updated_at)
    } satisfies ContactRecord];
  });
}

/** Follows merges. A merged contact resolves to the contact it was merged into. */
export async function resolveContactId(org: string, id: string, store: SqlStore = db()) {
  let current = text(id);
  for (let hop = 0; current && hop < 16; hop++) {
    const row = await store.prepare("SELECT merged_into FROM contacts WHERE organization_id=? AND id=?").get(org, current);
    if (!row) return "";
    if (!text(row.merged_into)) return current;
    current = text(row.merged_into);
  }
  return "";
}

export async function readContact(org: string, id: string, options: { follow?: boolean } = {}) {
  const resolved = options.follow === false ? text(id) : await resolveContactId(org, id);
  const [record] = resolved ? await loadRecords(db(), org, [resolved]) : [];
  if (!record) throw notFound("contact_not_found", "The contact is not available in this organization.");
  return record;
}

export async function readContacts(org: string, ids: string[]) {
  const resolved = [...new Set((await Promise.all(strings(ids).map(id => resolveContactId(org, id)))).filter(Boolean))];
  return loadRecords(db(), org, resolved);
}

/** Field values, tags and kind are validated by the custom-field contract for the contact entity. */
async function validated(org: string, id: string, next: JsonObject, previous: JsonObject) {
  const fields = await import("../custom_fields/records.js");
  const branch = strings(next.branch_ids)[0] || "default";
  const shape = (record: JsonObject) => ({ ...record, id, branch_id: strings(record.branch_ids)[0] || branch });
  const prepared = await fields.prepareStoredFields(org, "customers", shape(next), Object.keys(previous).length ? shape(previous) : {});
  await fields.validateStoredFields(org, "customers", prepared, Object.keys(previous).length ? shape(previous) : {}, true, id);
  return prepared;
}

async function writeRecord(store: SqlStore, org: string, id: string, data: JsonObject, points: Partial<Record<ContactPointKind, ContactPoint[]>>, revision: number, createdAt: string) {
  const time = now();
  const name = text(data.name) || [text(data.first_name), text(data.last_name)].filter(Boolean).join(" ");
  await store.prepare(`INSERT INTO contacts(organization_id,id,kind,name,first_name,last_name,name_key,tags_json,time_zone,custom_field_values_json,extra_json,merged_into,revision,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,'',?,?,?)
    ON CONFLICT(organization_id,id) DO UPDATE SET kind=excluded.kind,name=excluded.name,first_name=excluded.first_name,last_name=excluded.last_name,name_key=excluded.name_key,
      tags_json=excluded.tags_json,time_zone=excluded.time_zone,custom_field_values_json=excluded.custom_field_values_json,extra_json=excluded.extra_json,revision=excluded.revision,updated_at=excluded.updated_at`)
    .run(org, id, contactKind(data), name, text(data.first_name), text(data.last_name), nameKey(name), json(strings(data.tags)), text(data.time_zone),
      json(asObject(data.custom_field_values)), json(Object.fromEntries(EXTRA_KEYS.map(k => [k, text(data[k])]))), revision, createdAt || time, time);
  for (const [kind, rows] of Object.entries(points) as [ContactPointKind, ContactPoint[]][]) {
    await store.prepare("DELETE FROM contact_points WHERE organization_id=? AND contact_id=? AND kind=?").run(org, id, kind);
    for (const [position, p] of rows.entries()) await store.prepare("INSERT INTO contact_points(organization_id,contact_id,kind,value,normalized,label,is_primary,position) VALUES(?,?,?,?,?,?,?,?)")
      .run(org, id, kind, p.value, p.normalized, p.label, p.primary ? 1 : 0, position);
  }
  await store.prepare("DELETE FROM contact_branches WHERE organization_id=? AND contact_id=?").run(org, id);
  for (const branch of strings(data.branch_ids)) await store.prepare("INSERT INTO contact_branches(organization_id,contact_id,branch_id) VALUES(?,?,?)").run(org, id, branch);
}

function contactData(input: JsonObject, previous: Partial<ContactRecord> = {}): JsonObject {
  const merged: JsonObject = { ...previous };
  for (const key of ["contact_kind", "name", "first_name", "last_name", "time_zone", "tags", ...EXTRA_KEYS]) if (key in input) merged[key] = input[key];
  if ("branch_ids" in input || "branch_id" in input) merged.branch_ids = strings([...(Array.isArray(input.branch_ids) ? input.branch_ids : []), input.branch_id]);
  for (const key of ["custom_field_values", "contact_custom_field_values"]) if (key in input) merged.custom_field_values = asObject(input[key]);
  if (!("tags" in merged)) merged.tags = [];
  return merged;
}

/** `migration`: copying existing stored contacts, whose values were validated when they were saved. */
export async function createContact(org: string, input: JsonObject, options: { id?: string; migration?: boolean } = {}) {
  const id = assertId(text(options.id || input.id || input.contact_id) || newContactId());
  const data = options.migration ? contactData(input) : await validated(org, id, contactData(input), {});
  const points = inputPoints(input);
  if (!text(data.name) && !text(data.first_name) && !text(data.last_name) && !Object.values(points).some(rows => rows?.length)) throw badRequest("contact_identity_missing", "A contact needs a name, email, phone or address.");
  const store = db();
  await store.transaction(async tx => {
    if (await tx.prepare("SELECT 1 FROM contacts WHERE organization_id=? AND id=?").get(org, id)) throw conflict("contact_exists", "A contact with this id already exists.");
    await writeRecord(tx, org, id, data, { email: [], phone: [], address: [], ...points }, 1, "");
  }, `contact:${org}:${id}`);
  const record = await readContact(org, id, { follow: false });
  await publishRealtimeEvent({ organization_id: org, topic: "contact.created", payload: { contact_id: id, revision: record.revision } });
  // A copy of existing data is not a new person to check.
  if (!options.migration) await (await import("./merge.js")).suggestContactDuplicates(org, id);
  return record;
}

/** Changes only what the patch names. Point kinds named in the patch are replaced. */
export async function updateContact(org: string, id: string, patch: JsonObject, options: { expectedRevision?: number; projections?: boolean } = {}) {
  const store = db();
  const target = await resolveContactId(org, id);
  if (!target) throw notFound("contact_not_found", "The contact is not available in this organization.");
  const changed = await store.transaction(async tx => {
    const [previous] = await loadRecords(tx, org, [target]);
    if (!previous) throw notFound("contact_not_found", "The contact is not available in this organization.");
    if (options.expectedRevision && options.expectedRevision !== previous.revision) throw conflict("revision_conflict", "This contact changed elsewhere. Reload and try again.");
    const next = contactData(patch, previous);
    const points = inputPoints(patch);
    const samePoints = (Object.entries(points) as [ContactPointKind, ContactPoint[]][]).every(([kind, rows]) => JSON.stringify(rows.map(p => [p.normalized, p.value, p.label, p.primary])) === JSON.stringify(previous[POINT_KEYS[kind].many as "emails"].map(p => [p.normalized, p.value, p.label, p.primary])));
    const comparable = (record: JsonObject) => JSON.stringify([contactKind(record), text(record.name), text(record.first_name), text(record.last_name), text(record.time_zone), strings(record.tags).filter(t => t !== "org"), strings(record.branch_ids), asObject(record.custom_field_values), EXTRA_KEYS.map(k => text(record[k]))]);
    if (samePoints && comparable(next) === comparable(previous as unknown as JsonObject)) return null;
    const data = await validated(org, target, next, previous as unknown as JsonObject);
    await writeRecord(tx, org, target, data, points, previous.revision + 1, previous.created_at);
    return true;
  }, `contact:${org}:${target}`);
  const record = await readContact(org, target, { follow: false });
  if (!changed) return record;
  await publishRealtimeEvent({ organization_id: org, topic: "contact.updated", payload: { contact_id: target, revision: record.revision } });
  if (options.projections !== false) await refreshProjections(org, await contactProjectIds(org, target));
  return record;
}

export async function listContacts(org: string, query: { q?: string; kind?: string; tag?: string; branch_ids?: string[] | null; ids?: string[]; after?: string; limit?: number } = {}) {
  const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
  const where = ["c.organization_id=?", "c.merged_into=''"], values: (string | number)[] = [org];
  const q = text(query.q);
  if (q) {
    const phone = normalizePhone(q), email = normalizeEmail(q);
    where.push("(c.name_key LIKE ? OR c.id IN (SELECT contact_id FROM contact_points WHERE organization_id=? AND (normalized LIKE ? OR normalized=? OR normalized=?)))");
    values.push(`%${nameKey(q)}%`, org, `%${q.toLowerCase()}%`, phone || "#none", email || "#none");
  }
  if (query.kind === "human" || query.kind === "org") { where.push("c.kind=?"); values.push(query.kind); }
  if (text(query.tag)) { where.push("c.tags_json LIKE ?"); values.push(`%${JSON.stringify(text(query.tag))}%`); }
  if (query.ids) { const ids = strings(query.ids); if (!ids.length) return { items: [], next: null }; where.push(`c.id IN (${ids.map(() => "?").join(",")})`); values.push(...ids); }
  if (Array.isArray(query.branch_ids)) {
    // A contact with no branches is visible in every branch.
    const branches = strings(query.branch_ids);
    where.push(`(NOT EXISTS (SELECT 1 FROM contact_branches b WHERE b.organization_id=c.organization_id AND b.contact_id=c.id)${branches.length ? ` OR EXISTS (SELECT 1 FROM contact_branches b WHERE b.organization_id=c.organization_id AND b.contact_id=c.id AND b.branch_id IN (${branches.map(() => "?").join(",")}))` : ""})`);
    values.push(...branches);
  }
  const [afterKey = "", afterId = ""] = text(query.after).split("~");
  if (query.after) { where.push("(c.name_key>? OR (c.name_key=? AND c.id>?))"); values.push(afterKey, afterKey, afterId); }
  const rows = await db().prepare(`SELECT c.id,c.name_key FROM contacts c WHERE ${where.join(" AND ")} ORDER BY c.name_key,c.id LIMIT ?`).all(...values, limit + 1);
  const page = rows.slice(0, limit);
  return { items: await loadRecords(db(), org, page.map(r => text(r.id))), next: rows.length > limit ? `${text(page.at(-1)!.name_key)}~${text(page.at(-1)!.id)}` : null };
}

/** Contacts sharing a normalized email or phone. Addresses and names never make an exact match. */
export async function findExactMatches(org: string, input: JsonObject) {
  const points = inputPoints(input);
  const keys = [...(points.email || []), ...(points.phone || [])].filter(p => !p.normalized.startsWith("raw:"));
  if (!keys.length) return [];
  const rows = await db().prepare(`SELECT DISTINCT p.contact_id FROM contact_points p JOIN contacts c ON c.organization_id=p.organization_id AND c.id=p.contact_id
    WHERE p.organization_id=? AND c.merged_into='' AND (${keys.map(() => "(p.kind=? AND p.normalized=?)").join(" OR ")}) ORDER BY p.contact_id`)
    .all(org, ...keys.flatMap(p => [p.kind, p.normalized]));
  return loadRecords(db(), org, rows.map(r => text(r.contact_id)));
}

/** Deletes a contact an import created, if nothing links to it. Only undoing that import may call this. */
export async function removeUnusedContact(org: string, id: string, importId: string) {
  if (!id || !importId) return false;
  const store = db();
  const removed = await store.transaction(async tx => {
    const [contact] = await loadRecords(tx, org, [id]);
    if (!contact || contact.import_id !== importId || contact.merged_into) return false;
    if (await tx.prepare("SELECT 1 FROM contact_links WHERE organization_id=? AND contact_id=?").get(org, id)) return false;
    for (const table of ["contact_points", "contact_branches"]) await tx.prepare(`DELETE FROM ${table} WHERE organization_id=? AND contact_id=?`).run(org, id);
    await tx.prepare("DELETE FROM contacts WHERE organization_id=? AND id=?").run(org, id);
    return true;
  }, `contact:${org}:${id}`);
  if (removed) await publishRealtimeEvent({ organization_id: org, topic: "contact.removed", payload: { contact_id: id } });
  return removed;
}

// ---- Project links -------------------------------------------------------

export async function projectContactLinks(org: string, projectId: string, store: SqlStore = db()): Promise<ContactLink[]> {
  return (await store.prepare("SELECT contact_id,role,is_primary FROM contact_links WHERE organization_id=? AND project_id=? ORDER BY position,contact_id").all(org, projectId))
    .map(row => ({ contact_id: text(row.contact_id), role: text(row.role), primary: Number(row.is_primary) === 1 }));
}

export async function contactProjectIds(org: string, contactId: string) {
  return (await db().prepare("SELECT project_id FROM contact_links WHERE organization_id=? AND contact_id=? ORDER BY project_id").all(org, contactId)).map(r => text(r.project_id));
}

/** Replaces a project's links. Exactly one link is primary when there are any. */
export async function setProjectContactLinks(org: string, projectId: string, links: ContactLink[], store: SqlStore = db()) {
  const unique: ContactLink[] = [];
  for (const link of links) {
    const id = await resolveContactId(org, link.contact_id, store);
    if (!id) throw notFound("contact_not_found", "A linked contact is not available in this organization.");
    if (!unique.some(l => l.contact_id === id)) unique.push({ contact_id: id, role: text(link.role).slice(0, 80), primary: link.primary === true });
  }
  const primary = Math.max(0, unique.findIndex(l => l.primary));
  unique.forEach((link, index) => { link.primary = index === primary; });
  await store.transaction(async tx => {
    await tx.prepare("DELETE FROM contact_links WHERE organization_id=? AND project_id=?").run(org, projectId);
    for (const [position, link] of unique.entries()) await tx.prepare("INSERT INTO contact_links(organization_id,project_id,contact_id,role,is_primary,position,created_at) VALUES(?,?,?,?,?,?,?)")
      .run(org, projectId, link.contact_id, link.role, link.primary ? 1 : 0, position, now());
  }, `contact-links:${org}:${projectId}`);
  return unique;
}

/** The shape existing readers of `project.contacts` expect. Read-only; written only by this module. */
export function projectionContact(record: ContactRecord, link: ContactLink) {
  return {
    id: record.id, contact_id: record.id, contact_kind: record.contact_kind, name: record.name, first_name: record.first_name, last_name: record.last_name,
    email: record.email, phone: record.phone, phones: record.phones.map(p => p.value), emails: record.emails.map(p => p.value),
    address: record.address, default_address: record.address, role: link.role, company: record.company, notes: record.notes, birthday: record.birthday,
    tags: record.tags, time_zone: record.time_zone, profile_media_id: record.profile_media_id, custom_field_values: record.custom_field_values,
    imported_at: record.imported_at, import_id: record.import_id, import_source: record.import_source, primary: link.primary,
    contact_revision: record.revision
  };
}

export async function projectContactsProjection(org: string, projectId: string, store: SqlStore = db()) {
  const links = await projectContactLinks(org, projectId, store);
  const records = new Map((await loadRecords(store, org, links.map(l => l.contact_id))).map(r => [r.id, r]));
  const contacts = links.flatMap(link => { const r = records.get(link.contact_id); return r ? [projectionContact(r, link)] : []; });
  const primary = contacts.find(c => c.primary);
  return {
    contacts, contact_id: primary?.id || "", primary_contact_id: primary?.id || "", contact_ids: contacts.map(c => c.id),
    customer_name: primary?.name || "", primary_contact_name: primary?.name || "", customer_email: primary?.email || "",
    primary_contact_email: primary?.email || "", customer_phone: primary?.phone || "", primary_contact_phone: primary?.phone || ""
  };
}

/** Rewrites `project.contacts` on each project. A project that no longer exists loses its links. */
export async function refreshProjections(org: string, projectIds: string[]) {
  const storage = await import("../platform/storage.js");
  for (const projectId of [...new Set(projectIds)]) {
    try { await storage.upsertDocument(org, "projects", { id: projectId, data: await projectContactsProjection(org, projectId) }, { contactsProjection: true, mustExist: true }); }
    catch (error) {
      if ((error as { statusCode?: number })?.statusCode === 404 || (error as { code?: string })?.code === "document_missing") await setProjectContactLinks(org, projectId, []);
      else throw error;
    }
  }
}
