import { ASSIGNEE_TYPE_BY_KIND, ASSIGNEE_TYPES } from "../labor/assignees.js";
import { laborLinesOf, listCommitments } from "../labor/commitments.js";
import { MATERIAL_LIST_COLLECTION } from "../materials/storage.js";
import type { AccessPolicy } from "../platform/publication/contracts.js";
import type { DataExport } from "../platform/publication/providers.js";
import { listDocuments, type JsonObject } from "../platform/storage.js";
import { TIME_CLOCK_EXPORTS, timeClockExports } from "./time-clock-sources.js";

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

/**
 * Projected pay. A collection that takes a boolean `projected` argument publishes, when it is true, the work that is
 * not done yet with each row as it is expected to look once it is done; payroll/pay-refresh.ts `projectPayeeEarnings`
 * runs a pay rule's own selection and formula over those rows instead of the real ones. The collection owns what
 * "done" means and when it is expected, so a rule needs no projected variant of itself.
 *
 * Labor: a current commitment that is neither released nor finalized (labor/completion.ts) is projected, as is an
 * assigned labor list that was never committed. A finalized commitment is earned, not projected. `asDone` is the one
 * place that says what a row looks like once its work is done: finished work is finalized, never released, so it stays
 * `committed` and carries `finalized_at`, here the expected date. Change it with the finished row's shape.
 */
const isLaborDone = (entry: { id: string; status: string }, finalized: ReadonlySet<string>) => entry.status !== "committed" || finalized.has(entry.id);
const asDone = (row: JsonObject, expected: { at: string; from: string }) => ({ ...row, status: "committed", released_at: "", release_reason: "", finalized_at: expected.at, finalized_by_user_id: "", completion_method: "", expected_from: expected.from, projected: true });
const NOT_SCHEDULED = new Set(["unscheduled", "canceled", "cancelled", "deleted", "removed"]);
/** The latest instant a schedule (an event, or a list's or commitment's copy of one, with its parts) ends, or starts when it has no end. */
function scheduleEnd(schedule: unknown) {
  const value = object(schedule);
  const ends = [value, ...Object.values(object(value.parts)).map(object)]
    .filter((part) => !NOT_SCHEDULED.has(text(part.status).toLowerCase()) && !part.deleted_at)
    .map((part) => Date.parse(text(part.end_at) || text(part.start_at))).filter(Number.isFinite);
  return ends.length ? new Date(Math.max(...ends)).toISOString() : "";
}
async function projectedLaborRows(orgId: string): Promise<JsonObject[]> {
  const commitments = await listCommitments(orgId);
  // A store that is not registered holds no completions; any other failure to read them fails the reading, since
  // projecting finalized work as well would count it twice.
  // A list paid out in part is projected only for its lines nobody has been paid for yet.
  const unpaid = await (await import("../labor/completion.js")).unpaidShares(orgId);
  const finalized = await (await import("../labor/completion.js")).finalizedCommitmentIds(orgId)
    .catch((error: { code?: string }) => { if (error?.code === "invalid_collection") return new Set<string>(); throw error; });
  const lists = new Map((await listDocuments(orgId, MATERIAL_LIST_COLLECTION)).map((document) => [document.id, object(document.data)]));
  const projects = new Map((await listDocuments(orgId, "projects")).map((document) => [document.id, object(document.data)]));
  /** When the work on a list is expected to be done: its schedule event as it stands, else the list's copy of it, else what was frozen when it was committed. */
  const expected = (list: JsonObject | undefined, projectId: string, frozen?: unknown) => {
    const eventId = text(list?.schedule_event_id || object(list?.schedule).event_id);
    const event = eventId ? (Array.isArray(projects.get(projectId)?.events) ? projects.get(projectId)!.events as unknown[] : []).map(object).find((entry) => text(entry.id) === eventId) : undefined;
    const fromEvent = event ? scheduleEnd({ ...event, parts: object(list?.schedule).parts }) : "";
    if (fromEvent) return { at: fromEvent, from: "schedule_event" };
    const fromList = list ? scheduleEnd(list.schedule) : "";
    if (fromList) return { at: fromList, from: "labor_list" };
    const fromCommitment = scheduleEnd(frozen);
    return fromCommitment ? { at: fromCommitment, from: "commitment" } : { at: "", from: "" };
  };
  const rows: JsonObject[] = [];
  for (const entry of commitments) {
    if (isLaborDone(entry, finalized)) continue;
    rows.push(asDone({
      id: entry.id, assignee_key: `${entry.assignee.type}:${entry.assignee.id}`, assignee_name: entry.assignee.name, unit_id: entry.unit?.id || "",
      project_id: entry.project_id, project_title: entry.project_title, list_id: entry.list_id, title: entry.title, ...unpaid(entry),
      committed_at: entry.committed_at, projected_from: "commitment"
    }, expected(lists.get(entry.list_id), entry.project_id, entry.schedule)));
  }
  // A list that has a commitment of any kind is accounted for by it; one that was never committed is projected from its own lines.
  const committed = new Set(commitments.map((entry) => entry.list_id));
  for (const [id, list] of lists) {
    if (committed.has(id) || text(list.resource_type) !== "labor" || ["archived", "deleted"].includes(text(list.status))) continue;
    const reference = object(object(list.assignment).work_resource_ref), type = ASSIGNEE_TYPE_BY_KIND[text(reference.kind)];
    const items = (Array.isArray(list.current_items) ? list.current_items : []).map(object);
    if (!type || !text(reference.id) || !items.length) continue;
    const lines = laborLinesOf(items), projectId = text(list.project_id), project = projects.get(projectId);
    rows.push(asDone({
      id: `labor_list:${id}`, assignee_key: `${type}:${text(reference.id)}`, assignee_name: text(reference.name), unit_id: text(object(list.assignment).unit_id),
      project_id: projectId, project_title: text(project?.title || project?.address), list_id: id, title: text(list.title) || "Labor",
      total_cents: lines.reduce((sum, line) => sum + (line.total_cents || 0), 0), unpriced_lines: lines.filter((line) => line.total_cents == null).length,
      committed_at: "", projected_from: "labor_list"
    }, expected(list, projectId)));
  }
  return rows;
}

