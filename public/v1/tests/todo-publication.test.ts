import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
let root:string,storage:typeof import("../platform/storage.js"),actions:typeof import("../platform/publication/actions.js"),context:typeof import("../platform/publication/context.js"),providers:typeof import("../platform/publication/providers.js");
const organizationId="todo-publication-org";
before(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"todo-publication-"));process.env.NODE_ENV="test";process.env.PLATFORM_STORAGE_ROOT=root;process.env.WORK_SCHEDULER_DISABLED="1";process.env.PLATFORM_HEARTBEAT_DISABLED="1";
  storage=await import("../platform/storage.js");actions=await import("../platform/publication/actions.js");context=await import("../platform/publication/context.js");providers=await import("../platform/publication/providers.js");
  await storage.createOrganization({id:organizationId});
  await (await import("../platform/capabilities.js")).saveCapabilityValues(organizationId,{"platform.expanded_access":true});
  for(const id of ["manager","reader","other"])await storage.upsertDocument(organizationId,"users",{id,data:{id,roles:[]}});
  for(const id of ["p1","p2"])await storage.upsertDocument(organizationId,"projects",{id,data:{title:id}});
  (await import("../work/publication.js")).registerTodoPublication();
});
after(async()=>{await actions.closeActionDatabase();await (await import("../work/storage.js")).closeWorkDatabase();await (await import("../platform/sql_store.js")).closeSqlStores();await rm(root,{recursive:true,force:true});});
function ctx(userId="manager",permissions:Record<string,boolean>={view_projects:true,manage_projects:true},projectId?:string){return context.userPublicationContext({orgId:organizationId,userId,role:"member",permissions,branchId:"default",identity:{},organization:{},user:{},applicationAccess:{management:{enabled:true,permissions:{}}}} as any,{mode:"command",executionKind:"agent",...(projectId?{projectId}:{})});}
function target(id?:string,projectId?:string){return {scope:projectId?"project" as const:"organization" as const,organizationId,...(id?{id}:{}),...(projectId?{projectId}:{})};}
async function invoke(action:string,input:Record<string,unknown>={},id?:string,key?:string,principal=ctx(),projectId?:string){return actions.invokeAction(principal,{action,target:target(id,projectId)},input,key?{idempotencyKey:key}:{});}
test("agent creates distinct receipt-backed todos, edits assignment/dates, reads published fields and transitions",async()=>{
  const input={title:"Call customer",assigned_user_ids:["reader"],due_at:"2026-11-01T12:00:00Z",priority:4};
  const first=await invoke("work.todos.create",input,undefined,"create-1",ctx(),"p1");const id=String((first.value as any).id);
  const replay=await invoke("work.todos.create",input,undefined,"create-1",ctx(),"p1");assert.equal(replay.receipt.replayed,true);assert.equal((replay.value as any).id,id);
  const second=await invoke("work.todos.create",input,undefined,"create-2",ctx(),"p1");assert.notEqual((second.value as any).id,id);
  const updated=await invoke("work.todos.patch",{title:"Confirm appointment",due_at:"2026-11-02T12:00:00Z",assigned_user_ids:["reader"],notes:[{text:"Customer prefers mornings"}]},id,"patch");assert.equal((updated.value as any).title,"Confirm appointment");
  const result=await providers.readPublishedData(ctx("reader",{view_projects:true}),{provider:"todos",export:"items",target:target()});assert.equal(result.status,"ready",JSON.stringify(result));if(result.status!=="ready")return;
  const row=(result.value as any[]).find(row=>row.id===id);assert.deepEqual(row.assigned_user_ids,["reader"]);assert.equal(row.due_at,"2026-11-02T12:00:00Z");assert.equal(row.automation_bindings,undefined);
  const done=await invoke("work.todos.transition",{status:"completed"},id,"complete");assert.equal((done.value as any).workflow_status,"completed");
  const history=await invoke("work.todos.history",{},id);assert.ok((history.value as any).transitions.length>0);
});
test("permissions, tenant, project scope and caller-owned state are enforced, including receipt replay",async()=>{
  const created=await invoke("work.todos.create",{title:"Private assignment",assigned_user_ids:["reader"]},undefined,"private",ctx(),"p2");const id=String((created.value as any).id);
  await assert.rejects(invoke("work.todos.patch",{title:"Denied"},id,"denied",ctx("reader",{view_projects:true})),{code:"publication_permission_denied"});
  await assert.rejects(invoke("work.todos.read",{},id,undefined,ctx("other",{view_projects:true})),{code:"action_item_not_visible"});
  await assert.rejects(invoke("work.todos.read",{},id,undefined,ctx("manager",{view_projects:true,manage_projects:true},"p1")),{code:"publication_project_denied"});
  await assert.rejects(actions.invokeAction(ctx(),{action:"work.todos.read",target:{scope:"organization",organizationId:"other-org",id}},{}),{code:"publication_tenant_denied"});
  await invoke("work.todos.userState",{hidden:true,pinned:true},id,"hide",ctx("reader",{view_projects:true}));
  let read=await invoke("work.todos.read",{},id,undefined,ctx("reader",{view_projects:true}));assert.ok((read.value as any).user_state.hidden_at);
  await invoke("work.todos.userState",{hidden:false},id,"unhide",ctx("reader",{view_projects:true}));read=await invoke("work.todos.read",{},id,undefined,ctx("reader",{view_projects:true}));assert.equal((read.value as any).user_state.hidden_at,"");
  assert.equal((await invoke("work.todos.read",{},id)).value && ((await invoke("work.todos.read",{},id)).value as any).user_state.hidden_at,undefined);
  await invoke("work.todos.patch",{assigned_user_ids:["other"]},id,"reassign");
  await assert.rejects(invoke("work.todos.userState",{hidden:true,pinned:true},id,"hide",ctx("reader",{view_projects:true})),{code:"action_item_not_visible"});
});
test("follow-up creation retains normal outcomes and cadence; schema rejects malformed dates and extra authority",async()=>{
  const result=await invoke("work.todos.create",{title:"Follow up",kind:"follow_up",assigned_user_ids:["reader"]},undefined,"follow-up",ctx(),"p1");const id=String((result.value as any).id);
  await assert.rejects(invoke("work.todos.transition",{status:"completed"},id,"no-outcome"),{code:"follow_up_outcome_required"});
  const outcome=await invoke("work.followUps.outcome",{outcome:"follow_up",due_at:"2026-11-04T12:00:00Z",policy_trigger:"manual_follow_up"},id,"reschedule");assert.equal((outcome.value as any).completed.status,"completed");assert.equal((outcome.value as any).successor.metadata.kind,"follow_up");
  await assert.rejects(invoke("work.todos.create",{title:"Invalid",due_at:"garbage"},undefined,"invalid"));
  await assert.rejects(invoke("work.todos.create",{title:"Invalid",project_id:"p2"},undefined,"override"));
  const configuration=await invoke("work.configuration.read");assert.ok((configuration.value as any).follow_ups.retry_policy);
});



