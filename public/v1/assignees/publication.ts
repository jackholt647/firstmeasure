import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import type { JsonSchema, PublicationContext } from "../platform/publication/contracts.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { contentHash } from "../platform/publication/validation.js";
import { ASSIGNEE_TYPE_KINDS, assigneeProfileInputSchema, assigneeTypeInputSchema, groupTypeMemberRolesInputSchema, listAssigneeBases, listAssigneeTypes, permissionDefaultsInputSchema, readCompanyPermissionDefaults, saveAssigneeType, setAssigneeProfile, setGroupStaffingRequirements, setGroupTypeMemberRoles, setPermissionDefaults, type Actor } from "./base.js";
import { ASSIGNEE_KINDS, assigneeKey } from "./contract.js";
import { loadAssigneeDirectory } from "./directory.js";
import { checkAssignment, loadRoster, rosterInputSchema } from "./roster.js";
import { listTimeOff, removeTimeOff, saveTimeOff, timeOffInputSchema } from "./time-off.js";

/**
 * What the assignee base publishes. See docs/architecture/assignee-base.md.
 *
 * `assignee-directory` is the collection: one row per assignee, selectable with `selectPublishedData`.
 * `assignment-roster` answers who is on a piece of work and what is wrong with an assignment; it takes the assignment
 * list and the window as arguments. Every read here only reads.
 */
