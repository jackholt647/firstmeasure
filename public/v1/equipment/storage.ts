import { randomUUID } from "node:crypto";
import path from "node:path";
import { openSqlStore, ensureSqlColumn, type SqlStore } from "../platform/sql_store.js";

import { env } from "../src/config/env.js";
import { conflict, notFound } from "../platform/errors.js";

export type JsonObject = Record<string, unknown>;

let database: SqlStore | null = null;
let databasePath = "";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

function parseJson(value: unknown, fallback: unknown = {}) {
  try {
    return value ? JSON.parse(String(value)) : fallback;
  } catch {
    return fallback;
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function newId(prefix: string) {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
}

function resolvedDatabasePath() {
  return path.resolve(process.cwd(), env.platformStorageRoot, "equipment.sqlite");
}

export async function closeEquipmentDatabase() {
  const current = database;
  database = null;
  databasePath = "";
  return (await current?.close());
}

export function getEquipmentDatabase() {
  const nextPath = resolvedDatabasePath();
  if (database && databasePath === nextPath) return database;
  void closeEquipmentDatabase();
  database = openSqlStore({ id: "equipment", filename: nextPath, initialize: initializeSchema });
  databasePath = nextPath;
  return database;
}

async function initializeSchema(db: SqlStore) {
  (await db.exec(`
    CREATE TABLE IF NOT EXISTS equipment_categories (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0,
      seed_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_equipment_categories_org ON equipment_categories (organization_id, status);

    CREATE TABLE IF NOT EXISTS equipment_types (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'other',
      category_id TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      tracking TEXT NOT NULL DEFAULT 'unit',
      mobility TEXT NOT NULL DEFAULT 'mobile',
      pool_quantity INTEGER NOT NULL DEFAULT 0,
      allow_double_booking INTEGER NOT NULL DEFAULT 0,
      default_meter_kind TEXT NOT NULL DEFAULT 'none',
      operator_requirements_json TEXT NOT NULL DEFAULT '[]',
      attributes_schema_json TEXT NOT NULL DEFAULT '[]',
      default_rates_json TEXT NOT NULL DEFAULT '{}',
      scope_item_keys_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      sort_order INTEGER NOT NULL DEFAULT 0,
      seed_key TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_equipment_types_org ON equipment_types (organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_equipment_types_category ON equipment_types (organization_id, category_id);

    CREATE TABLE IF NOT EXISTS equipment_yards (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      address_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_equipment_yards_org ON equipment_yards (organization_id, status, name);

    /* One table for both worlds: fleet units (ownership owned/leased/rented)
     * and customer-installed units (ownership 'customer' + contact_id /
     * service_location_json). Customer-owned rows are a FILTER, never a fork:
     * every unit query scopes by ownership rather than by table. */
    CREATE TABLE IF NOT EXISTS equipment_units (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      type_id TEXT NOT NULL DEFAULT '',
      branch_id TEXT NOT NULL DEFAULT 'default',
      name TEXT NOT NULL,
      identifier TEXT NOT NULL DEFAULT '',
      serial_number TEXT NOT NULL DEFAULT '',
      license_plate TEXT NOT NULL DEFAULT '',
      year TEXT NOT NULL DEFAULT '',
      make TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      vin TEXT NOT NULL DEFAULT '',
      color TEXT NOT NULL DEFAULT '',
      ownership TEXT NOT NULL DEFAULT 'owned',
      contact_id TEXT NOT NULL DEFAULT '',
      service_location_json TEXT NOT NULL DEFAULT '{}',
      acquisition_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'available',
      condition_status_id TEXT NOT NULL DEFAULT '',
      location_source TEXT NOT NULL DEFAULT 'manual',
      location_json TEXT NOT NULL DEFAULT '{}',
      home_location_json TEXT NOT NULL DEFAULT '{}',
      current_meter_json TEXT NOT NULL DEFAULT '{}',
      rates_json TEXT NOT NULL DEFAULT '{}',
      attributes_json TEXT NOT NULL DEFAULT '{}',
      operator_tag_overrides_json TEXT NOT NULL DEFAULT '[]',
      custody_json TEXT NOT NULL DEFAULT '{}',
      photos_json TEXT NOT NULL DEFAULT '[]',
      documents_json TEXT NOT NULL DEFAULT '[]',
      tags_json TEXT NOT NULL DEFAULT '[]',
      notes TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_equipment_units_org ON equipment_units (organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_equipment_units_type ON equipment_units (organization_id, type_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_units_ownership ON equipment_units (organization_id, ownership);
    CREATE INDEX IF NOT EXISTS idx_equipment_units_contact ON equipment_units (organization_id, contact_id);

    CREATE TABLE IF NOT EXISTS equipment_meter_entries (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'hours',
      value DOUBLE PRECISION NOT NULL DEFAULT 0,
      gallons DOUBLE PRECISION NOT NULL DEFAULT 0,
      cost_cents INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'manual',
      event_id TEXT NOT NULL DEFAULT '',
      user_id TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_equipment_meters_unit ON equipment_meter_entries (organization_id, unit_id, kind, recorded_at);

    CREATE TABLE IF NOT EXISTS equipment_service_programs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'service',
      type_id TEXT NOT NULL DEFAULT '',
      unit_id TEXT NOT NULL DEFAULT '',
      trigger_json TEXT NOT NULL DEFAULT '{}',
      checklist_json TEXT NOT NULL DEFAULT '[]',
      lead_time_days INTEGER NOT NULL DEFAULT 0,
      estimated_downtime_hours DOUBLE PRECISION NOT NULL DEFAULT 0,
      estimated_cost_cents INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_equipment_programs_org ON equipment_service_programs (organization_id, status);

    CREATE TABLE IF NOT EXISTS equipment_work_orders (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      unit_id TEXT NOT NULL,
      program_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'repair',
      status TEXT NOT NULL DEFAULT 'open',
      due_at TEXT NOT NULL DEFAULT '',
      due_meter_json TEXT NOT NULL DEFAULT '{}',
      scheduled_start_at TEXT NOT NULL DEFAULT '',
      scheduled_end_at TEXT NOT NULL DEFAULT '',
      completed_at TEXT NOT NULL DEFAULT '',
      assigned_to_json TEXT NOT NULL DEFAULT '{}',
      cost_json TEXT NOT NULL DEFAULT '{}',
      meter_at_service_json TEXT NOT NULL DEFAULT '{}',
      checklist_state_json TEXT NOT NULL DEFAULT '[]',
      downtime_event_id TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_equipment_work_orders_org ON equipment_work_orders (organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_equipment_work_orders_unit ON equipment_work_orders (organization_id, unit_id, status);

    CREATE TABLE IF NOT EXISTS equipment_settings (
      organization_id TEXT PRIMARY KEY,
      settings_json TEXT NOT NULL DEFAULT '{}',
      revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `));
  await ensureSqlColumn(db, "equipment_units", "color", "TEXT NOT NULL DEFAULT ''");
  await ensureSqlColumn(db, "equipment_types", "kind", "TEXT NOT NULL DEFAULT 'other'");
}

/* Row views --------------------------------------------------------------- */

export function categoryView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    organization_id: cleanText(value.organization_id),
    name: cleanText(value.name),
    icon: cleanText(value.icon),
    sort_order: Number(value.sort_order || 0),
    seed_key: cleanText(value.seed_key),
    status: cleanText(value.status || "active"),
    revision: Number(value.revision || 1),
    created_at: cleanText(value.created_at),
    updated_at: cleanText(value.updated_at)
  };
}

