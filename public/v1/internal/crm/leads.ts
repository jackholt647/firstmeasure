import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import { env } from "../../src/config/env.js";
import { badRequest, notFound } from "../../platform/errors.js";
import { asObject, type JsonObject } from "./storage.js";

export const LEAD_FIELDS = [
  { key: "id", label: "Lead ID", type: "text", defaultVisible: false, sortable: true, filterable: true },
  { key: "company", label: "Company", type: "text", defaultVisible: true, sortable: true, filterable: true },
  { key: "lead_name", label: "Lead Name", type: "text", defaultVisible: true, sortable: true, filterable: true },
  { key: "status", label: "Status", type: "select", defaultVisible: true, sortable: true, filterable: true },
  { key: "phone", label: "Phone", type: "text", defaultVisible: true, sortable: true, filterable: true },
  { key: "email", label: "Email", type: "text", defaultVisible: true, sortable: true, filterable: true },
  { key: "website", label: "Website", type: "url", defaultVisible: true, sortable: true, filterable: true },
  { key: "address", label: "Address", type: "text", defaultVisible: true, sortable: true, filterable: true },
  { key: "city", label: "City", type: "text", defaultVisible: true, sortable: true, filterable: true },
  { key: "state", label: "State", type: "text", defaultVisible: true, sortable: true, filterable: true },
  { key: "postal_code", label: "Postal Code", type: "text", defaultVisible: false, sortable: true, filterable: true },
  { key: "region", label: "Region", type: "text", defaultVisible: true, sortable: true, filterable: true },
  { key: "region_code", label: "Region Code", type: "text", defaultVisible: false, sortable: true, filterable: true },
  { key: "source", label: "Source", type: "text", defaultVisible: false, sortable: true, filterable: true },
  { key: "assigned_to_email", label: "Assigned To", type: "email", defaultVisible: true, sortable: true, filterable: true },
  { key: "latest_call_at", label: "Most Recent Call", type: "date", defaultVisible: true, sortable: true, filterable: true },
  { key: "latest_export_at", label: "Most Recent Export", type: "date", defaultVisible: true, sortable: true, filterable: true },
  { key: "latest_note_at", label: "Most Recent Note", type: "date", defaultVisible: false, sortable: true, filterable: true },
  { key: "next_followup_at", label: "Next Follow-Up", type: "date", defaultVisible: true, sortable: true, filterable: true },
  { key: "notes_count", label: "Notes", type: "notes", defaultVisible: true, sortable: true, filterable: true },
  { key: "imported_at", label: "Import Date", type: "date", defaultVisible: true, sortable: true, filterable: true },
  { key: "created_at", label: "Created", type: "date", defaultVisible: false, sortable: true, filterable: true },
  { key: "updated_at", label: "Updated", type: "date", defaultVisible: false, sortable: true, filterable: true }
] as const;

const CUSTOM_FIELD_TYPES = new Set(["text", "number", "date", "select", "multiselect"]);

type LeadRow = JsonObject;
type ImportRow = JsonObject & { __row_index?: number };
type ImportMatch = { id: string; company?: unknown; email?: unknown; phone?: unknown; external_key?: unknown; reason: string };
type ImportPreviewRow = {
  row_index: number;
  status: "new" | "duplicate" | "unchanged" | "invalid";
  reason?: string;
  lead: ImportRow;
  matches: ImportMatch[];
};
type ImportBatch = {
  id: string;
  created_at: string;
  created_by_email: string;
  rows: ImportPreviewRow[];
  summary: JsonObject;
};

const LEAD_COLUMNS = [
  "id",
  "list_id",
  "region",
  "region_code",
  "status",
  "lead_name",
  "company",
  "email",
  "phone",
  "address",
  "city",
  "state",
  "postal_code",
  "notes",
  "source",
  "assigned_to_email",
  "metadata_json",
  "created_at",
  "updated_at",
  "created_by_email",
  "updated_by_email",
  "external_key",
  "website",
  "organization_id",
  "lead_entity_id",
  "imported_at",
  "imported_by_email",
  "import_hash",
  "last_import_changed_at",
  "last_import_unchanged_at"
] as const;

const ENTITY_COLUMNS = [
  "id",
  "organization_id",
  "external_key",
  "region",
  "region_code",
  "lead_name",
  "company",
  "email",
  "phone",
  "address",
  "city",
  "state",
  "postal_code",
  "website",
  "notes",
  "source",
  "metadata_json",
  "created_at",
  "updated_at",
  "created_by_email",
  "updated_by_email"
] as const;

const LEAD_LIST_COLUMNS = LEAD_COLUMNS.filter((column) => column !== "metadata_json");
const filterOptionsCache = new Map<string, { expires: number; value: JsonObject }>();
const EDITABLE_LEAD_COLUMNS = new Set(["status", "lead_name", "company", "email", "phone", "website", "address", "city", "state", "postal_code", "region", "region_code", "source", "assigned_to_email", "notes"]);
const EDITABLE_CONTACT_COLUMNS = new Set(["full_name", "title", "email", "phone", "notes"]);
const IMPORT_COMPARE_COLUMNS = ["region", "region_code", "status", "lead_name", "company", "email", "phone", "address", "city", "state", "postal_code", "notes", "source", "assigned_to_email", "external_key", "website"];
const IMPORT_KEY_ALIASES: Record<string, string> = {
  lead_id: "id",
  name: "lead_name",
  lead: "lead_name",
  business: "company",
  business_name: "company",
  zip: "postal_code",
  zip_code: "postal_code",
  assigned: "assigned_to_email",
  assigned_to: "assigned_to_email",
  assignee: "assigned_to_email",
  url: "website"
};

const SORT_SQL: Record<string, string> = {
  id: "lm.id",
  company: "lm.company",
  lead_name: "lm.lead_name",
  status: "lm.status",
  phone: "lm.phone",
  email: "lm.email",
  website: "lm.website",
  address: "lm.address",
  city: "lm.city",
  state: "lm.state",
  postal_code: "lm.postal_code",
  region: "lm.region",
  region_code: "lm.region_code",
  source: "lm.source",
  assigned_to_email: "COALESCE(lm.assigned_to_email, ll.assigned_to_email, '')",
  list_name: "ll.name",
  latest_call_at: "latest_call_at",
  latest_export_at: "latest_export_at",
  latest_note_at: "latest_note_at",
  next_followup_at: "next_followup_at",
  notes_count: "notes_count",
  contact_count: "contact_count",
  imported_at: "lm.imported_at",
  created_at: "lm.created_at",
  updated_at: "lm.updated_at"
};

function crmStorageRoot() {
  return path.resolve(process.cwd(), process.env.CRM_STORAGE_ROOT ?? env.crmStorageRoot);
}

function crmDbPath() {
  return path.join(crmStorageRoot(), "databases", "leads.sqlite");
}

