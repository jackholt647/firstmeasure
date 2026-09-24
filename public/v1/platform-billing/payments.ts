import { env } from "../src/config/env.js";
import { readGlobal } from "../platform/storage.js";
import { badRequest, notFound, conflict } from "../platform/errors.js";
import { billingStore, record, put } from "./storage.js";
import { audit, invoiceKey } from "./service.js";
import type { Invoice } from "./model.js";

export async function stripe(method:string, route:string, fields:Record<string,string>={}, key="") {
  const secret=env.stripeSecretKey || (env.stripeTestMode?env.stripeTestSecretKey:env.stripeLiveSecretKey);
  if(!secret) throw badRequest("billing_payments_unconfigured","Stripe is not configured for this environment.");
  if(env.dataEnvironment!=="production" && (!env.stripeTestMode || !secret.startsWith("sk_test_"))) throw badRequest("billing_test_mode_required","Development billing requires a Stripe test key.");
  const response=await fetch(`https://api.stripe.com/v1/${route}`,{method,headers:{Authorization:`Bearer ${secret}`,"Content-Type":"application/x-www-form-urlencoded","Stripe-Version":"2025-06-30.basil",...(key?{"Idempotency-Key":key}:{})},...(method==="POST"?{body:new URLSearchParams(fields)}:{}),signal:AbortSignal.timeout(15000)});
  const data=await response.json() as any;
  if(!response.ok) throw badRequest("billing_provider_error",data.error?.message||"Payment provider request failed.");
  return data;
}
export async function checkout(org:string, period:string, actor:string) {
  let invoice=await record<Invoice>(org,"invoice",period);
  if(!invoice) throw notFound("billing_invoice_missing");
  if(invoice.status!=="open" || !invoice.total_cents) throw conflict("billing_invoice_not_payable");
  let expiredId="";
  if(invoice.checkout_id) {
    const prior=await stripe("GET",`checkout/sessions/${encodeURIComponent(invoice.checkout_id)}`);
    if(prior.payment_status==="paid") {
      await billingStore().transaction(async()=>{
        const current=await record<Invoice>(org,"invoice",period);
        if(current?.status==="open") await settle(org,current,prior,actor);
      },org);
      return {paid:true};
    }
    if(prior.status!=="expired") return {url:invoice.checkout_url};
    expiredId=invoice.checkout_id;
  }
  const global=await readGlobal(org); const customer=String((global.data as any)?.billing?.stripe?.customer_id||"");
  const base=env.stripeBaseUrl.replace(/\/+$/,""); const url=new URL(base);
  if(env.dataEnvironment!=="production" && url.hostname!=="dev.1m8.ai" && !["localhost","127.0.0.1"].includes(url.hostname)) throw badRequest("billing_return_url_invalid");
  const fields:Record<string,string>={mode:"payment",success_url:`${base}/index.php?tab=company_settings&sub=platform_billing`,cancel_url:`${base}/index.php?tab=company_settings&sub=platform_billing`,
    "line_items[0][price_data][currency]":"usd","line_items[0][price_data][unit_amount]":String(invoice.total_cents),"line_items[0][price_data][product_data][name]":`FirstMate platform · ${period}`,"line_items[0][quantity]":"1",
    "metadata[billing_kind]":"platform_invoice","metadata[organization_id]":org,"metadata[invoice_id]":period};
  if(customer) fields.customer=customer;
  type Attempt={number:number;created_at:string;fields:Record<string,string>};
  // Commit the request identity and exact fields BEFORE contacting Stripe. An ambiguous result
  // can be retried safely within its idempotency window, even after process or database failure.
  const attempt=await billingStore().transaction(async()=>{
    const current=await record<Invoice>(org,"invoice",period);
    if(current?.status!=="open") throw conflict("billing_invoice_not_payable");
    const previous=await record<Attempt>(org,"checkout-attempt",period);
    if(current.checkout_id && current.checkout_id!==expiredId) return {completed:current.checkout_url};
    const replaceExpired=Boolean(expiredId && current.checkout_id===expiredId);
    if(previous && !replaceExpired) {
      if(Date.now()-Date.parse(previous.created_at)>23*3600000) throw conflict("billing_payment_review_required","A previous checkout result is uncertain. An operator must reconcile it with Stripe before another checkout can be created.");
      return {pending:previous};
    }
    const next:Attempt={number:(previous?.number||0)+1,created_at:new Date().toISOString(),fields};
    if(replaceExpired) { current.checkout_id=undefined;current.checkout_url=undefined;await put(org,"invoice",period,current); }
    await put(org,"checkout-attempt",period,next); return {pending:next};
  },org);
  if("completed" in attempt) return {url:attempt.completed};
  const pending=attempt.pending!;
  const session=await stripe("POST","checkout/sessions",pending.fields,`platform-billing-${invoiceKey(org,period)}-${pending.number}`);
  return billingStore().transaction(async()=>{
    invoice=(await record<Invoice>(org,"invoice",period))!;
    if(invoice.status!=="open") return {paid:invoice.status==="paid"};
    if(invoice.checkout_id && invoice.checkout_id!==session.id) throw conflict("billing_checkout_conflict");
    invoice.checkout_id=session.id; invoice.checkout_url=session.url;
    await put(org,"invoice",period,invoice);await audit(org,"invoice.checkout",actor,{period,session_id:session.id});return {url:session.url};
  },org);
}
async function settle(org:string, invoice:Invoice, session:any, actor:string) {
  if(session.metadata?.billing_kind!=="platform_invoice" || session.metadata?.organization_id!==org || session.metadata?.invoice_id!==invoice.id || session.amount_total!==invoice.total_cents || session.currency!=="usd" || session.livemode!==!env.stripeTestMode) throw conflict("billing_payment_mismatch");
  if(session.payment_status!=="paid") return;
  invoice.status="paid"; invoice.paid_at=new Date().toISOString(); invoice.payment_id=String(session.payment_intent||session.id);
  await put(org,"invoice",invoice.id,invoice); await audit(org,"invoice.paid",actor,{period:invoice.id,payment_id:invoice.payment_id});
}
export async function reconcilePayments(org:string, actor:string) {
  await (await import("./subscriptions.js")).reconcileSubscriptions(org,actor);
  const {records}=await import("./storage.js");
  for(const invoice of await records<Invoice>(org,"invoice")) if(invoice.status==="open" && invoice.checkout_id) {
    const session=await stripe("GET",`checkout/sessions/${encodeURIComponent(invoice.checkout_id)}`);
    await billingStore().transaction(async()=>{
      const current=await record<Invoice>(org,"invoice",invoice.id);
      if(current?.status==="open") await settle(org,current,session,actor);
    },org);
  }
  await (await import("./collection.js")).collectOpenInvoices(org);
}
