import { z } from "zod";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { readMediaMetadata } from "../platform/storage.js";
import { FirstMeasureError } from "./errors.js";
import { currentExpeditePricing, pricingContext } from "./pricing_config.js";
import { buildReportExpediteOptions } from "./expedite.js";
export const EXTERIOR_VIEWS = ["front", "front-right", "right", "back-right", "back", "back-left", "left", "front-left"] as const;
export const isCustomerExteriorId = (id:unknown) => /^exteriors_[a-f0-9]{32}$/.test(String(id ?? ""));
export async function requireExteriorAccess(orgId:string, projectType:string) {
  if (!["residential","commercial","multifamily"].includes(projectType) || !await isCapabilityEnabled(orgId,"firstmeasure.exteriors") || (projectType!=="residential" && !await isCapabilityEnabled(orgId,`firstmeasure.exteriors_${projectType}`))) {
    throw new FirstMeasureError("exteriors_disabled",403,"Full-house reports are not enabled for this property type.");
  }
}
export function exteriorQuote(count=1) {
  const config=currentExpeditePricing(), now=pricingContext.getStore()?.now ?? new Date();
  const orderingClosed=Number(new Intl.DateTimeFormat("en-US",{timeZone:"America/Los_Angeles",hour:"numeric",hourCycle:"h23"}).format(now))>=20;
  const roof=buildReportExpediteOptions({now}).options[0]!;
  const ratio=Math.max(0,Math.min(1,((roof.estimated_wait_minutes ?? 240)-240)/180));
  return {ordering_closed:orderingClosed,pricing_revision:pricingContext.getStore()?.revision ?? 0,structure_count:count,base_price:config.exteriors_base_price,
    busy_label:roof.busy_label,estimated_wait_minutes:Math.round((18+6*ratio)*60),
    options:[{key:"exteriors_standard",label:"Standard · 24 hours",minutes:1440,fee:0},
      {key:"exteriors_same_day",label:"Same day · under 6 hours",minutes:360,fee:config.exteriors_same_day_fee},
      {key:"exteriors_priority",label:"Priority · under 3 hours",minutes:180,fee:config.exteriors_priority_fee}]
      .map(o=>({...o,unit_price:Math.round((config.exteriors_base_price+o.fee)*100)/100,
        amount:Math.round((config.exteriors_base_price+o.fee)*count*100)/100,
        deadline:new Date(now.getTime()+o.minutes*60000).toISOString()}))};
}
const referenceSchema=z.array(z.object({structure:z.number().int().min(0).max(99),view:z.enum([...EXTERIOR_VIEWS,"additional"]),media_id:z.string().min(1).max(160)}).strict()).min(8).max(100);
export async function validateExteriorOrder(orgId:string, body:Record<string,unknown>, count:number) {
  await requireExteriorAccess(orgId,String(body.project_type || "residential"));
  if (!Number.isInteger(count) || count<1 || count>10) throw new FirstMeasureError("invalid_structures",400,"Place a pin on each structure (up to 10).");
  let referenceInput=body.exterior_references;
  if(typeof referenceInput==="string") {try{referenceInput=JSON.parse(referenceInput);}catch{throw new FirstMeasureError("invalid_references",400,"Upload the eight required reference views.");}}
  const references=referenceSchema.parse(referenceInput);
  if(new Set(references.map(r=>r.media_id)).size!==references.length) throw new FirstMeasureError("duplicate_reference",400,"Use a separate photo for each required view.");
  for(let structure=0;structure<count;structure++) for(const view of EXTERIOR_VIEWS) {
    if(references.filter(r=>r.structure===structure && r.view===view).length!==1) throw new FirstMeasureError("missing_reference",400,"Upload all eight reference views for every structure.");
  }
  for(const ref of references){
    if(ref.structure>=count) throw new FirstMeasureError("invalid_reference",400,"Reference structure is not in this order.");
    const media=await readMediaMetadata(orgId,ref.media_id);
    if((media.metadata as any)?.source!=="exteriors_order_reference") throw new FirstMeasureError("invalid_reference",400,"Upload this reference through the full-house order form.");
  }
  const quote=exteriorQuote(count);
  if(Number(body.report_pricing_revision)!==quote.pricing_revision) throw new FirstMeasureError("pricing_changed",409,"Prices changed. Refresh the delivery options before ordering.");
  const option=quote.options.find(o=>o.key===body.report_expedite_option);
  if(quote.ordering_closed && option && option.key!=="exteriors_standard") throw new FirstMeasureError("exteriors_closed",409,"Expedited delivery is unavailable while closed. Choose standard delivery.");
  if(!option) throw new FirstMeasureError("invalid_delivery",400,"Choose a full-house delivery option.");
  return {quote,option,references};
}
