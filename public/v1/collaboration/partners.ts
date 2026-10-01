import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { backgroundAuthContext } from "../platform/auth.js";
import { badRequest, forbidden, conflict } from "../platform/errors.js";
import { withDeferredWorkEvents } from "../work/engine.js";
import { storeMediaUpload, readDocument } from "../platform/storage.js";
import { idSchema, grantSchema } from "./schemas.js";
import { actor, currentActor, requirePermission, requireConnection, requireOpen, createGrant, validateOwnedResource, relationshipClassification } from "./service.js";
import { getRecord, findRecord, insertRecord, updateRecord, withOrganizationLocks, audit, now, resourceKey } from "./storage.js";

const operationId=idSchema;
const stableId=(kind:string,org:string,key:string)=>`${kind}_${createHash("sha256").update(`${org}:${key}`).digest("hex")}`;

export async function createEngagement(ctx:PlatformAuthContext,raw:unknown){
  ctx=await currentActor(ctx);requirePermission(ctx,"manage_projects");requirePermission(ctx,"manage_external_connections");requirePermission(ctx,"manage_external_sharing");
  const input=z.object({relationship_id:idSchema,project_id:idSchema,title:z.string().trim().min(1).max(200),description:z.string().max(10000).default(""),payment_terms:z.string().max(2000).default(""),grant:grantSchema.omit({resource:true,recipient_org_id:true,recipient_identity_id:true}),client_operation_id:operationId}).strict().parse(raw);
  const relationship=await getRecord(input.relationship_id,"relationship");
  if(relationship.owner_org_id!==ctx.orgId||await relationshipClassification(relationship)!=="partner")throw forbidden("partner_required","Choose one of your registered partners.");
  if(!relationship.workforce_connection_id)throw conflict("partner_setup_pending","Partner contact setup is still being completed. Try again shortly.");
  const resource={owner_org_id:ctx.orgId,type:"project" as const,id:input.project_id};
  await validateOwnedResource(ctx,resource);
  const {validateDelegatedOperations,validateSharedFields}=await import("./resources.js");
  validateDelegatedOperations(ctx,"project",input.grant.operations);validateSharedFields("project",input.grant.fields);
  return withOrganizationLocks([ctx.orgId,relationship.recipient_org_id],async()=>{
    await requireOpen(ctx.orgId,"send_shares");await requireOpen(relationship.recipient_org_id,"receive_shares");await requireConnection(ctx.orgId,relationship.recipient_org_id);
    const id=stableId("engagement",ctx.orgId,input.client_operation_id),requestHash=createHash("sha256").update(JSON.stringify(input)).digest("hex"),previous=await findRecord(id,"engagement");
    if(previous){if(previous.request_hash!==requestHash)throw conflict("operation_conflict","This request key was already used.");return previous;}
    const result=await insertRecord("engagement",{...input,id,request_hash:requestHash,resource,owner_org_id:ctx.orgId,recipient_org_id:relationship.recipient_org_id,created_by:actor(ctx),created_at:now(),status:"proposed",revision:1,work_resource_ref:{kind:"organization_connection",id:relationship.workforce_connection_id}});
    await audit(result,"collaboration.engagement.proposed",actor(ctx));return result;
  });
}

export async function transitionEngagement(ctx:PlatformAuthContext,id:string,raw:unknown){
  ctx=await currentActor(ctx);requirePermission(ctx,"manage_projects");requirePermission(ctx,"manage_external_connections");
  const input=z.object({expected_revision:z.number().int().positive(),status:z.enum(["accepted","declined","completed","canceled"])}).strict().parse(raw),initial=await getRecord(id,"engagement");
  if(![initial.owner_org_id,initial.recipient_org_id].includes(ctx.orgId))throw forbidden("engagement_unavailable","This engagement is unavailable.");
  return withOrganizationLocks([initial.owner_org_id,initial.recipient_org_id],async()=>{
    const engagement=await getRecord(id,"engagement");
    if(engagement.revision!==input.expected_revision)throw conflict("collaboration_revision_conflict","Reload this engagement before responding.");
    if(["completed","declined","canceled"].includes(engagement.status))throw conflict("engagement_closed","This engagement is closed.");
    if(["accepted","declined"].includes(input.status)&&(ctx.orgId!==engagement.recipient_org_id||engagement.status!=="proposed"))throw forbidden("engagement_recipient_required","Only the receiving organization can accept or decline this proposal.");
    if(input.status==="completed"&&(ctx.orgId!==engagement.owner_org_id||engagement.status!=="accepted"))throw forbidden("engagement_owner_required","The hiring organization completes accepted engagements.");
    let grantId=engagement.grant_id;
    if(input.status==="accepted"){
      const issuer=await backgroundAuthContext(engagement.owner_org_id,engagement.created_by.user_id);
      const grant=await createGrant(issuer,{...engagement.grant,resource:engagement.resource,recipient_org_id:engagement.recipient_org_id});
      await updateRecord(grant,{engagement_id:id},grant.revision);grantId=grant.id;
    }
    if(["completed","canceled"].includes(input.status)&&grantId){
      const grant=await getRecord(grantId,"grant");
      if(grant.engagement_id!==id)throw conflict("engagement_grant_mismatch","The assignment share could not be verified.");
      if(grant.status==="active"){
        const revoked=await updateRecord(grant,{status:"revoked"},grant.revision);
        await audit(revoked,"collaboration.share.revoked",actor(ctx));
      }
    }
    const result=await updateRecord(engagement,{status:input.status,grant_id:grantId||null,responded_by:actor(ctx)},engagement.revision);
    await audit(result,`collaboration.engagement.${input.status}`,actor(ctx));return result;
  });
}