function importRoot() {
  return path.join(crmStorageRoot(), "imports", "lead_batches");
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function nowIso() {
  return new Date().toISOString();
}

export async function ensureLeadDatabase() {
  await mkdir(path.dirname(crmDbPath()), { recursive: true });
  withLeadDb((db) => {
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS lead_entities (
        id TEXT PRIMARY KEY,
        organization_id TEXT DEFAULT '',
        external_key TEXT DEFAULT '',
        region TEXT DEFAULT '',
        region_code TEXT DEFAULT '',
        lead_name TEXT DEFAULT '',
        company TEXT DEFAULT '',
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        address TEXT DEFAULT '',
        city TEXT DEFAULT '',
        state TEXT DEFAULT '',
        postal_code TEXT DEFAULT '',
        website TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        source TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}',
        created_at INTEGER,
        updated_at INTEGER,
        created_by_email TEXT DEFAULT '',
        updated_by_email TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS lead_lists (
        id TEXT PRIMARY KEY,
        name TEXT DEFAULT '',
        region TEXT DEFAULT '',
        region_code TEXT DEFAULT '',
        description TEXT DEFAULT '',
        status TEXT DEFAULT 'active',
        sort_order INTEGER DEFAULT 0,
        metadata_json TEXT DEFAULT '{}',
        created_at INTEGER,
        updated_at INTEGER,
        created_by_email TEXT DEFAULT '',
        updated_by_email TEXT DEFAULT '',
        type TEXT DEFAULT '',
        source_kind TEXT DEFAULT '',
        source_key TEXT DEFAULT '',
        assigned_to_email TEXT DEFAULT '',
        assigned_by_email TEXT DEFAULT '',
        exported_at INTEGER,
        exported_by_email TEXT DEFAULT '',
        exported_count INTEGER DEFAULT 0,
        lead_count INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS lead_memberships (
        id TEXT PRIMARY KEY,
        list_id TEXT DEFAULT '',
        region TEXT DEFAULT '',
        region_code TEXT DEFAULT '',
        status TEXT DEFAULT 'new',
        lead_name TEXT DEFAULT '',
        company TEXT DEFAULT '',
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        address TEXT DEFAULT '',
        city TEXT DEFAULT '',
        state TEXT DEFAULT '',
        postal_code TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        source TEXT DEFAULT '',
        assigned_to_email TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}',
        created_at INTEGER,
        updated_at INTEGER,
        created_by_email TEXT DEFAULT '',
        updated_by_email TEXT DEFAULT '',
        external_key TEXT DEFAULT '',
        website TEXT DEFAULT '',
        organization_id TEXT DEFAULT '',
        lead_entity_id TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS lead_contacts (
        id TEXT PRIMARY KEY,
        lead_id TEXT,
        owner_email TEXT DEFAULT '',
        full_name TEXT DEFAULT '',
        title TEXT DEFAULT '',
        email TEXT DEFAULT '',
        phone TEXT DEFAULT '',
        notes TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER,
        created_by_email TEXT DEFAULT '',
        updated_by_email TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS lead_notes (
        id TEXT PRIMARY KEY,
        lead_id TEXT,
        owner_email TEXT DEFAULT '',
        note_text TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER,
        created_by_email TEXT DEFAULT '',
        updated_by_email TEXT DEFAULT '',
        dial_event_id TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS lead_contact_notes (
        id TEXT PRIMARY KEY,
        lead_id TEXT,
        contact_id TEXT,
        owner_email TEXT DEFAULT '',
        note_text TEXT DEFAULT '',
        created_at INTEGER,
        updated_at INTEGER,
        created_by_email TEXT DEFAULT '',
        updated_by_email TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS lead_followups (
        id TEXT PRIMARY KEY,
        lead_id TEXT,
        list_id TEXT DEFAULT '',
        owner_email TEXT DEFAULT '',
        title TEXT DEFAULT '',
        body TEXT DEFAULT '',
        due_at INTEGER,
        status TEXT DEFAULT 'open',
        priority TEXT DEFAULT '',
        completed_at INTEGER,
        created_at INTEGER,
        updated_at INTEGER,
        created_by_email TEXT DEFAULT '',
        updated_by_email TEXT DEFAULT '',
        dial_event_id TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS lead_dial_events (
        id TEXT PRIMARY KEY,
        lead_id TEXT,
        owner_email TEXT DEFAULT '',
        source TEXT DEFAULT '',
        context_json TEXT DEFAULT '{}',
        dialed_at INTEGER,
        created_at INTEGER,
        event_token TEXT DEFAULT '',
        selected_contact_id TEXT DEFAULT '',
        selected_contact_unknown INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS lead_activity_items (
        id TEXT PRIMARY KEY,
        lead_id TEXT,
        owner_email TEXT DEFAULT '',
        activity_type TEXT DEFAULT '',
        direction TEXT DEFAULT '',
        subject TEXT DEFAULT '',
        body_text TEXT DEFAULT '',
        related_id TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}',
        happened_at INTEGER DEFAULT 0,
        created_at INTEGER,
        updated_at INTEGER,
        created_by_email TEXT DEFAULT '',
        updated_by_email TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS lead_exports (
        id TEXT PRIMARY KEY,
        list_id TEXT,
        exported_by_email TEXT DEFAULT '',
        exported_at INTEGER,
        row_count INTEGER DEFAULT 0,
        metadata_json TEXT DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS lead_custom_fields (
        id TEXT PRIMARY KEY,
        field_key TEXT UNIQUE,
        label TEXT DEFAULT '',
        data_type TEXT DEFAULT 'text',
        topbar_filter INTEGER DEFAULT 0,
        options_json TEXT DEFAULT '[]',
        archived_at INTEGER,
        created_at INTEGER,
        updated_at INTEGER,
        created_by_email TEXT DEFAULT '',
        updated_by_email TEXT DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS lead_custom_values (
        lead_id TEXT,
        field_key TEXT,
        value_text TEXT DEFAULT '',
        value_number REAL,
        value_date INTEGER,
        updated_at INTEGER,
        updated_by_email TEXT DEFAULT '',
        PRIMARY KEY (lead_id, field_key)
      );
      CREATE INDEX IF NOT EXISTS idx_lead_memberships_company ON lead_memberships(company);
      CREATE INDEX IF NOT EXISTS idx_lead_memberships_assigned ON lead_memberships(assigned_to_email);
      CREATE INDEX IF NOT EXISTS idx_lead_memberships_status ON lead_memberships(status);
      CREATE INDEX IF NOT EXISTS idx_lead_memberships_region ON lead_memberships(region_code, region);
      CREATE INDEX IF NOT EXISTS idx_lead_memberships_external ON lead_memberships(external_key);
      CREATE INDEX IF NOT EXISTS idx_lead_memberships_email ON lead_memberships(email);
      CREATE INDEX IF NOT EXISTS idx_lead_memberships_phone ON lead_memberships(phone);
      CREATE INDEX IF NOT EXISTS idx_lead_memberships_updated ON lead_memberships(updated_at);
      CREATE INDEX IF NOT EXISTS idx_lead_dial_events_lead ON lead_dial_events(lead_id, dialed_at);
      CREATE INDEX IF NOT EXISTS idx_lead_activity_items_lead ON lead_activity_items(lead_id, happened_at);
      CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_lead_contact_notes_lead ON lead_contact_notes(lead_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_lead_exports_list ON lead_exports(list_id, exported_at);
      CREATE INDEX IF NOT EXISTS idx_lead_custom_values_field_text ON lead_custom_values(field_key, value_text);
      CREATE INDEX IF NOT EXISTS idx_lead_custom_values_field_number ON lead_custom_values(field_key, value_number);
      CREATE INDEX IF NOT EXISTS idx_lead_custom_values_field_date ON lead_custom_values(field_key, value_date);
    `);
    safeAddColumn(db, "lead_memberships", "imported_at", "INTEGER");
    safeAddColumn(db, "lead_memberships", "imported_by_email", "TEXT DEFAULT ''");
    safeAddColumn(db, "lead_memberships", "import_hash", "TEXT DEFAULT ''");
    safeAddColumn(db, "lead_memberships", "last_import_changed_at", "INTEGER");
    safeAddColumn(db, "lead_memberships", "last_import_unchanged_at", "INTEGER");
  });
}

export function withLeadDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(crmDbPath());
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function safeAddColumn(db: DatabaseSync, table: string, column: string, definition: string) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all() as LeadRow[];
  if (existing.some((row) => String(row.name) === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export async function queryLeads(body: JsonObject) {
  await ensureLeadDatabase();
  const customFields = await leadCustomFields();
  const page = Math.max(1, Math.floor(Number(body.page ?? 1)) || 1);
  const perPage = Math.max(1, Math.min(500, Math.floor(Number(body.per_page ?? body.limit ?? 100)) || 100));
  const offset = (page - 1) * perPage;
  const selection = asObject(body.selection);
  const selectionView = Boolean(body.selection_view) && Object.keys(selection).length > 0;

  if (selectionView) {
    return withLeadDb((db) => {
      const ids = resolveSelectionIds(db, selection, 200000, customFields);
      const pageIds = ids.slice(offset, offset + perPage);
      const order = new Map(pageIds.map((id, index) => [id, index]));
      const leads = fetchLeadsByIds(db, pageIds).sort((a, b) => (order.get(String(a.id)) ?? 0) - (order.get(String(b.id)) ?? 0));
      const summary = selectionSummary(db, selection, asObject(body.selection_summary_query), customFields);
      return {
        ok: true,
        success: true,
        leads: leads.map(normalizeRow),
        total: ids.length,
        page,
        per_page: perPage,
        total_pages: Math.max(1, Math.ceil(ids.length / perPage)),
        fields: LEAD_FIELDS,
        selection_summary: summary
      };
    });
  }

  const { whereSql, params } = buildLeadWhere(body, customFields);
  params.limit = perPage;
  params.offset = offset;

  const sortKey = String(body.sort ?? "updated_at");
  const sortSql = customSortSql(sortKey, customFields) ?? SORT_SQL[sortKey] ?? SORT_SQL.updated_at;
  const dir = String(body.dir ?? body.sort_dir ?? "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const querySql = `
    SELECT
      ${LEAD_LIST_COLUMNS.map((column) => `lm.${column}`).join(",\n      ")},
      ll.name AS list_name,
      ll.assigned_to_email AS list_assigned_to_email,
      COALESCE(lm.assigned_to_email, ll.assigned_to_email, '') AS effective_assigned_to_email,
      (SELECT COUNT(*) FROM lead_contacts c WHERE c.lead_id = lm.id) AS contact_count,
      (SELECT COUNT(*) FROM lead_notes n WHERE n.lead_id = lm.id) AS notes_count,
      (SELECT MAX(n.created_at) FROM lead_notes n WHERE n.lead_id = lm.id) AS latest_note_at,
      (SELECT substr(n.note_text, 1, 260) FROM lead_notes n WHERE n.lead_id = lm.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note_preview,
      (SELECT MAX(de.dialed_at) FROM lead_dial_events de WHERE de.lead_id = lm.id) AS latest_call_at,
      (SELECT MIN(fu.due_at) FROM lead_followups fu WHERE fu.lead_id = lm.id AND fu.status = 'open') AS next_followup_at,
      (SELECT COUNT(*) FROM lead_followups fu WHERE fu.lead_id = lm.id AND fu.status = 'open') AS open_followup_count,
      COALESCE((SELECT MAX(le.exported_at) FROM lead_exports le WHERE le.list_id = lm.list_id), ll.exported_at) AS latest_export_at,
      (SELECT json_group_object('custom_' || cv.field_key, COALESCE(cv.value_text, '')) FROM lead_custom_values cv WHERE cv.lead_id = lm.id) AS custom_values_json
    FROM lead_memberships lm
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${whereSql}
    ORDER BY ${sortSql} ${dir}, lm.id ASC
    LIMIT :limit OFFSET :offset
  `;

  return withLeadDb((db) => {
    const countParams = sqliteParams(`SELECT COUNT(*) AS total FROM lead_memberships lm LEFT JOIN lead_lists ll ON ll.id = lm.list_id ${whereSql}`, params);
    const total = Number(db.prepare(`SELECT COUNT(*) AS total FROM lead_memberships lm LEFT JOIN lead_lists ll ON ll.id = lm.list_id ${whereSql}`).get(countParams as any)?.total ?? 0);
    const leads = db.prepare(querySql).all(sqliteParams(querySql, params) as any) as LeadRow[];
    const summary = Object.keys(selection).length > 0 ? selectionSummary(db, selection, body, customFields) : undefined;
    return {
      ok: true,
      success: true,
      leads: leads.map(normalizeRow),
      total,
      page,
      per_page: perPage,
      total_pages: Math.max(1, Math.ceil(total / perPage)),
      fields: [...LEAD_FIELDS, ...customFields],
      ...(summary ? { selection_summary: summary } : {})
    };
  });
}

export async function exportSelectedLeads(body: JsonObject) {
  await ensureLeadDatabase();
  const customFields = await leadCustomFields();
  const selection = asObject(body.selection);
  const fields = Array.isArray(body.fields) ? body.fields.map((field) => String(field)).filter(Boolean) : [...LEAD_FIELDS, ...customFields].map((field) => String(field.key));
  return withLeadDb((db) => {
    const ids = resolveSelectionIds(db, selection, 100000, customFields);
    const rows = fetchLeadsByIds(db, ids);
    const csv = leadRowsToCsv(rows, fields, customFields);
    return { ok: true, success: true, count: rows.length, filename: `leads-${new Date().toISOString().slice(0, 10)}.csv`, csv };
  });
}

export async function reassignSelectedLeads(body: JsonObject) {
  await ensureLeadDatabase();
  const customFields = await leadCustomFields();
  if (!body.manager) throw badRequest("manager_required", "Only managers can reassign leads.");
  const assignees = Array.isArray(body.assignees)
    ? body.assignees.map((email) => String(email ?? "").trim().toLowerCase()).filter(Boolean)
    : [];
  if (!assignees.length) throw badRequest("missing_assignees", "Choose at least one assignee.");
  const actorEmail = String(body.actor_email ?? "").trim().toLowerCase();
  const selection = asObject(body.selection);
  const dryRun = body.dry_run !== false;
  return withLeadDb((db) => {
    const ids = resolveSelectionIds(db, selection, 200000, customFields);
    const preview = distributeIds(ids, assignees);
    if (dryRun) return { ok: true, success: true, dry_run: true, total: ids.length, assignees: preview.map((group) => ({ email: group.email, count: group.count })) };
    const now = nowUnix();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const group of preview) {
        if (!group.ids.length) continue;
        for (const chunk of chunks(group.ids, 500)) {
          const params: JsonObject = { assigned_to_email: group.email, updated_at: now, updated_by_email: actorEmail };
          const placeholders = chunk.map((id, index) => {
            params[`id_${index}`] = id;
            return `:id_${index}`;
          });
          db.prepare(`UPDATE lead_memberships SET assigned_to_email = :assigned_to_email, updated_at = :updated_at, updated_by_email = :updated_by_email WHERE id IN (${placeholders.join(", ")})`).run(params as any);
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    filterOptionsCache.clear();
    return { ok: true, success: true, dry_run: false, total: ids.length, assignees: preview.map((group) => ({ email: group.email, count: group.count })) };
  });
}

export async function leadFilterOptions(body: JsonObject) {
  await ensureLeadDatabase();
  const customFields = await leadCustomFields();
  const cacheKey = `${Boolean(body.manager) || String(body.scope ?? "").toLowerCase() === "all" ? "all" : "mine"}:${String(body.actor_email ?? body.email ?? "").trim().toLowerCase()}`;
  const cached = filterOptionsCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  const params: JsonObject = {};
  const where: string[] = ["1=1"];
  applyViewerScope(where, params, body, "lm", "ll");
  const whereSql = `WHERE ${where.join(" AND ")}`;
  const value = withLeadDb((db) => {
    const assigned = distinctRows(db, `
      SELECT LOWER(COALESCE(lm.assigned_to_email, ll.assigned_to_email, '')) AS value, COUNT(*) AS count
      FROM lead_memberships lm
      LEFT JOIN lead_lists ll ON ll.id = lm.list_id
      ${whereSql}
      GROUP BY value
      HAVING value <> ''
      ORDER BY value ASC
      LIMIT 500
    `, params);
    const unassignedCount = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM lead_memberships lm
      LEFT JOIN lead_lists ll ON ll.id = lm.list_id
      ${whereSql}
      AND COALESCE(lm.assigned_to_email, ll.assigned_to_email, '') = ''
    `).get(sqliteParams(`
      SELECT COUNT(*) AS count
      FROM lead_memberships lm
      LEFT JOIN lead_lists ll ON ll.id = lm.list_id
      ${whereSql}
      AND COALESCE(lm.assigned_to_email, ll.assigned_to_email, '') = ''
    `, params) as any)?.count ?? 0);
    if (unassignedCount > 0) {
      assigned.unshift({ value: "__unassigned__", label: "Unassigned", count: unassignedCount });
    }
    const statuses = distinctRows(db, `
      SELECT lm.status AS value, COUNT(*) AS count
      FROM lead_memberships lm
      LEFT JOIN lead_lists ll ON ll.id = lm.list_id
      ${whereSql}
      GROUP BY value
      HAVING value <> ''
      ORDER BY count DESC, value ASC
      LIMIT 200
    `, params);
    const noStatusCount = blankCount(db, whereSql, params, "lm.status");
    if (noStatusCount > 0) statuses.push({ value: "__none__", label: "No status", count: noStatusCount });
    const regions = distinctRows(db, `
      SELECT COALESCE(NULLIF(lm.region, ''), lm.region_code) AS value, lm.region_code AS code, COUNT(*) AS count
      FROM lead_memberships lm
      LEFT JOIN lead_lists ll ON ll.id = lm.list_id
      ${whereSql}
      GROUP BY value, code
      HAVING value <> ''
      ORDER BY value ASC
      LIMIT 500
    `, params);
    const noRegionCount = Number(db.prepare(`
      SELECT COUNT(*) AS count
      FROM lead_memberships lm
      LEFT JOIN lead_lists ll ON ll.id = lm.list_id
      ${whereSql}
      AND COALESCE(lm.region, '') = ''
      AND COALESCE(lm.region_code, '') = ''
    `).get(sqliteParams(`
      SELECT COUNT(*) AS count
      FROM lead_memberships lm
      LEFT JOIN lead_lists ll ON ll.id = lm.list_id
      ${whereSql}
      AND COALESCE(lm.region, '') = ''
      AND COALESCE(lm.region_code, '') = ''
    `, params) as any)?.count ?? 0);
    if (noRegionCount > 0) regions.push({ value: "__none__", label: "No region", count: noRegionCount });
    const dispositions = dispositionOptions(db, whereSql, params);
    const noDispositionCount = noDispositionLeadCount(db, whereSql, params);
    if (noDispositionCount > 0) dispositions.push({ value: "__none__", label: "No disposition", count: noDispositionCount });
    return {
      ok: true,
      success: true,
      cached: false,
      options: {
        assigned_to_email: assigned,
        status: statuses,
        region: regions,
        disposition: dispositions,
        custom: Object.fromEntries(customFields.filter((field) => field.topbarFilter || field.filterable).map((field) => [field.key, customFilterOptions(db, field, whereSql, params)]))
      }
    };
  });
  filterOptionsCache.set(cacheKey, { expires: Date.now() + 60_000, value });
  return value;
}

export async function leadDetail(leadId: string) {
  await ensureLeadDatabase();
  return withLeadDb((db) => {
    const lead = db.prepare(`
      SELECT lm.*, ll.name AS list_name, ll.assigned_to_email AS list_assigned_to_email,
        (SELECT json_group_object('custom_' || cv.field_key, COALESCE(cv.value_text, '')) FROM lead_custom_values cv WHERE cv.lead_id = lm.id) AS custom_values_json
      FROM lead_memberships lm
      LEFT JOIN lead_lists ll ON ll.id = lm.list_id
      WHERE lm.id = :id
      LIMIT 1
    `).get({ id: leadId } as any) as LeadRow | undefined;
    if (!lead) throw notFound("lead_not_found", "The requested lead was not found.");
    return {
      ok: true,
      success: true,
      lead: normalizeRow(lead),
      contacts: rows(db, "SELECT * FROM lead_contacts WHERE lead_id = :id ORDER BY updated_at DESC LIMIT 100", { id: leadId }),
      notes: rows(db, "SELECT * FROM lead_notes WHERE lead_id = :id ORDER BY created_at DESC LIMIT 100", { id: leadId }),
      followups: rows(db, "SELECT * FROM lead_followups WHERE lead_id = :id ORDER BY due_at ASC LIMIT 100", { id: leadId }),
      dial_events: rows(db, "SELECT * FROM lead_dial_events WHERE lead_id = :id ORDER BY dialed_at DESC LIMIT 100", { id: leadId })
    };
  });
}

export async function leadFields() {
  await ensureLeadDatabase();
  return {
    ok: true,
    success: true,
    fields: [...LEAD_FIELDS, ...await leadCustomFields()]
  };
}

export async function createLeadCustomField(body: JsonObject) {
  await ensureLeadDatabase();
  const label = String(body.label ?? "").trim();
  if (!label) throw badRequest("missing_label", "Column name is required.");
  const dataType = String(body.data_type ?? body.type ?? "text").trim().toLowerCase();
  if (!CUSTOM_FIELD_TYPES.has(dataType)) throw badRequest("invalid_type", "Custom column type is invalid.");
  const now = nowUnix();
  const options = normalizeCustomOptions(body.options);
  const actor = String(body.actor_email ?? "").trim().toLowerCase();
  return withLeadDb((db) => {
    const fieldKey = uniqueCustomFieldKey(db, label);
    db.prepare(`
      INSERT INTO lead_custom_fields (id, field_key, label, data_type, topbar_filter, options_json, created_at, updated_at, created_by_email, updated_by_email)
      VALUES (:id, :field_key, :label, :data_type, :topbar_filter, :options_json, :created_at, :updated_at, :created_by_email, :updated_by_email)
    `).run({
      id: `custom_field_${randomBytes(10).toString("hex")}`,
      field_key: fieldKey,
      label,
      data_type: dataType,
      topbar_filter: body.topbar_filter ? 1 : 0,
      options_json: JSON.stringify(options),
      created_at: now,
      updated_at: now,
      created_by_email: actor,
      updated_by_email: actor
    } as any);
    filterOptionsCache.clear();
    return { ok: true, success: true, field: customFieldRowToField(db.prepare("SELECT * FROM lead_custom_fields WHERE field_key = :field_key").get({ field_key: fieldKey } as any) as LeadRow) };
  });
}

export async function updateLeadCustomField(fieldKeyOrId: string, body: JsonObject) {
  await ensureLeadDatabase();
  const now = nowUnix();
  const actor = String(body.actor_email ?? "").trim().toLowerCase();
  return withLeadDb((db) => {
    const current = findCustomField(db, fieldKeyOrId);
    if (!current) throw notFound("custom_field_not_found", "Custom column was not found.");
    const label = String(body.label ?? current.label ?? "").trim();
    const dataType = String(body.data_type ?? body.type ?? current.data_type ?? "text").trim().toLowerCase();
    if (!label) throw badRequest("missing_label", "Column name is required.");
    if (!CUSTOM_FIELD_TYPES.has(dataType)) throw badRequest("invalid_type", "Custom column type is invalid.");
    const options = body.options === undefined ? parseJsonArray(current.options_json) : normalizeCustomOptions(body.options);
    db.prepare(`
      UPDATE lead_custom_fields
      SET label = :label, data_type = :data_type, topbar_filter = :topbar_filter, options_json = :options_json, updated_at = :updated_at, updated_by_email = :updated_by_email
      WHERE id = :id
    `).run({
      id: current.id,
      label,
      data_type: dataType,
      topbar_filter: body.topbar_filter ? 1 : 0,
      options_json: JSON.stringify(options),
      updated_at: now,
      updated_by_email: actor
    } as any);
    filterOptionsCache.clear();
    return { ok: true, success: true, field: customFieldRowToField(db.prepare("SELECT * FROM lead_custom_fields WHERE id = :id").get({ id: current.id } as any) as LeadRow) };
  });
}

export async function deleteLeadCustomField(fieldKeyOrId: string, body: JsonObject = {}) {
  await ensureLeadDatabase();
  const now = nowUnix();
  const actor = String(body.actor_email ?? "").trim().toLowerCase();
  return withLeadDb((db) => {
    const current = findCustomField(db, fieldKeyOrId);
    if (!current) throw notFound("custom_field_not_found", "Custom column was not found.");
    db.prepare("UPDATE lead_custom_fields SET archived_at = :archived_at, updated_at = :updated_at, updated_by_email = :updated_by_email WHERE id = :id")
      .run({ id: current.id, archived_at: now, updated_at: now, updated_by_email: actor } as any);
    filterOptionsCache.clear();
    return { ok: true, success: true, deleted: true };
  });
}

export async function updateLeadRecord(leadId: string, body: JsonObject) {
  await ensureLeadDatabase();
  const actor = String(body.actor_email ?? "").trim().toLowerCase();
  const leadPatch = asObject(body.lead ?? body);
  const customPatch = asObject(body.custom_values);
  const now = nowUnix();
  return withLeadDb((db) => {
    const current = db.prepare("SELECT id FROM lead_memberships WHERE id = :id LIMIT 1").get({ id: leadId } as any);
    if (!current) throw notFound("lead_not_found", "The requested lead was not found.");
    const params: JsonObject = { id: leadId, updated_at: now, updated_by_email: actor };
    const assignments: string[] = [];
    for (const [key, value] of Object.entries(leadPatch)) {
      if (!EDITABLE_LEAD_COLUMNS.has(key)) continue;
      assignments.push(`${key} = :${key}`);
      params[key] = key === "email" ? String(value ?? "").trim().toLowerCase() : normalizeLeadValue(value);
    }
    if (assignments.length) {
      assignments.push("updated_at = :updated_at", "updated_by_email = :updated_by_email");
      db.prepare(`UPDATE lead_memberships SET ${assignments.join(", ")} WHERE id = :id`).run(params as any);
    }
    if (Object.keys(customPatch).length) saveCustomValues(db, leadId, customPatch, actor, now);
    filterOptionsCache.clear();
    return leadViewer(leadId);
  });
}

export async function updateLeadContact(leadId: string, contactId: string, body: JsonObject) {
  await ensureLeadDatabase();
  const actor = String(body.actor_email ?? "").trim().toLowerCase();
  const patch = asObject(body.contact ?? body);
  const now = nowUnix();
  return withLeadDb((db) => {
    const current = db.prepare("SELECT id FROM lead_contacts WHERE id = :id AND lead_id = :lead_id LIMIT 1").get({ id: contactId, lead_id: leadId } as any);
    if (!current) throw notFound("contact_not_found", "The requested contact was not found.");
    const params: JsonObject = { id: contactId, lead_id: leadId, updated_at: now, updated_by_email: actor };
    const assignments: string[] = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!EDITABLE_CONTACT_COLUMNS.has(key)) continue;
      assignments.push(`${key} = :${key}`);
      params[key] = key === "email" ? String(value ?? "").trim().toLowerCase() : normalizeLeadValue(value);
    }
    if (assignments.length) {
      assignments.push("updated_at = :updated_at", "updated_by_email = :updated_by_email");
      db.prepare(`UPDATE lead_contacts SET ${assignments.join(", ")} WHERE id = :id AND lead_id = :lead_id`).run(params as any);
      touchLead(db, leadId, actor, now);
    }
    return leadViewer(leadId);
  });
}

export async function addLeadNote(leadId: string, body: JsonObject) {
  await ensureLeadDatabase();
  const text = String(body.note_text ?? body.text ?? "").trim();
  if (!text) throw badRequest("missing_note", "Note text is required.");
  const actor = String(body.actor_email ?? body.owner_email ?? "").trim().toLowerCase();
  const now = nowUnix();
  return withLeadDb((db) => {
    ensureLeadExists(db, leadId);
    db.prepare(`
      INSERT INTO lead_notes (id, lead_id, owner_email, note_text, created_at, updated_at, created_by_email, updated_by_email)
      VALUES (:id, :lead_id, :owner_email, :note_text, :created_at, :updated_at, :created_by_email, :updated_by_email)
    `).run({ id: `note_${randomBytes(8).toString("hex")}`, lead_id: leadId, owner_email: actor, note_text: text, created_at: now, updated_at: now, created_by_email: actor, updated_by_email: actor } as any);
    touchLead(db, leadId, actor, now);
    return leadViewer(leadId);
  });
}

export async function addLeadFollowup(leadId: string, body: JsonObject) {
  await ensureLeadDatabase();
  const title = String(body.title ?? "").trim();
  const bodyText = String(body.body ?? body.body_text ?? "").trim();
  const dueAt = parseDateish(body.due_at ?? body.due_date);
  if (!title && !bodyText) throw badRequest("missing_followup", "Follow-up text is required.");
  const actor = String(body.actor_email ?? body.owner_email ?? "").trim().toLowerCase();
  const now = nowUnix();
  return withLeadDb((db) => {
    ensureLeadExists(db, leadId);
    db.prepare(`
      INSERT INTO lead_followups (id, lead_id, owner_email, title, body, due_at, status, priority, created_at, updated_at, created_by_email, updated_by_email)
      VALUES (:id, :lead_id, :owner_email, :title, :body, :due_at, :status, :priority, :created_at, :updated_at, :created_by_email, :updated_by_email)
    `).run({ id: `followup_${randomBytes(8).toString("hex")}`, lead_id: leadId, owner_email: actor, title: title || bodyText.slice(0, 80), body: bodyText, due_at: dueAt || null, status: String(body.status ?? "open"), priority: String(body.priority ?? ""), created_at: now, updated_at: now, created_by_email: actor, updated_by_email: actor } as any);
    touchLead(db, leadId, actor, now);
    return leadViewer(leadId);
  });
}

export async function addLeadContactNote(leadId: string, contactId: string, body: JsonObject) {
  await ensureLeadDatabase();
  const text = String(body.note_text ?? body.text ?? "").trim();
  if (!text) throw badRequest("missing_note", "Note text is required.");
  const actor = String(body.actor_email ?? body.owner_email ?? "").trim().toLowerCase();
  const now = nowUnix();
  return withLeadDb((db) => {
    ensureLeadExists(db, leadId);
    const contact = db.prepare("SELECT id FROM lead_contacts WHERE id = :id AND lead_id = :lead_id LIMIT 1").get({ id: contactId, lead_id: leadId } as any);
    if (!contact) throw notFound("contact_not_found", "The requested contact was not found.");
    db.prepare(`
      INSERT INTO lead_contact_notes (id, lead_id, contact_id, owner_email, note_text, created_at, updated_at, created_by_email, updated_by_email)
      VALUES (:id, :lead_id, :contact_id, :owner_email, :note_text, :created_at, :updated_at, :created_by_email, :updated_by_email)
    `).run({ id: `contact_note_${randomBytes(8).toString("hex")}`, lead_id: leadId, contact_id: contactId, owner_email: actor, note_text: text, created_at: now, updated_at: now, created_by_email: actor, updated_by_email: actor } as any);
    touchLead(db, leadId, actor, now);
    return leadViewer(leadId);
  });
}

export async function leadViewer(leadId: string) {
  await ensureLeadDatabase();
  return withLeadDb((db) => {
    const lead = db.prepare(`
      SELECT
        ${LEAD_LIST_COLUMNS.map((column) => `lm.${column}`).join(",\n        ")},
        ll.name AS legacy_list_name,
        ll.exported_at AS legacy_list_exported_at,
        COALESCE(lm.assigned_to_email, ll.assigned_to_email, '') AS effective_assigned_to_email,
        (SELECT MAX(de.dialed_at) FROM lead_dial_events de WHERE de.lead_id = lm.id) AS latest_call_at,
        COALESCE((SELECT MAX(le.exported_at) FROM lead_exports le WHERE le.list_id = lm.list_id), ll.exported_at) AS latest_export_at,
        (SELECT json_group_object('custom_' || cv.field_key, COALESCE(cv.value_text, '')) FROM lead_custom_values cv WHERE cv.lead_id = lm.id) AS custom_values_json
      FROM lead_memberships lm
      LEFT JOIN lead_lists ll ON ll.id = lm.list_id
      WHERE lm.id = :id
      LIMIT 1
    `).get({ id: leadId } as any) as LeadRow | undefined;
    if (!lead) throw notFound("lead_not_found", "The requested lead was not found.");
    return {
      ok: true,
      success: true,
      lead: normalizeRow(lead),
      contacts: rows(db, "SELECT id, full_name, title, email, phone, notes, updated_at, created_at FROM lead_contacts WHERE lead_id = :id ORDER BY updated_at DESC LIMIT 100", { id: leadId }),
      notes: rows(db, "SELECT id, owner_email, note_text, created_at, updated_at FROM lead_notes WHERE lead_id = :id ORDER BY created_at DESC LIMIT 100", { id: leadId }),
      contact_notes: rows(db, "SELECT id, contact_id, owner_email, note_text, created_at, updated_at FROM lead_contact_notes WHERE lead_id = :id ORDER BY created_at DESC LIMIT 100", { id: leadId }),
      followups: rows(db, "SELECT id, owner_email, title, body, due_at, status, priority, completed_at FROM lead_followups WHERE lead_id = :id ORDER BY due_at ASC LIMIT 100", { id: leadId }),
      activity: rows(db, "SELECT id, owner_email, activity_type, direction, subject, body_text, happened_at FROM lead_activity_items WHERE lead_id = :id ORDER BY happened_at DESC LIMIT 100", { id: leadId }),
      dial_events: rows(db, "SELECT id, owner_email, source, dialed_at, created_at, selected_contact_id FROM lead_dial_events WHERE lead_id = :id ORDER BY dialed_at DESC LIMIT 100", { id: leadId }),
      exports: rows(db, "SELECT le.id, le.exported_by_email, le.exported_at, le.row_count FROM lead_exports le JOIN lead_memberships lm ON lm.list_id = le.list_id WHERE lm.id = :id ORDER BY le.exported_at DESC LIMIT 50", { id: leadId })
    };
  });
}


export async function previewLeadImport(body: JsonObject) {
  await ensureLeadDatabase();
  const customFields = await leadCustomFields();
  const rawRows = Array.isArray(body.rows) ? body.rows : [];
  if (!rawRows.length) throw badRequest("empty_import", "Import preview requires at least one row.");
  if (rawRows.length > 25000) throw badRequest("import_too_large", "Import preview is limited to 25,000 rows at a time.");
  const createdBy = String(body.actor_email ?? body.created_by_email ?? "").trim().toLowerCase();
  const normalizedRows = rawRows.map((row, index) => normalizeLeadInput(asObject(row), index, customFields));
  const previewRows = withLeadDb((db) => normalizedRows.map((lead, index) => previewOne(db, lead, index)));
  const importId = `lead_import_${randomBytes(10).toString("hex")}`;
  const summary = {
    total: previewRows.length,
    new_count: previewRows.filter((row) => row.status === "new").length,
    duplicate_count: previewRows.filter((row) => row.status === "duplicate").length,
    unchanged_count: previewRows.filter((row) => row.status === "unchanged").length,
    invalid_count: previewRows.filter((row) => row.status === "invalid").length
  };
  const batch: ImportBatch = { id: importId, created_at: nowIso(), created_by_email: createdBy, rows: previewRows, summary };
  await writeImportBatch(batch);
  return { ok: true, success: true, import_id: importId, summary, rows: previewRows.slice(0, 500), returned_rows: Math.min(500, previewRows.length) };
}

export async function commitLeadImport(importId: string, body: JsonObject) {
  await ensureLeadDatabase();
  const batch = await readImportBatch(importId);
  const decisions = asObject(body.decisions);
  const defaultAction = String(body.default_action ?? "skip").toLowerCase();
  const newAction = String(body.new_action ?? "create").toLowerCase();
  const duplicateAction = String(body.duplicate_action ?? defaultAction).toLowerCase();
  const unchangedAction = String(body.unchanged_action ?? "skip").toLowerCase();
  const actorEmail = String(body.actor_email ?? batch.created_by_email ?? "").trim().toLowerCase();
  const listId = String(body.list_id ?? "").trim();
  const counts = { created: 0, updated: 0, unchanged: 0, skipped: 0, invalid: 0 };

  withLeadDb((db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const targetListId = listId || ensureImportList(db, actorEmail);
      for (const row of batch.rows) {
        if (row.status === "invalid") {
          counts.invalid += 1;
          continue;
        }
        const decision = asObject(decisions[String(row.row_index)] ?? decisions[row.row_index]);
        const action = String(decision.action ?? (row.status === "new" ? newAction : row.status === "unchanged" ? unchangedAction : duplicateAction)).toLowerCase();
        if (action === "skip") {
          counts.skipped += 1;
          continue;
        }
        if ((action === "touch" || action === "sync") && row.matches[0]) {
          touchImport(db, String(decision.match_id ?? row.matches[0].id), actorEmail, nowUnix());
          counts.unchanged += 1;
          continue;
        }
        if (action === "update" && row.matches[0]) {
          updateLead(db, String(decision.match_id ?? row.matches[0].id), row.lead, actorEmail);
          counts.updated += 1;
          continue;
        }
        createLead(db, row.lead, targetListId, actorEmail);
        counts.created += 1;
      }
      refreshListCounts(db);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
  await rm(importBatchPath(importId), { force: true });
  return { ok: true, success: true, import_id: importId, counts };
}

function previewOne(db: DatabaseSync, lead: ImportRow, index: number): ImportPreviewRow {
  if (!String(lead.company ?? lead.lead_name ?? lead.email ?? lead.phone ?? "").trim()) {
    return { row_index: index, status: "invalid", reason: "Missing company, lead name, email, or phone.", lead, matches: [] };
  }
  const matches = findDuplicateMatches(db, lead);
  const firstMatch = matches[0];
  if (firstMatch && isImportUnchanged(db, firstMatch.id, lead)) return { row_index: index, status: "unchanged", lead, matches };
  return { row_index: index, status: matches.length ? "duplicate" : "new", lead, matches };
}

function findDuplicateMatches(db: DatabaseSync, lead: ImportRow): ImportMatch[] {
  const id = String(lead.id ?? "").trim();
  const externalKey = String(lead.external_key ?? "").trim();
  const email = String(lead.email ?? "").trim().toLowerCase();
  const phone = normalizePhone(lead.phone);
  const company = normalizeText(lead.company);
  const matches = new Map<string, ImportMatch>();
  if (id) addMatches(matches, db.prepare("SELECT id, company, email, phone, external_key FROM lead_memberships WHERE id = :id LIMIT 1").all({ id } as any) as LeadRow[], "id");
  if (externalKey) addMatches(matches, db.prepare("SELECT id, company, email, phone, external_key FROM lead_memberships WHERE external_key = :external_key LIMIT 10").all({ external_key: externalKey } as any) as LeadRow[], "external_key");
  if (email && company) addMatches(matches, db.prepare("SELECT id, company, email, phone, external_key FROM lead_memberships WHERE LOWER(email) = :email AND LOWER(company) = :company LIMIT 10").all({ email, company } as any) as LeadRow[], "email_company");
  if (phone && company) {
    const candidates = db.prepare("SELECT id, company, email, phone, external_key FROM lead_memberships WHERE LOWER(company) = :company AND phone <> '' LIMIT 200").all({ company } as any) as LeadRow[];
    addMatches(matches, candidates.filter((row) => normalizePhone(row.phone) === phone), "phone_company");
  }
  return [...matches.values()];
}

function addMatches(matches: Map<string, ImportMatch>, rowsToAdd: LeadRow[], reason: string) {
  for (const row of rowsToAdd) {
    const id = String(row.id ?? "");
    if (!id || matches.has(id)) continue;
    matches.set(id, { id, company: row.company, email: row.email, phone: row.phone, external_key: row.external_key, reason });
  }
}

function createLead(db: DatabaseSync, input: ImportRow, listId: string, actorEmail: string) {
  const now = nowUnix();
  const id = `lead_${randomBytes(8).toString("hex")}`;
  const values = rowValues({ ...input, id, list_id: input.list_id || listId, lead_entity_id: id, status: input.status || "new", created_at: now, updated_at: now, created_by_email: actorEmail, updated_by_email: actorEmail, imported_at: now, imported_by_email: actorEmail, import_hash: importHash(input), last_import_changed_at: now });
  const placeholders = LEAD_COLUMNS.map((column) => `:${column}`).join(", ");
  db.prepare(`INSERT INTO lead_memberships (${LEAD_COLUMNS.join(", ")}) VALUES (${placeholders})`).run(rowValues(values) as any);
  const entityValues = rowValues({ ...values, id, created_at: now, updated_at: now }, ENTITY_COLUMNS);
  db.prepare(`INSERT OR IGNORE INTO lead_entities (${ENTITY_COLUMNS.join(", ")}) VALUES (${ENTITY_COLUMNS.map((column) => `:${column}`).join(", ")})`).run(entityValues as any);
  saveCustomValues(db, id, asObject(input.custom_values), actorEmail, now);
}

function updateLead(db: DatabaseSync, id: string, input: ImportRow, actorEmail: string) {
  const now = nowUnix();
  const current = db.prepare("SELECT * FROM lead_memberships WHERE id = :id LIMIT 1").get({ id } as any) as LeadRow | undefined;
  if (!current) return;
  const values = rowValues({ ...current, ...input, id, updated_at: now, updated_by_email: actorEmail || current.updated_by_email });
  values.imported_at = now;
  values.imported_by_email = actorEmail;
  values.import_hash = importHash(input);
  values.last_import_changed_at = now;
  const assignments = LEAD_COLUMNS.filter((column) => column !== "id" && column !== "created_at" && column !== "created_by_email").map((column) => `${column} = :${column}`).join(", ");
  const updateSql = `UPDATE lead_memberships SET ${assignments} WHERE id = :id`;
  db.prepare(updateSql).run(sqliteParams(updateSql, values) as any);
  saveCustomValues(db, id, asObject(input.custom_values), actorEmail, now);
}

function touchImport(db: DatabaseSync, id: string, actorEmail: string, now: number) {
  db.prepare(`
    UPDATE lead_memberships
    SET imported_at = :imported_at,
      imported_by_email = :imported_by_email,
      last_import_unchanged_at = :last_import_unchanged_at
    WHERE id = :id
  `).run({ id, imported_at: now, imported_by_email: actorEmail, last_import_unchanged_at: now } as any);
}

function isImportUnchanged(db: DatabaseSync, id: string, lead: ImportRow) {
  const current = db.prepare("SELECT * FROM lead_memberships WHERE id = :id LIMIT 1").get({ id } as any) as LeadRow | undefined;
  if (!current) return false;
  if (String(current.import_hash || "") === importHash(lead)) return true;
  const presentKeys = new Set(Array.isArray(lead.__present_keys) ? lead.__present_keys.map((key) => String(key)) : Object.keys(lead));
  const compareColumns = IMPORT_COMPARE_COLUMNS.filter((column) => presentKeys.has(column));
  for (const column of compareColumns) {
    if (String(current[column] ?? "").trim() !== String(lead[column] ?? "").trim()) return false;
  }
  const customValues = asObject(lead.custom_values);
  for (const [fieldKey, value] of Object.entries(customValues)) {
    const row = db.prepare("SELECT value_text FROM lead_custom_values WHERE lead_id = :lead_id AND field_key = :field_key LIMIT 1").get({ lead_id: id, field_key: fieldKey } as any) as LeadRow | undefined;
    if (String(row?.value_text ?? "").trim() !== String(value ?? "").trim()) return false;
  }
  return true;
}

function importHash(lead: JsonObject) {
  const picked: JsonObject = {};
  const presentKeys = new Set(Array.isArray(lead.__present_keys) ? lead.__present_keys.map((key) => String(key)) : IMPORT_COMPARE_COLUMNS);
  for (const key of IMPORT_COMPARE_COLUMNS) {
    if (!presentKeys.has(key)) continue;
    picked[key] = String(lead[key] ?? "").trim();
  }
  picked.custom_values = asObject(lead.custom_values);
  return Buffer.from(JSON.stringify(picked)).toString("base64url");
}

function rowValues(input: JsonObject, columns: readonly string[] = LEAD_COLUMNS) {
  const out: JsonObject = {};
  for (const column of columns) out[column] = column === "metadata_json" ? JSON.stringify(asObject(input.metadata ?? input.metadata_json)) : input[column] ?? "";
  return out;
}

function customImportValues(input: JsonObject, customFields: JsonObject[]) {
  const out: JsonObject = {};
  const normalizedInput = new Map(Object.entries(input).map(([key, value]) => [normalizeHeaderKey(key), value]));
  for (const field of customFields) {
    const customKey = String(field.customKey ?? "");
    const candidates = [
      normalizeHeaderKey(String(field.key ?? "")),
      normalizeHeaderKey(customKey),
      normalizeHeaderKey(String(field.label ?? ""))
    ].filter(Boolean);
    for (const candidate of candidates) {
      if (normalizedInput.has(candidate)) {
        const value = normalizeLeadValue(normalizedInput.get(candidate));
        if (String(value ?? "").trim()) out[customKey] = value;
        break;
      }
    }
  }
  return out;
}

function saveCustomValues(db: DatabaseSync, leadId: string, values: JsonObject, actorEmail: string, now: number) {
  for (const [fieldKey, raw] of Object.entries(values)) {
    const key = String(fieldKey ?? "").trim();
    if (!key) continue;
    const field = db.prepare("SELECT * FROM lead_custom_fields WHERE field_key = :field_key AND archived_at IS NULL LIMIT 1").get({ field_key: key } as any) as LeadRow | undefined;
    if (!field) continue;
    const typed = typedCustomValue(raw, String(field.data_type ?? "text"));
    db.prepare(`
      INSERT INTO lead_custom_values (lead_id, field_key, value_text, value_number, value_date, updated_at, updated_by_email)
      VALUES (:lead_id, :field_key, :value_text, :value_number, :value_date, :updated_at, :updated_by_email)
      ON CONFLICT(lead_id, field_key) DO UPDATE SET
        value_text = excluded.value_text,
        value_number = excluded.value_number,
        value_date = excluded.value_date,
        updated_at = excluded.updated_at,
        updated_by_email = excluded.updated_by_email
    `).run({ lead_id: leadId, field_key: key, ...typed, updated_at: now, updated_by_email: actorEmail } as any);
  }
  if (Object.keys(values).length) filterOptionsCache.clear();
}

function ensureLeadExists(db: DatabaseSync, leadId: string) {
  const current = db.prepare("SELECT id FROM lead_memberships WHERE id = :id LIMIT 1").get({ id: leadId } as any);
  if (!current) throw notFound("lead_not_found", "The requested lead was not found.");
}

function touchLead(db: DatabaseSync, leadId: string, actorEmail: string, now: number) {
  db.prepare("UPDATE lead_memberships SET updated_at = :updated_at, updated_by_email = :updated_by_email WHERE id = :id")
    .run({ id: leadId, updated_at: now, updated_by_email: actorEmail } as any);
}

function typedCustomValue(raw: unknown, dataType: string) {
  const valueText = String(raw ?? "").trim();
  const valueNumber = dataType === "number" && valueText ? Number(valueText) : null;
  const valueDate = dataType === "date" ? parseDateish(valueText) || null : null;
  return {
    value_text: valueText,
    value_number: Number.isFinite(valueNumber) ? valueNumber : null,
    value_date: valueDate
  };
}

function normalizeHeaderKey(value: string) {
  return String(value || "").trim().toLowerCase().replace(/^custom_/, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function ensureImportList(db: DatabaseSync, actorEmail: string) {
  const id = "list_imports_default";
  const now = nowUnix();
  db.prepare(`
    INSERT OR IGNORE INTO lead_lists (id, name, status, type, source_kind, created_at, updated_at, created_by_email, updated_by_email)
    VALUES (:id, 'Imported Leads', 'active', 'import', 'crm_import', :now, :now, :actor, :actor)
  `).run({ id, now, actor: actorEmail } as any);
  return id;
}

function refreshListCounts(db: DatabaseSync) {
  db.exec("UPDATE lead_lists SET lead_count = (SELECT COUNT(*) FROM lead_memberships lm WHERE lm.list_id = lead_lists.id)");
}

function normalizeLeadInput(input: JsonObject, index: number, customFields: JsonObject[] = []): ImportRow {
  const metadata = asObject(input.metadata);
  const normalizedInput = normalizedImportInput(input);
  const presentKeys: string[] = [];
  const normalized: ImportRow = { __row_index: index, __present_keys: presentKeys, metadata };
  for (const column of LEAD_COLUMNS) {
    if (column === "metadata_json") continue;
    if (!normalizedInput.has(column)) continue;
    normalized[column] = normalizeLeadValue(normalizedInput.get(column));
    presentKeys.push(column);
  }
  if (presentKeys.includes("email")) normalized.email = String(normalized.email ?? "").trim().toLowerCase();
  normalized.custom_values = customImportValues(input, customFields);
  return normalized;
}

function normalizeLeadValue(value: unknown) {
  if (value == null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? value : "";
  return String(value).trim();
}

function snakeToCamel(value: string) {
  return value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function normalizedImportInput(input: JsonObject) {
  const out = new Map<string, unknown>();
  const fieldLabels = new Map<string, string>(LEAD_FIELDS.map((field) => [normalizeHeaderKey(String(field.label)), String(field.key)]));
  for (const [rawKey, value] of Object.entries(input)) {
    const normalizedKey = normalizeHeaderKey(rawKey);
    const alias = IMPORT_KEY_ALIASES[normalizedKey] ?? fieldLabels.get(normalizedKey) ?? normalizedKey;
    const camelAlias = IMPORT_KEY_ALIASES[normalizeHeaderKey(snakeToCamel(alias))] ?? alias;
    if (LEAD_COLUMNS.includes(camelAlias as any)) out.set(camelAlias, value);
  }
  return out;
}

async function leadCustomFields(): Promise<JsonObject[]> {
  await ensureLeadDatabase();
  return withLeadDb((db) => (db.prepare(`
    SELECT *
    FROM lead_custom_fields
    WHERE archived_at IS NULL
    ORDER BY created_at ASC, label ASC
  `).all() as LeadRow[]).map(customFieldRowToField));
}

function customFieldRowToField(row: LeadRow): JsonObject {
  const customKey = String(row.field_key ?? "").trim();
  const type = normalizeCustomFieldType(row.data_type);
  return {
    key: `custom_${customKey}`,
    customKey,
    label: String(row.label ?? customKey),
    type,
    dataType: type,
    defaultVisible: false,
    sortable: true,
    filterable: true,
    custom: true,
    topbarFilter: Boolean(row.topbar_filter),
    options: parseJsonArray(row.options_json)
  };
}

function findCustomField(db: DatabaseSync, fieldKeyOrId: string) {
  const raw = String(fieldKeyOrId ?? "").trim();
  const key = raw.startsWith("custom_") ? raw.slice(7) : raw;
  return db.prepare(`
    SELECT *
    FROM lead_custom_fields
    WHERE archived_at IS NULL
    AND (id = :raw OR field_key = :raw OR field_key = :key)
    LIMIT 1
  `).get({ raw, key } as any) as LeadRow | undefined;
}

function uniqueCustomFieldKey(db: DatabaseSync, label: string) {
  const base = slugifyCustomKey(label);
  let candidate = base;
  let suffix = 2;
  while (db.prepare("SELECT 1 FROM lead_custom_fields WHERE field_key = :field_key LIMIT 1").get({ field_key: candidate } as any)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function slugifyCustomKey(label: string) {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 48);
  return slug || `field_${randomBytes(4).toString("hex")}`;
}

function normalizeCustomFieldType(value: unknown) {
  const raw = String(value ?? "text").trim().toLowerCase();
  if (raw === "free" || raw === "free_entry") return "text";
  if (raw === "multi" || raw === "multiple") return "multiselect";
  return CUSTOM_FIELD_TYPES.has(raw) ? raw : "text";
}

function normalizeCustomOptions(value: unknown) {
  const items = Array.isArray(value)
    ? value
    : String(value ?? "").split(/\r?\n|,/g);
  return [...new Set(items.map((item) => String(item ?? "").trim()).filter(Boolean))].slice(0, 200);
}

function parseJsonArray(value: unknown) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function normalizeText(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizePhone(value: unknown) {
  return String(value ?? "").replace(/\D+/g, "");
}

function normalizeRow(row: LeadRow) {
  const next = { ...row };
  if (typeof next.metadata_json === "string") {
    try {
      next.metadata = JSON.parse(String(next.metadata_json || "{}"));
    } catch {
      next.metadata = {};
    }
  }
  if (typeof next.custom_values_json === "string") {
    const customValues = parseJsonObject(next.custom_values_json);
    for (const [key, value] of Object.entries(customValues)) next[key] = value;
    delete next.custom_values_json;
  }
  return next;
}

function rows(db: DatabaseSync, sql: string, params: JsonObject) {
  return (db.prepare(sql).all(sqliteParams(sql, params) as any) as LeadRow[]).map(normalizeRow);
}

function buildLeadWhere(body: JsonObject, customFields: JsonObject[] = []) {
  const filters = asObject(body.filters);
  const params: JsonObject = {};
  const where: string[] = ["1=1"];
  const q = String(body.q ?? filters.q ?? "").trim();
  applyViewerScope(where, params, body, "lm", "ll");

  const assigned = String(filters.assigned_to_email ?? "").trim().toLowerCase();
  if (assigned === "__unassigned__") {
    where.push("COALESCE(lm.assigned_to_email, ll.assigned_to_email, '') = ''");
  } else if (assigned) {
    where.push("LOWER(COALESCE(lm.assigned_to_email, ll.assigned_to_email, '')) = :assigned_to_email");
    params.assigned_to_email = assigned;
  }
  if (q) {
    where.push(`(
      lm.company LIKE :q OR lm.lead_name LIKE :q OR lm.email LIKE :q OR lm.phone LIKE :q OR lm.address LIKE :q OR lm.website LIKE :q OR lm.notes LIKE :q
      OR EXISTS (SELECT 1 FROM lead_custom_values cv_q WHERE cv_q.lead_id = lm.id AND cv_q.value_text LIKE :q)
    )`);
    params.q = `%${q}%`;
  }
  addTextFilter(where, params, "lm.status", "status", filters.status);
  addRegionFilter(where, params, filters.region);
  addTextFilter(where, params, "lm.region_code", "region_code", filters.region_code);
  addTextFilter(where, params, "lm.source", "source", filters.source);
  const disposition = String(filters.disposition ?? "").trim();
  if (disposition === "__none__") {
    where.push(`NOT EXISTS (
      SELECT 1 FROM lead_dial_events de_filter
      WHERE de_filter.lead_id = lm.id
      AND ${dispositionValueSql("de_filter")}
    )`);
  } else if (disposition) {
    where.push("EXISTS (SELECT 1 FROM lead_dial_events de_filter WHERE de_filter.lead_id = lm.id AND de_filter.context_json LIKE :disposition_like)");
    params.disposition_like = `%${disposition.replace(/[%_]/g, "")}%`;
  }
  addBooleanPresenceFilter(where, "lm.email", filters.has_email);
  addBooleanPresenceFilter(where, "lm.phone", filters.has_phone);
  addBooleanPresenceFilter(where, "lm.website", filters.has_website);
  if (filters.no_contact_data === true || filters.no_contact_data === "true" || filters.no_contact_data === "1") {
    where.push(`
      COALESCE(lm.email, '') = ''
      AND COALESCE(lm.phone, '') = ''
      AND COALESCE(lm.website, '') = ''
      AND NOT EXISTS (
        SELECT 1 FROM lead_contacts c_filter
        WHERE c_filter.lead_id = lm.id
        AND (
          COALESCE(c_filter.email, '') <> ''
          OR COALESCE(c_filter.phone, '') <> ''
          OR COALESCE(c_filter.full_name, '') <> ''
          OR COALESCE(c_filter.title, '') <> ''
        )
      )
    `);
  }
  addDateRangeFilter(where, params, "lm.created_at", "created_at", filters.created_from, filters.created_to);
  addDateRangeFilter(where, params, "lm.updated_at", "updated_at", filters.updated_from, filters.updated_to);
  addDateRangeFilter(where, params, "lm.imported_at", "imported_at", filters.imported_from, filters.imported_to);
  addDateRangeFilter(where, params, "(SELECT MAX(de.dialed_at) FROM lead_dial_events de WHERE de.lead_id = lm.id)", "latest_call_at", filters.latest_call_from, filters.latest_call_to);
  addDateRangeFilter(where, params, "COALESCE((SELECT MAX(le.exported_at) FROM lead_exports le WHERE le.list_id = lm.list_id), ll.exported_at)", "latest_export_at", filters.latest_export_from, filters.latest_export_to);
  addDateRangeFilter(where, params, "(SELECT MAX(n.created_at) FROM lead_notes n WHERE n.lead_id = lm.id)", "latest_note_at", filters.latest_note_from, filters.latest_note_to);
  addCustomFilters(where, params, filters, customFields);
  return { whereSql: `WHERE ${where.join(" AND ")}`, params };
}

function resolveSelectionIds(db: DatabaseSync, selection: JsonObject, maxRows: number, customFields: JsonObject[] = []) {
  const mode = String(selection.mode ?? "explicit");
  const explicitIds = normalizeIdArray(selection.ids);
  const excludedIds = new Set(normalizeIdArray(selection.excluded_ids));
  if (mode !== "filtered") {
    return explicitIds.filter((id) => !excludedIds.has(id)).slice(0, maxRows);
  }
  const query = asObject(selection.query);
  const { whereSql, params } = buildLeadWhere(query, customFields);
  const rows = db.prepare(`
    SELECT lm.id
    FROM lead_memberships lm
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${whereSql}
    ORDER BY lm.updated_at DESC, lm.id ASC
    LIMIT :max_rows
  `).all(sqliteParams(`
    SELECT lm.id
    FROM lead_memberships lm
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${whereSql}
    ORDER BY lm.updated_at DESC, lm.id ASC
    LIMIT :max_rows
  `, { ...params, max_rows: maxRows }) as any) as LeadRow[];
  return rows.map((row) => String(row.id ?? "")).filter((id) => id && !excludedIds.has(id));
}

function selectionSummary(db: DatabaseSync, selection: JsonObject, filterQuery: JsonObject, customFields: JsonObject[] = []) {
  const ids = resolveSelectionIds(db, selection, 200000, customFields);
  const total = ids.length;
  const matching = countIdsMatchingQuery(db, ids, filterQuery, customFields);
  return {
    total,
    matching_current_filter: matching,
    outside_current_filter: Math.max(0, total - matching)
  };
}

function countIdsMatchingQuery(db: DatabaseSync, ids: string[], query: JsonObject, customFields: JsonObject[] = []) {
  if (!ids.length) return 0;
  const { whereSql, params } = buildLeadWhere(query, customFields);
  let total = 0;
  for (const chunk of chunks(ids, 500)) {
    const chunkParams: JsonObject = { ...params };
    const placeholders = chunk.map((id, index) => {
      chunkParams[`selected_id_${index}`] = id;
      return `:selected_id_${index}`;
    });
    const sql = `
      SELECT COUNT(*) AS total
      FROM lead_memberships lm
      LEFT JOIN lead_lists ll ON ll.id = lm.list_id
      ${whereSql}
      AND lm.id IN (${placeholders.join(", ")})
    `;
    total += Number(db.prepare(sql).get(sqliteParams(sql, chunkParams) as any)?.total ?? 0);
  }
  return total;
}

function normalizeIdArray(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);
}

function fetchLeadsByIds(db: DatabaseSync, ids: string[]) {
  const out: LeadRow[] = [];
  for (const chunk of chunks(ids, 500)) {
    const params: JsonObject = {};
    const placeholders = chunk.map((id, index) => {
      params[`id_${index}`] = id;
      return `:id_${index}`;
    });
    out.push(...rows(db, `
      SELECT
        ${LEAD_LIST_COLUMNS.map((column) => `lm.${column}`).join(",\n        ")},
        COALESCE(lm.assigned_to_email, ll.assigned_to_email, '') AS effective_assigned_to_email,
        (SELECT COUNT(*) FROM lead_contacts c WHERE c.lead_id = lm.id) AS contact_count,
        (SELECT COUNT(*) FROM lead_notes n WHERE n.lead_id = lm.id) AS notes_count,
        (SELECT MAX(n.created_at) FROM lead_notes n WHERE n.lead_id = lm.id) AS latest_note_at,
        (SELECT substr(n.note_text, 1, 260) FROM lead_notes n WHERE n.lead_id = lm.id ORDER BY n.created_at DESC LIMIT 1) AS latest_note_preview,
        (SELECT MAX(de.dialed_at) FROM lead_dial_events de WHERE de.lead_id = lm.id) AS latest_call_at,
        (SELECT MIN(fu.due_at) FROM lead_followups fu WHERE fu.lead_id = lm.id AND fu.status = 'open') AS next_followup_at,
        (SELECT COUNT(*) FROM lead_followups fu WHERE fu.lead_id = lm.id AND fu.status = 'open') AS open_followup_count,
        COALESCE((SELECT MAX(le.exported_at) FROM lead_exports le WHERE le.list_id = lm.list_id), ll.exported_at) AS latest_export_at,
        (SELECT json_group_object('custom_' || cv.field_key, COALESCE(cv.value_text, '')) FROM lead_custom_values cv WHERE cv.lead_id = lm.id) AS custom_values_json
      FROM lead_memberships lm
      LEFT JOIN lead_lists ll ON ll.id = lm.list_id
      WHERE lm.id IN (${placeholders.join(", ")})
      ORDER BY lm.company ASC, lm.id ASC
    `, params));
  }
  return out;
}

function leadRowsToCsv(rowsToExport: LeadRow[], fieldKeys: string[], customFields: JsonObject[] = []) {
  const fieldByKey = new Map<string, JsonObject>([...LEAD_FIELDS, ...customFields].map((field) => [String(field.key), field]));
  const fields = fieldKeys
    .map((key) => fieldByKey.get(key) ?? { key, label: labelize(key), type: "text" })
    .filter((field) => field.key !== "notes_count");
  const lines = [fields.map((field) => csvCell(field.label)).join(",")];
  for (const row of rowsToExport) {
    lines.push(fields.map((field) => {
      const key = String(field.key ?? "");
      const value = field.type === "date" ? unixToIsoDate(row[key]) : row[key];
      return csvCell(value);
    }).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function distributeIds(ids: string[], assignees: string[]) {
  return assignees.map((email, index) => {
    const groupIds = ids.filter((_id, leadIndex) => leadIndex % assignees.length === index);
    return { email, count: groupIds.length, ids: groupIds };
  });
}

function chunks<T>(items: T[], size: number) {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, "\"\"")}"` : raw;
}

function unixToIsoDate(value: unknown) {
  const n = Number(value || 0);
  if (!n) return "";
  const date = new Date(n > 100000000000 ? n : n * 1000);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function distinctRows(db: DatabaseSync, sql: string, params: JsonObject): JsonObject[] {
  return (db.prepare(sql).all(sqliteParams(sql, params) as any) as LeadRow[])
    .map((row) => ({ ...row, label: labelize(row.value), count: Number(row.count ?? 0) }));
}

function dispositionOptions(db: DatabaseSync, whereSql: string, params: JsonObject) {
  const rowsToParse = db.prepare(`
    SELECT de.context_json
    FROM lead_dial_events de
    JOIN lead_memberships lm ON lm.id = de.lead_id
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${whereSql}
    AND COALESCE(de.context_json, '') <> ''
    ORDER BY de.created_at DESC
    LIMIT 50000
  `).all(sqliteParams(`
    SELECT de.context_json
    FROM lead_dial_events de
    JOIN lead_memberships lm ON lm.id = de.lead_id
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${whereSql}
    AND COALESCE(de.context_json, '') <> ''
    ORDER BY de.created_at DESC
    LIMIT 50000
  `, params) as any) as LeadRow[];
  const counts = new Map<string, number>();
  for (const row of rowsToParse) {
    const context = parseJsonObject(row.context_json);
    const raw = context.disposition ?? context.disposition_name ?? context.outcome ?? context.call_disposition ?? context.orum_disposition ?? "";
    const value = String(raw ?? "").trim();
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 200)
    .map(([value, count]) => ({ value, label: labelize(value), count }));
}

function applyViewerScope(where: string[], params: JsonObject, body: JsonObject, leadAlias: string, listAlias: string) {
  const actorEmail = String(body.actor_email ?? body.email ?? "").trim().toLowerCase();
  const manager = Boolean(body.manager) || String(body.scope ?? "").toLowerCase() === "all";
  if (!manager && actorEmail) {
    where.push(`LOWER(COALESCE(${leadAlias}.assigned_to_email, ${listAlias}.assigned_to_email, '')) = :actor_email`);
    params.actor_email = actorEmail;
  }
}

function sqliteParams(sql: string, params: JsonObject) {
  return Object.fromEntries(Object.entries(params).filter(([key]) => sql.includes(`:${key}`)));
}

function parseJsonObject(value: unknown) {
  try {
    return asObject(JSON.parse(String(value || "{}")));
  } catch {
    return {};
  }
}

function labelize(value: unknown) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.replace(/[_-]+/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function addTextFilter(where: string[], params: JsonObject, sqlColumn: string, paramName: string, value: unknown) {
  const raw = Array.isArray(value) ? value : String(value ?? "").trim() ? [value] : [];
  const values = raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (!values.length) return;
  if (values.includes("__none__")) {
    where.push(`COALESCE(${sqlColumn}, '') = ''`);
    return;
  }
  const keys = values.map((_value, index) => `${paramName}_${index}`);
  where.push(`${sqlColumn} IN (${keys.map((key) => `:${key}`).join(", ")})`);
  keys.forEach((key, index) => {
    params[key] = values[index];
  });
}

function addRegionFilter(where: string[], params: JsonObject, value: unknown) {
  const raw = Array.isArray(value) ? value : String(value ?? "").trim() ? [value] : [];
  const values = raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (!values.length) return;
  if (values.includes("__none__")) {
    where.push("COALESCE(lm.region, '') = '' AND COALESCE(lm.region_code, '') = ''");
    return;
  }
  const keys = values.map((_value, index) => `region_${index}`);
  where.push(`COALESCE(NULLIF(lm.region, ''), lm.region_code) IN (${keys.map((key) => `:${key}`).join(", ")})`);
  keys.forEach((key, index) => {
    params[key] = values[index];
  });
}

function addCustomFilters(where: string[], params: JsonObject, filters: JsonObject, customFields: JsonObject[]) {
  for (const field of customFields) {
    const key = String(field.key ?? "");
    const customKey = String(field.customKey ?? "");
    if (!key || !customKey || filters[key] == null || filters[key] === "") continue;
    const type = String(field.type ?? "text");
    const value = filters[key];
    const paramBase = key.replace(/[^a-zA-Z0-9_]/g, "_");
    params[`${paramBase}_field`] = customKey;
    if (value === "__none__") {
      where.push(`NOT EXISTS (
        SELECT 1 FROM lead_custom_values cv_${paramBase}
        WHERE cv_${paramBase}.lead_id = lm.id
        AND cv_${paramBase}.field_key = :${paramBase}_field
        AND COALESCE(cv_${paramBase}.value_text, '') <> ''
      )`);
      continue;
    }
    if (type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) continue;
      params[`${paramBase}_number`] = n;
      where.push(`EXISTS (
        SELECT 1 FROM lead_custom_values cv_${paramBase}
        WHERE cv_${paramBase}.lead_id = lm.id
        AND cv_${paramBase}.field_key = :${paramBase}_field
        AND cv_${paramBase}.value_number = :${paramBase}_number
      )`);
      continue;
    }
    if (type === "date") {
      const dateValue = parseDateish(value);
      if (!dateValue) continue;
      params[`${paramBase}_date_from`] = dateValue;
      params[`${paramBase}_date_to`] = dateValue + 86399;
      where.push(`EXISTS (
        SELECT 1 FROM lead_custom_values cv_${paramBase}
        WHERE cv_${paramBase}.lead_id = lm.id
        AND cv_${paramBase}.field_key = :${paramBase}_field
        AND cv_${paramBase}.value_date BETWEEN :${paramBase}_date_from AND :${paramBase}_date_to
      )`);
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    const clean = values.map((item) => String(item ?? "").trim()).filter(Boolean);
    if (!clean.length) continue;
    const placeholders = clean.map((item, index) => {
      params[`${paramBase}_value_${index}`] = type === "multiselect" ? `%${item}%` : item;
      return type === "multiselect"
        ? `cv_${paramBase}.value_text LIKE :${paramBase}_value_${index}`
        : `cv_${paramBase}.value_text = :${paramBase}_value_${index}`;
    });
    where.push(`EXISTS (
      SELECT 1 FROM lead_custom_values cv_${paramBase}
      WHERE cv_${paramBase}.lead_id = lm.id
      AND cv_${paramBase}.field_key = :${paramBase}_field
      AND (${placeholders.join(" OR ")})
    )`);
  }
}

function addBooleanPresenceFilter(where: string[], sqlColumn: string, value: unknown) {
  if (value === true || value === "true" || value === "1") where.push(`COALESCE(${sqlColumn}, '') <> ''`);
  if (value === false || value === "false" || value === "0") where.push(`COALESCE(${sqlColumn}, '') = ''`);
}

function customSortSql(sortKey: string, customFields: JsonObject[]) {
  const field = customFields.find((item) => item.key === sortKey);
  if (!field) return undefined;
  const customKey = String(field.customKey ?? "").replace(/'/g, "''");
  const type = String(field.type ?? "text");
  const valueColumn = type === "number" ? "value_number" : type === "date" ? "value_date" : "value_text";
  return `(SELECT cv_sort.${valueColumn} FROM lead_custom_values cv_sort WHERE cv_sort.lead_id = lm.id AND cv_sort.field_key = '${customKey}' LIMIT 1)`;
}

function customFilterOptions(db: DatabaseSync, field: JsonObject, whereSql: string, params: JsonObject) {
  const customKey = String(field.customKey ?? "");
  if (!customKey) return [];
  const type = String(field.type ?? "text");
  if (type === "text") return [];
  const fieldParams = { ...params, custom_field_key: customKey };
  const result = distinctRows(db, `
    SELECT cv.value_text AS value, COUNT(*) AS count
    FROM lead_custom_values cv
    JOIN lead_memberships lm ON lm.id = cv.lead_id
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${whereSql}
    AND cv.field_key = :custom_field_key
    GROUP BY cv.value_text
    HAVING value <> ''
    ORDER BY value ASC
    LIMIT 500
  `, fieldParams);
  const blank = Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM lead_memberships lm
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${whereSql}
    AND NOT EXISTS (
      SELECT 1 FROM lead_custom_values cv
      WHERE cv.lead_id = lm.id
      AND cv.field_key = :custom_field_key
      AND COALESCE(cv.value_text, '') <> ''
    )
  `).get(sqliteParams(`
    SELECT COUNT(*) AS count
    FROM lead_memberships lm
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${whereSql}
    AND NOT EXISTS (
      SELECT 1 FROM lead_custom_values cv
      WHERE cv.lead_id = lm.id
      AND cv.field_key = :custom_field_key
      AND COALESCE(cv.value_text, '') <> ''
    )
  `, fieldParams) as any)?.count ?? 0);
  if (blank > 0) result.push({ value: "__none__", label: `No ${field.label}`, count: blank });
  return result;
}

function blankCount(db: DatabaseSync, whereSql: string, params: JsonObject, sqlColumn: string) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM lead_memberships lm
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${whereSql}
    AND COALESCE(${sqlColumn}, '') = ''
  `).get(sqliteParams(`
    SELECT COUNT(*) AS count
    FROM lead_memberships lm
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${whereSql}
    AND COALESCE(${sqlColumn}, '') = ''
  `, params) as any)?.count ?? 0);
}

function noDispositionLeadCount(db: DatabaseSync, whereSql: string, params: JsonObject) {
  return Number(db.prepare(`
    SELECT COUNT(*) AS count
    FROM lead_memberships lm
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${whereSql}
    AND NOT EXISTS (
      SELECT 1 FROM lead_dial_events de
      WHERE de.lead_id = lm.id
      AND ${dispositionValueSql("de")}
    )
  `).get(sqliteParams(`
    SELECT COUNT(*) AS count
    FROM lead_memberships lm
    LEFT JOIN lead_lists ll ON ll.id = lm.list_id
    ${whereSql}
    AND NOT EXISTS (
      SELECT 1 FROM lead_dial_events de
      WHERE de.lead_id = lm.id
      AND ${dispositionValueSql("de")}
    )
  `, params) as any)?.count ?? 0);
}

function dispositionValueSql(alias: string) {
  return `
    CASE
      WHEN json_valid(${alias}.context_json) THEN (
        COALESCE(json_extract(${alias}.context_json, '$.disposition'), '') <> ''
        OR COALESCE(json_extract(${alias}.context_json, '$.disposition_name'), '') <> ''
        OR COALESCE(json_extract(${alias}.context_json, '$.outcome'), '') <> ''
        OR COALESCE(json_extract(${alias}.context_json, '$.call_disposition'), '') <> ''
        OR COALESCE(json_extract(${alias}.context_json, '$.orum_disposition'), '') <> ''
      )
      ELSE 0
    END
  `;
}

function addDateRangeFilter(where: string[], params: JsonObject, sqlExpr: string, key: string, from: unknown, to: unknown) {
  const fromUnix = parseDateish(from);
  const toUnix = parseDateish(to, true);
  if (fromUnix) {
    where.push(`${sqlExpr} >= :${key}_from`);
    params[`${key}_from`] = fromUnix;
  }
  if (toUnix) {
    where.push(`${sqlExpr} <= :${key}_to`);
    params[`${key}_to`] = toUnix;
  }
}

function parseDateish(value: unknown, endOfDay = false) {
  if (value == null || value === "") return 0;
  if (typeof value === "number") return Math.floor(value);
  const raw = String(value).trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  const date = new Date(endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T23:59:59` : raw);
  return Number.isNaN(date.getTime()) ? 0 : Math.floor(date.getTime() / 1000);
}

function importBatchPath(importId: string) {
  const clean = String(importId).replace(/[^a-zA-Z0-9_-]/g, "");
  if (!clean) throw badRequest("invalid_import_id", "Import ID is invalid.");
  return path.join(importRoot(), `${clean}.json`);
}

async function writeImportBatch(batch: ImportBatch) {
  await mkdir(importRoot(), { recursive: true });
  const target = importBatchPath(batch.id);
  const temp = `${target}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(batch), "utf8");
  await rename(temp, target);
}

async function readImportBatch(importId: string) {
  try {
    return JSON.parse(await readFile(importBatchPath(importId), "utf8")) as ImportBatch;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw notFound("lead_import_not_found", "The requested lead import batch was not found.");
    throw error;
  }
}
