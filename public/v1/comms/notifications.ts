// Inbound-communication notification routing + auto-response trigger.
//
// Called after ANY inbound customer message is recorded (Telnyx SMS webhook,
// email engine inbound, dev simulation). Resolves who should hear about it —
// project overrides first, branch comms settings second — and creates a
// platform notification that deep-links into the project comms tab. When the
// comms AI auto-response is enabled for the message's channel, an agent turn
// is scheduled to draft (or send) a reply.
//
// Scope sets parameterize routing independently of this default path: bind
// `notification.create.v1` (with conditions/targets) on the
// `communication.received` work event to notify, say, the operations role once
// a project is in production.

import { readMessageRecord } from "../messaging/communications_storage.js";
import { resolveProjectCommsSettings, loadCommsSettings } from "./settings.js";

type Json = Record<string, unknown>;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function channelLabel(channel: string) {
  if (channel === "sms") return "text message";
  if (channel === "email") return "email";
  if (channel === "webchat") return "chat message";
  return "message";
}

function commsViewForChannel(channel: string) {
  if (channel === "sms") return "sms";
  if (channel === "email") return "email";
  if (channel === "webchat") return "chat";
  return "overview";
}

function previewText(message: Json) {
  const subject = cleanText(message.subject);
  const body = cleanText(message.text_body).replace(/\s+/g, " ");
  const preview = subject ? (body ? `${subject} — ${body}` : subject) : body;
  return preview.length > 180 ? `${preview.slice(0, 177)}…` : preview;
}

export async function onInboundCommunication(organizationId: string, messageId: string) {
  let message: Json;
  try {
    message = (await readMessageRecord(organizationId, messageId));
  } catch {
    return null;
  }
  if (cleanText(message.direction) !== "inbound") return null;
  const channel = cleanText(message.channel);
  // Webchat already notifies through the live-chat pipeline (notifyTeam);
  // double-notifying every portal chat message would be noise.
  if (channel === "webchat") return null;

  const branchId = cleanText(message.branch_id) || "default";
  const context = asObject(message.context);
  const projectId = cleanText(context.project_id || message.project_id);

  const resolved = projectId
    ? await resolveProjectCommsSettings(organizationId, branchId, projectId)
    : { notifications: (await loadCommsSettings(organizationId, branchId)).notifications, agent: null };

  // Appointment confirmations listen on every inbound reply: a customer texting
  // back "yes" is the confirmation, so this runs before notification routing and
  // is allowed to mark the appointment confirmed on its own.
  let confirmation: unknown = null;
  try {
    const { handleInboundConfirmationResponse } = await import("../appointments/service.js");
    confirmation = await handleInboundConfirmationResponse(organizationId, message);
  } catch (error) {
    console.error("appointment confirmation matching failed", error);
  }

  // The guided rescheduling workflow is deterministic and works without an AI
  // agent. It runs before agent auto-response so a numbered slot choice never
  // receives a second, competing reply from the model.
  let rescheduling: unknown = null;
  if (projectId) {
    try {
      const { handleInboundReschedulingResponse } = await import("../appointments/rescheduling.js");
      rescheduling = await handleInboundReschedulingResponse(organizationId, branchId, message);
    } catch (error) {
      console.error("appointment rescheduling workflow failed", error);
    }
  }

  let notification: unknown = null;
  if (resolved.notifications.enabled) {
    const sender = asObject(message.sender);
    const senderName = cleanText(sender.name) || cleanText(sender.address) || "A customer";
    try {
      const { createPlatformNotification } = await import("../platform/api.js");
      notification = await createPlatformNotification(organizationId, {
        id: `notification_comms_${cleanText(message.id)}`,
        title: `New ${channelLabel(channel)} from ${senderName}`,
        body: previewText(message),
        kind: "comms_message",
        channel: "passive",
        push: true,
        manual_dismissible: true,
        branch_id: branchId,
        source: "comms",
        target_role_ids: resolved.notifications.target_role_ids,
        target_user_ids: resolved.notifications.target_user_ids,
        ...(projectId
          ? {
            frontend_action: {
              kind: "open_project_comms",
              project_id: projectId,
              comms_view: commsViewForChannel(channel),
              conversation_id: cleanText(message.conversation_id),
              message_id: cleanText(message.id)
            }
          }
          : {}),
        context: {
          project_id: projectId,
          conversation_id: cleanText(message.conversation_id),
          message_id: cleanText(message.id),
          channel
        }
      });
    } catch (error) {
      console.error("comms notification failed", error);
    }
  }

  // Auto-response (project-resolved settings only — org-wide auto-reply to
  // unmatched senders is deliberately off the table).
  if (projectId && !asObject(rescheduling).handled && resolved.agent && resolved.agent.enabled && resolved.agent.auto_response.enabled) {
    const channelEnabled = channel === "email"
      ? resolved.agent.auto_response.channels.email
      : channel === "sms" ? resolved.agent.auto_response.channels.sms : false;
    if (channelEnabled) {
      try {
        const { scheduleAutoResponse } = await import("./agent.js");
        scheduleAutoResponse(organizationId, branchId, projectId, cleanText(message.id), resolved.agent.auto_response.mode);
      } catch (error) {
        console.error("comms auto-response scheduling failed", error);
      }
    }
  }
  return { notification, confirmation, rescheduling };
}
