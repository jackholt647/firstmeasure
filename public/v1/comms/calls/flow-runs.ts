import type { PlatformAuthContext } from "../../platform/auth.js";
import { badRequest, conflict, forbidden, notFound } from "../../platform/errors.js";
import { callResultForOutcome, type FlowDefinition } from "../../flows/contracts.js";
import * as store from "./storage.js";
import { text, object } from "./storage.js";

/**
 * The call surface of flows (docs/architecture/flows.md, docs/architecture/global-phone-tray.md): a call's script is a
 * run of a `call` flow. The call keeps the run's id (`metadata.flow_run_id`, `metadata.flow`) so the call detail,
 * observers and supervisors see it; the run keeps the call's id (`flow_runs.call_id`) so its outcome lands on the call
 * (`result.flow_outcome`), which pre-fills the wrap-up. The outcome's effects run in the work engine like any flow's.
 */
type RunRef = { id: string; flow_id: string; flow_version: number; name: string };

async function service() { return import("./service.js"); }

/** Only someone who may change the call (its owner or a communications manager) plays a script on it, and only before its outcome is saved. */
export async function authorizeCallRun(ctx: PlatformAuthContext, callId: string) {
  const { requireCallAccess } = await service();
  const call = requireCallAccess(ctx, await store.readCall(ctx.orgId, callId), true);
  if (call.mode === "diagnostic") throw badRequest("call_script_unavailable", "Device checks have no script.");
  if (call.wrap_up_state === "saved") throw conflict("call_already_saved", "This call's outcome is already saved.");
  return call;
}

/** Whoever has the call now plays its run, even when someone else started it (a transfer, a takeover). */
export async function ownsCallRun(ctx: PlatformAuthContext, run: { id: string; call_id: string }) {
  const call = await store.readCall(ctx.orgId, run.call_id).catch(() => null);
  return !!call && call.owner_user_id === ctx.userId && text(call.metadata.flow_run_id) === run.id;
}

export async function linkCallRun(orgId: string, callId: string, run: RunRef) {
  const call = await store.readCall(orgId, callId);
  const updated = await store.patchCall(orgId, callId, { metadata: { ...call.metadata, flow_run_id: run.id, flow: { id: run.flow_id, version: run.flow_version, name: run.name } } });
  await store.appendEvent(orgId, callId, "communication.call.flow_started", { run_id: run.id, flow_id: run.flow_id }, `${callId}:flow:${run.id}`);
  return updated;
}

/** A finished run's outcome becomes the call's result: kept on `result.flow_outcome` and carried into the saved wrap-up. */
export async function callRunFinished(orgId: string, run: { id: string; flow_id: string; call_id: string; outcome_id: string }, definition: FlowDefinition) {
  const call = await store.readCall(orgId, run.call_id).catch(() => null);
  if (!call || text(call.metadata.flow_run_id) !== run.id) return;
  const outcome = definition.outcomes.find((entry) => entry.id === run.outcome_id);
  const mapped = outcome ? callResultForOutcome(outcome) : { disposition: "", next_action: "none" };
  const flowOutcome = { run_id: run.id, flow_id: run.flow_id, outcome_id: outcome?.id || "", label: outcome?.label || "", color: outcome?.color || "", ...mapped };
  await store.patchCall(orgId, call.id, { result: { ...call.result, flow_outcome: flowOutcome } });
  await store.appendEvent(orgId, call.id, "communication.call.flow_finished", { run_id: run.id, outcome_id: flowOutcome.outcome_id }, `${call.id}:flow-finished:${run.id}`);
}

/** A run played for a call list entry with no call (the CRM worklist) completes the entry with the run's outcome. */
export async function entryRunFinished(orgId: string, run: { id: string; flow_id: string; outcome_id: string; source: Record<string, unknown> }) {
  const entryId = text(object(run.source).entry_id);
  if (!entryId) return;
  const { ensureCallListDatabase, getCallListDatabase } = await import("../call-lists.js");
  await ensureCallListDatabase();
  const at = store.now();
  await getCallListDatabase().prepare("UPDATE crm_call_list_entries SET status='completed',result_json=?,updated_at=?,completed_at=? WHERE organization_id=? AND id=? AND status='pending'")
    .run(JSON.stringify({ flow_run_id: run.id, flow_id: run.flow_id, outcome_id: run.outcome_id }), at, at, orgId, entryId);
}

/**
 * Plays a flow on a call: starts a run of `flow_id`, or carries on an open run (`run_id`, a new-lead run waiting on this
 * lead) on this call. Returns the call with its run linked.
 */
export async function playFlowOnCall(ctx: PlatformAuthContext, callId: string, input: { flow_id?: string; run_id?: string }) {
  const call = await authorizeCallRun(ctx, callId);
  const flows = await import("../../flows/service.js");
  const runId = text(input.run_id), flowId = text(input.flow_id);
  if (runId) {
    if (runId === text(call.metadata.flow_run_id)) return call;
    const { readRun, readVersion, attachRunToCall } = await import("../../flows/storage.js");
    const run = await readRun(ctx.orgId, runId);
    if (!run || run.status !== "open") throw notFound("flow_run_not_found", "This run is finished or unavailable.");
    if (!(run.project_id && run.project_id === call.project_id) && !(run.contact_id && run.contact_id === call.contact_id)) throw badRequest("flow_run_mismatch", "This run is for another lead.");
    // A run waiting on the lead (started by a rule or for a call list entry) is anyone's to carry on; a person's own run is theirs.
    const waiting = ["automation", "call_list_entry"].includes(text(object(run.source).kind));
    if (!waiting && run.started_by !== ctx.userId && !flows.canEditFlows(ctx)) throw forbidden("flow_run_denied", "This run belongs to someone else.");
    const version = await readVersion(ctx.orgId, run.flow_id, run.flow_version);
    if (!(await attachRunToCall(ctx.orgId, runId, call.id))) throw conflict("flow_run_moved", "This run just finished. Reload it.");
    return linkCallRun(ctx.orgId, call.id, { id: run.id, flow_id: run.flow_id, flow_version: run.flow_version, name: text(version?.name) });
  }
  if (!flowId) throw badRequest("flow_required", "Choose a script.");
  await flows.startRun(ctx, { flow_id: flowId, source: { kind: "call", call_id: call.id, ...(call.project_id ? { project_id: call.project_id } : {}), ...(call.contact_id ? { contact_id: call.contact_id } : {}),
    ...(call.entry_id ? { entry_id: call.entry_id } : {}) } });
  return store.readCall(ctx.orgId, call.id);
}

/** What the call detail shows of its script for everyone who may see the call, observers included (read-only). */
export async function callFlowSummary(orgId: string, metadata: Record<string, unknown>) {
  const runId = text(object(metadata).flow_run_id);
  if (!runId) return null;
  const { runSummary } = await import("../../flows/service.js");
  return runSummary(orgId, runId).catch(() => null);
}
