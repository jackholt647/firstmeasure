import { createHash } from "node:crypto";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { badRequest } from "../platform/errors.js";
import { createConversationRecord, type CommunicationsJson } from "./communications_storage.js";

export function groupMmsNumber(value: unknown) {
  const number = parsePhoneNumberFromString(String(value || ""), "US");
  if (!number?.isValid() || !["US", "CA"].includes(number.country || "")
    || /^\+1(?:800|833|844|855|866|877|888|900)/.test(number.number)) {
    throw badRequest("group_mms_number_unsupported", "Group MMS requires US or Canadian local phone numbers, not toll-free numbers or short codes.");
  }
  return String(number.number);
}

export function groupMmsMembers(local: string, values: unknown[]) {
  const localNumber = groupMmsNumber(local);
  const members = values.map(groupMmsNumber).sort();
  if (members.length < 2 || members.length > 8) throw badRequest("group_mms_recipient_limit", "A group MMS must have 2 to 8 external recipients.");
  if (new Set(members).size !== members.length || members.includes(localNumber)) {
    throw badRequest("group_mms_duplicate_participant", "Group recipients must be distinct and cannot include the sending line.");
  }
  return members;
}

export function smsGroup(value: unknown): CommunicationsJson | null {
  const metadata = value as CommunicationsJson | undefined;
  const group = metadata?.sms_group as CommunicationsJson | undefined;
  return group?.mode === "group_mms" ? group : null;
}

export async function ensureGroupMmsConversation(input: CommunicationsJson, local: string, participants: CommunicationsJson[]) {
  const members = groupMmsMembers(local, participants.map(item => item.address));
  return persistGroupConversation(input, local, participants, members);
}

export function groupReplyBlockReason(local: string, values: unknown[]): "" | "recipient_limit" | "unsupported_number" {
  if (values.length > 8) return "recipient_limit";
  try { groupMmsMembers(local, values); return ""; } catch { return "unsupported_number"; }
}

export function assertGroupSendable(conversation: CommunicationsJson) {
  const group = smsGroup(conversation.metadata);
  if (group && groupReplyBlockReason(String(group.local_number), (conversation.participants as CommunicationsJson[]).map(item => item.address))) {
    throw badRequest("group_mms_read_only", "This incoming group is read-only. Send an explicitly private reply to an individual sender instead.");
  }
}

export async function ensureInboundGroupMmsConversation(input: CommunicationsJson, local: string, participants: CommunicationsJson[]) {
  const normalize = (value: unknown) => {
    const number = parsePhoneNumberFromString(String(value || ""), "US");
    if (!number?.isValid()) throw badRequest("group_mms_invalid_inbound_number", "The incoming group contains an invalid phone number.");
    return String(number.number);
  };
  const localNumber = normalize(local);
  const normalized = participants.map(item => ({ ...item, address: normalize(item.address) }));
  const members = [...new Set(normalized.map(item => item.address).filter(address => address !== localNumber))].sort();
  if (members.length < 2) throw badRequest("group_mms_recipient_limit", "An incoming group requires at least two other participants.");
  return persistGroupConversation(input, localNumber, normalized, members);
}

async function persistGroupConversation(input: CommunicationsJson, local: string, participants: CommunicationsJson[], members: string[]) {
  const key = createHash("sha256").update(JSON.stringify([input.organization_id, local, members])).digest("hex");
  const metadata = (input.metadata || {}) as CommunicationsJson;
  const conversation = await createConversationRecord({ ...input, id: `group_mms_${key}`, channel_strategy: "sms", participants: members.map(address => participants.find(item => item.address === address) || { address }),
    metadata: { ...metadata, sms_group: { mode: "group_mms", local_number: local, remote_numbers: members, participant_key: key } }
  }, true);
  const requestedProject = String((input.context as CommunicationsJson | undefined)?.project_id || "");
  if (requestedProject && requestedProject !== String(conversation.project_id || "")) throw badRequest("group_mms_context_changed", "This group already belongs to a different context. Use its existing conversation.");
  return conversation;
}
