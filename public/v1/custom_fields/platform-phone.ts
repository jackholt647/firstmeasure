import { authorizePublication } from "../platform/publication/context.js";
import { FIELD_OWNERS } from "./owners.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { badRequest, forbidden } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import type { PublicationContext, TargetRef } from "../platform/publication/contracts.js";
import { object, validateField, type FieldEntity } from "./contracts.js";

// Server-only capability. No API body, module or system grant can set it.
export const phoneProducer = new AsyncLocalStorage<boolean>();
export async function resolvePlatformPhone(orgId:string,value:unknown) {
  const ref=object(value);
  const owner=await (await import("../messaging/communications_storage.js")).findPhoneNumberOwner(String(ref.phone_number || ""));
  const available=!!owner && owner.organization_id === orgId && owner.status === "active" && !!owner.provider_phone_number_id && owner.provider_phone_number_id === ref.issuance_id;
  return {phone_number:String(ref.phone_number || ""),issuance_id:String(ref.issuance_id || ""),available};
}
export async function assertPlatformPhoneMutation(orgId:string,field:JsonObject,value:unknown,previous:unknown) {
  if(JSON.stringify(value) === JSON.stringify(previous)) return;
  if(!phoneProducer.getStore()) throw forbidden("platform_phone_managed","Only the phone system can assign or remove platform phone numbers.");
  validateField(field,value);
  for(const ref of (Array.isArray(value)?value:[value])) if(ref && !(await resolvePlatformPhone(orgId,ref)).available) throw badRequest("platform_phone_not_issued","Choose a currently issued platform phone number belonging to this organization.");
}

/** Phone-domain integration seam: issuance is performed by the phone system
 * before assigning references. Unassignment uses null/[] and never releases a
 * provider number. Call this from an authorized phone-domain command, not from
 * the standard custom-field API. Cardinality many supports multiple lines.
 */
export async function setPlatformPhoneField(ctx:PublicationContext,target:TargetRef,entity:FieldEntity,path:string,value:unknown,expectedRevision:number) {
  if (!ctx.auth || ctx.mode !== "command") throw forbidden("platform_phone_assignment_denied","An authorized phone-domain command is required.");
  await authorizePublication(ctx,target,{scopes:entity === "project" ? ["project"] : entity === "contact" ? ["project","organization"] : ["organization"],permissions:["manage_communications|manage_company_settings",FIELD_OWNERS[entity].writePermission]},"platform-phone.assign");
  const records=await import("./records.js");
  const state=await records.readFieldRecord(ctx,target,entity);
  const field=state.fields.find(f=>f.path === path);
  if(field?.type !== "platform_phone") throw badRequest("platform_phone_field","Choose a declared platform phone field.");
  return phoneProducer.run(true,()=>records.writeFields(ctx,target,entity,{values:{[path]:value},expectedRevision}));
}