type Obj = Record<string, unknown>;
const strings = { type: "array", items: { type: "string" } };
const interval = { type: "object", required: ["from", "until"], properties: { from: { type: "string" }, until: { type: "string" } }, additionalProperties: false };
const intervals = { type: "array", items: interval };
const fields = { type: "object", additionalProperties: true };
const traits = { type: "object", required: ["has_members", "has_login", "external_link", "splits_pay"], properties: { has_members: { type: "boolean" }, has_login: { type: "boolean" }, external_link: { type: "boolean" }, splits_pay: { type: "boolean" } }, additionalProperties: false };
const member = { type: "object", required: ["id", "user_id", "name", "role", "is_lead", "status", "type_ids", "tag_ids", "fields"], properties: { id: { type: "string" }, user_id: { type: "string" }, name: { type: "string" }, role: { type: "string" }, is_lead: { type: "boolean" }, status: { type: "string" }, type_ids: strings, tag_ids: strings, fields }, additionalProperties: false };
export const assigneeRowSchema: JsonSchema = {
  type: "object",
  required: ["id", "kind", "assignee_id", "name", "status", "type_ids", "type_names", "role_ids", "tag_ids", "department_ids", "branch_ids", "traits", "link_status", "fields", "fields_error", "member_ids", "member_count", "members", "member_fields", "member_tag_ids", "member_type_ids", "group_ids", "revision"],
  properties: {
    id: { type: "string" }, kind: { enum: [...ASSIGNEE_KINDS] }, assignee_id: { type: "string" }, name: { type: "string" }, status: { enum: ["active", "inactive", "archived"] },
    type_ids: strings, type_names: strings, role_ids: strings, tag_ids: strings, department_ids: strings, branch_ids: strings, traits, link_status: { type: "string" },
    fields, fields_error: { type: "string" }, member_ids: strings, member_count: { type: "integer" }, members: { type: "array", items: member }, member_fields: fields,
    member_tag_ids: strings, member_type_ids: strings, group_ids: strings, revision: { type: "string" }
  },
  additionalProperties: false
};
const typeSchema = { type: "object", required: ["id", "name", "description", "status", "kind", "member_role_ids"], properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" }, status: { enum: ["active", "archived"] }, kind: { enum: [...ASSIGNEE_TYPE_KINDS] }, member_role_ids: strings }, additionalProperties: false };
const timeOffSchema = { type: "object", required: ["id", "assignee_id", "assignee", "from", "until", "reason", "revision"], properties: { id: { type: "string" }, assignee_id: { type: "string" }, assignee: { type: "object" }, from: { type: "string" }, until: { type: "string" }, reason: { type: "string" }, revision: { type: "integer" } }, additionalProperties: false };
// Conditions nest, which JSON Schema here cannot say without references; the domain function validates them in full.
const staffingRequirementSchema = { type: "object", required: ["id", "label", "count", "where"], properties: { id: { type: "string" }, label: { type: "string" }, count: { type: "integer", minimum: 1 }, where: { type: "object", required: ["rules"], properties: { match: { enum: ["all", "any"] }, rules: { type: "array", items: { type: "object" } } }, additionalProperties: false } }, additionalProperties: false };
const assigneeArg = { type: "object", required: ["type", "id"], properties: { type: { enum: [...ASSIGNEE_KINDS] }, id: { type: "string" } }, additionalProperties: false };
const groupStaffingRequirementRow = { type: "object", required: ["id", "assignee_id", "staffing_requirements", "revision"], properties: { id: { type: "string" }, assignee_id: { type: "string" }, staffing_requirements: { type: "array", items: { type: "object" } }, revision: { type: "integer" } }, additionalProperties: false };
const unavailable = { type: "array", items: { type: "object", required: ["from", "until", "reason", "source", "source_id"], properties: { from: { type: "string" }, until: { type: "string" }, reason: { type: "string" }, source: { type: "string" }, source_id: { type: "string" } }, additionalProperties: false } };
const personBase = { id: { type: "string" }, user_id: { type: "string" }, name: { type: "string" }, type_ids: strings, tag_ids: strings, department_ids: strings, group_ids: strings, fields, via: strings, removed: intervals, unavailable };
const rosterSchema: JsonSchema = {
  type: "object", required: ["window", "assigned", "people", "absent", "parties", "conflicts", "unknown", "timeline", "facts"], additionalProperties: false,
  properties: {
    window: interval,
    assigned: { type: "array", items: { type: "object", required: ["id", "kind", "name"], properties: { id: { type: "string" }, kind: { type: "string" }, name: { type: "string" } }, additionalProperties: false } },
    people: { type: "array", items: { type: "object", required: ["id", "user_id", "name", "present", "whole_window", "fields"], properties: { ...personBase, present: intervals, whole_window: { type: "boolean" } }, additionalProperties: false } },
    absent: { type: "array", items: { type: "object", required: ["id", "name", "reason"], properties: { ...personBase, reason: { enum: ["unavailable", "removed", "inactive"] } }, additionalProperties: false } },
    parties: { type: "array", items: { type: "object", required: ["id", "name", "present"], properties: { id: { type: "string" }, name: { type: "string" }, type_ids: strings, tag_ids: strings, present: intervals, unavailable }, additionalProperties: false } },
    conflicts: { type: "array", items: { type: "object", required: ["id", "person_id", "name", "work", "intervals"], properties: { id: { type: "string" }, person_id: { type: "string" }, name: { type: "string" }, work: { type: "object", required: ["id", "title", "project_id"], properties: { id: { type: "string" }, title: { type: "string" }, project_id: { type: "string" } }, additionalProperties: false }, intervals }, additionalProperties: false } },
    unknown: { type: "array", items: { type: "object", required: ["id", "op"], properties: { id: { type: "string" }, op: { type: "string" } }, additionalProperties: false } },
    timeline: { type: "array", items: { type: "object", required: ["from", "until", "person_ids", "party_ids"], properties: { from: { type: "string" }, until: { type: "string" }, person_ids: strings, party_ids: strings }, additionalProperties: false } },
    facts: { type: "object", required: ["count", "min_count", "max_count", "party_count", "person_hours", "type_ids", "tag_ids", "person_ids", "fields"], properties: { count: { type: "integer" }, min_count: { type: "integer" }, max_count: { type: "integer" }, party_count: { type: "integer" }, person_hours: { type: "number" }, type_ids: strings, tag_ids: strings, person_ids: strings, fields }, additionalProperties: false }
  }
};
const staffingRequirementResult = { type: "object", required: ["id", "staffing_requirement_id", "label", "count", "source", "met", "unmet", "matching_ids", "missing", "reason"], properties: { id: { type: "string" }, staffing_requirement_id: { type: "string" }, label: { type: "string" }, count: { type: "integer" }, source: { type: "object" }, met: { type: "boolean" }, unmet: { type: "array", items: { type: "object", required: ["from", "until", "matching"], properties: { from: { type: "string" }, until: { type: "string" }, matching: { type: "integer" } }, additionalProperties: false } }, matching_ids: strings, missing: { type: "array", items: { type: "object", required: ["id", "name", "reason", "intervals"], properties: { id: { type: "string" }, name: { type: "string" }, reason: { enum: ["unavailable", "removed", "not_assigned", "inactive"] }, intervals }, additionalProperties: false } }, reason: { type: "string" } }, additionalProperties: false };
const warning = { type: "object", required: ["id", "kind", "message", "accepted", "intervals"], properties: { id: { type: "string" }, kind: { enum: ["staffing_requirement_unmet", "double_booked", "unavailable", "unknown_assignee", "nobody_assigned"] }, message: { type: "string" }, accepted: { type: "boolean" }, person_id: { type: "string" }, staffing_requirement_id: { type: "string" }, intervals }, additionalProperties: false };
const checkSchema: JsonSchema = { type: "object", required: ["ok", "roster", "staffing_requirements", "warnings", "timezone"], properties: { ok: { type: "boolean" }, roster: rosterSchema, staffing_requirements: { type: "array", items: staffingRequirementResult }, warnings: { type: "array", items: warning }, timezone: { type: "string" } }, additionalProperties: false };

const revision = (value: unknown) => `sha256:${contentHash(value)}`;
/** A published action run by a person carries their session; one run by the platform itself has already been authorized by the publication layer. */
const actor = (ctx: PublicationContext): Actor => (ctx.auth ? ctx.auth : { orgId: ctx.organizationId, userId: "", branchId: ctx.branchId, system: true });
const systemKinds = ["work", "module", "agent"] as const;
const everyKind = ["api", "module", "agent", "work"] as const;
const args = (schema: Parameters<typeof zodToJsonSchema>[0]) => zodToJsonSchema(schema, { $refStrategy: "none" }) as Obj;

let registered = false;
export function registerAssigneePublication() {
  if (registered) return;
  registered = true;
  const read = { scopes: ["organization"] as const, permissions: ["view_schedule"], systemKinds };
  registerDataProvider({ id: "assignee-directory", version: "1", apps: ["settings", "scheduling", "crew", "sales", "materials", "payroll"], exports: {
    assignees: {
      description: "Everyone work can be assigned to, one row each, in one shape: people, groups of users and outside companies. A row has a stable id (`organization_user:<id>`, `resource_group:<id>`, `organization_connection:<id>`), its kind, name, status, tags, departments, the branches it belongs to (`branch_ids`; empty for a company that works in every branch) and its structural traits (has members, has a login, can be linked, splits pay). `type_ids` is a list for every kind: a person's types are their access roles (also given as `role_ids`), a group has exactly one type, and an outside company has zero or more company types; `type_names` names them in the same order. A person's row carries their custom field values under `fields` (fields that are private or need a permission are left out) and the groups they are in. A group's row carries its members with their fields, the member count, and under `member_fields` each field as the list of its members' values, so groups with a member for whom something is true can be selected with `contains`. Select rows with a declared selection. A person limited to some branches sees only the rows of those branches.",
      schema: { type: "array", items: assigneeRowSchema }, schemaVersion: "1", access: read,
      read: async (ctx) => {
        const directory = await loadAssigneeDirectory(ctx.organizationId);
        // Branch scope (docs/architecture/branches.md): a person reading sees the rows of the branches they may see. An outside company with no branch works in every branch.
        if (!ctx.auth) return { value: directory.rows, revision: directory.revision };
        const { branchScope, canSeeBranches } = await import("../workforce/branch-scope.js");
        const scope = branchScope(ctx.auth);
        const rows = directory.rows.filter((row) => canSeeBranches(scope, row.branch_ids, row.kind === "organization_connection"));
        return { value: rows, revision: rows.length === directory.rows.length ? directory.revision : revision(rows.map((row) => [row.id, row.revision])) };
      }
    },
    types: {
      description: "The organization's group types and company types. `kind` says which list a type is in. A group has exactly one group type; an outside company can have several company types. A group type's `member_role_ids` are the access roles a user is given when they join a group of that type. There is no user type: a person's types are their access roles.",
      schema: { type: "array", items: typeSchema }, schemaVersion: "1", access: read,
      read: async (ctx) => { const value = (await listAssigneeTypes(ctx.organizationId)).types; return { value, revision: revision(value) }; }
    },
    "time-off": {
      description: "When people and outside companies are off, as exact intervals: `from` is the first instant they are off and `until` the instant they are back. Select by period on `from` or `until`. Whole days marked unavailable in the scheduling settings are not listed here; the roster reads those too.",
      schema: { type: "array", items: timeOffSchema }, schemaVersion: "1", access: read,
      read: async (ctx) => { const value = await listTimeOff(ctx.organizationId); return { value, revision: revision(value.map((entry) => [entry.id, entry.revision])) }; }
    },
    "permission-defaults": {
      description: "The permission set one outside company carries: the roles and overrides its own people get on this organization's projects, with the revision to save against. Name the company by its assignee key as the target id (`organization_connection:<id>`). It is for permission administrators and is not part of the directory row. A company with nothing saved reads as empty roles and overrides at revision 0.",
      schema: { type: "object", required: ["assignee", "permission_defaults", "revision"], properties: { assignee: assigneeArg, permission_defaults: { type: "object", required: ["access_role_ids", "permission_overrides"], properties: { access_role_ids: strings, permission_overrides: { type: "object", additionalProperties: { type: "boolean" } } }, additionalProperties: false }, revision: { type: "integer" } }, additionalProperties: false },
      schemaVersion: "1", access: { scopes: ["organization"] as const, permissions: ["manage_company_user_permissions"] },
      read: async (ctx, ref) => { const value = await readCompanyPermissionDefaults(ctx.organizationId, ref.target.id); return { value, revision: revision(value) }; }
    },
    "staffing-requirements": {
      description: "Who each group of users should always have when it is given work: each staffing requirement is a count and a condition over the people on the work (at least N people for whom the condition holds).",
      schema: { type: "array", items: groupStaffingRequirementRow }, schemaVersion: "1", access: read,
      read: async (ctx) => { const value = (await listAssigneeBases(ctx.organizationId)).filter((base) => base.staffing_requirements.length).map((base) => ({ id: assigneeKey(base.assignee), assignee_id: assigneeKey(base.assignee), staffing_requirements: base.staffing_requirements, revision: base.revision })); return { value, revision: revision(value) }; }
    }
  } });

  const rosterArgs = args(rosterInputSchema);
  const checkArgs = { ...rosterArgs, properties: { ...(rosterArgs.properties as Obj), staffing_requirements: { type: "array", items: staffingRequirementSchema }, accepted: strings } };
  const rosterAccess = { scopes: ["organization", "project"] as const, permissions: ["view_schedule"], systemKinds };
  registerDataProvider({ id: "assignment-roster", version: "1", apps: ["scheduling", "crew", "sales", "materials", "payroll"], exports: {
    roster: {
      description: "Who is actually on a piece of work. Pass the assignment as a list of entries that add or remove an assignee, each optionally limited to part of the work (`from`, `until`), and the work's window. Returns the people on the work with their fields and exactly when each is on it; the people the list names who are not on it and why (removed, or off, with the exact intervals); outside companies as single parties; people who are on other work at the same time; the window cut wherever the roster changes; and facts about the whole roster (count, fewest and most at once, person-hours, and each field as the list of everyone's values). Time is compared as exact intervals. A person in two assigned groups is counted once.",
      schema: rosterSchema, schemaVersion: "1", argsSchema: rosterArgs, access: rosterAccess,
      read: async (ctx, ref) => { const { roster } = await loadRoster(ctx.organizationId, ref.args || {}); return { value: roster, revision: revision(roster) }; }
    },
    check: {
      description: "What is wrong with an assignment. Pass the assignment list, the window and the work's own staffing requirements (each a count and a condition over the people on the work). The standing staffing requirements of every group the list adds are checked too. Returns each staffing requirement with whether it is met, exactly when it is not and a plain sentence saying why, and one warning for each unmet one, each person promised to two things at once, each person who is off, and each entry naming no one. These are warnings: nothing is refused. Pass the ids of warnings already accepted in `accepted`.",
      schema: checkSchema, schemaVersion: "1", argsSchema: checkArgs, access: rosterAccess,
      read: async (ctx, ref) => { const value = await checkAssignment(ctx.organizationId, ref.args || {}); return { value, revision: revision(value) }; }
    }
  } });

  const settings = { scopes: ["organization"] as const, permissions: ["manage_company_settings"] };
  const write = { effect: "write" as const, executionKinds: everyKind, idempotency: "required" as const, version: "1", domain: "workforce", implementation: backendImplementationDigest() };
  const permissions = { scopes: ["organization"] as const, permissions: ["manage_company_user_permissions"] };
  registerAction({ ...write, id: "assignees.type.save", description: "add a group type or a company type to the organization's lists, or rename or archive one. `kind` says which list. It does not change the roles a group type gives its members.", inputSchema: args(assigneeTypeInputSchema), outputSchema: typeSchema as Obj, policy: settings, execute: (ctx, _target, input) => saveAssigneeType(ctx.organizationId, input, actor(ctx)) });
  registerAction({ ...write, id: "assignees.type.member-roles.set", description: "set the access roles a user is given when they join a group of this type. The roles are added to a user on joining; people who are already members are not changed, and leaving a group removes no role.", inputSchema: args(groupTypeMemberRolesInputSchema), outputSchema: typeSchema as Obj, policy: permissions, execute: (ctx, _target, input) => setGroupTypeMemberRoles(ctx.organizationId, input, actor(ctx)) });
  registerAction({ ...write, id: "assignees.profile.set", description: "set an assignee's types, its tags, or both. Tags work the same for a person, a group of users and an outside company. Types: the whole list of company types for an outside company, exactly one group type for a group; a person's types are their access roles and are not set here.", inputSchema: args(assigneeProfileInputSchema), outputSchema: { type: "object", required: ["assignee", "id", "name", "type_ids", "tag_ids"], properties: { assignee: { type: "object" }, id: { type: "string" }, name: { type: "string" }, type_ids: strings, tag_ids: strings }, additionalProperties: false }, policy: settings, execute: (ctx, _target, input) => setAssigneeProfile(ctx.organizationId, input, actor(ctx)) });
  registerAction({ ...write, id: "assignees.staffing-requirements.set", description: "replace who a group of users should always have when it is given work: each staffing requirement is a count and a condition over the people on the work.", inputSchema: { type: "object", required: ["assignee", "staffing_requirements"], properties: { assignee: assigneeArg, staffing_requirements: { type: "array", items: staffingRequirementSchema }, expected_revision: { type: "integer", minimum: 0 } }, additionalProperties: false }, outputSchema: { type: "object", required: ["assignee", "staffing_requirements", "revision"], properties: { assignee: { type: "object" }, staffing_requirements: { type: "array", items: staffingRequirementSchema }, revision: { type: "integer" } }, additionalProperties: false }, policy: settings, execute: (ctx, _target, input) => setGroupStaffingRequirements(ctx.organizationId, input, actor(ctx)) });
  registerAction({ ...write, id: "assignees.permission-defaults.set", description: "set the permission set an outside company carries: the roles and overrides its own people get on this organization's projects. It is stored only and changes no one's permissions.", inputSchema: args(permissionDefaultsInputSchema), outputSchema: { type: "object", required: ["assignee", "applies_to", "access_role_ids", "permission_overrides", "revision"], properties: { assignee: { type: "object" }, applies_to: { enum: ["external_people"] }, access_role_ids: strings, permission_overrides: { type: "object", additionalProperties: { type: "boolean" } }, revision: { type: "integer" } }, additionalProperties: false }, policy: permissions, execute: (ctx, _target, input) => setPermissionDefaults(ctx.organizationId, input, actor(ctx)) });
  const schedule = { scopes: ["organization"] as const, permissions: ["manage_schedule"] };
  registerAction({ ...write, id: "assignees.time-off.save", description: "record that a person or an outside company is off for an exact interval, or change an entry. Part of a day is allowed.", inputSchema: args(timeOffInputSchema), outputSchema: timeOffSchema as Obj, policy: schedule, execute: (ctx, _target, input) => saveTimeOff(ctx.organizationId, input, actor(ctx)) });
  registerAction({ ...write, id: "assignees.time-off.remove", description: "remove a time off entry.", inputSchema: { type: "object", required: ["id"], properties: { id: { type: "string" } }, additionalProperties: false }, outputSchema: { type: "object", required: ["id", "removed"], properties: { id: { type: "string" }, removed: { type: "boolean" } }, additionalProperties: false }, policy: schedule, execute: (ctx, _target, input) => removeTimeOff(ctx.organizationId, input, actor(ctx)) });
}
