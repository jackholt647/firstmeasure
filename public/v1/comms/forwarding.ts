import { customFieldValueAtPath } from "../custom_fields/service.js";
import { normalizeEmailAddress, sendEngineEmail } from "../email/engine.js";
import { readDocument, type JsonObject } from "../platform/storage.js";
import { readResourceGroup } from "../workforce/storage.js";
import { loadCommsSettings } from "./settings.js";

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as JsonObject) } : {};
}

async function userEmail(orgId: string, userIdValue: unknown) {
  const userId = cleanText(userIdValue);
  if (!userId) return "";
  const document = await readDocument(orgId, "users", userId).catch(() => null);
  return normalizeEmailAddress(asObject(document?.data).email);
}

async function targetEmail(orgId: string, project: JsonObject, forwardingValue: unknown) {
  const forwarding = asObject(forwardingValue);
  const target = asObject(forwarding.target || forwarding);
  const kind = cleanText(target.kind || target.type);
  if (kind === "email") return normalizeEmailAddress(target.email || target.address);
  if (kind === "organization_user") return await userEmail(orgId, target.user_id || target.id);
  if (kind !== "custom_field") return "";
  const reference = asObject(customFieldValueAtPath(
    project.custom_field_values || project.custom_fields,
    target.custom_field_path || target.path
  ));
  const subjectType = cleanText(reference.subject_type);
  const subjectId = cleanText(reference.subject_id || reference.id);
  if (subjectType === "organization_user") return await userEmail(orgId, subjectId);
  if (subjectType === "resource_group" && subjectId) {
    const group = await readResourceGroup(orgId, subjectId).catch(() => null);
    return group ? await userEmail(orgId, group.primary_member_user_id) : "";
  }
  return "";
}

export async function forwardInboundEmail(
  orgId: string,
  branchId: string,
  messageValue: unknown,
  options: { inboxAddress?: string } = {}
) {
  const message = asObject(messageValue);
  const projectId = cleanText(message.project_id || asObject(message.context).project_id);
  const projectDocument = projectId ? await readDocument(orgId, "projects", projectId).catch(() => null) : null;
  const project: JsonObject = projectDocument ? { id:projectId, ...asObject(projectDocument.data) } : {};
  const projectForwarding = asObject(asObject(project.comms).email_forwarding);
  const settings = await loadCommsSettings(orgId, branchId);
  let forwardingAddress = projectForwarding.enabled === false
    ? ""
    : await targetEmail(orgId, project, projectForwarding);
  let usedFallback = false;
  if (!forwardingAddress && settings.email_forwarding.enabled) {
    forwardingAddress = normalizeEmailAddress(settings.email_forwarding.fallback_email);
    usedFallback = true;
  }
  if (!forwardingAddress || forwardingAddress === normalizeEmailAddress(options.inboxAddress)) {
    return { forwarded:false, reason:forwardingAddress ? "forwarding_loop" : "no_forwarding_target" };
  }

  const sender = asObject(message.sender);
  const senderAddress = cleanText(sender.address || sender.email);
  const originalSubject = cleanText(message.subject || "Inbound project email");
  const routingNote = projectId
    ? `Matched project: ${cleanText(project.title || project.project_title || project.address || projectId)} (${projectId})`
    : "This message arrived without a recognized thread and could not be paired to a project.";
  const body = [
    routingNote,
    usedFallback ? "It was sent to the configured global fallback inbox." : "It was sent to this project's configured forwarding target.",
    "",
    `From: ${cleanText(sender.name)}${cleanText(sender.name) && senderAddress ? ` <${senderAddress}>` : senderAddress}`,
    `Subject: ${originalSubject}`,
    "",
    String(message.text_body || "").trim()
  ].join("\n");
  const result = await sendEngineEmail(orgId, {
    branch_id: branchId,
    recipients: [{ address:forwardingAddress, type:"to" }],
    subject: `Fwd: ${originalSubject}`,
    text: body,
    context: {
      ...(projectId ? { project_id:projectId } : {}),
      forwarded_inbound_message_id:cleanText(message.id)
    },
    source: { type:"system", automation_id:"email.forwardInbound.v1" },
    metadata: {
      forwarded_inbound:true,
      original_message_id:cleanText(message.id),
      unmatched_project:!projectId,
      fallback:usedFallback
    },
    idempotency_key:`email-forward:${cleanText(message.id)}:${forwardingAddress}`
  });
  return { forwarded:true, address:forwardingAddress, fallback:usedFallback, result };
}
