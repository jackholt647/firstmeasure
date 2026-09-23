import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
let root="";
let storage:typeof import("../platform/storage.js");
let actions:typeof import("../platform/publication/actions.js");
let context:typeof import("../platform/publication/context.js");
const organizationId="publication-domain-org";
before(async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),"publication-domain-"));
  process.env.NODE_ENV="test";process.env.PLATFORM_STORAGE_ROOT=root;
  process.env.WORK_SCHEDULER_DISABLED="1";
  storage=await import("../platform/storage.js");actions=await import("../platform/publication/actions.js");context=await import("../platform/publication/context.js");
  await storage.createOrganization({id:organizationId});
  (await import("../platform/publication/action-adapters.js")).registerDomainActions();
});
after(async()=>{
  await actions.closeActionDatabase();
  await (await import("../platform/sql_store.js")).closeSqlStores();
  await rm(root,{recursive:true,force:true});
});
function principal(userId:string,permissions:Record<string,boolean>={}) {
  return {orgId:organizationId,userId,role:"member",permissions,branchId:"default",identity:{},organization:{},user:{},applicationAccess:{management:{enabled:true,permissions:{}}}} as any;
}
test("media adapter mutates through service; revoked receipt privacy prevents replay",async()=>{
  const media=await storage.storeMediaUpload(organizationId,{bytes:Buffer.from("receipt"),fileName:"receipt.txt",contentType:"text/plain",slot:"receipts",metadata:{uploaded_by_user_id:"owner",document_type:"receipt"}});
  const id=String(media.id);
  const ref={action:"media.item.rename",target:{scope:"organization" as const,organizationId,id}};
  const ctx=context.userPublicationContext(principal("owner"),{mode:"command",executionKind:"module"});
  const result=await actions.invokeAction(ctx,ref,{name:"renamed.txt"},{idempotencyKey:"rename1"});
  assert.equal((result.value as any).file_name,"renamed.txt");
  assert.equal((await storage.readMediaMetadata(organizationId,id)).file_name,"renamed.txt");
  const other=context.userPublicationContext(principal("other"),{mode:"command",executionKind:"module"});
  await assert.rejects(actions.invokeAction(other,ref,{name:"renamed.txt"},{idempotencyKey:"rename1"}),{code:"receipt_media_forbidden"});
  const replay=await actions.invokeAction(ctx,ref,{name:"renamed.txt"},{idempotencyKey:"rename1"});
  assert.equal(replay.receipt.replayed,true);
});
test("project context cannot read another project's media even with view permission",async()=>{
  const media=await storage.storeMediaUpload(organizationId,{bytes:Buffer.from("photo"),fileName:"photo.txt",contentType:"text/plain",ownerType:"project",ownerId:"project-b",metadata:{project_id:"project-b"}});
  const ctx=context.userPublicationContext(principal("reader",{view_projects:true}),{mode:"evaluate",executionKind:"module",projectId:"project-a"});
  await assert.rejects(actions.invokeAction(ctx,{action:"media.item.read",target:{scope:"organization",organizationId,id:String(media.id)}},{}),{code:"publication_project_denied"});
});
test("project search all selector invokes real project and contact lookup",async()=>{
  await storage.upsertDocument(organizationId,"projects",{id:"search-project",data:{title:"Publication Search Example",address:"10 Test Street"}},{replace:true});
  const ctx=context.userPublicationContext(principal("reader",{view_projects:true}),{mode:"evaluate",executionKind:"module"});
  const result=await actions.invokeAction(ctx,{action:"projects.search",target:{scope:"organization",organizationId}},{query:"Publication Search",types:"all"});
  assert.ok((result.value as any).results.some((row:any)=>row.id==="search-project"));
});
