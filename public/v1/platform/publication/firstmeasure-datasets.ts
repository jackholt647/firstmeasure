import type { ProjectManifest } from "../../firstmeasure/storage.js";
import { readStoredXml, readPdfState, readArtifact } from "../../firstmeasure/storage.js";
import { parseRoofplanMeasurementXml } from "../../public-firstmeasure/measurements.js";
import { listDocuments, readDocument } from "../storage.js";
import { systemPublicationContext } from "./context.js";
import { importMeasurementDataset, listProjectDatasets, readProjectDataset, selectProjectDataset } from "./datasets.js";
import { contentHash } from "./validation.js";
import type { PublicationContext } from "./contracts.js";
import { authorizePublication } from "./context.js";
import { FirstMeasureError } from "../../firstmeasure/errors.js";
import { buildProjectInstantPayload } from "../../firstmeasure/instant.js";
import { badRequest, forbidden } from "../errors.js";
type Obj=Record<string,unknown>;
const obj=(v:unknown):Obj=>v&&typeof v==="object"&&!Array.isArray(v)?v as Obj:{};
/** Roofplan model coordinates and polygon sizes are feet/ft², independent of PDF display preferences. */
export function measurementPayloadFromRoofplan(xml:string,reportId:string){
 const parsed=parseRoofplanMeasurementXml(xml);const measurements:Record<string,{value:number;unit:string;source:string}>={};
 const add=(key:string,value:number,unit:string)=>{if(Number.isFinite(value)&&value>=0)measurements[key]={value:(measurements[key]?.value||0)+value,unit,source:"firstmeasure"};};
 const pointMap=new Map(parsed.points.filter(p=>{const parts=String(p.raw.data||"").split(",");return parts.length===3&&parts.every(n=>n.trim()!==""&&Number.isFinite(Number(n)));}).map(p=>[p.id,p]));
 const keys:Record<string,string>={ridge:"ridgesLf",hip:"hipsLf",valley:"valleyLf",rake:"rakesLf",eave:"eavesLf",headwall:"headWallLf",sidewall:"sideWallLf",stepflashing:"sideWallLf",transition:"transitionsLf"};
 for(const line of parsed.lines){const key=keys[line.type.toLowerCase().replace(/[^a-z]/g,"")];if(!key)continue;const a=pointMap.get(line.start_point_id||""),b=pointMap.get(line.end_point_id||"");if(a&&b&&[a.x,a.y,a.z,b.x,b.y,b.z].every(Number.isFinite))add(key,Math.hypot(Number(a.x)-Number(b.x),Number(a.y)-Number(b.y),Number(a.z)-Number(b.z)),"ft");}
 let roofArea=0;let observed=false;
 for(const face of parsed.faces){const rawSize=face.raw.polygon.size;if(rawSize===undefined||rawSize.trim()===""||!Number.isFinite(Number(rawSize))||face.area===null||face.area<0)continue;observed=true;roofArea+=face.area;if(face.pitch!==null&&face.raw.polygon.pitch?.trim()&&Number.isFinite(Number(face.raw.polygon.pitch))){const p=face.pitch;add(p<=2?"flatRoofSquares":p<=4?"pitch2to4Squares":p<=6?"pitch4to6Squares":p<=8?"pitch6to8Squares":p<=12?"pitch9to12Squares":"pitch13PlusSquares",face.area/100,"roofing_square");}}
 if(observed){add("roofSquares",roofArea/100,"roofing_square");add("roofArea",roofArea,"ft2");}
 return {measurements,artifacts:[{id:reportId,kind:"firstmeasure.report",sourceRevision:contentHash(xml)},{id:`${reportId}/model_data.xml`,kind:"roofplan.xml",sourceRevision:contentHash(xml)}]};
}
/** Saved report quantities are authoritative. Do not rebuild editor geometry here. */
export function measurementPayloadFromExterior(report: Obj, reportId: string) {
 const measurements: Record<string,{value:number;unit:string;source:string}> = {};
 if (report.units !== "ft" || report.version !== 1) return { measurements, artifacts: [] as {id:string;kind:string;sourceRevision:string}[] };
 const totals=obj(report.totals);
 const fields:Record<string,[string,string]>={gross:["wallGrossArea","ft2"],net:["wallNetArea","ft2"],openingArea:["wallOpeningArea","ft2"],openingPerimeter:["wallOpeningPerimeter","ft"],top:["wallTopLf","ft"],bottom:["wallBottomLf","ft"],transitions:["wallTransitionsLf","ft"],terminations:["wallTerminationsLf","ft"],inside:["insideCornersLf","ft"],outside:["outsideCornersLf","ft"],returns:["wallReturnsArea","ft2"]};
 for(const [field,[key,unit]] of Object.entries(fields)) { const value=totals[field]; if(typeof value==='number'&&Number.isFinite(value)&&value>=0) measurements[key]={value,unit,source:"firstmeasure.exterior"}; }
 return {measurements,artifacts:[{id:`${reportId}/pdf-state`,kind:"exterior.report",sourceRevision:contentHash(report)}]};
}
export function measurementPayloadFromInstant(manifest:ProjectManifest,insights:unknown,structureInsights?:unknown) {
 const payload=buildProjectInstantPayload({manifest,insights,structureInsights,assetUrls:{preview_image_url:null,solar_rgb_url:null,height_map_url:null,mask_url:null,insights_url:null}});
 const area=payload.roof_area.total_roof_area_meters2;
 const measurements:Record<string,{value:number;unit:string;source:string}>={};
 if(typeof area==='number'&&Number.isFinite(area)&&area>=0) {
  measurements.roofArea={value:area/0.09290304,unit:"ft2",source:"firstmeasure.instant"};
  measurements.roofSquares={value:area/9.290304,unit:"roofing_square",source:"firstmeasure.instant"};
 }
 return {measurements,artifacts:[{id:`${manifest.id}/insights.json`,kind:"instant.estimate",sourceRevision:contentHash({insights,structureInsights:structureInsights||null})}]};
}
const optionalArtifact = async (read:()=>Promise<{content:Buffer}>) => {try{return await read();}catch(error){if(error instanceof FirstMeasureError&&error.statusCode===404)return null;throw error;}};
function linkedReport(project:Obj){const m=obj(project.measurement_project||project.measurement),raw=obj(m.raw);return String(m.id||m.project_id||raw.id||raw.project_id||project.measurement_project_id||project.folder||"");}
/** Shared read-only normalization for provider exports and completion projection. */
export async function readFirstMeasureMeasurements(manifest:ProjectManifest) {
 // Internal trial measurements must never become customer publications.
 if(manifest.id.startsWith("fullhouse_"))throw forbidden("internal_report_private","Internal draft reports are not customer publications.");
 const xml=await optionalArtifact(()=>readStoredXml(manifest.id));const text=xml?.content.toString("utf8")||"";
 const payload=measurementPayloadFromRoofplan(text,manifest.id);
 if(!text)payload.artifacts=[];
 const pdfState=obj(await readPdfState(manifest.id));
 const exterior=measurementPayloadFromExterior(obj(pdfState.exteriorReport),manifest.id);
 Object.assign(payload.measurements,exterior.measurements);payload.artifacts.push(...exterior.artifacts);
 if(!payload.measurements.roofArea&&manifest.instant_enabled) {
  const insights=await optionalArtifact(()=>readArtifact(manifest.id,"insights.json"));
  const structures=await optionalArtifact(()=>readArtifact(manifest.id,"instant-structures.json"));
  if(insights) {const instant=measurementPayloadFromInstant(manifest,JSON.parse(insights.content.toString("utf8")),structures?JSON.parse(structures.content.toString("utf8")):undefined);Object.assign(payload.measurements,instant.measurements);payload.artifacts.push(...instant.artifacts);}
 }
 return payload;
 }
