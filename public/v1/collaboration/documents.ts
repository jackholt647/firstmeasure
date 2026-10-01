import { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";
import { forbidden, notFound } from "../platform/errors.js";
import { readMediaFile } from "../platform/storage.js";
import { readDocumentInstance, readDocumentSnapshot } from "../documents/storage.js";
import { recordDocumentOutput } from "../documents/service.js";
import { packagesForDocument } from "../documents/signing/store.js";
import { prepareSigning, acceptSigning, signingPdf, drainSigningOutbox, type SigningAccess } from "../documents/signing/service.js";
import { type ResourceRef, idSchema } from "./schemas.js";
import { withSharedAccess, requirePermission, actor } from "./service.js";
import { audit } from "./storage.js";

const selectionSchema=z.object({snapshot_id:idSchema,signer_id:idSchema}).strict();
type Selection=z.infer<typeof selectionSchema>;

function selectedSnapshot(resource:ResourceRef,grants:Record<string,any>[],snapshot:string){
  if(resource.type!=="document"||!grants.some(g=>g.child_ids.includes(snapshot)))throw forbidden("document_snapshot_not_shared","This document revision is not shared.");
}
const responseTypes=["text","string","number","boolean","checkbox","date","select"];
export async function sharedDocumentInfo(ctx:PlatformAuthContext,resource:ResourceRef){
  return withSharedAccess(ctx,resource,"documents.read",async decision=>{
    requirePermission(decision.ctx,"view_documents");
    if(resource.type!=="document")throw forbidden("document_required","Choose a document.");
    const document=await readDocumentInstance(resource.owner_org_id,resource.id);
    const snapshots=[...new Set(decision.grants.flatMap(g=>g.child_ids))] as string[];
    const readable=[];
    for(const id of snapshots){const snapshot=await readDocumentSnapshot(resource.owner_org_id,id).catch(()=>null);if(snapshot?.document_id===resource.id)readable.push({id,label:`Revision ${snapshot.snapshot_number||id}`});}
    const metadata=ctx.identity.metadata as Record<string,any>||{},verified=metadata.email_verified===true||metadata.signup_email_verification?.verified===true;
    const packages=await packagesForDocument(resource.owner_org_id,resource.id);
    const signers=verified?packages.filter(p=>p.status==="open"&&snapshots.includes(p.snapshot_id)&&p.snapshot_id===(document.delivery as any)?.current_snapshot_id).flatMap(p=>p.signers.filter(s=>!s.user_id&&s.email.toLowerCase()===String(ctx.identity.email).toLowerCase()).map(s=>({snapshot_id:p.snapshot_id,signer_id:s.id,fields:s.fields}))):[];
    const {authorizeShared}=await import("./service.js");
    let writable:string[]=[];
    try{const write=await authorizeShared(ctx,resource,"documents.respond");writable=[...new Set(write.grants.flatMap(g=>g.response_fields||[]))] as string[];}catch(e:any){if(e.statusCode!==403)throw e;}
    const defs=(document.output_defs||{}) as Record<string,any>;
    const responses=writable.filter(key=>responseTypes.includes(defs[key]?.type)&&!['company','internal'].includes(defs[key]?.party||defs[key]?.signer)).map(key=>({key,type:defs[key].type,label:String(defs[key].label||key)}));
    return {snapshots:readable,signers,responses,current_snapshot_id:snapshots.includes(String((document.delivery as any)?.current_snapshot_id))?(document.delivery as any).current_snapshot_id:null};
  });
}

export async function respondToSharedDocument(ctx:PlatformAuthContext,resource:ResourceRef,raw:unknown,requestAudit:Record<string,unknown>){
  const input=z.object({snapshot_id:idSchema,field:idSchema,value:z.union([z.string().max(20000),z.number().finite(),z.boolean()])}).strict().parse(raw);
  return withSharedAccess(ctx,resource,"documents.respond",async decision=>{
    requirePermission(decision.ctx,"manage_documents");
    const applicable=decision.grants.filter(g=>(g.response_fields||[]).includes(input.field));
    selectedSnapshot(resource,applicable,input.snapshot_id);
    const document=await readDocumentInstance(resource.owner_org_id,resource.id),def=(document.output_defs as any)?.[input.field];
    if(!def||!responseTypes.includes(def.type)||['company','internal'].includes(def.party||def.signer))throw forbidden("document_response_private","This response field is not externally editable.");
    const expected=["boolean","checkbox"].includes(def.type)?"boolean":def.type==="number"?"number":"string";
    if(typeof input.value!==expected)throw forbidden("document_response_type","Use the declared type for this response.");
    if((document.outputs as any)?.[input.field]===input.value)return {status:document.status};
    const result=await recordDocumentOutput(resource.owner_org_id,resource.id,input.field,{value:input.value,evidence:{collaboration_actor:actor(decision.ctx)}},requestAudit,decision.ctx,{snapshotId:input.snapshot_id,surface:"public"});
    await audit(applicable[0]!,"collaboration.document.responded",actor(decision.ctx),{snapshot_id:input.snapshot_id,field:input.field});
    return {status:result.status};
  });
}

/** Shares name issued immutable snapshots explicitly. Future document revisions
 * never inherit access, even when other project content includes future items. */
export async function sharedDocumentPdf(ctx:PlatformAuthContext,resource:ResourceRef,snapshotId:string){
  return withSharedAccess(ctx,resource,"documents.read",async decision=>{
    requirePermission(decision.ctx,"view_documents");
    selectedSnapshot(resource,decision.grants,snapshotId);
    const snapshot=await readDocumentSnapshot(resource.owner_org_id,snapshotId);
    if(snapshot.document_id!==resource.id)throw forbidden("document_snapshot_mismatch","This revision belongs to another document.");
    const retained=await signingPdf(resource.owner_org_id,snapshotId);
    if(retained)return retained;
    const mediaId=String((snapshot.pdf as any)?.media_id||"");
    if(!mediaId)throw notFound("document_pdf_unavailable","The owner must prepare this revision's PDF before sharing it.");
    const file=await readMediaFile(resource.owner_org_id,mediaId);
    if(file.contentType!=="application/pdf")throw forbidden("document_pdf_invalid","The retained artifact is not a PDF.");
    return file;
  });
}

async function signingAccess(ctx:PlatformAuthContext,resource:ResourceRef,selection:Selection):Promise<SigningAccess>{
  requirePermission(ctx,"sign_documents");
  const metadata=ctx.identity.metadata as Record<string,any>||{};
  if(!(metadata.email_verified===true||metadata.signup_email_verification?.verified===true))throw forbidden("signature_verified_email_required","Verify your account email before signing.");
  const document=await readDocumentInstance(resource.owner_org_id,resource.id);
  if((document.delivery as any)?.current_snapshot_id!==selection.snapshot_id)throw forbidden("document_revision_superseded","Use the currently issued document revision.");
  const pkg=(await packagesForDocument(resource.owner_org_id,resource.id)).find(p=>p.snapshot_id===selection.snapshot_id&&["open","completed"].includes(p.status));
  const signer=pkg?.signers.find(s=>s.id===selection.signer_id&&!s.user_id&&s.email.toLowerCase()===String(ctx.identity.email).toLowerCase());
  if(!pkg||!signer)throw forbidden("signature_assignment","This signer role is not assigned to your verified account email.");
  return {pkg,signer,authentication:"firstmate_external_verified_session",userId:`external_${ctx.orgId}_${ctx.userId}`};
}

export async function prepareSharedSignature(ctx:PlatformAuthContext,resource:ResourceRef,raw:unknown){
  const selection=selectionSchema.parse(raw);
  return withSharedAccess(ctx,resource,"documents.respond",async decision=>{
    selectedSnapshot(resource,decision.grants,selection.snapshot_id);
    // A signing challenge is issued only when the recipient can also retain its review copy.
    const {authorizeShared}=await import("./service.js");
    const readable=await authorizeShared(ctx,resource,"documents.read");
    selectedSnapshot(resource,readable.grants,selection.snapshot_id);
    const access=await signingAccess(decision.ctx,resource,selection),result=await prepareSigning(access);
    return {...result,receipts:Object.fromEntries(Object.entries(result.receipts).filter(([field])=>access.signer.fields.includes(field)))};
  });
}

export async function acceptSharedSignature(ctx:PlatformAuthContext,resource:ResourceRef,raw:unknown,requestAudit:Record<string,unknown>){
  const input=selectionSchema.extend({field:idSchema,value:z.record(z.unknown()),content_hash:z.string().max(128),challenge:z.string().max(128),consent:z.record(z.unknown())}).strict().parse(raw);
  const receipt=await withSharedAccess(ctx,resource,"documents.respond",async decision=>{
    selectedSnapshot(resource,decision.grants,input.snapshot_id);
    const {authorizeShared}=await import("./service.js");
    const readable=await authorizeShared(ctx,resource,"documents.read");
    selectedSnapshot(resource,readable.grants,input.snapshot_id);
    const access=await signingAccess(decision.ctx,resource,input);
    const result=await acceptSigning(access,input.field,input,requestAudit,{deferOutbox:true});
    await audit(decision.grants[0]!,"collaboration.document.signed",actor(decision.ctx),{snapshot_id:input.snapshot_id,receipt_id:result.receipt.receipt_id});
    return {receipt:result.receipt,duplicate:result.duplicate};
  });
  // Delivery may emit workflows and mail. It must run after the authorization
  // and signature transaction has committed; the durable signing worker retries.
  await drainSigningOutbox().catch(()=>undefined);
  return receipt;
}
