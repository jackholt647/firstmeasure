import { z } from "zod";
import { createHash } from "node:crypto";
import sharp from "sharp";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, forbidden, notFound, conflict } from "../platform/errors.js";
import { readDocument, readMediaMetadata, readMediaFile, listMedia, storeMediaUpload, listDocuments } from "../platform/storage.js";
import { updateProjectData } from "../platform/project_document_mutation.js";
import { resolveContact } from "../contacts/service.js";
import { readDocumentInstance } from "../documents/storage.js";
import { readInvoice } from "../payments/invoices.js";
import { readChannelRecord, listMessageRecords, createMessageRecord, findChannelByProject, createChannelRecord, listChannelRecords } from "../channels/storage.js";
import { requireChannelAccess, channelAdminAllowed } from "../channels/service.js";
import { isReceiptMedia, canReadReceiptMedia } from "../platform/media_access.js";
import { type ResourceRef } from "./schemas.js";
import { authorizeShared, withSharedAccess, requirePermission, actor, participantView, organizationProfile, verifiedMessageContributor } from "./service.js";
import { audit, newId, now, getRecord, listRecords, listGrants, findRecord, insertRecord } from "./storage.js";

const fields:Record<ResourceRef["type"],readonly string[]>={
  project:["title","address","city","state","zip","description","status","created_at","updated_at"],
  contact:["name","email","phone","address","company","contact_kind"],
  channel:["name","description","type"],document:["title","document_type","status","created_at","updated_at"],
  media:["file_name","content_type","kind","created_at"],invoice:["invoice_number","status","currency","total_cents","balance_due_cents","amount_paid_cents","due_date","issued_at"]
};
const permissions:Record<ResourceRef["type"],string>={project:"view_projects",contact:"view_contacts",channel:"view_channels",document:"view_documents",media:"view_media",invoice:"view_financials"};
const operationPermissions:Record<string,string>={"details.update":"manage_projects","photos.read":"view_media","photos.upload":"manage_media","notes.read":"view_projects","notes.create":"manage_projects","messages.read":"view_channels","messages.post":"send_channel_messages","documents.read":"view_documents","documents.respond":"manage_documents","invoice.read":"view_financials","invoice.pay":"manage_projects","work.read":"view_projects","work.update":"manage_projects","schedule.read":"view_projects","schedule.update":"manage_projects"};
const typeOperations:Record<ResourceRef["type"],string[]>={project:["read","details.update","photos.read","photos.upload","notes.read","notes.create","work.read","work.update","schedule.read","schedule.update"],contact:["read"],channel:["read","messages.read","messages.post"],document:["read","documents.read","documents.respond"],media:["read"],invoice:["read","invoice.read","invoice.pay"]};
export function validateDelegatedOperations(ctx:PlatformAuthContext,type:ResourceRef["type"],operations:string[]){
  for(const operation of operations){
    if(!typeOperations[type].includes(operation))throw badRequest("shared_operation_invalid","This operation is not supported for the selected resource.");
    if(operationPermissions[operation])requirePermission(ctx,operationPermissions[operation]);
  }
}
export async function sharingOptions(ctx:PlatformAuthContext,type:ResourceRef["type"],after="",limit=50){
  requirePermission(ctx,"manage_external_sharing");requirePermission(ctx,permissions[type]);
  const candidates:{resource:ResourceRef;label:string}[]=[];
  const add=(id:string,label:string,project_id?:string)=>candidates.push({resource:{owner_org_id:ctx.orgId,type,id,...(project_id?{project_id}:{})},label});
  if(type==="project"||type==="contact")for(const project of await listDocuments(ctx.orgId,"projects")){
    if(type==="project"){if(project.data.workflow_state!=="contact_only")add(project.id,String(project.data.title||project.id));}
    else for(const contact of Array.isArray(project.data.contacts)?project.data.contacts as Record<string,any>[]:[])if(contact.id)add(String(contact.id),String(contact.name||contact.id),project.id);
  }
  if(type==="channel")for(const channel of await listChannelRecords(ctx.orgId)){
    try{await requireChannelAccess(ctx,channel.id);add(channel.id,channel.name);}catch(e:any){if(![403,404].includes(e.statusCode))throw e;}
  }
  if(type==="media")for(const media of await listMedia(ctx.orgId)){
    try{await validateResource(ctx,{owner_org_id:ctx.orgId,type,id:String(media.id)});add(String(media.id),String(media.file_name||media.id));}catch(e:any){if(![403,404].includes(e.statusCode))throw e;}
  }
  if(type==="document"){
    const {DOCUMENT_COLLECTION}=await import("../documents/storage.js");
    for(const document of await listDocuments(ctx.orgId,DOCUMENT_COLLECTION))add(document.id,String(document.data.title||document.id));
  }
  if(type==="invoice"){
    const {listOrganizationInvoices}=await import("../payments/invoices.js");
    for(const invoice of (await listOrganizationInvoices(ctx.orgId)).invoices)add(String(invoice.id),String(invoice.invoice_number||invoice.id));
  }
  const key=(item:typeof candidates[number])=>`${item.resource.project_id||""}:${item.resource.id}`;
  const eligible=candidates.sort((a,b)=>key(a).localeCompare(key(b))).filter(item=>key(item)>after);
  const items=eligible.slice(0,limit);
  return {items,next_cursor:eligible.length>limit?key(items.at(-1)!):null,fields:fields[type],operations:typeOperations[type]};
}
async function source(r:ResourceRef):Promise<Record<string,any>>{
  if(r.type==="project"){const d=await readDocument(r.owner_org_id,"projects",r.id);return {...d.data,id:d.id,revision:d.revision};}
  if(r.type==="contact"){const c=await resolveContact(r.owner_org_id,{project_id:r.project_id,contact_id:r.id});return {...c.contact,revision:c.parent.revision};}
  if(r.type==="document")return readDocumentInstance(r.owner_org_id,r.id);
  if(r.type==="invoice")return readInvoice(r.owner_org_id,r.id);
  if(r.type==="media")return readMediaMetadata(r.owner_org_id,r.id);
  const c=await readChannelRecord(r.owner_org_id,r.id);if(!c)throw notFound("channel_unavailable","This channel is unavailable.");return c;
}
export async function validateResource(ctx:PlatformAuthContext,r:ResourceRef){
  requirePermission(ctx,permissions[r.type]);
  if(r.type==="channel"){
    const {channel}=await requireChannelAccess(ctx,r.id,{write:true});
    if(!["public","private","project"].includes(channel.type)||!await channelAdminAllowed(ctx,channel))throw forbidden("channel_sharing_denied","Only channel managers can share collaboration channels.");
  }
  if(r.type==="contact"&&!r.project_id)throw badRequest("contact_anchor_required","Choose the contact's saved reference.");
  const value=await source(r);
  if(r.type==="media"){
    if(!canReadReceiptMedia(value,ctx))throw forbidden("media_private","This file is not available for sharing.");
    if(isReceiptMedia(value))requirePermission(ctx,"view_financials");
    if(value.metadata?.partner_relationship_id)requirePermission(ctx,"view_documents");
  }
}
export function projectFields(type:ResourceRef["type"],value:Record<string,any>,selected:string[]){
  const result:Record<string,unknown>={};
  for(const key of selected)if(fields[type].includes(key)&&["string","number","boolean"].includes(typeof value[key]))result[key]=value[key];
  return result;
}
export function validateSharedFields(type:ResourceRef["type"],selected:string[]){
  if(selected.some(key=>!fields[type].includes(key)))throw badRequest("shared_field_invalid","Choose only supported fields for this resource type.");
}
async function messageParticipant(message:Record<string,any>,owner:string){
  return await verifiedMessageContributor(message as any)||{organization_id:owner,user_id:message.author_id};
}
export async function readSharedResource(ctx:PlatformAuthContext,r:ResourceRef){
  return withSharedAccess(ctx,r,"read",async decision=>{
    requirePermission(decision.ctx,permissions[r.type]);
    const value=await source(r);
    if(r.type==="media"&&isReceiptMedia(value))requirePermission(decision.ctx,"view_financials");
    if(r.type==="media"&&value.metadata?.partner_relationship_id)requirePermission(decision.ctx,"view_documents");
    return {resource:r,revision:value.revision||1,data:projectFields(r.type,value,decision.fields),owner:await organizationProfile(r.owner_org_id),
      operations:decision.operations};
  });
}
export async function sharedResources(ctx:PlatformAuthContext,after="",limit=50,type="",owner=""){
  requirePermission(ctx,"use_external_shares");
  const page=await listGrants(ctx.orgId,"inbound",after,limit,type,owner),items:any[]=[],seen=new Set<string>();
  for(const grant of page.items){
    if(grant.status!=="active"||type&&grant.resource.type!==type||owner&&grant.owner_org_id!==owner)continue;
    const key=JSON.stringify(grant.resource);if(seen.has(key))continue;seen.add(key);
    try{items.push({...await readSharedResource(ctx,grant.resource),share_id:grant.id});}catch(e:any){if(![403,404].includes(e.statusCode))throw e;}
  }
  return {items,next_cursor:page.next_cursor};
}
export async function updateSharedDetails(ctx:PlatformAuthContext,r:ResourceRef,raw:unknown){
  const input=z.object({expected_revision:z.number().int().positive(),fields:z.record(z.string().max(4000))}).strict().parse(raw);
  if(r.type!=="project")throw badRequest("resource_operation_invalid","This action requires a project.");
  return withSharedAccess(ctx,r,"details.update",async d=>{
    requirePermission(d.ctx,"manage_projects");
    const keys=Object.keys(input.fields);
    if(!keys.length||keys.some(k=>!["title","description"].includes(k)||!d.fields.includes(k)))throw forbidden("shared_fields_denied","Only explicitly shared editable fields can be changed.");
    const saved=await updateProjectData(r.owner_org_id,r.id,(data,doc)=>{
      if(Number(doc.revision)!==input.expected_revision)throw conflict("revision_conflict","This project changed. Reload before saving.");
      return {...data,...input.fields};
    });
    await audit(d.grants[0]!,"collaboration.project.updated",actor(d.ctx),{fields:keys});
    return {revision:saved?.revision};
  });
}
function mediaInProject(media:Record<string,any>,projectId:string){return media.owner?.type==="project"&&media.owner.id===projectId&&!isReceiptMedia(media);}
function childAllowed(grants:Record<string,any>[],id:string){return grants.some(g=>g.include_future||g.child_ids.includes(id));}
export async function sharedPhotos(ctx:PlatformAuthContext,r:ResourceRef){
  if(r.type!=="project")throw badRequest("project_required","Choose a project.");
  return withSharedAccess(ctx,r,"photos.read",async d=>{
    requirePermission(d.ctx,"view_media");
    const media=await listMedia(r.owner_org_id);
    return {items:media.filter(m=>mediaInProject(m,r.id)&&childAllowed(d.grants,String(m.id))&&String(m.content_type).startsWith("image/")).map(m=>({id:m.id,...projectFields("media",m,[...fields.media])}))};
  });
}
export async function sharedFile(ctx:PlatformAuthContext,r:ResourceRef,mediaId:string){
  const operation=r.type==="project"?"photos.read":"read";
  if(!["project","media"].includes(r.type))throw badRequest("media_required","Choose a media resource.");
  return withSharedAccess(ctx,r,operation,async d=>{
    requirePermission(d.ctx,"view_media");
    const media=await readMediaMetadata(r.owner_org_id,mediaId);
    if(r.type==="project"?(!mediaInProject(media,r.id)||!childAllowed(d.grants,mediaId)||!String(media.content_type).startsWith("image/")):r.id!==mediaId)throw forbidden("media_not_shared","This file is not shared.");
    if(isReceiptMedia(media))requirePermission(d.ctx,"view_financials");
    if((media.metadata as any)?.partner_relationship_id)requirePermission(d.ctx,"view_documents");
    const file=await readMediaFile(r.owner_org_id,mediaId);
    if(r.type==="project"){
      if(file.bytes.length>20_000_000)throw badRequest("photo_size","This photo is too large for the shared viewer.");
      const bytes=await sharp(file.bytes,{limitInputPixels:40_000_000}).rotate().jpeg({quality:90}).toBuffer();
      return {bytes,contentType:"image/jpeg",fileName:file.fileName.replace(/\.[^.]*$/,"")+".jpg"};
    }
    return file;
  });
}
export async function sharedMessages(ctx:PlatformAuthContext,r:ResourceRef,after=0){
  if(r.type!=="channel")throw badRequest("channel_required","Choose a channel.");
  return withSharedAccess(ctx,r,"messages.read",async d=>{
    requirePermission(d.ctx,"view_channels");
    const messages=await listMessageRecords(r.owner_org_id,r.id,{after,limit:100});
    const earliest=d.grants.reduce((time,g)=>g.include_future?Math.min(time,Date.parse(g.created_at)):time,Infinity);
    const visible=messages.filter(m=>!m.deleted_at&&!m.audience.length&&(d.grants.some(g=>g.child_ids.includes(m.id))||Date.parse(m.created_at)>=earliest));
    return {items:await Promise.all(visible.map(async m=>({id:m.id,seq:m.seq,text:m.text,created_at:m.created_at,parent_id:m.parent_id,
      author:await participantView(ctx.orgId,await messageParticipant(m,r.owner_org_id),true)}))),next_sequence:messages.at(-1)?.seq||after};
  });
}
async function messageOperation(ctx:PlatformAuthContext,r:ResourceRef,kind:string,input:{text:string;client_operation_id:string},write:(id:string)=>Promise<{id:string;seq?:number}>){
  const digest=(value:string)=>createHash("sha256").update(value).digest("hex");
  const id=`shared_message_${digest(JSON.stringify([r,ctx.orgId,ctx.userId,kind,input.client_operation_id]))}`,requestHash=digest(input.text),prior=await findRecord(id,"message_operation");
  if(prior){if(prior.request_hash!==requestHash)throw conflict("operation_conflict","This message reference was already used for different content.");return prior.result as {id:string;seq?:number};}
  const result=await write(id);
  await insertRecord("message_operation",{id,owner_org_id:r.owner_org_id,recipient_org_id:ctx.orgId,resource:r,status:"completed",revision:1,created_by:actor(ctx),request_hash:requestHash,result});return result;
}
export async function postSharedMessage(ctx:PlatformAuthContext,r:ResourceRef,raw:unknown){
  const input=z.object({text:z.string().trim().min(1).max(20000),client_operation_id:z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/)}).strict().parse(raw);
  if(r.type!=="channel")throw badRequest("channel_required","Choose a channel.");
  return withSharedAccess(ctx,r,"messages.post",async d=>{
    requirePermission(d.ctx,"send_channel_messages");
    const channel=await readChannelRecord(r.owner_org_id,r.id);if(!channel||channel.archived_at||channel.settings.posting_locked===true)throw forbidden("channel_closed","This channel is closed to external posts.");
    return messageOperation(ctx,r,"message",input,async operationId=>{
    const message=await createMessageRecord({organization_id:r.owner_org_id,channel_id:r.id,author_id:`external_${ctx.orgId}_${ctx.userId}`,client_msg_id:operationId,text:input.text,metadata:{collaboration_actor:actor(ctx)}});
    await audit(d.grants[0]!,"collaboration.message.posted",actor(ctx),{message_id:message.id});return {id:message.id,seq:message.seq};
    });
  });
}

