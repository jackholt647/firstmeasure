import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { PlatformAuthContext } from "../platform/auth.js";
import type { PublicationContext } from "../platform/publication/contracts.js";

let root: string;
let service: typeof import("../documents/modules/service.js");
let storage: typeof import("../platform/storage.js");
let bindings: typeof import("../platform/publication/bindings.js");
const auth = { orgId: "modules", userId: "owner", role: "owner", permissions: { "*": true }, capabilities: { effectiveByKey: { "platform.documents": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } } as unknown as PlatformAuthContext;
const ctx: PublicationContext = { auth, organizationId: "modules", executionKind: "module", mode: "evaluate" };
const target = { scope: "project" as const, organizationId: "modules", projectId: "project" };
let cube: unknown = { volume: 40 };
const obj = { type: "object" };
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "module-service-"));
  process.env.NODE_ENV = "test"; process.env.PLATFORM_STORAGE_ROOT = root;
  storage = await import("../platform/storage.js");
  service = await import("../documents/modules/service.js");
  bindings = await import("../platform/publication/bindings.js");
  await storage.createOrganization({ id: "modules" });
  await storage.upsertDocument("modules", "projects", { id: "project", data: {} });
  const { registerDataProvider } = await import("../platform/publication/providers.js");
  registerDataProvider({ id: "cube-test", version: "1", apps: [], exports: { inventory: { schema: obj, schemaVersion: "1", description: "Inventory", access: { scopes: ["project"], permissions: ["view_projects"] }, read: async () => cube ? { value: cube } : { status: "missing", code: "no_cube", message: "No cube sheet." } } } });
  (await import("../documents/modules/provider.js")).registerModuleDataProvider();
});
after(async () => {
  await bindings.closeBindingStoreForTests();
  await (await import("../platform/publication/actions.js")).closeActionDatabase();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  await rm(root, { recursive: true, force: true });
});
test("inventory -> independent workflow -> independent frozen document, manual fallback and override", async () => {
  const workflowModule = await service.publishModule(ctx, { name: "Estimate", kind: "workflow", inputSchema: obj, outputSchema: obj, privateStateSchema: obj,
    exports: { estimate: { path: "/outputs/estimate", schema: obj, access: "read" }, secret: { path: "/outputs/secret", schema: {}, access: "private" } },
    bindings: { cube: { kind: "data", policy: "live", required: false, source: { provider: "cube-test", export: "inventory", target } } },
    source: `const cube = await api.data.read('cube'); const hours = inputs.overrideHours ?? (cube ? cube.volume / 10 : inputs.manualHours); if (hours == null) throw new Error('Manual hours required'); return {outputs:{estimate:{hours,total:hours*100},secret:'hidden'},privateState:{notes:'private'}};` });
  let workflow = await service.createModuleInstance(ctx, { moduleId: String(workflowModule.id), projectId: "project" });
  let evaluated = await service.evaluateModuleInstance(ctx, workflow.id, { expectedRevision: workflow.revision });
  workflow = evaluated.instance as typeof workflow;
  assert.deepEqual((await service.getModuleExports(ctx, workflow.id, "estimate") as any).value, { hours: 4, total: 400 });
  await assert.rejects(service.getModuleExports(ctx, workflow.id, "secret"), /not available/);
  assert.equal(JSON.stringify(await service.moduleInstanceView(ctx, workflow)).includes('hidden'), false);
  const documentModule = await service.publishModule(ctx, { name: "Estimate document", kind: "document", inputSchema: obj, outputSchema: obj, exports: { total: { path: "/outputs/total", schema: { type: "number" }, access: "read" } }, bindings: { estimate: { kind: "data", policy: "frozen", source: { provider: "document-modules", export: "value", args: { exportName: "estimate" }, target: { ...target, id: workflow.id } } } }, source: `const estimate=await api.data.read('estimate'); return {outputs:{total:estimate.total}};` });
  let doc = await service.generateModuleDocument(ctx, workflow.id, { moduleId: String(documentModule.id), bindingName: "estimate", exportName: "estimate", policy: "frozen" });
  assert.notEqual(doc.id, workflow.id); assert.equal(doc.kind, "document");
  doc = (await service.evaluateModuleInstance(ctx, doc.id, { expectedRevision: doc.revision })).instance as typeof doc;
  assert.equal(doc.outputs.total, 400);
  cube = { volume: 90 };
  workflow = (await service.evaluateModuleInstance(ctx, workflow.id, { expectedRevision: workflow.revision })).instance as typeof workflow;
  assert.equal((workflow.outputs.estimate as any).total, 900);
  doc = (await service.evaluateModuleInstance(ctx, doc.id, { expectedRevision: doc.revision })).instance as typeof doc;
  assert.equal(doc.outputs.total, 400);
  await service.freezeModuleInstance(ctx, doc.id, doc.revision);
  await assert.rejects(service.evaluateModuleInstance(ctx, doc.id, { expectedRevision: doc.revision + 1 }), /Frozen/);
  cube = null;
  workflow = await service.updateModuleInputs(ctx, workflow.id, { manualHours: 2 }, workflow.revision) as typeof workflow;
  workflow = (await service.evaluateModuleInstance(ctx, workflow.id, { expectedRevision: workflow.revision })).instance as typeof workflow;
  assert.equal((workflow.outputs.estimate as any).hours, 2);
  workflow = await service.updateModuleInputs(ctx, workflow.id, { overrideHours: 5 }, workflow.revision) as typeof workflow;
  workflow = (await service.evaluateModuleInstance(ctx, workflow.id, { expectedRevision: workflow.revision })).instance as typeof workflow;
  assert.equal((workflow.outputs.estimate as any).hours, 5);
  assert.ok(workflow.bindingManifest);
});
test("permission and project context prevent unauthorized execution or reads", async () => {
  const modules = await service.listModuleInstances(ctx);
  const workflow = modules.find(x => x.kind === "workflow")!;
  await assert.rejects(service.readModuleInstance({ ...ctx, projectId: "other" }, String(workflow.id)), /outside/);
  const viewer = { ...ctx, auth: { ...auth, role: "member", permissions: { view_projects: true } } };
  await assert.rejects(service.evaluateModuleInstance(viewer, String(workflow.id), { expectedRevision: Number(workflow.revision) }), /not permitted/);
  await assert.rejects(service.readModuleInstance({ ...ctx, organizationId: "another" }, String(workflow.id)));
});
test("concurrent command requests serialize; replay never calls effects twice", async () => {
  let count = 0;
  const actions = await import("../platform/publication/actions.js");
  actions.registerAction({ id: "module-test.effect", version: "1", implementation: "module-test-1", domain: "test", description: "Test effect", inputSchema: obj, outputSchema: { type: "number" }, effect: "write", idempotency: "required", executionKinds: ["module"], policy: { scopes: ["project"], permissions: ["manage_projects"] }, execute: () => ++count });
  const module = await service.publishModule(ctx, { name: "Effect", kind: "workflow", inputSchema: obj, outputSchema: obj, exports: {}, bindings: { effect: { kind: "action", policy: "frozen", action: { action: "module-test.effect", target } } }, source: `return {outputs:{n:await api.actions.invoke('effect',{})}};` });
  let instance = await service.createModuleInstance(ctx, { moduleId: String(module.id), projectId: "project" });
  await assert.rejects(service.evaluateModuleInstance(ctx, instance.id, { expectedRevision: instance.revision }), /side effects|Effects require/);
  assert.equal(count, 0);
  instance = await service.readModuleInstance(ctx, instance.id);
  const options = { mode: "command" as const, expectedRevision: instance.revision, idempotencyKey: "once" };
  const results = await Promise.allSettled([service.evaluateModuleInstance(ctx, instance.id, options), service.evaluateModuleInstance(ctx, instance.id, options)]);
  assert.equal(results.filter(x => x.status === "fulfilled").length, 1); assert.equal(count, 1);
  await service.evaluateModuleInstance(ctx, instance.id, options); assert.equal(count, 1);
});
test("writable exports validate input ownership and frozen instances reject writes", async () => {
  const module = await service.publishModule(ctx, { name: "Inventory", kind: "document", inputSchema: obj, outputSchema: obj, exports: { count: { path: "/inputs/count", schema: { type: "number", minimum: 0 }, access: "write" }, total: { path: "/outputs/total", schema: { type: "number" }, access: "read" } }, source: `return {outputs:{total:inputs.count*10}};` });
  let instance = await service.createModuleInstance(ctx, { moduleId: String(module.id), projectId: "project", inputs: { count: 1 } });
  await assert.rejects(service.writeModuleExport(ctx, instance.id, "total", 5, instance.revision), /read-only/);
  await assert.rejects(service.writeModuleExport(ctx, instance.id, "count", -1, instance.revision), /schema/);
  instance = await service.writeModuleExport(ctx, instance.id, "count", 3, instance.revision) as typeof instance;
  instance = (await service.evaluateModuleInstance(ctx, instance.id, { expectedRevision: instance.revision })).instance as typeof instance;
  assert.equal(instance.outputs.total, 30);
  instance = await service.freezeModuleInstance(ctx, instance.id, instance.revision) as typeof instance;
  await assert.rejects(service.writeModuleExport(ctx, instance.id, "count", 4, instance.revision), /Frozen/);
});
test("materialization reuses DocModel without running code again; signed drafts cannot adopt", async () => {
  const { FMDocModel } = await import("../documents/schemas.js");
  const renderer = FMDocModel.createBlankDocument();
  const module = await service.publishModule(ctx, { name: "Rendered", kind: "document", inputSchema: obj, outputSchema: obj, exports: { total: { path: "/outputs/total", schema: { type: "number" }, access: "read" } }, renderer, source: `return {outputs:{total:99}};` });
  let instance = await service.createModuleInstance(ctx, { moduleId: String(module.id), projectId: "project" });
  instance = (await service.evaluateModuleInstance(ctx, instance.id, { expectedRevision: instance.revision })).instance as typeof instance;
  await storage.upsertDocument(ctx.organizationId, "documents", { id: "legacy-draft", data: { id: "legacy-draft", status: "draft", project_id: "project", document_type: "generic", params: {}, outputs: {} } });
  const materialized = await service.materializeModuleDocument(ctx, instance.id, { documentId: "legacy-draft", expectedDocumentRevision: 1 });
  assert.deepEqual(materialized.document.module_render, instance.view);
  assert.equal((materialized.document.module_ref as any).execution_id, instance.lastExecutionId);
  assert.deepEqual(materialized.document.publication, { params: ["total"] });
  const [created, repeated] = await Promise.all([service.materializeModuleDocument(ctx, instance.id), service.materializeModuleDocument(ctx, instance.id)]);
  assert.equal(created.document.id, repeated.document.id);
  assert.equal(created.document.revision, repeated.document.revision);
  await storage.upsertDocument(ctx.organizationId, "documents", { id: "legacy-draft", data: { status: "signed" } });
  await assert.rejects(service.materializeModuleDocument(ctx, instance.id, { documentId: "legacy-draft", expectedDocumentRevision: 3 }), /Only a draft/);
  instance = await service.updateModuleInputs(ctx, instance.id, { override: 123 }, instance.revision) as typeof instance;
  assert.deepEqual((await storage.readDocument(ctx.organizationId, "documents", "legacy-draft")).data.params, { total: 99 });
});

