import { z } from "zod";
import { registerWorkAutomation, type WorkAutomationContext } from "../registry.js";
import { moduleBindingSchema } from "../../documents/modules/schemas.js";
import { runModuleCode } from "../../documents/modules/runtime.js";
import { initializePublication } from "../../platform/publication/bootstrap.js";
import { withWorkPublicationContext } from "../../platform/publication/work-actions.js";
import { createBindingSession, resolveCodeBinding } from "../../platform/publication/bindings.js";
import { registerDataProvider } from "../../platform/publication/providers.js";
import { contentHash, jsonClone, validateJson } from "../../platform/publication/validation.js";
import { assertSafeTenantSchema } from "../../platform/publication/tenant-schema.js";
import { listDocuments, readDocument, upsertDocument, type JsonObject } from "../../platform/storage.js";
import { conflict, forbidden, badRequest, PlatformError } from "../../platform/errors.js";
import { backgroundAuthContext } from "../../platform/auth.js";
import { instantiateBindings } from "../../platform/publication/instantiate.js";
import { authorizeModuleEvidence, refreshModuleGraph } from "../../documents/modules/dependencies.js";
import type { PublicationContext, DataResult } from "../../platform/publication/contracts.js";
import { Ajv } from "ajv";

const engine = "quickjs-emscripten@0.32.0";
const programSchema = z.object({
  id: z.string().min(1).max(80), source: z.string().min(1).max(128000),
  policy: z.enum(["live", "frozen"]).default("frozen"),
  mode: z.enum(["evaluate", "command"]).default("evaluate"),
  inputs: z.record(z.unknown()).default({}), inputSchema: z.record(z.unknown()), outputSchema: z.record(z.unknown()),
  bindings: z.record(moduleBindingSchema).default({})
}).strict();

export function validateScopeProgram(raw: unknown) {
  const program = programSchema.parse(jsonClone(raw));
  for (const schema of [program.inputSchema, program.outputSchema]) {
    assertSafeTenantSchema(schema);
    try { new Ajv({ strict: false }).compile(schema); } catch { throw badRequest("scope_code_schema", "Invalid scope program schema."); }
  }
  validateJson(program.inputSchema, program.inputs, "scope program inputs");
  return program;
}
async function authorizeScopeResult(ctx: PublicationContext, row: { id: string; data: JsonObject }) {
  await authorizeModuleEvidence(ctx, { id: `scope-output:${row.id}`, bindingManifest: row.data.manifest }, new Set(ctx.dependencyPath));
}
async function authorizeScopeSnapshot(ctx: PublicationContext, _ref: unknown, result: Extract<DataResult, {status:"ready"}>) {
  const executionId = result.provenance.executionId;
  if (typeof executionId !== "string") throw badRequest("scope_output_evidence", "Scope result lacks execution evidence.");
  const row = await readDocument(ctx.organizationId, "publication_executions", executionId);
  if (row.data.projectId !== result.source.target.projectId || row.data.status !== "complete") throw forbidden("scope_output_denied", "This execution does not belong to the selected project.");
  await authorizeScopeResult(ctx, row);
}

/** The scope definition is already an administrator-authored, versioned work plan.
 * Guest code receives only declared bindings and explicit inputs, never host context. */