export function typeView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    organization_id: cleanText(value.organization_id),
    name: cleanText(value.name),
    kind: cleanText(value.kind || "other"),
    category_id: cleanText(value.category_id),
    description: cleanText(value.description),
    icon: cleanText(value.icon),
    color: cleanText(value.color),
    tracking: cleanText(value.tracking || "unit"),
    mobility: cleanText(value.mobility || "mobile"),
    pool_quantity: Number(value.pool_quantity || 0),
    allow_double_booking: Number(value.allow_double_booking ?? 0) !== 0,
    default_meter_kind: cleanText(value.default_meter_kind || "none"),
    operator_requirements: parseJson(value.operator_requirements_json, []),
    attributes_schema: parseJson(value.attributes_schema_json, []),
    default_rates: parseJson(value.default_rates_json, {}),
    scope_item_keys: parseJson(value.scope_item_keys_json, []),
    status: cleanText(value.status || "active"),
    sort_order: Number(value.sort_order || 0),
    seed_key: cleanText(value.seed_key),
    revision: Number(value.revision || 1),
    created_at: cleanText(value.created_at),
    updated_at: cleanText(value.updated_at)
  };
}

export function yardView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    organization_id: cleanText(value.organization_id),
    name: cleanText(value.name),
    address: parseJson(value.address_json, {}),
    status: cleanText(value.status || "active"),
    revision: Number(value.revision || 1),
    created_at: cleanText(value.created_at),
    updated_at: cleanText(value.updated_at)
  };
}

export function unitView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    organization_id: cleanText(value.organization_id),
    type_id: cleanText(value.type_id),
    branch_id: cleanText(value.branch_id || "default"),
    name: cleanText(value.name),
    identifier: cleanText(value.identifier),
    serial_number: cleanText(value.serial_number),
    license_plate: cleanText(value.license_plate),
    year: cleanText(value.year),
    make: cleanText(value.make),
    model: cleanText(value.model),
    vin: cleanText(value.vin),
    color: cleanText(value.color),
    ownership: cleanText(value.ownership || "owned"),
    contact_id: cleanText(value.contact_id),
    service_location: parseJson(value.service_location_json, {}),
    acquisition: parseJson(value.acquisition_json, {}),
    status: cleanText(value.status || "available"),
    condition_status_id: cleanText(value.condition_status_id),
    location_source: cleanText(value.location_source || "manual"),
    location: parseJson(value.location_json, {}),
    home_location: parseJson(value.home_location_json, {}),
    current_meter: parseJson(value.current_meter_json, {}),
    rates: parseJson(value.rates_json, {}),
    attributes: parseJson(value.attributes_json, {}),
    operator_tag_overrides: parseJson(value.operator_tag_overrides_json, []),
    custody: parseJson(value.custody_json, {}),
    photos: parseJson(value.photos_json, []),
    documents: parseJson(value.documents_json, []),
    tags: parseJson(value.tags_json, []),
    notes: cleanText(value.notes),
    revision: Number(value.revision || 1),
    created_at: cleanText(value.created_at),
    updated_at: cleanText(value.updated_at),
    archived_at: cleanText(value.archived_at)
  };
}

