import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ActionDefinition } from "../platform/publication/actions.js";
let root = "";
let actions: typeof import("../platform/publication/actions.js");
let contexts: typeof import("../platform/publication/context.js");
const target = { scope: "organization" as const, organizationId: "action-test-org" };
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "publication-actions-"));
  process.env.PLATFORM_STORAGE_ROOT = root;
  process.env.NODE_ENV = "test";
  actions = await import("../platform/publication/actions.js");
  contexts = await import("../platform/publication/context.js");
});
after(async () => { await actions.closeActionDatabase(); await rm(root,{recursive:true,force:true}); });
function definition(id: string, execute: ActionDefinition["execute"], overrides: Partial<ActionDefinition> = {}): ActionDefinition {
  return { id, version:"1",implementation:`${id}-source1`,domain:"test",description:"Test action",inputSchema:{type:"object",properties:{amount:{type:"number"}},required:["amount"],additionalProperties:false},outputSchema:{type:"number"},effect:"write",executionKinds:["module"],idempotency:"required",policy:{scopes:["organization"],permissions:[],applications:false,systemKinds:["module"]},execute,...overrides };
}
function context(id: string) { return contexts.systemPublicationContext({kind:"module",organizationId:target.organizationId,operations:[id],mode:"command"}); }
function ref(id: string) { return {action:id,version:"1",target}; }
test("JSON contracts, tenant authorization, evaluate effect gate and forged grants are enforced before handler",async () => {
  let calls = 0;
  const id = "test.gates";
  actions.registerAction(definition(id,(_c,_t,i)=>{calls++;return i.amount;}));
  await assert.rejects(actions.invokeAction(context(id),ref(id),{amount:"2"},{idempotencyKey:"bad"}),{code:"publication_schema_invalid"});
  await assert.rejects(actions.invokeAction(context(id),{...ref(id),target:{...target,organizationId:"other"}},{amount:2},{idempotencyKey:"bad"}),{code:"publication_tenant_denied"});
  await assert.rejects(actions.invokeAction({...context(id),mode:"evaluate"},ref(id),{amount:2},{idempotencyKey:"bad"}),{code:"action_effect_denied"});
  await assert.rejects(actions.invokeAction(JSON.parse(JSON.stringify(context(id))),ref(id),{amount:2},{idempotencyKey:"bad"}),{code:"publication_system_denied"});
  assert.equal(calls,0);
});

test("domain Zod schemas are discoverable and invalid nested input never claims a receipt",async()=>{
  const {actionInputContract}=await import("../platform/publication/action-schemas.js");
  const {validateJson}=await import("../platform/publication/validation.js");
  for(const action of ["equipment.meter.record","equipment.maintenance.open","equipment.maintenance.complete","work.node.transition","work.node.patch","payments.invoice.create","payments.invoice.due","payments.invoice.void","payments.payment.clear","payments.payment.refund","proposals.create","proposals.patch","proposals.snapshot","proposals.send","documents.instance.issue"]){
    const derived=actionInputContract(action,true)!;
    assert.throws(()=>validateJson(derived.inputSchema,{},"discovered action input"),{code:"publication_schema_invalid"});
  }
  const contract=actionInputContract("work.node.transition",true)!;
  assert.ok(JSON.stringify(contract.inputSchema).includes('"status"'));
  assert.ok(JSON.stringify(contract.inputSchema).includes('"required":["status"]'));
  const id="test.domain-schema";let calls=0;
  actions.registerAction(definition(id,()=>{calls++;return 1;},{...contract}));
  await assert.rejects(actions.invokeAction(context(id),ref(id),{values:{}},{idempotencyKey:"correctable"}),{code:"publication_schema_invalid"});
  await actions.invokeAction(context(id),ref(id),{values:{status:"completed"}},{idempotencyKey:"correctable"});
  assert.equal(calls,1);
  assert.doesNotThrow(()=>JSON.stringify(actions.describeAction(id)));
  assert.equal(Object.hasOwn(actions.describeAction(id)!,"validateInput"),false);
});

