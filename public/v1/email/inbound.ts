// Inbound email processing for the FirstMate Mail engine.
//
// Providers land here as a NORMALIZED payload — the Cloudflare Email Worker
// (and the dev simulator) convert their native formats into InboundEmailInput
// so routing, threading, project matching, and notifications live in exactly
// one place.

import { z } from "zod";

import { badRequest } from "../platform/errors.js";
import {
  createCommunicationEvent,
  createConversationRecord,
  createMessageRecord,
  getCommunicationsDatabase,
  readMessageRecord,
  touchConversationForMessage,
  updateMessageRecord
} from "../messaging/communications_storage.js";
import { publishWorkCommunicationEvent } from "../messaging/communications_service.js";
import { findEmailInboxOwner, normalizeEmailAddress } from "./engine.js";
import { matchProjectContact } from "../comms/matching.js";

type Json = Record<string, unknown>;

export const inboundEmailSchema = z.object({
  provider: z.string().trim().max(80).optional(),
  provider_event_id: z.string().trim().max(240).optional(),
  from: z.object({
    address: z.string().trim().min(3).max(500),
    name: z.string().trim().max(300).optional()
  }).passthrough(),
  to: z.array(z.object({
    address: z.string().trim().min(3).max(500),
    name: z.string().trim().max(300).optional()
  }).passthrough()).min(1).max(50),
  subject: z.string().trim().max(998).optional(),
  text: z.string().max(500_000).optional(),
  html: z.string().max(1_000_000).optional(),
  headers: z.object({
    message_id: z.string().trim().max(500).optional(),
    in_reply_to: z.string().trim().max(500).optional(),
    references: z.array(z.string().trim().max(500)).max(50).optional()
  }).passthrough().optional(),
  occurred_at: z.string().trim().optional(),
  metadata: z.record(z.unknown()).optional()
}).passthrough();

export type InboundEmailInput = z.infer<typeof inboundEmailSchema>;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

/** Find the outbound message that an inbound reply references, if any. */
async function findMessageByRfcMessageId(organizationId: string, rfcIds: string[]) {
  const db = getCommunicationsDatabase();
  for (const rfcId of rfcIds) {
    const id = cleanText(rfcId);
    if (!id) continue;
    const row = (await db.prepare(
      "SELECT * FROM communication_messages WHERE organization_id = ? AND channel = 'email' AND metadata_json LIKE ? ORDER BY created_at DESC LIMIT 1"
    ).get(organizationId, `%${JSON.stringify(id).slice(1, -1)}%`)) as Json | undefined;
    if (row) return row;
  }
  return null;
}

async function findOpenEmailConversation(organizationId: string, remoteAddress: string) {
  const row = (await getCommunicationsDatabase().prepare(
    `SELECT * FROM communication_conversations
     WHERE organization_id = ? AND status = 'open' AND channel_strategy IN ('email', 'omnichannel')
       AND participants_json LIKE ?
     ORDER BY COALESCE(last_message_at, updated_at) DESC LIMIT 1`
  ).get(organizationId, `%${JSON.stringify(remoteAddress).slice(1, -1)}%`)) as Json | undefined;
  return row ?? null;
}

