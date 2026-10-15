import { zodToJsonSchema } from "zod-to-json-schema";
import type { JsonSchema } from "../platform/publication/contracts.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { contentHash } from "../platform/publication/validation.js";
import { eventRosterInputSchema, readEventRosters } from "./roster.js";

/**
 * What scheduling publishes about events beyond the events themselves. See docs/architecture/schedule-events.md
 * ("Roster and warnings"). It only reads.
 */
const strings = { type: "array", items: { type: "string" } };
const interval = { type: "object", required: ["from", "until"], properties: { from: { type: "string" }, until: { type: "string" } }, additionalProperties: false };
const intervals = { type: "array", items: interval };
const loose = { type: "object", additionalProperties: true };
const warning = {
  type: "object", required: ["id", "kind", "message", "accepted", "mode", "intervals"], additionalProperties: false,
  properties: {
    id: { type: "string" },
    kind: { enum: ["staffing_requirement_unmet", "double_booked", "unavailable", "unknown_assignee", "nobody_assigned", "assignee_overlap", "missing_member"] },
    message: { type: "string" }, accepted: { type: "boolean" }, mode: { enum: ["warn", "block"] },
    person_id: { type: "string" }, assignee_id: { type: "string" }, staffing_requirement_id: { type: "string" }, intervals
  }
};
const roster = {
  type: "object", required: ["people", "parties", "absent", "count", "party_count", "min_count", "max_count", "days"], additionalProperties: false,
  properties: {
    people: { type: "array", items: { type: "object", required: ["id", "user_id", "name", "via", "whole_window", "present"], properties: { id: { type: "string" }, user_id: { type: "string" }, name: { type: "string" }, via: strings, whole_window: { type: "boolean" }, present: intervals }, additionalProperties: false } },
    parties: { type: "array", items: { type: "object", required: ["id", "name", "present"], properties: { id: { type: "string" }, name: { type: "string" }, present: intervals }, additionalProperties: false } },
    absent: { type: "array", items: { type: "object", required: ["id", "name", "reason"], properties: { id: { type: "string" }, name: { type: "string" }, reason: { type: "string" } }, additionalProperties: false } },
    count: { type: "integer" }, party_count: { type: "integer" }, min_count: { type: "integer" }, max_count: { type: "integer" },
    days: { type: "array", items: { type: "object", required: ["date", "person_ids", "party_ids"], properties: { date: { type: "string" }, person_ids: strings, party_ids: strings }, additionalProperties: false } }
  }
};
const eventRoster = {
  type: "object", additionalProperties: false,
  required: ["event_id", "project_id", "parent_event_id", "draft", "window", "roster", "staffing_requirements", "warnings", "assignee_conflicts", "error"],
  properties: {
    event_id: { type: "string" }, project_id: { type: "string" }, parent_event_id: { type: "string" }, draft: { type: "boolean" },
    window: { anyOf: [interval, { type: "null" }] }, roster: { anyOf: [roster, { type: "null" }] },
    staffing_requirements: { type: "array", items: loose }, warnings: { type: "array", items: warning },
    assignee_conflicts: { type: "array", items: loose }, error: { type: "string" }
  }
};
export const eventRosterSchema: JsonSchema = {
  type: "object", required: ["timezone", "overlap_mode", "events"], additionalProperties: false,
  properties: { timezone: { type: "string" }, overlap_mode: { enum: ["warn", "block", "allow"] }, events: { type: "array", items: eventRoster } }
};

let registered = false;
export function registerSchedulePublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "schedule-roster", version: "1", apps: ["scheduling", "project-schedule"], exports: {
    events: {
      description: "Who is on each schedule event and what is wrong with it, from the assignee roster and its check. Pass the events (`project_id`, `event_id`; children are included unless `include_children` is false), or a `draft` being placed (the event as it would be saved; its children are re-placed against it as the save would). Each event returns its roster (the people on it, a person in two groups once, with who is there each local day; outside companies as single parties), its staffing requirements met or not, and warnings: unmet staffing requirements, a person promised to two things at once, an assignee over its capacity, people who are off, members who are no longer active and entries naming no one. Warnings never block; an overlap carries the assignee's overlap setting as `mode`. Only assignees in the reader's branches are considered. Derived: nothing here is stored on the event.",
      schema: eventRosterSchema, schemaVersion: "1",
      argsSchema: zodToJsonSchema(eventRosterInputSchema, { $refStrategy: "none" }) as JsonSchema,
      access: { scopes: ["organization"] as const, permissions: ["view_schedule"], systemKinds: ["work", "module", "agent"] as const },
      read: async (ctx, ref) => {
        const value = await readEventRosters(ctx.organizationId, ctx.auth, ctx.branchId || ctx.auth?.branchId || "default", ref.args || {});
        return { value, revision: `sha256:${contentHash(value)}` };
      }
    }
  } });
}
