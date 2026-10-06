import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { registerAction } from "../platform/publication/actions.js";
import { registerDataProvider } from "../platform/publication/providers.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import { contentHash } from "../platform/publication/validation.js";
import type { PublicationContext, TargetRef, SourceRef, AccessPolicy } from "../platform/publication/contracts.js";
import { badRequest, forbidden } from "../platform/errors.js";
import { canonicalActionItemForUser, listCanonicalActionItems, setUserActionItemState } from "../platform/api.js";
import { createTodo } from "./todos.js";
import { patchWorkNode, transitionWorkNode } from "./service.js";
import { patchWorkNodeSchema, transitionWorkNodeSchema, workConfigurationSchema } from "./schemas.js";
import { readWorkConfiguration, saveWorkConfiguration } from "./config.js";
import { resolveFollowUpOutcome } from "./followups.js";
import { listEventRecords } from "./storage.js";

const text = z.string().trim().max(500);
const ids = z.array(text.min(1)).max(500);
const date = z.string().refine(value => value === "" || Number.isFinite(Date.parse(value)), "Choose a valid date.");
const query = z.object({ includeCompleted:z.boolean().optional(), includeCanceled:z.boolean().optional(), includeFuture:z.boolean().optional(), includeHidden:z.boolean().optional(), includeAll:z.boolean().optional(), kind:text.optional(), status:text.optional(), contact:text.optional(), dueBefore:date.optional(), dueAfter:date.optional() }).strict();
const create = z.object({ title:text.min(1), body:z.string().max(100000).optional(), kind:text.optional(), due_at:date.optional(), assigned_user_ids:ids.optional(), assigned_role_ids:ids.optional(), assigned_resource_group_ids:ids.optional(), priority:z.number().int().min(0).max(100).optional(), contact_refs:z.array(z.object({contact_id:text.optional(),name:text.optional(),email:text.optional(),phone:text.optional()}).strict()).max(8).optional(), metadata:z.record(z.unknown()).optional(), frontend_action:z.record(z.unknown()).optional() }).strict();
const outcome = z.object({ outcome:text.min(1), due_at:date.optional(), use_policy:z.boolean().optional(), policy_trigger:z.enum(["voicemail","no_answer","manual_follow_up"]).optional() }).strict();
const state = z.object({ seen:z.boolean().optional(), hidden:z.boolean().optional(), dismissed:z.boolean().optional(), pinned:z.boolean().optional(), snoozed_until:date.optional() }).strict();
function principal(ctx:PublicationContext) { if(!ctx.auth) throw forbidden("todo_user_required","To-dos require an authenticated user."); return ctx.auth; }
async function item(ctx:PublicationContext,target:TargetRef) {
  if(!target.id) throw badRequest("todo_id_required","Choose a to-do id.");
  const value = await canonicalActionItemForUser(ctx.organizationId,target.id,principal(ctx) as unknown as Record<string,unknown>);
  if(value.actionable !== true || value.show_in_todo_list !== true) throw badRequest("not_a_todo","This Work node is not a to-do.");
  const project = target.projectId || ctx.projectId;
  if(project && value.project_id !== project) throw forbidden("publication_project_denied","This to-do is outside the project context.");
  return value;
}
// Public task fields only; internal automation bindings and execution context stay private.
const properties:Record<string,unknown> = {
  ...Object.fromEntries(["id","plan_id","project_id","project_title","branch_id","parent_id","title","body","description","status","workflow_status","kind","due_at","created_at","updated_at","completed_at"].map(key=>[key,{type:["string","null"]}])),
  ...Object.fromEntries(["assigned_user_ids","assigned_role_ids","assigned_resource_group_ids","depends_on","project_ids"].map(key=>[key,{type:"array",items:{type:"string"}}])),
  priority:{type:["string","number"]}, assignment_policy:{type:"object"}, notes:{type:"array",items:{type:"object"}}, contact_refs:{type:"array",items:{type:"object"}}, user_state:{type:"object"}, follow_up:{type:"object"}, type_tags:{type:"array",items:{type:"string"}}
};
const itemSchema = {type:"object",properties,required:["id","title","status"],additionalProperties:false};
function projectItem(value:Record<string,unknown>) {
  const metadata = value.metadata as Record<string,unknown> | undefined;
  const publicValue = {...value,priority:Number(value.work_priority || 0),assignment_policy:(value.metadata as Record<string,unknown>)?.assignment_policy,follow_up:metadata?.follow_up,type_tags:metadata?.type_tags};
  return Object.fromEntries(Object.keys(properties).filter(key=>publicValue[key as keyof typeof publicValue]!==undefined).map(key=>[key,(publicValue as Record<string,unknown>)[key]]));
}
async function rows(ctx:PublicationContext,ref:SourceRef) {
  const options = query.parse(ref.args || {});
  const result = await listCanonicalActionItems(ctx.organizationId,principal(ctx) as unknown as Record<string,unknown>,{...options,projectId:ref.target.projectId || ctx.projectId,branchId:ref.target.branchId || ctx.branchId});
  return result.items.map(projectItem);
}
let registered=false;
export function registerTodoPublication() {
  if(registered)return;registered=true;
  const access:AccessPolicy={scopes:["organization","project"],permissions:["view_projects"],authorize:ctx=>{principal(ctx);}};
  const schema = (value:z.ZodTypeAny)=>zodToJsonSchema(value,{$refStrategy:"none"});
  registerDataProvider({id:"todos",version:"1",apps:["checklists","sales","crew"],exports:{
    items:{description:"Personal cross-project or project-scoped to-dos, including assignments, dates, notes, dependencies, follow-up state and the caller's display state.",schema:{type:"array",items:itemSchema},listItemSchema:itemSchema,schemaVersion:"1",argsSchema:schema(query),access,
      read:async(ctx,ref)=>({value:await rows(ctx,ref),provenance:{viewerUserId:principal(ctx).userId}}),
      list:async(ctx,ref,page)=>{
        const all=await rows(ctx,ref);const signature=contentHash({all,ref,user:principal(ctx).userId});let offset=0;
        if(page.cursor){try{const cursor=JSON.parse(Buffer.from(page.cursor,"base64url").toString());if(cursor.signature!==signature||!Number.isInteger(cursor.offset)||cursor.offset<0)throw Error();offset=cursor.offset;}catch{throw badRequest("source_cursor_invalid","The to-do list changed; start a new page.");}}
        const items=all.slice(offset,offset+page.limit);return {items,revision:signature,provenance:{viewerUserId:principal(ctx).userId},...(offset+items.length<all.length?{nextCursor:Buffer.from(JSON.stringify({signature,offset:offset+items.length})).toString("base64url")}: {})};
      },
      authorizeSnapshot:async(ctx,ref,result)=>{
        if(result.provenance.viewerUserId!==principal(ctx).userId)throw forbidden("snapshot_viewer_denied","This to-do snapshot belongs to another user.");
        const allowed=new Set((await rows(ctx,ref)).map(value=>value.id));
        if(!Array.isArray(result.value)||result.value.some(value=>!allowed.has(value.id)))throw forbidden("snapshot_subject_denied","A captured to-do is no longer accessible.");
      }
    }
  }});
  function publish(id:string,description:string,input:z.ZodTypeAny,permission:string,effect:"read"|"write",execute:(ctx:PublicationContext,target:TargetRef,input:any,receiptId:string)=>Promise<unknown>,resource=false) {
    registerAction({id,version:"1",domain:"work",description,inputSchema:schema(input),outputSchema:{type:["object","array"]},implementation:backendImplementationDigest(),effect,executionKinds:["api","agent","module","work"],idempotency:effect==="read"?"none":"required",policy:{...access,permissions:permission?[permission]:[],authorize:async(ctx,target)=>{principal(ctx);if(resource)await item(ctx,target);}},validateInput:value=>{input.parse(value);},execute:async(ctx,target,value,execution)=>JSON.parse(JSON.stringify(await execute(ctx,target,input.parse(value),execution.receiptId)))});
  }
  publish("work.todos.list","List the caller's to-dos across projects, or filter to a project. includeAll includes other assignments for authorized project viewers.",query,"view_projects","read",async(ctx,target,input)=>rows(ctx,{provider:"todos",export:"items",target,args:input}));
  publish("work.todos.read","Read one visible to-do with assignment, follow-up and personal display state.",z.object({}).strict(),"view_projects","read",async(ctx,target)=>projectItem(await item(ctx,target)),true);
  publish("work.todos.create","Create a manual to-do or tagged follow-up, with assignment, due date, priority and contacts. Use the target projectId to link a project.",create,"manage_projects","write",async(ctx,target,input,receiptId)=>{
    const result=await createTodo(ctx.organizationId,{...input,id:`publication_todo_${contentHash(receiptId)}`,project_id:target.projectId || ctx.projectId || "",branch_id:target.branchId || ctx.branchId},principal(ctx));
    if(!result.todo)throw badRequest("todo_creation_failed","The created plan has no to-do.");
    return projectItem(await item(ctx,{...target,id:String(result.todo.id)}));
  });
  publish("work.todos.patch","Edit title, description, assignments, priority, due date, notes, assignment policy and metadata using Work validation.",patchWorkNodeSchema.omit({status:true}).strict(),"manage_projects","write",async(ctx,target,input)=>{await patchWorkNode(ctx.organizationId,target.id!,input);return projectItem(await item(ctx,target));},true);
  publish("work.todos.transition","Claim/start, complete, cancel, skip or deliberately reopen a to-do. Follow-ups require their outcome operation.",transitionWorkNodeSchema.extend({expected_updated_at:z.string().optional()}).strict(),"manage_projects","write",async(ctx,target,input)=>{await transitionWorkNode(ctx.organizationId,target.id!,input.status,{...input,actor_user_id:principal(ctx).userId,actor_email:String(principal(ctx).identity.email || "")});return projectItem(await item(ctx,target));},true);
  publish("work.todos.userState","Set only the caller's seen, hidden, dismissed, pinned or snoozed state for a visible to-do.",state,"","write",async(ctx,target,input)=>setUserActionItemState(ctx.organizationId,principal(ctx).userId,target.id!,input),true);
  publish("work.followUps.outcome","Resolve a tagged follow-up through its configured reschedule, scheduled or lost outcome, retaining cadence and project effects.",outcome,"manage_projects","write",async(ctx,target,input)=>resolveFollowUpOutcome(ctx.organizationId,target.id!,{...input,actor_user_id:principal(ctx).userId,actor_email:String(principal(ctx).identity.email || "")}),true);
  publish("work.todos.history","Read lifecycle events for one visible to-do.",z.object({}).strict(),"view_projects","read",async(ctx,target)=>{const value=await item(ctx,target);return {transitions:(value.metadata as Record<string,unknown>)?.history || [],events:(await listEventRecords(ctx.organizationId,{node_id:target.id})).map(event=>({id:event.id,type:event.type,created_at:event.created_at,node_id:event.node_id,status:event.status}))};},true);
  publish("work.configuration.read","Read branch Work terminology, follow-up cadence and configured outcomes.",z.object({}).strict(),"view_projects","read",async(ctx,target)=>readWorkConfiguration(ctx.organizationId,target.branchId || ctx.branchId || "default"));
  publish("work.configuration.save","Update validated branch Work terminology and follow-up configuration.",workConfigurationSchema,"manage_company_settings","write",async(ctx,target,input)=>saveWorkConfiguration(ctx.organizationId,target.branchId || ctx.branchId || "default",input));
}