/** The time clock is published beside these (time-clock-sources.ts); a rule reads it like any other collection. */
export const PAY_SOURCE_EXPORTS = [...TIME_CLOCK_EXPORTS, "project_records", "labor_commitments", "work_roster"] as const;
export function paySourceExports(): Record<typeof PAY_SOURCE_EXPORTS[number], DataExport> {
  return {
    ...timeClockExports(),
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
    work_roster: {
      description: "Who is on each scheduled piece of work, from the schedule roster (the same answer as schedule-roster.events): one row per person, or outside company, per interval they are on a project's schedule event, after removals, time off and unavailability. `assignee_key` (`organization_user:<id>`, or the company's key), `user_id`, `name`, `via` (the assignees that put them there), `project_id`, `event_id`, `parent_event_id`, `title`, exact `from` and `until` instants and `seconds`. Past and future work alike; `revision` changes with anything in the row. Split rules read it to divide an earning by who was actually on the work.",
      schema: rows, schemaVersion: "1", access, units: { seconds: "seconds" },
      read: async (ctx) => ({ value: await (await import("./roster-sources.js")).workRosterRows(ctx.organizationId, ctx.auth) })
    },
    labor_commitments: {
      description: "Labor lists committed to an assignee, one row per commitment: `assignee_key`, `unit_id`, `project_id`, `status` (committed, released, superseded), `total_cents` of its priced lines, `unpriced_lines`, `committed_at` and `released_at`. A release covers both finished work and work taken back; `release_reason` says which when someone recorded it. With args `{ \"projected\": true }` the rows are instead the labor not done yet, each as it is expected to look once done, for projected pay: every current commitment that is neither released nor finalized, and every assigned labor list that has never been committed (`committed_at` blank), each as finished work looks: `status` committed and `finalized_at` the expected date (the end of its schedule event, else the list's or the commitment's schedule; blank when nothing is scheduled), `expected_from` (schedule_event, labor_list, commitment or blank), `projected_from` (commitment or labor_list) and `projected: true`. Once its work is confirmed as done and marked to be paid it also carries `finalized_at`, `finalized_by_user_id` and `completion_method` (empty until then, and again if a manager reopens it); piece-rate pay is earned on `finalized_at`. Finished work is finalized, never released.",
      schema: rows, schemaVersion: "1", access, units: { total_cents: "currency minor units" },
      argsSchema: { type: "object", properties: { projected: { type: "boolean" } }, additionalProperties: false },
      // One row per commitment, and one per payout of part of a list (labor/completion.ts laborPayRows): each earns on its own finalized_at.
      read: async (ctx, ref) => ({ value: ref.args?.projected === true ? await projectedLaborRows(ctx.organizationId) : await (await import("../labor/completion.js")).laborPayRows(ctx.organizationId, await listCommitments(ctx.organizationId)) })
    }
  };
}