test("standard provider and action grants do not require internal service operations", async () => {
  const { systemPublicationContext } = await import("../platform/publication/context.js");
  const { readPublishedData } = await import("../platform/publication/providers.js");
  const { invokeAction } = await import("../platform/publication/actions.js");
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues("modules", { "platform.expanded_access": true, "platform.documents": true });
  const module = await service.publishModule(ctx, { name: "Shared inputs", kind: "document", inputSchema: obj, outputSchema: obj, exports: { count: { path: "/inputs/count", schema: { type: "number", minimum: 0 }, access: "write" }, secret: { path: "/inputs/secret", schema: {}, access: "private" } }, source: `return {outputs:{}};` });
  const instance = await service.createModuleInstance(ctx, { moduleId: String(module.id), projectId: "project", inputs: { count: 1, secret: "hidden" } });
  const readCtx = systemPublicationContext({ kind: "work", organizationId: "modules", projectId: "project", operations: ["document-modules.value"] });
  const ref = { provider: "document-modules", export: "value", target: { ...target, id: instance.id }, args: { exportName: "count" } };
  assert.equal((await readPublishedData(readCtx, ref) as any).value, 1);
  assert.equal((await readPublishedData(readCtx, { ...ref, args: { exportName: "secret" } })).status, "denied");
  const writeCtx = systemPublicationContext({ kind: "work", organizationId: "modules", projectId: "project", operations: ["document-modules.export.write"], mode: "command" });
  const actionRef = { action: "document-modules.export.write", target: { ...target, id: instance.id } };
  const input = { exportName: "count", value: 2, expectedRevision: instance.revision };
  const result = await invokeAction(writeCtx, actionRef, input, { idempotencyKey: "once" });
  assert.equal((await invokeAction(writeCtx, actionRef, input, { idempotencyKey: "once" })).receipt.replayed, true);
  assert.equal((await readPublishedData(readCtx, ref) as any).value, 2);
  assert.equal((result.value as any).revision, instance.revision + 1);
  await assert.rejects(invokeAction({ ...writeCtx, mode: "evaluate" }, actionRef, input, { idempotencyKey: "denied" }));
  await assert.rejects(invokeAction(writeCtx, { ...actionRef, target: { ...actionRef.target, projectId: "other" } }, input, { idempotencyKey: "wrong-project" }));
});
test("retained module render overlays signature and delivery evidence without refreshing prices", async () => {
  const { FMDocModel } = await import("../documents/schemas.js");
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues("modules", { "platform.expanded_access": true, "platform.documents": true, "documents.esign": true, "documents.payments": true });
  const { resolveDocumentInstance } = await import("../documents/service.js");
  const document = FMDocModel.createDocument();
  (document.pages as any[])[0].children = [
    FMDocModel.createNode("widget", { id: "sig", props: { widget: "doc.signature@1", config: { output: "sig_customer" } } }),
    FMDocModel.createNode("widget", { id: "qr", props: { widget: "doc.qr@1", config: {} } }),
    FMDocModel.createNode("widget", { id: "prices", props: { widget: "doc.line_items@1", config: {} } })
  ];
  const captured = { resolved_definition: document, widget_data: { sig: null, qr: null, prices: { total: 400 } }, theme: {}, theme_ref: {}, theme_vars: {}, theme_context: {}, scope: { params: { total: 400 }, project: {} }, sources: { price: 400 }, skipped_overrides: [] };
  const output = await resolveDocumentInstance("modules", { id: "signed", project_id: "project", module_ref: { execution_id: "e" }, module_resolved: captured, output_defs: { sig_customer: { required: true } } }, { snapshot: { public_token: "new-delivery-token", outputs: { sig_customer: { signed_at: "2026-09-23", text: "Customer" } } } });
  assert.equal((output.widget_data.sig as any).signed, true);
  assert.match((output.widget_data.qr as any).url, /new-delivery-token/);
  assert.deepEqual(output.widget_data.prices, { total: 400 });
  assert.deepEqual(output.sources, { price: 400 });
});

