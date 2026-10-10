import { registerDataProvider } from "../platform/publication/providers.js";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { forbidden } from "../platform/errors.js";
import { canReadField, readFieldRecord, readFields, writeFields } from "./records.js";
import { FIELD_OWNERS, type FieldEntity } from "./owners.js";
import { types, isManuallyEditableType } from "./contracts.js";
import { resolvePlatformPhone } from "./platform-phone.js";
import type { AccessPolicy, SourceRef, PublicationContext } from "../platform/publication/contracts.js";

let registered = false;
export function registerCustomFieldPublication() {
  if (registered) return; registered = true;

  registerDataProvider({id:"custom-fields-catalog",version:"1",apps:["settings"],exports:{contract:{description:"Shared owner and variable type catalog for frontend integrations.",schema:{type:"object",additionalProperties:true},schemaVersion:"1",access:{scopes:["organization"],permissions:["manage_company_settings"],systemKinds:["work","module","agent"]},read:async()=>({value:{owners:FIELD_OWNERS,types:types.map(type=>({type,...(type === "platform_phone"?{baseType:"phone",producer:"phone-system",manuallyEditable:false,description:"A phone number issued by the platform."}:{manuallyEditable:isManuallyEditableType(type)})}))},revision:"1"})}}});
  for (const entity of Object.keys(FIELD_OWNERS) as FieldEntity[]) {
    const access: AccessPolicy = { scopes:entity === "project" ? ["project"] : entity === "contact" ? ["project", "organization"] : ["organization"], permissions:[FIELD_OWNERS[entity].readPermission], systemKinds:["work","module","agent"] };
    const provider = `custom-fields-${entity}`;
    const argsSchema = { type:"object", properties:{ field:{type:"string",minLength:1,maxLength:780} }, additionalProperties:false };
    const resolve = (ctx:PublicationContext,ref:SourceRef) => readFields(ctx,ref.target,entity,ref.args?.field as string | undefined, ref.export === "contract",ref.export === "phones");
    registerDataProvider({ id:provider, version:"1", apps:[entity === "project" ? "projects" : entity === "contact" ? "contacts" : "settings"], exports:Object.fromEntries(["contract","values","phones"].map(name => [name, {
      schema:name === "phones" ? {type:"array",items:{type:"object",additionalProperties:true}} : {type:"object",additionalProperties:true}, schemaVersion:"1", argsSchema, access,
      description:`${entity} custom ${name === "contract" ? "field definitions, nested schemas, access and record revision" : "field values, including read-only and background variables"}. Optional args.field selects a declared dotted field path. Private fields require their read permission.`,
      authorizeSnapshot:async(ctx:PublicationContext,ref:SourceRef,result:any) => {
        const current = await readFieldRecord(ctx,ref.target,entity);
        for (const path of result.provenance.fieldPaths || []) {
          const f = current.fields.find(f => f.path === path);
          if (!f || !canReadField(ctx,f)) throw forbidden("custom_field_access_revoked","A captured field is no longer accessible.");
        }
        for (const ref of result.provenance.platformPhones || []) if(!(await resolvePlatformPhone(ctx.organizationId,ref)).available) throw forbidden("platform_phone_revoked","A captured platform phone is no longer issued to this organization.");
      },
      read:async(ctx:PublicationContext,ref:SourceRef) => {
        const state = await resolve(ctx,ref);
        return { value:name === "contract" ? { entity, id:state.id, recordRevision:state.row?.revision || 0, fields:state.contract } : name === "phones" ? state.phones : state.values, revision:state.revision, provenance:{entity, id:state.id, fieldPaths:state.dependencies,platformPhones:state.phones.filter(p=>p.type === "platform_phone" && p.available).map(p=>({phone_number:p.phone_number,issuance_id:p.issuance_id}))} };
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
}
