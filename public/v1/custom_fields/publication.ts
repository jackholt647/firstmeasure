import { registerDataProvider } from "../platform/publication/providers.js";
import { authorizeSourceSnapshot } from '../platform/publication/providers.js';
import { contentHash } from '../platform/publication/validation.js';
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { forbidden, PlatformError } from "../platform/errors.js";
import { canReadField, readFieldRecord, readFields, writeFields } from "./records.js";
import { FIELD_HOMES, FIELD_OWNERS, homeKindOf, type FieldEntity } from "./owners.js";
import { homeDefinitions, homeIndex, homeNames, placeDefinition, recordHomes, saveHomeDefinitions, unassignedDefinitions } from "./homes.js";
import { types, isManuallyEditableType } from "./contracts.js";
import { resolvePlatformPhone } from "./platform-phone.js";
import type { AccessPolicy, SourceRef, PublicationContext } from "../platform/publication/contracts.js";
import type { JsonObject } from "../platform/storage.js";

const HOME_KINDS = Object.keys(FIELD_HOMES);
const HOME_REF = {type:"object",required:["kind","id","name"],properties:{kind:{type:"string",enum:HOME_KINDS},id:{type:"string"},name:{type:"string"}},additionalProperties:false};
const FIELD_ROWS = {type:"array",items:{type:"object",required:["path","type"],properties:{path:{type:"string"},type:{type:"string"},label:{type:"string"}},additionalProperties:true}};
const RESOLVED_SCHEMA = {type:"object",required:["entity","id","recordRevision","homes","unassigned","fields","values"],properties:{
  entity:{type:"string"},id:{type:"string"},recordRevision:{type:"integer",minimum:0},
  homes:{type:"array",items:{type:"object",required:["kind","id","name","fields"],properties:{...HOME_REF.properties,fields:{type:"array",items:{type:"string"}}},additionalProperties:false}},
  unassigned:{type:"array",items:{type:"string"}},
  fields:{type:"array",items:{type:"object",required:["path","type","homes","writable"],properties:{path:{type:"string"},type:{type:"string"},homes:{type:"array",items:HOME_REF},writable:{type:"boolean"}},additionalProperties:true}},
  values:{type:"object",additionalProperties:true}
},additionalProperties:false};
const HOME_ARGS = {type:"object",required:["kind","id"],properties:{kind:{type:"string",enum:HOME_KINDS},id:{type:"string",minLength:1,maxLength:180}},additionalProperties:false};
const HOME_SAVED = {type:"object",required:["kind","id","revision","count"],properties:{kind:{type:"string",enum:HOME_KINDS},id:{type:"string"},revision:{type:"string"},count:{type:"integer",minimum:0}},additionalProperties:false};

/** One record's fields with the home each comes from. A field two homes declare is listed under both. */
async function resolvedValue(ctx:PublicationContext,entity:FieldEntity,state:Awaited<ReturnType<typeof readFields>>) {
  const kind = homeKindOf(entity)!, names = await homeNames(ctx.organizationId,kind);
  const named = (home:any) => ({kind:String(home.kind),id:String(home.id),name:names.get(String(home.id)) || String(home.id)});
  const fields = (state.contract as JsonObject[]).map((f,index)=>({f,index})).sort((a,b)=>Number(a.f.order ?? a.index) - Number(b.f.order ?? b.index) || a.index - b.index).map(({f}):JsonObject & {homes:{kind:string,id:string,name:string}[]}=>({...f,homes:(Array.isArray(f.homes) && f.homes.length ? f.homes : f.home ? [f.home] : []).map(named)}));
  const order = (await recordHomes(ctx.organizationId,entity,state.record))?.ids || [];
  // A home lists its fields in the order that home gave them, also where another home's definition is the one shown.
  const position = new Map<string,Map<string,number>>();
  for (const f of state.contract as JsonObject[]) for (const home of (Array.isArray(f.homes) && f.homes.length ? f.homes : f.home ? [{...(f.home as JsonObject),order:f.order}] : []) as JsonObject[]) {
    const id = String(home.id);
    position.set(id,(position.get(id) || new Map<string,number>()).set(String(f.path),Number(home.order ?? 0)));
  }
  const homes = order.map(id=>{
    const own = position.get(id) || new Map<string,number>();
    return {...named({kind,id}),fields:fields.map((f,index)=>({path:String(f.path),index})).filter(entry=>own.has(entry.path)).sort((a,b)=>own.get(a.path)! - own.get(b.path)! || a.index - b.index).map(entry=>entry.path)};
  }).filter(home=>home.fields.length);
  return {entity,id:String(state.record.id || state.id),recordRevision:Number(state.row?.revision || 0),homes,unassigned:fields.filter(f=>!f.homes.length).map(f=>String(f.path)),fields,values:state.values};
}