export async function addPartnerDocument(ctx:PlatformAuthContext,raw:unknown){
  ctx=await currentActor(ctx);requirePermission(ctx,"manage_documents");requirePermission(ctx,"manage_external_connections");
  const input=z.object({relationship_id:idSchema,title:z.string().trim().min(1).max(200),category:z.string().max(80).default("Other"),expires_at:z.string().datetime().optional(),file_name:z.string().min(1).max(180),file_base64:z.string().max(16_000_000),client_operation_id:operationId}).strict().parse(raw);
  const relationship=await getRecord(input.relationship_id,"relationship");
  if(relationship.owner_org_id!==ctx.orgId)throw forbidden("relationship_private","This relationship profile is private.");
  const decoded=Buffer.from(input.file_base64,"base64");if(!decoded.length||decoded.length>10_000_000)throw badRequest("document_size","Documents must be under 10 MB.");
  const pdf=decoded.subarray(0,5).toString()==="%PDF-",bytes=pdf?decoded:await sharp(decoded,{limitInputPixels:40_000_000}).rotate().jpeg({quality:90}).toBuffer();
  const hash=createHash("sha256").update(bytes).digest("hex"),id=stableId("partner_document",ctx.orgId,input.client_operation_id);
  return withOrganizationLocks([ctx.orgId],async()=>{
    const prior=await findRecord(id,"partner_document");
    if(prior){if(prior.sha256!==hash||prior.relationship_id!==relationship.id||prior.title!==input.title||prior.category!==input.category||prior.expires_at!==(input.expires_at||null))throw conflict("operation_conflict","This request key was already used.");return prior;}
    const mediaId=`file_${id}`;
    await storeMediaUpload(ctx.orgId,{id:mediaId,ownerType:"organization",ownerId:ctx.orgId,fileName:input.file_name.replace(/\.[^.]*$/,"")+(pdf?".pdf":".jpg"),contentType:pdf?"application/pdf":"image/jpeg",bytes,metadata:{partner_relationship_id:relationship.id,uploaded_by_user_id:ctx.userId}});
    const record=await insertRecord("partner_document",{id,owner_org_id:ctx.orgId,relationship_id:relationship.id,title:input.title,category:input.category,expires_at:input.expires_at||null,media_id:mediaId,sha256:hash,status:"active",revision:1,created_at:now(),created_by:actor(ctx)});
    await audit(record,"collaboration.partner_document.added",actor(ctx));return record;
  });
}


export async function scheduleEngagement(ctx:PlatformAuthContext,id:string,raw:unknown){
  ctx=await currentActor(ctx);requirePermission(ctx,"manage_projects");requirePermission(ctx,"manage_schedule");
  if(!await isCapabilityEnabled(ctx.orgId,"platform.scheduling"))throw forbidden("scheduling_disabled","Scheduling is disabled for your organization.");
  const input=z.object({expected_revision:z.number().int().positive(),start_at:z.string().datetime(),end_at:z.string().datetime(),client_operation_id:operationId}).strict().parse(raw);
  if(Date.parse(input.end_at)<=Date.parse(input.start_at))throw badRequest("schedule_range","The end must follow the start.");
  const initial=await getRecord(id,"engagement");
  if(initial.owner_org_id!==ctx.orgId)throw forbidden("engagement_owner_required","Only the hiring organization can schedule this engagement.");
  return withDeferredWorkEvents(()=>withOrganizationLocks([ctx.orgId,initial.recipient_org_id],async()=>{
    const engagement=await getRecord(id,"engagement");
    if(engagement.status!=="accepted")throw conflict("engagement_not_accepted","The partner must accept before scheduling.");
    await requireConnection(ctx.orgId,engagement.recipient_org_id);await requireOpen(ctx.orgId,"send_shares");await requireOpen(engagement.recipient_org_id,"receive_shares");
    const operation=stableId("engagement_schedule",ctx.orgId,input.client_operation_id),requestHash=createHash("sha256").update(JSON.stringify([id,input])).digest("hex"),prior=await findRecord(operation,"engagement_schedule");
    if(prior){if(prior.request_hash!==requestHash)throw conflict("operation_conflict","This scheduling reference was already used.");return {event_id:prior.event_id};}
    if(engagement.revision!==input.expected_revision)throw conflict("collaboration_revision_conflict","Reload the engagement before scheduling.");
    const project=await readDocument(ctx.orgId,"projects",engagement.resource.id),eventId=operation;
    const existing=(Array.isArray(project.data.events)?project.data.events as any[]:[]).find(e=>e.id===eventId);
    if(existing&&(existing.start_at!==input.start_at||existing.end_at!==input.end_at))throw conflict("operation_conflict","This scheduling reference was already used.");
    if(!existing){
      const {saveProjectScheduleEvent}=await import("../platform/api.js");
      await saveProjectScheduleEvent(ctx.orgId,engagement.resource.id,ctx,{branch_id:project.data.branch_id||"default",expected_event_revision:0,event:{id:eventId,title:engagement.title,kind:"project_work",event_type_default_id:"project_work",start_at:input.start_at,end_at:input.end_at,work_resource_ref:engagement.work_resource_ref,resource_refs:[{...engagement.work_resource_ref,role:"crew"}],collaboration_engagement_id:id}});
    }
    const record=await insertRecord("engagement_schedule",{id:operation,owner_org_id:ctx.orgId,recipient_org_id:engagement.recipient_org_id,resource:engagement.resource,engagement_id:id,event_id:eventId,request_hash:requestHash,status:"active",revision:1,created_at:now()});
    await audit(record,"collaboration.engagement.scheduled",actor(ctx));return {event_id:eventId};
  }));
}
