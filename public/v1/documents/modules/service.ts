import { randomUUID } from "node:crypto";
import type { PublicationContext, DataBinding } from "../../platform/publication/contracts.js";
import { authorizePublication } from "../../platform/publication/context.js";
import { createBindingSession } from "../../platform/publication/bindings.js";
import { hasPermission } from "../../platform/auth.js";
import { contentHash, jsonClone, readPointer, validateJson } from "../../platform/publication/validation.js";
import { badRequest, conflict, forbidden, PlatformError } from "../../platform/errors.js";
import { readDocument, type JsonObject } from "../../platform/storage.js";
import { FMDocModel } from "../schemas.js";
import { moduleBindingSchema, validateModuleDefinition, validateModuleView, type ModuleDefinition } from "./schemas.js";
import { getRecord, saveRecord, records, MODULES, VERSIONS, INSTANCES, EXECUTIONS } from "./storage.js";
import { runModuleCode, type ModuleBroker } from "./runtime.js";

export type ModuleInstance = JsonObject & { id: string; revision: number; projectId: string; moduleId: string; version: string; kind: "document" | "workflow"; inputs: JsonObject; outputs: JsonObject; privateState: JsonObject; bindings: ModuleDefinition["bindings"] };
export type ModuleExecutionBroker = ModuleBroker & { manifest?: () => unknown };
export type ModuleBrokerFactory = (ctx: PublicationContext, instance: ModuleInstance) => ModuleExecutionBroker | Promise<ModuleExecutionBroker>;
let factory: ModuleBrokerFactory = (ctx, instance) => {
  const session = createBindingSession(ctx, instance.id, instance.bindings);
  return { read: name => session.read(name), invoke: (name, input) => session.invoke(name, input), manifest: () => session.manifest() };
};
export function configureModuleBroker(value: ModuleBrokerFactory) { factory = value; }
const id = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "")}`;
const optionalRecord = (org: string, collection: string, id: string) => readDocument(org, collection, id).catch(error => { if (error instanceof PlatformError && error.statusCode === 404) return null; throw error; });
async function allowed(ctx: PublicationContext, projectId?: string, edit: boolean | "instance" = false, operation?: string) {
  await authorizePublication(ctx, { scope: projectId ? "project" : "organization", organizationId: ctx.organizationId, ...(projectId ? { projectId } : {}) }, {
    scopes: ["organization", "project"], permissions: [edit === "instance" ? "manage_projects|manage_company_settings" : edit ? "manage_company_settings" : "view_projects"], systemKinds: ["module", "work", "agent"], capabilities: ["platform.documents"]
  }, operation || (edit ? "document-modules.manage" : "document-modules.read"));
}
export async function listModules(ctx: PublicationContext) { await allowed(ctx); return records(ctx.organizationId, MODULES); }
export async function publishModule(ctx: PublicationContext, raw: unknown, moduleId = "") {
  await allowed(ctx, undefined, true);
  const definition = validateModuleDefinition(raw);
  const version = contentHash(definition);
  const selectedId = moduleId || id("module");
  const key = `${selectedId}_${version}`;
  if (!(await optionalRecord(ctx.organizationId, VERSIONS, key))) await saveRecord(ctx.organizationId, VERSIONS, key, { moduleId: selectedId, version, definition, createdAt: new Date().toISOString() }, undefined, true);
  return saveRecord(ctx.organizationId, MODULES, selectedId, { name: definition.name, kind: definition.kind, version });
}
export async function moduleDefinition(ctx: PublicationContext, moduleId: string, version?: string) {
  await allowed(ctx, ctx.projectId);
  const current = await getRecord(ctx.organizationId, MODULES, moduleId);
  return getRecord(ctx.organizationId, VERSIONS, `${moduleId}_${version || current.version}`);
}
export async function readModuleInstance(ctx: PublicationContext, instanceId: string): Promise<ModuleInstance> {
  const instance = await getRecord(ctx.organizationId, INSTANCES, instanceId) as ModuleInstance;
  await allowed(ctx, instance.projectId);
  return instance;
}
export async function listModuleInstances(ctx: PublicationContext) {
  await allowed(ctx, ctx.projectId);
  return (await records(ctx.organizationId, INSTANCES)).filter(x => !ctx.projectId || x.projectId === ctx.projectId);
}
export async function createModuleInstance(ctx: PublicationContext, input: { moduleId: string; version?: string; projectId: string; inputs?: JsonObject; bindings?: ModuleDefinition["bindings"] }, instanceId = id("module_instance")) {
  await allowed(ctx, input.projectId, "instance");
  if (!input.projectId || !(await readDocument(ctx.organizationId, "projects", input.projectId))) throw badRequest("module_project_missing", "An existing project is required.");
  const asset = await moduleDefinition(ctx, input.moduleId, input.version);
  const definition = validateModuleDefinition(asset.definition);
  const inputs = jsonClone(input.inputs || {});
  validateJson(definition.inputSchema, inputs, "module inputs");
  const bindings = { ...definition.bindings };
  for (const [name, binding] of Object.entries(input.bindings || {})) {
    if (!Object.hasOwn(bindings, name)) throw badRequest("module_binding_undeclared", "Instance bindings must be declared by the module.");
    bindings[name] = moduleBindingSchema.parse(binding);
  }
  return saveRecord(ctx.organizationId, INSTANCES, instanceId, { organizationId: ctx.organizationId, projectId: input.projectId, moduleId: input.moduleId, version: asset.version, kind: definition.kind, inputs, outputs: {}, privateState: {}, bindings, frozen: false, createdAt: new Date().toISOString() }, undefined, true) as Promise<ModuleInstance>;
}
export async function updateModuleInputs(ctx: PublicationContext, instanceId: string, inputs: JsonObject, expectedRevision: number) {
  const instance = await readModuleInstance(ctx, instanceId);
  await allowed(ctx, instance.projectId, "instance");
  return saveModuleInputs(ctx, instance, inputs, expectedRevision);
}
async function saveModuleInputs(ctx: PublicationContext, instance: ModuleInstance, inputs: JsonObject, expectedRevision: number) {
  if (instance.activeExecution) throw conflict("module_execution_pending", "Module execution is in progress.");
  if (instance.frozen) throw conflict("module_frozen", "Frozen module instances cannot be changed.");
  if (!expectedRevision || expectedRevision !== instance.revision) throw conflict("module_revision", "The current revision is required.");
  const definition = validateModuleDefinition((await getRecord(ctx.organizationId, VERSIONS, `${instance.moduleId}_${instance.version}`)).definition);
  const updated = { ...instance.inputs, ...jsonClone(inputs) };
  validateJson(definition.inputSchema, updated, "module inputs");
  return saveRecord(ctx.organizationId, INSTANCES, instance.id, { ...instance, inputs: updated, outputs: {}, lastExecutionId: null }, expectedRevision);
}
export async function evaluateModuleInstance(ctx: PublicationContext, instanceId: string, options: { mode?: "evaluate" | "command"; expectedRevision: number; idempotencyKey?: string } ) {
  const instance = await readModuleInstance(ctx, instanceId);
  if (instance.frozen) throw conflict("module_frozen", "Frozen module instances cannot be evaluated again.");
  await allowed(ctx, instance.projectId, "instance");
  const mode = options.mode || "evaluate";
  if (mode === "command" && !options.idempotencyKey) throw badRequest("module_idempotency_required", "Commands require an idempotency key.");
  const definition = validateModuleDefinition((await moduleDefinition(ctx, instance.moduleId, instance.version)).definition);
  validateJson(definition.inputSchema, instance.inputs, "module inputs");
  const invocationId = mode === "command" ? contentHash({ instanceId, key: options.idempotencyKey }) : id("evaluation");
  const requestHash = contentHash({ instanceId, mode, expectedRevision: options.expectedRevision });
  const previous = await optionalRecord(ctx.organizationId, EXECUTIONS, invocationId);
  if (previous) {
    if (previous.data.requestHash !== requestHash) throw conflict("module_idempotency_conflict", "This key belongs to a different request.");
    if (previous.data.status === "complete") return { instance: previous.data.resultInstance, execution: previous.data };
    throw conflict("module_execution_pending", "This command already started; inspect its receipt before retrying.");
  }
  if (options.expectedRevision !== instance.revision) throw conflict("module_revision", "The current revision is required.");
  if (instance.activeExecution) throw conflict("module_execution_pending", "Module execution is in progress.");
  // CAS claim serializes execution across processes before any capability can run.
  const claimed = await saveRecord(ctx.organizationId, INSTANCES, instanceId, { ...instance, activeExecution: invocationId }, instance.revision);
  const execution = { instanceId, requestHash, inputRevision: instance.revision, definitionVersion: instance.version, mode, status: "started", startedAt: new Date().toISOString() };
  await saveRecord(ctx.organizationId, EXECUTIONS, invocationId, execution, undefined, true);
  const boundContext: PublicationContext = { ...ctx, projectId: instance.projectId, mode, invocationId };
  try {
    const broker = await factory(boundContext, instance);
    const checkedBroker: ModuleBroker = {
      read: name => { if (instance.bindings[name]?.kind !== "data") throw badRequest("module_binding_undeclared", "Data binding is not declared."); return broker.read(name); },
      invoke: (name, input) => { if (instance.bindings[name]?.kind !== "action") throw badRequest("module_binding_undeclared", "Action binding is not declared."); return broker.invoke(name, input); }
    };
    const result = await runModuleCode({ source: definition.source, inputs: instance.inputs, state: instance.privateState, mode, now: execution.startedAt }, checkedBroker);
    validateJson({ type: "object", required: ["outputs"], properties: { outputs: { type: "object" }, privateState: { type: "object" }, view: { type: "object" } }, additionalProperties: false }, result, "module result");
    validateJson(definition.outputSchema, result.outputs, "module outputs");
    validateJson(definition.privateStateSchema, result.privateState || instance.privateState, "private state");
    const rawView = result.view || definition.renderer;
    const view = rawView ? validateModuleView(FMDocModel.resolveBindings(validateModuleView(rawView), { params: instance.inputs, outputs: result.outputs, computed: result.outputs })) : null;
    const bindingManifest = jsonClone(broker.manifest?.() || {});
    const updated = await saveRecord(ctx.organizationId, INSTANCES, instanceId, { ...instance, activeExecution: null, outputs: result.outputs, privateState: result.privateState || instance.privateState, view, lastExecutionId: invocationId, bindingManifest }, Number(claimed.revision));
    const receipt = await saveRecord(ctx.organizationId, EXECUTIONS, invocationId, { ...execution, status: "complete", completedAt: new Date().toISOString(), outputs: result.outputs, view, bindings: instance.bindings, bindingManifest, codeHash: contentHash(definition.source), engine: definition.engine, resultInstance: updated });
    return { instance: updated, execution: receipt };
  } catch (error) {
    await saveRecord(ctx.organizationId, EXECUTIONS, invocationId, { ...execution, status: error instanceof PlatformError && error.code === "module_effect_uncertain" ? "uncertain" : "failed", error: error instanceof Error ? error.message : "Execution failed." });
    await saveRecord(ctx.organizationId, INSTANCES, instanceId, { ...instance, activeExecution: null }, Number(claimed.revision)).catch(() => undefined);
    throw error;
  }
}
export async function freezeModuleInstance(ctx: PublicationContext, instanceId: string, expectedRevision: number) {
  const instance = await readModuleInstance(ctx, instanceId);
  await allowed(ctx, instance.projectId, "instance");
  if (instance.activeExecution) throw conflict("module_execution_pending", "Module execution is in progress.");
  if (!instance.lastExecutionId || instance.revision !== expectedRevision) throw conflict("module_freeze_invalid", "Evaluate the current inputs and provide the current revision before freezing.");
  if (instance.frozen) return instance;
  return saveRecord(ctx.organizationId, INSTANCES, instanceId, { ...instance, frozen: true, frozenAt: new Date().toISOString() }, expectedRevision);
}
export async function getModuleExportDescriptor(ctx: PublicationContext, instanceId: string, exportName: string, operation: "document-modules.read" | "document-modules.value" | "document-modules.export.write" = "document-modules.read") {
  const instance = await getRecord(ctx.organizationId, INSTANCES, instanceId) as ModuleInstance;
  await allowed(ctx, instance.projectId, operation === "document-modules.export.write" ? "instance" : false, operation);
  const definition = validateModuleDefinition((await getRecord(ctx.organizationId, VERSIONS, `${instance.moduleId}_${instance.version}`)).definition);
  const field = definition.exports[exportName];
  if (!field || field.access === "private") throw forbidden("module_export_private", "This module export is not available.");
  return { instance, field };
}
export async function getModuleExports(ctx: PublicationContext, instanceId: string, exportName: string, operation: "document-modules.read" | "document-modules.value" = "document-modules.read") {
  const { instance, field } = await getModuleExportDescriptor(ctx, instanceId, exportName, operation);
  const value = readPointer({ inputs: instance.inputs, outputs: instance.outputs }, field.path);
  if (value === undefined) return { status: "pending" as const, code: "module_output_pending", message: "Module has not produced this export." };
  validateJson(field.schema, value, exportName);
  return { status: "ready" as const, value: jsonClone(value), schema: field.schema, revision: String(instance.revision), provenance: { moduleId: instance.moduleId, version: instance.version, instanceId, kind: instance.kind, frozen: !!instance.frozen, executionId: instance.lastExecutionId || null } };
}
export async function writeModuleExport(ctx: PublicationContext, instanceId: string, exportName: string, value: unknown, expectedRevision: number) {
  const { instance, field } = await getModuleExportDescriptor(ctx, instanceId, exportName, "document-modules.export.write");
  if (field.access !== "write") throw forbidden("module_export_readonly", "This export is read-only.");
  validateJson(field.schema, value, exportName);
  const inputs = jsonClone(instance.inputs);
  const parts = field.path.slice("/inputs/".length).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  if (parts.some(part => ["__proto__", "prototype", "constructor"].includes(part) || !part)) throw badRequest("module_export_path", "Invalid writable export path.");
  let parent: Record<string, unknown> = inputs;
  for (const part of parts.slice(0, -1)) {
    if (!parent[part] || typeof parent[part] !== "object" || Array.isArray(parent[part])) throw badRequest("module_export_path", "Writable export parent must be an existing object.");
    parent = parent[part] as Record<string, unknown>;
  }
  parent[parts.at(-1)!] = jsonClone(value);
  return saveModuleInputs(ctx, instance, inputs, expectedRevision);
}
export async function generateModuleDocument(ctx: PublicationContext, workflowId: string, input: { moduleId: string; bindingName: string; exportName: string; policy: "live" | "frozen"; inputs?: JsonObject }) {
  const workflow = await readModuleInstance(ctx, workflowId);
  await allowed(ctx, workflow.projectId, "instance");
  if (workflow.kind !== "workflow" || !workflow.lastExecutionId) throw badRequest("module_workflow_required", "An evaluated workflow instance is required.");
  const exported = await getModuleExports(ctx, workflowId, input.exportName);
  if (exported.status !== "ready") throw conflict("module_export_pending", "The workflow export is not ready.");
  const definition = validateModuleDefinition((await moduleDefinition(ctx, input.moduleId)).definition);
  if (definition.kind !== "document" || definition.bindings[input.bindingName]?.kind !== "data") throw badRequest("module_document_binding", "Choose a document module and its declared data binding.");
  const binding: DataBinding = { kind: "data", policy: input.policy, required: true, source: { provider: "document-modules", export: "value", args: { exportName: input.exportName }, ...(input.policy === "frozen" ? { revision: String(workflow.revision) } : {}), target: { scope: "project", organizationId: ctx.organizationId, projectId: workflow.projectId, id: workflowId } } };
  const generatedId = `module_instance_${contentHash({ workflowId, workflowRevision: workflow.revision, ...input, inputs: input.inputs || {} }).slice(0, 32)}`;
  const prior = await optionalRecord(ctx.organizationId, INSTANCES, generatedId);
  const generated = prior ? await readModuleInstance(ctx, generatedId) : await createModuleInstance(ctx, { moduleId: input.moduleId, projectId: workflow.projectId, inputs: input.inputs, bindings: { [input.bindingName]: binding } }, generatedId);
  if (input.policy === "frozen") await createBindingSession({ ...ctx, projectId: workflow.projectId }, generated.id, generated.bindings).read(input.bindingName);
  return generated;
}

/** HTTP views never expose private execution state or undeclared calculated values. */
export async function moduleInstanceView(ctx: PublicationContext, instance: ModuleInstance | JsonObject) {
  const module = instance as ModuleInstance;
  const definition = validateModuleDefinition((await moduleDefinition(ctx, module.moduleId, module.version)).definition);
  const exports: JsonObject = {};
  for (const [name, field] of Object.entries(definition.exports)) {
    if (field.access === "private") continue;
    const value = readPointer({ inputs: module.inputs, outputs: module.outputs }, field.path);
    if (value !== undefined) exports[name] = jsonClone(value);
  }
  const manager = !!ctx.auth && hasPermission(ctx.auth, "manage_company_settings");
  return { id: module.id, revision: module.revision, projectId: module.projectId, moduleId: module.moduleId, version: module.version, kind: module.kind, frozen: !!module.frozen, lastExecutionId: module.lastExecutionId || null, view: module.view || null, exports, ...(manager ? { inputs: module.inputs, bindings: module.bindings } : {}) };
}

/** Explicit bridge into the existing portal/signature/PDF system. Never re-runs code. */
export async function materializeModuleDocument(ctx: PublicationContext, instanceId: string, input: { documentId?: string; expectedDocumentRevision?: number; title?: string } = {}) {
  const instance = await readModuleInstance(ctx, instanceId);
  await allowed(ctx, instance.projectId, "instance");
  if (!ctx.auth) throw forbidden("module_document_user_required", "A user must create or attach a rendered document.");
  if (instance.kind !== "document" || !instance.lastExecutionId || !instance.view || instance.activeExecution) throw badRequest("module_document_unrendered", "Evaluate a document module with a valid view first.");
  const { readDocumentInstance, saveDocumentInstance } = await import("../storage.js");
  const { createDocumentInstance, resolveDocumentInstance } = await import("../service.js");
  const materializationKey = contentHash({ instanceId, executionId: instance.lastExecutionId });
  const generatedId = `doc_module_${materializationKey.slice(0, 32)}`;
  let document;
  if (input.documentId) document = await readDocumentInstance(ctx.organizationId, input.documentId);
  else {
    const prior = await optionalRecord(ctx.organizationId, "documents", generatedId);
    if (prior) document = await readDocumentInstance(ctx.organizationId, generatedId);
    else {
      try { document = (await createDocumentInstance(ctx.organizationId, instance.projectId, { id: generatedId, document_type: "generic", title: input.title || "Module document", workflow_id: null, metadata: { module_materialization: materializationKey } }, ctx.auth, { createOnly: true })).document; }
      catch (error) { if (!(error instanceof PlatformError) || error.statusCode !== 409) throw error; document = await readDocumentInstance(ctx.organizationId, generatedId); }
    }
    if ((document.metadata as JsonObject)?.module_materialization !== materializationKey || document.project_id !== instance.projectId) throw conflict("module_materialization_identity", "The materialized document identity conflicts.");
    if ((document.module_ref as JsonObject)?.execution_id === instance.lastExecutionId && document.module_resolved) return { document };
  }
  if (document.project_id !== instance.projectId || document.status !== "draft") throw conflict("module_document_not_draft", "Only a draft in the same project may adopt this module result.");
  if (input.documentId && input.expectedDocumentRevision !== document.revision) throw conflict("module_document_revision", "The current document revision is required.");
  const publicParams = (await moduleInstanceView(ctx, instance)).exports;
  const renderedDocument = {
    ...document, module_ref: { instance_id: instanceId, module_id: instance.moduleId, version: instance.version, execution_id: instance.lastExecutionId, revision: instance.revision },
    module_render: validateModuleView(instance.view), module_binding_manifest: instance.bindingManifest || {},
    module_resolved: null,
    // Rendering was resolved during evaluation. Import only explicitly public exports as params.
    params: publicParams, publication: { params: Object.keys(publicParams) }
  };
  // Capture legacy widget/source/theme enrichment exactly once. Subsequent issue,
  // signing, print and portal resolution consume this artifact, not live prices.
  const resolved = await resolveDocumentInstance(ctx.organizationId, renderedDocument, { target: "static" });
  try {
    const updated = await saveDocumentInstance(ctx.organizationId, String(document.id), { ...renderedDocument, module_resolved: jsonClone(resolved) }, { expectedRevision: Number(document.revision) });
    return { document: updated };
  } catch (error) {
    if (input.documentId || !(error instanceof PlatformError) || error.statusCode !== 409) throw error;
    const current = await readDocumentInstance(ctx.organizationId, generatedId);
    if ((current.module_ref as JsonObject)?.execution_id !== instance.lastExecutionId || !current.module_resolved) throw error;
    return { document: current };
  }
}
