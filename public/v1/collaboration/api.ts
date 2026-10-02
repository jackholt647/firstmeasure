import * as assignments from "./assignments.js";
import type { FastifyPluginAsync } from "fastify";
import { z, ZodError } from "zod";
import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError, forbidden } from "../platform/errors.js";
import { resourceSchema, pageSchema, revisionSchema } from "./schemas.js";
import * as service from "./service.js";
import * as resources from "./resources.js";
import * as documents from "./documents.js";
import * as partners from "./partners.js";
import * as payments from "./payments.js";
import * as work from "./work.js";
import { listRecords, listGrants, getRecord } from "./storage.js";
import { registerCollaborationEvents, drainCollaborationEvents } from "./events.js";

export const registerCollaborationApi:FastifyPluginAsync=async app=>{
  // Domain audit actors are retained server-side. Cross-org response envelopes
  // must not expose global identity IDs or private organization user references.
  const privateKeys=new Set(["created_by","accepted_by","responded_by","request_hash","recipient_identity_id"]);
  const publicEnvelope=(value:any):any=>Array.isArray(value)?value.map(publicEnvelope):value&&typeof value==="object"&&!Buffer.isBuffer(value)?Object.fromEntries(Object.entries(value).filter(([key])=>!privateKeys.has(key)).map(([key,entry])=>[key,publicEnvelope(entry)])):value;
  app.addHook("preSerialization",async(_request,_reply,payload)=>publicEnvelope(payload));
  registerCollaborationEvents();
  if(process.env.NODE_ENV!=="test"&&process.env.PLATFORM_HEARTBEAT_DISABLED!=="1"&&(!process.env.PLATFORM_PROCESS_ROLE||process.env.PLATFORM_PROCESS_ROLE==="worker")){
    let pending:Promise<void>|null=null;
    const timer=setInterval(()=>{if(!pending)pending=drainCollaborationEvents().then(()=>payments.reconcilePartnerPayments()).then(()=>service.repairCollaborationContacts()).catch(error=>app.log.error(error)).finally(()=>{pending=null;});},15000);
    timer.unref();
    app.addHook("onClose",async()=>{clearInterval(timer);await pending;});
  }
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof ZodError)return reply.code(400).send({ok:false,error:"validation_error",issues:error.issues});
    if(error instanceof PlatformError)return reply.code(error.statusCode).send({ok:false,error:error.code,message:error.message});
    app.log.error(error);return reply.code(500).send({ok:false,error:"internal_error",message:"The collaboration request could not be completed."});
  });
  const auth=async(request:any,permission:string,write=false)=>{
    const ctx=await requirePlatformAuth(request,{orgId:request.params.orgId,csrf:write});
    service.requirePermission(ctx,permission);return ctx;
  };
  const base="/organizations/:orgId";
  app.get(base+"/shares/:id/audience",async req=>{
    const ctx=await auth(req,"manage_external_connections"),grant=await getRecord((req.params as any).id,"grant");
    if(grant.recipient_org_id!==ctx.orgId)throw forbidden("share_recipient_required","This audience belongs to the receiving organization.");
    const {findRecord}=await import("./storage.js"),{listDocuments}=await import("../platform/storage.js");
    const value=await findRecord(`audience_${grant.id}`,"audience");
    return {ok:true,revision:value?.revision||0,audience:value?.audience||{mode:"members",user_ids:[]},users:(await listDocuments(ctx.orgId,"users")).filter(u=>u.data.status==="active").map(u=>({id:u.id,name:String(u.data.name||u.data.email||u.id)}))};
  });
  app.put(base+"/shares/:id/audience",async req=>{
    const ctx=await auth(req,"manage_external_connections",true),body=z.object({audience:z.unknown(),expected_revision:z.number().int().min(0)}).strict().parse(req.body);
    return {ok:true,record:await service.saveRecipientAudience(ctx,(req.params as any).id,body.audience,body.expected_revision)};
  });
  app.get(base+"/payments",async req=>{const ctx=await auth(req,"manage_partner_payments"),p=pageSchema.parse(req.query);return {ok:true,...await listRecords("partner_checkout",ctx.orgId,"both",p.after,p.limit)};});
  app.get(base+"/offline-payments",async req=>{const ctx=await auth(req,"manage_partner_payments"),p=pageSchema.parse(req.query);return {ok:true,...await listRecords("partner_payment",ctx.orgId,"outbound",p.after,p.limit)};});
  app.get(base+"/offline-payments/:id/receipt",async(req,reply)=>{
    const ctx=await auth(req,"manage_partner_payments"),record=await getRecord((req.params as any).id,"partner_payment");
    if(record.owner_org_id!==ctx.orgId||!record.receipt_media_id)throw forbidden("receipt_private","This evidence is not available.");
    const {readMediaFile,readMediaMetadata}=await import("../platform/storage.js"),media=await readMediaMetadata(ctx.orgId,record.receipt_media_id);
    if((media.metadata as any)?.collaboration_payment_id!==record.id){
      service.requirePermission(ctx,"view_media");const {canReadReceiptMedia}=await import("../platform/media_access.js");
      if(!canReadReceiptMedia(media,ctx))throw forbidden("receipt_private","This evidence is not available.");
      if((media.metadata as any)?.partner_relationship_id)service.requirePermission(ctx,"view_documents");
    }
    const file=await readMediaFile(ctx.orgId,record.receipt_media_id);
    return reply.header("Cache-Control","private, no-store").header("X-Content-Type-Options","nosniff").header("Content-Security-Policy","sandbox").header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`).type(file.contentType).send(file.bytes);
  });
  app.post(base+"/resources/checkout",async req=>{const ctx=await auth(req,"manage_partner_payments");return {ok:true,...await payments.partnerCheckout(ctx,resourceSchema.parse(req.body))};});
  app.post(base+"/resources/payment-quote",async req=>{const ctx=await auth(req,"manage_partner_payments");const b=z.object({resource:resourceSchema,method:z.enum(["card","bank"])}).strict().parse(req.body);return {ok:true,...await payments.partnerPaymentQuote(ctx,b.resource,b.method)};});
  app.post(base+"/resources/payment-method",{config:{rateLimit:{max:10,timeWindow:"1 minute"}}},async req=>{const ctx=await auth(req,"manage_partner_payments",true);const b=z.object({resource:resourceSchema,input:z.unknown()}).strict().parse(req.body);return {ok:true,...await payments.partnerPaymentMethod(ctx,b.resource,b.input)};});
  app.post(base+"/resources/pay",async req=>{const ctx=await auth(req,"manage_partner_payments",true);const b=z.object({resource:resourceSchema,input:z.unknown()}).strict().parse(req.body);return {ok:true,payment:await payments.payPartnerInvoice(ctx,b.resource,b.input)};});
  app.post(base+"/resources/offline-payment",{bodyLimit:13_000_000},async req=>{const ctx=await auth(req,"manage_partner_payments",true);const b=z.object({resource:resourceSchema,input:z.unknown()}).strict().parse(req.body);return {ok:true,payment:await payments.recordOfflinePartnerPayment(ctx,b.resource,b.input)};});
  app.get(base+"/engagements",async req=>{const ctx=await auth(req,"view_partners"),p=pageSchema.parse(req.query);return {ok:true,...await listRecords("engagement",ctx.orgId,"both",p.after,p.limit)};});
  app.post(base+"/engagements/:id/schedule",async req=>{const ctx=await auth(req,"manage_projects",true);return {ok:true,...await partners.scheduleEngagement(ctx,(req.params as any).id,req.body)};});
  app.post(base+"/engagements",async req=>{const ctx=await auth(req,"manage_projects",true);return {ok:true,engagement:await partners.createEngagement(ctx,req.body)};});
  app.patch(base+"/engagements/:id",async req=>{const ctx=await auth(req,"manage_projects",true);return {ok:true,engagement:await partners.transitionEngagement(ctx,(req.params as any).id,req.body)};});
  app.get(base+"/partner-documents",async req=>{const ctx=await auth(req,"view_partners");service.requirePermission(ctx,"view_documents");const p=pageSchema.parse(req.query);return {ok:true,...await listRecords("partner_document",ctx.orgId,"outbound",p.after,p.limit)};});
  app.post(base+"/partner-documents",{bodyLimit:17_000_000},async req=>{const ctx=await auth(req,"manage_documents",true);return {ok:true,document:await partners.addPartnerDocument(ctx,req.body)};});
  app.get(base+"/partner-documents/:id/file",async(req,reply)=>{
    const ctx=await auth(req,"view_partners");service.requirePermission(ctx,"view_documents");
    const record=await getRecord((req.params as any).id,"partner_document");
    if(record.owner_org_id!==ctx.orgId)throw forbidden("partner_document_private","This document is private.");
    const {readMediaFile}=await import("../platform/storage.js"),file=await readMediaFile(ctx.orgId,record.media_id);
    return reply.header("Cache-Control","private, no-store").header("X-Content-Type-Options","nosniff").header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`).type(file.contentType).send(file.bytes);
  });
  app.get(base+"/sharing-options",async req=>{const ctx=await auth(req,"manage_external_sharing"),p=z.object({type:resourceSchema.shape.type,after:z.string().max(365).default(""),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(req.query);return {ok:true,...await resources.sharingOptions(ctx,p.type,p.after,p.limit)};});
  app.post(base+"/resources/share-children",async req=>{
    const ctx=await auth(req,"manage_external_sharing"),resource=resourceSchema.parse(req.body);
    await service.validateOwnedResource(ctx,resource);
    if(resource.type==="document"){
      const {listDocumentSnapshots}=await import("../documents/storage.js");
      const {readDocumentInstance}=await import("../documents/storage.js");
      const document=await readDocumentInstance(ctx.orgId,resource.id);
      const response_fields=Object.entries(document.output_defs||{}).filter(([,def]:[string,any])=>["text","string","number","boolean","checkbox","date","select"].includes(def.type)&&!["company","internal"].includes(def.party||def.signer)).map(([key,def]:[string,any])=>({key,label:String(def.label||key)}));
      return {ok:true,response_fields,items:(await listDocumentSnapshots(ctx.orgId,resource.id)).map(s=>({id:s.id,label:`Revision ${s.snapshot_number||s.id} · ${s.created_at||""}`}))};
    }
    if(resource.type==="project"){
      const {readDocument,listMedia}=await import("../platform/storage.js"),{listNodeRecords}=await import("../work/storage.js"),{isReceiptMedia}=await import("../platform/media_access.js");
      const project=await readDocument(ctx.orgId,"projects",resource.id),items:{id:string,label:string}[]=[];
      let canViewMedia=true;try{service.requirePermission(ctx,"view_media");}catch{canViewMedia=false;}
      for(const media of canViewMedia?await listMedia(ctx.orgId):[])if((media.owner as any)?.type==="project"&&(media.owner as any)?.id===resource.id&&String(media.content_type).startsWith("image/")&&!isReceiptMedia(media))items.push({id:String(media.id),label:`Photo: ${media.file_name||media.id}`});
      for(const event of Array.isArray(project.data.events)?project.data.events as any[]:[])items.push({id:String(event.id),label:`Schedule: ${event.title||event.name||event.id}`});
      for(const node of await listNodeRecords(ctx.orgId,{project_id:resource.id}))items.push({id:String(node.id),label:`Work: ${node.title}`});
      return {ok:true,items};
    }
    return {ok:true,items:[]};
  });
  app.get(base+"/privacy",async req=>{const ctx=await auth(req,"use_external_shares");return {ok:true,...await service.privacy(ctx.orgId)};});
  app.put(base+"/privacy",async req=>{const ctx=await auth(req,"manage_external_privacy",true);const body=z.object({policy:z.unknown(),expected_revision:z.number().int().min(0)}).strict().parse(req.body);return {ok:true,record:await service.savePrivacy(ctx,body.policy,body.expected_revision)};});
  app.get(base+"/engagements/:id/assignment-options",async req=>{const ctx=await auth(req,"manage_schedule");return {ok:true,...await partners.engagementAssignmentOptions(ctx,(req.params as any).id)};});
  app.get(base+"/partners/:id/assignments",async req=>{const ctx=await auth(req,"manage_external_connections");return {ok:true,...await assignments.assignmentSettings(ctx,(req.params as any).id)};});
  app.put(base+"/partners/:id/assignments",async req=>{const ctx=await auth(req,"manage_external_connections",true);return {ok:true,settings:await assignments.saveAssignmentSettings(ctx,(req.params as any).id,req.body)};});
  app.get(base+"/partners",async req=>{const ctx=await auth(req,"view_partners"),p=pageSchema.parse(req.query);return {ok:true,...await service.listRelationships(ctx,p.after,p.limit)};});
  app.patch(base+"/partners/:id",async req=>{const ctx=await auth(req,"manage_external_connections",true);return {ok:true,relationship:await service.updateRelationship(ctx,(req.params as any).id,req.body)};});
  app.get(base+"/invitations",async req=>{const ctx=await auth(req,"manage_external_connections"),p=pageSchema.parse(req.query);return {ok:true,...await listRecords("invitation",ctx.orgId,"both",p.after,p.limit)};});
  app.post(base+"/invitations",async req=>{const ctx=await auth(req,"manage_external_connections",true);return {ok:true,...await service.createInvitation(ctx,req.body)};});
  app.post(base+"/invitations/preview",async req=>{const ctx=await auth(req,"use_external_shares");const {token}=z.object({token:z.string().max(100)}).strict().parse(req.body);return {ok:true,...await service.previewInvitation(ctx,token)};});
  app.post(base+"/invitations/accept",async req=>{const ctx=await auth(req,"use_external_shares",true);const {token}=z.object({token:z.string().max(100)}).strict().parse(req.body);return {ok:true,...await service.acceptInvitation(ctx,token)};});
  app.post(base+"/invitations/:id/approve",async req=>{const ctx=await auth(req,"manage_external_connections",true);const body=revisionSchema.parse(req.body);return {ok:true,...await service.approveInvitation(ctx,(req.params as any).id,body.expected_revision)};});
  app.post(base+"/invitations/:id/revoke",async req=>{const ctx=await auth(req,"manage_external_connections",true);const body=revisionSchema.parse(req.body);return {ok:true,invitation:await service.revokeInvitation(ctx,(req.params as any).id,body.expected_revision)};});
  app.patch(base+"/connections/:id",async req=>{const ctx=await auth(req,"manage_external_connections",true);const body=z.object({expected_revision:z.number().int().positive(),status:z.enum(["active","suspended","blocked","ended"])}).strict().parse(req.body);return {ok:true,connection:await service.setConnectionStatus(ctx,(req.params as any).id,body.status,body.expected_revision)};});
  app.get(base+"/shares",async req=>{
    const ctx=await auth(req,"manage_external_sharing"),p=pageSchema.extend({type:resourceSchema.shape.type.optional(),recipient:z.string().max(180).optional()}).parse(req.query);
    const page=await listGrants(ctx.orgId,"outbound",p.after,p.limit,p.type,p.recipient);
    for(const grant of page.items)grant.recipient=await service.organizationProfile(grant.recipient_org_id);
    return {ok:true,...page};
  });
  app.post(base+"/shares",async req=>{const ctx=await auth(req,"manage_external_sharing",true);return {ok:true,share:await service.createGrant(ctx,req.body)};});
  app.post(base+"/shares/:id/revoke",async req=>{const ctx=await auth(req,"manage_external_sharing",true);const body=revisionSchema.parse(req.body);return {ok:true,share:await service.revokeGrant(ctx,(req.params as any).id,body.expected_revision)};});
  app.get(base+"/shared",async req=>{const ctx=await auth(req,"use_external_shares"),p=pageSchema.extend({type:resourceSchema.shape.type.optional(),owner:z.string().max(180).optional()}).parse(req.query);return {ok:true,...await resources.sharedResources(ctx,p.after,p.limit,p.type,p.owner)};});
  app.post(base+"/resources/read",async req=>{const ctx=await auth(req,"use_external_shares");return {ok:true,...await resources.readSharedResource(ctx,resourceSchema.parse(req.body))};});
  app.post(base+"/resources/work",async req=>{const ctx=await auth(req,"use_external_shares");return {ok:true,...await work.sharedWork(ctx,resourceSchema.parse(req.body))};});
  app.patch(base+"/resources/work",async req=>{const ctx=await auth(req,"use_external_shares",true);const b=z.object({resource:resourceSchema,input:z.unknown()}).strict().parse(req.body);return {ok:true,...await work.updateSharedWork(ctx,b.resource,b.input)};});
  app.post(base+"/resources/schedule",async req=>{const ctx=await auth(req,"use_external_shares");return {ok:true,...await work.sharedSchedule(ctx,resourceSchema.parse(req.body))};});
  app.patch(base+"/resources/schedule",async req=>{const ctx=await auth(req,"use_external_shares",true);const b=z.object({resource:resourceSchema,input:z.unknown()}).strict().parse(req.body);return {ok:true,...await work.rescheduleSharedEvent(ctx,b.resource,b.input)};});
  app.post(base+"/resources/signatures/prepare",async req=>{const ctx=await auth(req,"use_external_shares",true);const b=z.object({resource:resourceSchema,input:z.unknown()}).strict().parse(req.body);return {ok:true,...await documents.prepareSharedSignature(ctx,b.resource,b.input)};});
  app.post(base+"/resources/document",async req=>{const ctx=await auth(req,"use_external_shares");return {ok:true,...await documents.sharedDocumentInfo(ctx,resourceSchema.parse(req.body))};});
  app.post(base+"/resources/document/respond",async req=>{const ctx=await auth(req,"use_external_shares",true);const b=z.object({resource:resourceSchema,input:z.unknown()}).strict().parse(req.body);return {ok:true,...await documents.respondToSharedDocument(ctx,b.resource,b.input,{ip_address:req.ip,user_agent:req.headers["user-agent"],request_id:req.id})};});
  app.post(base+"/resources/signatures/accept",async req=>{const ctx=await auth(req,"use_external_shares",true);const b=z.object({resource:resourceSchema,input:z.unknown()}).strict().parse(req.body);return {ok:true,...await documents.acceptSharedSignature(ctx,b.resource,b.input,{ip_address:req.ip,user_agent:req.headers["user-agent"],request_id:req.id})};});
  app.get(base+"/shares/:id/documents/:snapshotId/pdf",async(req,reply)=>{
    const ctx=await auth(req,"use_external_shares"),params=req.params as any,grant=await getRecord(params.id,"grant");
    const file=await documents.sharedDocumentPdf(ctx,grant.resource,params.snapshotId);
    return reply.header("Cache-Control","private, no-store").header("X-Content-Type-Options","nosniff").header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`).type("application/pdf").send(file.bytes);
  });
  app.patch(base+"/resources/details",async req=>{const ctx=await auth(req,"use_external_shares",true);const b=z.object({resource:resourceSchema,input:z.unknown()}).strict().parse(req.body);return {ok:true,...await resources.updateSharedDetails(ctx,b.resource,b.input)};});
  app.post(base+"/resources/photos",async req=>{const ctx=await auth(req,"use_external_shares");return {ok:true,...await resources.sharedPhotos(ctx,resourceSchema.parse(req.body))};});
  app.post(base+"/resources/photos/upload",{bodyLimit:13_000_000},async req=>{const ctx=await auth(req,"use_external_shares",true);const b=z.object({resource:resourceSchema,input:z.unknown()}).strict().parse(req.body);return {ok:true,...await resources.uploadSharedPhoto(ctx,b.resource,b.input)};});
  app.post(base+"/resources/notes/read",async req=>{const ctx=await auth(req,"use_external_shares");return {ok:true,...await resources.sharedNotes(ctx,resourceSchema.parse(req.body))};});
  app.post(base+"/resources/notes",async req=>{const ctx=await auth(req,"use_external_shares",true);const b=z.object({resource:resourceSchema,input:z.unknown()}).strict().parse(req.body);return {ok:true,...await resources.createSharedNote(ctx,b.resource,b.input)};});
  app.get(base+"/shares/:id/files/:mediaId",async(req,reply)=>{
    const ctx=await auth(req,"use_external_shares"),params=req.params as any,g=await getRecord(params.id,"grant");
    const file=await resources.sharedFile(ctx,g.resource,params.mediaId);
    reply.header("Cache-Control","private, no-store").header("X-Content-Type-Options","nosniff").header("Content-Security-Policy","sandbox").header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`);
    return reply.type(file.contentType).send(file.bytes);
  });
  app.post(base+"/resources/messages/read",async req=>{const ctx=await auth(req,"use_external_shares");const b=z.object({resource:resourceSchema,after:z.number().int().min(0).default(0)}).strict().parse(req.body);return {ok:true,...await resources.sharedMessages(ctx,b.resource,b.after)};});
  app.post(base+"/resources/messages",async req=>{const ctx=await auth(req,"use_external_shares",true);const b=z.object({resource:resourceSchema,input:z.unknown()}).strict().parse(req.body);return {ok:true,...await resources.postSharedMessage(ctx,b.resource,b.input)};});
};
