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
