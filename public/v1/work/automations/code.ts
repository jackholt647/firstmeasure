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

const engine = "quickjs-emscripten@0.32.0";
const programSchema = z.object({
  id: z.string().min(1).max(80), source: z.string().min(1).max(128000),
  policy: z.enum(["live", "frozen"]).default("frozen"),
  mode: z.enum(["evaluate", "command"]).default("evaluate"),
  inputs: z.record(z.unknown()).default({}), inputSchema: z.record(z.unknown()), outputSchema: z.record(z.unknown()),
  bindings: z.record(moduleBindingSchema).default({})
}).strict();

/** The scope definition is already an administrator-authored, versioned work plan.
 * Guest code receives only declared bindings and explicit inputs, never host context. */
export async function executeScopeCode(context: WorkAutomationContext, raw: JsonObject) {
  initializePublication();
  const requested = programSchema.parse(jsonClone(raw));
  assertSafeTenantSchema(requested.inputSchema); assertSafeTenantSchema(requested.outputSchema);
  const consumer = `scope:${String(context.plan.id)}:${String(context.node.id)}:${requested.id}`;
  const artifact = await withWorkPublicationContext(context, ["scope.code.run.v1"], ctx => resolveCodeBinding(ctx, consumer, "code", {
    kind: "code", policy: requested.policy, moduleId: consumer
  }, async () => ({ id: consumer, version: contentHash(requested), source: requested.source, engine,
    digest: contentHash({ source: requested.source, engine }),
    contract: { inputSchema: requested.inputSchema, outputSchema: requested.outputSchema, bindings: requested.bindings, mode: requested.mode }
  })));
  if (artifact.engine !== engine) throw conflict("scope_code_engine_unavailable", "The pinned execution engine is unavailable.");
  const contract = artifact.contract!;
  const bindings = z.record(moduleBindingSchema).parse(contract.bindings);
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
      return previous.data.outputs;
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
  });
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
    access: { scopes: ["project"], permissions: ["view_projects"], systemKinds: ["work", "module", "agent"], authorize: async (ctx, target) => {
      const row = target.id && await readDocument(ctx.organizationId, "publication_executions", target.id);
      if (!row || row.data.projectId !== target.projectId) throw forbidden("scope_output_denied", "This execution does not belong to the selected project.");
    } },
    read: async (ctx, ref) => {
      const row = await readDocument(ctx.organizationId, "publication_executions", ref.target.id!);
      if (row.data.status !== "complete") return { status: "pending", code: "scope_output_pending", message: "Scope execution has not completed." };
      return { value: row.data.outputs, revision: String(row.revision), provenance: { executionId: row.id, consumer: row.data.consumer } };
    }
  }, latest: {
    description: "Latest completed result for an explicitly named scope program in this project.", schema: { type: "object" }, schemaVersion: "1",
    argsSchema: { type: "object", required: ["planId", "nodeId", "programId"], additionalProperties: false, properties: { planId: { type: "string", minLength: 1 }, nodeId: { type: "string", minLength: 1 }, programId: { type: "string", minLength: 1 } } },
    access: { scopes: ["project"], permissions: ["view_projects"], systemKinds: ["work", "module", "agent"], authorize: async (ctx, target) => { await readDocument(ctx.organizationId, "projects", target.projectId!); } },
    read: async (ctx, ref) => {
      const consumer = `scope:${ref.args!.planId}:${ref.args!.nodeId}:${ref.args!.programId}`;
      const rows = (await listDocuments(ctx.organizationId, "publication_executions")).filter(row => row.data.projectId === ref.target.projectId && row.data.consumer === consumer && row.data.status === "complete");
      rows.sort((a, b) => String(b.data.completedAt).localeCompare(String(a.data.completedAt)) || b.id.localeCompare(a.id));
      const row = rows[0];
      if (!row) return { status: "pending", code: "scope_output_pending", message: "This scope program has not produced a result." };
      return { value: row.data.outputs, revision: `${row.id}:${row.revision}`, provenance: { executionId: row.id, consumer } };
    }
  } } });
}
