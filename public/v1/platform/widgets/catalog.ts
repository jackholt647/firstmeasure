import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readDocument } from '../storage.js';
import { forbidden, badRequest } from '../errors.js';
import { authorizePublicationDiscovery } from '../publication/context.js';
import { authorizeSource, registerDataProvider, describeDataProvider } from '../publication/providers.js';
import { validateJson } from '../publication/validation.js';
import type { PublicationContext, TargetRef, JsonSchema, SourceRef, AccessPolicy } from '../publication/contracts.js';
import { listProjectMaterialLists } from '../../materials/storage.js';
import { widgetSelectionValue } from './selection.js';

type Obj=Record<string,any>;
const object=(v:unknown):Obj=>v&&typeof v==='object'&&!Array.isArray(v)?v as Obj:{};
const widgetRoot=path.resolve(process.cwd(),'../libraries/platform-widgets');
const scopeData=createRequire(import.meta.url)(path.join(widgetRoot,'scope-data.js')) as {measurements:(project:Obj,lists:Obj[],report:Obj)=>Obj};
export type WidgetDefinition={id:string;version:string;title:string;description:string;app:string;surfaces:string[];sizing:Obj;configSchema:JsonSchema;sources:{provider:string;export:string}[];children?:{id:string;version:string;key:string}[];selection?:{description:string;schema:JsonSchema}};
const definitions=JSON.parse(readFileSync(path.join(widgetRoot,'catalog.json'),'utf8')) as WidgetDefinition[];
// Selection is optional. A widget that declares one must describe a closed object, so discovery tells agents the answer's exact shape.
for(const def of definitions)if(def.selection!==undefined){const schema=object(object(def.selection).schema);if(!String(object(def.selection).description||'').trim()||schema.type!=='object'||schema.additionalProperties!==false)throw Error(`Widget ${def.id} declares an invalid selection contract.`);}
/** Screen-reported selection is untrusted presentation metadata. Returns it only when the exact widget version declares a selection and the value is bounded and matches that schema; otherwise null. Never an authorization input. */
export function widgetSelection(id:string,version:string,value:unknown):Obj|null{
 const def=definitions.find(d=>d.id===id&&d.version===version);if(!def?.selection||value==null)return null;
 const bounded=widgetSelectionValue.safeParse(value);if(!bounded.success)return null;
 try{validateJson(def.selection.schema,bounded.data,'widget selection');}catch{return null;}
 return structuredClone(bounded.data) as Obj;
}
export function widgetDefinition(id:string,version='1'){const def=definitions.find(d=>d.id===id&&d.version===version);if(!def)throw badRequest('widget_unknown','This widget version is unavailable.');return structuredClone(def);}
export function widgetSources(def:WidgetDefinition):{provider:string;export:string}[]{return [...def.sources,...(def.children||[]).flatMap(child=>widgetSources(widgetDefinition(child.id,child.version)))];}
/** Search concept words across fields, including common spelling/plural variants. */
export function widgetMatchesQuery(def:WidgetDefinition,query:string){
 const normalize=(value:string)=>value.toLowerCase().replace(/\bto[\s-]*dos?\b/g,'todo').replace(/[^a-z0-9]+/g,' ').replace(/\b(tasks|lists|projects|measurements|widgets)\b/g,word=>word.slice(0,-1));
 const terms=[...new Set(normalize(query).split(/\s+/).filter(Boolean))];
 const text=normalize(`${def.id} ${def.title} ${def.description} ${def.app}`);
 return terms.every(term=>text.includes(term));
}
export async function authorizeWidget(ctx:PublicationContext,id:string,version:string,target:TargetRef,config:Obj={}){
 const def=widgetDefinition(id,version);validateJson(def.configSchema,config,'widget configuration');
 for(const source of widgetSources(def))await authorizeSource(ctx,{...source,target});return def;
}
export async function listWidgets(ctx:PublicationContext,target?:TargetRef){
 const result:WidgetDefinition[]=[];
 for(const def of definitions){try{for(const source of widgetSources(def)){
  if(target)await authorizeSource(ctx,{...source,target});
  else {const access=describeDataProvider(source.provider)?.exports[source.export]?.access;if(!access)throw Error('Missing widget source');await authorizePublicationDiscovery(ctx,(access as AccessPolicy).scopes.includes('project')?{scope:'project',organizationId:ctx.organizationId,projectId:'$project'}:{scope:'organization',organizationId:ctx.organizationId},access as AccessPolicy,`${source.provider}.${source.export}`);}
 }result.push(structuredClone(def));}catch{/* Discovery is never an authority grant. */}}
 return result;
}
const string={type:'string'};const rowSchema={type:'object',properties:{key:string,label:string,value:{type:['number','string','boolean']},unit:string},required:['key','label','value','unit'],additionalProperties:false};
const listSchema={type:'object',properties:{id:string,title:string,resourceType:string,status:string,items:{type:'array',items:{type:'object',properties:{id:string,title:string,quantity:{type:'number'},unit:string},required:['id','title','quantity','unit'],additionalProperties:false}}},required:['id','title','resourceType','status','items'],additionalProperties:false};
const mediaSchema={type:'object',properties:{url:string,label:string,video:{type:'boolean'}},required:['url','label','video'],additionalProperties:false};
const projectPolicy:AccessPolicy={scopes:['project'],permissions:['view_materials'],capabilities:['platform.materials'],authorize:async(ctx,target)=>{await readDocument(ctx.organizationId,'projects',target.projectId!);}};
function title(key:string){return key.replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ').replace(/^./,s=>s.toUpperCase());}
export function measurementRows(values:Obj){return Object.entries(values).flatMap(([key,raw])=>{
 const entry=object(raw),value=Object.hasOwn(entry,'value')?entry.value:raw;
 if(!['number','string','boolean'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))return [];
 const unit=typeof entry.unit==='string'?entry.unit:/Squares$/.test(key)?'sq':/Lf$/.test(key)?'lf':/Ea$/.test(key)?'ea':key==='wastePercent'?'%':key==='pitchRise'?'/12':'';
 return [{key,label:title(key),value,unit}];
});}
export function projectLists(lists:Obj[]){return lists.map(list=>({id:String(list.id),title:String(list.title||'Scope list'),resourceType:String(list.resource_type||object(list.metadata).resource_type||'material'),status:String(list.status||'draft'),items:(Array.isArray(list.current_items)?list.current_items:Array.isArray(list.items)?list.items:[]).map((raw:unknown)=>{const item=object(raw);return {id:String(item.id||''),title:String(item.name||item.title||item.description||'Item'),quantity:Number.isFinite(Number(item.quantity))?Number(item.quantity):0,unit:String(item.unit||'')};})}));}
function linkedReport(project:Obj){const m=object(project.measurement_project||project.measurement),raw=object(m.raw);return String(m.id||m.project_id||raw.id||raw.project_id||project.measurement_project_id||project.folder||'');}
async function reportFor(ctx:PublicationContext,ref:SourceRef){
 const project=await readDocument(ctx.organizationId,'projects',ref.target.projectId!);const id=linkedReport(object(project.data));if(!id)return null;
 const storage=await import('../../firstmeasure/storage.js');const manifest=await storage.readManifest(id);
 if(String(object(manifest.organization_ref).id)!==ctx.organizationId)throw forbidden('widget_report_owner','The report belongs to another organization.');
 const hold=object(manifest.delivery_release_hold||object(manifest.delivery).release_hold);
 if(manifest.status!=='completed'||String(manifest.delivery_hold_status||hold.status)==='holding')return null;
 return {id,manifest,storage};
}
const directorySchema={type:'object',properties:{results:{type:'array',items:{type:'object',properties:{id:string,title:string,subtitle:string},required:['id','title','subtitle'],additionalProperties:false}}},required:['results'],additionalProperties:false};
export function registerWidgetProviders(){registerDataProvider({id:'project-widgets',version:'1',apps:['materials','measurements'],exports:{
 directory:{description:'Bounded project search for the project picker widget: id, title and subtitle of matching or recent projects.',schema:directorySchema,schemaVersion:'1',argsSchema:{type:'object',properties:{query:{type:'string',maxLength:200},limit:{type:'integer',minimum:1,maximum:25}},additionalProperties:false},access:{scopes:['organization'],permissions:['view_projects']},read:async(ctx,ref)=>{
  const {searchPlatformProjectsAndContacts}=await import('../api.js');const found=await searchPlatformProjectsAndContacts(ctx.organizationId,{query:String(object(ref.args).query||''),types:'projects',limit:Number(object(ref.args).limit||12)});
  return {value:{results:found.results.map(row=>({id:String(row.project_id||row.id),title:String(row.title||''),subtitle:String(row.subtitle||'')}))}};
 }},
 lists:{description:'Project scope material, labor and equipment lists for reusable widgets.',schema:{type:'object',properties:{lists:{type:'array',items:listSchema}},required:['lists'],additionalProperties:false},schemaVersion:'1',access:projectPolicy,read:async(ctx,ref)=>({value:{lists:projectLists(await listProjectMaterialLists(ctx.organizationId,ref.target.projectId!))}})},
 measurements:{description:'Effective scope measurements, including saved proposal/list measurements and the selected dataset.',schema:{type:'object',properties:{rows:{type:'array',items:rowSchema}},required:['rows'],additionalProperties:false},schemaVersion:'1',access:projectPolicy,read:async(ctx,ref)=>{
  const project=await readDocument(ctx.organizationId,'projects',ref.target.projectId!);const lists=await listProjectMaterialLists(ctx.organizationId,ref.target.projectId!);let report:Obj={};
  const {effectiveProjectMeasurements}=await import('../publication/firstmeasure-datasets.js');
  // Independently authorize the selected dataset or linked report; never turn denial into zero quantities.
  if(object(object(project.data).dataset_defaults).measurements){
    const selected=await effectiveProjectMeasurements(ctx,ref.target.projectId!);
    if(selected.status==='ready')for(const [k,v]of Object.entries(object(object(selected.value).measurements)))report[k]=object(v).value;
  }else if(linkedReport(object(project.data))){
    await authorizeSource(ctx,{provider:'project-widgets',export:'report',target:ref.target});
    const saved=await reportFor(ctx,ref);
    if(saved){const {readFirstMeasureMeasurements}=await import('../publication/firstmeasure-datasets.js');const values=await readFirstMeasureMeasurements(saved.manifest);for(const [k,v]of Object.entries(values.measurements))report[k]=object(v).value;}
  }
  return {value:{rows:measurementRows(scopeData.measurements(object(project.data),lists,report))}};
 }},
 report:{description:'Completed report roof geometry reference and the aerial selected for the report, with reference media.',schema:{type:'object',properties:{reportId:string,xmlUrl:string,media:{type:'array',items:mediaSchema}},required:['reportId','xmlUrl','media'],additionalProperties:false},schemaVersion:'1',access:{...projectPolicy,permissions:['view_reports'],capabilities:[]},read:async(ctx,ref)=>{
  const report=await reportFor(ctx,ref);if(!report)return {status:'missing',code:'widget_report_unavailable',message:'No completed report is available for this project.'};
  const detail=await report.storage.getProjectDetail(report.id);const files=detail.files;
  const artifact=(name:string)=>`/v1/firstmeasure/projects/${encodeURIComponent(report.id)}/artifacts/${encodeURIComponent(name)}`;
  const image=object(detail.pdf_state).solarImg;const media:{url:string;label:string;video:boolean}[]=[];
  if(typeof image==='string'&&/^data:image\/(jpeg|png|webp);base64,/i.test(image))media.push({url:image,label:'Aerial view',video:false});
  for(const file of files)if(/^customer-reference-.*\.(jpg|jpeg|png|webp|mp4|mov|webm)$/i.test(file.name))media.push({url:artifact(file.name),label:'Reference media',video:/\.(mp4|mov|webm)$/i.test(file.name)});
  return {value:{reportId:report.id,xmlUrl:files.some(f=>f.name==='model_data.xml')?artifact('model_data.xml'):'',media}};
 }}
}});}
