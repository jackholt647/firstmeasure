import { AsyncLocalStorage } from 'node:async_hooks';
const batches = new AsyncLocalStorage<string>();
export const currentSyntheticBatch = () => batches.getStore() || '';
export const withSyntheticBatch = <T>(key: string, run: () => Promise<T>) => batches.run(key, run);
import { createHash } from "node:crypto";
import { env } from "../src/config/env.js";
import { readOrganization, readDocument, listDocuments, upsertDocument } from "../platform/storage.js";
import * as channels from "../channels/storage.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { ensureEquipmentSeed, scheduleWorkOrder } from "../equipment/service.js";
import { getEquipmentDatabase, listCategories, listTypes, listUnits, listYards, listWorkOrders, saveType, saveUnit, saveYard, saveWorkOrder } from "../equipment/storage.js";
import { sandboxStore, sandboxError, type JsonObject } from "../signup-sandbox/storage.js";

export function sampleId(orgId: string, key: string) {
  return `sample_${createHash("sha256").update(`${orgId}:${currentSyntheticBatch() ? currentSyntheticBatch()+":" : ""}${key}`).digest("hex").slice(0, 24)}`;
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
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["equipment", "channels", "projects", "customers"].includes(key)) || Object.values(input).some(value => typeof value !== "boolean")) {
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
  for (const [key, capability] of [["channels", "apps.channels"], ["projects", "apps.projects"], ["customers", "platform.contacts"]]) {
    if (input[key!] && !await isCapabilityEnabled(orgId, capability!)) throw sandboxError(400, "sample_app_disabled", `Enable ${key} for this test organization first.`);
  }
  const result: JsonObject = {};
  if (input.equipment) result.equipment = await seedEquipment(orgId);
  if (input.customers) result.customers = await seedCustomers(orgId);
  if (input.projects) result.projects = await seedProjects(orgId);
  if (input.channels) result.channels = await seedChannels(orgId);
  return result;
}

const sampleMetadata = { synthetic: true, source: "signup_sandbox_samples" };

async function createSampleDocument(orgId: string, collection: string, id: string, data: JsonObject) {
  if (await existingDocument(orgId, collection, id)) return false;
  try {
    await upsertDocument(orgId, collection, { id, data: { id, ...data }, metadata: sampleMetadata }, { createOnly: true });
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === "document_exists") return false;
    throw error;
  }
}

const customerSpecs = [
  ["avery", "Avery Morgan", "104 Example Maple Street"],
  ["jordan", "Jordan Rivera", "218 Sample Cedar Lane"],
  ["taylor", "Taylor Chen", "360 Example Harbor Way"],
  ["casey", "Casey Brooks", "72 Sample Willow Court"],
  ["riley", "Riley Patel", "915 Example Pine Avenue"]
] as const;

export async function seedCustomers(orgId: string) {
  let created = 0;
  for (const [key, name, address] of customerSpecs) {
    const contactId = sampleId(orgId, `customer:${key}`);
    const recordId = sampleId(orgId, `customer-record:${key}`);
    const contact = { id: contactId, contact_id: contactId, name: `${name} (Sample)`, email: `${key}@example.test`, address, default_address: address, primary: true };
    // Contacts use the same standalone contact-only records as the real New Contact flow.
    if (await createSampleDocument(orgId, "projects", recordId, {
      title: contact.name, project_title: contact.name, branch_id: "default", project_type: "residential",
      workflow_state: "contact_only", contacts: [contact], contact_id: contactId, primary_contact_id: contactId,
      contact_ids: [contactId], address, tags: ["Sample"], events: [], proposals: [], photos: [],
      measurement: {}, measurement_project: {}, notes: "Synthetic customer for testing."
    })) created++;
  }
  return { created };
}

