// Comms service — the project-scoped aggregation layer over the shared
// communications store. Assembles the unified feed/overview, email threads,
// SMS conversations, and portal-chat listings; wraps outbound sends with
// conversation threading; and powers the dev simulator that exercises the
// whole inbound path while providers are in capture mode.

import { badRequest } from "../platform/errors.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import {
  createConversationRecord,
  createCommunicationEvent,
  createMessageRecord,
  listConversationRecords,
  listDeliveryRecords,
  listMessageRecords,
  readConversationRecord,
  readMessageRecord,
  touchConversationForMessage,
  updateMessageRecord
} from "../messaging/communications_storage.js";
import { publishWorkCommunicationEvent, sendCommunication } from "../messaging/communications_service.js";
import { ensureOrgEmailInbox, sendEngineEmail, normalizeEmailAddress } from "../email/engine.js";
import { processInboundEmail } from "../email/inbound.js";
import { readDocument } from "../platform/storage.js";
import { searchCommunicationMessages, listAutoReplyRecords } from "./storage.js";
import { matchProjectContact } from "./matching.js";
import { callActivityRows, callInbox, workflow, incomingWorkflow } from "./calls/activity.js";

type Json = Record<string, unknown>;

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizePhone(value: unknown) {
  const raw = cleanText(value);
  const compact = raw.replace(/[^\d+]/g, "");
  if (/^\+[1-9]\d{7,14}$/.test(compact)) return compact;
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return "";
}

function messageTestMode(message: Json) {
  return ["capture", "test"].includes(cleanText(asObject(message.metadata).transport_mode));
}

function sourceKind(message: Json) {
  const source = asObject(message.source);
  const type = cleanText(source.type);
  if (cleanText(source.id) === "comms_agent" || cleanText(asObject(message.metadata).source) === "comms_agent") return "ai";
  if (type === "automation") return "automation";
  if (type === "user") return "user";
  if (type === "webhook") return "customer";
  return type || "system";
}

/** The comms-tab view of a message: compact, with an explicit test flag. */
export function commsMessageView(message: Json) {
  return {
    id: message.id,
    conversation_id: message.conversation_id,
    channel: message.channel,
    direction: message.direction,
    status: message.status,
    subject: message.subject,
    text: message.text_body,
    html: message.html_body,
    sender: message.sender,
    recipients: message.recipients,
    tags: message.tags,
    metadata: asObject(message.metadata),
    source_kind: sourceKind(message),
    test_mode: messageTestMode(message),
    project_id: cleanText(asObject(message.context).project_id || message.project_id),
    contact_id: cleanText(asObject(message.context).contact_id || message.contact_id),
    created_at: message.created_at,
    sent_at: message.sent_at,
    delivered_at: message.delivered_at,
    failed_at: message.failed_at
  };
}

export type CommsMessageViewModel = ReturnType<typeof commsMessageView>;

// ---------------------------------------------------------------------------
// Project channel plumbing
// ---------------------------------------------------------------------------

async function projectPrimaryContact(orgId: string, projectId: string) {
  const document = await readDocument(orgId, "projects", projectId);
  const data = asObject(document.data);
  const contacts = asArray(data.contacts).map(asObject);
  const primary = contacts.find((contact) => contact.primary === true) || contacts[0] || {};
  return {
    project: { id: cleanText(document.id), ...data },
    contact: primary,
    contacts,
    email: normalizeEmailAddress(primary.email),
    phone: normalizePhone(primary.phone || primary.phone_number || primary.mobile),
    contact_id: cleanText(primary.id) || cleanText(primary.contact_id),
    name: cleanText(primary.name || `${cleanText(primary.first_name)} ${cleanText(primary.last_name)}`)
  };
}

function conversationParticipantAddresses(conversation: Json) {
  return asArray(conversation.participants).map((participant) => cleanText(asObject(participant).address)).filter(Boolean);
}

