import { badRequest, conflict, notFound } from "../platform/errors.js";
import { readDocument, type JsonObject } from "../platform/storage.js";
import { listNodeRecords, listPlanRecords, readPlanRecord, updatePlanRecord } from "./storage.js";

// An opportunity is a sales work plan (docs/architecture/opportunities.md). Its
// outcome is set only here, by the sales.* actions a scope binds to whatever
// trigger the organization chooses, or by the mark-lost flows. The platform never
// decides on its own that a sale was won.

export type OpportunityOutcome = "open" | "won" | "lost";
const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const TERMINAL = ["completed", "canceled"];

/** Open opportunities on a project, newest first. */
export async function openOpportunities(orgId: string, projectId: string) {
  return (await listPlanRecords(orgId, { project_id: projectId, sales: true }))
    .filter(plan => plan.outcome === "open" && !TERMINAL.includes(text(plan.status)))
    .sort((a, b) => text(b.created_at).localeCompare(text(a.created_at)));
}

/**
 * `plan_id` names the opportunity; without one, `won` and `reopen` act on the
 * project's newest open opportunity and `lost` on every open one. A project with
 * no opportunity can still be won (a production-only flow): its `won_at` is set.
 */
export async function setOpportunityOutcome(orgId: string, input: { project_id?: string; plan_id?: string; outcome: OpportunityOutcome; reason?: string; actor_user_id?: string }) {
  const { emitWorkEvent } = await import("./engine.js");
  const { transitionWorkNode, syncProjectWorkProjection } = await import("./service.js");
  const { updateProjectData } = await import("../platform/project_document_mutation.js");
  const now = new Date().toISOString(), reason = text(input.reason).slice(0, 500);
  let plans: JsonObject[];
  if (text(input.plan_id)) {
    const plan = await readPlanRecord(orgId, text(input.plan_id));
    if (!plan) throw notFound("opportunity_not_found", "That opportunity no longer exists.");
    if (plan.sales !== true) throw badRequest("opportunity_not_sales", "Only a sales scope is an opportunity.");
    plans = [plan];
  } else {
    if (!text(input.project_id)) throw badRequest("opportunity_target", "Name the project or the opportunity.");
    const all = await listPlanRecords(orgId, { project_id: text(input.project_id), sales: true });
    const open = all.filter(plan => plan.outcome === "open" && !TERMINAL.includes(text(plan.status))).sort((a, b) => text(b.created_at).localeCompare(text(a.created_at)));
    plans = input.outcome === "lost" ? open
      : input.outcome === "won" ? open.slice(0, 1)
      : all.filter(plan => plan.outcome === "won").sort((a, b) => text(b.outcome_at).localeCompare(text(a.outcome_at))).slice(0, 1);
  }
  const projectId = text(input.project_id || plans[0]?.project_id);
  // A project with no open opportunity can still be marked won or lost (a production-only flow, or a lead
  // that never got a sales scope): the outcome is recorded on the project.
  if (!plans.length && input.outcome !== "open" && projectId) {
    await readDocument(orgId, "projects", projectId);
    const field = input.outcome === "won" ? "won_at" : "lost_at";
    await updateProjectData(orgId, projectId, data => object(data)[field] ? data : { ...object(data), [field]: now, ...(input.outcome === "lost" ? { lost_reason: reason } : {}) });
    await emitWorkEvent({ organization_id: orgId, project_id: projectId, type: `opportunity.${input.outcome}`, idempotency_key: `opportunity.${input.outcome}:${projectId}:project`, payload: { project_id: projectId, plan_id: "", reason } });
    await syncProjectWorkProjection(orgId, projectId);
    return { project_id: projectId, plans: [] };
  }
  const changed: JsonObject[] = [];
  for (const plan of plans) {
    const planId = text(plan.id);
    if (plan.outcome === input.outcome) continue;
    if (input.outcome === "open" && plan.outcome === "lost") throw conflict("opportunity_closed", "A lost opportunity's scope was stopped; start the sales scope again instead.");
    if (input.outcome === "lost") {
      // A lost opportunity stops: its open work is canceled with the reason.
      for (const node of (await listNodeRecords(orgId, { plan_id: planId })).filter(node => !["completed", "skipped", "canceled"].includes(text(node.status)))) {
        await transitionWorkNode(orgId, text(node.id), "canceled", { reason: reason || "lost" });
      }
    }
    const next = await updatePlanRecord(orgId, planId, {
      outcome: input.outcome, outcome_at: input.outcome === "open" ? "" : now, outcome_reason: input.outcome === "open" ? "" : reason,
      ...(input.outcome === "lost" && !TERMINAL.includes(text(plan.status)) ? { status: "canceled", canceled_at: now, metadata: { ...object(plan.metadata), canceled_reason: "lost" } } : {})
    });
    changed.push(next || plan);
    const type = input.outcome === "open" ? "opportunity.reopened" : `opportunity.${input.outcome}`;
    await emitWorkEvent({ organization_id: orgId, branch_id: text(plan.branch_id) || "default", project_id: text(plan.project_id), plan_id: planId, type, idempotency_key: `${type}:${planId}:${now}`, payload: { project_id: text(plan.project_id), plan_id: planId, reason }, context: input.actor_user_id ? { actor_user_id: input.actor_user_id } : {} });
  }
  for (const id of new Set(changed.map(plan => text(plan.project_id)).filter(Boolean))) await syncProjectWorkProjection(orgId, id);
  return { project_id: projectId, plans: changed };
}

/** Lifecycle facts read from opportunities. Exported for the projection. */
export function opportunitySummary(plans: JsonObject[], project: JsonObject = {}) {
  const sales = plans.filter(plan => plan.sales === true);
  const won = sales.filter(plan => plan.outcome === "won");
  const wonAt = [...won.map(plan => text(plan.outcome_at)), text(project.won_at)].filter(Boolean).sort()[0] || "";
  return {
    open: sales.filter(plan => plan.outcome === "open" && !TERMINAL.includes(text(plan.status))).length,
    won: won.length,
    lost: sales.filter(plan => plan.outcome === "lost").length,
    // A sales scope that finished or was stopped without anyone saying won or lost.
    unresolved: sales.filter(plan => plan.outcome === "open" && TERMINAL.includes(text(plan.status)) && plan.outcome_reason !== "merged").length,
    won_at: wonAt,
    lost_at: !wonAt && !sales.some(plan => plan.outcome === "open" && !TERMINAL.includes(text(plan.status))) ? text(project.lost_at) : ""
  };
}