test("pure preflight validation failure occurs before a durable mutation claim",async()=>{
  const id="test.preflight";let calls=0;
  actions.registerAction(definition(id,()=>{calls++;return 1;},{validateInput(input){if(Number(input.amount)<5)throw new Error("domain refinement");}}));
  await assert.rejects(actions.invokeAction(context(id),ref(id),{amount:1},{idempotencyKey:"correctable"}),/domain refinement/);
  await actions.invokeAction(context(id),ref(id),{amount:5},{idempotencyKey:"correctable"});
  assert.equal(calls,1);
});
test("receipt prevents duplicate effects, survives store restart, rejects changed input and unauthorized replay",async () => {
  let calls = 0;
  const id = "test.receipt";
  actions.registerAction(definition(id,(_c,_t,i)=>{calls++;return i.amount;}));
  const first = await actions.invokeAction(context(id),ref(id),{amount:3},{idempotencyKey:"same"});
  await actions.closeActionDatabase();
  const second = await actions.invokeAction(context(id),ref(id),{amount:3},{idempotencyKey:"same"});
  assert.equal(first.value,3); assert.equal(second.receipt.replayed,true); assert.equal(calls,1);
  await assert.rejects(actions.invokeAction(context(id),ref(id),{amount:4},{idempotencyKey:"same"}),{code:"action_idempotency_conflict"});
  await assert.rejects(actions.invokeAction({...context(id),system:undefined},ref(id),{amount:3},{idempotencyKey:"same"}),{code:"publication_system_denied"});
});
test("concurrent claims execute once; uncertain effects cannot be replayed",async () => {
  let calls = 0;
  const id="test.concurrent";
  actions.registerAction(definition(id,async (_c,_t,i)=>{calls++; await new Promise(resolve=>setTimeout(resolve,20)); return i.amount;}));
  const results=await Promise.allSettled([1,2].map(()=>actions.invokeAction(context(id),ref(id),{amount:1},{idempotencyKey:"same"})));
  assert.equal(calls,1); assert.ok(results.some(result=>result.status==="fulfilled"));
  const failed="test.external";
  actions.registerAction(definition(failed,()=>{calls++;throw new Error("provider response lost");},{effect:"external"}));
  await assert.rejects(actions.invokeAction(context(failed),ref(failed),{amount:1},{idempotencyKey:"lost"}));
  await assert.rejects(actions.invokeAction(context(failed),ref(failed),{amount:1},{idempotencyKey:"lost"}),{code:"action_outcome_uncertain"});
  assert.equal(calls,2);
});
test("immutable definitions and pinned implementation reject drift; wrong output is rejected",async () => {
  const id="test.version";
  const def=definition(id,(_c,_t,i)=>i.amount);
  actions.registerAction(def); actions.registerAction(def);
  assert.throws(()=>actions.registerAction({...def,implementation:"changed"}),{code:"action_version_immutable"});
  await assert.rejects(actions.invokeAction(context(id),ref(id),{amount:1},{expectedImplementation:"other",idempotencyKey:"x"}),{code:"action_implementation_changed"});
  const invalid="test.output";
  actions.registerAction(definition(invalid,()=>"wrong"));
  await assert.rejects(actions.invokeAction(context(invalid),ref(invalid),{amount:1},{idempotencyKey:"x"}),{code:"publication_schema_invalid"});
});
test("all 29 legacy work actions are published but cannot be invoked with a fabricated work context",async () => {
  (await import("../work/automations/builtins.js")).registerBuiltinWorkAutomations();
  (await import("../payroll/automations.js")).registerPayrollAutomations();
  const registry=await import("../work/registry.js");
  const {legacyWorkActionIds}=await import("../platform/publication/work-actions.js");
  assert.equal(legacyWorkActionIds.length,29);
  for(const id of legacyWorkActionIds) assert.ok(registry.hasWorkAutomation(id));
  for(const id of registry.listWorkAutomations()) assert.ok(actions.describeAction(id,"1"));
  const ctx=contexts.systemPublicationContext({kind:"work",organizationId:target.organizationId,operations:["project.patch.v1"],mode:"command"});
  await assert.rejects(actions.invokeAction(ctx,ref("project.patch.v1"),{values:{title:"hijack"}}),{code:"action_work_context_required"});
  let patch:unknown;
  const workContext={ event:{organization_id:target.organizationId},project:{id:"p1"},plan:{},node:{},scope:{},proposal:{},now:"2026-09-23",idempotencyKey:"work-event:binding",data:{resolve:async()=>undefined},services:{patchProject:async(value:unknown)=>{patch=value;return value;}} };
  await registry.workAutomation("project.patch.v1")!(workContext as any,{values:{title:"updated"}});
  assert.deepEqual(patch,{title:"updated"});
});
test("business adapter catalog registration is idempotent",async()=>{
  const {registerDomainActions}=await import("../platform/publication/action-adapters.js");
  registerDomainActions(); const count=actions.listActions().length; registerDomainActions();
  assert.equal(actions.listActions().length,count);
  assert.ok(actions.describeAction("equipment.unit.checkIn"));
  assert.ok(actions.describeAction("websites.page.publish"));
});
test("user permission and capability checks apply before receipt lookup",async()=>{
  const id="test.user-permission";
  actions.registerAction(definition(id,()=>1,{policy:{scopes:["organization"],applications:false,permissions:["manage_projects"]}}));
  const principal={orgId:target.organizationId,userId:"user",role:"member",permissions:{},capabilities:{effectiveByKey:{}}} as any;
  const ctx=contexts.userPublicationContext(principal,{executionKind:"module",mode:"command"});
  await assert.rejects(actions.invokeAction(ctx,ref(id),{amount:1},{idempotencyKey:"denied"}),{code:"publication_permission_denied"});
  const cap="test.capability";
  actions.registerAction(definition(cap,()=>1,{policy:{scopes:["organization"],applications:false,permissions:[],capabilities:["apps.equipment"]}}));
  await assert.rejects(actions.invokeAction(ctx,ref(cap),{amount:1},{idempotencyKey:"denied"}),{code:"publication_capability_denied"});
});
test("nested work calls have distinct stable receipts and cannot repeat effects",async()=>{
  const {registerWorkAutomation}=await import("../work/registry.js");
  const {withWorkPublicationContext}=await import("../platform/publication/work-actions.js");
  const seen:string[]=[];
  registerWorkAutomation("test.nested.work",(ctx)=>{seen.push(ctx.idempotencyKey);return {key:ctx.idempotencyKey};},{inputSchema:{type:"object",additionalProperties:false}});
  const work={event:{organization_id:target.organizationId},project:{id:"p1"},plan:{},node:{},scope:{},proposal:{},now:"2026-09-23",idempotencyKey:"outer",data:{},services:{}} as any;
  await withWorkPublicationContext(work,["test.nested.work"],async ctx=>{
    const targetRef={action:"test.nested.work",target:{scope:"project" as const,organizationId:target.organizationId,projectId:"p1"}};
    await actions.invokeAction(ctx,targetRef,{}, {idempotencyKey:"outer:call1"});
    await actions.invokeAction(ctx,targetRef,{}, {idempotencyKey:"outer:call2"});
    const replay=await actions.invokeAction(ctx,targetRef,{}, {idempotencyKey:"outer:call1"});
    assert.equal(replay.receipt.replayed,true);
  });
  assert.equal(seen.length,2);assert.notEqual(seen[0],seen[1]);
});