test("draft dependency refresh is topological, read probes do not write, and frozen results stay fixed", async () => {
  const { refreshModuleGraph, inspectModuleGraph } = await import("../documents/modules/dependencies.js");
  cube = { volume: 20 };
  const upstream = await service.publishModule(ctx, { name: "Source", kind: "workflow", inputSchema: obj, outputSchema: obj,
    exports: { total: { path: "/outputs/total", schema: { type: "number" }, access: "read" } },
    bindings: { source: { kind: "data", policy: "live", source: { provider: "cube-test", export: "inventory", target } } },
    source: "return {outputs:{total:(await api.data.read('source')).volume}};" });
  let a = await service.createModuleInstance(ctx, { moduleId: String(upstream.id), projectId: "project" });
  const downstream = await service.publishModule(ctx, { name: "Consumer", kind: "document", inputSchema: obj, outputSchema: obj,
    exports: { total: { path: "/outputs/total", schema: { type: "number" }, access: "read" } },
    bindings: { source: { kind: "data", policy: "live", source: { provider: "document-modules", export: "value", args: { exportName: "total" }, target: { ...target, id: a.id } } } },
    source: "return {outputs:{total:2*await api.data.read('source')}};" });
  let b = await service.createModuleInstance(ctx, { moduleId: String(downstream.id), projectId: "project" });
  assert.equal((await inspectModuleGraph(ctx, b.id)).stale, true);
  assert.equal((await service.readModuleInstance(ctx, a.id)).revision, a.revision);
  const initial = await refreshModuleGraph(ctx, b.id, b.revision);
  assert.deepEqual(initial.refreshed, [a.id, b.id]); b = initial.instance;
  assert.equal(b.outputs.total, 40);
  assert.deepEqual((await refreshModuleGraph(ctx, b.id, b.revision)).refreshed, []);
  cube = { volume: 30 };
  b = (await refreshModuleGraph(ctx, b.id, b.revision)).instance;
  assert.equal(b.outputs.total, 60);
  b = await service.freezeModuleInstance(ctx, b.id, b.revision) as typeof b;
  cube = { volume: 90 };
  assert.deepEqual((await refreshModuleGraph(ctx, b.id, b.revision)).refreshed, []);
  assert.equal((await service.getModuleExports(ctx, b.id, "total") as any).value, 60);
  a = await service.readModuleInstance(ctx, a.id);
  await service.updateModuleBindings(ctx, a.id, { source: { kind: "data", policy: "live", source: { provider: "document-modules", export: "value", args: { exportName: "total" }, target: { ...target, id: a.id } } } }, a.revision);
  await assert.rejects(inspectModuleGraph(ctx, a.id), /cycle/);
});

