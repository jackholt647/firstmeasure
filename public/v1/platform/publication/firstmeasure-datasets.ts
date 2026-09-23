import type { ProjectManifest } from "../../firstmeasure/storage.js";
import { readStoredXml } from "../../firstmeasure/storage.js";
import { parseRoofplanMeasurementXml } from "../../public-firstmeasure/measurements.js";
import { listDocuments, readDocument } from "../storage.js";
import { systemPublicationContext } from "./context.js";
import { importMeasurementDataset, listProjectDatasets, readProjectDataset, selectProjectDataset } from "./datasets.js";
import { contentHash } from "./validation.js";
import type { PublicationContext } from "./contracts.js";
import { authorizePublication } from "./context.js";
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
function linkedReport(project:Obj){const m=obj(project.measurement_project||project.measurement),raw=obj(m.raw);return String(m.id||m.project_id||raw.id||raw.project_id||project.measurement_project_id||project.folder||"");}
/** Retry-safe completion projection. Report remains authoritative; importer retains local overrides. */
export async function publishCompletedFirstMeasureDataset(manifest:ProjectManifest,onlyProjectId?:string){
 if(manifest.status!=="completed")return;
 const orgId=String(obj(manifest.organization_ref).id||"");if(!orgId)return;
 const xml=await readStoredXml(manifest.id);const text=xml.content.toString("utf8");if(!text)return;
 const payload=measurementPayloadFromRoofplan(text,manifest.id);if(!Object.keys(payload.measurements).length)return;
 const sourceRevision=contentHash(text);
 for(const project of (await listDocuments(orgId,"projects")).filter(p=>(!onlyProjectId||p.id===onlyProjectId)&&linkedReport(obj(p.data))===manifest.id)){
  const target={scope:"project" as const,organizationId:orgId,projectId:project.id};
  const ctx=systemPublicationContext({kind:"work",organizationId:orgId,projectId:project.id,operations:["datasets.save","datasets.value","datasets.select"],mode:"command"});
  const all=await listProjectDatasets(ctx,target);const existing=all.find(d=>d.role===`firstmeasure:${manifest.id}`);
  let current:Awaited<ReturnType<typeof readProjectDataset>>|undefined;
  if(existing)current=await readProjectDataset(ctx,{...target,id:existing.id});
  const saved=current?.provenance.sourceRevision===sourceRevision?{id:current.id}:await importMeasurementDataset(ctx,target,{...(existing?{id:existing.id,expectedRevision:Number(existing.storeRevision)}:{id:`dataset_${contentHash({orgId,projectId:project.id,reportId:manifest.id}).slice(0,32)}`}),name:"FirstMeasure report",role:`firstmeasure:${manifest.id}`,value:payload,provenance:{producer:"firstmeasure",reportId:manifest.id,sourceRevision,sourceFormat:"roofplan",unitsContract:"roofplan-feet"}});
  const latest=await readDocument(orgId,"projects",project.id);
  if(!obj(obj(latest.data).dataset_defaults).measurements)await selectProjectDataset(ctx,target,"measurements",saved.id,Number(latest.revision));
 }
}
export async function importProjectFirstMeasure(ctx:PublicationContext,projectId:string){
 const target={scope:"project" as const,organizationId:ctx.organizationId,projectId};
 await authorizePublication(ctx,target,{scopes:["project"],permissions:["manage_projects"],systemKinds:["work","module"]},"firstmeasure.measurements.import");
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
