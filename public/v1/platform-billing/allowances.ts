import { billingStore, record, records } from "./storage.js";
import type { Account, Price, Subscription } from "./model.js";

/** Counts provider submissions per recipient, including ambiguous submissions.
 * Organization locks make the final slot atomic across delivery workers. */
export async function smsAllowance(org:string, at=new Date().toISOString()) {
  const subscriptions=await records<Subscription>(org,"subscription");
  const enrolled=subscriptions.some(s=>s.product_id==="sms" && s.price.allowances?.sms_messages!==undefined);
  if(!enrolled){
    // Preserve legacy contracts, but an enrolled commercial account must buy SMS
    // before background deliveries can use the provider, regardless of API route.
    if(subscriptions.some(s=>s.product_id==="sms"&&s.starts_at<=at&&(!s.ends_at||s.ends_at>at)&&(!s.stripe_subscription_id||(s.paid_through||"")>at)))return null;
    if(!(await record<Account>(org,"account","account"))?.enforce)return null;
    if(!(await records<Price>("_platform","price")).some(p=>p.published&&p.product_id==="sms"&&p.allowances?.sms_messages!==undefined))return null;
  }
  const plan=subscriptions.filter(s=>s.product_id==="sms" && s.starts_at<=at && (!s.ends_at||s.ends_at>at) && (!s.stripe_subscription_id||(s.paid_through||"")>at)).sort((a,b)=>b.starts_at.localeCompare(a.starts_at))[0];
  const start=plan?.period_start||plan?.starts_at||at;
  const end=plan?.paid_through||new Date(Date.parse(start)+30*86400000).toISOString();
  const row=await billingStore().prepare("SELECT COUNT(*) AS count FROM platform_billing_sms_reservations WHERE organization_id=? AND occurred_at>=? AND occurred_at<?").get(org,start,end);
  const used=Number(row?.count||0),limit=plan?.price.allowances?.sms_messages||0;
  return {used,limit,remaining:Math.max(0,limit-used),paused:used>=limit,period_start:start,renews_at:end};
}
export async function reserveSms(org:string,delivery:string) {
  return billingStore().transaction(async()=>{
    if(await billingStore().prepare("SELECT delivery_id FROM platform_billing_sms_reservations WHERE organization_id=? AND delivery_id=?").get(org,delivery))return true;
    const allowance=await smsAllowance(org);if(!allowance)return true;
    if(allowance.paused)return false;
    await billingStore().prepare("INSERT INTO platform_billing_sms_reservations(organization_id,delivery_id,occurred_at) VALUES(?,?,?)").run(org,delivery,new Date().toISOString());return true;
  },org);
}
export async function releaseSms(org:string,delivery:string) {
  await billingStore().prepare("DELETE FROM platform_billing_sms_reservations WHERE organization_id=? AND delivery_id=?").run(org,delivery);
}
