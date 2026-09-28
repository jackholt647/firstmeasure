import { exchangeEstimate } from "../commerce/exchange.js";
import { priceForOrganization, stripePriceKey } from "../commerce/prices.js";
import { organizationProfile } from "../commerce/profile.js";
import { randomUUID, createHash } from "node:crypto";
import { env } from "../src/config/env.js";
import { badRequest, conflict, notFound } from "../platform/errors.js";
import { billingStore, record, records, put } from "./storage.js";
import { audit, subscribe, cancelSubscription } from "./service.js";
import { stripe } from "./payments.js";
import type { Price, Subscription } from "./model.js";
import { rawCapabilityValues, resolveCapabilities } from "../platform/capabilities.js";

type StripeAccount = { customer_id:string; subscription_id?:string };
export type Quote = { id:string; price:Price; exchange?:Awaited<ReturnType<typeof exchangeEstimate>>; adaptive_pricing?:boolean; stripe_price_id?:string; subscription_id?:string; state:string; proration_date:number; expires_at:string;
  replaces_id?:string; replaces_item_id?:string; replaces_name?:string;
  current_monthly_cents:number; new_monthly_cents:number; due_now_cents:number; renewal_at:string|null;
  items:{name:string;monthly_cents:number;added:boolean;description:string}[]; credit_cents:number; future_credit_cents:number; subtotal_cents:number };