function sameAddressSet(left: string[], right: string[]) {
  const a = [...new Set(left.filter(Boolean))].sort();
  const b = [...new Set(right.filter(Boolean))].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function ensureProjectChannelConversation(
  orgId: string,
  branchId: string,
  projectId: string,
  strategy: "sms" | "email",
  remote: { address: string; name?: string; contact_id?: string },
  localAddress: string
) {
  return (await createProjectRecipientsConversation(orgId, branchId, projectId, strategy, [{
    address: remote.address,
    name: remote.name,
    contact_id: remote.contact_id,
    type: "to"
  }], localAddress));
}

type ProjectRecipient = { address: string; name?: string; contact_id?: string; type?: "to" | "cc" | "bcc" };

async function findExactProjectChannelConversation(
  orgId: string,
  projectId: string,
  strategy: "sms" | "email",
  recipients: ProjectRecipient[],
  localAddress = ""
) {
  const wanted = recipients.map((recipient) => recipient.address);
  return (await listConversationRecords(orgId, { project_id: projectId, limit: 250 })).find((conversation) => {
    if (cleanText(conversation.channel_strategy) !== strategy || cleanText(conversation.status) === "archived") return false;
    const addresses = conversationParticipantAddresses(conversation).filter((address) => !localAddress || address !== localAddress);
    return sameAddressSet(addresses, wanted);
  }) || null;
}

async function createProjectRecipientsConversation(
  orgId: string,
  branchId: string,
  projectId: string,
  strategy: "sms" | "email",
  recipients: ProjectRecipient[],
  localAddress = "",
  subject = "",
  reuseExisting = true
) {
  const existing = reuseExisting
    ? (await findExactProjectChannelConversation(orgId, projectId, strategy, recipients, localAddress))
    : null;
  if (existing) return existing;
  const contactIds = recipients.map((recipient) => cleanText(recipient.contact_id)).filter(Boolean);
  return (await createConversationRecord({
    organization_id: orgId,
    branch_id: branchId,
    channel_strategy: strategy,
    subject: cleanText(subject),
    participants: [
      ...recipients.map((recipient) => ({
        address: recipient.address,
        name: cleanText(recipient.name),
        type: recipient.type || "to",
        ...(recipient.contact_id ? { contact_id: recipient.contact_id } : {})
      })),
      ...(localAddress ? [{ address: localAddress, type: "internal" }] : [])
    ],
    context: { project_id: projectId, ...(contactIds.length === 1 ? { contact_id: contactIds[0] } : {}) },
    metadata: { source: "comms", recipient_key: recipients.map((recipient) => recipient.address).sort().join("|") }
  }));
}

function projectContactForAddress(contacts: Json[], channel: "email" | "sms", address: string) {
  return contacts.find((contact) => {
    const candidate = channel === "email"
      ? normalizeEmailAddress(contact.email)
      : normalizePhone(contact.phone || contact.phone_number || contact.mobile);
    return candidate === address;
  }) || {};
}

function projectRecipientView(contact: Json) {
  return {
    id: cleanText(contact.id || contact.contact_id),
    name: cleanText(contact.name || `${cleanText(contact.first_name)} ${cleanText(contact.last_name)}`),
    email: normalizeEmailAddress(contact.email),
    phone: normalizePhone(contact.phone || contact.phone_number || contact.mobile),
    primary: contact.primary === true
  };
}

function normalizeEmailRecipientLists(
  input: { to?: string | string[]; cc?: string[]; bcc?: string[] },
  defaultAddress: string
) {
  const rawByType: Array<["to" | "cc" | "bcc", string[]]> = [
    ["to", Array.isArray(input.to) ? input.to : cleanText(input.to) ? [cleanText(input.to)] : defaultAddress ? [defaultAddress] : []],
    ["cc", Array.isArray(input.cc) ? input.cc : []],
    ["bcc", Array.isArray(input.bcc) ? input.bcc : []]
  ];
  const seen = new Set<string>();
  const result: Array<{ address: string; type: "to" | "cc" | "bcc" }> = [];
  for (const [type, values] of rawByType) {
    for (const raw of values) {
      const address = normalizeEmailAddress(raw);
      if (!address) throw badRequest("invalid_recipient", `Enter a valid email address for ${type.toUpperCase()}.`);
      if (seen.has(address)) continue;
      seen.add(address);
      result.push({ address, type });
    }
  }
  if (!result.some((recipient) => recipient.type === "to")) {
    throw badRequest("recipient_email_missing", "Add at least one To recipient.");
  }
  return result;
}

function normalizeSmsRecipients(input: string | string[] | undefined, defaultAddress: string) {
  const values = Array.isArray(input) ? input : cleanText(input) ? [cleanText(input)] : defaultAddress ? [defaultAddress] : [];
  const recipients = [...new Set(values.map(normalizePhone).filter(Boolean))];
  if (recipients.length !== values.length) {
    throw badRequest("invalid_recipient", "Enter a valid, unique phone number for every text recipient.");
  }
  if (!recipients.length) throw badRequest("recipient_phone_missing", "Add at least one phone number to text.");
  return recipients;
}

/** Last known RFC message id + references in a conversation, for reply headers. */
async function conversationThreadingHeaders(orgId: string, conversationId: string) {
  const messages = (await listMessageRecords(orgId, { conversation_id: conversationId, channel: "email", limit: 50 }));
  for (const message of messages) {
    const email = asObject(asObject(message.metadata).email);
    const messageId = cleanText(email.message_id);
    if (messageId) {
      const references = [...asArray(email.references).map(cleanText).filter(Boolean), messageId].slice(-20);
      return { in_reply_to: messageId, references };
    }
  }
  return { in_reply_to: "", references: [] as string[] };
}

// ---------------------------------------------------------------------------
// Overview + feed
// ---------------------------------------------------------------------------

export async function projectCommsOverview(orgId: string, branchId: string, projectId: string) {
  const inbox = await ensureOrgEmailInbox(orgId, branchId).catch(() => null);
  const messages = (await listMessageRecords(orgId, { project_id: projectId, limit: 500 }));
  const channels: Record<string, { total: number; inbound: number; outbound: number; last_message: CommsMessageViewModel | null }> = {};
  for (const message of messages) {
    const channel = cleanText(message.channel) || "unknown";
    if (!channels[channel]) channels[channel] = { total: 0, inbound: 0, outbound: 0, last_message: null };
    const bucket = channels[channel];
    bucket.total += 1;
    if (cleanText(message.direction) === "inbound") bucket.inbound += 1;
    else bucket.outbound += 1;
    if (!bucket.last_message) bucket.last_message = commsMessageView(message);
  }
  const calls=(await callActivityRows(orgId,{project_id:projectId,limit:200}));
  channels.call={total:calls.length,inbound:calls.filter(c=>c.direction==='inbound').length,outbound:calls.filter(c=>c.direction==='outbound').length,last_message:calls[0]||null};
  const recent = [...messages.slice(0,12).map(commsMessageView),...calls].sort((a,b)=>cleanText(b.created_at).localeCompare(cleanText(a.created_at))).slice(0,12);
  const drafts = (await listAutoReplyRecords(orgId, { project_id: projectId, status: "draft", limit: 10 }));
  const contact = await projectPrimaryContact(orgId, projectId).catch(() => null);
  return {
    org_inbox_address: inbox ? cleanText(inbox.address) : "",
    contact: contact
      ? { name: contact.name, email: contact.email, phone: contact.phone, contact_id: contact.contact_id }
      : null,
    contacts: contact ? contact.contacts.map(projectRecipientView) : [],
    channels,
    recent,
    pending_ai_drafts: drafts,
    total_messages: messages.length
  };
}

export async function projectCommsFeed(orgId: string, projectId: string, options: { channel?: string; limit?: number } = {}) {
  const messages = (await listMessageRecords(orgId, {
    project_id: projectId,
    ...(cleanText(options.channel) ? { channel: cleanText(options.channel) } : {}),
    limit: Math.max(1, Math.min(500, Number(options.limit || 200)))
  }));
  const calls=!options.channel||options.channel==='call'?(await callActivityRows(orgId,{project_id:projectId,limit:options.limit||200})):[];
  return [...messages.map(commsMessageView),...calls].sort((a,b)=>cleanText(b.created_at).localeCompare(cleanText(a.created_at))).slice(0,options.limit||200).reverse();
}

export async function orgCommsFeed(orgId: string, options: { channel?: string; limit?: number; branch_id?:string } = {}) {
  const messages = (await listMessageRecords(orgId, {
    branch_id:options.branch_id,
    ...(cleanText(options.channel) ? { channel: cleanText(options.channel) } : {}),
    limit: Math.max(1, Math.min(500, Number(options.limit || 200)))
  }));
  const calls=!options.channel||options.channel==='call'?(await callActivityRows(orgId,{branch_id:options.branch_id,limit:options.limit||200})):[];
  return [...messages.map(commsMessageView),...calls].sort((a,b)=>cleanText(b.created_at).localeCompare(cleanText(a.created_at))).slice(0,options.limit||200).reverse();
}

// ---------------------------------------------------------------------------
// Org-wide inbox (the global communications center)
// ---------------------------------------------------------------------------

function conversationChannel(conversation: Json) {
  const strategy = cleanText(conversation.channel_strategy);
  if (["email", "sms", "webchat"].includes(strategy)) return strategy;
  return "";
}

/**
 * Every conversation in the org across email, SMS, and web/portal chat, as
 * one channel-labeled list for the global comms center. Rows carry the
 * project label so the inbox can say who/what each thread belongs to.
 */
export async function orgCommsInbox(orgId: string, options: { channel?: string; status?: string; limit?: number;branch_id?:string;user_id?:string;snoozed?:boolean } = {}) {
  const limit = Math.max(1, Math.min(250, Number(options.limit || 100)));
  const conversations = (await listConversationRecords(orgId, {}));
  const rows: Json[] = [];
  const projectTitles = new Map<string, string>();
  for (const conversation of conversations) {
    if(options.branch_id&&cleanText(conversation.branch_id||'default')!==options.branch_id)continue;
    const lastMessages = (await listMessageRecords(orgId, { conversation_id: cleanText(conversation.id), limit: 1 }));
    const last = lastMessages[0] ? commsMessageView(lastMessages[0]) : null;
    const channel = cleanText(last?.channel) || conversationChannel(conversation);
    if (!channel) continue;
    if (cleanText(options.channel) && channel !== cleanText(options.channel)) continue;
    const projectId = cleanText(conversation.project_id);
    if (projectId && !projectTitles.has(projectId)) {
      try {
        const document = await readDocument(orgId, "projects", projectId);
        const data = asObject(document.data);
        projectTitles.set(projectId, cleanText(data.title || data.name || data.customer_name || data.address));
      } catch {
        projectTitles.set(projectId, "");
      }
    }
    const participants = asArray(conversation.participants).map(asObject);
    const customer = participants.find((participant) => cleanText(participant.type) !== "internal") || participants[0] || {};
    rows.push({
      id: conversation.id,
      channel,
      ...(await incomingWorkflow(orgId,"conversation",cleanText(conversation.id),cleanText((await listMessageRecords(orgId,{conversation_id:cleanText(conversation.id),direction:'inbound',limit:1}))[0]?.created_at),options.user_id,{status:conversation.status})),
      subject: cleanText(conversation.subject),
      project_id: projectId,
      project_title: projectId ? projectTitles.get(projectId) || "" : "",
      contact_name: cleanText(customer.name),
      contact_address: cleanText(customer.address || customer.email || customer.phone),
      last_message: last,
      last_message_at: conversation.last_message_at || last?.created_at || conversation.updated_at
    });
  }
  if(!options.channel||options.channel==='call')rows.push(...(await callInbox(orgId,options)));
  return rows.filter(row=>(!options.status||row.status===options.status)&&(options.snoozed?cleanText(row.snoozed_until)>new Date().toISOString():!row.snoozed_until||cleanText(row.snoozed_until)<=new Date().toISOString()))
    .sort((a,b)=>cleanText(b.last_message_at).localeCompare(cleanText(a.last_message_at))).slice(0,limit);
}

export async function orgConversationDetail(orgId: string, conversationId: string) {
  const conversation = (await readConversationRecord(orgId, conversationId));
  const messages = (await listMessageRecords(orgId, { conversation_id: conversationId, limit: 500 }))
    .map(commsMessageView)
    .reverse();
  const inbound=messages.filter(m=>m.direction==='inbound').at(-1);
  return { ...conversation, ...(await incomingWorkflow(orgId,'conversation',conversationId,cleanText(inbound?.created_at),'',{status:conversation.status})),channel: conversationChannel(conversation) || cleanText(messages[messages.length - 1]?.channel), messages };
}

// ---------------------------------------------------------------------------
// Email threads
// ---------------------------------------------------------------------------

export async function projectEmailThreads(orgId: string, projectId: string) {
  const conversations = (await listConversationRecords(orgId, { project_id: projectId, limit: 250 }))
    .filter((conversation) => ["email", "omnichannel"].includes(cleanText(conversation.channel_strategy)));
  return (await Promise.all(conversations.map(async (conversation) => {
    const messages = (await listMessageRecords(orgId, { conversation_id: cleanText(conversation.id), channel: "email", limit: 500 }));
    if (!messages.length) return null;
    return {
      id: conversation.id,
      subject: cleanText(conversation.subject) || cleanText(messages[messages.length - 1]?.subject) || "(no subject)",
      status: conversation.status,
      participants: conversation.participants,
      message_count: messages.length,
      last_message: commsMessageView(messages[0]!),
      last_message_at: conversation.last_message_at || messages[0]?.created_at
    };
  }))).filter(Boolean);
}

export async function projectEmailThreadDetail(orgId: string, projectId: string, conversationId: string) {
  const conversation = (await readConversationRecord(orgId, conversationId));
  if (cleanText(conversation.project_id) && cleanText(conversation.project_id) !== projectId) {
    throw badRequest("conversation_project_mismatch", "This conversation belongs to a different project.");
  }
  const messages = (await listMessageRecords(orgId, { conversation_id: conversationId, limit: 500 }))
    .filter((message) => cleanText(message.channel) === "email")
    .map(commsMessageView)
    .reverse();
  return {
    ...conversation,
    subject: cleanText(conversation.subject) || cleanText(messages[0]?.subject) || "(no subject)",
    messages
  };
}

export async function sendProjectEmail(
  orgId: string,
  branchId: string,
  projectId: string,
  input: { to?: string | string[]; cc?: string[]; bcc?: string[]; subject: string; text: string; html?: string; conversation_id?: string; source?: Json; idempotency_key?: string },
  ctx?: Partial<PlatformAuthContext>
) {
  const contact = await projectPrimaryContact(orgId, projectId);
  const inbox = await ensureOrgEmailInbox(orgId, branchId);
  let conversationId = cleanText(input.conversation_id);
  let recipients: ProjectRecipient[] = [];
  if (conversationId) {
    const conversation = (await readConversationRecord(orgId, conversationId));
    if (cleanText(conversation.project_id) && cleanText(conversation.project_id) !== projectId) {
      throw badRequest("conversation_project_mismatch", "This conversation belongs to a different project.");
    }
    const supplied = input.to !== undefined || input.cc !== undefined || input.bcc !== undefined;
    if (supplied) {
      recipients = normalizeEmailRecipientLists(input, contact.email).map((recipient) => {
        const match = projectContactForAddress(contact.contacts, "email", recipient.address);
        return { ...recipient, name: cleanText(match.name), contact_id: cleanText(match.id || match.contact_id) };
      });
    } else {
      recipients = asArray(conversation.participants).map(asObject)
        .filter((participant) => cleanText(participant.address) !== cleanText(inbox.address) && cleanText(participant.type) !== "internal" && cleanText(participant.type) !== "bcc")
        .map((participant) => ({
          address: normalizeEmailAddress(participant.address),
          name: cleanText(participant.name),
          contact_id: cleanText(participant.contact_id),
          type: (cleanText(participant.type) === "cc" ? "cc" : "to") as "to" | "cc"
        }))
        .filter((recipient) => recipient.address);
      if (!recipients.length) {
        recipients = normalizeEmailRecipientLists({}, contact.email);
      }
    }
  } else {
    recipients = normalizeEmailRecipientLists(input, contact.email).map((recipient) => {
      const match = projectContactForAddress(contact.contacts, "email", recipient.address);
      return { ...recipient, name: cleanText(match.name), contact_id: cleanText(match.id || match.contact_id) };
    });
    // A newly composed email is a new thread even when it has the same
    // recipients as an earlier conversation. Explicit replies supply a
    // conversation_id above and continue the existing thread.
    const conversation = (await createProjectRecipientsConversation(
      orgId,
      branchId,
      projectId,
      "email",
      recipients,
      cleanText(inbox.address),
      input.subject,
      false
    ));
    conversationId = cleanText(conversation.id);
  }
  const threading = (await conversationThreadingHeaders(orgId, conversationId));
  const contactIds = recipients.map((recipient) => cleanText(recipient.contact_id)).filter(Boolean);
  return await sendEngineEmail(orgId, {
    branch_id: branchId,
    conversation_id: conversationId,
    recipients,
    subject: input.subject,
    text: input.text,
    html: input.html,
    context: { project_id: projectId, ...(contactIds.length === 1 ? { contact_id: contactIds[0] } : {}) },
    source: input.source,
    idempotency_key: input.idempotency_key,
    in_reply_to: threading.in_reply_to || undefined,
    references: threading.references.length ? threading.references : undefined
  }, ctx);
}

// ---------------------------------------------------------------------------
// SMS conversations
// ---------------------------------------------------------------------------

export async function projectSmsConversation(orgId: string, _branchId: string, projectId: string, conversationId = "") {
  const contact = await projectPrimaryContact(orgId, projectId).catch(() => null);
  const conversations = (await Promise.all((await listConversationRecords(orgId, { project_id: projectId, limit: 250 }))
    .filter((conversation) => cleanText(conversation.channel_strategy) === "sms")
    .map(async (conversation) => {
      const messages = (await listMessageRecords(orgId, { conversation_id: cleanText(conversation.id), channel: "sms", limit: 500 }));
      const participants = asArray(conversation.participants).map(asObject).filter((participant) => cleanText(participant.address));
      return {
        id: conversation.id,
        status: conversation.status,
        participants,
        message_count: messages.length,
        last_message: messages.length ? commsMessageView(messages[0]!) : null,
        last_message_at: conversation.last_message_at || messages[0]?.created_at,
        messages: messages.map(commsMessageView).reverse()
      };
    })));
  const conversation = conversations.find((item) => cleanText(item.id) === cleanText(conversationId))
    || conversations.find((item) => item.participants.some((participant) => cleanText(participant.address) === (contact?.phone || "")))
    || conversations[0]
    || null;
  return {
    conversation: conversation || null,
    contact_phone: contact?.phone || "",
    contact_name: contact?.name || "",
    contacts: contact ? contact.contacts.map(projectRecipientView) : [],
    conversations,
    messages: conversation?.messages || []
  };
}

export async function sendProjectSms(
  orgId: string,
  branchId: string,
  projectId: string,
  input: { to?: string | string[]; text: string; conversation_id?: string; source?: Json; idempotency_key?: string; audio_note?: Json },
  ctx?: Partial<PlatformAuthContext>
) {
  const contact = await projectPrimaryContact(orgId, projectId);
  let recipientAddresses: string[] = [];
  let conversation: Json;
  if (cleanText(input.conversation_id) && input.to === undefined) {
    conversation = (await readConversationRecord(orgId, cleanText(input.conversation_id)));
    if (cleanText(conversation.project_id) && cleanText(conversation.project_id) !== projectId) {
      throw badRequest("conversation_project_mismatch", "This conversation belongs to a different project.");
    }
    recipientAddresses = conversationParticipantAddresses(conversation);
  } else {
    recipientAddresses = normalizeSmsRecipients(input.to, contact.phone);
    const projectRecipients = recipientAddresses.map((address) => {
      const match = projectContactForAddress(contact.contacts, "sms", address);
      return { address, name: cleanText(match.name), contact_id: cleanText(match.id || match.contact_id) };
    });
    conversation = (await createProjectRecipientsConversation(orgId, branchId, projectId, "sms", projectRecipients));
  }
  if (!recipientAddresses.length) throw badRequest("recipient_phone_missing", "Add at least one phone number to text.");
  const recipients = recipientAddresses.map((address) => {
    const match = projectContactForAddress(contact.contacts, "sms", address);
    return { address, name: cleanText(match.name), ...(cleanText(match.id || match.contact_id) ? { contact_id: cleanText(match.id || match.contact_id) } : {}) };
  });
  const contactIds = recipients.map((recipient) => cleanText(recipient.contact_id)).filter(Boolean);
  return await sendCommunication(orgId, {
    branch_id: branchId,
    conversation_id: cleanText(conversation.id),
    channel: "sms",
    purpose: "customer_care",
    recipients,
    content: { text: input.text },
    context: { project_id: projectId, ...(contactIds.length === 1 ? { contact_id: contactIds[0] } : {}) },
    source: input.source as never,
    metadata: cleanText(asObject(input.audio_note).media_id) ? { audio_note: asObject(input.audio_note) } : undefined,
    idempotency_key: input.idempotency_key
  } as never, ctx);
}

// ---------------------------------------------------------------------------
// Portal chat
// ---------------------------------------------------------------------------

export async function projectChatConversations(orgId: string, projectId: string) {
  const conversations = (await listConversationRecords(orgId, { project_id: projectId, limit: 250 }))
    .filter((conversation) => cleanText(conversation.channel_strategy) === "webchat");
  return (await Promise.all(conversations.map(async (conversation) => {
    const messages = (await listMessageRecords(orgId, { conversation_id: cleanText(conversation.id), limit: 500 }));
    return {
      id: conversation.id,
      status: conversation.status,
      participants: conversation.participants,
      message_count: messages.length,
      last_message: messages.length ? commsMessageView(messages[0]!) : null,
      last_message_at: conversation.last_message_at,
      messages: messages.map(commsMessageView).reverse()
    };
  })));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function searchComms(orgId: string, query: string, options: { project_id?: string; channel?: string; limit?: number;branch_id?:string } = {}) {
  const messages=(await searchCommunicationMessages(orgId, query, options)).map((hit) => ({
    ...commsMessageView({
      ...hit.message,
      metadata: JSON.parse(String(hit.message.metadata_json || "{}")),
      sender: JSON.parse(String(hit.message.sender_json || "{}")),
      recipients: JSON.parse(String(hit.message.recipients_json || "[]")),
      context: JSON.parse(String(hit.message.context_json || "{}")),
      source: JSON.parse(String(hit.message.source_json || "{}")),
      tags: JSON.parse(String(hit.message.tags_json || "[]")),
      subject: hit.message.subject,
      text_body: hit.message.text_body,
      html_body: ""
    }),
    snippet: hit.snippet
  }));
  const calls=!options.channel||options.channel==='call'?(await callActivityRows(orgId,{...options,query})).map(call=>({...call,snippet:call.text})):[];
  return [...messages,...calls].sort((a,b)=>cleanText(b.created_at).localeCompare(cleanText(a.created_at))).slice(0,options.limit||100);
}

// ---------------------------------------------------------------------------
// Inbound simulation (test mode)
// ---------------------------------------------------------------------------

/**
 * Simulate an inbound customer message for a project. Email rides the real
 * inbound pipeline (routing, threading, matching, notifications); SMS mirrors
 * the Telnyx webhook's record shape and then runs the same notification hook.
 */
export async function simulateProjectInbound(
  orgId: string,
  branchId: string,
  projectId: string,
  input: { channel: "email" | "sms"; text: string; subject?: string },
  ctx?: Partial<PlatformAuthContext>
) {
  const contact = await projectPrimaryContact(orgId, projectId);
  if (input.channel === "email") {
    const fromAddress = contact.email;
    if (!fromAddress) throw badRequest("contact_email_missing", "This project's contact has no email address to simulate from.");
    const inbox = await ensureOrgEmailInbox(orgId, branchId);
    const result = await processInboundEmail({
      provider: "simulation",
      provider_event_id: `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      from: { address: fromAddress, name: contact.name },
      to: [{ address: cleanText(inbox.address) }],
      subject: cleanText(input.subject) || "Re: your message",
      text: input.text,
      metadata: { simulated: true }
    });
    return { message: commsMessageView(result.message), created: result.created };
  }

  const fromPhone = contact.phone;
  if (!fromPhone) throw badRequest("contact_phone_missing", "This project's contact has no phone number to simulate from.");
  const conversation = await ensureProjectChannelConversation(orgId, branchId, projectId, "sms", {
    address: fromPhone,
    name: contact.name,
    contact_id: contact.contact_id
  }, "");
  const now = new Date().toISOString();
  const created = (await createMessageRecord({
    organization_id: orgId,
    branch_id: branchId,
    conversation_id: cleanText(conversation.id),
    direction: "inbound",
    channel: "sms",
    purpose: "customer_care",
    status: "delivered",
    text_body: input.text,
    sender: { address: fromPhone, name: contact.name, ...(contact.contact_id ? { contact_id: contact.contact_id } : {}) },
    recipients: [{ address: "+15555550100", type: "to" }],
    context: { project_id: projectId, ...(contact.contact_id ? { contact_id: contact.contact_id } : {}) },
    source: { type: "webhook", id: "simulation" },
    metadata: { transport_mode: "capture", simulated: true },
    delivered_at: now,
    created_by_user_id: cleanText(ctx?.userId)
  }));
  const messageId = cleanText(created.message.id);
  (await createCommunicationEvent({
    organization_id: orgId,
    message_id: messageId,
    type: "message.received",
    provider: "simulation",
    occurred_at: now,
    payload: { simulated: true }
  }));
  (await updateMessageRecord(orgId, messageId, { status: "delivered", delivered_at: now }));
  (await touchConversationForMessage(orgId, cleanText(conversation.id), now));
  const received = (await readMessageRecord(orgId, messageId));
  await publishWorkCommunicationEvent("communication.received", received, { status: "delivered" });
  const { onInboundCommunication } = await import("./notifications.js");
  await onInboundCommunication(orgId, messageId);
  return { message: commsMessageView((await readMessageRecord(orgId, messageId))), created: true };
}

// ---------------------------------------------------------------------------
// AI draft dispatch (approve a drafted auto-reply)
// ---------------------------------------------------------------------------

export async function dispatchAutoReplyDraft(
  orgId: string,
  branchId: string,
  projectId: string,
  autoReplyId: string,
  ctx?: Partial<PlatformAuthContext>
) {
  const { readAutoReplyRecord, updateAutoReplyRecord } = await import("./storage.js");
  const record = (await readAutoReplyRecord(orgId, autoReplyId));
  if (cleanText(record.project_id) !== projectId) throw badRequest("auto_reply_project_mismatch", "This draft belongs to a different project.");
  if (cleanText(record.status) !== "draft") throw badRequest("auto_reply_not_draft", "Only drafts can be sent.");
  const content = asObject(record.content);
  const text = String(content.text || "");
  if (!text.trim()) throw badRequest("auto_reply_empty", "This draft has no content.");
  const sent = cleanText(record.channel) === "sms"
    ? await sendProjectSms(orgId, branchId, projectId, { text, source: { type: "user", id: "comms_agent_draft" } }, ctx)
    : await sendProjectEmail(orgId, branchId, projectId, {
      subject: cleanText(content.subject) || "Re: your message",
      text,
      conversation_id: cleanText(record.conversation_id) || undefined,
      source: { type: "user", id: "comms_agent_draft" }
    }, ctx);
  return (await updateAutoReplyRecord(orgId, autoReplyId, {
    status: "sent",
    outbound_message_id: cleanText(asObject(sent.message).id)
  }));
}

export async function dismissAutoReplyDraft(orgId: string, projectId: string, autoReplyId: string) {
  const { readAutoReplyRecord, updateAutoReplyRecord } = await import("./storage.js");
  const record = (await readAutoReplyRecord(orgId, autoReplyId));
  if (cleanText(record.project_id) !== projectId) throw badRequest("auto_reply_project_mismatch", "This draft belongs to a different project.");
  return (await updateAutoReplyRecord(orgId, autoReplyId, { status: "dismissed" }));
}

export { matchProjectContact };
