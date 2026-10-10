import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import { badRequest, PlatformError } from '../platform/errors.js';
import { readPublishedData, listPublishedData } from '../platform/publication/providers.js';
import { contentHash, readPointer } from '../platform/publication/validation.js';
import type { DataResult, PublicationContext, SourceRef, TargetRef } from '../platform/publication/contracts.js';

const id = z.string().min(1).max(200);
export const fieldSourceSchema = z.object({provider:id, version:id.optional(), export:id,
  target:z.object({scope:z.enum(['project','organization','global']),organizationId:id.optional(),projectId:id.optional(),branchId:id.optional(),id:id.optional()}).strict(),
  args:z.record(z.unknown()).optional(),path:z.string().max(2000).optional(),revision:id.optional()}).strict();
export const selectionSchema = z.object({where:z.record(z.union([z.string(),z.number(),z.boolean(),z.null()])).default({}),orderBy:z.string().max(100).default('id'),direction:z.enum(['asc','desc']).default('asc'),pick:z.enum(['first','all']).default('first')}).strict();
export type Calculation = {op:'source';source:SourceRef;select?:z.infer<typeof selectionSchema>}
  | {op:'literal';value:string|number|boolean|null}
  | {op:'first'|'sum'|'product'|'difference'|'quotient';inputs:Calculation[];missing?:'skip'|'propagate'};