export async function executeScopeCode(context: WorkAutomationContext, raw: JsonObject) {
  initializePublication();
  const requested = validateScopeProgram(raw);
  // Resolve authority from the immutable template version, not guest inputs.
  let principal;
  if (context.plan.template_id && context.plan.template_version) {
    const { readScopeTemplateVersion } = await import("../../scopes/storage.js");
    const template = await readScopeTemplateVersion(String(context.event.organization_id), String(context.plan.branch_id || context.event.branch_id || "default"), String(context.plan.template_id), Number(context.plan.template_version));
    const metadata = ((template?.definition as JsonObject)?.metadata || {}) as JsonObject;
    const authoredPrograms: unknown[] = [];
    const collect = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const record = value as JsonObject;
      if (record.automation === "scope.code.run.v1") authoredPrograms.push(record.input);
      for (const child of Object.values(record)) if (typeof child === "object") collect(child);
    };
    collect(template?.definition);
    if (!authoredPrograms.some(program => contentHash(validateScopeProgram(program)) === contentHash(requested))) throw forbidden("scope_program_not_authored", "This program does not match its authorized scope version.");
    if (metadata.publication_author_id) principal = await backgroundAuthContext(String(context.event.organization_id), String(metadata.publication_author_id));
    if (!principal) throw forbidden("scope_author_required", "Republish this scope with an authorized author before executing custom code.");
  }
  assertSafeTenantSchema(requested.inputSchema); assertSafeTenantSchema(requested.outputSchema);
  const consumer = `scope:${String(context.plan.id)}:${String(context.node.id)}:${requested.id}`;
  const artifact = await withWorkPublicationContext(context, ["scope.code.run.v1"], ctx => resolveCodeBinding(ctx, consumer, "code", {
    kind: "code", policy: requested.policy, moduleId: consumer
  }, async () => ({ id: consumer, version: contentHash(requested), source: requested.source, engine,
    digest: contentHash({ source: requested.source, engine }),
    contract: { inputSchema: requested.inputSchema, outputSchema: requested.outputSchema, bindings: requested.bindings, mode: requested.mode }
  })), principal);
  if (artifact.engine !== engine) throw conflict("scope_code_engine_unavailable", "The pinned execution engine is unavailable.");
  const contract = artifact.contract!;
  const bindings = instantiateBindings(z.record(moduleBindingSchema).parse(contract.bindings), { organizationId: String(context.event.organization_id), projectId: String(context.project.id || context.plan.project_id || ""), branchId: String(context.plan.branch_id || context.event.branch_id || "default") });
  const mode = z.enum(["evaluate", "command"]).parse(contract.mode);
  validateJson(contract.inputSchema as Record<string, unknown>, requested.inputs, "scope code input");
  const operations = [...new Set(Object.values(bindings).map(binding => binding.kind === "data" ? `${binding.source.provider}.${binding.source.export}` : binding.action.action))];
  if (operations.includes("scope.code.run.v1")) throw badRequest("scope_code_recursion", "Scope code cannot recursively execute scope code.");
  return withWorkPublicationContext(context, operations.length ? operations : ["scope.code.run.v1"], async ctx => {
    ctx.mode = mode;
    const executionId = `scope_exec_${contentHash({ consumer, invocation: context.idempotencyKey })}`;
    const requestHash = contentHash({ artifact, inputs: requested.inputs });
    const previous = await readDocument(ctx.organizationId, "publication_executions", executionId).catch(error => {
      if (error instanceof PlatformError && error.statusCode === 404) return null;
      throw error;
    });
    if (previous) {
      if (previous.data.requestHash !== requestHash) throw conflict("scope_code_input_changed", "This execution identity was used with different inputs or code.");
      if (previous.data.status !== "complete") throw conflict("scope_code_outcome_uncertain", "This execution started already and requires reconciliation.");
      await authorizeScopeResult(ctx, previous);
      return previous.data.outputs;
    }
    // A configured trigger is an explicit execution boundary. Refresh upstream
    // calculations here; ordinary provider reads remain entirely read-only.
    for (const binding of Object.values(bindings)) if (binding.kind === "data" && binding.policy === "live" && binding.source.provider === "document-modules") {
      const { authorizeSource } = await import("../../platform/publication/providers.js");
      const { readModuleInstance } = await import("../../documents/modules/service.js");
      await authorizeSource(ctx, binding.source);
      const instance = await readModuleInstance(ctx, binding.source.target.id || "");
      await refreshModuleGraph(ctx, instance.id, instance.revision);
    }
    const started = await upsertDocument(ctx.organizationId, "publication_executions", { id: executionId, data: {
      projectId: ctx.projectId, consumer, requestHash, status: "running", code: artifact, createdAt: new Date().toISOString()
    } }, { createOnly: true });
    const session = createBindingSession(ctx, consumer, bindings);
    try {
      const result = await runModuleCode({ source: artifact.source, inputs: requested.inputs, mode, now: context.now }, {
        read: name => session.read(name), invoke: (name, input) => session.invoke(name, input)
      });
      if (!result.outputs || typeof result.outputs !== "object" || Array.isArray(result.outputs)) {
        throw badRequest("scope_code_output_invalid", "Scope code must publish an object of named outputs.");
      }
      validateJson(contract.outputSchema as Record<string, unknown>, result.outputs, "scope code output");
      await upsertDocument(ctx.organizationId, "publication_executions", { id: executionId, expected_revision: started.revision, data: {
        ...started.data, status: "complete", outputs: result.outputs, outputSchema: contract.outputSchema,
        manifest: session.manifest(), completedAt: new Date().toISOString()
      } }, { replace: true });
      return result.outputs;
    } catch (error) {
      await upsertDocument(ctx.organizationId, "publication_executions", { id: executionId, expected_revision: started.revision, data: {
        ...started.data, status: "uncertain", manifest: session.manifest()
      } }, { replace: true }).catch(() => undefined);
      throw error;
    }
  }, principal);
}

