import { createHash } from "node:crypto";
import sharp from "sharp";
import { z } from "zod";
import { backgroundAuthContext, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest, forbidden, conflict } from "../platform/errors.js";
import { readInvoice } from "../payments/invoices.js";
import { withDeferredWorkEvents } from "../work/engine.js";
import { getPaymentProvider } from "../payments/providers/index.js";
import { createPayment } from "../payments/storage.js";
import { paymentIntakeConfig, resolveIntakeProvider, tokenizePaymentMethod, surchargeQuote, removeProviderShadowRecord } from "../payments/intake.js";
import { readMediaMetadata, storeMediaUpload } from "../platform/storage.js";
import { canReadReceiptMedia } from "../platform/media_access.js";
import { type ResourceRef, idSchema } from "./schemas.js";
import { actor, requirePermission, withSharedAccess } from "./service.js";
import { collaborationStore, findRecord, getRecord, insertRecord, updateRecord, audit, now, resourceKey, withOrganizationLocks } from "./storage.js";

const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
const paymentView=(r:Record<string,any>)=>({id:r.id,status:r.status,amount_cents:r.amount_cents,currency:r.currency,created_at:r.created_at,payment_id:r.payment_id||null});
function invoiceResource(resource:ResourceRef){if(resource.type!=="invoice")throw badRequest("invoice_required","Choose an invoice.");}
async function merchant(org:string){
  const result=await resolveIntakeProvider(org);
  if(!result.provider||!result.config||result.config.forward.boarding_status!=="APPROVED"||!result.config.forward.processing_enabled)throw forbidden("partner_payments_unavailable","This organization is not currently approved to receive platform payments. You can record an external payment instead.");
  return result;
}
function requireRail(config:any,method:string){
  const rail=method==="ach"?"bank":method;
  if(config?.forward?.enabled_rails?.[rail]!==true)throw forbidden("payment_rail_disabled","This payment method is not enabled by the receiving organization.");
}

export async function partnerCheckout(ctx:PlatformAuthContext,resource:ResourceRef){
  invoiceResource(resource);
  return withSharedAccess(ctx,resource,"invoice.pay",async decision=>{
    requirePermission(decision.ctx,"manage_partner_payments");
    const invoice=await readInvoice(resource.owner_org_id,resource.id);
    let available=false,config:any=null;
    try{await merchant(resource.owner_org_id);available=true;config=await paymentIntakeConfig(resource.owner_org_id,"",String(invoice.branch_id||"default"));}
    catch(e:any){if(e.code!=="partner_payments_unavailable")throw e;}
    return {invoice:{id:resource.id,invoice_number:invoice.invoice_number,amount_cents:invoice.balance_due_cents,currency:invoice.currency,status:invoice.status},online_available:available,tokenization:config?.tokenization||null};
  });
}

export async function partnerPaymentMethod(ctx:PlatformAuthContext,resource:ResourceRef,raw:unknown){
  invoiceResource(resource);
  return withSharedAccess(ctx,resource,"invoice.pay",async decision=>{
    requirePermission(decision.ctx,"manage_partner_payments");const {provider,config}=await merchant(resource.owner_org_id);
    // Real card data remains in provider-hosted fields. The simulator alone accepts test card fields.
    const input=provider!.provider==="mock"?z.object({type:z.enum(["card","bank","ach"]),card:z.record(z.unknown()).optional(),bank:z.record(z.unknown()).optional()}).strict().parse(raw):z.object({type:z.enum(["card","bank","ach"])}).strict().parse(raw);
    requireRail(config,input.type);return tokenizePaymentMethod(resource.owner_org_id,provider!,input);
  });
}

export async function partnerPaymentQuote(ctx:PlatformAuthContext,resource:ResourceRef,method:"card"|"bank"){
  invoiceResource(resource);
  return withSharedAccess(ctx,resource,"invoice.pay",async decision=>{
    requirePermission(decision.ctx,"manage_partner_payments");const {provider,config}=await merchant(resource.owner_org_id),invoice=await readInvoice(resource.owner_org_id,resource.id);
    requireRail(config,method);
    if(!["due","overdue","partially_paid"].includes(String(invoice.status))||Number(invoice.balance_due_cents)<=0)throw conflict("invoice_not_payable","This invoice is not open for payment.");
    const quote=await surchargeQuote(resource.owner_org_id,provider!,{amount_cents:Number(invoice.balance_due_cents),method,branch_id:String(invoice.branch_id||"default")});
    return {...quote,currency:invoice.currency,invoice_revision:invoice.revision};
  });
}