/** Retry-safe completion projection. Report remains authoritative; importer retains local overrides. */
export async function publishCompletedFirstMeasureDataset(manifest:ProjectManifest,onlyProjectId?:string){
 if(manifest.status!=="completed")return;
 const orgId=String(obj(manifest.organization_ref).id||"");if(!orgId)return;
 const payload=await readFirstMeasureMeasurements(manifest);
 if(!Object.keys(payload.measurements).length)return;
 const sourceRevision=contentHash(payload);
 for(const project of (await listDocuments(orgId,"projects")).filter(p=>(!onlyProjectId||p.id===onlyProjectId)&&linkedReport(obj(p.data))===manifest.id)){
  const target={scope:"project" as const,organizationId:orgId,projectId:project.id};
  const ctx=systemPublicationContext({kind:"work",organizationId:orgId,projectId:project.id,operations:["datasets.save","datasets.value","datasets.select"],mode:"command"});
  const all=await listProjectDatasets(ctx,target);const existing=all.find(d=>d.role===`firstmeasure:${manifest.id}`);
  let current:Awaited<ReturnType<typeof readProjectDataset>>|undefined;
  if(existing)current=await readProjectDataset(ctx,{...target,id:existing.id});
  const saved=current?.provenance.sourceRevision===sourceRevision?{id:current.id}:await importMeasurementDataset(ctx,target,{...(existing?{id:existing.id,expectedRevision:Number(existing.storeRevision)}:{id:`dataset_${contentHash({orgId,projectId:project.id,reportId:manifest.id}).slice(0,32)}`}),name:"FirstMeasure report",role:`firstmeasure:${manifest.id}`,value:payload,provenance:{producer:"firstmeasure",reportId:manifest.id,sourceRevision,sourceFormat:"firstmeasure-report",unitsContract:"explicit-per-value"}});
  const latest=await readDocument(orgId,"projects",project.id);
  if(!obj(obj(latest.data).dataset_defaults).measurements)await selectProjectDataset(ctx,target,"measurements",saved.id,Number(latest.revision));
 }
}
export async function importProjectFirstMeasure(ctx:PublicationContext,projectId:string){
 const target={scope:"project" as const,organizationId:ctx.organizationId,projectId};
 await authorizePublication(ctx,target,{scopes:["project"],permissions:["manage_project_data"],systemKinds:["work","module"]},"firstmeasure.measurements.import");
 if(ctx.mode!=="command")throw forbidden("measurement_import_mode","Measurement import requires command execution.");
 const project=await readDocument(ctx.organizationId,"projects",projectId);const reportId=linkedReport(obj(project.data));
 if(!reportId)throw badRequest("measurement_report_unlinked","The project has no linked measurement report.");
 const manifest=await (await import("../../firstmeasure/storage.js")).readManifest(reportId);
 if(String(obj(manifest.organization_ref).id)!==ctx.organizationId)throw forbidden("measurement_report_owner","The report belongs to another organization.");
 if(manifest.status!=="completed")throw badRequest("measurement_report_pending","The report must be completed before importing measurements.");
 await publishCompletedFirstMeasureDataset(manifest,projectId);
 const reader=systemPublicationContext({kind:"work",organizationId:ctx.organizationId,projectId,operations:["datasets.value"]});
 const result=await effectiveProjectMeasurements(reader,projectId);
 if(result.status!=="ready")throw badRequest("measurement_values_unavailable","The report does not contain supported measurement values yet.");
 return result;
}
export async function effectiveProjectMeasurements(ctx:PublicationContext,projectId:string){
 const target={scope:"project" as const,organizationId:ctx.organizationId,projectId};
 // Authorize through list even if this project has no default yet.
 await listProjectDatasets(ctx,target);
 const project=await readDocument(ctx.organizationId,"projects",projectId);const datasetId=String(obj(obj(project.data).dataset_defaults).measurements||"");
 if(!datasetId)return {status:"missing",code:"measurement_dataset_unselected",legacyFallback:true};
 const dataset=await readProjectDataset(ctx,{...target,id:datasetId});
 return {status:"ready",datasetId,revision:dataset.revision,provenance:dataset.provenance,value:dataset.value,legacyFallback:false};
}
