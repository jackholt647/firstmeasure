import { randomBytes } from "node:crypto";
import { z } from "zod";
import { badRequest } from "../platform/errors.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { readDocument, type JsonObject } from "../platform/storage.js";
import { readWorkConfiguration } from "../work/config.js";
import { emitWorkEvent } from "../work/engine.js";
import { crmViewStore } from "./views.js";

// Recording what happened on a touch (docs/architecture/crm.md, "Worklists"). A result
// on a call-list row or a follow-up runs the existing disposition path (retry ladder,
// next follow-up); on any other row a follow-up is created when the outcome asks for
// one. Every result is logged and emitted as crm.disposition.recorded, so organization
// rules decide what else follows.

const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

export const resultSchema = z.object({
  project_id: z.string().trim().max(200).default(""),
  contact_id: z.string().trim().max(200).default(""),
  entry_id: z.string().trim().max(200).default(""),
  node_id: z.string().trim().max(200).default(""),
  /** What happened on the touch itself. */
  disposition: z.enum(["answered", "voicemail", "no_answer", "texted", "emailed", "met", "other"]).default("answered"),
  /** A follow-up outcome from the work configuration (follow up again, appointment set, lost, or the organization's own). */
  outcome_id: z.string().trim().min(1).max(120),
  note: z.string().trim().max(4000).default(""),
  follow_up_at: z.string().trim().max(40).default(""),
  channel: z.enum(["call", "text", "email", "visit", "other"]).default("call")
}).strict();
export type ResultInput = z.infer<typeof resultSchema>;

/** The outcomes a result can choose from, with what each does. */
export async function resultOutcomes(orgId: string, branchId = "default") {
  const config = await readWorkConfiguration(orgId, branchId);
  return (Array.isArray(object(config.follow_ups).outcomes) ? object(config.follow_ups).outcomes as JsonObject[] : []).map(o => ({
    id: text(o.id), label: text(o.label) || text(o.id), action: text(o.action) || "reschedule", color: text(o.color)
  }));
}