test("derived live and frozen exports cannot preserve revoked source access", async () => {
  const { registerDataProvider, readPublishedData } = await import("../platform/publication/providers.js");
  const { forbidden } = await import("../platform/errors.js");
  let granted = true;
  registerDataProvider({ id: "revocable-module-source", version: "1", apps: [], exports: { value: { description: "Protected", schema: obj, schemaVersion: "1",
    access: { scopes: ["project"], permissions: ["view_projects"], authorize: () => { if (!granted) throw forbidden("revoked", "Source access revoked"); } }, read: async () => ({ value: { n: 7 } }) } } });
  const module = await service.publishModule(ctx, { name: "Derived", kind: "document", inputSchema: obj, outputSchema: obj,
    exports: { total: { path: "/outputs/total", schema: { type: "number" }, access: "read" } },
    bindings: { source: { kind: "data", policy: "frozen", source: { provider: "revocable-module-source", export: "value", target } } },
    source: "return {outputs:{total:(await api.data.read('source')).n}};" });
  let instance = await service.createModuleInstance(ctx, { moduleId: String(module.id), projectId: "project" });
  instance = (await service.evaluateModuleInstance(ctx, instance.id, { expectedRevision: instance.revision })).instance as typeof instance;
  const ref = { provider: "document-modules", export: "value", args: { exportName: "total" }, target: { ...target, id: instance.id } };
  const binding = { kind: "data" as const, policy: "frozen" as const, source: ref };
  assert.equal((await bindings.resolveDataBinding(ctx, "protected-consumer", "n", binding)).status, "ready");
  granted = false;
  assert.equal((await readPublishedData(ctx, ref)).status, "denied");
  await assert.rejects(bindings.resolveDataBinding(ctx, "protected-consumer", "n", binding), /revoked/);
  await assert.rejects(service.moduleInstanceView(ctx, instance), /revoked/);
});