let registered = false;
export function registerCustomFieldPublication() {
  if (registered) return; registered = true;

  registerDataProvider({id:"custom-fields-catalog",version:"1",apps:["settings"],exports:{contract:{description:"Shared owner and variable type catalog for frontend integrations.",schema:{type:"object",additionalProperties:true},schemaVersion:"1",access:{scopes:["organization"],permissions:["manage_company_settings"],systemKinds:["work","module","agent"]},read:async()=>({value:{owners:FIELD_OWNERS,types:types.map(type=>({type,...(type === "platform_phone"?{baseType:"phone",producer:"phone-system",manuallyEditable:false,description:"A phone number issued by the platform."}:{manuallyEditable:isManuallyEditableType(type)})}))},revision:"1"})}}});
  for (const entity of Object.keys(FIELD_OWNERS) as FieldEntity[]) {
    const access: AccessPolicy = { scopes:entity === "project" ? ["project"] : entity === "contact" ? ["project", "organization"] : ["organization"], permissions:[FIELD_OWNERS[entity].readPermission], systemKinds:["work","module","agent"] };
    const provider = `custom-fields-${entity}`;
    const argsSchema = { type:"object", properties:{ field:{type:"string",minLength:1,maxLength:780} }, additionalProperties:false };
    const resolve = (ctx:PublicationContext,ref:SourceRef) => readFields(ctx,ref.target,entity,ref.args?.field as string | undefined, ref.export === "contract",ref.export === "phones");
    registerDataProvider({ id:provider, version:"1", apps:[entity === "project" ? "projects" : entity === "contact" ? "contacts" : "settings"], exports:Object.fromEntries(["contract","values","phones",...(homeKindOf(entity) ? ["resolved"] : [])].map(name => [name, {
      schema:name === "phones" ? {type:"array",items:{type:"object",additionalProperties:true}} : name === "resolved" ? RESOLVED_SCHEMA : {type:"object",additionalProperties:true}, schemaVersion:"1", argsSchema, access,
      description:name === "resolved" ? `The fields one ${entity} has: each definition with the roles, types or department it comes from, grouped by that home, and the values. Values of fields the ${entity} no longer has are kept and not returned.` : `${entity} custom ${name === "contract" ? "field definitions, nested schemas, access and record revision" : "field values, including read-only and background variables"}. Optional args.field selects a declared dotted field path. Private fields require their read permission.`,
      authorizeSnapshot:async(ctx:PublicationContext,ref:SourceRef,result:any) => {
        const identity=`snapshot:${contentHash(ref)}`;
        if(ctx.dependencyPath?.includes(identity) || (ctx.dependencyPath?.length || 0)>32)throw forbidden('field_snapshot_cycle','Invalid calculated-field evidence.');
        const current = await readFieldRecord(ctx,ref.target,entity);
        for (const path of result.provenance.fieldPaths || []) {
          const f = current.fields.find(f => f.path === path);
          if (!f || !canReadField(ctx,f)) throw forbidden("custom_field_access_revoked","A captured field is no longer accessible.");
        }
        for (const ref of result.provenance.platformPhones || []) if(!(await resolvePlatformPhone(ctx.organizationId,ref)).available) throw forbidden("platform_phone_revoked","A captured platform phone is no longer issued to this organization.");
        for(const dependency of result.provenance.sourceEvidence || [])await authorizeSourceSnapshot({...ctx,dependencyPath:[...(ctx.dependencyPath || []),identity]},dependency.source,dependency);
      },
      read:async(ctx:PublicationContext,ref:SourceRef) => {
        let state;
        try { state = await resolve(ctx,ref); }
        catch(error){if(error instanceof PlatformError && (error.details as any)?.publicationStatus==='pending')return {status:'pending' as const,code:error.code,message:error.message};throw error;}
        return { value:name === "resolved" ? await resolvedValue(ctx,entity,state) : name === "contract" ? { entity, id:state.id, recordRevision:state.row?.revision || 0, fields:state.contract } : name === "phones" ? state.phones : state.values, revision:state.revision, provenance:{entity, id:state.id, fieldPaths:state.dependencies,sourceEvidence:state.sourceEvidence,platformPhones:state.phones.filter(p=>p.type === "platform_phone" && p.available).map(p=>({phone_number:p.phone_number,issuance_id:p.issuance_id}))} };
      }
    }])) });
  registerAction({id:`platform-phones.${entity}.assignment.set`,version:"1",implementation:backendImplementationDigest(),domain:"platform-phones",description:"Phone-system command: assign already issued organization phone numbers to a declared platform_phone field. Empty phoneNumbers unassigns; this never purchases, releases or routes numbers.",inputSchema:{type:"object",required:["field","phoneNumbers","expectedRevision"],properties:{field:{type:"string",minLength:1,maxLength:780},phoneNumbers:{type:"array",maxItems:100,uniqueItems:true,items:{type:"string",minLength:9,maxLength:16}},expectedRevision:{type:"integer",minimum:0}},additionalProperties:false},outputSchema:{type:"object",required:["id","revision"],properties:{id:{type:"string"},revision:{type:"integer"}},additionalProperties:false},policy:{...access,permissions:["manage_communications|manage_company_settings"],authorize:async(ctx,target)=>{await (await import("../platform/publication/context.js")).authorizePublication(ctx,target,{...access,permissions:[FIELD_OWNERS[entity].writePermission],systemKinds:[]},"platform-phone.owner");await readFieldRecord(ctx,target,entity);}},effect:"write",executionKinds:["api","agent","module","work"],idempotency:"required",execute:async(ctx,target,input)=>(await import("../comms/calls/field-assignments.js")).setPhoneFieldAssignment(ctx,target,{...input,entity})});
    registerAction({ id:`custom-fields.${entity}.write`, version:"1", implementation:backendImplementationDigest(), domain:"custom-fields",
      description:`Update declared writable ${entity} fields. values maps complete dotted field paths to replacement JSON values; dictionaries and arrays are replaced as a unit. Obtain expectedRevision from the contract export.`,
      inputSchema:{type:"object",required:["values","expectedRevision"],properties:{values:{type:"object",minProperties:1,maxProperties:256,additionalProperties:true},expectedRevision:{type:"integer",minimum:entity === "organization" || FIELD_OWNERS[entity].sidecar ? 0 : 1}},additionalProperties:false},
      outputSchema:{type:"object",required:["id","revision"],properties:{id:{type:"string"},revision:{type:"integer"}},additionalProperties:false},
      policy:{...access,permissions:[FIELD_OWNERS[entity].writePermission]},effect:"write",executionKinds:["api","agent","module","work"],idempotency:"required",
      execute:(ctx,target,input) => writeFields(ctx,target,entity,input)
    });
  }

  // Definitions of user, group, outside company and department fields are made on a home: one role, one group
  // type, one company type or one department. These reads and actions are the only way a home's list is edited.
  const homeAccess: AccessPolicy = { scopes:["organization"], permissions:["manage_company_settings"], systemKinds:["work","module","agent"] };
  registerDataProvider({ id:"custom-fields-homes", version:"1", apps:["settings"], exports:{
    index:{ description:"Every role, group type, company type and department that exists or holds field definitions, with its field count.", schemaVersion:"1", access:homeAccess,
      schema:{type:"object",required:["homes","entities"],properties:{homes:{type:"array",items:{type:"object",required:["kind","id","name","status","exists","fields"],properties:{...HOME_REF.properties,status:{type:"string"},exists:{type:["boolean","null"]},fields:{type:"integer",minimum:0}},additionalProperties:false}},entities:{type:"object",additionalProperties:{type:"string"}}},additionalProperties:false},
      read:async(ctx:PublicationContext) => { const value = await homeIndex(ctx.organizationId); return { value, revision:contentHash(value) }; } },
    definitions:{ description:"The field definitions made on one role, group type, company type or department, in order, with the revision to save against. args: kind and id.", schemaVersion:"1", access:homeAccess, argsSchema:HOME_ARGS,
      schema:{type:"object",required:["home","entity","revision","fields","retired"],properties:{home:{type:"object",required:["kind","id","name","exists"],properties:{...HOME_REF.properties,exists:{type:["boolean","null"]}},additionalProperties:false},entity:{type:"string"},revision:{type:"string"},fields:FIELD_ROWS,retired:FIELD_ROWS},additionalProperties:false},
      read:async(ctx:PublicationContext,ref:SourceRef) => { const value = await homeDefinitions(ctx.organizationId,ref.args?.kind,ref.args?.id); return { value, revision:contentHash(value) }; } },
    unassigned:{ description:"User, team, company and department field definitions that name no home. They apply to every record of their owner until placed. Optional args.entity narrows the list.", schemaVersion:"1", access:homeAccess,
      argsSchema:{type:"object",properties:{entity:{type:"string",enum:Object.values(FIELD_HOMES).map(home=>home.entity)}},additionalProperties:false},
      schema:{type:"object",required:["fields","revision"],properties:{fields:FIELD_ROWS,revision:{type:"string"}},additionalProperties:false},
      read:async(ctx:PublicationContext,ref:SourceRef) => { const value = await unassignedDefinitions(ctx.organizationId,ref.args?.entity); return { value, revision:value.revision }; } }
  } });
  registerAction({ id:"custom-fields.definitions.save", version:"1", implementation:backendImplementationDigest(), domain:"custom-fields",
    description:"Replace the field definitions of one role, group type, company type or department. fields is the complete ordered list; a definition left out is retired and its stored values are kept. The same path may be declared by several homes only with the same type and cardinality. Obtain expectedRevision from custom-fields-homes.definitions.",
    inputSchema:{type:"object",required:["kind","id","fields","expectedRevision"],properties:{...HOME_ARGS.properties,fields:{type:"array",maxItems:256,items:{type:"object",required:["path","type"],properties:{path:{type:"string",minLength:1,maxLength:780},type:{type:"string",minLength:1,maxLength:64},label:{type:"string",maxLength:200}},additionalProperties:true}},expectedRevision:{type:"string",minLength:1,maxLength:128}},additionalProperties:false},
    outputSchema:HOME_SAVED, policy:homeAccess, effect:"write", executionKinds:["api","agent","module","work"], idempotency:"required",
    execute:(ctx,_target,input) => saveHomeDefinitions(ctx.organizationId,input)
  });
  registerAction({ id:"custom-fields.definitions.place", version:"1", implementation:backendImplementationDigest(), domain:"custom-fields",
    description:"Give an unassigned user, team, company or department field definition its home. From then on it applies only to records in that role, type or department; values on other records are kept and no longer shown.",
    inputSchema:{type:"object",required:["path","kind","id"],properties:{...HOME_ARGS.properties,path:{type:"string",minLength:1,maxLength:780},entity:{type:"string",enum:Object.values(FIELD_HOMES).map(home=>home.entity)}},additionalProperties:false},
    outputSchema:HOME_SAVED, policy:homeAccess, effect:"write", executionKinds:["api","agent","module","work"], idempotency:"required",
    execute:(ctx,_target,input) => placeDefinition(ctx.organizationId,input)
  });
}