export function meterEntryView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    unit_id: cleanText(value.unit_id),
    kind: cleanText(value.kind || "hours"),
    value: Number(value.value || 0),
    gallons: Number(value.gallons || 0),
    cost_cents: Number(value.cost_cents || 0),
    recorded_at: cleanText(value.recorded_at),
    source: cleanText(value.source || "manual"),
    event_id: cleanText(value.event_id),
    user_id: cleanText(value.user_id),
    notes: cleanText(value.notes),
    created_at: cleanText(value.created_at)
  };
}

/* Categories --------------------------------------------------------------- */

export async function listCategories(orgId: string, options: { includeArchived?: boolean } = {}) {
  const rows = (await getEquipmentDatabase().prepare(`SELECT * FROM equipment_categories WHERE organization_id = ?
    AND (? = 1 OR status <> 'archived') ORDER BY sort_order ASC, created_at ASC`).all(orgId, options.includeArchived ? 1 : 0));
  return rows.map(categoryView);
}

export async function readCategory(orgId: string, categoryId: string) {
  const row = (await getEquipmentDatabase().prepare("SELECT * FROM equipment_categories WHERE organization_id = ? AND id = ?").get(orgId, categoryId));
  if (!row) throw notFound("equipment_category_not_found", "Equipment category was not found.");
  return categoryView(row);
}

