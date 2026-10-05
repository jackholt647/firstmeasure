import { reportPrice, assertCommercialRevision } from "../commerce/profile.js";
import { z } from "zod";
import { isCapabilityEnabled } from "../platform/capabilities.js";
import { readMediaMetadata } from "../platform/storage.js";
import { FirstMeasureError } from "./errors.js";
import { currentExpeditePricing, pricingContext } from "./pricing_config.js";
import { buildReportExpediteOptions } from "./expedite.js";
export const EXTERIOR_VIEWS = ["front", "front-right", "right", "back-right", "back", "back-left", "left", "front-left"] as const;
export const isCustomerExteriorId = (id:unknown) => /^exteriors_[a-f0-9]{32}$/.test(String(id ?? ""));
export async function requireExteriorAccess(orgId:string, projectType:string) {
  if (projectType!=="residential" || !await isCapabilityEnabled(orgId,"firstmeasure.exteriors")) {
    throw new FirstMeasureError("exteriors_disabled",403,"Full-house reports are not enabled for this property type.");
  }
}
export function exteriorQuote(count=1) {
  const raw=currentExpeditePricing(), config={...raw,exteriors_base_price:reportPrice(raw.exteriors_base_price),exteriors_same_day_fee:reportPrice(raw.exteriors_same_day_fee),exteriors_priority_fee:reportPrice(raw.exteriors_priority_fee)}, now=pricingContext.getStore()?.now ?? new Date();
  const orderingClosed=false; // Reports are processed 24/7.
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
export const EXTERIOR_ORBITAL_VIDEO = "orbital_video";
export const EXTERIOR_VIDEO_MAX_BYTES = 120*1024*1024;
/** Sniffs the container so a renamed file cannot pose as a reference video. */
export function exteriorVideoFormat(bytes:Buffer) {
  if(bytes.length>12 && bytes.toString("ascii",4,8)==="ftyp") return bytes.toString("ascii",8,12)==="qt  " ? {contentType:"video/quicktime",ext:"mov"} : {contentType:"video/mp4",ext:"mp4"};
  if(bytes.length>4 && bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3]))) return {contentType:"video/webm",ext:"webm"};
  return null;
}
const referenceSchema=z.array(z.object({structure:z.number().int().min(0).max(99),view:z.enum([...EXTERIOR_VIEWS,"additional",EXTERIOR_ORBITAL_VIDEO]),angle:z.enum(EXTERIOR_VIEWS).optional(),kind:z.enum(["image","video"]).optional(),media_id:z.string().min(1).max(160)}).strict()).min(1).max(100);
export async function validateExteriorOrder(orgId:string, body:Record<string,unknown>, count:number) {
  await requireExteriorAccess(orgId,String(body.project_type || "residential"));
  if (!Number.isInteger(count) || count<1 || count>10) throw new FirstMeasureError("invalid_structures",400,"Place a pin on each structure (up to 10).");
  let referenceInput=body.exterior_references;
  if(typeof referenceInput==="string") {try{referenceInput=JSON.parse(referenceInput);}catch{throw new FirstMeasureError("invalid_references",400,"Add an orbital video or the eight required reference views.");}}
  const parsed=referenceSchema.parse(referenceInput);
  if(new Set(parsed.map(r=>r.media_id)).size!==parsed.length) throw new FirstMeasureError("duplicate_reference",400,"Use a separate photo for each required view.");
  // Each structure is covered by an orbital video, or by exactly one photo of every view.
  for(let structure=0;structure<count;structure++) {
    const own=parsed.filter(r=>r.structure===structure);
    for(const view of EXTERIOR_VIEWS) if(own.filter(r=>r.view===view).length>1) throw new FirstMeasureError("duplicate_reference",400,"Use one primary photo for each view.");
    if(own.some(r=>r.view===EXTERIOR_ORBITAL_VIDEO)) continue;
    if(!EXTERIOR_VIEWS.every(view=>own.some(r=>r.view===view))) throw new FirstMeasureError("missing_reference",400,"Add an orbital video or all eight reference views for every structure.");
  }
  const references:Array<(typeof parsed)[number]&{kind:"image"|"video"}>=[];
  for(const ref of parsed){
    if(ref.structure>=count) throw new FirstMeasureError("invalid_reference",400,"Reference structure is not in this order.");
    const media=await readMediaMetadata(orgId,ref.media_id);
    if((media.metadata as any)?.source!=="exteriors_order_reference") throw new FirstMeasureError("invalid_reference",400,"Upload this reference through the full-house order form.");
    // The stored upload, never the client, decides whether a reference is a video.
    const kind=(media.metadata as any)?.reference_kind==="video" ? "video" : "image";
    if(ref.view===EXTERIOR_ORBITAL_VIDEO && kind!=="video") throw new FirstMeasureError("invalid_reference",400,"The orbital video must be a video file.");
    if(ref.view!==EXTERIOR_ORBITAL_VIDEO && ref.view!=="additional" && kind!=="image") throw new FirstMeasureError("invalid_reference",400,"Each required view must be a photo.");
    references.push({...ref,kind});
  }
  const quote=exteriorQuote(count);
  assertCommercialRevision(body);
  if(Number(body.report_pricing_revision)!==quote.pricing_revision) throw new FirstMeasureError("pricing_changed",409,"Prices changed. Refresh the delivery options before ordering.");
  const option=quote.options.find(o=>o.key===body.report_expedite_option);
  if(quote.ordering_closed && option && option.key!=="exteriors_standard") throw new FirstMeasureError("exteriors_closed",409,"Expedited delivery is unavailable while closed. Choose standard delivery.");
  if(!option) throw new FirstMeasureError("invalid_delivery",400,"Choose a full-house delivery option.");
  return {quote,option,references};
}
