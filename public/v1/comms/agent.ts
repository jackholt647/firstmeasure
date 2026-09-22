// Comms auto-responses, running on the centralized agent framework. The
// comms agent itself is declared in definition.ts; interactive threads go
// through agents/runtime runAgentTurn (see api.ts). This module keeps the
// inbound-triggered auto-response orchestration: threadless runAgentOnce with
// the propose_reply tool, then draft-or-send under this function's control.

import { env } from "../src/config/env.js";
import { runAgentOnce } from "../agents/runtime.js";
import type { AgentTool } from "../agents/types.js";
import { asObject, cleanText, errorMessage, type JsonObject } from "../agents/util.js";
import { readMessageRecord } from "../messaging/communications_storage.js";
import { publishWorkCommunicationEvent } from "../messaging/communications_service.js";
import {
  countAutoRepliesSince,
  createAutoReplyRecord,
  updateAutoReplyRecord
} from "./storage.js";
import { sendProjectEmail, sendProjectSms } from "./service.js";
import { resolveProjectCommsSettings } from "./settings.js";
import { COMMS_AGENT_ID } from "./definition.js";

const MAX_AUTO_ROUNDS = 8;

const PROPOSE_REPLY_TOOL: AgentTool = {
  name: "propose_reply",
  description: "REQUIRED in auto-response runs: propose the reply to the customer's inbound message. In draft mode it is saved for team review; in send mode it is sent immediately.",
  parameters: {
    type: "object",
    properties: {
      channel: { type: "string", enum: ["email", "sms"] },
      subject: { type: "string", description: "Email only; keep the thread's subject when replying." },
      text: { type: "string" }
    },
    required: ["channel", "text"],
    additionalProperties: false
  },
  execute(run, args) {
    const channel = cleanText(args.channel) === "sms" ? "sms" : "email";
    run.scratch.proposedReply = { channel, subject: cleanText(args.subject), text: String(args.text ?? "") };
    return { ok: true, recorded: true, mode: cleanText(run.input.auto_mode) };
  }
};

const pendingAutoResponses = new Set<string>();

/** Fire-and-forget: never blocks or fails the inbound webhook path. */
export function scheduleAutoResponse(orgId: string, branchId: string, projectId: string, inboundMessageId: string, mode: "draft" | "send") {
  const key = `${orgId}:${inboundMessageId}`;
  if (pendingAutoResponses.has(key)) return;
  pendingAutoResponses.add(key);
  void runAutoResponse(orgId, branchId, projectId, inboundMessageId, mode)
    .catch((error) => console.error("comms auto-response failed", error))
    .finally(() => pendingAutoResponses.delete(key));
}

export async function runAutoResponse(orgId: string, branchId: string, projectId: string, inboundMessageId: string, mode: "draft" | "send") {
  if (!env.openaiApiKey) return null;
  const since = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
  if ((await countAutoRepliesSince(orgId, since)) >= env.commsAutoReplyOrganizationDailyLimit) return null;

  const inbound = (await readMessageRecord(orgId, inboundMessageId));
  const channel = cleanText(inbound.channel) === "sms" ? "sms" : "email";
  const record = (await createAutoReplyRecord({
    organization_id: orgId,
    branch_id: branchId,
    project_id: projectId,
    conversation_id: cleanText(inbound.conversation_id),
    inbound_message_id: inboundMessageId,
    channel,
    status: "working"
  }));
  if (!record) return null; // Already handled (duplicate webhook delivery).

  const resolved = await resolveProjectCommsSettings(orgId, branchId, projectId);
  if (!resolved.agent.enabled) {
    (await updateAutoReplyRecord(orgId, cleanText(record.id), { status: "failed", error: "The comms agent is turned off.", content: {} }));
    return null;
  }
  const outcome = await runAgentOnce(COMMS_AGENT_ID, {
    orgId,
    branchId,
    subjectId: projectId,
    ctx: null,
    input: { auto_mode: mode },
    extraTools: [PROPOSE_REPLY_TOOL],
    maxRounds: MAX_AUTO_ROUNDS,
    skipEnabledCheck: true,
    messages: [{
      role: "user",
      content: `Inbound ${channel} from the customer:\n${cleanText(inbound.subject) ? `Subject: ${cleanText(inbound.subject)}\n` : ""}${String(inbound.text_body || "")}`
    }]
  }).catch((error) => ({ run: null, finalText: "", reported: null, loopError: errorMessage(error), failed: true } as const));

  const recordId = cleanText(record.id);
  const proposedReply = outcome.run ? asObject(outcome.run.scratch.proposedReply) : {};
  const changes = outcome.run ? outcome.run.changeLog : [];
  if (outcome.loopError || !cleanText(proposedReply.text)) {
    (await updateAutoReplyRecord(orgId, recordId, {
      status: "failed",
      error: outcome.loopError || "The agent did not propose a reply.",
      content: { changes }
    }));
    return null;
  }

  const reply = {
    channel: cleanText(proposedReply.channel) === "sms" ? "sms" : "email",
    subject: cleanText(proposedReply.subject),
    text: String(proposedReply.text ?? "")
  };
  const summary = outcome.reported?.summary || "";
  if (mode === "send" && resolved.agent.allow_send) {
    try {
      const sent = reply.channel === "sms"
        ? await sendProjectSms(orgId, branchId, projectId, { text: reply.text, source: { type: "automation", id: "comms_agent" } })
        : await sendProjectEmail(orgId, branchId, projectId, {
          subject: reply.subject || `Re: ${cleanText(inbound.subject) || "your message"}`,
          text: reply.text,
          conversation_id: cleanText(inbound.conversation_id) || undefined,
          source: { type: "automation", id: "comms_agent" }
        });
      const updated = (await updateAutoReplyRecord(orgId, recordId, {
        status: "sent",
        outbound_message_id: cleanText(asObject(sent.message).id),
        content: { ...reply, summary, changes }
      }));
      await publishWorkCommunicationEvent("communication.auto_replied", (await readMessageRecord(orgId, cleanText(asObject(sent.message).id))), { auto_reply_id: recordId, mode: "send" });
      return updated;
    } catch (error) {
      return (await updateAutoReplyRecord(orgId, recordId, {
        status: "failed",
        error: errorMessage(error).slice(0, 500),
        content: { ...reply, changes }
      }));
    }
  }

  const updated = (await updateAutoReplyRecord(orgId, recordId, {
    status: "draft",
    content: { ...reply, summary, changes }
  }));
  // Tell the routed team members a draft is waiting.
  try {
    const { createPlatformNotification } = await import("../platform/api.js");
    await createPlatformNotification(orgId, {
      id: `notification_comms_draft_${recordId}`,
      title: "AI drafted a reply for review",
      body: reply.text.length > 160 ? `${reply.text.slice(0, 157)}…` : reply.text,
      kind: "comms_message",
      channel: "passive",
      manual_dismissible: true,
      branch_id: branchId,
      source: "comms_agent",
      target_role_ids: resolved.notifications.target_role_ids,
      target_user_ids: resolved.notifications.target_user_ids,
      frontend_action: {
        kind: "open_project_comms",
        project_id: projectId,
        comms_view: reply.channel === "sms" ? "sms" : "email",
        conversation_id: cleanText(inbound.conversation_id),
        auto_reply_id: recordId
      },
      context: { project_id: projectId, auto_reply_id: recordId }
    });
  } catch (error) {
    console.error("comms draft notification failed", error);
  }
  return updated;
}
