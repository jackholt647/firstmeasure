import { registerDataProvider } from "../platform/publication/providers.js";
import { registerAction } from "../platform/publication/actions.js";
import { backendImplementationDigest } from "../platform/publication/implementation.js";
import type { AccessPolicy, JsonSchema, PublicationContext, TargetRef } from "../platform/publication/contracts.js";
import { badRequest, forbidden } from "../platform/errors.js";
import { requireGroupAccess } from "./group_access.js";
import { createSmsGroup, groupPage, readGroup, sendSmsGroup, sendGroupSchema } from "./group_service.js";
import { communicationPurposeSchema } from "./schemas.js";

const string = { type: "string" };
const object = (properties: Record<string, unknown>): JsonSchema => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
const groupSchema = object({ id: string, branch_id: string, project_id: string, subject: string, status: string, local_number: string, participants: { type: "array", minItems: 2, maxItems: 8, items: object({ address: string, name: string, contact_id: string }) }, created_at: string, updated_at: string, last_message_at: string });
const messageSchema = object({ id: string, conversation_id: string, direction: { enum: ["inbound", "outbound"] }, sender: string, recipients: { type: "array", items: string }, text: string, status: string, created_at: string, scheduled_for: string, image_media_id: string, attachments: { type: "array", items: object({ url: string, content_type: string }) }, deliveries: { type: "array", items: object({ recipient: string, status: string, sent_at: string, delivered_at: string, failed_at: string }) } });
function user(ctx: PublicationContext) { if (!ctx.auth) throw forbidden("group_mms_user_required", "Group MMS requires an authenticated user."); return ctx.auth; }
async function authorize(ctx: PublicationContext, target: TargetRef) {
  await requireGroupAccess(user(ctx), ctx.organizationId, { branch_id: target.branchId || ctx.branchId, context: { project_id: target.projectId } });
}
const access: AccessPolicy = { scopes: ["organization", "project"], permissions: ["view_comms"], capabilities: ["apps.comms", "comms.sms"], systemKinds: [], authorize };
let registered = false;
export function registerGroupMmsPublication() {
  if (registered) return;
  registered = true;
  registerDataProvider({ id: "comms-sms-groups", version: "1", apps: ["comms"], exports: Object.fromEntries((["conversations", "messages"] as const).map(kind => [kind, {
    description: kind === "conversations" ? "Authorized group MMS threads and their complete participant lists." : "Group MMS history, image attachments and per-recipient delivery states, without private provider responses or consent evidence.",
    schema: { type: "array", items: kind === "conversations" ? groupSchema : messageSchema }, schemaVersion: "1", access,
    argsSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 200 }, ...(kind === "messages" ? { conversation_id: { type: "string", minLength: 1, maxLength: 180 } } : {}) }, ...(kind === "messages" ? { required: ["conversation_id"] } : {}), additionalProperties: false },
    authorizeRef: async (ctx, ref) => { if (kind === "messages") await readGroup(user(ctx), String(ref.args?.conversation_id || ""), ref.target.projectId); },
    authorizeSnapshot: async (ctx, ref, result) => {
      if (result.provenance.viewerUserId !== user(ctx).userId || !Array.isArray(result.provenance.conversationIds)) throw forbidden("snapshot_viewer_denied", "This snapshot is unavailable to this viewer.");
      for (const id of result.provenance.conversationIds) await readGroup(user(ctx), String(id), ref.target.projectId);
    },
    read: async (ctx, ref) => { const page = await groupPage(user(ctx), kind, ref.args, {}, ref.target.projectId); return { value: page.items, provenance: { viewerUserId: user(ctx).userId, conversationIds: [...new Set(page.items.map(item => "conversation_id" in item ? item.conversation_id : item.id))] } }; },
    list: async (ctx, ref, page) => groupPage(user(ctx), kind, ref.args, page, ref.target.projectId)
  }])) });
  const policy: AccessPolicy = { ...access, permissions: ["send_communications"], authorize: async (ctx, target) => { await authorize(ctx, target); await requireGroupAccess(user(ctx), ctx.organizationId, { branch_id: target.branchId || ctx.branchId, context: { project_id: target.projectId } }, true); } };
  registerAction({ id: "comms.smsGroup.create", version: "1", implementation: backendImplementationDigest(), domain: "comms", description: "Create or reuse a group MMS thread for a configured sending line and 2-8 US/Canadian local recipients. This does not grant messaging consent.", inputSchema: { type: "object", required: ["participants"], properties: { participants: { type: "array", minItems: 2, maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 40 } }, sender_identity_id: { type: "string", maxLength: 180 }, subject: { type: "string", maxLength: 200 } }, additionalProperties: false }, outputSchema: groupSchema, policy, effect: "write", executionKinds: ["api", "agent", "module", "work"], idempotency: "required", execute: (ctx, target, input) => createSmsGroup(user(ctx), input, target.projectId) });
  registerAction({ id: "comms.smsGroup.send", version: "1", implementation: backendImplementationDigest(), domain: "comms", description: "Send or schedule one true group MMS to every member of target.id, with consent, billing and development delivery checks. Uncertain submissions are not automatically resent.", inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 1600 }, image_media_id: { type: "string", minLength: 1, maxLength: 180 }, purpose: { enum: communicationPurposeSchema.options }, scheduled_for: { type: "string", maxLength: 80 } }, anyOf: [{ required: ["text"], properties: { text: { type: "string", minLength: 1, pattern: "\\S" } } }, { required: ["image_media_id"] }], additionalProperties: false }, outputSchema: object({ created: { type: "boolean" }, message_id: string, conversation_id: string, status: string }), policy: { ...policy, authorize: async (ctx, target) => { await policy.authorize!(ctx, target); if (!target.id) throw badRequest("group_mms_conversation_required", "Set target.id to a group conversation."); const row = await readGroup(user(ctx), target.id, target.projectId); await requireGroupAccess(user(ctx), ctx.organizationId, row, true); } }, effect: "external", executionKinds: ["api", "agent", "module", "work"], idempotency: "required", validateInput: input => { sendGroupSchema.parse({ ...input, conversation_id: "validated-at-target" }); }, execute: (ctx, target, input, execution) => sendSmsGroup(user(ctx), { ...input, conversation_id: target.id }, execution.receiptId, target.projectId) });
}
