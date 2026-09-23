import type { DataResult, PublicationContext } from "../../platform/publication/contracts.js";
import { readPublishedData, authorizeSourceSnapshot } from "../../platform/publication/providers.js";
import { contentHash } from "../../platform/publication/validation.js";
import { badRequest, conflict } from "../../platform/errors.js";
import { readModuleInstance, moduleDefinition, executionModuleInstance, evaluateModuleInstance, type ModuleInstance } from "./service.js";
import { authorizePublication } from "../../platform/publication/context.js";
import { authorizeActionResult } from "../../platform/publication/actions.js";
import type { ActionRef } from "../../platform/publication/contracts.js";

type Evidence = { kind?: string; policy?: string; result?: DataResult; action?: ActionRef };
type DependencyEvidence = { id: string; bindingManifest?: unknown };
const evidenceOf = (instance: DependencyEvidence) => (instance.bindingManifest || {}) as Record<string, Evidence>;
const identity = (result?: DataResult) => !result ? null : result.status === "ready"
  ? contentHash({ value: result.value, source: result.source, schemaVersion: result.schemaVersion })
  : contentHash({ status: result.status, code: result.code });

/** Authorization follows retained dependencies; publishing a derived value cannot
 * launder a revoked source grant. This never reads newer values or writes records. */
export async function authorizeModuleEvidence(ctx: PublicationContext, instance: DependencyEvidence, seen = new Set<string>()) {
  if (seen.has(instance.id) || seen.size >= 64) throw conflict("module_dependency_cycle", "Module dependencies contain a cycle or exceed the graph limit.");
  const next = new Set(seen).add(instance.id);
  for (const entry of Object.values(evidenceOf(instance))) {
    if (entry.kind === "action" && entry.action) {
      await authorizeActionResult(ctx, entry.action);
      continue;
    }
    if (entry.kind !== "data" || entry.result?.status !== "ready") continue;
    const ref = entry.result.source;
    // The module provider checks its retained execution's sources itself. Pass the
    // graph through a server-created context, never through a guest payload.
    await authorizeSourceSnapshot({ ...ctx, dependencyPath: [...next] }, ref, entry.result);
  }
}

async function orderedGraph(ctx: PublicationContext, rootId: string) {
  const visiting = new Set<string>(), done = new Set<string>();
  const ordered: ModuleInstance[] = [];
  async function visit(id: string) {
    if (visiting.has(id)) throw conflict("module_dependency_cycle", "Live module references form a cycle.");
    if (done.has(id)) return;
    if (done.size + visiting.size >= 64) throw badRequest("module_dependency_limit", "At most 64 modules can participate in one refresh.");
    visiting.add(id);
    const instance = await readModuleInstance(ctx, id);
    if (!instance.frozen) for (const binding of Object.values((await executionModuleInstance(ctx, instance)).instance.bindings)) {
      if (binding.kind === "data" && binding.policy === "live" && binding.source.provider === "document-modules" && binding.source.target.id) {
        // Validate the full target before traversing an id, including tenant/project.
        const { authorizeSource } = await import("../../platform/publication/providers.js");
        await authorizeSource(ctx, binding.source);
        await visit(binding.source.target.id);
      }
    }
    visiting.delete(id); done.add(id); ordered.push(instance);
  }
  await visit(rootId);
  return ordered;
}

export async function moduleFreshness(ctx: PublicationContext, instance: ModuleInstance) {
  await authorizeModuleEvidence(ctx, instance);
  if (instance.frozen) return { stale: false, frozen: true, changed: [] as string[] };
  const changed: string[] = [];
  if (!instance.lastExecutionId) changed.push("inputs");
  if (instance.codePolicy === "live" && (await moduleDefinition(ctx, instance.moduleId)).version !== instance.version) changed.push("code");
  for (const [name, binding] of Object.entries(instance.bindings)) {
    if (binding.kind !== "data" || binding.policy !== "live") continue;
    // Conditional code may not consume every declared capability on each run.
    if (instance.lastExecutionId && !evidenceOf(instance)[name]) continue;
    const current = await readPublishedData({ ...ctx, projectId: instance.projectId }, binding.source);
    if (current.status === "denied" || current.status === "error") throw badRequest(`dependency_${current.status}`, current.message, { binding: name, code: current.code });
    if (identity(current) !== identity(evidenceOf(instance)[name]?.result)) changed.push(name);
  }
  return { stale: changed.length > 0, frozen: false, changed };
}

/** A read-only graph probe. GETs and data providers never trigger evaluation. */
export async function inspectModuleGraph(ctx: PublicationContext, instanceId: string) {
  const graph = await orderedGraph(ctx, instanceId);
  const states = [];
  for (const instance of graph) states.push({ id: instance.id, revision: instance.revision, ...await moduleFreshness(ctx, instance) });
  return { stale: states.some(state => state.stale), modules: states };
}

/** Explicit command used by the draft UI and scope trigger. Preflight the graph
 * before writing; refresh upstream first. evaluate mode cannot dispatch effects. */
async function refreshGraph(ctx: PublicationContext, instanceId: string, expectedRevision: number, includeRoot: boolean) {
  const graph = await orderedGraph(ctx, instanceId);
  if (graph.at(-1)!.revision !== expectedRevision) throw conflict("module_revision", "The current revision is required.");
  for (const instance of graph) if (!instance.frozen) await authorizePublication(ctx, { scope: "project", organizationId: ctx.organizationId, projectId: instance.projectId }, {
    scopes: ["project"], permissions: ["manage_projects|manage_company_settings"], capabilities: ["platform.documents"], systemKinds: ["module", "work", "agent"]
  }, "document-modules.manage");
  const refreshed: string[] = [];
  for (const original of includeRoot ? graph : graph.slice(0, -1)) {
    const instance = await readModuleInstance(ctx, original.id);
    const state = await moduleFreshness(ctx, instance);
    if (!state.stale) continue;
    await evaluateModuleInstance(ctx, instance.id, { expectedRevision: instance.revision, mode: "evaluate", dependenciesReady: true });
    refreshed.push(instance.id);
  }
  return { instance: await readModuleInstance(ctx, instanceId), refreshed };
}
export const refreshModuleGraph = (ctx: PublicationContext, instanceId: string, expectedRevision: number) => refreshGraph(ctx, instanceId, expectedRevision, true);
export const refreshModuleDependencies = (ctx: PublicationContext, instanceId: string, expectedRevision: number) => refreshGraph(ctx, instanceId, expectedRevision, false);