export async function recordResult(ctx: PlatformAuthContext, value: unknown) {
  const input = resultSchema.parse(value);
  if (!input.project_id && !input.entry_id && !input.node_id && !input.contact_id) throw badRequest("crm_result_target", "Name the project, contact or to-do the result is for.");
  const project = input.project_id ? await readDocument(ctx.orgId, "projects", input.project_id) : null;
  const branchId = text(object(project?.data).branch_id) || ctx.branchId || "default";
  const outcomes = await resultOutcomes(ctx.orgId, branchId);
  const outcome = outcomes.find(o => o.id === input.outcome_id || o.action === input.outcome_id);
  if (!outcome) throw badRequest("crm_result_outcome", "Choose one of the configured results.");
  const retryTrigger = ["voicemail", "no_answer"].includes(input.disposition) ? input.disposition : "manual_follow_up";
  const actor = { actor_user_id: ctx.userId, actor_email: text(ctx.identity?.email || ctx.user?.email) };
  let path = "logged", detail: JsonObject = {};

  if (input.entry_id) {
    // A call-list row: the call list's own disposition path.
    const { recordCallListDisposition } = await import("../comms/call-lists.js");
    const callDisposition = ["voicemail", "no_answer"].includes(input.disposition) ? input.disposition : "answered";
    detail = object(await recordCallListDisposition(ctx.orgId, input.entry_id, { disposition: callDisposition, outcome_id: outcome.id, note_text: input.note, followup_at: input.follow_up_at, ...actor }));
    path = "call_list";
  } else if (input.node_id) {
    // A follow-up to-do: resolve it with the outcome (reschedule on the retry ladder, require an appointment, or lose).
    const { resolveFollowUpOutcome } = await import("../work/followups.js");
    detail = object(await resolveFollowUpOutcome(ctx.orgId, input.node_id, { outcome_id: outcome.id, due_at: input.follow_up_at, use_policy: !input.follow_up_at, policy_trigger: retryTrigger, ...actor }));
    path = "follow_up";
  } else if (input.project_id) {
    if (outcome.action === "reschedule") {
      const { createFollowUpTodo, nextFollowUpPolicySchedule } = await import("../work/followups.js");
      const config = await readWorkConfiguration(ctx.orgId, branchId);
      const policy = nextFollowUpPolicySchedule(object(config.follow_ups), null, retryTrigger);
      const dueAt = input.follow_up_at || text(policy?.due_at);
      if (!dueAt) throw badRequest("crm_result_follow_up_at", "Choose when to try again.");
      detail = object(await createFollowUpTodo(ctx.orgId, {
        branch_id: branchId, project_id: input.project_id, due_at: dueAt, origin: "crm_result",
        assigned_user_ids: [ctx.userId], channel: input.channel === "text" ? "text" : "call",
        metadata: { follow_up: { channel: input.channel, contact_id: input.contact_id, ...(policy && !input.follow_up_at ? policy : {}), origin: "crm_result" } }
      }));
      path = "follow_up_created";
    } else if (outcome.action === "lost") {
      const { setOpportunityOutcome } = await import("../work/opportunities.js");
      detail = object(await setOpportunityOutcome(ctx.orgId, { project_id: input.project_id, outcome: "lost", reason: outcome.label || outcome.id, actor_user_id: ctx.userId }));
      path = "lost";
    }
  }

  const id = `result_${randomBytes(8).toString("hex")}`, createdAt = new Date().toISOString();
  // The note joins the project's channel as a call note, as the call list's own path does.
  if (input.note && input.project_id && project && path !== "call_list") {
    const { ensureProjectChannelRecord } = await import("../channels/service.js");
    const { createMessageRecord } = await import("../channels/storage.js");
    const data = object(project.data);
    const channel = await ensureProjectChannelRecord(ctx.orgId, project.id, text(data.title || data.address));
    await createMessageRecord({ organization_id: ctx.orgId, channel_id: channel.id, author_id: ctx.userId || "system", text: input.note,
      tags: ["call_note"], client_msg_id: `crm_result:${id}`, metadata: { call: { id, disposition: input.disposition, outcome: outcome.id, channel: input.channel, created_at: createdAt } } });
  }
  await crmViewStore().prepare(`INSERT INTO crm_results(organization_id,id,project_id,contact_id,outcome_id,action,channel,note,follow_up_at,source_row,actor_user_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(ctx.orgId, id, input.project_id, input.contact_id, outcome.id, outcome.action, input.channel, input.note, input.follow_up_at, input.entry_id ? `entry:${input.entry_id}` : input.node_id ? `node:${input.node_id}` : "", ctx.userId, createdAt);
  await emitWorkEvent({
    organization_id: ctx.orgId, branch_id: branchId, project_id: input.project_id || undefined,
    type: "crm.disposition.recorded", idempotency_key: `crm.disposition.recorded:${id}`,
    payload: { result_id: id, project_id: input.project_id, contact_id: input.contact_id, disposition: input.disposition, outcome_id: outcome.id, action: outcome.action, channel: input.channel, note: input.note, follow_up_at: input.follow_up_at },
    context: actor
  });
  return { id, outcome, path, created_at: createdAt, detail };
}

/** The latest result per project, for "last touch" on the collections. */
export async function lastResults(orgId: string) {
  const rows = await crmViewStore().prepare("SELECT project_id, MAX(created_at) AS at FROM crm_results WHERE organization_id=? AND project_id<>'' GROUP BY project_id").all(orgId);
  return new Map(rows.map(r => [text(r.project_id), text(r.at)]));
}

/** Results on one project, newest first, for the lead drawer's timeline. */
export async function projectResults(orgId: string, projectId: string) {
  return (await crmViewStore().prepare("SELECT * FROM crm_results WHERE organization_id=? AND project_id=? ORDER BY created_at DESC LIMIT 200").all(orgId, projectId)).map(r => ({
    id: text(r.id), outcome_id: text(r.outcome_id), action: text(r.action), channel: text(r.channel), note: text(r.note), follow_up_at: text(r.follow_up_at), actor_user_id: text(r.actor_user_id), created_at: text(r.created_at)
  }));
}
