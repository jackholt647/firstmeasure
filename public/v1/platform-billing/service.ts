import { randomUUID, createHash } from "node:crypto";
import { capabilityDefinitions, type CapabilityValue } from "../platform/capabilities.js";
import { badRequest, conflict, notFound } from "../platform/errors.js";
import { billingStore, record, records, put } from "./storage.js";
import { meters, priceSchema, monthBounds, roundRatio, type Price, type Subscription, type Account, type Invoice, type Line } from "./model.js";

const now = () => new Date().toISOString();
const id = () => randomUUID();
const protectedKeys = new Set(["apps.billing","apps.firstmeasure","apps.projects","apps.project_map","apps.referrals","platform.expanded_access","platform.platform_billing"]);
export function billableCapabilities() {
  return capabilityDefinitions().filter(c => c.stores_value && c.type === "boolean" && !protectedKeys.has(c.key) && !c.key.startsWith("firstmeasure.") && !c.key.startsWith("mobile."));
}
export async function audit(org:string, action:string, actor:string, details:unknown) {
  const entry = { id:id(), action, actor, at:now(), details }; await put(org,"audit",entry.id,entry);
}
export async function catalog(operator=false) {
  const all = await records<Price>("_platform","price");
  return operator ? all : all.filter(p=>p.published);
}
export async function createPrice(input:unknown, actor:string) {
  const value = priceSchema.parse(input);
  if (!billableCapabilities().some(c=>c.key===value.capability_key)) throw badRequest("billing_capability_invalid","Choose an eligible platform capability.");
  if (new Set(value.rates.map(r=>r.meter)).size !== value.rates.length) throw badRequest("billing_duplicate_meter","A price can use each meter once.");
  return billingStore().transaction(async()=>{
    const prices = await catalog(true);
    if (prices.some(p=>p.capability_key===value.capability_key && p.product_id!==value.product_id)) throw conflict("billing_capability_assigned","This capability already belongs to a billing product.");
    if (prices.some(p=>p.product_id===value.product_id && p.capability_key!==value.capability_key)) throw conflict("billing_product_capability_fixed","A product keeps its original capability.");
    if (prices.some(p=>p.product_id!==value.product_id && p.rates.some(r=>r.unit_price_micros>0 && value.rates.some(next=>next.unit_price_micros>0 && next.meter===r.meter)))) throw conflict("billing_meter_assigned","A billable meter can belong to only one product, preventing duplicate usage charges.");
    const version = Math.max(0,...prices.filter(p=>p.product_id===value.product_id).map(p=>p.version))+1;
    const price:Price = { ...value, id:`${value.product_id}_v${version}`, version, published:false, actor, created_at:now() };
    await put("_platform","price",price.id,price); await audit("_platform","price.created",actor,price); return price;
  },"catalog");
}
export async function publishPrice(priceId:string, actor:string) {
  return billingStore().transaction(async()=>{
    const price = await record<Price>("_platform","price",priceId);
    if (!price) throw notFound("billing_price_missing");
    if (!price.published) { price.published=true; await put("_platform","price",price.id,price); await audit("_platform","price.published",actor,{price_id:price.id}); }
    return price;
  },"catalog");
}
export async function setAccount(org:string, enforce:boolean, actor:string) {
  return billingStore().transaction(async()=>{
    const current = await record<Account>(org,"account","account");
    const value:Account = { ...current, enforce, actor, created_at:current?.created_at || now(), updated_at:now() };
    await put(org,"account","account",value); await audit(org,"account.updated",actor,value); return value;
  },org);
}
export async function subscribe(org:string, priceId:string, requestKey:string, actor:string) {
  return billingStore().transaction(async()=>{
    const subscriptions = await records<Subscription>(org,"subscription");
    const existing = subscriptions.find(s=>s.request_key===requestKey);
    if (existing) { if(existing.price.id!==priceId) throw conflict("billing_request_reused"); return existing; }
    const price = await record<Price>("_platform","price",priceId);
    if (!price?.published) throw badRequest("billing_price_unavailable");
    if (subscriptions.some(s=>s.product_id===price.product_id && (!s.ends_at || s.ends_at>now()))) throw conflict("billing_subscription_exists","Cancel the existing subscription before changing plans.");
    const subscription:Subscription = { id:id(), product_id:price.product_id, price, starts_at:now(), ends_at:null, actor, request_key:requestKey };
    await put(org,"subscription",subscription.id,subscription);
    if (!await record(org,"account","account")) await put(org,"account","account",{enforce:false,created_at:now(),updated_at:now(),actor});
    await audit(org,"subscription.started",actor,subscription); return subscription;
  },org);
}
export async function cancelSubscription(org:string, subscriptionId:string, actor:string) {
  return billingStore().transaction(async()=>{
    const s = await record<Subscription>(org,"subscription",subscriptionId);
    if (!s) throw notFound("billing_subscription_missing");
    if (!s.ends_at) { s.ends_at=monthBounds(now().slice(0,7)).end; await put(org,"subscription",s.id,s); await audit(org,"subscription.cancelled",actor,{id:s.id,ends_at:s.ends_at}); }
    return s;
  },org);
}
export async function recordUsage(org:string, meter:string, eventKey:string, quantity:number, occurredAt:string) {
  if (!org || !eventKey || eventKey.length>200 || !meters.some(m=>m.id===meter) || !Number.isSafeInteger(quantity) || quantity<0 || !Number.isFinite(Date.parse(occurredAt))) throw badRequest("billing_usage_invalid");
  const at = new Date(occurredAt).toISOString();
  if (at > now()) throw badRequest("billing_future_usage");
  const db = billingStore();
  const result = await db.prepare(`INSERT INTO platform_billing_usage(organization_id,meter,event_key,quantity,occurred_at,received_at) VALUES(?,?,?,?,?,?) ON CONFLICT(organization_id,meter,event_key) DO NOTHING`).run(org,meter,eventKey,String(quantity),at,now());
  if (!result.changes) {
    const row = await db.prepare("SELECT quantity,occurred_at FROM platform_billing_usage WHERE organization_id=? AND meter=? AND event_key=?").get(org,meter,eventKey);
    if (String(row?.quantity)!==String(quantity) || row?.occurred_at!==at) throw conflict("billing_usage_conflict","A usage event cannot be changed after it is recorded.");
  }
  return result.changes>0;
}
async function meteredQuantity(org:string, meter:string, start:string, end:string, duration:number) {
  const db=billingStore();
  if (meter!=="storage.bytes") {
    const rows=await db.prepare("SELECT quantity FROM platform_billing_usage WHERE organization_id=? AND meter=? AND occurred_at>=? AND occurred_at<?").all(org,meter,start,end);
    return rows.reduce((sum,row)=>sum+BigInt(String(row.quantity)),0n);
  }
  const prior=await db.prepare("SELECT quantity,occurred_at FROM platform_billing_usage WHERE organization_id=? AND meter=? AND occurred_at<=? ORDER BY occurred_at DESC LIMIT 1").get(org,meter,start);
  const rows=await db.prepare("SELECT quantity,occurred_at FROM platform_billing_usage WHERE organization_id=? AND meter=? AND occurred_at>? AND occurred_at<? ORDER BY occurred_at").all(org,meter,start,end);
  let bytes=BigInt(String(prior?.quantity||0)), last=Date.parse(start), integral=0n;
  for(const row of rows) { const at=Date.parse(String(row.occurred_at)); integral+=bytes*BigInt(at-last); bytes=BigInt(String(row.quantity)); last=at; }
  integral+=bytes*BigInt(Date.parse(end)-last);
  return integral/BigInt(duration);
}
export async function estimate(org:string, period:string, at=now()) {
  let bounds:ReturnType<typeof monthBounds>;
  try { bounds=monthBounds(period); } catch { throw badRequest("billing_period_invalid"); }
  const lines:Line[]=[];
  for(const s of await records<Subscription>(org,"subscription")) {
    const start=[bounds.start,s.starts_at].sort().at(-1)!;
    const end=[bounds.end,s.ends_at||bounds.end,at].sort()[0]!;
    if(start>=end) continue;
    const duration=Date.parse(end)-Date.parse(start);
    const lineBase={subscription_id:s.id,product_id:s.product_id,price_id:s.price.id};
    // Recurring Stripe fees are prepaid. Only their usage enters the local arrears invoice.
    if(!s.stripe_subscription_id) lines.push({...lineBase,label:s.price.name,meter:null,quantity:"1",included:0,amount_cents:roundRatio(BigInt(s.price.monthly_cents)*BigInt(duration),BigInt(bounds.milliseconds))});
    for(const rate of s.price.rates) {
      const quantity=await meteredQuantity(org,rate.meter,start,end,bounds.milliseconds);
      // The first partial month receives the full allowance; storage allowance is time prorated.
      const included=rate.meter==="storage.bytes" ? Math.floor(rate.included*duration/bounds.milliseconds) : rate.included;
      const charged=quantity>BigInt(included)?quantity-BigInt(included):0n;
      const cents=roundRatio(charged*BigInt(rate.unit_price_micros),BigInt(rate.unit_quantity)*10000n);
      if(!Number.isSafeInteger(cents)) throw badRequest("billing_amount_overflow");
      lines.push({...lineBase,label:`${s.price.name} · ${meters.find(m=>m.id===rate.meter)!.label}`,meter:rate.meter,quantity:String(quantity),included,amount_cents:cents});
    }
  }
  for(const adjustment of await records<{id:string;period:string;reason:string;amount_cents:number}>(org,"adjustment")) if(adjustment.period===period) {
    lines.push({subscription_id:"",product_id:"adjustment",price_id:adjustment.id,label:adjustment.reason,meter:null,quantity:"1",included:0,amount_cents:adjustment.amount_cents});
  }
  const total=lines.reduce((sum,l)=>sum+l.amount_cents,0);
  if(!Number.isSafeInteger(total)) throw badRequest("billing_amount_overflow");
  return {period,currency:"USD" as const,lines,total_cents:total,through:at};
}
export async function finalizeInvoice(org:string, period:string, actor:string, at=now()) {
  const bounds=monthBounds(period);
  if(Date.parse(at)<Date.parse(bounds.end)+72*3600000) throw badRequest("billing_period_open","Invoices close 72 hours after the UTC month ends, allowing provider usage to settle.");
  return billingStore().transaction(async()=>{
    const existing=await record<Invoice>(org,"invoice",period); if(existing) return existing;
    const quote=await estimate(org,period,bounds.end);
    if(quote.total_cents<0) throw badRequest("billing_negative_invoice","Apply only enough credit to offset this invoice; carry remaining credit to another period.");
    const invoice:Invoice={id:period,period,currency:"USD",lines:quote.lines,total_cents:quote.total_cents,status:quote.total_cents?"open":"paid",created_at:at,actor};
    await put(org,"invoice",period,invoice); await audit(org,"invoice.finalized",actor,{period,total_cents:invoice.total_cents}); return invoice;
  },org);
}
export async function addAdjustment(org:string, period:string, amount:number, reason:string, requestKey:string, actor:string) {
  monthBounds(period);
  if(!Number.isSafeInteger(amount) || Math.abs(amount)>100_000_000 || !amount || !reason.trim()) throw badRequest("billing_adjustment_invalid");
  return billingStore().transaction(async()=>{
    const existing=await record<any>(org,"adjustment",requestKey);
    if(existing) { if(existing.period!==period||existing.amount_cents!==amount||existing.reason!==reason) throw conflict("billing_request_reused"); return existing; }
    if(await record(org,"invoice",period)) throw conflict("billing_invoice_closed","Apply the adjustment to an open period.");
    const value={id:requestKey,period,amount_cents:amount,reason,actor,created_at:now()};
    await put(org,"adjustment",requestKey,value); await audit(org,"adjustment.created",actor,value); return value;
  },org);
}
export async function applyEntitlements(org:string, values:Record<string,CapabilityValue>) {
  // Only explicitly enrolled organizations use commercial gating. Legacy orgs avoid even opening the ledger.
  const account=await record<Account>(org,"account","account"); if(!account?.enforce) return values;
  const subscriptions=await records<Subscription>(org,"subscription"); const latest=new Map<string,Price>();
  for(const p of await catalog()) if((latest.get(p.product_id)?.version||0)<p.version) latest.set(p.product_id,p);
  const result={...values};
  for(const p of latest.values()) {
    if(!p.require_subscription || (!p.monthly_cents && !p.rates.some(r=>r.unit_price_micros))) continue;
    if(!subscriptions.some(s=>s.product_id===p.product_id && s.starts_at<=now() && (!s.ends_at||s.ends_at>now()) && (!s.stripe_subscription_id || (s.paid_through||"")>now()))) result[p.capability_key]=false;
  }
  return result;
}
export async function overview(org:string, operator=false, period=now().slice(0,7)) {
  const [account,prices,subscriptions,invoices,estimateValue,usage,sync]=await Promise.all([
    record<Account>(org,"account","account"),catalog(operator),records<Subscription>(org,"subscription"),records<Invoice>(org,"invoice"),estimate(org,period),
    billingStore().prepare("SELECT meter,quantity,occurred_at FROM platform_billing_usage WHERE organization_id=? AND meter='storage.bytes' ORDER BY occurred_at DESC LIMIT 1").get(org),
    record(org,"sync","last")
  ]);
  const late=await billingStore().prepare("SELECT meter,COUNT(*) AS count FROM platform_billing_usage WHERE organization_id=? AND occurred_at<? AND received_at>? GROUP BY meter").all(org,monthBounds(period).end,(invoices.find(i=>i.period===period)?.created_at)||"9999");
  return {storage_allowance:await (await import("./storage-allowance.js")).storageAllowance(org),sms_allowance:await (await import("./allowances.js")).smsAllowance(org),account:account||{enforce:false},payment_details:await record(org,"payment-details","current"),has_customer:!!await record(org,"stripe-account","account"),collection_status:await records(org,"collection-status"),prices,subscriptions,invoices:invoices.sort((a,b)=>b.period.localeCompare(a.period)),recurring_invoices:await records(org,"stripe-invoice"),purchases:(await records<any>(org,"purchase")).filter(p=>!["paid","expired"].includes(p.status)).map(p=>({id:p.id,name:p.price.name,status:p.status,url:p.url})),estimate:estimateValue,storage:usage||null,sync,late_usage:late,meters,operator,
    ...(operator?{capabilities:billableCapabilities().map(c=>({key:c.key,label:c.label})),audit:(await records<any>(org,"audit")).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,100)}:{})};
}
export function invoiceKey(org:string, invoice:string) { return createHash("sha256").update(`${org}:${invoice}`).digest("hex"); }
