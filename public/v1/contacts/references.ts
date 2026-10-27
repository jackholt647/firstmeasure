import type { SqlStore } from "../platform/sql_store.js";
import type { JsonObject } from "../platform/storage.js";

// What a merge must repoint (docs/architecture/contacts.md "References").
// Every SQL table with a contact_id or project_id column is declared here as
// moved by an adapter or kept on purpose; tests/contact-references-coverage
// fails when a table is in neither list.

export type ReferenceAdapter = {
  id: string;
  /** SQL tables this adapter moves. */
  tables?: string[];
  repoint(org: string, fromId: string, toId: string): Promise<number>;
};

const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

/** Tables that keep the old id: history that belongs to the record it happened on, or rows the merge itself handles. */
export const CONTACT_TABLES_KEPT: Record<string, string> = {
  contact_points: "The merge itself unions points onto the survivor.",
  contact_branches: "The merge itself unions branches onto the survivor.",
  contact_links: "The merge itself moves links.",
  lead_contact_notes: "Legacy sales portal lead database, removed in contacts phase 5.",
  lead_dial_events: "Legacy sales portal lead database, removed in contacts phase 5."
};
export const PROJECT_TABLES_KEPT: Record<string, string> = {
  contact_links: "The merge itself unions the project's contacts.",
  work_plans: "Plans are not spliced; the merged project's open plans are closed with reason merged.",
  work_nodes: "They belong to the merged project's plans.",
  work_events: "History of the merged project's plans.",
  channels: "A project has one channel; the merged project's stays as its history.",
  comms_agent_threads: "Assistant threads are per project and per user.",
  comms_auto_replies: "Per-project auto-reply settings.",
  crm_call_list_entries: "Entries follow the merged project's plans, which close.",
  payroll_ledger_entries: "Posted ledger entries are never edited.",
  stats_events: "Stats are rebuilt from the records by sync.",
  stats_projects: "Stats are rebuilt from the records by sync.",
  project_queue_events: "FirstMeasure measurement report history.",
  firstmeasure_import_projects: "FirstMeasure measurement report imports.",
  firstmeasure_artifact_catalog: "FirstMeasure report artifacts.",
  crew_checklists: "Field checklists done on the merged project.",
  crew_checklist_items: "Field checklists done on the merged project.",
  appointment_slot_holds: "Short-lived booking holds.",
  project_changes: "The merged project's change history stays where it happened.",
  generation_runs: "Generator runs on the merged project are its history."
};

/** Document collections whose project references move with a project merge. The rest keep their history. */
export const PROJECT_DOCUMENT_COLLECTIONS_MOVED = [
  "documents", "document_events", "proposals", "proposal_events", "calendar_events", "appointment_bookings", "action_items", "activity",
  "feedback_requests", "customer_portals", "public_links", "recurrence_series", "recurrence_occurrences", "material_lists", "material_orders",
  "material_deliveries", "material_events", "payment_schedules", "payment_obligations", "payment_transactions", "payment_allocations",
  "payment_intents", "payment_invoices", "payment_receipts", "payment_events", "payment_ledger_events", "payment_autopay", "payment_saved_methods", "payment_checkouts"
];

const KEYS = { contact: ["contact_id", "primary_contact_id", "consent_contact"], project: ["project_id"] } as const;
const LIST_KEYS = { contact: ["contact_ids"], project: ["project_ids"] } as const;

/** Replaces an id wherever a JSON value names it under one of the kind's keys. Returns whether anything changed. */
export function replaceIdIn(value: unknown, kind: "contact" | "project", fromId: string, toId: string): { value: unknown; changed: boolean } {
  let changed = false;
  const visit = (node: unknown, key = ""): unknown => {
    if (Array.isArray(node)) {
      if ((LIST_KEYS[kind] as readonly string[]).includes(key)) {
        const next = [...new Set(node.map(entry => entry === fromId ? (changed = true, toId) : entry))];
        return next;
      }
      return node.map(entry => visit(entry));
    }
    if (!node || typeof node !== "object") return node;
    const out: JsonObject = {};
    for (const [k, v] of Object.entries(node)) {
      if ((KEYS[kind] as readonly string[]).includes(k) && v === fromId) { out[k] = toId; changed = true; }
      else out[k] = visit(v, k);
    }
    return out;
  };
  const next = visit(value);
  return { value: next, changed };
}

function sqlAdapter(id: string, store: () => Promise<SqlStore> | SqlStore, tables: string[], column: "contact_id" | "project_id"): ReferenceAdapter {
  return {
    id, tables,
    async repoint(org, fromId, toId) {
      const db = await store();
      let moved = 0;
      for (const table of tables) moved += Number((await db.prepare(`UPDATE ${table} SET ${column}=? WHERE organization_id=? AND ${column}=?`).run(toId, org, fromId)).changes || 0);
      return moved;
    }
  };
}

