import { systemPublicationContext } from "../platform/publication/context.js";
import { contentHash } from "../platform/publication/validation.js";
import { listAssigneeRecords, listAssigneeTypes } from "./base.js";
import { assigneeKey, type AssigneeKind, type AssigneeRecord, type AssigneeTraits } from "./contract.js";

/**
 * The assignee directory: one row per assignee, in one shape for all three kinds, with what the data layer needs to
 * select them and to reason about who is in a group. Everything here only reads.
 *
 * What is true of a person lives on them as an ordinary user custom field ("has a CDL"). A row for a person publishes
 * those values under `fields`; a row for a group publishes its members with their fields and, under `member_fields`,
 * every member's value for each field as a list, so "groups with a CDL driver" is the ordinary selection
 * `{ field: "member_fields.has_cdl", operator: "contains", value: true }`. No field is special.
 *
 * `type_ids` is a list for every kind: a person's access role ids, a group's one type, an outside company's zero or
 * more company types.
 */
export type DirectoryMember = { id: string; user_id: string; name: string; role: string; is_lead: boolean; status: string; type_ids: string[]; tag_ids: string[]; fields: Record<string, unknown> };
export type DirectoryRow = {
  /** `organization_user:<id>`, `resource_group:<id>` or `organization_connection:<id>`. Stable. */
  id: string;
  kind: AssigneeKind;
  assignee_id: string;
  name: string;
  status: string;
  /** A person: their access role ids. A group: its one type. An outside company: zero or more company types. */
  type_ids: string[];
  /** The names of `type_ids`, in the same order. */
  type_names: string[];
  /** A person's access role ids, the same list as their `type_ids`. Empty for the other kinds. */
  role_ids: string[];
  tag_ids: string[];
  department_ids: string[];
  branch_ids: string[];
  traits: AssigneeTraits;
  link_status: string;
  /** A person's published custom field values. Empty for the other kinds. */
  fields: Record<string, unknown>;
  /** Set when a person's fields could not be read. Their `fields` are then empty, which is not the same as having none. */
  fields_error: string;
  member_ids: string[];
  member_count: number;
  members: DirectoryMember[];
  /** For each field any member has, the members' values as a list. */
  member_fields: Record<string, unknown>;
  member_tag_ids: string[];
  member_type_ids: string[];
  /** The groups a person is an active member of. */
  group_ids: string[];
  revision: string;
};

const text = (value: unknown) => String(value ?? "").trim();
const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort();

/**
 * A person's custom field values as anyone may read them: every field that is not private and names no read
 * permission, with defaults and formulas resolved by the field service. The rule is the same for every reader, so a
 * requirement never comes out differently depending on who asked. A field an organization does not want schedulers to
 * see is marked private.
 */
export async function userFieldValues(orgId: string, userIds: string[]): Promise<Map<string, { values: Record<string, unknown>; error: string }>> {
  const { readFields } = await import("../custom_fields/records.js");
  const ctx = systemPublicationContext({ kind: "work", organizationId: orgId, operations: ["custom-fields-user.values"] });
  const found = new Map<string, { values: Record<string, unknown>; error: string }>();
  for (const userId of unique(userIds)) {
    try { found.set(userId, { values: (await readFields(ctx, { scope: "organization", organizationId: orgId, id: userId }, "user")).values, error: "" }); }
    catch (error) { found.set(userId, { values: {}, error: `Fields could not be read${error instanceof Error && error.message ? `: ${error.message}` : "."}` }); }
  }
  return found;
}

/** Each scalar field becomes the list of the members' values for it; nested objects keep their shape. */
function mergeMemberFields(members: Array<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const scalar = (value: unknown) => ["string", "number", "boolean"].includes(typeof value);
  const add = (target: Record<string, unknown>, fields: Record<string, unknown>, depth: number) => {
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined || value === null) continue;
      if (scalar(value)) { if (!Array.isArray(target[key])) target[key] = []; (target[key] as unknown[]).push(value); }
      else if (Array.isArray(value)) { if (!Array.isArray(target[key])) target[key] = []; (target[key] as unknown[]).push(...value.filter(scalar)); }
      else if (depth < 6) { if (!target[key] || Array.isArray(target[key])) target[key] = {}; add(target[key] as Record<string, unknown>, value as Record<string, unknown>, depth + 1); }
    }
  };
  for (const fields of members) add(out, fields, 0);
  return out;
}