export async function recordOfflinePartnerPayment(ctx:PlatformAuthContext,resource:ResourceRef,raw:unknown){
  invoiceResource(resource);
  const input=z.object({amount_cents:z.number().int().positive().max(100000000),method:z.enum(["check","cash","bank_transfer","other"]),paid_at:z.string().datetime(),note:z.string().max(2000).default(""),receipt_media_id:idSchema.optional(),receipt_file:z.object({name:z.string().min(1).max(180),base64:z.string().max(12_000_000)}).strict().optional(),client_operation_id:idSchema}).strict().parse(raw);
  return withSharedAccess(ctx,resource,"invoice.read",async decision=>{
    requirePermission(decision.ctx,"manage_partner_payments");
    const invoice=await readInvoice(resource.owner_org_id,resource.id);
    if(input.receipt_media_id){requirePermission(decision.ctx,"view_media");const media=await readMediaMetadata(ctx.orgId,input.receipt_media_id);if(!canReadReceiptMedia(media,decision.ctx))throw forbidden("receipt_private","This evidence is not available.");if((media.metadata as any)?.partner_relationship_id)requirePermission(decision.ctx,"view_documents");}
    const id=`offline_payment_${hash(`${ctx.orgId}:${resourceKey(resource)}:${input.client_operation_id}`)}`,requestHash=hash(JSON.stringify(input)),prior=await findRecord(id,"partner_payment");
    if(prior){if(prior.request_hash!==requestHash)throw conflict("operation_conflict","This payment reference was already used.");return prior;}
    const {receipt_file,...savedInput}=input;
    if(receipt_file){
      const decoded=Buffer.from(receipt_file.base64,"base64");if(!decoded.length||decoded.length>8_000_000)throw badRequest("receipt_size","Receipt evidence must be under 8 MB.");
      const pdf=decoded.subarray(0,5).toString()==="%PDF-",bytes=pdf?decoded:await sharp(decoded,{limitInputPixels:40_000_000}).rotate().jpeg({quality:90}).toBuffer();
      savedInput.receipt_media_id=`receipt_${id}`;
      await storeMediaUpload(ctx.orgId,{id:savedInput.receipt_media_id,ownerType:"organization",ownerId:ctx.orgId,slot:"receipts",fileName:receipt_file.name.replace(/\.[^.]*$/,"")+(pdf?".pdf":".jpg"),contentType:pdf?"application/pdf":"image/jpeg",bytes,metadata:{document_type:"receipt",uploaded_by_user_id:ctx.userId,collaboration_payment_id:id}});
    }
    const result=await insertRecord("partner_payment",{...savedInput,id,resource,owner_org_id:ctx.orgId,recipient_org_id:"",payee_org_id:resource.owner_org_id,currency:invoice.currency,request_hash:requestHash,status:"reported_paid",revision:1,created_at:now(),created_by:actor(ctx)});
    // This is the payer's reconciliation record; it cannot settle the issuer's receivable.
    await audit(result,"collaboration.payment.reported",actor(ctx));return result;
  });
}

export async function payPartnerInvoice(ctx:PlatformAuthContext,resource:ResourceRef,raw:unknown){
  invoiceResource(resource);
  const input=z.object({client_operation_id:idSchema,payment_method_id:z.string().min(1).max(200),method:z.enum(["card","bank"]),expected_total_cents:z.number().int().positive(),expected_invoice_revision:z.number().int().positive()}).strict().parse(raw);
  const id=`partner_checkout_${hash(`${ctx.orgId}:${resourceKey(resource)}:${input.client_operation_id}`)}`,requestHash=hash(JSON.stringify(input));
  // Claim commits before provider effects. An interrupted charge is never retried automatically.
  const claim=await withSharedAccess(ctx,resource,"invoice.pay",async decision=>{
    requirePermission(decision.ctx,"manage_partner_payments");
    const prior=await findRecord(id,"partner_checkout");
    if(prior){if(prior.request_hash!==requestHash)throw conflict("operation_conflict","This payment reference was already used.");return {record:prior,provider:null};}
    const {provider,config}=await merchant(resource.owner_org_id),invoice=await readInvoice(resource.owner_org_id,resource.id);
    requireRail(config,input.method);
    if(Number(invoice.revision)!==input.expected_invoice_revision||!["due","overdue","partially_paid"].includes(String(invoice.status)))throw conflict("invoice_changed","Reload this invoice before paying.");
    const pending=await collaborationStore().prepare("SELECT id FROM collaboration_records WHERE kind='partner_checkout' AND resource_key=? AND status NOT IN ('paid','failed') LIMIT 1").get(resourceKey(resource));
    if(pending)throw conflict("invoice_payment_pending","A payment is pending or requires reconciliation. Do not submit another payment.");
    const quote=await surchargeQuote(resource.owner_org_id,provider!,{amount_cents:Number(invoice.balance_due_cents),method:input.method,branch_id:String(invoice.branch_id||"default")});
    if(quote.total_cents!==input.expected_total_cents)throw conflict("payment_quote_changed","Review the current total before paying.");
    const obligations=Array.isArray(invoice.obligation_ids)?invoice.obligation_ids.map(String):[];
    if(!obligations.length)throw conflict("invoice_not_issued","The owner must issue this invoice before it can be paid.");
    const record=await insertRecord("partner_checkout",{id,resource,owner_org_id:resource.owner_org_id,recipient_org_id:ctx.orgId,request_hash:requestHash,created_by:actor(ctx),status:"charging",revision:1,created_at:now(),amount_cents:quote.total_cents,base_amount_cents:quote.amount_cents,surcharge_cents:quote.surcharge_cents,currency:String(invoice.currency||"USD"),provider:provider!.provider,project_id:invoice.project_id,branch_id:invoice.branch_id,obligation_ids:obligations});
    return {record,provider};
  });
  if(!claim.provider)return paymentView(claim.record);
  const record=claim.record;
  try{
    const intent=await claim.provider.createPaymentIntent({amount_cents:record.amount_cents,currency:record.currency,reference_id:id,auto_capture:true,user_fields:{collaboration_checkout_id:id}});
    await withOrganizationLocks([record.owner_org_id,ctx.orgId],async()=>{const current=await getRecord(id);await updateRecord(current,{provider_intent_id:intent.id},current.revision);});
    const charge=await claim.provider.createPayment(intent.id,{payment_method_id:input.payment_method_id});
    const recorded=await withOrganizationLocks([record.owner_org_id,ctx.orgId],async()=>{
      const current=await getRecord(id);
      const status=charge.amount_cents!==record.amount_cents||charge.currency.toUpperCase()!==record.currency.toUpperCase()?"reconciliation_required":["captured","settled"].includes(charge.status)?"captured":["failed","cancelled"].includes(charge.status)?"failed":"pending";
      return updateRecord(current,{status,provider_payment_id:charge.id},current.revision);
    });
    if(recorded.status!=="captured")return paymentView(recorded);
    return await settleCapturedCheckout(recorded,ctx);
  }catch{
    return withOrganizationLocks([record.owner_org_id,ctx.orgId],async()=>{const current=await getRecord(id);return paymentView(await updateRecord(current,{status:"reconciliation_required"},current.revision));});
  }
}