test("live code adopts compatible versions while pinned code and accepted artifacts retain theirs", async () => {
  const { refreshModuleGraph, inspectModuleGraph } = await import("../documents/modules/dependencies.js");
  const definition = { name:"Live calculation",kind:"workflow",inputSchema:obj,outputSchema:obj,exports:{total:{path:"/outputs/total",schema:{type:"number"},access:"read"}},source:"return {outputs:{total:1}};" };
  const module=await service.publishModule(ctx,definition);
  let live=await service.createModuleInstance(ctx,{moduleId:String(module.id),projectId:"project",codePolicy:"live"});
  let pinned=await service.createModuleInstance(ctx,{moduleId:String(module.id),projectId:"project"});
  live=(await refreshModuleGraph(ctx,live.id,live.revision)).instance;
  pinned=(await refreshModuleGraph(ctx,pinned.id,pinned.revision)).instance;
  await service.publishModule(ctx,{...definition,source:"return {outputs:{total:2}};"},String(module.id));
  assert.equal((await inspectModuleGraph(ctx,live.id)).stale,true);
  assert.equal((await inspectModuleGraph(ctx,pinned.id)).stale,false);
  live=(await refreshModuleGraph(ctx,live.id,live.revision)).instance;
  assert.equal(live.outputs.total,2);assert.equal(pinned.outputs.total,1);
  const goodVersion=live.version;
  await service.publishModule(ctx,{...definition,source:"throw new Error('broken update');"},String(module.id));
  await assert.rejects(refreshModuleGraph(ctx,live.id,live.revision),/broken update/);
  const retained=await service.readModuleInstance(ctx,live.id);
  assert.equal(retained.version,goodVersion);assert.equal(retained.outputs.total,2);
});