let registered = false;
export function registerScopeCodeAutomation() {
  if (registered) return;
  registered = true;
  registerWorkAutomation("scope.code.run.v1", executeScopeCode, {
    description: "Run version-bound scope JavaScript with declared data and action bindings in the shared sandbox.",
    inputSchema: { type: "object", required: ["id", "source", "inputSchema", "outputSchema"], additionalProperties: false,
      properties: { id: { type: "string" }, source: { type: "string" }, policy: { enum: ["live", "frozen"] }, mode: { enum: ["evaluate", "command"] }, inputs: { type: "object" }, inputSchema: { type: "object" }, outputSchema: { type: "object" }, bindings: { type: "object" } } }
  });
  registerDataProvider({ id: "scope-code", version: "1", apps: ["settings", "checklists"], exports: { outputs: {
    description: "Validated results of a completed scope program; excludes source code and private execution state.", schema: { type: "object" }, schemaVersion: "1",
    authorizeSnapshot: authorizeScopeSnapshot,
    access: { scopes: ["project"], permissions: ["view_projects"], systemKinds: ["work", "module", "agent"], authorize: async (ctx, target) => {
      const row = target.id && await readDocument(ctx.organizationId, "publication_executions", target.id);
      if (!row || row.data.projectId !== target.projectId) throw forbidden("scope_output_denied", "This execution does not belong to the selected project.");
    } },
    read: async (ctx, ref) => {
      const row = await readDocument(ctx.organizationId, "publication_executions", ref.target.id!);
      if (row.data.status !== "complete") return { status: "pending", code: "scope_output_pending", message: "Scope execution has not completed." };
      await authorizeScopeResult(ctx, row);
      return { value: row.data.outputs, revision: String(row.revision), provenance: { executionId: row.id, consumer: row.data.consumer } };
    }
  }, latest: {
    description: "Latest completed result for an explicitly named scope program in this project.", schema: { type: "object" }, schemaVersion: "1",
    authorizeSnapshot: authorizeScopeSnapshot,
    argsSchema: { type: "object", required: ["planId", "nodeId", "programId"], additionalProperties: false, properties: { planId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, programId: { type: "string", minLength: 1 } } },
    access: { scopes: ["project"], permissions: ["view_projects"], systemKinds: ["work", "module", "agent"], authorize: async (ctx, target) => { await readDocument(ctx.organizationId, "projects", target.projectId!); } },
    read: async (ctx, ref) => {
      const consumer = `scope:${ref.args!.planId}:${ref.args!.nodeId}:${ref.args!.programId}`;
      const rows = (await listDocuments(ctx.organizationId, "publication_executions")).filter(row => row.data.projectId === ref.target.projectId && row.data.consumer === consumer && row.data.status === "complete");
      rows.sort((a, b) => String(b.data.completedAt).localeCompare(String(a.data.completedAt)) || b.id.localeCompare(a.id));
      const row = rows[0];
      if (!row) return { status: "pending", code: "scope_output_pending", message: "This scope program has not produced a result." };
      await authorizeScopeResult(ctx, row);
      return { value: row.data.outputs, revision: `${row.id}:${row.revision}`, provenance: { executionId: row.id, consumer } };
    }
  } } });
}