/** Claim accounting separately from the provider request. If the process stops
 * during accounting, leave the record for reconciliation instead of repeating
 * domain events or creating a second charge. */
async function settleCapturedCheckout(record:Record<string,any>,ctx:PlatformAuthContext){
  const claimed=await withOrganizationLocks([record.owner_org_id,record.recipient_org_id],async()=>{
    const current=await getRecord(record.id,"partner_checkout");
    if(current.status!=="captured")return null;
    return updateRecord(current,{status:"accounting"},current.revision);
  });
  if(!claimed)return paymentView(await getRecord(record.id));
  return withDeferredWorkEvents(()=>withOrganizationLocks([record.owner_org_id,record.recipient_org_id],async()=>{
    const current=await getRecord(record.id,"partner_checkout");
    const payment=await createPayment(record.owner_org_id,{id:`receipt_${record.id}`,direction:"inbound",status:"settled",kind:"partner_invoice",amount_cents:record.amount_cents,currency:record.currency,project_id:record.project_id,branch_id:record.branch_id,allocation_obligation_ids:record.obligation_ids,provider:record.provider,processor:{provider:record.provider,provider_payment_id:record.provider_payment_id,provider_intent_id:record.provider_intent_id},metadata:{collaboration_actor:record.created_by,collaboration_checkout_id:record.id,base_amount_cents:record.base_amount_cents,surcharge_cents:record.surcharge_cents}},ctx);
    await removeProviderShadowRecord(record.owner_org_id,record.provider_payment_id);
    const saved=await updateRecord(current,{status:"paid",payment_id:(payment.payment as any).id},current.revision);
    await audit(saved,"collaboration.invoice.paid",record.created_by);return paymentView(saved);
  }));
}

/** Poll only known payment IDs; this worker never creates or retries a charge.
 * An unknown provider outcome remains blocked for operator reconciliation. */
export async function reconcilePartnerPayments(limit=25){
  const rows=await collaborationStore().prepare("SELECT value_json FROM collaboration_records WHERE kind='partner_checkout' AND status IN ('pending','captured') ORDER BY revision,id LIMIT ?").all(limit);
  for(const row of rows){
    const record=JSON.parse(String(row.value_json));
    try{
      if(!record.provider_payment_id)continue;
      const provider=await getPaymentProvider(record.owner_org_id);
      if(!provider||provider.provider!==record.provider)continue;
      const charge=await provider.getPayment(record.provider_payment_id);
      const nextStatus=charge.amount_cents!==record.amount_cents||charge.currency.toUpperCase()!==record.currency.toUpperCase()?"reconciliation_required":["captured","settled"].includes(charge.status)?"captured":["failed","cancelled"].includes(charge.status)?"failed":"pending";
      const current=await withOrganizationLocks([record.owner_org_id,record.recipient_org_id],async()=>{
        const value=await getRecord(record.id);
        if(!["pending","captured"].includes(value.status))return value;
        return updateRecord(value,{status:nextStatus,last_checked_at:now()},value.revision);
      });
      if(current.status==="captured"){
        const ctx=await backgroundAuthContext(record.created_by.organization_id,record.created_by.user_id);
        await settleCapturedCheckout(current,ctx);
      }
    }catch{
      // Provider outage is retryable. Accounting claims remain non-retryable.
    }
  }
}