test("existing visual builders publish executable designs and legacy create retains their evaluated artifact", async () => {
  const assets=await import("../documents/storage.js");
  const docs=await import("../documents/service.js");
  const {FMDocModel}=await import("../documents/schemas.js");
  const definition={...FMDocModel.createBlankDocument(),params:{quantity:{type:"number",required:true}},program:{enabled:true,inputSchema:{type:"object",required:["quantity"],properties:{quantity:{type:"number"}}},outputSchema:obj,exports:{total:{path:"/outputs/total",schema:{type:"number"},access:"read"}},bindings:{},source:"return {outputs:{total:inputs.quantity*50}};"}};
  const template=await assets.createDocumentTemplate(ctx.organizationId,{name:"Calculated template",document_type:"generic",definition},auth);
  const version=await assets.readDocumentTemplateVersion(ctx.organizationId,String(template.id),1);
  assert.ok(version);const program=(version.definition as any).program;assert.ok(program.moduleId);assert.ok(program.moduleVersion);
  const result=await docs.createDocumentInstance(ctx.organizationId,"project",{document_type:"generic",template_id:template.id,workflow_id:null,params:{quantity:3}},auth);
  assert.equal((result.document.params as any).total,150);assert.ok(result.document.module_resolved);
  assert.equal((result.document.module_ref as any).version,program.moduleVersion);
  const before=(await storage.listDocuments(ctx.organizationId,"documents")).length;
  await assert.rejects(docs.createDocumentInstance(ctx.organizationId,"project",{document_type:"generic",template_id:template.id,workflow_id:null,params:{quantity:"bad"}},auth),/schema/);
  assert.equal((await storage.listDocuments(ctx.organizationId,"documents")).length,before);
  const workflow=await assets.createDocumentWorkflow(ctx.organizationId,{name:"Calculated workflow",definition:{schema_version:1,name:"Calculator",steps:[{id:"details",items:[]}],program:{...definition.program}}},auth);
  const flowVersion=await assets.readDocumentWorkflowVersion(ctx.organizationId,String(workflow.id),1);
  assert.ok(flowVersion);const flowModule=await service.moduleDefinition(ctx,(flowVersion.definition as any).program.moduleId);
  assert.equal((flowModule.definition as any).workflow.steps[0].id,"details");
});


test("retained values from read actions recheck resource authorization", async () => {
  const {registerAction}=await import("../platform/publication/actions.js");
  const {forbidden}=await import("../platform/errors.js");
  let permitted=true;
  registerAction({id:"private-calculation",version:"1",implementation:"1",domain:"test",description:"Protected calculation",inputSchema:obj,outputSchema:obj,effect:"read",executionKinds:["module"],idempotency:"none",policy:{scopes:["project"],permissions:[],authorize:()=>{if(!permitted)throw forbidden("revoked","Calculation access revoked");}},execute:async()=>({amount:5})});
  const module=await service.publishModule(ctx,{name:"Calculated source",kind:"document",inputSchema:obj,outputSchema:obj,exports:{amount:{path:"/outputs/amount",schema:{type:"number"},access:"read"}},bindings:{calculation:{kind:"action",policy:"live",action:{action:"private-calculation",target}}},source:"return {outputs:await api.actions.invoke('calculation',{})};"});
  let instance=await service.createModuleInstance(ctx,{moduleId:String(module.id),projectId:"project"});
  instance=(await service.evaluateModuleInstance(ctx,instance.id,{expectedRevision:instance.revision})).instance as typeof instance;
  assert.equal((await service.getModuleExports(ctx,instance.id,"amount") as any).value,5);
  permitted=false;await assert.rejects(service.getModuleExports(ctx,instance.id,"amount"),/revoked/);
});


