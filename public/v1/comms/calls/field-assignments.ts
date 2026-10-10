import { badRequest } from "../../platform/errors.js";
import type { PublicationContext, TargetRef } from "../../platform/publication/contracts.js";
import { FIELD_OWNERS, type FieldEntity } from "../../custom_fields/owners.js";
import { readFieldRecord } from "../../custom_fields/records.js";
import { setPlatformPhoneField } from "../../custom_fields/platform-phone.js";
import { findPhoneNumberOwner } from "../../messaging/communications_storage.js";

/** Assign existing issued lines; never purchase, release or change routing. */
export async function setPhoneFieldAssignment(ctx:PublicationContext,target:TargetRef,input:Record<string,unknown>) {
  const entity=String(input.entity) as FieldEntity;
  if(!Object.hasOwn(FIELD_OWNERS,entity)) throw badRequest("custom_field_entity","Unknown field owner.");
  const state=await readFieldRecord(ctx,target,entity);
  const field=state.fields.find(f=>f.path === input.field);
  if(field?.type !== "platform_phone") throw badRequest("platform_phone_field","Choose a declared platform phone field.");
  const numbers=input.phoneNumbers;
  if(!Array.isArray(numbers) || numbers.length>100 || numbers.some(n=>typeof n !== "string" || !/^\+[1-9]\d{7,14}$/.test(n)) || new Set(numbers).size !== numbers.length) throw badRequest("platform_phone_numbers","Choose distinct issued numbers in E.164 format.");
  if(field.cardinality !== "many" && numbers.length>1) throw badRequest("platform_phone_cardinality","This field accepts one platform phone number.");
  const references=await Promise.all(numbers.map(async phone_number=>{
    const owner=await findPhoneNumberOwner(phone_number);
    if(!owner || owner.organization_id !== ctx.organizationId || owner.status !== "active" || !owner.provider_phone_number_id) throw badRequest("platform_phone_not_issued","Choose a currently issued number owned by this organization.");
    return {phone_number,issuance_id:String(owner.provider_phone_number_id)};
  }));
  return setPlatformPhoneField(ctx,target,entity,String(input.field),field.cardinality === "many" ? references : references[0] || null,Number(input.expectedRevision));
}