export async function processInboundEmail(input: InboundEmailInput) {
  const fromAddress = normalizeEmailAddress(input.from.address);
  if (!fromAddress) throw badRequest("invalid_inbound_sender", "Inbound email sender address is invalid.");

  // Route on the first recipient that maps to a provisioned org inbox.
  let owner: Awaited<ReturnType<typeof findEmailInboxOwner>> = null;
  for (const recipient of input.to) {
    owner = (await findEmailInboxOwner(recipient.address));
    if (owner) break;
  }
  if (!owner) throw badRequest("inbox_not_found", "No organization inbox matches the inbound recipients.");

  const organizationId = owner.organization_id;
  const headers = asObject(input.headers);
  const references = [
    ...(Array.isArray(headers.references) ? (headers.references as unknown[]).map(cleanText) : []),
    cleanText(headers.in_reply_to)
  ].filter(Boolean);

  // Thread resolution: referenced outbound message → its conversation; else an
  // open email conversation with this sender; else a fresh conversation
  // attached to the matched project/contact.
  let conversationId = "";
  let projectId = "";
  let contactId = "";
  const referenced = references.length ? (await findMessageByRfcMessageId(organizationId, references)) : null;
  if (referenced) {
    conversationId = cleanText(referenced.conversation_id);
    projectId = cleanText(referenced.project_id);
    contactId = cleanText(referenced.contact_id);
  }
  if (!conversationId) {
    const openConversation = (await findOpenEmailConversation(organizationId, fromAddress));
    if (openConversation) {
      conversationId = cleanText(openConversation.id);
      projectId = projectId || cleanText(openConversation.project_id);
      contactId = contactId || cleanText(openConversation.contact_id);
    }
  }
  if (!projectId || !contactId) {
    const match = await matchProjectContact(organizationId, { email: fromAddress });
    if (match) {
      projectId = projectId || match.project_id;
      contactId = contactId || match.contact_id;
    }
  }
  if (!conversationId) {
    const conversation = (await createConversationRecord({
      organization_id: organizationId,
      branch_id: owner.branch_id,
      channel_strategy: "email",
      subject: cleanText(input.subject),
      participants: [
        { address: fromAddress, name: cleanText(input.from.name), type: "to", ...(contactId ? { contact_id: contactId } : {}) },
        { address: owner.address, type: "to" }
      ],
      context: {
        ...(projectId ? { project_id: projectId } : {}),
        ...(contactId ? { contact_id: contactId } : {})
      },
      metadata: { source: "email_inbound", remote_address: fromAddress }
    }));
    conversationId = cleanText(conversation.id);
  }

  const providerEventId = cleanText(input.provider_event_id);
  const now = new Date().toISOString();
  const created = (await createMessageRecord({
    organization_id: organizationId,
    branch_id: owner.branch_id,
    conversation_id: conversationId,
    direction: "inbound",
    channel: "email",
    purpose: "customer_care",
    status: "delivered",
    subject: cleanText(input.subject),
    text_body: input.text,
    html_body: input.html,
    sender: { address: fromAddress, name: cleanText(input.from.name), ...(contactId ? { contact_id: contactId } : {}) },
    recipients: input.to.map((recipient) => ({ address: normalizeEmailAddress(recipient.address) || cleanText(recipient.address), name: cleanText(recipient.name), type: "to" })),
    context: {
      ...(projectId ? { project_id: projectId } : {}),
      ...(contactId ? { contact_id: contactId } : {})
    },
    source: { type: "webhook", id: cleanText(input.provider) || "firstmate_mail" },
    metadata: {
      ...asObject(input.metadata),
      email: {
        ...(cleanText(asObject(headers).message_id) ? { message_id: cleanText(asObject(headers).message_id) } : {}),
        ...(cleanText(headers.in_reply_to) ? { in_reply_to: cleanText(headers.in_reply_to) } : {}),
        ...(references.length ? { references } : {})
      },
      // Real provider events post-launch are live; everything before that
      // (simulation, spool replay) is capture and gets the TEST badge.
      transport_mode: cleanText(input.provider) === "cloudflare_email" ? "live" : "capture"
    },
    ...(providerEventId ? { idempotency_key: `email_inbound:${providerEventId}` } : {})
  }));
  if (!created.created) {
    // Duplicate provider event — already processed.
    return { message: created.message, created: false };
  }
  const messageId = cleanText(created.message.id);
  (await createCommunicationEvent({
    organization_id: organizationId,
    message_id: messageId,
    type: "message.received",
    provider: cleanText(input.provider) || "firstmate_mail",
    occurred_at: cleanText(input.occurred_at) || now,
    payload: { channel: "email", from: fromAddress }
  }));
  (await updateMessageRecord(organizationId, messageId, { status: "delivered", delivered_at: now }));
  (await touchConversationForMessage(organizationId, conversationId, now));
  const received = (await readMessageRecord(organizationId, messageId));
  await publishWorkCommunicationEvent("communication.received", received, { status: "delivered" });

  // Notification routing + optional auto-response live in comms; dynamic
  // import keeps the email engine free of a comms dependency cycle.
  try {
    const { onInboundCommunication } = await import("../comms/notifications.js");
    await onInboundCommunication(organizationId, messageId);
  } catch (error) {
    console.error("comms inbound hook failed", error);
  }
  try {
    const { forwardInboundEmail } = await import("../comms/forwarding.js");
    await forwardInboundEmail(organizationId, owner.branch_id, received, { inboxAddress:owner.address });
  } catch (error) {
    // Forwarding is an optional secondary delivery. The inbound message is
    // already durable, so a bad target must never make the provider retry it.
    console.error("comms inbound forwarding failed", error);
  }
  return { message: received, created: true };
}
