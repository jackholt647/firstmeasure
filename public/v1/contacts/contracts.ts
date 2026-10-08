import { badRequest } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
export const CONTACT_REFERENCE_TYPES = ["contact", "human_contact", "org_contact"];
export const MEDIA_REFERENCE_TYPES = ["media", "photo", "video"];
export const CONTACT_DEFAULT_FIELDS: JsonObject[] = [
 {entity:"contact",path:"relationships.employer",key:"relationships.employer",type:"org_contact",label:"Employer",required:false,enabled:true,location:"overview",order:0,builtin:true},
 {entity:"contact",path:"relationships.spouse",key:"relationships.spouse",type:"human_contact",label:"Spouse",required:false,enabled:true,location:"overview",order:1,builtin:true},
 {entity:"contact",path:"profile_photo",key:"profile_photo",type:"photo",label:"Profile photo",required:false,enabled:true,location:"overview",order:2,builtin:true},
 {entity:"contact",path:"secondary_phone",key:"secondary_phone",type:"phone",label:"Secondary Phone",required:false,enabled:true,location:"overview",order:3,builtin:true},
 {entity:"contact",path:"primary_phone_label",key:"primary_phone_label",type:"select",label:"Primary Phone Label",options:["home","cell","work","other"],required:false,enabled:true,location:"overview",order:4,builtin:true},
 {entity:"contact",path:"secondary_phone_label",key:"secondary_phone_label",type:"select",label:"Secondary Phone Label",options:["home","cell","work","other"],required:false,enabled:true,location:"overview",order:5,builtin:true}
];
export const asObject = (v:unknown):JsonObject => v && typeof v === "object" && !Array.isArray(v) ? v as JsonObject : {};
export const text = (v:unknown) => String(v ?? "").trim();
export function contactKind(value:JsonObject):"human"|"org" {
 const kind=text(value.contact_kind);
 if (kind && !["human","org"].includes(kind)) throw badRequest("contact_kind_invalid","Choose Human or Org.");
 return kind === "org" || !kind && Array.isArray(value.tags) && value.tags.includes("org") ? "org" : "human";
}
export function normalizeContactSettings(value:unknown):JsonObject {
 const input=asObject(value),seen=new Set<string>();
 const tags=(Array.isArray(input.tags)?input.tags:[]).map(raw=>{
  const row=asObject(raw),id=text(row.id),label=text(row.label);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) || !label || label.length>80 || seen.has(id)) throw badRequest("contact_tag_invalid","Tags need unique stable IDs and labels of up to 80 characters.");
  seen.add(id);
  return {id,label,enabled:row.enabled!==false};
 }).filter(row=>row.id!=="org");
 if(tags.length>256)throw badRequest("contact_tags_limit","Use at most 256 contact tags.");
 return {version:1,tags:[{id:"org",label:"Org",enabled:true,builtin:true},...tags]};
}
