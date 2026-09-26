import { registerDataProvider } from "../platform/publication/providers.js";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { forbidden } from "../platform/errors.js";
import { canReadField, readFieldRecord, readFields, writeFields } from "./records.js";
import type { FieldEntity } from "./contracts.js";
import type { AccessPolicy, SourceRef, PublicationContext } from "../platform/publication/contracts.js";

let registered = false;
export function registerCustomFieldPublication() {
  if (registered) return; registered = true;
  for (const entity of ["project","contact","organization"] as FieldEntity[]) {
    const access: AccessPolicy = { scopes:entity === "project" ? ["project"] : entity === "contact" ? ["project", "organization"] : ["organization"], permissions:[entity === "contact" ? "view_contacts" : "view_projects"], systemKinds:["work","module","agent"] };
    const provider = `custom-fields-${entity}`;
    const argsSchema = { type:"object", properties:{ field:{type:"string",minLength:1,maxLength:780} }, additionalProperties:false };
    const resolve = (ctx:PublicationContext,ref:SourceRef) => readFields(ctx,ref.target,entity,ref.args?.field as string | undefined, ref.export === "contract");
    registerDataProvider({ id:provider, version:"1", apps:[entity === "project" ? "projects" : entity === "contact" ? "contacts" : "settings"], exports:Object.fromEntries(["contract","values"].map(name => [name, {
      schema:{type:"object",additionalProperties:true}, schemaVersion:"1", argsSchema, access,
      description:`${entity} custom ${name === "contract" ? "field definitions, nested schemas, access and record revision" : "field values, including read-only and background variables"}. Optional args.field selects a declared dotted field path. Private fields require their read permission.`,
      authorizeSnapshot:async(ctx:PublicationContext,ref:SourceRef,result:any) => {
        const current = await readFieldRecord(ctx,ref.target,entity);
        for (const path of result.provenance.fieldPaths || []) {
          const f = current.fields.find(f => f.path === path);
          if (!f || !canReadField(ctx,f)) throw forbidden("custom_field_access_revoked","A captured field is no longer accessible.");
        }
      },
      read:async(ctx:PublicationContext,ref:SourceRef) => {
        const state = await resolve(ctx,ref);
        return { value:name === "contract" ? { entity, id:state.id, recordRevision:state.row?.revision || 0, fields:state.contract } : state.values, revision:state.revision, provenance:{entity, id:state.id, fieldPaths:state.dependencies} };
      }
    }])) });
    registerAction({ id:`custom-fields.${entity}.write`, version:"1", implementation:backendImplementationDigest(), domain:"custom-fields",
      description:`Update declared writable ${entity} fields. values maps complete dotted field paths to replacement JSON values; dictionaries and arrays are replaced as a unit. Obtain expectedRevision from the contract export.`,
      inputSchema:{type:"object",required:["values","expectedRevision"],properties:{values:{type:"object",minProperties:1,maxProperties:256,additionalProperties:true},expectedRevision:{type:"integer",minimum:entity === "organization" ? 0 : 1}},additionalProperties:false},
      outputSchema:{type:"object",required:["id","revision"],properties:{id:{type:"string"},revision:{type:"integer"}},additionalProperties:false},
      policy:{...access,permissions:[entity === "organization" ? "manage_company_settings" : "manage_projects"]},effect:"write",executionKinds:["api","agent","module","work"],idempotency:"required",
      execute:(ctx,target,input) => writeFields(ctx,target,entity,input)
    });
  }
}