export async function seedProjects(orgId: string, includeEvents = true) {
  let created = 0;
  const specs = [
    ["maple", "Maple Residence — roof replacement", "104 Example Maple Street", "active", "production", -2],
    ["cedar", "Cedar Duplex — gutter replacement", "218 Sample Cedar Lane", "active", "proposal", 3],
    ["harbor", "Harbor Office — leak repair", "360 Example Harbor Way", "active", "production", 1],
    ["willow", "Willow Court — exterior refresh", "72 Sample Willow Court", "completed", "completed", -14]
  ] as const;
  const now = Date.now();
  for (const [key, title, address, status, stage, day] of specs) {
    const id = sampleId(orgId, `project:${key}`);
    if (await createSampleDocument(orgId, "projects", id, {
      title: `${title} (Sample)`, project_title: `${title} (Sample)`, address, branch_id: "default", project_type: "residential",
      workflow_state: "project", status, stage, tags: ["Sample"], contacts: [], proposals: [], photos: [],
      notes: "Synthetic project for testing. Add a customer when you need one.",
      events: (includeEvents ? [0, 1, 2] : []).map(index => ({ id: sampleId(orgId, `project:${key}:event:${index}`), project_id: id,
        branch_id: "default", title: ["Site visit", "Scheduled work", "Final walkthrough"][index],
        kind: "project_work", event_type_default_id: "project_work", status: day + index < 0 ? "completed" : "scheduled",
        start_at: new Date(now + (day + index) * 86400000).toISOString(), end_at: new Date(now + (day + index) * 86400000 + 7200000).toISOString(),
        duration_minutes: 120, resource_refs: [], customer_visible: false }))
    })) created++;
  }
  return { created };
}

export async function seedChannels(orgId: string, includeMessages = true) {
  const users = await listDocuments(orgId, "users");
  const owner = users.find(row => (row.data as JsonObject)?.role === "owner");
  if (!owner) throw sandboxError(400, "sample_owner_missing", "This test organization needs an owner before adding channel samples.");
  const people = [["alex", "Alex Morgan (Sample)"], ["sam", "Sam Rivera (Sample)"]] as const;
  for (const [key, name] of people) await createSampleDocument(orgId, "users", sampleId(orgId, `channel-person:${key}`), {
    name, display_name: name, email: `${key}@example.test`, role: "viewer", roles: [], permissions: {}, status: "active", branch_id: "default", account_type: "employee"
  });
  return channels.getChannelsDatabase().transaction(async () => {
    const existing = await channels.listChannelRecords(orgId, { includeArchived: true });
    let created = 0;
    let messages = 0;
    const specs = [
      ["general", "Company updates", ["Welcome to the sample workspace. These conversations are fictional.", "The weekly planning meeting is ready for review.", "Thanks, I will bring the updated checklist."]],
      ["field-ops", "Daily field coordination", ["Tomorrow’s crew handoff is at 8 a.m. at the sample yard.", "Materials are staged and the access route is clear.", "I will review the safety checklist before work starts."]],
      ["equipment", "Fleet coordination", ["Please review equipment availability before scheduling a job.", "The sample inspection is on the maintenance calendar.", "Understood. I will check the reservation before assigning a trailer."]],
      ["project-planning", "Project planning examples", ["The next sample project is ready for a site visit.", "I have drafted the plan and added a walkthrough.", "Let’s review the access details together."]]
    ] as const;
    for (const [key, topic, texts] of specs) {
      const seedKey = `signup_samples:${currentSyntheticBatch()}:${key}`.replace("signup_samples::", "signup_samples:");
      let channel = existing.find(row => row.settings.sample_data_key === seedKey);
      if (!channel) {
        channel = await channels.createChannelRecord({ organization_id: orgId, type: "public", name: `sample-${key}${currentSyntheticBatch() ? "-"+sampleId(orgId,key).slice(-8) : ""}`, topic: `${topic} — synthetic test data`, created_by: String(owner.id), settings: { sample_data_key: seedKey } });
        await channels.upsertChannelMember({ organization_id: orgId, channel_id: channel.id, user_id: String(owner.id), role: "owner" });
        for (const [person] of people) await channels.upsertChannelMember({ organization_id: orgId, channel_id: channel.id, user_id: sampleId(orgId, `channel-person:${person}`), role: "member" });
        created++;
      }
      if (channel.archived_at || !includeMessages) continue;
      let parentId: string | null = null;
      for (const [index, text] of texts.entries()) {
        const authorId = sampleId(orgId, `channel-person:${index === 1 ? "sam" : "alex"}`);
        const clientId = `${seedKey}:${index}`;
        let message = await channels.findMessageByClientId(channel.id, authorId, clientId);
        if (!message) {
          message = await channels.createMessageRecord({ organization_id: orgId, channel_id: channel.id, author_id: authorId, client_msg_id: clientId, parent_id: parentId, text,
            language_code: "en", language_confidence: 1, tags: ["synthetic"], metadata: sampleMetadata,
            created_at: new Date(Date.now() - (3 - index) * 3600000).toISOString() });
          messages++;
        }
        if (!parentId) parentId = message.id;
      }
    }
    return { created, messages };
  });
}

export async function seedEquipment(orgId: string, includeEvents = true) {
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
    if (!includeEvents) return { created };
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

