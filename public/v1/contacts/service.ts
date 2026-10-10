import { readBranchModule, saveBranchModule, readDocument, listDocuments, readMediaMetadata, type JsonObject } from "../platform/storage.js";
import { badRequest, notFound, PlatformError } from "../platform/errors.js";
import { asObject, text, contactKind, normalizeContactSettings, CONTACT_REFERENCE_TYPES, MEDIA_REFERENCE_TYPES } from "./contracts.js";
export async function contactSettings(orgId:string) {
 try {return normalizeContactSettings((await readBranchModule(orgId,"default","contact_settings")).data);}
 catch(e){if(e instanceof PlatformError && e.statusCode===404 || (e as any)?.code==="ENOENT")return normalizeContactSettings({});throw e;}
}
export async function saveContactSettings(orgId:string,input:unknown) {
 const settings=normalizeContactSettings(input);
 await saveBranchModule(orgId,"default","contact_settings",{data:settings},{replace:true});return settings;
}
export async function resolveContact(orgId:string,value:unknown) {
 const ref=asObject(value),projectId=text(ref.project_id || ref.record_project_id),id=text(ref.contact_id);
 if(!projectId || !id)throw badRequest("contact_reference_invalid","Choose a saved contact.");
 const parent=await readDocument(orgId,"projects",projectId);
 const contact=(Array.isArray(parent.data.contacts)?parent.data.contacts:[]).map(asObject).find(c=>text(c.id || c.contact_id)===id);
 if(!contact)throw notFound("contact_not_found","The referenced contact is not available in this organization.");
 return {contact,parent,ref:{project_id:projectId,contact_id:id}};
}
export async function contactOptions(orgId:string,kind="either") {
 if(!["human","org","either"].includes(kind))throw badRequest("contact_kind_invalid","Choose human, org or either.");
 const documents=await listDocuments(orgId,"projects"),items=new Map<string,JsonObject>();
 // Standalone contact records take precedence over linked project copies.
 documents.sort((a,b)=>Number(b.data.workflow_state==="contact_only")-Number(a.data.workflow_state==="contact_only"));
 for(const row of documents)for(const raw of Array.isArray(row.data.contacts)?row.data.contacts:[]){
  const c=asObject(raw),id=text(c.id || c.contact_id),type=contactKind(c);
  if(!id || items.has(id) || kind!=="either" && type!==kind)continue;
  items.set(id,{contact_id:id,project_id:row.id,name:text(c.name || c.email || c.phone || id),contact_kind:type});
 }
 return [...items.values()].sort((a,b)=>text(a.name).localeCompare(text(b.name)));
}
export async function normalizeContactRecord(orgId:string,incoming:JsonObject,previous:JsonObject={}) {
 const next={...incoming},kind=contactKind({...previous,...incoming});
 const zone=text(next.time_zone ?? previous.time_zone);
 if(zone){
  try{new Intl.DateTimeFormat("en-US",{timeZone:zone});}
  catch{throw badRequest("contact_time_zone_invalid","Choose a valid time zone.");}
 }
 next.time_zone=zone;
 const raw=Array.isArray(next.tags)?next.tags:Array.isArray(previous.tags)?previous.tags:[];
 const tags=[...new Set(raw.map(text).filter(Boolean))].filter(tag=>tag!=="org");
 if(tags.length>64 || tags.some(tag=>tag.length>80))throw badRequest("contact_tags_invalid","Use at most 64 tags, each up to 80 characters.");
 const prior=new Set((Array.isArray(previous.tags)?previous.tags:[]).map(text));
 const added=tags.filter(tag=>!prior.has(tag));
 if(added.length){
  const settings=await contactSettings(orgId),allowed=new Set((settings.tags as JsonObject[]).filter(t=>t.enabled!==false).map(t=>text(t.id)));
  if(added.some(tag=>!allowed.has(tag)))throw badRequest("contact_tag_unavailable","Choose tags from the contact settings catalog. Only admins manage available tags.");
 }
 next.profile_media_id=text(asObject(asObject(next.custom_field_values || previous.custom_field_values).profile_photo).media_id);
 next.contact_kind=kind;next.tags=kind==="org"?["org",...tags]:tags;
 return next;
}
export async function validateReference(orgId:string,field:JsonObject,value:unknown,record:JsonObject,entity:string) {
 if(value===undefined || value===null || value==="")return;
 const type=text(field.type);
 if(!CONTACT_REFERENCE_TYPES.includes(type) && !MEDIA_REFERENCE_TYPES.includes(type))return;
 const values=field.cardinality==="many"?value as unknown[]:[value];
 for(const entry of values){
  if(CONTACT_REFERENCE_TYPES.includes(type)){
   const target=await resolveContact(orgId,entry),kind=contactKind(target.contact);
   if(type==="human_contact" && kind!=="human" || type==="org_contact" && kind!=="org")throw badRequest("contact_reference_kind",`${text(field.label || field.path)} requires ${type==="org_contact"?"an org":"a human"} contact.`);
  }else{
   const id=text(asObject(entry).media_id);if(!id)throw badRequest("media_reference_invalid","Choose media from the associated library.");
   const media=await readMediaMetadata(orgId,id),owner=asObject(media.owner);
   const expectedType=entity==="contact"?"contact":entity==="project"?"project":"organization";
   const expectedId=text(record.id || record.contact_id || (entity==="organization"?orgId:""));
   if(text(owner.type)!==expectedType || text(owner.id)!==expectedId)throw badRequest("media_reference_owner","Media must belong to this record's library.");
   const content=text(media.content_type);
   if(type==="photo" && !content.startsWith("image/") || type==="video" && !content.startsWith("video/"))throw badRequest("media_reference_type",`${text(field.label || field.path)} requires ${type}.`);
  }
 }
}
