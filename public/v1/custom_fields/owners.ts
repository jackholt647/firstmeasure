import { createHash } from "node:crypto";
import { badRequest, forbidden, notFound } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import type { TargetRef } from "../platform/publication/contracts.js";

// One owner catalog drives definition placement, publication and storage.
// `division` owns fields on a region (the older organizational unit, whose id a migrated region keeps); see docs/architecture/branches.md.
export const FIELD_OWNERS = {
  project: {shared:false,sidecar:false,readPermission:"view_projects",writePermission:"manage_projects"},
  contact: {shared:false,sidecar:false,readPermission:"view_contacts",writePermission:"manage_projects"},
  organization: {shared:true,sidecar:false,readPermission:"view_projects",writePermission:"manage_company_settings"},
  user: {shared:true,sidecar:false,readPermission:"manage_company_users",writePermission:"manage_company_users"},
  branch: {shared:true,sidecar:true,readPermission:"manage_company_settings",writePermission:"manage_company_settings"},
  department: {shared:true,sidecar:true,readPermission:"manage_company_settings",writePermission:"manage_company_settings"},
  division: {shared:true,sidecar:true,readPermission:"manage_company_settings",writePermission:"manage_company_settings"},
  team: {shared:true,sidecar:true,readPermission:"manage_company_settings",writePermission:"manage_company_settings"},
  // An outside company: an organization_connections row.
  company: {shared:true,sidecar:true,readPermission:"manage_company_settings",writePermission:"manage_company_settings"}
} as const;
export type FieldEntity = keyof typeof FIELD_OWNERS;

// Where a definition of a people owner is made: its home. A home is one role, one group type, one company type or
// one department, never an individual user, group or company. See docs/architecture/custom-fields.md.
export const FIELD_HOMES = {
  role: {entity:"user"},
  group_type: {entity:"team"},
  company_type: {entity:"company"},
  department: {entity:"department"}
} as const;
export type FieldHomeKind = keyof typeof FIELD_HOMES;
export type FieldHome = {kind:FieldHomeKind,id:string};
export const homeKindOf = (entity:string):FieldHomeKind | undefined => (Object.keys(FIELD_HOMES) as FieldHomeKind[]).find(kind=>FIELD_HOMES[kind].entity === entity);
/** The home a definition names, or null when it names none. A home of the wrong owner or with a bad id is refused. */
export function fieldHome(value:unknown,entity?:string):FieldHome | null {
  if(value === undefined || value === null || value === "") return null;
  const home = value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
  const kind = String(home.kind || ""), id = String(home.id ?? "").trim();
  if(!Object.hasOwn(FIELD_HOMES,kind)) throw badRequest("custom_field_home_invalid","A field belongs to a role, a group type, a company type or a department.");
  if(entity !== undefined && FIELD_HOMES[kind as FieldHomeKind].entity !== entity) throw badRequest("custom_field_home_invalid",`A ${kind.replace("_"," ")} holds ${FIELD_HOMES[kind as FieldHomeKind].entity} fields.`);
  if(!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,179}$/.test(id)) throw badRequest("custom_field_home_invalid","Name the role, type or department this field belongs to.");
  return {kind:kind as FieldHomeKind,id};
}
export function resourceFieldId(entity:FieldEntity,id:string) {
  if(!FIELD_OWNERS[entity].sidecar || !id || id.length>180) throw badRequest("custom_field_owner_invalid","Choose an existing resource owner.");
  return `${entity}_${createHash("sha256").update(id).digest("hex")}`;
}
export function ownerForCollection(collection:string,data:JsonObject):FieldEntity {
  const entity = collection === "projects" ? "project" : collection === "customers" ? "contact" : collection === "users" ? "user" : collection === "resource_custom_fields" ? String(data.entity) : "organization";
  if(!Object.hasOwn(FIELD_OWNERS,entity)) throw badRequest("custom_field_entity","Unknown field owner.");
  return entity as FieldEntity;
}
export async function readResourceOwner(orgId:string,entity:FieldEntity,target:TargetRef) {
  if(target.scope !== "organization" || target.organizationId && target.organizationId !== orgId) throw forbidden("custom_field_owner_target","The resource must belong to this organization.");
  const {readDocument}=await import("../platform/storage.js");
  const id=String(target.id || "");resourceFieldId(entity,id);
  let branchId="";
  if(entity === "branch") {
    const row=await readDocument(orgId,"branch",id);branchId=row.id;
  } else if(entity === "department" || entity === "division") {
    const catalog=await (await import("../workforce/departments.js")).readOrganizationDepartments(orgId);
    // `division` is the owner name fields on organizational units were saved under; units are now regions, which keep their ids.
    const owner=(entity === "department" ? catalog.departments : catalog.regions).find(row=>row.id === id);
    if(!owner) throw notFound("custom_field_owner_not_found","The organizational resource was not found.");
    branchId=String((owner as JsonObject).branch_id || "");
  } else if(entity === "team") {
    // The standard group reader seeds defaults. Publication reads use only the
    // existing domain row so that an absent owner never creates resources.
    const db=(await import("../workforce/storage.js")).getWorkforceDatabase();
    const row=await db.prepare("SELECT branch_id FROM resource_groups WHERE organization_id=? AND id=?").get(orgId,id);
    if(!row) throw notFound("custom_field_owner_not_found","The team/resource group was not found.");
    branchId=String(row.branch_id || "");
  } else if(entity === "company") {
    const db=(await import("../workforce/storage.js")).getWorkforceDatabase();
    const row=await db.prepare("SELECT id FROM organization_connections WHERE organization_id=? AND id=?").get(orgId,id);
    if(!row) throw notFound("custom_field_owner_not_found","The outside company was not found.");
  } else throw badRequest("custom_field_entity","This resource uses its domain record for fields.");
  if(target.branchId && branchId && target.branchId !== branchId) throw forbidden("custom_field_branch","The field target does not match the resource branch.");
  return {id,branchId};
}
