import { PlatformError } from "../platform/errors.js";
import { listDocuments, readDocument, type JsonObject } from "../platform/storage.js";
import { assigneeKey, type AssigneeAdapter, type AssigneeKind, type AssigneeStoreRecord, type AssigneeRef, type AssigneeStatus } from "./contract.js";

/**
 * The three adapters behind the assignee contract. Each reads its own store with that store's own reader and says
 * where the shared fields live for its kind:
 *
 * | Field | Person | Group of users | Outside company |
 * |---|---|---|---|
 * | name, status | user document | `resource_groups` row | `organization_connections` row |
 * | types | the roles the person resolves to today: a person's types are their roles | the row's `kind_id`, exactly one | base record `type_ids`, zero or more |
 * | tags | user document `assignment_tag_ids` | row `assignment_tags_json` | row `metadata.assignment_tag_ids` |
 * | members | none | `resource_group_memberships` | none |
 * | branches | user document `branch_id` plus `branch_ids` | row `branch_id` plus `metadata.branch_ids` | `organization_connection_branches` (none means every branch) |
 *
 * | departments | the department catalog, for all three kinds (filled in by `base.ts`) | | |
 */
const text = (value: unknown) => String(value ?? "").trim();
const obj = (value: unknown): JsonObject => (value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {});
const ids = (value: unknown) => [...new Set((Array.isArray(value) ? value : []).map(text).filter(Boolean))];
/** A record the store does not have, or an id the store could never hold, is an absence. Any other failure is a failure and is not hidden. */
async function absent<T>(read: () => Promise<T>): Promise<T | null> {
  try { return await read(); }
  catch (error) { if ((error instanceof PlatformError && (error.statusCode === 404 || error.statusCode === 400)) || (error as { code?: string })?.code === "ENOENT") return null; throw error; }
}
const status = (record: JsonObject): AssigneeStatus => {
  const value = text(record.status || "active").toLowerCase();
  if (record.archived_at || value === "archived" || value === "deleted") return "archived";
  return value === "active" ? "active" : "inactive";
};

/** Reads the types the base record holds for outside companies, the one kind that keeps its types there. Injected to avoid a cycle with `base.ts`. */
type CompanyTypes = (orgId: string, onlyId?: string) => Promise<Map<string, string[]>>;

type UserDocument = { id: string; revision?: number; data: JsonObject };
/**
 * The roles a person has today, by the same resolution the permission system uses. A saved `access_role_ids` list is
 * authoritative and is read as it is. Someone with none saved still has a role, inferred from their older permission
 * level; they must not come out with no types, because pay defaults and field definitions hang off roles. Nothing is
 * saved to the user by reading this.
 */
