import { userPublicationContext } from "../platform/publication/context.js";
import { readFields } from "../custom_fields/records.js";
import type { FastifyInstance } from "fastify";
import { requirePlatformAuth } from "../platform/auth.js";
import { contactSettings, saveContactSettings, contactOptions, resolveContact } from "./service.js";
import { text, asObject } from "./contracts.js";
export function registerContactRoutes(app:FastifyInstance){
 app.get("/organizations/:orgId/contacts/options",async request=>{
  const orgId=text(asObject(request.params).orgId);await requirePlatformAuth(request,{orgId,permission:"view_contacts"});
  return {ok:true,contacts:await contactOptions(orgId,text(asObject(request.query).kind)||"either")};
 });
 app.get("/organizations/:orgId/contacts/settings",async request=>{
  const orgId=text(asObject(request.params).orgId);await requirePlatformAuth(request,{orgId,permission:"view_contacts"});
  return {ok:true,settings:await contactSettings(orgId)};
 });
 app.put("/organizations/:orgId/contacts/settings",async request=>{
  const orgId=text(asObject(request.params).orgId);await requirePlatformAuth(request,{orgId,csrf:true,permission:"manage_company_settings"});
  return {ok:true,settings:await saveContactSettings(orgId,request.body)};
 });
 app.get("/organizations/:orgId/contacts/:contactId",async request=>{
  const orgId=text(asObject(request.params).orgId),ctx=await requirePlatformAuth(request,{orgId,permission:"view_contacts"});
  const state=await resolveContact(orgId,{contact_id:text(asObject(request.params).contactId),project_id:text(asObject(request.query).project_id)});
  const fields=await readFields(userPublicationContext(ctx),{scope:"project",organizationId:orgId,projectId:state.ref.project_id,id:state.ref.contact_id},"contact");
  const {custom_fields,custom_field_values,contact_custom_field_values,profile_media_id,...contact}=state.contact;
  return {ok:true,contact:{...contact,custom_field_values:fields.values,profile_media_id:text(asObject(fields.values.profile_photo).media_id)},reference:state.ref,revision:state.parent.revision};
 });
}
