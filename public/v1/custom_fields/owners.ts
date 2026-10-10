import { badRequest, forbidden, notFound } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import type { TargetRef } from "../platform/publication/contracts.js";

// One owner catalog drives definition placement, publication and storage.
// Organizational units include regions and any future division kind.
export const FIELD_OWNERS = {
  project: {shared:false,sidecar:false,readPermission:"view_projects",writePermission:"manage_projects"},
  contact: {shared:false,sidecar:false,readPermission:"view_contacts",writePermission:"manage_projects"},
  organization: {shared:true,sidecar:false,readPermission:"view_projects",writePermission:"manage_company_settings"},
  user: {shared:true,sidecar:false,readPermission:"manage_company_users",writePermission:"manage_company_users"},
  branch: {shared:true,sidecar:true,readPermission:"manage_company_settings",writePermission:"manage_company_settings"},
  department: {shared:true,sidecar:true,readPermission:"manage_company_settings",writePermission:"manage_company_settings"},
  division: {shared:true,sidecar:true,readPermission:"manage_company_settings",writePermission:"manage_company_settings"},
  team: {shared:true,sidecar:true,readPermission:"manage_company_settings",writePermission:"manage_company_settings"}
} as const;
export type FieldEntity = keyof typeof FIELD_OWNERS;
export function resourceFieldId(entity:FieldEntity,id:string) {
  if(!FIELD_OWNERS[entity].sidecar || !/^[a-zA-Z0-9_-]{1,180}$/.test(id)) throw badRequest("custom_field_owner_invalid","Choose an existing resource owner.");
  return `${entity}_${id}`;
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
    const owner=(entity === "department" ? catalog.departments : catalog.divisions).find(row=>row.id === id);
    if(!owner) throw notFound("custom_field_owner_not_found","The organizational resource was not found.");
    branchId=String((owner as JsonObject).branch_id || "");
  } else if(entity === "team") {
    // The standard group reader seeds defaults. Publication reads use only the
    // existing domain row so that an absent owner never creates resources.
    const db=(await import("../workforce/storage.js")).getWorkforceDatabase();
    const row=await db.prepare("SELECT branch_id FROM resource_groups WHERE organization_id=? AND id=?").get(orgId,id);
    if(!row) throw notFound("custom_field_owner_not_found","The team/resource group was not found.");
    branchId=String(row.branch_id || "");
  } else throw badRequest("custom_field_entity","This resource uses its domain record for fields.");
  if(target.branchId && branchId && target.branchId !== branchId) throw forbidden("custom_field_branch","The field target does not match the resource branch.");
  return {id,branchId};
}
