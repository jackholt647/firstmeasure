import { randomUUID } from "node:crypto";
import { readDocument, listDocuments, upsertDocument } from "../storage.js";
import { badRequest, conflict, forbidden, PlatformError } from "../errors.js";
import type { JsonSchema, PublicationContext, TargetRef, SourceRef } from "./contracts.js";
import { authorizePublication } from "./context.js";
import { contentHash, jsonClone, validateJson } from "./validation.js";
import { registerDataProvider } from "./providers.js";
import { assertSafeTenantSchema } from "./tenant-schema.js";

type Obj=Record<string,unknown>;
export type DatasetType={id:string;version:string;schema:JsonSchema;description:string};
const types=new Map<string,DatasetType>();
export function registerDatasetType(type:DatasetType){const key=`${type.id}@${type.version}`;if(types.has(key))throw badRequest("dataset_type_duplicate","Dataset type already registered.");types.set(key,type);}
export function listDatasetTypes(){return [...types.values()].map(jsonCloneType);}
function jsonCloneType(t:DatasetType){return jsonClone(t);}
const readAccess={scopes:["project"] as const,permissions:["view_project_data"],systemKinds:["work","module","agent"] as const};
const writeAccess={scopes:["project"] as const,permissions:["manage_project_data"],systemKinds:["work","module"] as const};
type Revision={revision:string;value:unknown;provenance:Obj;createdAt:string;overrides:Obj};
type Dataset={id:string;projectId:string;name:string;type:string;schemaVersion:string;role:string;head:string;history:Revision[];valueSchema?:JsonSchema};
function obj(v:unknown):Obj{return v&&typeof v==="object"&&!Array.isArray(v)?v as Obj:{};}
async function row(ctx:PublicationContext,target:TargetRef){
  if(!target.id)throw badRequest("dataset_id_required","Dataset identity is required.");
  const r=await readDocument(ctx.organizationId,"project_datasets",target.id);
  const d=r.data as unknown as Dataset;
  if(d.projectId!==target.projectId)throw forbidden("dataset_project_denied","Dataset belongs to another project.");
  return {r,d};
}
export async function authorizeDataset(ctx:PublicationContext,target:TargetRef){await row(ctx,target);}
function registered(type:string,version:string){const t=types.get(`${type}@${version}`);if(!t)throw badRequest("dataset_type_unknown","Register the dataset schema before storing values.");return t;}
export type DatasetWrite={id?:string;name:string;type:string;schemaVersion:string;role?:string;value:unknown;valueSchema?:JsonSchema;provenance?:Obj;overrides?:Obj;expectedRevision?:number};
/** History and current value commit in one optimistic store update; failed writes cannot expose partial history. */
export async function saveProjectDataset(ctx:PublicationContext,target:TargetRef,input:DatasetWrite){
  await authorizePublication(ctx,target,writeAccess,"datasets.save");
  if(ctx.mode!=="command")throw forbidden("dataset_write_mode","Dataset writes require command execution.");
  await readDocument(ctx.organizationId,"projects",target.projectId!);
  const type=registered(input.type,input.schemaVersion);validateJson(type.schema,input.value,"dataset");
  if(!input.name.trim())throw badRequest("dataset_name_required","A dataset name is required.");
  const id=input.id||target.id||`dataset_${randomUUID()}`;
  let previous:Awaited<ReturnType<typeof row>>|undefined;
  if(input.id||target.id){
    try{previous=await row(ctx,{...target,id});}catch(error){if(!(error instanceof PlatformError&&error.statusCode===404&&!input.expectedRevision))throw error;}
    if(previous&&(!input.expectedRevision||Number(previous.r.revision)!==input.expectedRevision))throw conflict("revision_conflict","Dataset revision does not match.");
  }
  if(previous&&(previous.d.type!==input.type||previous.d.schemaVersion!==input.schemaVersion))throw badRequest("dataset_type_immutable","Create a new dataset for a different schema.");
  const valueSchema=input.valueSchema||previous?.d.valueSchema;
  if(valueSchema){if(input.type!=="generic")throw badRequest("dataset_schema_specialized","Specialized datasets use their registered schema.");assertSafeTenantSchema(valueSchema);validateJson(valueSchema,input.value,"custom dataset");}
  if(previous&&contentHash(valueSchema||{})!==contentHash(previous.d.valueSchema||{}))throw badRequest("dataset_schema_immutable","Create a new dataset for a different value schema.");
  const value=jsonClone(input.value);const overrides=jsonClone(input.overrides??previous?.d.history.at(-1)?.overrides??{});
  if(input.type==="measurements")validateJson({type:"object",additionalProperties:measurementValue},overrides,"measurement overrides");
  else if(Object.keys(overrides).length)throw badRequest("dataset_override_unsupported","This dataset type has no declared override schema.");
  const provenance=jsonClone(input.provenance||{});
  const revision=`sha256:${contentHash({value,overrides,provenance})}`;
  const entry:Revision={revision,value,overrides,provenance,createdAt:new Date().toISOString()};
  const data:Dataset={id,projectId:target.projectId!,name:input.name.trim(),type:input.type,schemaVersion:input.schemaVersion,role:input.role||previous?.d.role||"",head:revision,history:[...(previous?.d.history||[]),entry],...(valueSchema?{valueSchema:jsonClone(valueSchema)}:{})};
  const saved=await upsertDocument(ctx.organizationId,"project_datasets",{id,data,expected_revision:input.expectedRevision},{replace:true,createOnly:!previous});
  return {id,revision,storeRevision:saved.revision};
}
export async function readProjectDataset(ctx:PublicationContext,target:TargetRef,revision?:string){
  await authorizePublication(ctx,target,readAccess,"datasets.value");
  const {r,d}=await row(ctx,target);const selected=revision?d.history.find(h=>h.revision===revision):d.history.at(-1);
  if(!selected)throw badRequest("dataset_revision_unavailable","Dataset revision is unavailable.");
  const schema=registered(d.type,d.schemaVersion).schema;validateJson(schema,selected.value,"stored dataset");
  if(d.valueSchema){assertSafeTenantSchema(d.valueSchema);validateJson(d.valueSchema,selected.value,"stored custom dataset");}
  const value=d.type==="measurements"?{...obj(selected.value),measurements:{...obj(obj(selected.value).measurements),...selected.overrides}}:selected.value;
  validateJson(schema,value,"effective dataset");
  return {id:d.id,name:d.name,type:d.type,schemaVersion:d.schemaVersion,role:d.role,storeRevision:r.revision,...selected,value};
}
export async function listProjectDatasets(ctx:PublicationContext,target:TargetRef){
  await authorizePublication(ctx,target,readAccess,"datasets.value");
  return (await listDocuments(ctx.organizationId,"project_datasets")).filter(r=>obj(r.data).projectId===target.projectId).map(r=>{const d=r.data as unknown as Dataset;return {id:r.id,name:d.name,type:d.type,schemaVersion:d.schemaVersion,role:d.role,revision:d.head,storeRevision:r.revision};}).sort((a,b)=>a.id.localeCompare(b.id));
}
/** Role defaults reside on the project, avoiding competing per-dataset boolean defaults. */
export async function selectProjectDataset(ctx:PublicationContext,target:TargetRef,role:string,datasetId:string,expectedProjectRevision:number){
  await authorizePublication(ctx,target,writeAccess,"datasets.select");
  if(ctx.mode!=="command")throw forbidden("dataset_write_mode","Dataset selection requires command execution.");
  if(!/^[a-z][a-z0-9_.-]*$/.test(role))throw badRequest("dataset_role_invalid","A stable role name is required.");
  const selected=await row(ctx,{...target,id:datasetId});
  if(role==="measurements"&&selected.d.type!=="measurements")throw badRequest("dataset_role_type","The measurement role requires a measurement dataset.");
  const project=await readDocument(ctx.organizationId,"projects",target.projectId!);
  if(!expectedProjectRevision||project.revision!==expectedProjectRevision)throw conflict("revision_conflict","Project revision does not match.");
  return upsertDocument(ctx.organizationId,"projects",{id:target.projectId,expected_revision:expectedProjectRevision,data:{dataset_defaults:{...obj(obj(project.data).dataset_defaults),[role]:datasetId}}});
}
const measurementValue:JsonSchema={type:"object",required:["value","unit"],properties:{value:{type:["number","null"]},unit:{type:"string",minLength:1},status:{enum:["ready","missing","pending"]},source:{type:"string"}},additionalProperties:false};
export const measurementDatasetSchema:JsonSchema={type:"object",required:["measurements"],properties:{measurements:{type:"object",additionalProperties:measurementValue},artifacts:{type:"array",items:{type:"object",required:["id","kind"],properties:{id:{type:"string"},kind:{type:"string"},sourceRevision:{type:"string"}},additionalProperties:false}}},additionalProperties:false};
export const inventoryDatasetSchema:JsonSchema={type:"object",required:["items"],properties:{items:{type:"array",items:{type:"object",required:["id","name","quantity"],properties:{id:{type:"string"},name:{type:"string"},quantity:{type:"number",minimum:0},volume:{type:"number",minimum:0},volumeUnit:{type:"string"},room:{type:"string"}},additionalProperties:false}}},additionalProperties:false};
registerDatasetType({id:"measurements",version:"1",schema:measurementDatasetSchema,description:"Unit-aware project measurements with original artifact links."});
registerDatasetType({id:"inventory",version:"1",schema:inventoryDatasetSchema,description:"Items and optional volume for inventories and cube sheets."});
registerDatasetType({id:"generic",version:"1",schema:{type:["object","array"]},description:"Named structured project data for custom applications; use a registered specialization for stronger validation."});
/** Import normalized producer values, never infer units or turn segment counts into lengths. Manual overrides survive reimports. */
export async function importMeasurementDataset(ctx:PublicationContext,target:TargetRef,input:Omit<DatasetWrite,"type"|"schemaVersion">){return saveProjectDataset(ctx,target,{...input,type:"measurements",schemaVersion:"1"});}
let registeredProvider=false;
export function registerDatasetProvider(){if(registeredProvider)return;registeredProvider=true;registerDataProvider({id:"datasets",version:"1",apps:["measurements","documents","crew"],exports:{contract:{description:"Dataset name, type and actual value schema.",schema:{type:"object",required:["name","type","schemaVersion","schema"]},schemaVersion:"1",access:{...readAccess,authorize:authorizeDataset},read:async(ctx,ref)=>{const {r,d}=await row(ctx,ref.target);return {value:{name:d.name,type:d.type,schemaVersion:d.schemaVersion,schema:d.valueSchema||registered(d.type,d.schemaVersion).schema},revision:String(r.revision)};}},value:{description:"Typed project dataset with retained historical revisions.",schema:{},schemaVersion:"1",historical:true,access:{...readAccess,authorize:async(ctx,target)=>{if(target.id)await authorizeDataset(ctx,target);}},read:async(ctx,ref)=>{const d=await readProjectDataset(ctx,ref.target,ref.revision);return {value:d.value,revision:d.revision,provenance:{...d.provenance,datasetId:d.id,type:d.type,schemaVersion:d.schemaVersion,overrides:d.overrides}};},list:async(ctx,ref,page)=>{
  const rows=await listProjectDatasets(ctx,ref.target);const signature=contentHash({target:ref.target,rows});let offset=0;
  if(page.cursor){try{const cursor=JSON.parse(Buffer.from(page.cursor,"base64url").toString());if(cursor.signature!==signature||!Number.isInteger(cursor.offset)||cursor.offset<0)throw Error();offset=cursor.offset;}catch{throw badRequest("dataset_cursor_invalid","The dataset list changed or its cursor is invalid.");}}
  const items=rows.slice(offset,offset+page.limit);return {items,...(offset+items.length<rows.length?{nextCursor:Buffer.from(JSON.stringify({signature,offset:offset+items.length})).toString("base64url")}: {})};
}}}});}
