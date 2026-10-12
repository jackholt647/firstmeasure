import { z } from "zod";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, PlatformError } from "../platform/errors.js";
import { manageCalls } from "../comms/calls/service.js";
import { contentHash } from "../platform/publication/validation.js";
import { createConversationRecord, listConversationRecords, listMessageRecords, listDeliveryRecords, readConversationRecord, readMessageRecord, type CommunicationsJson as Json } from "./communications_storage.js";
import { requireGroupAccess } from "./group_access.js";
import { assertGroupSendable, groupReplyBlockReason, smsGroup } from "./group_mms.js";
import { validateSmsImage } from "../comms/sms-images.js";
import { createConversation, sendCommunication } from "./communications_service.js";
import { communicationPurposeSchema, sendCommunicationSchema } from "./schemas.js";

const text = (value: unknown) => String(value || "");
const object = (value: unknown) => (value || {}) as Json;
export const createGroupSchema = z.object({ participants: z.array(z.string().trim().min(1).max(40)).min(2).max(8), sender_identity_id: z.string().max(180).optional(), subject: z.string().max(200).optional() }).strict();
export const sendGroupSchema = z.object({ conversation_id: z.string().min(1).max(180), text: z.string().max(1600).default(""), image_media_id: z.string().min(1).max(180).optional(), purpose: communicationPurposeSchema.default("customer_care"), scheduled_for: z.string().optional() }).strict().refine(value => value.text.trim() || value.image_media_id, "Text or an image is required.");
export const privateReplySchema = z.object({ reply_to_message_id: z.string().min(1).max(180), text: z.string().max(1600).default(""), image_media_id: z.string().min(1).max(180).optional(), purpose: communicationPurposeSchema.default("customer_care") }).strict().refine(value => value.text.trim() || value.image_media_id, "Text or an image is required.");
export async function readGroup(ctx: PlatformAuthContext, id: string, projectId?: string) {
  const row = await readConversationRecord(ctx.orgId, id);
  if (!smsGroup(row.metadata)) throw badRequest("group_mms_conversation_required", "Choose a group MMS conversation.");
  await requireGroupAccess(ctx, ctx.orgId, row);
  if (projectId && row.project_id !== projectId) throw badRequest("group_mms_project_mismatch", "This group is not attached to the requested project.");
  return row;
}
export function groupProjection(row: Json) {
  const group = smsGroup(row.metadata)!;
  const reason = groupReplyBlockReason(text(group.local_number), (row.participants as Json[]).map(item => item.address));
  return { id: text(row.id), branch_id: text(row.branch_id), project_id: text(row.project_id), subject: text(row.subject), status: text(row.status), local_number: text(group.local_number), read_only: Boolean(reason), reply_block_reason: reason, participants: (row.participants as Json[]).map(item => ({ address: text(item.address), name: text(item.name), contact_id: text(item.contact_id) })), created_at: text(row.created_at), updated_at: text(row.updated_at), last_message_at: text(row.last_message_at) };
}
export async function createSmsGroup(ctx: PlatformAuthContext, input: unknown, projectId?: string) {
  const body = createGroupSchema.parse(input);
  return groupProjection(await createConversation(ctx.orgId, { sms_mode: "group_mms", channel_strategy: "sms", subject: body.subject || "Group MMS", participants: body.participants.map(address => ({ address })), ...(body.sender_identity_id ? { sender: { identity_id: body.sender_identity_id } } : {}), ...(projectId ? { context: { project_id: projectId } } : {}) }, ctx));
}
export async function sendSmsGroup(ctx: PlatformAuthContext, input: unknown, idempotencyKey: string, projectId?: string) {
  const body = sendGroupSchema.parse(input);
  const conversation = await readGroup(ctx, body.conversation_id, projectId);
  await requireGroupAccess(ctx, ctx.orgId, conversation, true);
  assertGroupSendable(conversation);
  const result = await sendCommunication(ctx.orgId, sendCommunicationSchema.parse({ sms_mode: "group_mms", channel: "sms", conversation_id: conversation.id, purpose: body.purpose, content: { text: body.text }, recipients: conversation.participants, sender: { address: smsGroup(conversation.metadata)!.local_number }, context: conversation.context, idempotency_key: idempotencyKey, ...(body.image_media_id ? { metadata: { sms_image: { media_id: body.image_media_id } } } : {}), ...(body.scheduled_for ? { scheduled_for: body.scheduled_for } : {}) }), ctx);
  return { created: result.created, message_id: text(result.message.id), conversation_id: text(conversation.id), status: text(result.message.status) };
}
export async function replySmsGroupPrivately(ctx: PlatformAuthContext, id: string, input: unknown, idempotencyKey: string, projectId?: string) {
  const body = privateReplySchema.parse(input);
  const group = await readGroup(ctx, id, projectId);
  await requireGroupAccess(ctx, ctx.orgId, group, true);
  const original = await readMessageRecord(ctx.orgId, body.reply_to_message_id);
  if (original.conversation_id !== group.id || original.direction !== "inbound" || original.channel !== "sms") throw badRequest("group_mms_private_reply_source", "Choose an incoming message from this group for a private reply.");
  const address = text(object(original.sender).address);
  const participant = (group.participants as Json[]).find(item => item.address === address);
  if (!participant) throw badRequest("group_mms_private_reply_source", "The message sender is not a participant in this group.");
  if (body.image_media_id) await validateSmsImage(ctx.orgId, body.image_media_id, ctx.userId);
  const local = text(smsGroup(group.metadata)!.local_number);
  const context = object(group.context);
  const privateId = `sms_private_${contentHash({ organization: ctx.orgId, branch: ctx.branchId || "default", local, address, project: text(context.project_id) })}`;
  const conversation = await createConversationRecord({ id: privateId, organization_id: ctx.orgId, branch_id: ctx.branchId || "default", channel_strategy: "sms", subject: `Private text with ${text(participant.name) || address}`, participants: [{ address, name: text(participant.name), contact_id: text(participant.contact_id) }], context, created_by_user_id: ctx.userId, metadata: { created_from: "group_private_reply", sms_local_number: local } }, true);
  const privateParticipants = conversation.participants as Json[];
  if (smsGroup(conversation.metadata) || conversation.branch_id !== (ctx.branchId || "default") || privateParticipants.length !== 1 || privateParticipants[0]!.address !== address || object(conversation.metadata).sms_local_number !== local || text(conversation.project_id) !== text(context.project_id)) throw badRequest("group_mms_private_reply_thread", "The private conversation no longer matches this recipient and sending line.");
  // Preserve existing SMS fingerprints while binding private retries to their source and image.
  const result = await sendCommunication(ctx.orgId, sendCommunicationSchema.parse({ channel: "sms", sms_mode: "individual", conversation_id: conversation.id, recipients: privateParticipants, sender: { address: local }, content: { text: body.text }, purpose: body.purpose, context, source: { id: `group_private_reply:${original.id}`, metadata: { image_media_id: body.image_media_id || "" } }, idempotency_key: `group-private:${contentHash({ id, key: idempotencyKey })}`, metadata: { private_reply_to: { conversation_id: id, message_id: original.id }, ...(body.image_media_id ? { sms_image: { media_id: body.image_media_id } } : {}) } }), ctx);
  return { created: result.created, message_id: text(result.message.id), conversation_id: text(conversation.id), status: text(result.message.status), recipient: address, local_number: local };
}
export async function groupPage(ctx: PlatformAuthContext, kind: "conversations" | "messages", args: Json = {}, page: { limit?: number; cursor?: string } = {}, projectId?: string) {
  const limit = Math.max(1, Math.min(200, Number(page.limit || args.limit || 50)));
  await requireGroupAccess(ctx, ctx.orgId, { branch_id: ctx.branchId, context: { project_id: projectId } });
  const conversation = kind === "messages" ? await readGroup(ctx, text(args.conversation_id), projectId) : null;
  const signature = contentHash({ org: ctx.orgId, user: ctx.userId, branch: ctx.branchId || "default", projectId: projectId || "", kind, conversation: conversation?.id || "" });
  let before: Json = {};
  if (page.cursor) {
    try { const parsed = JSON.parse(Buffer.from(page.cursor, "base64url").toString()); if (parsed.signature !== signature || typeof parsed.at !== "string" || typeof parsed.id !== "string") throw Error(); before = { before_at: parsed.at, before_id: parsed.id }; }
    catch { throw badRequest("source_cursor_invalid", "This group-message cursor is invalid."); }
  }
  const rows = kind === "conversations" ? await listConversationRecords(ctx.orgId, { group_mms: true, ...(!manageCalls(ctx) ? { branch_id: ctx.branchId || "default" } : {}), ...(projectId ? { project_id: projectId } : {}), ...before, limit: limit + 1 }) : await listMessageRecords(ctx.orgId, { conversation_id: conversation!.id, ...before, limit: limit + 1 });
  const scanned = rows.slice(0, limit);
  const selected: Json[] = [];
  for (const row of scanned) {
    if (kind === "messages") { selected.push(row); continue; }
    // A project's current branch can differ from the thread's original branch.
    try { await requireGroupAccess(ctx, ctx.orgId, row); selected.push(row); }
    catch (error) { if (!(error instanceof PlatformError) || ![403, 404].includes(error.statusCode)) throw error; }
  }
  const items = kind === "conversations" ? selected.map(groupProjection) : await Promise.all(selected.map(async row => ({ id: text(row.id), conversation_id: text(row.conversation_id), direction: text(row.direction), sender: text(object(row.sender).address), recipients: (row.recipients as Json[]).map(item => text(item.address)), text: text(row.text_body), status: text(row.status), created_at: text(row.created_at), scheduled_for: text(row.scheduled_for), attachments: (Array.isArray(object(row.metadata).media) ? object(row.metadata).media as Json[] : []).map(item => ({ url: text(item.url), content_type: text(item.content_type) })), image_media_id: text(object(object(row.metadata).sms_image).media_id), deliveries: (await listDeliveryRecords(ctx.orgId, text(row.id))).map(item => ({ recipient: text(item.recipient_address), status: text(item.status), sent_at: text(item.sent_at), delivered_at: text(item.delivered_at), failed_at: text(item.failed_at) })) })));
  const last = scanned.at(-1);
  return { items, ...(rows.length > limit && last ? { nextCursor: Buffer.from(JSON.stringify({ signature, at: text(kind === "conversations" ? last.last_message_at || last.updated_at : last.created_at), id: last.id })).toString("base64url") } : {}) };
}
