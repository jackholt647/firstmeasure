import { createHash } from "node:crypto";
import { env } from "../src/config/env.js";
import { conflict } from "../platform/errors.js";
import { record, put, records, billingStore } from "./storage.js";
import { stripe } from "./payments.js";
import { audit } from "./service.js";
import type { Account, Invoice } from "./model.js";

const key=(org:string,id:string,step:string)=>'platform-collect-'+createHash('sha256').update(`${org}:${id}:${step}`).digest('hex');
function verify(value:any, customer:string, id?:string){
  if(value.livemode!==!env.stripeTestMode || String(value.customer?.id||value.customer)!==customer || (id&&value.id!==id))throw conflict('billing_payment_mismatch');
}

/** Automatic collection only. A durable provider invoice is reused on every retry. */
export async function collectInvoice(org:string,id:string) {
  const account=await record<Account>(org,'account','account');
  if(!account?.automatic_collection)return;
  let local=await record<Invoice>(org,'invoice',id);if(!local||local.status!=='open'||local.total_cents<=0)return;
  const customer=await record<{customer_id:string;subscription_id?:string}>(org,'stripe-account','account');
  if(!customer?.customer_id)throw conflict('billing_customer_missing');
  // Never race a historical manual Checkout session with a second charge.
  if(local.checkout_id)throw conflict('billing_legacy_checkout_review','Reconcile the previous checkout before automatic collection.');
  type Attempt={created_at:string;fields:Record<string,string>;stripe_id?:string;item_id?:string};
  let attempt=await billingStore().transaction(async()=>{
    const previous=await record<Attempt>(org,'automatic-invoice',id);if(previous)return previous;
    const value:Attempt={created_at:new Date().toISOString(),fields:{customer:customer.customer_id,currency:'usd',collection_method:'charge_automatically',auto_advance:'false',pending_invoice_items_behavior:'exclude',
      'metadata[billing_kind]':'platform_invoice','metadata[organization_id]':org,'metadata[invoice_id]':id}};
    await put(org,'automatic-invoice',id,value);return value;
  },org);
  const fresh=()=>{if(Date.now()-Date.parse(attempt.created_at)>23*3600000)throw conflict('billing_payment_review_required','An interrupted charge needs provider reconciliation before another request.');};
  if(!attempt.stripe_id){
    fresh();const created=await stripe('POST','invoices',attempt.fields,key(org,id,'create'));verify(created,customer.customer_id);
    attempt.stripe_id=created.id;await put(org,'automatic-invoice',id,attempt);
  }
  let invoice=await stripe('GET',`invoices/${attempt.stripe_id}`);verify(invoice,customer.customer_id,attempt.stripe_id);
  if(invoice.metadata?.organization_id!==org||invoice.metadata?.invoice_id!==id||invoice.currency!=='usd'||invoice.collection_method!=='charge_automatically')throw conflict('billing_payment_mismatch');
  if(invoice.status==='draft') {
    if(!attempt.item_id){
      fresh();const item=await stripe('POST','invoiceitems',{customer:customer.customer_id,invoice:attempt.stripe_id!,currency:'usd',amount:String(local.total_cents),description:`FirstMate usage · ${local.period}`},key(org,id,'item'));
      attempt.item_id=item.id;await put(org,'automatic-invoice',id,attempt);
    }
    // The customer's saved subscription card also pays usage. This never uses
    // the separate FirstMeasure credit customer's card.
    if(customer.subscription_id){
      const sub=await stripe('GET',`subscriptions/${customer.subscription_id}`);verify(sub,customer.customer_id,customer.subscription_id);
      if(sub.metadata?.organization_id!==org)throw conflict('billing_payment_mismatch');
      const method=String(sub.default_payment_method?.id||sub.default_payment_method||'');
      if(method)await stripe('POST',`invoices/${attempt.stripe_id}`,{default_payment_method:method},key(org,id,'card:'+method));
    }
    invoice=await stripe('POST',`invoices/${attempt.stripe_id}/finalize`,{auto_advance:'true'},key(org,id,'finalize'));verify(invoice,customer.customer_id,attempt.stripe_id);
  }
  if(invoice.total!==local.total_cents)throw conflict('billing_payment_mismatch');
  // Stripe's automatic collection and retry schedule own charging. Webhooks and
  // the sweep reconcile receipts; no customer Pay Invoice step is presented.
  await billingStore().transaction(async()=>{
    local=(await record<Invoice>(org,'invoice',id))!;
    local.checkout_url=invoice.hosted_invoice_url;
    if(invoice.status==='paid'&&local.status!=='paid'){
      local.status='paid';local.paid_at=new Date((invoice.status_transitions?.paid_at||Math.floor(Date.now()/1000))*1000).toISOString();local.payment_id=invoice.id;
      await audit(org,'invoice.automatically_paid','stripe',{id,stripe_id:invoice.id});
    }
    await put(org,'invoice',id,local);
    await put(org,'collection-status',id,{id,stripe_id:invoice.id,status:invoice.status,attempted:invoice.attempted,next_payment_attempt:invoice.next_payment_attempt,automatic:true});
  },org);
}
export async function collectOpenInvoices(org:string){
  for(const invoice of await records<Invoice>(org,'invoice'))if(invoice.status==='open')await collectInvoice(org,invoice.id);
}
