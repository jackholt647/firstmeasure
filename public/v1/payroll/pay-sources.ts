import { ASSIGNEE_TYPES } from "../labor/assignees.js";
import { listCommitments } from "../labor/commitments.js";
import { badRequest } from "../platform/errors.js";
import type { AccessPolicy } from "../platform/publication/contracts.js";
import type { DataExport } from "../platform/publication/providers.js";
import { listDocuments, type JsonObject } from "../platform/storage.js";
import { listClosedCrewTimeShifts } from "../workforce/crew_storage.js";

/**
 * Collections published for pay rules to select from. Every row has a stable
 * `id`, and names who it belongs to as an `assignee_key` (`type:id`) so one
 * condition matches a person, a group of users or an outside company alike.
 * These are answered by reading the collection today; see
 * platform/publication/select.ts for how an index replaces that later.
 */
const access: AccessPolicy = { scopes: ["organization"], permissions: ["manage_payroll|manage_company_settings"], capabilities: ["apps.payroll"] };
const rows = { type: "array", items: { type: "object", required: ["id"], additionalProperties: true } };
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const assigneeKey = (value: unknown) => {
  const type = text(object(value).subject_type || object(value).type), id = text(object(value).subject_id || object(value).id);
  return (ASSIGNEE_TYPES as readonly string[]).includes(type) && id ? `${type}:${id}` : "";
};

/** For every field holding an assignee (or several), the same path holding their keys as a list. Other fields are left out. */
export function assigneeKeysOf(values: unknown, depth = 0): JsonObject {
  const keys: JsonObject = {};
  if (depth > 12) return keys;
  for (const [name, value] of Object.entries(object(values))) {
    const direct = (Array.isArray(value) ? value : [value]).map(assigneeKey).filter(Boolean);
    if (direct.length) keys[name] = direct;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = assigneeKeysOf(value, depth + 1);
      if (Object.keys(nested).length) keys[name] = nested;
    }
  }
  return keys;
}

async function projectFacts(orgId: string) {
  const { getStatsDatabase, readSyncState } = await import("../stats/storage.js");
  const state = await readSyncState(orgId);
  if (!state || !Number(state.backfill_done)) return null;
  const facts = await getStatsDatabase().prepare(`SELECT project_id, status, stage_key, sold_at, completed_at, canceled_at, contract_cents, collected_cents,
    outstanding_cents, expenses_cents, profit_cents FROM stats_projects WHERE organization_id=?`).all(orgId);
  return new Map(facts.map((row) => [String(row.project_id), row as JsonObject]));
}

export const PAY_SOURCE_EXPORTS = ["time_shifts", "project_records", "labor_commitments"] as const;
export function paySourceExports(): Record<typeof PAY_SOURCE_EXPORTS[number], DataExport> {
  return {
    time_shifts: {
      description: "Closed time clock shifts, one row each: who worked (`user_id`, `assignee_key`), `project_id`, clock-in and clock-out, `worked_seconds` net of breaks, and `approval_status` (pending, approved, rejected). A corrected shift has a new revision.",
      schema: rows, schemaVersion: "1", access, units: { worked_seconds: "seconds", break_seconds: "seconds" },
      read: async () => { throw badRequest("source_list_required", "List or select time shifts; there can be too many to read at once."); },
      list: async (ctx, _ref, page) => {
        const shifts = await listClosedCrewTimeShifts(ctx.organizationId, { after: page.cursor, limit: page.limit + 1 });
        const items = shifts.slice(0, page.limit).map((shift) => ({
          id: shift.id, revision: shift.revision, user_id: shift.user_id, assignee_key: `organization_user:${shift.user_id}`, project_id: shift.project_id,
          clocked_in_at: shift.clocked_in_at, clocked_out_at: shift.clocked_out_at, worked_seconds: shift.worked_seconds, break_seconds: shift.break_seconds,
          approval_status: shift.approval_status, approved_at: shift.approved_at
        }));
        return { items, ...(shifts.length > page.limit ? { nextCursor: items.at(-1)!.id } : {}) };
      }
    },
    project_records: {
      description: "Every project, one row each: `title`, `status`, `created_at`, its stored custom field values under `fields`, and under `assignee_keys` the same paths for fields that hold an assignee, as lists of `type:id` keys (match with `contains`). With args `{ \"facts\": true }` each row also carries indexed `sold_at`, `completed_at`, `canceled_at`, `stage_key` and money in cents (`contract_cents`, `collected_cents`, `outstanding_cents`, `expenses_cents`, `profit_cents`); that reading is pending until project indexing has finished.",
      schema: rows, schemaVersion: "1", access,
      units: { contract_cents: "currency minor units", collected_cents: "currency minor units", outstanding_cents: "currency minor units", expenses_cents: "currency minor units", profit_cents: "currency minor units" },
      argsSchema: { type: "object", properties: { facts: { type: "boolean" } }, additionalProperties: false },
      read: async (ctx, ref) => {
        const facts = ref.args?.facts === true ? await projectFacts(ctx.organizationId) : undefined;
        if (facts === null) return { status: "pending", code: "project_facts_pending", message: "Project indexing has not finished, so sold dates and money are not available yet." };
        const value = (await listDocuments(ctx.organizationId, "projects")).map((document) => {
          const data = object(document.data), fields = object(data.custom_field_values || data.custom_fields), fact = facts?.get(document.id);
          return {
            id: document.id, title: text(data.title || data.name || data.project_name || data.address), status: text(fact?.status || data.status),
            created_at: text(data.created_at || (document as unknown as JsonObject).created_at), fields, assignee_keys: assigneeKeysOf(fields),
            ...(fact ? {
              stage_key: text(fact.stage_key), sold_at: text(fact.sold_at), completed_at: text(fact.completed_at), canceled_at: text(fact.canceled_at),
              contract_cents: Number(fact.contract_cents || 0), collected_cents: Number(fact.collected_cents || 0), outstanding_cents: Number(fact.outstanding_cents || 0),
              expenses_cents: Number(fact.expenses_cents || 0), profit_cents: Number(fact.profit_cents || 0)
            } : {})
          };
        });
        return { value };
      }
    },
    labor_commitments: {
      description: "Labor lists committed to an assignee, one row per commitment: `assignee_key`, `unit_id`, `project_id`, `status` (committed, released, superseded), `total_cents` of its priced lines, `unpriced_lines`, `committed_at` and `released_at`. A release covers both finished work and work taken back; `release_reason` says which when someone recorded it.",
      schema: rows, schemaVersion: "1", access, units: { total_cents: "currency minor units" },
      read: async (ctx) => ({ value: (await listCommitments(ctx.organizationId)).map((entry) => ({
        id: entry.id, assignee_key: `${entry.assignee.type}:${entry.assignee.id}`, assignee_name: entry.assignee.name, unit_id: entry.unit?.id || "",
        project_id: entry.project_id, list_id: entry.list_id, status: entry.status, total_cents: entry.total_cents, unpriced_lines: entry.unpriced_lines,
        committed_at: entry.committed_at, released_at: entry.released_at || "", release_reason: entry.release_reason || ""
      })) })
    }
  };
}