test("an uncertain command is retained for explicit review and never automatically repeated",async()=>{
 const {registerAction}=await import("../platform/publication/actions.js");let calls=0;
 registerAction({id:"uncertain-effect",version:"1",implementation:"1",domain:"test",description:"Effect fails after acceptance",inputSchema:obj,outputSchema:obj,effect:"write",executionKinds:["module"],idempotency:"required",policy:{scopes:["project"],permissions:[]},execute:async()=>{calls++;throw new Error("Remote outcome unknown");}});
 const module=await service.publishModule(ctx,{name:"Uncertain",kind:"workflow",inputSchema:obj,outputSchema:obj,exports:{},bindings:{effect:{kind:"action",policy:"live",action:{action:"uncertain-effect",target}}},source:"await api.actions.invoke('effect',{});return {outputs:{}};"});
 let instance=await service.createModuleInstance(ctx,{moduleId:String(module.id),projectId:"project"});
 await assert.rejects(service.evaluateModuleInstance(ctx,instance.id,{mode:"command",expectedRevision:instance.revision,idempotencyKey:"uncertain"}),/unknown/);
 instance=await service.readModuleInstance(ctx,instance.id);assert.ok(instance.uncertainExecution);
 const view=await service.moduleInstanceView(ctx,instance);assert.equal(view.lastAttempt?.status,"uncertain");
 await assert.rejects(service.evaluateModuleInstance(ctx,instance.id,{mode:"command",expectedRevision:instance.revision,idempotencyKey:"new"}),/Review/);
 await assert.rejects(service.updateModuleInputs(ctx,instance.id,{},instance.revision),/Review/);
 const viewer={...ctx,auth:{...auth,role:"member",permissions:{view_projects:true,manage_projects:true}} as typeof auth};
 await assert.rejects(service.reconcileModuleCommand(viewer,instance.id,instance.revision,String(instance.uncertainExecution),"Reviewed external outcome"),/permitted/);
 await service.reconcileModuleCommand(ctx,instance.id,instance.revision,String(instance.uncertainExecution),"Verified external record; retained prior result.");
 instance=await service.readModuleInstance(ctx,instance.id);assert.equal(instance.uncertainExecution,null);assert.equal(calls,1);
});


test("scope action registry composes independent module instances with project isolation and stable effects",async()=>{
 const {invokeAction}=await import("../platform/publication/actions.js");
 const module=await service.publishModule(ctx,{name:"Scope calculator",kind:"workflow",inputSchema:obj,outputSchema:obj,exports:{total:{path:"/outputs/total",schema:{type:"number"},access:"read"}},source:"return {outputs:{total:inputs.quantity*10}};"});
 const work={...ctx,executionKind:"work" as const,mode:"command" as const};
 const create={action:"document-modules.instance.create",target};
 const input={moduleId:String(module.id),inputs:{quantity:4}};
 const first=await invokeAction(work,create,input,{idempotencyKey:"scope-instance"});
 const replay=await invokeAction(work,create,input,{idempotencyKey:"scope-instance"});
 assert.deepEqual(first.value,replay.value);
 const instance=first.value as {id:string;revision:number};
 const refresh=await invokeAction(work,{action:"document-modules.instance.refresh",target:{...target,id:instance.id}},{expectedRevision:instance.revision},{idempotencyKey:"scope-refresh"});
 assert.equal((refresh.value as any).exports.total,40);
 await assert.rejects(invokeAction(work,{action:"document-modules.instance.refresh",target:{...target,projectId:"other",id:instance.id}},{expectedRevision:(refresh.value as any).revision},{idempotencyKey:"wrong-project"}),/outside/);
});
