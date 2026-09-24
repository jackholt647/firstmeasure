import { getAgentsDatabase } from "../agents/storage.js";
import { getCommunicationsDatabase } from "../messaging/communications_storage.js";
import { mediaStorageUsage } from "../platform/storage.js";
import { billingStore, record, records, put } from "./storage.js";
import { recordUsage, finalizeInvoice } from "./service.js";
import { monthBounds, type Account, type Subscription } from "./model.js";
import { reconcilePayments } from "./payments.js";

/** Durable source cursors make retries and multiple replicas safe. Source rows are retained as evidence. */
export async function collectUsage(org:string) {
  const account=await record<Account>(org,"account","account");
  if(!account) return { enrolled:false };
  const sources=[
    { id:"agents", db:getAgentsDatabase(), table:"agent_runs", time:"created_at" },
    { id:"sms", db:getCommunicationsDatabase(), table:"communication_usage_events", time:"occurred_at" },
    { id:"chat", db:getCommunicationsDatabase(), table:"chat_ai_usage_events", time:"created_at" }
  ];
  let complete=true;
  for(const source of sources) {
    const cursor=await record<{at:string;id:string}>(org,"cursor",source.id) || {at:account.created_at,id:""};
    const rows=await source.db.prepare(`SELECT * FROM ${source.table} WHERE organization_id=? AND (created_at>? OR (created_at=? AND id>?)) ORDER BY created_at,id LIMIT 2000`).all(org,cursor.at,cursor.at,cursor.id);
    if(rows.length===2000) complete=false;
    await billingStore().transaction(async()=>{
      for(const row of rows) {
        const key=String(row.id), at=String(row[source.time]);
        const emit=(meter:string,quantity:unknown)=>recordUsage(org,meter,`${source.id}:${key}`,Number(quantity||0),at);
        if(source.id==="agents") { await emit("agents.runs",1); await emit("agents.input_tokens",row.input_tokens); await emit("agents.output_tokens",row.output_tokens); }
        if(source.id==="chat") { await emit("chat.input_tokens",row.input_tokens); await emit("chat.output_tokens",row.output_tokens); }
        if(source.id==="sms") await emit(row.direction==="inbound"?"sms.inbound_segments":"sms.outbound_segments",row.segments);
      }
      const last=rows.at(-1);
      if(last) await put(org,"cursor",source.id,{at:String(last.created_at),id:String(last.id)});
    },org);
  }
  const hour=new Date().toISOString().slice(0,13);
  if(!await record(org,"snapshot",hour)) {
    const usage=await mediaStorageUsage(org);
    await billingStore().transaction(async()=>{
      if(await record(org,"snapshot",hour)) return;
      const at=new Date().toISOString();
      await recordUsage(org,"storage.bytes",`storage:${hour}`,usage.used_bytes,at);
      await put(org,"snapshot",hour,{at});
    },org);
  }
  const result={enrolled:true,complete,at:new Date().toISOString()}; await put(org,"sync","last",result); return result;
}

/** Runs from the existing leased heartbeat; finalization never sends a payment. */
export async function sweepBilling() {
  const rows=await billingStore().prepare("SELECT organization_id FROM platform_billing_records WHERE kind='account' AND id='account'").all();
  for(const row of rows) {
    const org=String(row.organization_id);
    try {
      const sync=await collectUsage(org); if(!("complete" in sync) || !sync.complete) continue;
      await reconcilePayments(org,"billing-scheduler");
      const subscriptions=await records<Subscription>(org,"subscription");
      if(!subscriptions.length) continue;
      let month=subscriptions.map(s=>s.starts_at.slice(0,7)).sort()[0]!;
      // Bounded catch-up; subsequent sweeps resume from existing immutable invoices.
      for(let i=0;i<120;i++) {
        const bounds=monthBounds(month);
        if(Date.now()<Date.parse(bounds.end)+72*3600000) break;
        await finalizeInvoice(org,month,"billing-scheduler");
        month=bounds.end.slice(0,7);
      }
    } catch(error) {
      await put(org,"sync","last",{at:new Date().toISOString(),complete:false,error:error instanceof Error?error.message:"Usage collection failed"});
    }
  }
}
