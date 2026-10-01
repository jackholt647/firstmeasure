import { registerDataProvider } from "../platform/publication/providers.js";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { forbidden } from "../platform/errors.js";
import type { PublicationContext } from "../platform/publication/contracts.js";
import { updateSharedWork, rescheduleSharedEvent } from "./work.js";
import { resourceSchema } from "./schemas.js";
import { revokeGrant } from "./service.js";
import { readSharedResource, sharedResources, updateSharedDetails, createSharedNote, postSharedMessage } from "./resources.js";

const resourceContract={type:"object",required:["owner_org_id","type","id"],properties:{owner_org_id:{type:"string",maxLength:180},type:{enum:["project","contact","channel","document","media","invoice"]},id:{type:"string",maxLength:180},project_id:{type:"string",maxLength:180}},additionalProperties:false};
const scalar={type:["string","number","boolean"]};
const projectedFields=Object.fromEntries(["title","address","city","state","zip","description","status","created_at","updated_at","name","email","phone","company","contact_kind","type","document_type","file_name","content_type","kind","invoice_number","currency","total_cents","balance_due_cents","amount_paid_cents","due_date","issued_at"].map(key=>[key,scalar]));
const resourceOutput={type:"object",required:["resource","revision","data","owner","operations"],properties:{resource:resourceContract,revision:{type:"integer",minimum:1},data:{type:"object",properties:projectedFields,additionalProperties:false},owner:{type:"object",required:["organization_id","name"],properties:{organization_id:{type:"string"},name:{type:"string"}},additionalProperties:false},operations:{type:"array",items:{type:"string"}},share_id:{type:"string"}},additionalProperties:false};
const resourcesOutput={type:"object",required:["items","next_cursor"],properties:{items:{type:"array",items:resourceOutput},next_cursor:{type:["string","null"]}},additionalProperties:false};
function principal(ctx:PublicationContext){if(!ctx.auth)throw forbidden("collaboration_principal_required","External collaboration requires a current member authority.");return ctx.auth;}
let registered=false;
export function registerCollaborationPublication(){
  if(registered)return;registered=true;
  registerDataProvider({id:"collaboration",version:"1",apps:["partners"],exports:{
    resource:{description:"A resource shared with the acting organization, projected through its current grants.",schemaVersion:"1",schema:resourceOutput,argsSchema:{type:"object",required:["resource"],properties:{resource:resourceContract},additionalProperties:false},access:{scopes:["organization"],permissions:["use_external_shares"],capabilities:["platform.collaboration"]},
      read:async(ctx,ref)=>{const result=await readSharedResource(principal(ctx),resourceSchema.parse(ref.args?.resource));return {value:result,revision:String(result.revision)};},
      authorizeSnapshot:async(ctx,ref,result)=>{
        const current=await readSharedResource(principal(ctx),resourceSchema.parse(ref.args?.resource));
        const value=result.value as any;
        if(Object.keys(value?.data||{}).some(k=>!Object.hasOwn(current.data,k)))throw forbidden("shared_snapshot_denied","The retained fields are no longer shared.");
      }
    },
    resources:{description:"Paginated shared resource references visible to this member.",schemaVersion:"1",schema:resourcesOutput,argsSchema:{type:"object",properties:{after:{type:"string"},limit:{type:"integer",minimum:1,maximum:100},type:{type:"string"},owner:{type:"string"}},additionalProperties:false},access:{scopes:["organization"],permissions:["use_external_shares"],capabilities:["platform.collaboration"]},
      read:async(ctx,ref)=>({value:await sharedResources(principal(ctx),String(ref.args?.after||""),Number(ref.args?.limit||50),String(ref.args?.type||""),String(ref.args?.owner||""))}),
      authorizeSnapshot:async(ctx,_ref,result)=>{for(const entry of (result.value as any)?.items||[]){
        const current=await readSharedResource(principal(ctx),resourceSchema.parse(entry.resource));
        if(Object.keys(entry.data||{}).some(k=>!Object.hasOwn(current.data,k)))throw forbidden("shared_snapshot_denied","The retained fields are no longer shared.");
      }}
    }
  }});
  registerAction({id:"collaboration.project.update",version:"1",implementation:backendImplementationDigest(),domain:"collaboration",description:"Update only explicitly editable fields of a shared project.",inputSchema:{type:"object",required:["resource","expected_revision","fields"],properties:{resource:resourceContract,expected_revision:{type:"integer",minimum:1},fields:{type:"object",properties:{title:{type:"string",maxLength:4000},description:{type:"string",maxLength:4000}},additionalProperties:false}},additionalProperties:false},outputSchema:{type:"object",required:["revision"],properties:{revision:{type:"integer"}},additionalProperties:false},policy:{scopes:["organization"],permissions:["use_external_shares"],capabilities:["platform.collaboration"]},effect:"write",executionKinds:["api","agent","module","work"],idempotency:"required",execute:(ctx,_target,input)=>updateSharedDetails(principal(ctx),resourceSchema.parse(input.resource),{expected_revision:input.expected_revision,fields:input.fields})});
  registerAction({id:"collaboration.share.revoke",version:"1",implementation:backendImplementationDigest(),domain:"collaboration",description:"Revoke an external share owned by the acting organization.",inputSchema:{type:"object",required:["id","expected_revision"],properties:{id:{type:"string",maxLength:180},expected_revision:{type:"integer",minimum:1}},additionalProperties:false},outputSchema:{type:"object",required:["id","status","revision"],properties:{id:{type:"string"},status:{const:"revoked"},revision:{type:"integer"}},additionalProperties:false},policy:{scopes:["organization"],permissions:["manage_external_sharing"],capabilities:["platform.collaboration"]},effect:"write",executionKinds:["api","agent","module","work"],idempotency:"required",execute:async(ctx,_target,input)=>{const grant=await revokeGrant(principal(ctx),String(input.id),Number(input.expected_revision));return {id:grant.id,status:grant.status,revision:grant.revision};}});
  for(const [id,handler,description,inputProperties,required] of [
    ["note.create",createSharedNote,"Add a note to an explicitly shared project.",{text:{type:"string",minLength:1,maxLength:20000},client_operation_id:{type:"string",maxLength:100}},["text","client_operation_id"]],
    ["message.post",postSharedMessage,"Post to an explicitly shared channel.",{text:{type:"string",minLength:1,maxLength:20000},client_operation_id:{type:"string",maxLength:100}},["text","client_operation_id"]],
    ["work.update",updateSharedWork,"Advance an explicitly shared manual work item.",{node_id:{type:"string"},status:{enum:["active","completed"]},expected_updated_at:{type:"string",format:"date-time"}},["node_id","status","expected_updated_at"]],
    ["schedule.update",rescheduleSharedEvent,"Reschedule an explicitly shared unlocked event.",{event_id:{type:"string"},expected_event_revision:{type:"integer",minimum:0},start_at:{type:"string",format:"date-time"},end_at:{type:"string",format:"date-time"}},["event_id","expected_event_revision","start_at","end_at"]]
  ] as const){
    registerAction({id:`collaboration.${id}`,version:"1",implementation:backendImplementationDigest(),domain:"collaboration",description,inputSchema:{type:"object",required:["resource","input"],properties:{resource:resourceContract,input:{type:"object",required:[...required],properties:inputProperties,additionalProperties:false}},additionalProperties:false},outputSchema:{type:"object",required:["ok"],properties:{ok:{const:true}},additionalProperties:false},policy:{scopes:["organization"],permissions:["use_external_shares"],capabilities:["platform.collaboration"]},effect:"write",executionKinds:["api","agent","module","work"],idempotency:"required",execute:async(ctx,_target,input)=>{await handler(principal(ctx),resourceSchema.parse(input.resource),input.input);return {ok:true};}});
  }

}
