import { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";
import { forbidden, badRequest } from "../platform/errors.js";
import { readDocument } from "../platform/storage.js";
import { listNodeRecords, readNodeRecord, getWorkDatabase } from "../work/storage.js";
import { transitionWorkNode } from "../work/service.js";
import { type ResourceRef, idSchema } from "./schemas.js";
import { withSharedAccess, requirePermission, actor } from "./service.js";
import { audit } from "./storage.js";

function project(resource:ResourceRef){if(resource.type!=="project")throw badRequest("project_required","Choose a project.");}
const selected=(grants:Record<string,any>[],id:string)=>grants.some(g=>g.include_future||g.child_ids.includes(id));
function scheduleProjection(event:Record<string,any>){return {id:String(event.id),title:String(event.title||event.name||"Scheduled work"),start_at:String(event.start_at||""),end_at:String(event.end_at||""),status:String(event.status||""),event_revision:Number(event.event_revision||0),locked:event.locked===true};}
export async function sharedSchedule(ctx:PlatformAuthContext,resource:ResourceRef){
  project(resource);
  return withSharedAccess(ctx,resource,"schedule.read",async decision=>{
    requirePermission(decision.ctx,"view_projects");
    const document=await readDocument(resource.owner_org_id,"projects",resource.id);
    const events=Array.isArray(document.data.events)?document.data.events as Record<string,any>[]:[];
    return {items:events.filter(e=>selected(decision.grants,String(e.id))).map(scheduleProjection)};
  });
}
export async function rescheduleSharedEvent(ctx:PlatformAuthContext,resource:ResourceRef,raw:unknown){
  project(resource);
  const input=z.object({event_id:idSchema,expected_event_revision:z.number().int().nonnegative(),start_at:z.string().datetime(),end_at:z.string().datetime()}).strict().parse(raw);
  if(Date.parse(input.end_at)<=Date.parse(input.start_at))throw badRequest("schedule_range","The end must be after the start.");
  return withSharedAccess(ctx,resource,"schedule.update",async decision=>{
    requirePermission(decision.ctx,"manage_projects");
    const document=await readDocument(resource.owner_org_id,"projects",resource.id),events=Array.isArray(document.data.events)?document.data.events as Record<string,any>[]:[];
    const event=events.find(e=>e.id===input.event_id);
    if(!event||!selected(decision.grants,input.event_id))throw forbidden("schedule_not_shared","This schedule item is not shared for editing.");
    const {saveProjectScheduleEvent}=await import("../platform/api.js");
    const saved=await saveProjectScheduleEvent(resource.owner_org_id,resource.id,decision.ctx,{branch_id:event.branch_id||document.data.branch_id||"default",expected_event_revision:input.expected_event_revision,event:{id:input.event_id,start_at:input.start_at,end_at:input.end_at}});
    await audit(decision.grants[0]!,"collaboration.schedule.updated",actor(decision.ctx),{event_id:input.event_id});
    return {event:scheduleProjection(saved.event)};
  });
}
export async function sharedWork(ctx:PlatformAuthContext,resource:ResourceRef){
  project(resource);
  return withSharedAccess(ctx,resource,"work.read",async decision=>{
    requirePermission(decision.ctx,"view_projects");
    return {items:(await listNodeRecords(resource.owner_org_id,{project_id:resource.id})).filter(n=>selected(decision.grants,String(n.id))).map(n=>({id:n.id,title:n.title,description:n.description,status:n.status,due_at:n.due_at,updated_at:n.updated_at}))};
  });
}
export async function updateSharedWork(ctx:PlatformAuthContext,resource:ResourceRef,raw:unknown){
  project(resource);
  const input=z.object({node_id:idSchema,status:z.enum(["active","completed"]),expected_updated_at:z.string().datetime()}).strict().parse(raw);
  return withSharedAccess(ctx,resource,"work.update",async decision=>{
    requirePermission(decision.ctx,"manage_projects");
    return getWorkDatabase().transaction(async()=>{
      const node=await readNodeRecord(resource.owner_org_id,input.node_id);
      if(!node||node.project_id!==resource.id||!selected(decision.grants,input.node_id))throw forbidden("work_not_shared","This work item is not shared for editing.");
      if(!node.actionable||node.completion_mode!=="manual"||!["ready","active",input.status].includes(String(node.status)))throw forbidden("work_transition_unavailable","This work item cannot be advanced manually in its current state.");
      const result=await transitionWorkNode(resource.owner_org_id,input.node_id,input.status,{expected_updated_at:input.expected_updated_at,actor_user_id:`external_${ctx.orgId}_${ctx.userId}`,reason:"partner_progress",payload:{collaboration_actor:actor(decision.ctx)}});
      await audit(decision.grants[0]!,"collaboration.work.updated",actor(decision.ctx),{node_id:input.node_id,status:input.status});
      return {id:result.id,status:result.status,updated_at:result.updated_at};
    });
  });
}