export async function saveCategory(orgId: string, input: JsonObject) {
  return (await getEquipmentDatabase().transaction(async () => {
  const db = getEquipmentDatabase();
  const now = nowIso();
  const categoryId = cleanText(input.id) || newId("eqcat");
  const existing = (await db.prepare("SELECT * FROM equipment_categories WHERE organization_id = ? AND id = ?").get(orgId, categoryId));
  const expected = Number(input.expected_revision || 0);
  if (existing) {
    const current = Number(asObject(existing).revision || 1);
    if (expected && expected !== current) throw conflict("equipment_category_revision_conflict", "The category was changed elsewhere. Reload and try again.");
    (await db.prepare(`UPDATE equipment_categories SET name=?, icon=?, sort_order=?, status=?, revision=?, updated_at=?
      WHERE organization_id=? AND id=?`)
      .run(cleanText(input.name), cleanText(input.icon), Number(input.sort_order || 0), cleanText(input.status || "active"), current + 1, now, orgId, categoryId));
  } else {
    (await db.prepare(`INSERT INTO equipment_categories (id, organization_id, name, icon, sort_order, seed_key, status, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(categoryId, orgId, cleanText(input.name), cleanText(input.icon), Number(input.sort_order || 0), cleanText(input.seed_key), cleanText(input.status || "active"), now, now));
  }
  return (await readCategory(orgId, categoryId));

  }));
}

export async function archiveCategory(orgId: string, categoryId: string) {
  return (await getEquipmentDatabase().transaction(async () => {
  const result = (await getEquipmentDatabase().prepare("UPDATE equipment_categories SET status='archived', updated_at=? WHERE organization_id=? AND id=?")
    .run(nowIso(), orgId, categoryId));
  if (!Number(result.changes || 0)) throw notFound("equipment_category_not_found", "Equipment category was not found.");
  return (await readCategory(orgId, categoryId));

  }));
}

export async function countCategoriesWithSeedKey(orgId: string) {
  const row = asObject((await getEquipmentDatabase().prepare("SELECT COUNT(*) AS count FROM equipment_categories WHERE organization_id = ? AND seed_key <> ''").get(orgId)));
  return Number(row.count || 0);
}

/* Types -------------------------------------------------------------------- */

export async function listTypes(orgId: string, options: { includeArchived?: boolean; categoryId?: string } = {}) {
  const rows = (await getEquipmentDatabase().prepare(`SELECT * FROM equipment_types WHERE organization_id = ?
    AND (? = 1 OR status <> 'archived') AND (? = '' OR category_id = ?) ORDER BY sort_order ASC, created_at ASC`)
    .all(orgId, options.includeArchived ? 1 : 0, cleanText(options.categoryId), cleanText(options.categoryId)));
  return rows.map(typeView);
}

export async function readType(orgId: string, typeId: string) {
  const row = (await getEquipmentDatabase().prepare("SELECT * FROM equipment_types WHERE organization_id = ? AND id = ?").get(orgId, typeId));
  if (!row) throw notFound("equipment_type_not_found", "Equipment type was not found.");
  return typeView(row);
}

export async function saveType(orgId: string, input: JsonObject) {
  return (await getEquipmentDatabase().transaction(async () => {
  const db = getEquipmentDatabase();
  const now = nowIso();
  const typeId = cleanText(input.id) || newId("eqtype");
  const existing = (await db.prepare("SELECT * FROM equipment_types WHERE organization_id = ? AND id = ?").get(orgId, typeId));
  const expected = Number(input.expected_revision || 0);
  if (existing) {
    const current = Number(asObject(existing).revision || 1);
    if (expected && expected !== current) throw conflict("equipment_type_revision_conflict", "The equipment type was changed elsewhere. Reload and try again.");
    (await db.prepare(`UPDATE equipment_types SET name=?, kind=?, category_id=?, description=?, icon=?, color=?, tracking=?, mobility=?, pool_quantity=?,
      allow_double_booking=?, default_meter_kind=?, operator_requirements_json=?, attributes_schema_json=?, default_rates_json=?,
      scope_item_keys_json=?, status=?, sort_order=?, revision=?, updated_at=?
      WHERE organization_id=? AND id=?`)
      .run(cleanText(input.name), cleanText(input.kind || "other"), cleanText(input.category_id), cleanText(input.description), cleanText(input.icon), cleanText(input.color),
        cleanText(input.tracking || "unit"), cleanText(input.mobility || "mobile"), Number(input.pool_quantity || 0),
        input.allow_double_booking === true ? 1 : 0, cleanText(input.default_meter_kind || "none"),
        JSON.stringify(input.operator_requirements ?? []), JSON.stringify(input.attributes_schema ?? []), JSON.stringify(input.default_rates ?? {}),
        JSON.stringify(input.scope_item_keys ?? []), cleanText(input.status || "active"), Number(input.sort_order || 0), current + 1, now, orgId, typeId));
  } else {
    (await db.prepare(`INSERT INTO equipment_types (id, organization_id, name, kind, category_id, description, icon, color, tracking, mobility, pool_quantity,
      allow_double_booking, default_meter_kind, operator_requirements_json, attributes_schema_json, default_rates_json, scope_item_keys_json,
      status, sort_order, seed_key, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(typeId, orgId, cleanText(input.name), cleanText(input.kind || "other"), cleanText(input.category_id), cleanText(input.description), cleanText(input.icon), cleanText(input.color),
        cleanText(input.tracking || "unit"), cleanText(input.mobility || "mobile"), Number(input.pool_quantity || 0),
        input.allow_double_booking === true ? 1 : 0, cleanText(input.default_meter_kind || "none"),
        JSON.stringify(input.operator_requirements ?? []), JSON.stringify(input.attributes_schema ?? []), JSON.stringify(input.default_rates ?? {}),
        JSON.stringify(input.scope_item_keys ?? []), cleanText(input.status || "active"), Number(input.sort_order || 0), cleanText(input.seed_key), now, now));
  }
  return (await readType(orgId, typeId));

  }));
}

export async function archiveType(orgId: string, typeId: string) {
  return (await getEquipmentDatabase().transaction(async () => {
  const result = (await getEquipmentDatabase().prepare("UPDATE equipment_types SET status='archived', updated_at=? WHERE organization_id=? AND id=?")
    .run(nowIso(), orgId, typeId));
  if (!Number(result.changes || 0)) throw notFound("equipment_type_not_found", "Equipment type was not found.");
  return (await readType(orgId, typeId));

  }));
}

/* Units -------------------------------------------------------------------- */

export type UnitListOptions = {
  includeArchived?: boolean;
  typeId?: string;
  branchId?: string;
  status?: string;
  /** Filter by ownership; "internal" = every non-customer ownership (the fleet). */
  ownership?: string;
  contactId?: string;
  query?: string;
};

export async function listUnits(orgId: string, options: UnitListOptions = {}) {
  const ownership = cleanText(options.ownership);
  const query = cleanText(options.query).toLowerCase();
  const rows = (await getEquipmentDatabase().prepare(`SELECT * FROM equipment_units WHERE organization_id = ?
    AND (? = 1 OR archived_at = '')
    AND (? = '' OR type_id = ?)
    AND (? = '' OR branch_id = ?)
    AND (? = '' OR status = ?)
    AND (? = '' OR contact_id = ?)
    AND (
      ? = ''
      OR (? = 'internal' AND ownership <> 'customer')
      OR ownership = ?
    )
    ORDER BY name ASC, created_at ASC`)
    .all(orgId, options.includeArchived ? 1 : 0,
      cleanText(options.typeId), cleanText(options.typeId),
      cleanText(options.branchId), cleanText(options.branchId),
      cleanText(options.status), cleanText(options.status),
      cleanText(options.contactId), cleanText(options.contactId),
      ownership, ownership, ownership));
  const units = rows.map(unitView);
  if (!query) return units;
  return units.filter((unit) => [unit.name, unit.identifier, unit.serial_number, unit.license_plate, unit.make, unit.model, unit.vin]
    .some((field) => cleanText(field).toLowerCase().includes(query)));
}

export async function readUnit(orgId: string, unitId: string) {
  const row = (await getEquipmentDatabase().prepare("SELECT * FROM equipment_units WHERE organization_id = ? AND id = ?").get(orgId, unitId));
  if (!row) throw notFound("equipment_unit_not_found", "Equipment unit was not found.");
  return unitView(row);
}

export async function listYards(orgId: string, options: { includeArchived?: boolean } = {}) {
  const rows = (await getEquipmentDatabase().prepare(`SELECT * FROM equipment_yards
    WHERE organization_id = ? AND (? = 1 OR status <> 'archived')
    ORDER BY name ASC, created_at ASC`).all(orgId, options.includeArchived ? 1 : 0));
  return rows.map(yardView);
}

export async function readYard(orgId: string, yardId: string) {
  const row = (await getEquipmentDatabase().prepare("SELECT * FROM equipment_yards WHERE organization_id = ? AND id = ?").get(orgId, yardId));
  if (!row) throw notFound("equipment_yard_not_found", "Equipment yard was not found.");
  return yardView(row);
}

export async function saveYard(orgId: string, input: JsonObject) {
  return (await getEquipmentDatabase().transaction(async () => {
  const db = getEquipmentDatabase();
  const now = nowIso();
  const yardId = cleanText(input.id) || newId("eqyard");
  const existing = (await db.prepare("SELECT revision FROM equipment_yards WHERE organization_id = ? AND id = ?").get(orgId, yardId));
  if (existing) {
    const current = Number(asObject(existing).revision || 1);
    const expected = Number(input.expected_revision || 0);
    if (expected && expected !== current) throw conflict("equipment_yard_revision_conflict", "The yard was changed elsewhere. Reload and try again.");
    (await db.prepare(`UPDATE equipment_yards SET name=?, address_json=?, status=?, revision=?, updated_at=?
      WHERE organization_id=? AND id=?`).run(cleanText(input.name), JSON.stringify(input.address ?? {}), cleanText(input.status || "active"), current + 1, now, orgId, yardId));
  } else {
    (await db.prepare(`INSERT INTO equipment_yards (id, organization_id, name, address_json, status, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)`).run(yardId, orgId, cleanText(input.name), JSON.stringify(input.address ?? {}), cleanText(input.status || "active"), now, now));
  }
  return (await readYard(orgId, yardId));

  }));
}

export async function archiveYard(orgId: string, yardId: string) {
  return (await getEquipmentDatabase().transaction(async () => {
  const result = (await getEquipmentDatabase().prepare("UPDATE equipment_yards SET status='archived', revision=revision+1, updated_at=? WHERE organization_id=? AND id=?")
    .run(nowIso(), orgId, yardId));
  if (!Number(result.changes || 0)) throw notFound("equipment_yard_not_found", "Equipment yard was not found.");
  return (await readYard(orgId, yardId));

  }));
}

export async function saveUnit(orgId: string, input: JsonObject) {
  return (await getEquipmentDatabase().transaction(async () => {
  const db = getEquipmentDatabase();
  const now = nowIso();
  const unitId = cleanText(input.id) || newId("equnit");
  const existing = (await db.prepare("SELECT * FROM equipment_units WHERE organization_id = ? AND id = ?").get(orgId, unitId));
  const expected = Number(input.expected_revision || 0);
  if (existing) {
    const current = Number(asObject(existing).revision || 1);
    if (expected && expected !== current) throw conflict("equipment_unit_revision_conflict", "The unit was changed elsewhere. Reload and try again.");
    (await db.prepare(`UPDATE equipment_units SET type_id=?, branch_id=?, name=?, identifier=?, serial_number=?, license_plate=?, year=?, make=?, model=?, vin=?, color=?,
      ownership=?, contact_id=?, service_location_json=?, acquisition_json=?, status=?, condition_status_id=?, location_source=?, location_json=?,
      home_location_json=?, current_meter_json=?, rates_json=?, attributes_json=?, operator_tag_overrides_json=?, custody_json=?, photos_json=?,
      documents_json=?, tags_json=?, notes=?, revision=?, updated_at=?
      WHERE organization_id=? AND id=?`)
      .run(cleanText(input.type_id), cleanText(input.branch_id || "default"), cleanText(input.name), cleanText(input.identifier),
        cleanText(input.serial_number), cleanText(input.license_plate), cleanText(input.year), cleanText(input.make), cleanText(input.model), cleanText(input.vin), cleanText(input.color),
        cleanText(input.ownership || "owned"), cleanText(input.contact_id), JSON.stringify(input.service_location ?? {}), JSON.stringify(input.acquisition ?? {}),
        cleanText(input.status || "available"), cleanText(input.condition_status_id), cleanText(input.location_source || "manual"), JSON.stringify(input.location ?? {}),
        JSON.stringify(input.home_location ?? {}), JSON.stringify(input.current_meter ?? {}), JSON.stringify(input.rates ?? {}), JSON.stringify(input.attributes ?? {}),
        JSON.stringify(input.operator_tag_overrides ?? []), JSON.stringify(input.custody ?? {}), JSON.stringify(input.photos ?? []),
        JSON.stringify(input.documents ?? []), JSON.stringify(input.tags ?? []), cleanText(input.notes), current + 1, now, orgId, unitId));
  } else {
    (await db.prepare(`INSERT INTO equipment_units (id, organization_id, type_id, branch_id, name, identifier, serial_number, license_plate, year, make, model, vin, color,
      ownership, contact_id, service_location_json, acquisition_json, status, condition_status_id, location_source, location_json, home_location_json,
      current_meter_json, rates_json, attributes_json, operator_tag_overrides_json, custody_json, photos_json, documents_json, tags_json, notes,
      revision, created_at, updated_at, archived_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, '')`)
      .run(unitId, orgId, cleanText(input.type_id), cleanText(input.branch_id || "default"), cleanText(input.name), cleanText(input.identifier),
        cleanText(input.serial_number), cleanText(input.license_plate), cleanText(input.year), cleanText(input.make), cleanText(input.model), cleanText(input.vin), cleanText(input.color),
        cleanText(input.ownership || "owned"), cleanText(input.contact_id), JSON.stringify(input.service_location ?? {}), JSON.stringify(input.acquisition ?? {}),
        cleanText(input.status || "available"), cleanText(input.condition_status_id), cleanText(input.location_source || "manual"), JSON.stringify(input.location ?? {}),
        JSON.stringify(input.home_location ?? {}), JSON.stringify(input.current_meter ?? {}), JSON.stringify(input.rates ?? {}), JSON.stringify(input.attributes ?? {}),
        JSON.stringify(input.operator_tag_overrides ?? []), JSON.stringify(input.custody ?? {}), JSON.stringify(input.photos ?? []),
        JSON.stringify(input.documents ?? []), JSON.stringify(input.tags ?? []), cleanText(input.notes), now, now));
  }
  return (await readUnit(orgId, unitId));

  }));
}

export async function patchUnit(orgId: string, unitId: string, patch: JsonObject) {
  return (await getEquipmentDatabase().transaction(async () => {
  const current = (await readUnit(orgId, unitId));
  return (await saveUnit(orgId, { ...current, ...patch, id: unitId }));

  }));
}

export async function archiveUnit(orgId: string, unitId: string) {
  return (await getEquipmentDatabase().transaction(async () => {
  const result = (await getEquipmentDatabase().prepare("UPDATE equipment_units SET archived_at=?, status='retired', updated_at=? WHERE organization_id=? AND id=?")
    .run(nowIso(), nowIso(), orgId, unitId));
  if (!Number(result.changes || 0)) throw notFound("equipment_unit_not_found", "Equipment unit was not found.");
  return (await readUnit(orgId, unitId));

  }));
}

/* Meter entries ------------------------------------------------------------ */

export async function recordMeterEntry(orgId: string, input: JsonObject) {
  return (await getEquipmentDatabase().transaction(async () => {
  const db = getEquipmentDatabase();
  const id = newId("eqmeter");
  const now = nowIso();
  (await db.prepare(`INSERT INTO equipment_meter_entries (id, organization_id, unit_id, kind, value, gallons, cost_cents, recorded_at, source, event_id, user_id, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, orgId, cleanText(input.unit_id), cleanText(input.kind || "hours"), Number(input.value || 0), Number(input.gallons || 0),
      Number(input.cost_cents || 0), cleanText(input.recorded_at) || now, cleanText(input.source || "manual"), cleanText(input.event_id),
      cleanText(input.user_id), cleanText(input.notes), now));
  return meterEntryView((await db.prepare("SELECT * FROM equipment_meter_entries WHERE id = ?").get(id)));

  }));
}

export async function listMeterEntries(orgId: string, unitId: string, options: { kind?: string; limit?: number } = {}) {
  const rows = (await getEquipmentDatabase().prepare(`SELECT * FROM equipment_meter_entries WHERE organization_id = ? AND unit_id = ?
    AND (? = '' OR kind = ?) ORDER BY recorded_at DESC LIMIT ?`)
    .all(orgId, unitId, cleanText(options.kind), cleanText(options.kind), Math.max(1, Math.min(500, Number(options.limit || 100)))));
  return rows.map(meterEntryView);
}

export async function latestMeterEntry(orgId: string, unitId: string, kind: string) {
  const row = (await getEquipmentDatabase().prepare(`SELECT * FROM equipment_meter_entries WHERE organization_id = ? AND unit_id = ? AND kind = ?
    ORDER BY recorded_at DESC LIMIT 1`).get(orgId, unitId, kind));
  return row ? meterEntryView(row) : null;
}

/* Service programs ----------------------------------------------------------- */

export function programView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    organization_id: cleanText(value.organization_id),
    name: cleanText(value.name),
    kind: cleanText(value.kind || "service"),
    type_id: cleanText(value.type_id),
    unit_id: cleanText(value.unit_id),
    trigger: asObject(parseJson(value.trigger_json, {})),
    checklist: parseJson(value.checklist_json, []),
    lead_time_days: Number(value.lead_time_days || 0),
    estimated_downtime_hours: Number(value.estimated_downtime_hours || 0),
    estimated_cost_cents: Number(value.estimated_cost_cents || 0),
    status: cleanText(value.status || "active"),
    revision: Number(value.revision || 1),
    created_at: cleanText(value.created_at),
    updated_at: cleanText(value.updated_at)
  };
}

export async function listPrograms(orgId: string, options: { includeArchived?: boolean; unitId?: string; typeId?: string } = {}) {
  const rows = (await getEquipmentDatabase().prepare(`SELECT * FROM equipment_service_programs WHERE organization_id = ?
    AND (? = 1 OR status <> 'archived')
    AND (? = '' OR unit_id = ? OR unit_id = '')
    AND (? = '' OR type_id = ? OR type_id = '')
    ORDER BY created_at ASC`)
    .all(orgId, options.includeArchived ? 1 : 0,
      cleanText(options.unitId), cleanText(options.unitId),
      cleanText(options.typeId), cleanText(options.typeId)));
  return rows.map(programView);
}

export async function readProgram(orgId: string, programId: string) {
  const row = (await getEquipmentDatabase().prepare("SELECT * FROM equipment_service_programs WHERE organization_id = ? AND id = ?").get(orgId, programId));
  if (!row) throw notFound("equipment_program_not_found", "Service program was not found.");
  return programView(row);
}

export async function saveProgram(orgId: string, input: JsonObject) {
  return (await getEquipmentDatabase().transaction(async () => {
  const db = getEquipmentDatabase();
  const now = nowIso();
  const programId = cleanText(input.id) || newId("eqprog");
  const existing = (await db.prepare("SELECT * FROM equipment_service_programs WHERE organization_id = ? AND id = ?").get(orgId, programId));
  const expected = Number(input.expected_revision || 0);
  if (existing) {
    const current = Number(asObject(existing).revision || 1);
    if (expected && expected !== current) throw conflict("equipment_program_revision_conflict", "The service program was changed elsewhere. Reload and try again.");
    (await db.prepare(`UPDATE equipment_service_programs SET name=?, kind=?, type_id=?, unit_id=?, trigger_json=?, checklist_json=?,
      lead_time_days=?, estimated_downtime_hours=?, estimated_cost_cents=?, status=?, revision=?, updated_at=?
      WHERE organization_id=? AND id=?`)
      .run(cleanText(input.name), cleanText(input.kind || "service"), cleanText(input.type_id), cleanText(input.unit_id),
        JSON.stringify(input.trigger ?? {}), JSON.stringify(input.checklist ?? []), Number(input.lead_time_days || 0),
        Number(input.estimated_downtime_hours || 0), Number(input.estimated_cost_cents || 0), cleanText(input.status || "active"),
        current + 1, now, orgId, programId));
  } else {
    (await db.prepare(`INSERT INTO equipment_service_programs (id, organization_id, name, kind, type_id, unit_id, trigger_json, checklist_json,
      lead_time_days, estimated_downtime_hours, estimated_cost_cents, status, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(programId, orgId, cleanText(input.name), cleanText(input.kind || "service"), cleanText(input.type_id), cleanText(input.unit_id),
        JSON.stringify(input.trigger ?? {}), JSON.stringify(input.checklist ?? []), Number(input.lead_time_days || 0),
        Number(input.estimated_downtime_hours || 0), Number(input.estimated_cost_cents || 0), cleanText(input.status || "active"), now, now));
  }
  return (await readProgram(orgId, programId));

  }));
}

/* Work orders ----------------------------------------------------------------- */

export function workOrderView(row: unknown): JsonObject {
  const value = asObject(row);
  return {
    id: cleanText(value.id),
    organization_id: cleanText(value.organization_id),
    unit_id: cleanText(value.unit_id),
    program_id: cleanText(value.program_id),
    title: cleanText(value.title),
    kind: cleanText(value.kind || "repair"),
    status: cleanText(value.status || "open"),
    due_at: cleanText(value.due_at),
    due_meter: asObject(parseJson(value.due_meter_json, {})),
    scheduled_start_at: cleanText(value.scheduled_start_at),
    scheduled_end_at: cleanText(value.scheduled_end_at),
    completed_at: cleanText(value.completed_at),
    assigned_to: asObject(parseJson(value.assigned_to_json, {})),
    cost: asObject(parseJson(value.cost_json, {})),
    meter_at_service: asObject(parseJson(value.meter_at_service_json, {})),
    checklist_state: parseJson(value.checklist_state_json, []),
    downtime_event_id: cleanText(value.downtime_event_id),
    notes: cleanText(value.notes),
    revision: Number(value.revision || 1),
    created_at: cleanText(value.created_at),
    updated_at: cleanText(value.updated_at)
  };
}

export async function listWorkOrders(orgId: string, options: { unitId?: string; status?: string; programId?: string } = {}) {
  const rows = (await getEquipmentDatabase().prepare(`SELECT * FROM equipment_work_orders WHERE organization_id = ?
    AND (? = '' OR unit_id = ?)
    AND (? = '' OR status = ?)
    AND (? = '' OR program_id = ?)
    ORDER BY created_at DESC`)
    .all(orgId,
      cleanText(options.unitId), cleanText(options.unitId),
      cleanText(options.status), cleanText(options.status),
      cleanText(options.programId), cleanText(options.programId)));
  return rows.map(workOrderView);
}

export async function readWorkOrder(orgId: string, workOrderId: string) {
  const row = (await getEquipmentDatabase().prepare("SELECT * FROM equipment_work_orders WHERE organization_id = ? AND id = ?").get(orgId, workOrderId));
  if (!row) throw notFound("equipment_work_order_not_found", "Work order was not found.");
  return workOrderView(row);
}

export async function saveWorkOrder(orgId: string, input: JsonObject) {
  return (await getEquipmentDatabase().transaction(async () => {
  const db = getEquipmentDatabase();
  const now = nowIso();
  const workOrderId = cleanText(input.id) || newId("eqwo");
  const existing = (await db.prepare("SELECT * FROM equipment_work_orders WHERE organization_id = ? AND id = ?").get(orgId, workOrderId));
  const expected = Number(input.expected_revision || 0);
  if (existing) {
    const current = Number(asObject(existing).revision || 1);
    if (expected && expected !== current) throw conflict("equipment_work_order_revision_conflict", "The work order was changed elsewhere. Reload and try again.");
    (await db.prepare(`UPDATE equipment_work_orders SET unit_id=?, program_id=?, title=?, kind=?, status=?, due_at=?, due_meter_json=?,
      scheduled_start_at=?, scheduled_end_at=?, completed_at=?, assigned_to_json=?, cost_json=?, meter_at_service_json=?,
      checklist_state_json=?, downtime_event_id=?, notes=?, revision=?, updated_at=?
      WHERE organization_id=? AND id=?`)
      .run(cleanText(input.unit_id), cleanText(input.program_id), cleanText(input.title), cleanText(input.kind || "repair"),
        cleanText(input.status || "open"), cleanText(input.due_at), JSON.stringify(input.due_meter ?? {}),
        cleanText(input.scheduled_start_at), cleanText(input.scheduled_end_at), cleanText(input.completed_at),
        JSON.stringify(input.assigned_to ?? {}), JSON.stringify(input.cost ?? {}), JSON.stringify(input.meter_at_service ?? {}),
        JSON.stringify(input.checklist_state ?? []), cleanText(input.downtime_event_id), cleanText(input.notes), current + 1, now, orgId, workOrderId));
  } else {
    (await db.prepare(`INSERT INTO equipment_work_orders (id, organization_id, unit_id, program_id, title, kind, status, due_at, due_meter_json,
      scheduled_start_at, scheduled_end_at, completed_at, assigned_to_json, cost_json, meter_at_service_json, checklist_state_json,
      downtime_event_id, notes, revision, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .run(workOrderId, orgId, cleanText(input.unit_id), cleanText(input.program_id), cleanText(input.title), cleanText(input.kind || "repair"),
        cleanText(input.status || "open"), cleanText(input.due_at), JSON.stringify(input.due_meter ?? {}),
        cleanText(input.scheduled_start_at), cleanText(input.scheduled_end_at), cleanText(input.completed_at),
        JSON.stringify(input.assigned_to ?? {}), JSON.stringify(input.cost ?? {}), JSON.stringify(input.meter_at_service ?? {}),
        JSON.stringify(input.checklist_state ?? []), cleanText(input.downtime_event_id), cleanText(input.notes), now, now));
  }
  return (await readWorkOrder(orgId, workOrderId));

  }));
}

export async function latestCompletedWorkOrder(orgId: string, unitId: string, programId: string) {
  const row = (await getEquipmentDatabase().prepare(`SELECT * FROM equipment_work_orders WHERE organization_id = ? AND unit_id = ? AND program_id = ?
    AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`).get(orgId, unitId, programId));
  return row ? workOrderView(row) : null;
}

/* Settings ------------------------------------------------------------------ */

export async function readSettingsRow(orgId: string) {
  const row = (await getEquipmentDatabase().prepare("SELECT * FROM equipment_settings WHERE organization_id = ?").get(orgId));
  if (!row) return { settings: {}, revision: 0 };
  const value = asObject(row);
  return { settings: asObject(parseJson(value.settings_json, {})), revision: Number(value.revision || 1) };
}

export async function writeSettingsRow(orgId: string, settings: JsonObject, expectedRevision = 0) {
  return (await getEquipmentDatabase().transaction(async () => {
  const db = getEquipmentDatabase();
  const now = nowIso();
  const existing = (await db.prepare("SELECT revision FROM equipment_settings WHERE organization_id = ?").get(orgId));
  if (existing) {
    const current = Number(asObject(existing).revision || 1);
    if (expectedRevision && expectedRevision !== current) {
      throw conflict("equipment_settings_revision_conflict", "Equipment settings were changed elsewhere. Reload and try again.");
    }
    (await db.prepare("UPDATE equipment_settings SET settings_json=?, revision=?, updated_at=? WHERE organization_id=?")
      .run(JSON.stringify(settings), current + 1, now, orgId));
  } else {
    (await db.prepare("INSERT INTO equipment_settings (organization_id, settings_json, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)")
      .run(orgId, JSON.stringify(settings), now, now));
  }
  return (await readSettingsRow(orgId));

  }));
}
