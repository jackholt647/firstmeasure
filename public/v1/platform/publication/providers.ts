import type { AccessPolicy, DataResult, JsonSchema, PublicationContext, SourceRef } from "./contracts.js";
import { authorizePublication } from "./context.js";
import { badRequest, PlatformError } from "../errors.js";
import { contentHash, jsonClone, readPointer, validateJson } from "./validation.js";
import { publishedDataPermission } from "./permission-bundles.js";

export type ProviderValue = { value: unknown; revision?: string; provenance?: Record<string, unknown> } | Exclude<DataResult, {status:"ready"}>;
export type DataExport = {
  schema: JsonSchema; schemaVersion: string; argsSchema?: JsonSchema; access: AccessPolicy;
  listItemSchema?: JsonSchema;
  authorizeRef?: (ctx:PublicationContext,ref:SourceRef)=>Promise<void>|void;
  authorizeSnapshot?: (ctx:PublicationContext,ref:SourceRef,result:Extract<DataResult,{status:"ready"}>)=>Promise<void>|void;
  description: string; units?: Record<string,string>; historical?: boolean;
  read: (ctx: PublicationContext, ref: SourceRef) => Promise<ProviderValue>;
  list?: (ctx: PublicationContext, ref: SourceRef, page: {limit:number;cursor?:string}) => Promise<{items:unknown[];nextCursor?:string}>;
};
export type DataProvider = { id:string; version:string; apps: string[]; exports:Record<string,DataExport> };
const registry = new Map<string,DataProvider>();
export function registerDataProvider(provider:DataProvider):void {
  provider={...provider,exports:Object.fromEntries(Object.entries(provider.exports).map(([name,entry])=>{
    const permission=publishedDataPermission(`${provider.id}.${name}`);
    return [name,permission===undefined?entry:{...entry,access:{...entry.access,permissions:permission?[permission]:[]}}];
  }))};
  if (!/^[a-z][a-z0-9_.-]*$/.test(provider.id) || !provider.version || !Object.keys(provider.exports).length) throw badRequest("provider_invalid","Provider identity and exports are required.");
  const key = `${provider.id}@${provider.version}`;
  if (registry.has(key)) throw badRequest("provider_duplicate","Provider version already registered.");
  const freeze=<T>(v:T):T=>{if(v&&typeof v==="object"){for(const item of Object.values(v))freeze(item);Object.freeze(v);}return v;};
  registry.set(key,Object.freeze({...provider,apps:Object.freeze([...provider.apps]) as unknown as string[],exports:Object.freeze(Object.fromEntries(Object.entries(provider.exports).map(([name,e])=>[name,Object.freeze({...e,schema:freeze(jsonClone(e.schema)),...(e.argsSchema?{argsSchema:freeze(jsonClone(e.argsSchema))}:{}),...(e.listItemSchema?{listItemSchema:freeze(jsonClone(e.listItemSchema))}:{}),access:Object.freeze({...e.access,scopes:Object.freeze([...e.access.scopes]),permissions:Object.freeze([...e.access.permissions]),...(e.access.systemKinds?{systemKinds:Object.freeze([...e.access.systemKinds])}:{}),...(Array.isArray(e.access.applications)?{applications:Object.freeze([...e.access.applications])}:{}),...(e.access.capabilities?{capabilities:Object.freeze([...e.access.capabilities])}:{})})})])))}));
}
function resolve(ref:SourceRef) {
  const versions = [...registry.values()].filter(p=>p.id===ref.provider);
  const provider = ref.version ? registry.get(`${ref.provider}@${ref.version}`) : versions.at(-1);
  const exported = provider&&Object.hasOwn(provider.exports,ref.export)?provider.exports[ref.export]:undefined;
  if (!provider || !exported) throw badRequest("source_unknown","Unknown published source or version.");
  return {provider,exported};
}
function descriptor(p:DataProvider) {
  return {id:p.id,version:p.version,apps:[...p.apps],exports:Object.fromEntries(Object.entries(p.exports).map(([id,e])=>[id,{schema:e.schema,schemaVersion:e.schemaVersion,argsSchema:e.argsSchema||{type:"object",additionalProperties:false},description:e.description,units:e.units||{},historical:!!e.historical,listable:!!e.list,access:{scopes:e.access.scopes,permissions:e.access.permissions,capabilities:e.access.capabilities||[],applications:e.access.applications??["management"],...(e.access.applicationPermission?{applicationPermission:e.access.applicationPermission}: {})}}]))};
}
export function listDataProviders(){return [...registry.values()].map(descriptor);}
export function describeDataProvider(id:string,version?:string){const p=[...registry.values()].filter(p=>p.id===id&&(!version||p.version===version)).at(-1);return p?descriptor(p):null;}
/** Also used for frozen replay: authorize without refetching mutable values. */
export async function authorizeSource(ctx:PublicationContext,ref:SourceRef):Promise<void>{
  const {exported}=resolve(ref);
  await authorizePublication(ctx,ref.target,exported.access,`${ref.provider}.${ref.export}`);
  await exported.authorizeRef?.(ctx,ref);
}
export async function authorizeSourceSnapshot(ctx:PublicationContext,ref:SourceRef,result:Extract<DataResult,{status:"ready"}>):Promise<void>{
  await authorizeSource(ctx,ref);
  await resolve(ref).exported.authorizeSnapshot?.(ctx,ref,result);
}
function failure(error:unknown):Exclude<DataResult,{status:"ready"}>{
  if(error instanceof PlatformError)return {status:error.statusCode===401||error.statusCode===403?"denied":error.statusCode===404?"missing":"error",code:error.code,message:error.message};
  return {status:"error",code:"source_failed",message:"The published source could not be read."};
}
export async function readPublishedData(ctx:PublicationContext,ref:SourceRef):Promise<DataResult>{
  try{
    const {provider,exported}=resolve(ref);
    await authorizeSource(ctx,ref);
    validateJson(exported.argsSchema||{type:"object",additionalProperties:false},ref.args||{},"source arguments");
    const result=await exported.read(ctx,ref);
    if("status" in result)return result;
    const whole=jsonClone(result.value);
    validateJson(exported.schema,whole,"source export");
    const revision=result.revision||`sha256:${contentHash(whole)}`;
    if(ref.revision&&ref.revision!==revision)return {status:"error",code:"source_revision_unavailable",message:"The requested source revision is unavailable."};
    const value=readPointer(whole,ref.path);
    if(value===undefined)return {status:"missing",code:"source_path_missing",message:"The published field is absent."};
    return {status:"ready",value,source:{...jsonClone(ref),version:provider.version,revision},schemaVersion:exported.schemaVersion,capturedAt:new Date().toISOString(),provenance:jsonClone(result.provenance||{})};
  }catch(error){return failure(error);}
}
export async function listPublishedData(ctx:PublicationContext,ref:SourceRef,page:{limit?:number;cursor?:string}={}):Promise<{status:"ready";items:unknown[];nextCursor?:string}|Exclude<DataResult,{status:"ready"}>>{
  try{
    const {exported}=resolve(ref);await authorizeSource(ctx,ref);
    if(!exported.list)throw badRequest("source_not_listable","This export cannot be listed.");
    if(ref.path||ref.revision)throw badRequest("source_list_selector","List requests cannot select a value path or revision.");
    validateJson(exported.argsSchema||{type:"object",additionalProperties:false},ref.args||{},"source arguments");
    const limit=page.limit??50;
    if(!Number.isInteger(limit)||limit<1||limit>200)throw badRequest("source_page_limit","Page limit must be between 1 and 200.");
    const result=await exported.list(ctx,ref,{limit,cursor:page.cursor});
    if(result.items.length>limit)throw badRequest("source_page_overflow","Provider exceeded its page limit.");
    const itemSchema=exported.listItemSchema||(exported.schema.type==="array"?exported.schema.items as JsonSchema:exported.schema);
    for(const item of result.items)validateJson(itemSchema,item,"listed source item");
    return {status:"ready",...jsonClone(result)};
  }catch(error){return failure(error);}
}
