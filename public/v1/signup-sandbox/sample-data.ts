import { createHash } from "node:crypto";
import { env } from "../src/config/env.js";
import { readOrganization, readDocument, upsertDocument } from "../platform/storage.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { ensureEquipmentSeed, scheduleWorkOrder } from "../equipment/service.js";
import { getEquipmentDatabase, listCategories, listTypes, listUnits, listYards, listWorkOrders, saveType, saveUnit, saveYard, saveWorkOrder } from "../equipment/storage.js";
import { sandboxStore, sandboxError, type JsonObject } from "./storage.js";

export function sampleId(orgId: string, key: string) {
  return `sample_${createHash("sha256").update(`${orgId}:${key}`).digest("hex").slice(0, 24)}`;
}

async function existingDocument(orgId: string, collection: string, id: string) {
  return readDocument(orgId, collection, id).catch(error => {
    if (error?.code === "not_found") return null;
    throw error;
  });
}

/** Explicit development fixture operation. Stable tenant-specific IDs preserve edits on repeat. */
export async function addTestOrgSampleData(instanceId: string, input: JsonObject) {
  if (env.isProduction) throw sandboxError(404, "not_found", "Not found.");
  if (Object.keys(input).some(key => key !== "equipment") || Object.values(input).some(value => typeof value !== "boolean")) {
    throw sandboxError(400, "invalid_sample_selection", "Choose sample data using boolean toggles.");
  }
  const record = await sandboxStore.readTestOrg(instanceId);
  if (!record) throw sandboxError(404, "test_org_not_found", "Test organization not found.");
  const orgId = String(record.org_id);
  const org = await readOrganization(orgId);
  const metadata = (org.metadata || {}) as JsonObject;
  if (metadata.sandbox_test_org !== true || metadata.sandbox_instance_id !== instanceId || record.workflow_id !== "swf_instant_full_org") {
    throw sandboxError(403, "sample_data_test_org_required", "Sample data is available only for full test organizations.");
  }
  if (input.equipment && !await isCapabilityEnabled(orgId, "apps.equipment")) {
    throw sandboxError(400, "equipment_disabled", "Enable Equipment for this test organization first.");
  }
  const result: JsonObject = {};
  if (input.equipment) result.equipment = await seedEquipment(orgId);
  return result;
}

async function seedEquipment(orgId: string) {
  return getEquipmentDatabase().transaction(async () => {
    await ensureEquipmentSeed(orgId);
    const id = (key: string) => sampleId(orgId, `equipment:${key}`);
    const categories = new Map((await listCategories(orgId)).map(row => [String(row.seed_key), row.id]));
    const types = new Set((await listTypes(orgId, { includeArchived: true })).map(row => String(row.id)));
    const units = new Set((await listUnits(orgId, { includeArchived: true })).map(row => String(row.id)));
    const yards = new Set((await listYards(orgId, { includeArchived: true })).map(row => String(row.id)));
    const orders = new Set((await listWorkOrders(orgId)).map(row => String(row.id)));
    const created = { types: 0, units: 0, yards: 0, work_orders: 0, reservations: 0 };
    if (!yards.has(id("yard"))) {
      await saveYard(orgId, { id: id("yard"), name: "Sample Operations Yard", address: { formatted: "100 Example Industrial Way (synthetic)" } });
      created.yards++;
    }
    const specs = [
      ["pickup", "Service Pickup", "vehicle", "vehicles", "fa-truck-pickup"],
      ["van", "Crew Van", "vehicle", "vehicles", "fa-van-shuttle"],
      ["trailer", "Equipment Trailer", "trailer", "trailers", "fa-trailer"],
      ["skid", "Skid Steer", "other", "heavy_equipment", "fa-truck-monster"],
      ["generator", "Portable Generator", "tool", "tools", "fa-bolt"]
    ];
    for (const [key, name, kind, category, icon] of specs) {
      if (!types.has(id(`type:${key}`))) {
        await saveType(orgId, { id: id(`type:${key}`), name, kind, category_id: categories.get(category!), icon, tracking: "unit", description: "Synthetic test equipment" });
        created.types++;
      }
      for (let number = 1; number <= 2; number++) {
        const unitId = id(`unit:${key}:${number}`);
        if (units.has(unitId)) continue;
        await saveUnit(orgId, { id: unitId, type_id: id(`type:${key}`), name: `${name} ${String(number).padStart(2, "0")} (Sample)`, identifier: `SAMPLE-${key!.toUpperCase()}-${number}`, ownership: "owned", status: key === "van" && number === 2 ? "retired" : "available", location: { yard_id: id("yard"), name: "Sample Operations Yard" }, home_location: { yard_id: id("yard") }, tags: ["sample-data"], notes: "Synthetic equipment for testing. Safe to edit." });
        created.units++;
      }
    }
    const now = Date.now();
    const at = (hours: number) => new Date(now + hours * 3600000).toISOString();
    for (const [key, unitKey, title, start, end] of [
      ["repair", "pickup:2", "Sample brake inspection", -1, 24],
      ["service", "skid:1", "Sample scheduled service", 48, 52]
    ] as const) {
      if (orders.has(id(`order:${key}`))) continue;
      await saveWorkOrder(orgId, { id: id(`order:${key}`), unit_id: id(`unit:${unitKey}`), title, kind: "repair", status: "open", downtime_event_id: id(`maintenance:${key}`), notes: "Synthetic maintenance example" });
      await scheduleWorkOrder(orgId, id(`order:${key}`), { start_at: at(start), end_at: at(end) });
      created.work_orders++;
    }
    const reservation = id("reservation");
    if (!await existingDocument(orgId, "calendar_events", reservation)) {
      await upsertDocument(orgId, "calendar_events", { id: reservation, data: { title: "Sample trailer reservation", kind: "equipment_reservation", event_type_default_id: "equipment_reservation", branch_id: "default", status: "scheduled", start_at: at(-1), end_at: at(24), resource_refs: [{ kind: "equipment_unit", id: id("unit:trailer:1"), role: "equipment" }] }, metadata: { synthetic: true, source: "signup_sandbox_samples" } });
      created.reservations++;
    }
    return { created };
  });
}