const expression:z.ZodType<Calculation,z.ZodTypeDef,unknown> = z.lazy(()=>z.discriminatedUnion('op',[
  z.object({op:z.literal('source'),source:fieldSourceSchema,select:selectionSchema.optional()}).strict(),
  z.object({op:z.literal('literal'),value:z.union([z.string(),z.number().finite(),z.boolean(),z.null()])}).strict(),
  z.object({op:z.enum(['first','sum','product','difference','quotient']),inputs:z.array(expression).min(1).max(32),missing:z.enum(['skip','propagate']).optional()}).strict()
]));
export function normalizeCalculation(input:unknown):Calculation {
  const visit=(v:any,depth=0,count={n:0})=>{if(depth>12 || ++count.n>128)throw badRequest('field_calculation_limit','Calculations support at most 128 nodes and 12 levels.');for(const child of Array.isArray(v?.inputs)?v.inputs:[])visit(child,depth+1,count);};
  visit(input);
  const parsed=expression.safeParse(input);
  if(!parsed.success)throw badRequest('field_calculation_invalid','Choose published sources and a supported field calculation.');
  return parsed.data;
}
export function bindFieldSource(source:SourceRef,ctx:PublicationContext,target:TargetRef):SourceRef {
  const tokens:Record<string,string|undefined>={'$organization':ctx.organizationId,'$project':target.projectId,'$branch':target.branchId || ctx.branchId};
  const bound={...source,target:{...source.target}};
  for(const key of ['organizationId','projectId','branchId','id'] as const){const value=bound.target[key];if(value?.startsWith('$')){if(!tokens[value])throw badRequest('field_source_context','The selected source needs a context that is unavailable here.');bound.target[key]=tokens[value];}}
  if(bound.target.scope!=='global')bound.target.organizationId ||= ctx.organizationId;
  if(bound.target.scope==='project')bound.target.projectId ||= target.projectId;
  return bound;
}
type Ready=Extract<DataResult,{status:'ready'}>;
const sessions=new AsyncLocalStorage<{cache:Map<string,Promise<DataResult>>;reads:number;nodes:number}>();
export function inCalculationSession<T>(run:()=>Promise<T>):Promise<T>{return sessions.getStore()?run():sessions.run({cache:new Map(),reads:0,nodes:0},run);}
function budget(kind:'reads'|'nodes') {const session=sessions.getStore();if(session && ++session[kind]>(kind==='reads'?128:512))throw badRequest('field_calculation_budget','This display exceeds its bounded field evaluation budget.');}
function fail(result:Exclude<DataResult,Ready>):never {throw new PlatformError(result.code,result.status==='denied'?403:result.status==='missing'?404:result.status==='pending'?409:400,result.message,{publicationStatus:result.status});}
export async function evaluateCalculation(input:Calculation,ctx:PublicationContext,target:TargetRef,evidence:Ready[]):Promise<unknown> {
  budget('nodes');
  const read=async(ref:SourceRef)=>{
    // Cache a whole export within this read only, so selected subfields share a revision.
    const whole={...ref};delete whole.path;const key=contentHash(whole),cache=sessions.getStore()?.cache,identity='calculation-source:'+key;
    if(ctx.dependencyPath?.includes(identity) || (ctx.dependencyPath?.length || 0)>32)throw badRequest('custom_field_formula_cycle','Published calculated fields contain a cycle or exceed the dependency limit.');
    let promise=cache?.get(key);if(!promise){budget('reads');promise=readPublishedData({...ctx,dependencyPath:[...(ctx.dependencyPath || []),identity]},whole);cache?.set(key,promise);}
    const result=await promise;if(result.status!=='ready'){if(result.status==='missing')return undefined;fail(result);}
    const value=readPointer(result.value,ref.path);evidence.push({...result,source:{...result.source,...(ref.path?{path:ref.path}:{})},value:value ?? null});
    return value;
  };
  if(input.op==='literal')return input.value;
  if(input.op==='source'){
    const ref=bindFieldSource(input.source,ctx,target);
    if(!input.select)return read(ref);
    const listRef={...ref};delete listRef.path;delete listRef.revision;
    const rows:Record<string,unknown>[]=[];let cursor:string|undefined;let pages=0;
    do {
      budget('reads');
      const result=await listPublishedData(ctx,listRef, {limit:200,...(cursor?{cursor}:{})});
      if(result.status!=='ready'){if(result.status==='missing')return undefined;fail(result);}
      for(const raw of result.items)if(raw && typeof raw==='object' && !Array.isArray(raw))rows.push(raw as Record<string,unknown>);
      cursor=result.nextCursor;if(cursor && ++pages>=5)throw badRequest('field_selection_limit','Source selection exceeds 1,000 records; narrow the source.');
    }while(cursor);
    const {where,orderBy,direction,pick}=input.select;
    const selected=rows.filter(row=>Object.entries(where).every(([k,v])=>Object.hasOwn(row,k)&&row[k]===v));
    selected.sort((a,b)=>{const av=a[orderBy],bv=b[orderBy];const compare=typeof av==='number'&&typeof bv==='number'?av-bv:String(av??'').localeCompare(String(bv??''));return (direction==='desc'?-compare:compare)||String(a.id).localeCompare(String(b.id));});
    const matches=pick==='first'?selected.slice(0,1):selected;
    const values=[];
    for(const row of matches){if(typeof row.id!=='string')throw badRequest('field_selection_identity','Selected exports must publish a stable id.');values.push(await read({...ref,target:{...ref.target,id:row.id}}));}
    return pick==='first'?values[0]:values;
  }
  const values:unknown[]=[];
  for(const child of input.inputs){const value=await evaluateCalculation(child,ctx,target,evidence);if(input.op==='first' && value!==undefined && value!==null && value!=='')return value;values.push(...(Array.isArray(value)?value:[value]));}
  if(input.op==='first')return undefined;
  const present=values.filter(v=>v!==undefined&&v!==null&&v!=='');
  if(input.missing!=='skip' && present.length!==values.length || !present.length)return undefined;
  if(present.some(v=>typeof v!=='number'||!Number.isFinite(v)))throw badRequest('field_calculation_type','Arithmetic requires numeric published fields in compatible units.');
  const numbers=present as number[];
  const result=input.op==='sum'?numbers.reduce((a,b)=>a+b,0):input.op==='product'?numbers.reduce((a,b)=>a*b,1):input.op==='difference'?numbers.slice(1).reduce((a,b)=>a-b,numbers[0]!):numbers.slice(1).reduce((a,b)=>a/b,numbers[0]!);
  if(!Number.isFinite(result))throw badRequest('field_calculation_nonfinite','The calculation produced an invalid number.');
  return result;
}