async function userRoleIds(orgId: string, document: UserDocument): Promise<string[]> {
  if (Object.prototype.hasOwnProperty.call(document.data, "access_role_ids")) return ids(document.data.access_role_ids);
  return ids((await (await import("../workforce/access.js")).resolveAccessProfile(orgId, document)).access_role_ids);
}
function userRecord(document: UserDocument, roleIds: string[]): AssigneeStoreRecord {
  const ref: AssigneeRef = { type: "organization_user", id: document.id };
  // A person's types are their access roles. There is no separate user type.
  return {
    ref, key: assigneeKey(ref), kind: "organization_user", name: text(document.data.name) || text(document.data.email), status: status(document.data),
    type_ids: roleIds, role_ids: roleIds, tag_ids: ids(document.data.assignment_tag_ids || document.data.tag_ids), branch_ids: ids([text(document.data.branch_id) || "default", ...(Array.isArray(document.data.branch_ids) ? document.data.branch_ids : [])]),
    traits: { has_members: false, has_login: true, external_link: false, splits_pay: false },
    members: [], link: null, store_revision: Number(document.revision || 0), record: document.data
  };
}
function groupRecord(group: JsonObject): AssigneeStoreRecord {
  const ref: AssigneeRef = { type: "resource_group", id: text(group.id) };
  return {
    ref, key: assigneeKey(ref), kind: "resource_group", name: text(group.name), status: status(group),
    // A group has exactly one type: its kind.
    type_ids: ids([group.kind_id]), role_ids: [], tag_ids: ids(group.assignment_tag_ids), branch_ids: ids(Array.isArray(group.branch_ids) && group.branch_ids.length ? group.branch_ids : [text(group.branch_id) || "default"]),
    traits: { has_members: true, has_login: false, external_link: false, splits_pay: true },
    members: (Array.isArray(group.members) ? group.members : []).map(obj).map((member) => ({ user_id: text(member.user_id), role: text(member.role) || "member", is_lead: member.is_lead === true })),
    link: null, store_revision: Number(group.revision || 0), record: group
  };
}
function connectionRecord(connection: JsonObject, typeIds: string[]): AssigneeStoreRecord {
  const ref: AssigneeRef = { type: "organization_connection", id: text(connection.id) };
  const linked = text(connection.link_status) === "linked" && !!text(connection.linked_organization_id);
  return {
    ref, key: assigneeKey(ref), kind: "organization_connection", name: text(connection.name), status: status(connection),
    type_ids: ids(typeIds), role_ids: [], tag_ids: ids(obj(connection.metadata).assignment_tag_ids), branch_ids: ids(connection.branch_ids),
    // An outside company signs in through its own organization, so it has a login only once it is linked to one.
    traits: { has_members: false, has_login: linked, external_link: true, splits_pay: false },
    members: [], link: { status: text(connection.link_status) || "unlinked", organization_id: text(connection.linked_organization_id) },
    store_revision: Number(connection.revision || 0), record: connection
  };
}

export function assigneeAdapters(companyTypes: CompanyTypes): Record<AssigneeKind, AssigneeAdapter> {
  return {
    organization_user: {
      kind: "organization_user",
      async read(orgId, id) {
        const document = await absent(() => readDocument(orgId, "users", id));
        return document ? userRecord(document, await userRoleIds(orgId, document)) : null;
      },
      async list(orgId) {
        const documents = (await listDocuments(orgId, "users")).filter((document) => status(document.data) !== "archived");
        return Promise.all(documents.map(async (document) => userRecord(document, await userRoleIds(orgId, document))));
      },
      async setTags(orgId, record, tagIds) {
        await (await import("../workforce/service.js")).patchWorkforceUserProfile(orgId, record.ref.id, { assignment_tag_ids: tagIds });
      }
    },
    resource_group: {
      kind: "resource_group",
      async read(orgId, id) {
        const [group] = await (await import("../workforce/storage.js")).listResourceGroupRows(orgId, { id, include_archived: true });
        return group ? groupRecord(group) : null;
      },
      async list(orgId) {
        return (await (await import("../workforce/storage.js")).listResourceGroupRows(orgId)).map(groupRecord);
      },
      async setTags(orgId, record, tagIds) {
        await (await import("../workforce/storage.js")).patchResourceGroup(orgId, record.ref.id, { assignment_tag_ids: tagIds, expected_revision: record.store_revision });
      }
    },
    organization_connection: {
      kind: "organization_connection",
      async read(orgId, id) {
        const connection = await absent(async () => (await import("../connections/storage.js")).readOrganizationConnection(orgId, id));
        return connection ? connectionRecord(connection, (await companyTypes(orgId, text(connection.id))).get(text(connection.id)) || []) : null;
      },
      async list(orgId) {
        // The connections store also holds suppliers. Its own reader leaves out a connection that is only a supplier.
        const [connections, types] = await Promise.all([(await import("../connections/storage.js")).listOrganizationConnections(orgId), companyTypes(orgId)]);
        return connections.map((connection) => connectionRecord(connection, types.get(text(connection.id)) || []));
      },
      async setTags(orgId, record, tagIds) {
        await (await import("../connections/storage.js")).patchOrganizationConnection(orgId, record.ref.id, { metadata: { assignment_tag_ids: tagIds }, expected_revision: record.store_revision });
      }
    }
  };
}