/** Walks document collections; the projection on projects is rebuilt by the merge, so it is skipped. */
function documentsAdapter(kind: "contact" | "project", collections: () => Promise<readonly string[]>): ReferenceAdapter {
  return {
    id: `${kind}-documents`,
    async repoint(org, fromId, toId) {
      const storage = await import("../platform/storage.js");
      let moved = 0;
      for (const collection of await collections()) {
        const rows = await storage.listDocuments(org, collection).catch(() => [] as Awaited<ReturnType<typeof storage.listDocuments>>);
        for (const row of rows) {
          if (!JSON.stringify(row.data ?? {}).includes(fromId)) continue;
          const { contacts: projection, ...rest } = object(row.data);
          const result = replaceIdIn(rest, kind, fromId, toId);
          if (!result.changed) continue;
          await storage.upsertDocument(org, collection, { id: row.id, expected_revision: row.revision, data: { ...object(result.value), ...(projection !== undefined ? { contacts: projection } : {}) }, metadata: row.metadata }, { replace: true, contactsProjection: true });
          moved++;
        }
      }
      return moved;
    }
  };
}

/** JSON columns that can name a contact: to-do contact refs on work nodes, relationship fields on other contacts. */
function jsonColumnAdapter(id: string, store: () => Promise<SqlStore> | SqlStore, table: string, column: string, kind: "contact" | "project"): ReferenceAdapter {
  return {
    id,
    async repoint(org, fromId, toId) {
      const db = await store();
      let moved = 0;
      const rows = await db.prepare(`SELECT id, ${column} AS value FROM ${table} WHERE organization_id=? AND ${column} LIKE ?`).all(org, `%${fromId}%`);
      for (const row of rows) {
        let parsed: unknown; try { parsed = JSON.parse(text(row.value)); } catch { continue; }
        const result = replaceIdIn(parsed, kind, fromId, toId);
        if (!result.changed) continue;
        await db.prepare(`UPDATE ${table} SET ${column}=? WHERE organization_id=? AND id=?`).run(JSON.stringify(result.value), org, text(row.id));
        moved++;
      }
      return moved;
    }
  };
}

function mediaAdapter(ownerType: "contact" | "project"): ReferenceAdapter {
  return {
    id: `${ownerType}-media`,
    async repoint(org, fromId, toId) {
      const storage = await import("../platform/storage.js");
      let moved = 0;
      for (const media of await storage.listMedia(org)) {
        const owner = object((media as JsonObject).owner);
        if (text(owner.type) !== ownerType || text(owner.id) !== fromId) continue;
        await storage.reassignMediaOwner(org, text((media as JsonObject).id), toId);
        moved++;
      }
      return moved;
    }
  };
}

const communications = async () => (await import("../messaging/communications_storage.js")).getCommunicationsDatabase();
const allCollections = async () => (await import("../platform/storage.js")).PLATFORM_DOCUMENT_COLLECTIONS;

export function contactReferenceAdapters(): ReferenceAdapter[] {
  return [
    sqlAdapter("comms", communications, ["customer_calls", "communication_conversations", "communication_messages", "communication_sms_consents", "chat_visitors"], "contact_id"),
    sqlAdapter("appointments", async () => (await import("../appointments/storage.js")).getAppointmentsDatabase(), ["appointment_confirmations"], "contact_id"),
    sqlAdapter("equipment", async () => (await import("../equipment/storage.js")).getEquipmentDatabase(), ["equipment_units"], "contact_id"),
    jsonColumnAdapter("todo-contact-refs", async () => (await import("../work/storage.js")).getWorkDatabase(), "work_nodes", "metadata_json", "contact"),
    jsonColumnAdapter("contact-relationships", async () => (await import("./store.js")).contactStore(), "contacts", "custom_field_values_json", "contact"),
    documentsAdapter("contact", allCollections),
    mediaAdapter("contact")
  ];
}

export function projectReferenceAdapters(): ReferenceAdapter[] {
  return [
    sqlAdapter("project-comms", communications, ["customer_calls", "communication_conversations", "communication_messages"], "project_id"),
    sqlAdapter("project-appointments", async () => (await import("../appointments/storage.js")).getAppointmentsDatabase(), ["appointment_confirmations", "appointment_reschedule_sessions"], "project_id"),
    documentsAdapter("project", async () => PROJECT_DOCUMENT_COLLECTIONS_MOVED),
    // Markup on report PDFs and other non-media documents is keyed by project, so it moves to the survivor's key.
    { id: "project-document-markup", async repoint(org, fromId, toId) { return (await import("../projects/document-markup.js")).projectDocumentMarkupAdapter().repoint(org, fromId, toId); } },
    mediaAdapter("project")
  ];
}

/** Every table an adapter moves, for the coverage test. */
export function coveredTables(kind: "contact" | "project") {
  const adapters = kind === "contact" ? contactReferenceAdapters() : projectReferenceAdapters();
  return new Set([...adapters.flatMap(adapter => adapter.tables || []), ...(kind === "contact" ? ["work_nodes", "contacts"] : [])]);
}
