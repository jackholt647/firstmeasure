import { billingStore, records } from "./storage.js";
import type { Subscription } from "./model.js";
import { conflict, PlatformError } from "../platform/errors.js";

export async function storageAllowance(org:string) {
  const subscriptions=await records<Subscription>(org,"subscription");
  if(!subscriptions.some(s=>s.price.allowances?.storage_bytes!==undefined))return null;
  const now=new Date().toISOString();
  const active=subscriptions.filter(s=>s.starts_at<=now&&(!s.ends_at||s.ends_at>now)&&(!s.stripe_subscription_id||(s.paid_through||"")>now));
  const limits=active.map(s=>s.price.allowances?.storage_bytes||0);
  const values=await (await import("../platform/capabilities.js")).rawCapabilityValues(org);
  return Math.max(Number(values["platform.free_storage_gb"]??1)*1073741824,...limits);
}
/** Render first, then check and commit under the same lock used by plan changes.
 * Retained originals and renditions count; replacing media credits its old bytes. */
export async function withStorageAllowance<T>(org:string,mediaId:string,bytes:number,commit:()=>Promise<T>):Promise<T> {
  if(await storageAllowance(org)===null)return commit();
  return billingStore().transaction(async()=>{
    const limit=await storageAllowance(org);if(limit===null)return commit();
    const storage=await import("../platform/storage.js");
    const usage=await storage.mediaStorageUsage(org);
    let replaced=0;
    try {
      const old=await storage.readMediaMetadata(org,mediaId);
      replaced=Object.values((old.variants||{}) as Record<string,any>).reduce((sum,v)=>sum+Number(v.size_bytes||0),0)||Number(old.size_bytes||0);
    }catch(error){if(!(error instanceof PlatformError)||error.statusCode!==404)throw error;}
    if(usage.used_bytes-replaced+bytes>limit)throw conflict("billing_storage_allowance","Your storage allowance is full. Upgrade storage in Billing or remove files before uploading.");
    return commit();
  },org);
}
