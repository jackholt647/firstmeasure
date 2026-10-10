import { createHash } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { requirePlatformAuth, hasPermission, can, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, forbidden, notFound } from "../platform/errors.js";
import { listDocuments, listMedia, readDocument, readMediaMetadata, storeMediaUpload } from "../platform/storage.js";
import { canReadReceiptMedia } from "../platform/media_access.js";
import { readEventRecord, listEventRecords } from "../work/storage.js";
import { grantFeedRoot } from "./feed-access.js";
import * as store from "./storage.js";
import * as channels from "./service.js";
import { postMessageSchema, reactionSchema, editMessageSchema, giphyMessageSchema } from "./schemas.js";
import {canAccessDepartmentResource,hasResourcePermission,matchesDepartmentFilter,relevantDepartmentContext} from '../workforce/department-access.js';
import { canManageFeed, canViewAllFeedDepartments, canViewFeedActivity, feedDepartmentContext, matchesFeedDepartment } from "./feed-permissions.js";
import { defaultFeedPostActivityTypes, allowedFeedDepartments, feedActivityOptions, feedGroupDirectory, readFeedPostSettings, requireFeedDepartment, saveFeedPostSettings } from "./feed-groups.js";

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v : {};
const str = (v: unknown) => String(v ?? "").trim();
const refSchema = z.object({ kind:z.enum(["media","document","activity"]), id:z.string().trim().min(1).max(500), project_id:z.string().trim().max(200).default("") });
const refsSchema = z.object({ refs:z.array(refSchema).min(1).max(200) });
type Ref = z.infer<typeof refSchema>;
const views = ["list","small","large","mosaic","posts"];
export function feedPermission(ctx: PlatformAuthContext, key: string) {
  // Migration default: all members may use all layouts and participate.
  // An explicit deny wins, including a resolved role/user deny and wildcard.
  return ctx.permissions[key] !== false && (ctx.permissions[key] === undefined || hasPermission(ctx,key));
}
function requirePermission(ctx: PlatformAuthContext,key:string) {
  if (!feedPermission(ctx,key)) throw forbidden("feed_forbidden","This Feed action is not available to you.");
}
function permissionForType(type: string) {
  if (/^(payment|invoice|expense|receipt|payroll)\./.test(type)) return "view_financials";
  if (/^proposal\./.test(type)) return "view_proposals";
  if (/^(document|contract)\./.test(type)) return "view_documents";
  if (/^(project\.event|recurrence)\./.test(type)) return "view_schedule";
  if (/^material\./.test(type)) return "view_materials";
  return "view_projects";
}
const projectCaches=new WeakMap<PlatformAuthContext,Map<string,Promise<Obj>>>();
async function projectAccess(ctx:PlatformAuthContext,id:string) {
  if (!hasPermission(ctx,"view_projects")) throw forbidden("feed_source_denied","Project access is required.");
  if (!id) return null;
  let cache=projectCaches.get(ctx);if(!cache){cache=new Map();projectCaches.set(ctx,cache);}
  let promise=cache.get(id);if(!promise){promise=readDocument(ctx.orgId,"projects",id).then(r=>obj(r.data));cache.set(id,promise);}
  const p=await promise;
  if (p.deleted_at || p.trashed_at || p.branch_id && p.branch_id !== ctx.branchId && !hasPermission(ctx,"manage_company_settings")) throw notFound("feed_source_missing","This source is not available.");
  if (!hasResourcePermission(ctx,"view_projects",p) || !canAccessDepartmentResource(ctx,p,"view_projects")) throw notFound("feed_source_missing","This project is not available.");
  return p;
}
export async function resolveFeedSource(ctx:PlatformAuthContext,ref:Ref) {
  let data:Obj, projectId="", author="system", at="", key="";
  if (ref.kind === "media") {
    data=obj(await readMediaMetadata(ctx.orgId,ref.id).catch(()=>null));
    if (!data.id && ref.project_id) {
      const project=await projectAccess(ctx,ref.project_id);
      data=obj((project?.photos || []).find((p:Obj)=>[p.id,p.media_id,p.src].map(str).includes(ref.id)));
    }
    const meta=obj(data.metadata),owner=obj(data.owner);
    projectId=str(meta.project_id || (owner.type === "project" ? owner.id : "") || ref.project_id);
    if (!Object.keys(data).length || data.deleted_at || data.trashed_at || !canReadReceiptMedia(data,ctx) || !hasResourcePermission(ctx,"view_media",{...data,...obj(data.metadata)})) throw notFound("feed_source_missing","This media is not available.");
    // A non-project owner must not be rebound to a caller-selected project.
    if (owner.type && owner.type !== "project") throw notFound("feed_source_missing","This media is not a project feed artifact.");
    await projectAccess(ctx,projectId);
    author=str(meta.uploaded_by_user_id || meta.uploaded_by || data.uploaded_by_user_id || data.uploaded_by || data.created_by || "system");
    at=str(meta.uploaded_at || data.uploaded_at || data.created_at);
    const batch=str(meta.upload_batch_id || meta.batch_id || data.upload_batch_id);
    const bucket=Number.isFinite(Date.parse(at)) ? Math.floor(Date.parse(at)/300000) : ref.id;
    key=`media:${projectId}:${author}:${batch || bucket}`;
  } else if (ref.kind === "activity") {
    data=obj(await readEventRecord(ctx.orgId,ref.id));
    if (!data.id || data.visibility !== "activity" || !hasResourcePermission(ctx,permissionForType(str(data.type)),{...data,...obj(data.payload)})) throw notFound("feed_source_missing","This event is not available.");
    projectId=str(data.project_id);await projectAccess(ctx,projectId);
    author=str(data.actor_user_id || obj(data.context).actor_user_id || "system");at=str(data.created_at);key=`activity:${data.id}`;
    // Recheck referenced document/media authority instead of relying on event access.
    const payload=obj(data.payload);
    if (payload.document_id) await resolveFeedSource(ctx,{kind:"document",id:str(payload.document_id),project_id:projectId});
    if (payload.media_id) await resolveFeedSource(ctx,{kind:"media",id:str(payload.media_id),project_id:projectId});
  } else {
    const project=await projectAccess(ctx,ref.project_id);
    if (ref.id.startsWith("invoice:")) {
      if (!hasPermission(ctx,"view_financials")) throw forbidden("feed_source_denied","Financial access is required.");
      data=obj(await (await import("../payments/invoices.js")).readInvoice(ctx.orgId,ref.id.slice(8)));
    } else if (ref.id.startsWith("receipt:")) {
      if (!hasPermission(ctx,"view_financials")) throw forbidden("feed_source_denied","Financial access is required.");
      data=obj(await (await import("../payments/expenses.js")).readReceipt(ctx.orgId,ref.id.slice(8)));
    } else {
      // Canonical document classification overrides any embedded project preview.
      const canonical = await (await import("../documents/storage.js")).readDocumentInstance(ctx.orgId,ref.id).catch(()=>null);
      data=canonical ? obj(canonical) : obj((project?.documents || []).find((d:Obj)=>str(d.id || d.document_id || d.media_id)===ref.id));
      if (!Object.keys(data).length) data=obj((await readDocument(ctx.orgId,"documents",ref.id).catch(()=>readDocument(ctx.orgId,"proposals",ref.id))).data);
      if (!hasResourcePermission(ctx,/invoice|receipt/.test(str(data.document_type || data.type))?"view_financials":str(data.document_type || data.type).includes("proposal")?"view_proposals":"view_documents",data)) throw forbidden("feed_source_denied","Document access is required.");
    }
    projectId=str(data.project_id || ref.project_id);
    if (!Object.keys(data).length || data.deleted_at || projectId !== ref.project_id) throw notFound("feed_source_missing","This document is not available.");
    author=str(data.uploaded_by_user_id || data.created_by || data.uploaded_by || "system");
    at=str(data.uploaded_at || data.created_at || data.issued_at);key=`document:${projectId}:${ref.id}`;
  }
  const metadata=obj(data.metadata),payload=obj(data.payload);
  const department_ids=Array.isArray(data.department_ids)?data.department_ids:Array.isArray(metadata.department_ids)?metadata.department_ids:Array.isArray(payload.department_ids)?payload.department_ids:ctx.organizationStructure?.users.find(u=>u.id===author)?.department_ids||[];
  const resource={...data,department_ids,department_access:str(data.department_access||metadata.department_access)};
  if(!canAccessDepartmentResource(ctx,resource,ref.kind==="media"?"view_media":ref.kind==="activity"?permissionForType(str(data.type)):"view_documents|view_proposals|view_financials"))throw notFound('feed_source_missing','This source is not available.');
  if (!matchesFeedDepartment(ctx,{department_ids})) throw notFound('feed_source_missing','This source is outside your feed departments.');
  return {ref:{...ref,project_id:projectId},key,author,at,department_ids};
}
async function authorizeRefs(ctx:PlatformAuthContext,refs:Ref[]) {
  const resolved=await Promise.all(refs.map(ref=>resolveFeedSource(ctx,ref)));
  if (resolved.some(r=>r.key!==resolved[0]!.key)) throw forbidden("feed_group_mismatch","These artifacts are not one upload/post.");
  return resolved;
}
async function feedChannel(orgId:string) {
  try {return await store.getChannelsDatabase().transaction(async()=>await store.findChannelByDmKey(orgId,"company-feed") || store.createChannelRecord({organization_id:orgId,type:"feed",name:"Company feed",created_by:"system",dm_key:"company-feed",settings:{feed:true}}));}
  catch(error){const existing=await store.findChannelByDmKey(orgId,"company-feed");if(existing)return existing;throw error;}
}
async function createRootRecord(input:Parameters<typeof store.createMessageRecord>[0]) {
  try{return await store.createMessageRecord(input);}
  catch(error){const existing=await store.findMessageByClientId(input.channel_id,input.author_id,str(input.client_msg_id));if(existing?.organization_id===input.organization_id)return existing;throw error;}
}
async function ensureRoot(ctx:PlatformAuthContext,refs:Ref[]) {
  const sources=await authorizeRefs(ctx,refs),source=sources[0]!;
  const channel=await feedChannel(ctx.orgId);
  const clientId=createHash("sha256").update(source.key).digest("hex");
  const root=await createRootRecord({organization_id:ctx.orgId,channel_id:channel.id,author_id:source.author,client_msg_id:clientId,text:"",created_at:source.at || undefined,metadata:{feed_post:true,feed_source:sources.map(s=>s.ref),feed_key:source.key}});
  await authorizedRoot(ctx,root.id);
  return root;
}
async function authorizedRoot(ctx:PlatformAuthContext,id:string) {
  const row=await store.readMessageRecord(ctx.orgId,id);
  const root=row?.parent_id ? await store.readMessageRecord(ctx.orgId,row.parent_id) : row;
  if (!row || !root || root.deleted_at || root.metadata.feed_post !== true) throw notFound("feed_post_missing","This post is not available.");
  if (root.metadata.feed_manual === true) {
    const departmentId=str(root.metadata.feed_department_id);
    if (departmentId) requireFeedDepartment(await feedGroupDirectory(ctx.orgId),ctx.userId,departmentId,ctx);
  } else {
    const refs=z.array(refSchema).min(1).max(200).parse(root.metadata.feed_source);
    await authorizeRefs(ctx,refs);
  }
  grantFeedRoot(ctx,root.id);
  return {row,root};
}
export async function authorizeFeedAttachment(ctx:PlatformAuthContext,rootId:string) {
  await feedActionAccess(ctx,"view_feed_posts");
  await authorizedRoot(ctx,rootId);
}
async function feedActionAccess(ctx:PlatformAuthContext,key:string) {
  if(!await can(ctx,"platform.photos_feed"))throw forbidden("feed_disabled","Feed is not enabled.");
  requirePermission(ctx,"view_feed");requirePermission(ctx,"view_feed_posts");requirePermission(ctx,key);
}
export async function readFeedThread(ctx:PlatformAuthContext,messageId:string) {
  await feedActionAccess(ctx,"view_feed_posts");const {root}=await authorizedRoot(ctx,messageId);
  return channels.listThread(ctx,root.id,{});
}
export async function createFeedComment(ctx:PlatformAuthContext,messageId:string,input:unknown) {
  await feedActionAccess(ctx,"comment_feed");const {root}=await authorizedRoot(ctx,messageId),body=postMessageSchema.parse(input);
  let parentId=root.id,replyTo:Obj|undefined;
  if(body.parent_id && body.parent_id!==root.id){const {row,root:replyRoot}=await authorizedRoot(ctx,body.parent_id);if(replyRoot.id!==root.id || !row.parent_id || row.deleted_at)throw forbidden("feed_reply_denied","This comment is not in this post.");parentId=row.id;replyTo={id:row.id,author_name:(await channels.userDirectory(ctx.orgId)).get(row.author_id)?.name || "Someone"};}
  return channels.postMessage(ctx,root.channel_id,{text:body.text,content:body.content,client_msg_id:body.client_msg_id,parent_id:parentId,attachment_ids:body.attachment_ids,metadata:{...(body.metadata.giphy?{giphy:body.metadata.giphy}:{}),...(body.metadata.audio_note?{audio_note:body.metadata.audio_note}:{}),...(replyTo?{feed_reply_to:replyTo}:{})}});
}
export async function reactFeedMessage(ctx:PlatformAuthContext,messageId:string,input:unknown) {
  await feedActionAccess(ctx,"react_feed");await authorizedRoot(ctx,messageId);const body=reactionSchema.parse(input);
  return channels.toggleReaction(ctx,messageId,body.emoji,body.on);
}
export async function resolveFeedPost(ctx:PlatformAuthContext,input:unknown,projectId?:string) {
  await feedActionAccess(ctx,"view_feed_posts");const refs=refsSchema.parse(input).refs;
  if(projectId && (await authorizeRefs(ctx,refs)).some(s=>s.ref.project_id!==projectId))throw forbidden("feed_project_denied","This post is outside the project context.");
  const root=await ensureRoot(ctx,refs);
  return channels.listThread(ctx,root.id,{});
}
// Called from durable Work event delivery. Source references and actor IDs come
// from the server event/media records; no permission snapshots or bodies are stored.
export async function recordFeedEvent(event:Obj) {
  if(event.visibility!=="activity" || !event.id)return;
  const {isCapabilityEnabled}=await import("../platform/capabilities.js");
  const orgId=str(event.organization_id);
  if(!await isCapabilityEnabled(orgId,"platform.photos_feed"))return;
  let ref:Ref={kind:"activity",id:str(event.id),project_id:str(event.project_id)},key=`activity:${event.id}`,author=str(event.actor_user_id || obj(event.context).actor_user_id || "system"),at=str(event.created_at);
  const mediaId=str(obj(event.payload).media_id);
  if(event.type==="media.uploaded" && mediaId){
    const data=obj(await readMediaMetadata(orgId,mediaId)),meta=obj(data.metadata),owner=obj(data.owner);
    if(owner.type!=="project")return;
    ref={kind:"media",id:mediaId,project_id:str(meta.project_id || owner.id)};
    author=str(meta.uploaded_by_user_id || meta.uploaded_by || data.uploaded_by_user_id || data.uploaded_by || data.created_by || "system");
    at=str(meta.uploaded_at || data.uploaded_at || data.created_at);
    const batch=str(meta.upload_batch_id || meta.batch_id || data.upload_batch_id),bucket=Number.isFinite(Date.parse(at))?Math.floor(Date.parse(at)/300000):mediaId;
    key=`media:${ref.project_id}:${author}:${batch || bucket}`;
  }
  const channel=await feedChannel(orgId);
  await createRootRecord({organization_id:orgId,channel_id:channel.id,author_id:author,client_msg_id:createHash("sha256").update(key).digest("hex"),text:"",created_at:at || undefined,metadata:{feed_post:true,feed_source:[ref],feed_key:key}});
}
export function registerFeedRoutes(app:FastifyInstance) {
  const prefix="/organizations/:orgId/feed";
  const auth=async(request:any,csrf=false)=>{
    const ctx=await requirePlatformAuth(request,{orgId:str(request.params.orgId),capability:"platform.photos_feed",application:["management","field"],csrf});
    requirePermission(ctx,"view_feed");return ctx;
  };
  app.get(prefix+"/catalog",async request=>{
    const ctx=await auth(request);
    const departmentId=str(obj(request.query).department_id);
    const relevant=(source:{department_ids:string[]})=>matchesFeedDepartment(ctx,source,departmentId);
    const allowedViews=views.filter(v=>feedPermission(ctx,`view_feed_${v}`) && (v === "posts" || canViewFeedActivity(ctx)));
    if (!allowedViews.length) throw forbidden("feed_views_denied","No feed views are available.");
    const [records,allMedia,events,directory,groups,settings]=await Promise.all([listDocuments(ctx.orgId,"projects"),listMedia(ctx.orgId),listEventRecords(ctx.orgId,{visibility:"activity",limit:500}),channels.userDirectory(ctx.orgId),feedGroupDirectory(ctx.orgId),readFeedPostSettings(ctx.orgId)]);
    const projects=[];
    for (const r of records) {try {
      const original=await projectAccess(ctx,r.id),p:Obj={id:r.id,title:original?.title,project_title:original?.project_title,address:original?.address,customer_name:original?.customer_name,contacts:original?.contacts,photos:[],documents:[]};
      for(const photo of original?.photos || []){try{const source=await resolveFeedSource(ctx,{kind:"media",id:str(photo.media_id || photo.id || photo.src),project_id:r.id});if(relevant(source))p.photos.push({...photo,department_ids:source.department_ids});}catch{}}
      for(const doc of original?.documents || []){try{const source=await resolveFeedSource(ctx,{kind:"document",id:str(doc.id || doc.document_id || doc.media_id),project_id:r.id});if(relevant(source))p.documents.push({...doc,department_ids:source.department_ids});}catch{}}
      projects.push({id:r.id,data:p});
    }catch{}}
    const projectIds=new Set(projects.map(p=>p.id));

    const media=allMedia.filter(m=>{const d=obj(m),o=obj(d.owner);return hasResourcePermission(ctx,"view_media",{...d,...obj(d.metadata)}) && canReadReceiptMedia(m,ctx) && projectIds.has(str(obj(d.metadata).project_id || (o.type==="project"?o.id:"")));});
    const permittedEvents:Obj[]=[],permittedMedia:Obj[]=[];
    for(const item of media){try{const d=obj(item),o=obj(d.owner);const source=await resolveFeedSource(ctx,{kind:'media',id:str(d.id),project_id:str(obj(d.metadata).project_id||(o.type==='project'?o.id:''))});if(relevant(source))permittedMedia.push({...d,department_ids:source.department_ids});}catch{}}
    for (const event of events) {try {const source=await resolveFeedSource(ctx,{kind:"activity",id:str(event.id),project_id:str(event.project_id)});if(relevant(source))permittedEvents.push({...event,department_ids:source.department_ids});}catch{}}
    const memberDepartments=allowedFeedDepartments(groups,ctx.userId);
    const visibleDepartmentIds=canViewAllFeedDepartments(ctx) ? groups.departments.map(department=>department.id) : memberDepartments;
    const channel=await store.findChannelByDmKey(ctx.orgId,"company-feed");
    const manualRecords=channel && feedPermission(ctx,"view_feed_posts") ? (await store.listFeedManualMessageRecords(ctx.orgId,channel.id)).filter(row=>!str(row.metadata.feed_department_id) || visibleDepartmentIds.includes(str(row.metadata.feed_department_id))) : [];
    manualRecords.forEach(row=>grantFeedRoot(ctx,row.id));
    const manualPosts=channel ? await channels.hydrateMessages(ctx,channel,manualRecords) : [];
    const visibleDepartments=groups.departments.filter(department=>visibleDepartmentIds.includes(department.id));
    const visibleSettings={...settings,department_activity_types:Object.fromEntries(visibleDepartmentIds.map(id=>[id,settings.department_activity_types[id] ?? null]))};
    return {ok:true,projects,media:permittedMedia,events:permittedEvents,department_context:feedDepartmentContext(ctx),users:[...directory.values()],views:allowedViews,can_comment:feedPermission(ctx,"comment_feed"),can_react:feedPermission(ctx,"react_feed"),can_post:feedPermission(ctx,"comment_feed"),manual_posts:manualPosts,departments:visibleDepartments,user_departments:groups.user_departments,member_department_ids:memberDepartments,post_settings:visibleSettings,activity_options:feedActivityOptions(permittedEvents.map(event=>str(event.type))),can_manage_post_settings:canManageFeed(ctx),can_manage_feed:canManageFeed(ctx),can_view_all_departments:canViewAllFeedDepartments(ctx),post_departments:groups.departments.filter(department=>memberDepartments.includes(department.id)),default_activity_types:defaultFeedPostActivityTypes};
  });
  app.get(prefix+"/settings",async request=>{
    const ctx=await auth(request);
    if(!canManageFeed(ctx))throw forbidden("feed_settings_denied","Feed manager permission is required.");
    const events=await listEventRecords(ctx.orgId,{visibility:"activity",limit:500});
    return {ok:true,settings:await readFeedPostSettings(ctx.orgId),departments:(await feedGroupDirectory(ctx.orgId)).departments,activity_options:feedActivityOptions(events.map(event=>str(event.type))),default_activity_types:defaultFeedPostActivityTypes};
  });
  app.put(prefix+"/settings",async request=>{
    const ctx=await auth(request,true);
    return {ok:true,settings:await saveFeedPostSettings(ctx,request.body)};
  });
  app.post(prefix+"/posts/manual",async request=>{
    const ctx=await auth(request,true);requirePermission(ctx,"view_feed_posts");requirePermission(ctx,"comment_feed");
    const body=z.object({text:z.string().trim().max(5000).default(""),department_id:z.string().trim().max(120).default(""),mention_user_ids:z.array(z.string().trim().min(1).max(160)).max(20).default([]),client_msg_id:z.string().trim().max(160).optional(),has_uploads:z.boolean().default(false),giphy:giphyMessageSchema.optional(),audio_note:z.record(z.unknown()).optional()}).strict().refine(value=>!!(value.text || value.has_uploads || value.giphy),{message:"A post needs text, a GIF, or an attachment."}).parse(request.body);
    const groups=await feedGroupDirectory(ctx.orgId);
    if(body.department_id)requireFeedDepartment(groups,ctx.userId,body.department_id);
    const directory=await channels.userDirectory(ctx.orgId);
    const mentions=[...new Set(body.mention_user_ids)].map(id=>{
      const user=directory.get(id);
      if(!user || !Object.prototype.hasOwnProperty.call(groups.user_departments,id))throw notFound("feed_mention_missing","A tagged employee was not found.");
      if(body.department_id && !allowedFeedDepartments(groups,id).includes(body.department_id))throw forbidden("feed_mention_denied","Tagged employees must belong to this department.");
      return {id,name:user.name};
    });
    const channel=await feedChannel(ctx.orgId);
    const message=await createRootRecord({organization_id:ctx.orgId,channel_id:channel.id,author_id:ctx.userId,client_msg_id:body.client_msg_id,text:body.text,mention_users:mentions,metadata:{feed_post:true,feed_manual:true,feed_department_id:body.department_id,...(body.giphy?{giphy:body.giphy}:{}),...(body.audio_note?{audio_note:body.audio_note}:{})}});
    grantFeedRoot(ctx,message.id);
    return {ok:true,post:(await channels.hydrateMessages(ctx,channel,[message]))[0]};

  });
  app.post(prefix+"/authorize",async request=>{
    const ctx=await auth(request,true),body=z.object({refs:z.array(refSchema).max(3000),department_id:z.string().optional()}).parse(request.body);
    const sources=[];
    for (const ref of body.refs) {try {const source=await resolveFeedSource(ctx,ref);if(matchesFeedDepartment(ctx,source,body.department_id))sources.push(source);}catch{}}
    return {ok:true,sources};
  });
  app.post(prefix+"/posts/lookup",async request=>{
    const ctx=await auth(request,true);requirePermission(ctx,"view_feed_posts");
    const sources=await authorizeRefs(ctx,refsSchema.parse(request.body).refs);
    const channel=await store.findChannelByDmKey(ctx.orgId,"company-feed");
    const root=channel?await store.findMessageByClientId(channel.id,sources[0]!.author,createHash("sha256").update(sources[0]!.key).digest("hex")):null;
    if(!root)return {ok:true,root:null,replies:[]};
    await authorizedRoot(ctx,root.id);
    return {ok:true,...await channels.listThread(ctx,root.id,{})};
  });
  app.post(prefix+"/posts/:messageId/uploads",async request=>{
    const ctx=await auth(request,true);requirePermission(ctx,"view_feed_posts");requirePermission(ctx,"comment_feed");
    const {root}=await authorizedRoot(ctx,str((request.params as Obj).messageId));
    const part=await request.file();
    if(!part)throw forbidden("file_required","Choose an attachment.");
    const manual=root.metadata.feed_manual === true && root.id === str((request.params as Obj).messageId);
    if(manual && root.author_id !== ctx.userId)throw forbidden("feed_post_upload_denied","Only the author can add images to this post.");
    const bytes=await part.toBuffer();
    if(manual && bytes.length>(part.mimetype.startsWith("image/")?10:25)*1024*1024)throw badRequest("feed_post_file_too_large","Images must be 10 MB or smaller; other files must be 25 MB or smaller.");
    const media=await storeMediaUpload(ctx.orgId,{ownerType:"channel",ownerId:root.channel_id,slot:"attachment",fileName:part.filename,contentType:part.mimetype,bytes,metadata:{source:manual?"feed_post":"feed_comment",channel_id:root.channel_id,feed_root_id:root.id,uploaded_by:ctx.userId}});
    const attachment=await store.createAttachmentRecord({organization_id:ctx.orgId,channel_id:root.channel_id,media_id:str(media.id),file_name:part.filename,content_type:part.mimetype,size_bytes:bytes.length,uploaded_by:ctx.userId});
    if(manual)await store.attachToMessage(ctx.orgId,[attachment.id],root.id,root.channel_id,ctx.userId);
    return {ok:true,attachment};
  });
  app.post(prefix+"/posts/resolve",async request=>{
    const ctx=await auth(request,true);requirePermission(ctx,"view_feed_posts");
    const root=await ensureRoot(ctx,refsSchema.parse(request.body).refs);
    return {ok:true,...await channels.listThread(ctx,root.id,{})};
  });
  app.get(prefix+"/posts/:messageId",async request=>{
    const ctx=await auth(request);requirePermission(ctx,"view_feed_posts");
    const {root}=await authorizedRoot(ctx,str((request.params as Obj).messageId));
    return {ok:true,...await channels.listThread(ctx,root.id,{})};
  });
  app.post(prefix+"/posts/:messageId/comments",async request=>{
    const ctx=await auth(request,true);requirePermission(ctx,"view_feed_posts");requirePermission(ctx,"comment_feed");
    const {root}=await authorizedRoot(ctx,str((request.params as Obj).messageId));
    const result=await createFeedComment(ctx,root.id,request.body);
    return {ok:true,...result};
  });
  app.post(prefix+"/messages/:messageId/reactions",async request=>{
    const ctx=await auth(request,true);requirePermission(ctx,"view_feed_posts");requirePermission(ctx,"react_feed");
    const id=str((request.params as Obj).messageId);await authorizedRoot(ctx,id);
    const body=reactionSchema.parse(request.body);
    return {ok:true,message:await channels.toggleReaction(ctx,id,body.emoji,body.on)};
  });
  app.patch(prefix+"/messages/:messageId",async request=>{
    const ctx=await auth(request,true);requirePermission(ctx,"view_feed_posts");requirePermission(ctx,"comment_feed");
    const id=str((request.params as Obj).messageId),{row}=await authorizedRoot(ctx,id);
    if (!row.parent_id && row.metadata.feed_manual !== true) throw forbidden("feed_post_immutable","Automated posts cannot be edited.");
    return {ok:true,message:await channels.editMessage(ctx,id,editMessageSchema.parse(request.body))};
  });
  app.delete(prefix+"/messages/:messageId",async request=>{
    const ctx=await auth(request,true);requirePermission(ctx,"view_feed_posts");
    if(!canManageFeed(ctx))requirePermission(ctx,"comment_feed");
    const id=str((request.params as Obj).messageId),{row}=await authorizedRoot(ctx,id);
    if (!row.parent_id && row.metadata.feed_manual !== true) throw forbidden("feed_post_immutable","Automated posts cannot be deleted.");
    return {ok:true,message:await channels.deleteMessage(ctx,id)};
  });
  app.post(prefix+"/messages/:messageId/restore",async request=>{
    const ctx=await auth(request,true);requirePermission(ctx,"view_feed_posts");
    if(!canManageFeed(ctx))requirePermission(ctx,"comment_feed");
    const id=str((request.params as Obj).messageId),{row}=await authorizedRoot(ctx,id);
    if(!row.parent_id)throw forbidden("feed_post_immutable","Automated posts cannot be changed.");
    return {ok:true,message:await channels.restoreMessage(ctx,id)};
  });
  app.post(prefix+"/messages/:messageId/share",async request=>{
    const ctx=await auth(request,true);requirePermission(ctx,"view_feed_posts");
    if (!await can(ctx,"apps.channels")) throw forbidden("channels_disabled","Channels access is required to share.");
    const id=str((request.params as Obj).messageId),{row}=await authorizedRoot(ctx,id);
    const body=z.object({channel_id:z.string().min(1),text:z.string().max(250000).default("")}).parse(request.body);
    // Sharing uses Channels' server-authored attribution and attachment checks.
    // Only comments can be shared; automated roots contain no artifact snapshots.
    if (!row.parent_id) throw forbidden("feed_share_comment","Share a comment or use the artifact's own sharing controls.");
    return {ok:true,...await channels.postMessage(ctx,body.channel_id,{text:body.text,forwarded_message_id:id})};
  });
}