export async function uploadSharedPhoto(ctx:PlatformAuthContext,r:ResourceRef,raw:unknown){
  const input=z.object({file_name:z.string().min(1).max(180),file_base64:z.string().max(12_000_000),client_operation_id:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)}).strict().parse(raw);
  if(r.type!=="project")throw badRequest("project_required","Choose a project.");
  const decoded=Buffer.from(input.file_base64,"base64");
  if(!decoded.length||decoded.length>8_000_000)throw badRequest("photo_size","Photos must be under 8 MB.");
  // Decode and normalize before taking authorization locks; EXIF/GPS is not republished.
  const bytes=await sharp(decoded,{limitInputPixels:40_000_000}).rotate().jpeg({quality:90}).toBuffer();
  return withSharedAccess(ctx,r,"photos.upload",async d=>{
    requirePermission(d.ctx,"manage_media");
    const hash=createHash("sha256").update(bytes).digest("hex"),id=`shared_photo_${createHash("sha256").update([r.owner_org_id,r.id,ctx.orgId,ctx.userId,input.client_operation_id].join(":" )).digest("hex")}`;
    let previous:any=null;try{previous=await readMediaMetadata(r.owner_org_id,id);}catch(e:any){if(e.statusCode!==404&&e.code!=="ENOENT")throw e;}
    if(previous){if(previous.metadata?.collaboration_hash!==hash)throw conflict("operation_conflict","This upload key was already used for another file.");return {id};}
    await storeMediaUpload(r.owner_org_id,{id,ownerType:"project",ownerId:r.id,collection:"photos",fileName:input.file_name.replace(/\.[^.]*$/,"")+".jpg",contentType:"image/jpeg",bytes,metadata:{project_id:r.id,collaboration_actor:actor(ctx),collaboration_hash:hash,uploaded_at:now()}});
    await audit(d.grants[0]!,"collaboration.photo.uploaded",actor(ctx),{media_id:id});return {id};
  });
}
export async function sharedNotes(ctx:PlatformAuthContext,r:ResourceRef){
  if(r.type!=="project")throw badRequest("project_required","Choose a project.");
  return withSharedAccess(ctx,r,"notes.read",async d=>{
    requirePermission(d.ctx,"view_projects");
    const channel=await findChannelByProject(r.owner_org_id,r.id);if(!channel)return {items:[]};
    const messages=await listMessageRecords(r.owner_org_id,channel.id,{limit:200,projectNotes:true});
    const visible=messages.filter(m=>!m.deleted_at&&!m.audience.length&&(d.grants.some(g=>g.child_ids.includes(m.id))||m.metadata.collaboration_visible===true&&d.grants.some(g=>g.include_future)));
    return {items:await Promise.all(visible.map(async m=>({id:m.id,text:m.text,created_at:m.created_at,author:await participantView(ctx.orgId,await messageParticipant(m,r.owner_org_id),true)})))};
  });
}
export async function createSharedNote(ctx:PlatformAuthContext,r:ResourceRef,raw:unknown){
  const input=z.object({text:z.string().trim().min(1).max(20000),client_operation_id:z.string().regex(/^[A-Za-z0-9_-]{1,100}$/)}).strict().parse(raw);
  if(r.type!=="project")throw badRequest("project_required","Choose a project.");
  return withSharedAccess(ctx,r,"notes.create",async d=>{
    requirePermission(d.ctx,"manage_projects");
    return messageOperation(ctx,r,"note",input,async operationId=>{
    let channel=await findChannelByProject(r.owner_org_id,r.id);
    if(!channel)channel=await createChannelRecord({organization_id:r.owner_org_id,type:"project",project_id:r.id,name:"Project",created_by:`external_${ctx.orgId}_${ctx.userId}`});
    const note=await createMessageRecord({organization_id:r.owner_org_id,channel_id:channel.id,author_id:`external_${ctx.orgId}_${ctx.userId}`,client_msg_id:operationId,text:input.text,metadata:{project_note:true,collaboration_visible:true,collaboration_actor:actor(ctx)}});
    await audit(d.grants[0]!,"collaboration.note.created",actor(ctx),{note_id:note.id});return {id:note.id};
    });
  });
}
