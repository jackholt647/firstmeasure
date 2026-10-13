import { z } from "zod";
import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, forbidden } from "../platform/errors.js";
import { readDocument, type JsonObject } from "../platform/storage.js";

/**
 * An assignee is anyone work can be assigned to: a person, a group of users, or an outside company. Equipment is not
 * one. See docs/architecture/assignees.md. Stored references elsewhere call the same thing a work resource or a subject.
 */
export const ASSIGNEE_TYPES = ["organization_user", "resource_group", "organization_connection"] as const;
const id = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/);
export const assigneeSchema = z.object({ type: z.enum(ASSIGNEE_TYPES), id }).strict();
export type Assignee = z.infer<typeof assigneeSchema>;
/** The kinds a list's `work_resource_ref` uses, mapped to assignee types. */
export const ASSIGNEE_TYPE_BY_KIND: Record<string, Assignee["type"]> = { resource_group: "resource_group", organization_connection: "organization_connection", organization_user: "organization_user", user: "organization_user" };

const text = (value: unknown) => String(value ?? "").trim();
/** The live record behind an assignee, or null when there is none or it has been archived. Reads only. */
export async function readAssignee(orgId: string, assignee: Assignee): Promise<{ name: string; record: JsonObject } | null> {
  try {
    if (assignee.type === "organization_user") {
      const user = await readDocument(orgId, "users", assignee.id);
      return text(user.data.status) === "archived" || user.data.archived_at ? null : { name: text(user.data.name) || text(user.data.email), record: user.data };
    }
    if (assignee.type === "resource_group") {
      const group = await (await import("../workforce/storage.js")).readResourceGroup(orgId, assignee.id);
      return !group || group.archived_at || text(group.status) === "archived" ? null : { name: text(group.name), record: group };
    }
    const connection = await (await import("../connections/storage.js")).readOrganizationConnection(orgId, assignee.id);
    return !connection || connection.archived_at || text(connection.status) === "archived" ? null : { name: text(connection.name), record: connection };
  } catch { return null; }
}
/** Refuses a pay sheet, delivery setting, unit or commitment for an assignee that does not exist, so none is left orphaned from the start. */
export async function requireAssignee(orgId: string, assignee: Assignee) {
  const found = await readAssignee(orgId, assignee);
  if (!found) throw badRequest("assignee_unknown", "That person, group or company is not available in this organization.");
  return found;
}

/** Who is acting. Published actions run by the platform itself carry no user; the publication layer has already authorized them. */
export type Actor = Pick<PlatformAuthContext, "orgId" | "userId"> & Partial<PlatformAuthContext> & { system?: boolean };
/** A person needs the permission in this organization; the platform acting for an already-authorized action does not. */
export function requireActor(orgId: string, actor: Actor, permission: string, code: string, message: string) {
  if (!actor || actor.orgId !== orgId || (!actor.system && !hasPermission(actor as PlatformAuthContext, permission))) throw forbidden(code, message);
}
