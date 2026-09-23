import { listDocuments, readDocument, readOrganization, readGlobal, listMedia } from "../storage.js";
import { badRequest, forbidden } from "../errors.js";
import type { AccessPolicy, JsonSchema, PublicationContext, SourceRef, TargetRef } from "./contracts.js";
import { registerDataProvider, type DataExport } from "./providers.js";
import { contentHash } from "./validation.js";
import { registerDatasetProvider, measurementDatasetSchema } from "./datasets.js";
import { registerDomainDataProviders } from "./provider-adapters-domains.js";
import { canReadReceiptMedia, publicMediaMetadata } from "../media_access.js";

type Obj=Record<string,unknown>;
const object=(v:unknown):Obj=>v&&typeof v==="object"&&!Array.isArray(v)?v as Obj:{};
const scalarSchema:JsonSchema={type:["string","number","boolean","null"]};
/** Never copy arbitrary nested domain blobs across the publication boundary. */
function pick(input:unknown,fields:string[]):Obj{const data=object(input);return Object.fromEntries(fields.filter(k=>data[k]===null||["string","number","boolean"].includes(typeof data[k])).map(k=>[k,data[k]]));}
function shape(fields:string[]):JsonSchema{return {type:"object",properties:Object.fromEntries(fields.map(k=>[k,scalarSchema])),additionalProperties:false};}
const projectAccess:AccessPolicy={scopes:["project"],permissions:["view_projects"],systemKinds:["work","module","agent"],authorize:async(ctx,target)=>{await readDocument(ctx.organizationId,"projects",target.projectId!);}};
const orgAccess:AccessPolicy={scopes:["organization"],permissions:["view_projects"],systemKinds:["work","module","agent"]};
function id(ref:SourceRef){if(!ref.target.id)throw badRequest("source_id_required","Source instance identity is required.");return ref.target.id;}
function projectCheck(data:Obj,target:TargetRef){if(target.scope==="project"&&String(data.project_id||data.projectId||"")!==target.projectId)throw forbidden("source_project_denied","Resource belongs to another project.");}
function pageRows(rows:Obj[],ref:SourceRef,page:{limit:number;cursor?:string}){
  rows.sort((a,b)=>String(a.id).localeCompare(String(b.id)));const signature=contentHash({ref,rows});let offset=0;
  if(page.cursor){try{const c=JSON.parse(Buffer.from(page.cursor,"base64url").toString());if(c.signature!==signature||!Number.isInteger(c.offset)||c.offset<0)throw Error();offset=c.offset;}catch{throw badRequest("source_cursor_invalid","The source list changed or its cursor is invalid.");}}
  const items=rows.slice(offset,offset+page.limit);return {items,...(offset+items.length<rows.length?{nextCursor:Buffer.from(JSON.stringify({signature,offset:offset+items.length})).toString("base64url")}: {})};
}
function collectionProvider(provider:string,apps:string[],collection:string,fields:string[],access:AccessPolicy,projectOwned=false){
  registerDataProvider({id:provider,version:"1",apps,exports:{record:{description:`Published ${provider} business fields.`,schema:shape(["id",...fields]),schemaVersion:"1",access:{...access,authorize:async(ctx,target)=>{await access.authorize?.(ctx,target);if(target.id&&projectOwned){const row=await readDocument(ctx.organizationId,collection,target.id);projectCheck(object(row.data),target);}}},read:async(ctx,ref)=>{const row=await readDocument(ctx.organizationId,collection,id(ref));const data=object(row.data);if(projectOwned)projectCheck(data,ref.target);return {value:{...pick(data,fields),id:row.id},revision:String(row.revision),provenance:{collection}};},list:async(ctx,ref,page)=>{const rows=await listDocuments(ctx.organizationId,collection);return pageRows(rows.filter(r=>provider==="projects"?r.id===ref.target.projectId:!projectOwned||object(r.data).project_id===ref.target.projectId).map(r=>({...pick(r.data,fields),id:r.id})),ref,page);}}}});
}
let registered=false;
export function registerBuiltinDataProviders(){
  if(registered)return;registered=true;registerDatasetProvider();
  collectionProvider("projects",["projects","project-map","project-request"],"projects",["name","address","status","stage","city","state","postal","lat","lng","customer_id","created_at","updated_at"],{...projectAccess,authorize:async(ctx,target)=>{if(target.id&&target.id!==target.projectId)throw forbidden("source_project_denied","Project identity must match its target.");await projectAccess.authorize?.(ctx,target);}});
  collectionProvider("customers",["contacts"],"customers",["name","first_name","last_name","email","phone","address","city","state","postal"],orgAccess);
  collectionProvider("calendar",["scheduling","project-schedule"],"calendar_events",["title","project_id","start","end","start_at","end_at","status","timezone"],projectAccess,true);
  collectionProvider("materials",["materials"],"material_orders",["project_id","name","status","ordered_at","delivered_at","supplier","total_cents"],{...projectAccess,capabilities:["platform.materials"]},true);
  collectionProvider("feedback",["feedback"],"feedback_requests",["project_id","status","rating","created_at","completed_at"],projectAccess,true);
  collectionProvider("proposals",["proposals"],"proposals",["project_id","name","status","created_at","updated_at","signed_at","total_cents"],projectAccess,true);
  collectionProvider("websites",["web-editor"],"websites",["name","status","domain","created_at","updated_at"],{...orgAccess,permissions:["manage_company_settings"],capabilities:["apps.web_editor"]});
  collectionProvider("customer-portal",["customer-portal"],"customer_portals",["project_id","name","status","created_at","updated_at"],{...projectAccess,permissions:["view_reports"]},true);
  const profileFields=["id","name","display_name","phone","email","website"];
  registerDataProvider({id:"organization",version:"1",apps:["settings","onboarding"],exports:{profile:{description:"Organization public business profile; excludes settings and credentials.",schema:shape(profileFields),schemaVersion:"1",access:orgAccess,read:async(ctx)=>{const r=await readOrganization(ctx.organizationId);return {value:{...pick(object(r).data||r,profileFields),id:ctx.organizationId},revision:String(object(r).revision||contentHash(pick(r,profileFields)))};}}}});
  registerDataProvider({id:"billing",version:"1",apps:["billing"],exports:{balance:{description:"Organization credit balance and billing configuration summary without payment credentials.",schema:shape(["credits_balance","auto_topup_enabled","has_payment_method"]),schemaVersion:"1",access:{...orgAccess,permissions:["manage_billing"]},read:async(ctx)=>{const r=await readGlobal(ctx.organizationId);const data=object(r.data),billing=object(data.billing);return {value:{...pick(data,["credits_balance"]),auto_topup_enabled:object(billing.auto_topup).enabled===true,has_payment_method:object(billing.stripe).has_payment_method===true},revision:String(r.revision)};}}}});
  registerDataProvider({id:"referrals",version:"1",apps:["referrals"],exports:{eligibility:{description:"Organization referral eligibility; does not create referral partners or codes.",schema:shape(["show","reason","bonus_first_shown_at","eligible_at","seconds_until_eligible"]),schemaVersion:"1",access:orgAccess,read:async(ctx)=>({value:await (await import("../../internal/crm/referrals.js")).customerReferralEligibility(ctx.organizationId)})}}});
  const mediaFields=["id","kind","content_type","file_name","created_at","updated_at"];
  const mediaFor=async(ctx:PublicationContext,ref:SourceRef)=>(await listMedia(ctx.organizationId)).filter(r=>{const d=object(r),o=object(d.owner),m=object(d.metadata);return String(m.project_id||(o.type==="project"?o.id:""))===ref.target.projectId&&canReadReceiptMedia(r,ctx.auth||{permissions:{view_projects:true}});}).map(publicMediaMetadata);
  registerDataProvider({id:"media",version:"1",apps:["photos","receipts"],exports:{metadata:{description:"Project media metadata, without storage paths or access tokens.",schema:shape(mediaFields),schemaVersion:"1",access:{...projectAccess,authorize:async(ctx,target)=>{await projectAccess.authorize?.(ctx,target);if(target.id&&!(await mediaFor(ctx,{provider:"media",export:"metadata",target})).some(m=>object(m).id===target.id))throw forbidden("source_project_denied","Media is outside the project.");}},read:async(ctx,ref)=>{const r=(await mediaFor(ctx,ref)).find(m=>object(m).id===id(ref));return r?{value:pick(r,mediaFields)}:{status:"missing",code:"media_missing",message:"Media does not exist."};},list:async(ctx,ref,page)=>pageRows((await mediaFor(ctx,ref)).map(r=>pick(r,mediaFields)),ref,page)}}});
  registerPricebook();registerDocuments();registerDomainDataProviders();registerFirstMeasure();
}
function registerFirstMeasure(){
 const access:AccessPolicy={scopes:["organization"],permissions:["view_reports"],systemKinds:["work","module"],authorize:async(ctx,t)=>{const m=await (await import("../../firstmeasure/storage.js")).readManifest(t.id||"");if(m.id.startsWith("fullhouse_")||String(object(m.organization_ref).id)!==ctx.organizationId)throw forbidden("report_owner_denied","Report belongs to another organization.");}};
 registerDataProvider({id:"firstmeasure",version:"1",apps:["firstmeasure/order","measurements"],exports:{status:{description:"Report order and completion state.",schema:shape(["id","status","project_type","address","report_mode"]),schemaVersion:"1",access,read:async(_ctx,ref)=>{const m=await (await import("../../firstmeasure/storage.js")).readManifest(id(ref));return {value:pick(m,["id","status","project_type","address","report_mode"])};}},measurements:{description:"Completed roof, exterior and instant report quantities with explicit units and artifact references.",schema:measurementDatasetSchema,schemaVersion:"1",access,read:async(_ctx,ref)=>{const s=await import("../../firstmeasure/storage.js");const m=await s.readManifest(id(ref));if(m.status!=="completed")return {status:"pending",code:"report_pending",message:"The measurement report is not complete."};const {readFirstMeasureMeasurements}=await import("./firstmeasure-datasets.js");const value=await readFirstMeasureMeasurements(m);return {value,revision:`sha256:${contentHash(value)}`,provenance:{reportId:m.id,sourceFormat:"firstmeasure-report",unitsContract:"explicit-per-value"}};}}}});
}
function registerPricebook(){
  const fields=["id","name","description","category","manufacturer","unit","unitPrice","unit_price","basePrice","base_price"];
  const access:AccessPolicy={scopes:["global","organization"],permissions:["view_projects"],systemKinds:["work","module","agent"],authorize:async(ctx,target)=>{
    const s=await import("../../pricebook/storage.js");const manifest=await s.readManifest(target.id||"");const org=String(object(object(manifest).organization_ref).id||"");
    if(target.scope==="organization"&&org!==ctx.organizationId)throw forbidden("pricebook_owner_denied","Pricebook belongs to another organization.");
    if(target.scope==="global"){const global=await s.getGlobalMarketPricebook();if(String(object(global).id||object(object(global).manifest).id)!==target.id)throw forbidden("pricebook_global_denied","Only the published global market pricebook is available.");}
  }};
  registerDataProvider({id:"pricebook",version:"1",apps:["pricebook"],exports:{items:{description:"Explicit pricebook catalog items, without default or branch fallback.",schema:{type:"array",items:shape(fields)},schemaVersion:"1",access,read:async(_ctx,ref)=>{const s=await import("../../pricebook/storage.js");const catalog=object(await s.readCatalog(id(ref)));return {value:(Array.isArray(catalog.items)?catalog.items:[]).map(item=>pick(item,fields)),provenance:{pricebookId:ref.target.id!}};}}}});
}
function registerDocuments(){
  const access:AccessPolicy={...projectAccess,authorize:async(ctx,target)=>{await projectAccess.authorize?.(ctx,target);if(target.id){const r=await readDocument(ctx.organizationId,"documents",target.id);projectCheck(object(r.data),target);}}};
  const exports:Record<string,DataExport>={};
  for(const kind of ["params","outputs"]){exports[kind]={description:`Explicitly published document ${kind}.`,schema:{type:"object",additionalProperties:true},schemaVersion:"1",access,authorizeSnapshot:async(ctx,ref,result)=>{const row=await readDocument(ctx.organizationId,"documents",id(ref));const current=object(object(row.data).publication)[kind];const captured=result.provenance.publishedKeys;if(!Array.isArray(current)||!Array.isArray(captured)||captured.some(k=>typeof k!=="string"||!current.includes(k)))throw forbidden("document_export_revoked","A captured document variable is no longer published.");},read:async(ctx,ref)=>{
    const row=await readDocument(ctx.organizationId,"documents",id(ref));const data=object(row.data);projectCheck(data,ref.target);
    const keys=object(data.publication)[kind];if(!Array.isArray(keys))return {status:"missing",code:"document_exports_undeclared",message:"This document has not declared published variables."};
    const values=object(data[kind]);const value=Object.fromEntries(keys.filter((k):k is string=>typeof k==="string"&&Object.hasOwn(values,k)&&!["__proto__","constructor","prototype"].includes(k)).map(k=>[k,values[k]]));
    return {value,revision:String(row.revision),provenance:{documentId:row.id,publishedKeys:Object.keys(value)}};
  }};}
  registerDataProvider({id:"documents",version:"1",apps:["documents","docs","signatures"],exports});
}