export type AssigneeDirectory = { rows: DirectoryRow[]; records: Map<string, AssigneeRecord>; revision: string };
/**
 * Every assignee that is not archived. `fields` chooses whose custom fields are read: everyone (the published
 * collection), or only the people named (the roster, which needs a handful).
 */
export async function loadAssigneeDirectory(orgId: string, options: { fieldsFor?: "all" | ((records: Map<string, AssigneeRecord>) => string[]) } = {}): Promise<AssigneeDirectory> {
  const [records, { types }, roles] = await Promise.all([listAssigneeRecords(orgId), listAssigneeTypes(orgId), (await import("../workforce/storage.js")).readAccessRoleNames(orgId)]);
  // A type id is named in the list its kind draws from: roles for a person, group types, company types. An id with no name there is its own name.
  const names = { organization_user: new Map(roles.map((role) => [role.id, role.name])), resource_group: new Map(types.filter((type) => type.kind === "resource_group").map((type) => [type.id, type.name])), organization_connection: new Map(types.filter((type) => type.kind === "organization_connection").map((type) => [type.id, type.name])) };
  const users = records.filter((record) => record.kind === "organization_user");
  const groups = records.filter((record) => record.kind === "resource_group");
  const wanted = options.fieldsFor === undefined || options.fieldsFor === "all" ? users.map((user) => user.ref.id) : options.fieldsFor(new Map(records.map((record) => [record.key, record])));
  const fields = await userFieldValues(orgId, wanted.filter((userId) => users.some((user) => user.ref.id === userId)));
  const userByKey = new Map(users.map((user) => [user.ref.id, user]));
  const groupsOf = new Map<string, string[]>();
  for (const group of groups) for (const member of group.members) groupsOf.set(member.user_id, [...(groupsOf.get(member.user_id) || []), group.key]);

  const rows = records.map((record): DirectoryRow => {
    const members = record.members.map((member): DirectoryMember => {
      const user = userByKey.get(member.user_id);
      return {
        id: assigneeKey({ type: "organization_user", id: member.user_id }), user_id: member.user_id, name: user?.name || member.user_id, role: member.role, is_lead: member.is_lead,
        // A member whose user record is gone is still listed, so the count is never quietly short.
        status: user?.status || "missing", type_ids: unique(user?.type_ids || []), tag_ids: user?.tag_ids || [], fields: fields.get(member.user_id)?.values || {}
      };
    });
    const own = record.kind === "organization_user" ? fields.get(record.ref.id) : undefined;
    const row: Omit<DirectoryRow, "revision"> = {
      id: record.key, kind: record.kind, assignee_id: record.ref.id, name: record.name, status: record.status,
      type_ids: unique(record.type_ids), type_names: unique(record.type_ids).map((id) => names[record.kind].get(id) || id), role_ids: unique(record.role_ids), tag_ids: unique(record.tag_ids),
      department_ids: record.department_ids, branch_ids: unique(record.branch_ids), traits: record.traits,
      link_status: record.link?.status || "", fields: own?.values || {}, fields_error: own?.error || "",
      member_ids: members.map((member) => member.id), member_count: members.length, members,
      member_fields: mergeMemberFields(members.map((member) => member.fields)),
      member_tag_ids: unique(members.flatMap((member) => member.tag_ids)), member_type_ids: unique(members.flatMap((member) => member.type_ids)),
      group_ids: record.kind === "organization_user" ? unique(groupsOf.get(record.ref.id) || []) : []
    };
    return { ...row, revision: `sha256:${contentHash(row)}` };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return { rows, records: new Map(records.map((record) => [record.key, record])), revision: `sha256:${contentHash(rows.map((row) => [row.id, row.revision]))}` };
}
