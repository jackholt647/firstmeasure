import { z } from "zod";
import type { JsonObject } from "../platform/storage.js";

/**
 * The assignee base: what every assignee has, whichever store it lives in. See docs/architecture/assignee-base.md.
 *
 * An assignee is anyone work can be assigned to. There are three kinds, each kept in its own store: a person
 * (`organization_user`, a document in the platform store), a group of users (`resource_group`, a row in the workforce
 * database) and an outside company (`organization_connection`, a row in the connections store). Equipment is never
 * one. Stored references say `{ type, id }`; `type` there is the kind.
 *
 * An assignee's **types** (`type_ids`) are a different thing and depend on the kind. A person's types are their access
 * roles: there is no separate user type. A group has exactly one type, its `kind_id`, from the organization's group
 * types. An outside company has zero or more, from the organization's company types, because one company can do
 * several jobs.
 */
export const ASSIGNEE_KINDS = ["organization_user", "resource_group", "organization_connection"] as const;
export type AssigneeKind = typeof ASSIGNEE_KINDS[number];

const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
/** The stored reference to an assignee. `type` is one of the three kinds. */
export const assigneeRefSchema = z.object({ type: z.enum(ASSIGNEE_KINDS), id }).strict();
export type AssigneeRef = z.infer<typeof assigneeRefSchema>;

/** The names older records use for a kind (`work_resource_ref.kind`, schedule `resource_refs`), mapped to the kind. */
export const ASSIGNEE_KIND_BY_NAME: Record<string, AssigneeKind> = {
  resource_group: "resource_group", organization_connection: "organization_connection", organization_user: "organization_user", user: "organization_user"
};

/** `organization_user:u_1`. The one string form of a reference: published row ids, roster ids and condition values use it. */
export const assigneeKey = (ref: { type: string; id: string }) => `${ref.type}:${ref.id}`;
export function parseAssigneeKey(value: unknown): AssigneeRef | null {
  const raw = String(value ?? "").trim();
  const at = raw.indexOf(":");
  if (at < 1) return null;
  const parsed = assigneeRefSchema.safeParse({ type: raw.slice(0, at), id: raw.slice(at + 1) });
  return parsed.success ? parsed.data : null;
}

/**
 * How the kinds differ in structure. These are traits, not subclasses: code asks "does it have members" and never "is
 * it a group". They are not labor's capabilities (labor/capabilities.ts), which say what kinds of work an assignee can
 * do.
 */
export type AssigneeTraits = {
  /** It is made of people. Only a group of users; its members are always users. */
  has_members: boolean;
  /** Someone can sign in as it: a person, or an outside company that is linked to its own organization. */
  has_login: boolean;
  /** It can be linked to, and onboarded as, another organization. Only an outside company. */
  external_link: boolean;
  /** What it is paid can be split among the people in it. Only a group of users. */
  splits_pay: boolean;
};

export type AssigneeMember = { user_id: string; role: string; is_lead: boolean };

/** `active`: work can be assigned to it. `inactive`: it exists but should not be given work. `archived`: it is gone. */
export type AssigneeStatus = "active" | "inactive" | "archived";

/**
 * What every assignee has. An adapter for each kind fills this from its own store; nothing outside the adapters reads
 * a user document, a group row or a connection row to learn these things.
 */
export type AssigneeRecord = {
  ref: AssigneeRef;
  key: string;
  kind: AssigneeKind;
  name: string;
  status: AssigneeStatus;
  /**
   * Its types. A person: the access role ids they resolve to today (saved, or inferred when none are saved). A group: exactly one id, its `kind_id`. An outside company: zero or
   * more of the organization's company types.
   */
  type_ids: string[];
  /** A person's access role ids, the same list as their `type_ids`. Empty for the other kinds. */
  role_ids: string[];
  tag_ids: string[];
  /**
   * The departments it is assigned to, for all three kinds. They live in the one department catalog
   * (workforce/departments.ts): assigned directly, or through a role or the type of a group, and a person also
   * belongs to the departments of the groups they are in. A branch is a different thing and is not a substitute.
   */
  department_ids: string[];
  /** Branches it works in. Empty means every branch (an outside company with no branch chosen). */
  branch_ids: string[];
  traits: AssigneeTraits;
  /** Active members. Empty unless `traits.has_members`. */
  members: AssigneeMember[];
  /** The other organization an outside company is linked to. Null for the other kinds. */
  link: { status: string; organization_id: string } | null;
  /** The revision of the record in its own store. */
  store_revision: number;
  /** The store's own record, for the adapters' callers that still need a field the base does not name. Never published. */
  record: JsonObject;
};

/** What an adapter reads from its own store: everything but departments, which one catalog holds for all three kinds. */
export type AssigneeStoreRecord = Omit<AssigneeRecord, "department_ids">;

/**
 * One adapter per kind. `read` returns the record whatever its status, or null when the store has none; `list` leaves
 * archived records out. Both only read. `setTags` writes to wherever that kind keeps its tags.
 */
export interface AssigneeAdapter {
  readonly kind: AssigneeKind;
  read(orgId: string, id: string): Promise<AssigneeStoreRecord | null>;
  list(orgId: string): Promise<AssigneeStoreRecord[]>;
  setTags(orgId: string, record: AssigneeStoreRecord, tagIds: string[]): Promise<void>;
}