type Purchase = Quote & { status:"prepared"|"pending"|"paid"|"expired"; actor:string; created_at:string; fields:Record<string,string>; route:string; session_id?:string; invoice_id?:string; url?:string };
const now = () => new Date().toISOString();
const objectId = (value:any):string => typeof value==="string"?value:String(value?.id||"");
const hash = (value:unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const iso = (seconds:number) => new Date(seconds*1000).toISOString();
const pending = (p:Purchase) => p.status==="prepared" || p.status==="pending";
const active = (s:Subscription) => !s.ends_at || s.ends_at>now();
async function purchasable(org:string,price:Price) {
  if(!resolveCapabilities(await rawCapabilityValues(org)).effectiveByKey[price.capability_key]) throw conflict("billing_feature_unavailable","This feature must be enabled for your organization before it can be added.");
}
function mode(value:any) { if(value.livemode!==!env.stripeTestMode) throw conflict("billing_payment_mode_mismatch"); }
function owned(sub:any, org:string, account:StripeAccount) {
  mode(sub);
  if(sub.metadata?.billing_kind!=="platform_subscription" || sub.metadata?.organization_id!==org || objectId(sub.customer)!==account.customer_id || sub.id!==account.subscription_id) throw conflict("billing_subscription_mismatch");
  if(sub.collection_method && sub.collection_method!=="charge_automatically")throw conflict("billing_automatic_collection_required");
  if(sub.items?.has_more) throw conflict("billing_too_many_items");
}
function validateItem(item:any, price:Price, stripePrice:string) {
  if(!item || item.quantity!==1 || objectId(item.price)!==stripePrice || item.price.unit_amount!==price.monthly_cents || item.price.currency!==price.currency.toLowerCase() || item.price.recurring?.interval!=="month" || item.price.recurring?.interval_count!==1) throw conflict("billing_price_mismatch");
}
async function nativePrice(price:Price) {
  const existing=await record<{id:string}>("_platform","stripe-price",stripePriceKey(price));
  if(existing) return existing.id;
  // Immutable price versions map to immutable Stripe prices. lookup_key makes recovery
  // safe even beyond Stripe's 24-hour idempotency retention.
  const lookup=`fm_platform_${stripePriceKey(price)}`;
  const found=await stripe("GET",`prices?lookup_keys[]=${encodeURIComponent(lookup)}&limit=1`);
  let value=found.data?.[0];
  if(!value) value=await stripe("POST","prices",{currency:price.currency.toLowerCase(),unit_amount:String(price.monthly_cents),"recurring[interval]":"month","product_data[name]":price.name,lookup_key:lookup,"metadata[platform_price_id]":price.id},`platform-price-${hash(stripePriceKey(price))}`);
  mode(value);
  if(value.unit_amount!==price.monthly_cents || value.currency!==price.currency.toLowerCase() || value.recurring?.interval!=="month" || value.recurring?.interval_count!==1) throw conflict("billing_price_mismatch");
  await put("_platform","stripe-price",stripePriceKey(price),{id:value.id}); return String(value.id);
}
async function state(org:string) {
  const subscriptions=(await records<Subscription>(org,"subscription")).filter(active);
  const account=await record<StripeAccount>(org,"stripe-account","account");
  const sub=account?.subscription_id?await stripe("GET",`subscriptions/${encodeURIComponent(account.subscription_id)}?expand[]=latest_invoice`):null;
  if(sub) owned(sub,org,account!);
  return {subscriptions,account,sub,fingerprint:hash({subscriptions,sub:sub?{id:sub.id,status:sub.status,items:sub.items,pending:sub.pending_update,cancel:sub.cancel_at_period_end,invoice:objectId(sub.latest_invoice)}:null})};
}
function readyForChange(sub:any) {
  if(sub && (sub.status!=="active" || sub.pending_update || sub.cancel_at_period_end || sub.schedule || sub.latest_invoice?.status!=="paid")) throw conflict("billing_payment_pending","Finish the existing payment or cancellation before adding another subscription.");
  if(sub && (sub.discounts?.length || sub.default_tax_rates?.length || sub.automatic_tax?.enabled)) throw conflict("billing_subscription_review_required","This subscription needs a billing review before it can be changed here.");
}
async function preview(subId:string, stripePrice:string, at:number, itemId?:string) {
  return stripe("POST","invoices/create_preview",{subscription:subId,...(itemId?{"subscription_details[items][0][id]":itemId}:{}),"subscription_details[items][0][price]":stripePrice,"subscription_details[items][0][quantity]":"1","subscription_details[proration_behavior]":"always_invoice","subscription_details[proration_date]":String(at)});
}
function validAmount(invoice:any, currency:string) {
  if(invoice.currency!==currency.toLowerCase() || !Number.isSafeInteger(invoice.amount_due) || invoice.amount_due<0 || invoice.amount_due>100_000_000) throw conflict("billing_quote_invalid");
}
export async function quoteSubscription(org:string, priceId:string) {
  await reconcileSubscriptions(org,"checkout-review");
  const catalogPrice=await record<Price>("_platform","price",priceId);
  if(!catalogPrice?.published) throw badRequest("billing_price_unavailable");
  const price=await priceForOrganization(org,catalogPrice!);
  const profile=await organizationProfile(org);
  await purchasable(org,price);
  if((await records<Purchase>(org,"purchase")).some(pending) || (await records<any>(org,"stripe-cancel")).some(c=>!c.complete) || (await records<any>(org,"stripe-resume")).some(r=>!r.complete)) throw conflict("billing_checkout_pending","Finish or cancel your pending checkout first.");
  const current=await state(org);
  const replacing=current.subscriptions.find(s=>s.product_id===price.product_id);
  if(replacing?.price.id===price.id) throw conflict("billing_subscription_exists");
  if(replacing && (!replacing.stripe_item_id || replacing.ends_at)) throw conflict("billing_resume_required","Resume this subscription before changing its plan.");
  if(price.allowances?.storage_bytes && replacing && price.allowances.storage_bytes<(replacing.price.allowances?.storage_bytes||0)) {
    const usage=await (await import("../platform/storage.js")).mediaStorageUsage(org);
    if(usage.used_bytes>price.allowances.storage_bytes)throw conflict("billing_storage_too_large","Your stored media exceeds this plan. Remove files or choose a larger plan before downgrading.");
  }
  readyForChange(current.sub);
  if(current.subscriptions.some(s=>s.price.currency!==price.currency))throw conflict("billing_currency_mismatch","Existing subscriptions use another billing currency. Contact support before changing currency.");
  const at=Math.floor(Date.now()/1000);
  const stripePrice=(price.monthly_cents||price.rates.some(r=>r.unit_price_micros))?await nativePrice(price):undefined;
  const invoice=current.sub && stripePrice?await preview(current.sub.id,stripePrice,at,replacing?.stripe_item_id):null;
  if(invoice) validAmount(invoice,price.currency);
  const items=current.subscriptions.filter(s=>!s.ends_at && s.id!==replacing?.id).map(s=>({name:s.price.name,monthly_cents:s.price.monthly_cents,added:false,description:s.price.description}));
  const monthly=current.subscriptions.filter(s=>!s.ends_at).reduce((total,s)=>total+s.price.monthly_cents,0);
  items.push({name:price.name,monthly_cents:price.monthly_cents,added:true,description:price.description});
  const due=invoice?invoice.amount_due:price.monthly_cents;
  const quote:Quote={id:randomUUID(),price,exchange:profile.credit_display==="credits"?await exchangeEstimate(profile.currency,profile.local_currency):null,adaptive_pricing:profile.credit_display==="credits",stripe_price_id:stripePrice,subscription_id:current.sub?.id,state:current.fingerprint,...(replacing?{replaces_id:replacing.id,replaces_item_id:replacing.stripe_item_id,replaces_name:replacing.price.name}:{}),proration_date:at,expires_at:iso(at+600),current_monthly_cents:monthly,new_monthly_cents:monthly+price.monthly_cents-(replacing?.price.monthly_cents||0),due_now_cents:due,renewal_at:current.sub?iso(current.sub.items.data[0].current_period_end):null,items,future_credit_cents:Math.max(0,-(invoice?.total||0)),subtotal_cents:invoice?.subtotal??due,credit_cents:invoice?Math.max(0,(invoice.total||0)-due):0};
  await put(org,"quote",quote.id,quote); return quote;
}
function checkoutBase() {
  const base=env.stripeBaseUrl.replace(/\/+$/,"");const url=new URL(base);
  if(url.protocol!=="https:" && !["localhost","127.0.0.1"].includes(url.hostname)) throw badRequest("billing_return_url_invalid");
  if(env.dataEnvironment!=="production" && !["dev.1m8.ai","localhost","127.0.0.1"].includes(url.hostname)) throw badRequest("billing_return_url_invalid");
  return `${base}/index.php?tab=company_settings&sub=billing`;
}
export async function acceptSubscription(org:string, quoteId:string, actor:string) {
  let purchase=await record<Purchase>(org,"purchase",quoteId);
  if(purchase) return execute(org,purchase);
  const quote=await record<Quote>(org,"quote",quoteId);
  if(!quote) throw notFound("billing_quote_missing");
  if(quote.expires_at<=now()) throw conflict("billing_quote_expired","Refresh the review before checking out.");
  await purchasable(org,quote.price);
  const current=await state(org);
  // A concurrent acceptance may have finished while Stripe state was loading.
  purchase=await record<Purchase>(org,"purchase",quoteId);if(purchase)return execute(org,purchase);
  readyForChange(current.sub);
  if(current.fingerprint!==quote.state) throw conflict("billing_quote_changed","Your subscription changed. Refresh the review before checking out.");
  if(quote.subscription_id && quote.stripe_price_id) {
    const next=await preview(quote.subscription_id,quote.stripe_price_id,quote.proration_date,quote.replaces_item_id);validAmount(next,quote.price.currency);
    if(next.amount_due!==quote.due_now_cents || next.subtotal!==quote.subtotal_cents) throw conflict("billing_quote_changed","The amount changed. Refresh the review before checking out.");
  }
  purchase=await billingStore().transaction(async()=>{
    const existing=await record<Purchase>(org,"purchase",quote.id);if(existing)return existing;
    if((await records<Purchase>(org,"purchase")).some(pending) || (await records<any>(org,"stripe-cancel")).some(c=>!c.complete) || (await records<any>(org,"stripe-resume")).some(r=>!r.complete)) throw conflict("billing_checkout_pending");
    // Compare local state again under the organization lock; another accepted free plan
    // or cancellation must invalidate the quote too.
    const local=(await records<Subscription>(org,"subscription")).filter(active);
    if(hash(local)!==hash(current.subscriptions)) throw conflict("billing_quote_changed");
    const fields:Record<string,string>=quote.subscription_id?{
      ...(quote.replaces_item_id?{"items[0][id]":quote.replaces_item_id}:{}),"items[0][price]":quote.stripe_price_id||"","items[0][quantity]":"1",payment_behavior:"pending_if_incomplete",proration_behavior:"always_invoice",proration_date:String(quote.proration_date),"expand[0]":"latest_invoice"
    }:{mode:"subscription","adaptive_pricing[enabled]":quote.adaptive_pricing?"true":"false","line_items[0][price]":quote.stripe_price_id||"","line_items[0][quantity]":"1","payment_method_types[0]":"card",success_url:`${checkoutBase()}&billing_checkout=${quote.id}`,cancel_url:`${checkoutBase()}&billing_checkout=${quote.id}`,expires_at:String(Math.floor(Date.now()/1000)+1800),client_reference_id:org,
      "metadata[billing_kind]":"platform_subscription","metadata[organization_id]":org,"metadata[purchase_id]":quote.id,"subscription_data[metadata][billing_kind]":"platform_subscription","subscription_data[metadata][organization_id]":org,"subscription_data[metadata][purchase_id]":quote.id,"payment_method_collection":"always"};
    // A separate platform customer keeps payment method changes isolated from
    // FirstMeasure credit purchases and automatic top-ups.
    if(!quote.subscription_id && current.account?.customer_id) fields.customer=current.account.customer_id;
    const value:Purchase={...quote,status:"prepared",actor,created_at:now(),fields,route:quote.subscription_id?`subscriptions/${quote.subscription_id}`:"checkout/sessions"};
    await put(org,"purchase",value.id,value);
    if(!await record(org,"account","account")) await put(org,"account","account",{enforce:false,created_at:now(),updated_at:now(),actor});
    const billingAccount=await record<any>(org,"account","account");
    await put(org,"account","account",{...billingAccount,automatic_collection:true});
    await audit(org,"subscription.accepted",actor,{quote_id:value.id,monthly_cents:value.new_monthly_cents,due_now_cents:value.due_now_cents});return value;
  },org);
  return execute(org,purchase);
}
async function execute(org:string,p:Purchase) {
  if(p.status==="paid") return {paid:true};
  if(p.status==="expired") throw conflict("billing_checkout_expired","Review the subscription again to start a new checkout.");
  if(!p.price.monthly_cents && !p.price.rates.some(r=>r.unit_price_micros)) {
    await billingStore().transaction(async()=>{await subscribe(org,p.price.id,p.id,p.actor,p.price);p.status="paid";await put(org,"purchase",p.id,p);},org);return {paid:true};
  }
  if(p.status==="pending") {await reconcilePurchase(org,p);return result((await record<Purchase>(org,"purchase",p.id))!);}
  if(Date.now()-Date.parse(p.created_at)>23*3600000) throw conflict("billing_payment_review_required","The checkout result needs to be reconciled with Stripe before retrying.");
  const response=await stripe("POST",p.route,p.fields,`platform-purchase-${hash([org,p.id])}`);
  await billingStore().transaction(async()=>{
    const current=(await record<Purchase>(org,"purchase",p.id))!;if(current.status!=="prepared")return;
    if(p.subscription_id) {current.invoice_id=objectId(response.latest_invoice);current.url=response.latest_invoice?.hosted_invoice_url;}
    else {current.session_id=response.id;current.url=response.url;}
    current.status="pending";await put(org,"purchase",p.id,current);
  },org);
  p=(await record<Purchase>(org,"purchase",p.id))!;await reconcilePurchase(org,p);return result((await record<Purchase>(org,"purchase",p.id))!);
}
function result(p:Purchase) {return {paid:p.status==="paid",pending:p.status==="pending",expired:p.status==="expired",url:p.status==="pending"?p.url:undefined,purchase_id:p.id};}
async function reconcilePurchase(org:string,p:Purchase) {
  if(!pending(p))return;
  if(p.status==="prepared")return; // Retrying the persisted request is the only safe recovery from an unknown response.
  let subId=p.subscription_id, customer="", paid=false, invoice:any;
  if(p.session_id) {
    const session=await stripe("GET",`checkout/sessions/${encodeURIComponent(p.session_id)}`);mode(session);
    if(session.metadata?.organization_id!==org || session.metadata?.purchase_id!==p.id || session.metadata?.billing_kind!=="platform_subscription" || session.mode!=="subscription") throw conflict("billing_payment_mismatch");
    if(session.status==="expired") {await expire(org,p);return;}
    if(session.payment_status!=="paid")return;
    if(session.currency!==p.price.currency.toLowerCase() || session.amount_total!==p.due_now_cents)throw conflict("billing_payment_mismatch");
    subId=objectId(session.subscription);customer=objectId(session.customer);paid=true;
  }
  if(!subId)return;
  const account=(await record<StripeAccount>(org,"stripe-account","account"))||{customer_id:customer,subscription_id:subId};
  if(!account.subscription_id) account.subscription_id=subId;
  const sub=await stripe("GET",`subscriptions/${encodeURIComponent(subId)}?expand[]=latest_invoice`);owned(sub,org,account);
  if(p.invoice_id) {
    invoice=await stripe("GET",`invoices/${encodeURIComponent(p.invoice_id)}`);mode(invoice);
    if(objectId(invoice.customer)!==account.customer_id || objectId(invoice.parent?.subscription_details?.subscription||invoice.subscription)!==subId || invoice.currency!==p.price.currency.toLowerCase() || invoice.amount_due!==p.due_now_cents)throw conflict("billing_payment_mismatch");
    if(invoice.status==="void" || invoice.status==="uncollectible") {await expire(org,p);return;}
    paid=invoice.status==="paid";
  }
  if(!paid || sub.pending_update || sub.status!=="active")return;
  const item=sub.items.data.find((i:any)=>objectId(i.price)===p.stripe_price_id);validateItem(item,p.price,p.stripe_price_id!);
  await billingStore().transaction(async()=>{
    const current=(await record<Purchase>(org,"purchase",p.id))!;if(current.status==="paid")return;
    if(p.replaces_id) {
      const previous=await record<Subscription>(org,"subscription",p.replaces_id);
      if(!previous || previous.stripe_item_id!==p.replaces_item_id)throw conflict("billing_subscription_mismatch");
      previous.ends_at=now();await put(org,"subscription",previous.id,previous);
    }
    const local=await subscribe(org,p.price.id,p.id,p.actor,p.price);
    local.stripe_subscription_id=subId;local.stripe_item_id=item.id;local.paid_through=iso(item.current_period_end);local.period_start=iso(item.current_period_start);local.payment_status="paid";
    await put(org,"subscription",local.id,local);await put(org,"stripe-account","account",account);
    const commercial=await record<any>(org,"account","account");await put(org,"account","account",{...commercial,enforce:true,automatic_collection:true});
    current.status="paid";await put(org,"purchase",p.id,current);
    await audit(org,"subscription.payment_confirmed",p.actor,{purchase_id:p.id,subscription_id:subId,due_now_cents:p.due_now_cents});
  },org);
  await saveInvoice(org,invoice||sub.latest_invoice);
}
async function expire(org:string,p:Purchase) {await billingStore().transaction(async()=>{const current=(await record<Purchase>(org,"purchase",p.id))!;if(current.status!=="paid"){current.status="expired";await put(org,"purchase",p.id,current);}},org);}
async function saveInvoice(org:string,invoice:any) {
  if(!invoice?.id || typeof invoice!=="object")return;
  mode(invoice);
  const profile=await organizationProfile(org);
  await put(org,"stripe-invoice",invoice.id,{id:invoice.id,minor_digits:profile.minor_digits,currency:String(invoice.currency||"USD").toUpperCase(),presentment_details:invoice.presentment_details||null,status:invoice.status,total_cents:invoice.total,amount_paid_cents:invoice.amount_paid,amount_remaining_cents:invoice.amount_remaining,created_at:iso(invoice.created),url:invoice.hosted_invoice_url,lines:(invoice.lines?.data||[]).map((l:any)=>({label:l.description,amount_cents:l.amount}))});
}
export async function reconcileSubscriptions(org:string,actor:string) {
  for(const p of await records<Purchase>(org,"purchase")) if(pending(p)) {
    if(p.status==="prepared") await execute(org,p); else await reconcilePurchase(org,p);
  }
  for(const c of await records<any>(org,"stripe-cancel")) if(!c.complete) await finishCancellation(org,c);
  for(const r of await records<any>(org,"stripe-resume"))if(!r.complete)await resumeRecurring(org,r.id,actor);
  const account=await record<StripeAccount>(org,"stripe-account","account");if(!account?.subscription_id)return;
  const sub=await stripe("GET",`subscriptions/${encodeURIComponent(account.subscription_id)}?expand[]=latest_invoice`);owned(sub,org,account);
  // The dedicated customer portal changes the customer's default card. Keep the
  // recurring subscription aligned, including subscriptions created by Checkout.
  const customer=await stripe("GET",`customers/${encodeURIComponent(account.customer_id)}`);mode(customer);
  if(customer.id!==account.customer_id)throw conflict("billing_subscription_mismatch");
  const method=objectId(customer.invoice_settings?.default_payment_method);
  if(method && objectId(sub.default_payment_method)!==method)await stripe("POST",`subscriptions/${sub.id}`,{default_payment_method:method});
  await put(org,"payment-details","current",{has_payment_method:Boolean(method||sub.default_payment_method),status:sub.status,automatic:true});
  await saveInvoice(org,sub.latest_invoice);
  await billingStore().transaction(async()=>{
    for(const local of await records<Subscription>(org,"subscription")) if(local.stripe_subscription_id===sub.id && !local.ends_at) {
      const item=sub.items.data.find((i:any)=>i.id===local.stripe_item_id);
      local.payment_status=sub.latest_invoice?.status||sub.status;
      if(sub.status==="active" && sub.latest_invoice?.status==="paid" && item) {
        const mapped=await record<{id:string}>("_platform","stripe-price",stripePriceKey(local.price));validateItem(item,local.price,mapped?.id||"");local.paid_through=iso(item.current_period_end);local.period_start=iso(item.current_period_start);
      }
      if(sub.status==="canceled" || !item) local.ends_at=local.paid_through||now();
      await put(org,"subscription",local.id,local);
    }
    if(sub.status==="canceled" || sub.status==="incomplete_expired") {account.subscription_id=undefined;await put(org,"stripe-account","account",account);await audit(org,"subscription.ended",actor,{stripe_id:sub.id});}
  },org);
}
export async function cancelPurchase(org:string,id:string) {
  const p=await record<Purchase>(org,"purchase",id);if(!p)throw notFound("billing_checkout_missing");
  if(p.status==="prepared") throw conflict("billing_payment_review_required","The previous payment result is uncertain. Resume the accepted checkout to reconcile it before cancelling.");
  await reconcilePurchase(org,p);
  if((await record<Purchase>(org,"purchase",id))?.status!=="pending")return;
  if(p.session_id) await stripe("POST",`checkout/sessions/${p.session_id}/expire`,{},`expire-${hash([org,id])}`);
  else if(p.invoice_id) await stripe("POST",`invoices/${p.invoice_id}/void`,{},`void-${hash([org,id])}`);
  await reconcilePurchase(org,p);
}
export async function cancelRecurring(org:string,id:string,actor:string) {
  const local=await record<Subscription>(org,"subscription",id);if(!local)throw notFound("billing_subscription_missing");
  if(!local.stripe_subscription_id)return cancelSubscription(org,id,actor);
  if(local.ends_at)return local;
  let cancel=await record<any>(org,"stripe-cancel",id);
  if(cancel?.resumed)cancel=null;
  if(!cancel) {
    const current=await state(org);
    if(current.sub?.pending_update)throw conflict("billing_payment_pending","Cancel the pending plan change before cancelling renewal.");
    const item=current.sub.items.data.find((i:any)=>i.id===local.stripe_item_id);
    if(!item)throw conflict("billing_subscription_mismatch");
    cancel=await billingStore().transaction(async()=>{
      if((await records<Purchase>(org,"purchase")).some(pending) || (await records<any>(org,"stripe-cancel")).some(c=>!c.complete) || (await records<any>(org,"stripe-resume")).some(r=>!r.complete))throw conflict("billing_checkout_pending");
      const value={id,operation_id:randomUUID(),sub_id:local.stripe_subscription_id,item_id:local.stripe_item_id,ends_at:iso(item.current_period_end),created_at:now(),actor,complete:false,fields:current.sub.items.data.length===1?{cancel_at_period_end:"true",proration_behavior:"none"}:{"items[0][id]":item.id,"items[0][deleted]":"true",proration_behavior:"none"}};
      await put(org,"stripe-cancel",id,value);return value;
    },org);
  }
  await finishCancellation(org,cancel);return record<Subscription>(org,"subscription",id);
}
async function finishCancellation(org:string,c:any) {
  const sub=await stripe("GET",`subscriptions/${encodeURIComponent(c.sub_id)}`);
  const account=await record<StripeAccount>(org,"stripe-account","account");if(!account)throw conflict("billing_subscription_mismatch");owned(sub,org,account);
  if(!sub.cancel_at_period_end && sub.status!=="canceled" && sub.items.data.some((i:any)=>i.id===c.item_id)) {
    if(Date.now()-Date.parse(c.created_at)>23*3600000)throw conflict("billing_payment_review_required");
    await stripe("POST",`subscriptions/${c.sub_id}`,c.fields,`platform-cancel-${hash([org,c.id,c.operation_id||"legacy"])}`);
  }
  await billingStore().transaction(async()=>{const local=(await record<Subscription>(org,"subscription",c.id))!;local.ends_at=c.ends_at;await put(org,"subscription",local.id,local);c.complete=true;await put(org,"stripe-cancel",c.id,c);await audit(org,"subscription.cancelled",c.actor,{id:c.id,ends_at:c.ends_at});},org);
}

/** Restore renewal without charging again for the already-paid period. */
export async function resumeRecurring(org:string,id:string,actor:string) {
  const local=await record<Subscription>(org,"subscription",id);
  if(!local?.stripe_subscription_id || !local.ends_at || local.ends_at<=now())throw conflict("billing_resume_unavailable","This subscription has ended. Choose a plan to subscribe again.");
  const current=await state(org);
  if(current.sub.pending_update || current.sub.status==="canceled")throw conflict("billing_payment_pending");
  const cancel=await record<any>(org,"stripe-cancel",id);
  if(!cancel?.complete || cancel.resumed)throw conflict("billing_resume_unavailable");
  const resumePrice=await nativePrice(local.price);
  const operation=await billingStore().transaction(async()=>{
    if((await records<Purchase>(org,"purchase")).some(pending))throw conflict("billing_checkout_pending");
    const prior=await record<any>(org,"stripe-resume",id);
    if(prior && prior.cancel_id===(cancel.operation_id||"legacy"))return prior;
    const exists=current.sub.items.data.some((i:any)=>objectId(i.price)===resumePrice);
    const value={id,cancel_id:cancel.operation_id||"legacy",created_at:now(),complete:false,fields:exists?{cancel_at_period_end:"false"}:{...(current.sub.cancel_at_period_end?{"items[0][id]":current.sub.items.data[0].id}:{}),"items[0][price]":resumePrice,"items[0][quantity]":"1",cancel_at_period_end:"false",proration_behavior:"none"}};
    await put(org,"stripe-resume",id,value);return value;
  },org);
  if(Date.now()-Date.parse(operation.created_at)>23*3600000 && !operation.complete)throw conflict("billing_payment_review_required");
  const updated=await stripe("POST",`subscriptions/${local.stripe_subscription_id}`,operation.fields,`platform-resume-${hash([org,id,operation.cancel_id])}`);
  owned(updated,org,current.account!);
  const mapped=await nativePrice(local.price),item=updated.items.data.find((i:any)=>objectId(i.price)===mapped);validateItem(item,local.price,mapped);
  return billingStore().transaction(async()=>{
    const value=(await record<Subscription>(org,"subscription",id))!;value.ends_at=null;value.stripe_item_id=item.id;
    cancel.resumed=true;operation.complete=true;
    await put(org,"subscription",id,value);await put(org,"stripe-cancel",id,cancel);await put(org,"stripe-resume",id,operation);
    await audit(org,"subscription.resumed",actor,{id});return value;
  },org);
}

/** Stripe handles card/address edits; plan mutations stay in our quoted workflow. */
export async function customerPortal(org:string) {
  const account=await record<StripeAccount>(org,"stripe-account","account");
  if(!account?.customer_id)throw conflict("billing_customer_missing","Choose a subscription first to save a payment method.");
  let config=await record<{id:string}>("_platform","stripe-portal","payment-details");
  if(!config){
    const value=await stripe("POST","billing_portal/configurations",{
      "features[customer_update][enabled]":"true","features[customer_update][allowed_updates][0]":"name","features[customer_update][allowed_updates][1]":"email","features[customer_update][allowed_updates][2]":"address",
      "features[payment_method_update][enabled]":"true","features[invoice_history][enabled]":"true","features[subscription_cancel][enabled]":"false","features[subscription_update][enabled]":"false",
      "business_profile[headline]":"Manage your FirstMate subscription payment details"
    },"firstmate-platform-payment-portal-v1");mode(value);config={id:value.id};await put("_platform","stripe-portal","payment-details",config);
  }
  const session=await stripe("POST","billing_portal/sessions",{customer:account.customer_id,configuration:config.id,return_url:checkoutBase()+"&billing_portal=returned"});mode(session);
  const url=new URL(session.url);if(url.protocol!=="https:"||url.hostname!=="billing.stripe.com")throw conflict("billing_provider_url_invalid");
  return {url:url.href};
}

/** Called only after the existing webhook proxy verifies the signature and mode.
 * Fetch current provider state; duplicate/out-of-order events never overwrite it. */
export async function subscriptionWebhook(event:any) {
  const object=event.data?.object||{};
  if(object.metadata?.billing_kind==="platform_invoice") {
    const org=String(object.metadata.organization_id||"");if(org)await (await import("./payments.js")).reconcilePayments(org,"stripe-webhook");return true;
  }
  const meta=object.metadata?.billing_kind==="platform_subscription"?object.metadata:object.parent?.subscription_details?.metadata||object.subscription_details?.metadata;
  if(meta?.billing_kind!=="platform_subscription")return false;
  const org=String(meta.organization_id||"");if(!org)return true;
  await reconcileSubscriptions(org,"stripe-webhook");return true;
}
