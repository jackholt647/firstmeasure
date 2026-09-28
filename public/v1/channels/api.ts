import { platformBackgroundAllowed } from "../platform/runtime.js";
import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError, badRequest } from "../platform/errors.js";
import { readDocument, storeMediaUpload, upsertDocument } from "../platform/storage.js";
import {
  addMembersSchema,
  attentionPatchSchema,
  collaborationPreferencesSchema,
  createActionItemFromMessageSchema,
  createChannelSchema,
  createHuddleSchema,
  draftSchema,
  editMessageSchema,
  folderSchema,
  huddleRecordingSchema,
  huddleMediaStateSchema,
  huddleSignalSchema,
  listMessagesQuerySchema,
  messageReminderSchema,
  memberPatchSchema,
  postMessageSchema,
  reactionSchema,
  readStateSchema,
  resourceRefSchema,
  scheduledMessageSchema,
  scheduledMessagePatchSchema,
  searchQuerySchema,
  sidebarSectionSchema,
  tabSchema,
  threadSubscriptionSchema,
  unreadStateSchema,
  updateChannelSchema
} from "./schemas.js";
import * as service from "./service.js";
import * as collaboration from "./collaboration.js";
import { startChannelAgentScheduler } from "./agent.js";
import { createAttachmentRecord } from "./storage.js";

const APP_CAPABILITY = "apps.channels";

function getParam(params: unknown, key: string) {
  const value = params && typeof params === "object" ? (params as Record<string, unknown>)[key] : "";
  return String(value ?? "").trim();
}

export const registerChannelsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ ok: false, error: "validation_error", issues: error.issues });
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    app.log.error(error);
    return reply.code(500).send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({ ok: true, api: "channels" }));

  if (platformBackgroundAllowed()) {
  const scheduledDeliveryTimer = setInterval(async () => {
    try { (await service.deliverAllDueScheduledMessages()); } catch (error) { app.log.error(error); }
  }, 15_000);
  scheduledDeliveryTimer.unref();
  app.addHook("onClose", async () => clearInterval(scheduledDeliveryTimer));
  }

  // Both management and field users participate in team messaging.
  const AUTH_APPLICATIONS = ["management", "field"];

  function auth(request: Parameters<typeof requirePlatformAuth>[0], orgId: string, options: { csrf?: boolean; permission?: string; capability?: string } = {}) {
    return requirePlatformAuth(request, {
      orgId,
      capability: options.capability || APP_CAPABILITY,
      application: AUTH_APPLICATIONS,
      csrf: options.csrf,
      permission: options.permission
    });
  }

  // --- channels ---------------------------------------------------------------

  app.get("/organizations/:orgId/directory", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const users = await service.listDirectoryUsers(ctx);
    return { ok: true, users, count: users.length };
  });

  app.get("/organizations/:orgId/channels", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const includeArchived = ["1", "true"].includes(String(query.include_archived ?? ""));
    const channels = await service.listChannelsForUser(ctx, { includeArchived });
    return { ok: true, channels, count: channels.length };
  });

  app.post("/organizations/:orgId/channels", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const body = createChannelSchema.parse(request.body ?? {});
    const channel = await service.createChannel(ctx, body);
    reply.code(201);
    return { ok: true, channel };
  });

  app.post("/organizations/:orgId/channels/project/:projectId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const channel = await service.ensureProjectChannel(ctx, getParam(request.params, "projectId"));
    return { ok: true, channel };
  });

  app.get("/organizations/:orgId/channels/:channelId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const channel = await service.getChannel(ctx, getParam(request.params, "channelId"));
    return { ok: true, channel };
  });

  app.patch("/organizations/:orgId/channels/:channelId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const body = updateChannelSchema.parse(request.body ?? {});
    const channel = await service.updateChannel(ctx, getParam(request.params, "channelId"), body);
    return { ok: true, channel };
  });

  app.post("/organizations/:orgId/channels/:channelId/archive", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const channel = await service.setChannelArchived(ctx, getParam(request.params, "channelId"), true);
    return { ok: true, channel };
  });

  app.post("/organizations/:orgId/channels/:channelId/unarchive", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const channel = await service.setChannelArchived(ctx, getParam(request.params, "channelId"), false);
    return { ok: true, channel };
  });

  // --- members ----------------------------------------------------------------

  app.post("/organizations/:orgId/channels/:channelId/members", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const body = addMembersSchema.parse(request.body ?? {});
    const channel = await service.addChannelMembers(ctx, getParam(request.params, "channelId"), body.user_ids);
    return { ok: true, channel };
  });

  app.patch("/organizations/:orgId/channels/:channelId/members/:userId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const body = memberPatchSchema.parse(request.body ?? {});
    const channelId = getParam(request.params, "channelId");
    const userId = getParam(request.params, "userId");
    if (body.notify_level && userId === ctx.userId) {
      const { readChannelMember, setMemberNotifyLevel, upsertChannelMember } = await import("./storage.js");
      const { channel } = await service.requireChannelAccess(ctx, channelId);
      if (!(await readChannelMember(channelId, userId))) {
        (await upsertChannelMember({ channel_id: channelId, organization_id: orgId, user_id: userId, role: "member", notify_level: body.notify_level }));
      }
      (await setMemberNotifyLevel(channelId, userId, body.notify_level));
      return { ok: true, notify_level: body.notify_level, channel_type: channel.type };
    }
    throw badRequest("unsupported_member_patch", "Only your own notification level can be changed here.");
  });

  app.delete("/organizations/:orgId/channels/:channelId/members/:userId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    return service.removeMember(ctx, getParam(request.params, "channelId"), getParam(request.params, "userId"));
  });

  // --- messages ---------------------------------------------------------------

  app.get("/organizations/:orgId/channels/:channelId/messages", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const query = listMessagesQuerySchema.parse(request.query ?? {});
    const result = await service.listMessages(ctx, getParam(request.params, "channelId"), query);
    return { ok: true, ...result };
  });

  // --- personal message inbox (topbar Messages dropdown) --------------------

  app.get("/organizations/:orgId/inbox", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    return { ok: true, ...(await service.personalInbox(ctx, { limit: Number(query.limit) || undefined })) };
  });

  app.post("/organizations/:orgId/inbox/seen", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    return { ok: true, ...(await service.markPersonalInboxSeen(ctx)) };
  });

  app.get("/organizations/:orgId/preferences", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    return { ok: true, preferences: await service.translationPreferences(ctx) };
  });

  app.post("/organizations/:orgId/channels/:channelId/messages", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const body = postMessageSchema.parse(request.body ?? {});
    const result = await service.postMessage(ctx, getParam(request.params, "channelId"), body);
    reply.code(result.deduplicated ? 200 : 201);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/messages/:messageId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const result = await service.listThread(ctx, getParam(request.params, "messageId"), { limit: 1 });
    return { ok: true, message: result.root };
  });

  app.post("/organizations/:orgId/messages/:messageId/translation", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const translation = await service.translateMessage(ctx, getParam(request.params, "messageId"));
    return { ok: true, translation };
  });

  app.patch("/organizations/:orgId/messages/:messageId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const body = editMessageSchema.parse(request.body ?? {});
    const message = await service.editMessage(ctx, getParam(request.params, "messageId"), body);
    return { ok: true, message };
  });

  app.delete("/organizations/:orgId/messages/:messageId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const message = await service.deleteMessage(ctx, getParam(request.params, "messageId"));
    return { ok: true, message };
  });

  app.post("/organizations/:orgId/messages/:messageId/restore", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const message = await service.restoreMessage(ctx, getParam(request.params, "messageId"));
    return { ok: true, message };
  });

  app.get("/organizations/:orgId/messages/:messageId/revisions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const result = await service.messageRevisions(ctx, getParam(request.params, "messageId"));
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/messages/:messageId/thread", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const query = listMessagesQuerySchema.parse(request.query ?? {});
    const result = await service.listThread(ctx, getParam(request.params, "messageId"), query);
    return { ok: true, ...result };
  });

  app.put("/organizations/:orgId/messages/:messageId/reactions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const body = reactionSchema.parse(request.body ?? {});
    const message = await service.toggleReaction(ctx, getParam(request.params, "messageId"), body.emoji, body.on);
    return { ok: true, message };
  });

  app.post("/organizations/:orgId/messages/:messageId/pin", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const message = await service.setPinned(ctx, getParam(request.params, "messageId"), true);
    return { ok: true, message };
  });

  app.post("/organizations/:orgId/messages/:messageId/unpin", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const message = await service.setPinned(ctx, getParam(request.params, "messageId"), false);
    return { ok: true, message };
  });

  app.get("/organizations/:orgId/channels/:channelId/pins", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const messages = await service.pinnedMessages(ctx, getParam(request.params, "channelId"));
    return { ok: true, messages };
  });

  // --- saved ------------------------------------------------------------------

  app.get("/organizations/:orgId/saved", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const messages = await service.savedMessages(ctx);
    return { ok: true, messages };
  });

  app.put("/organizations/:orgId/saved/:messageId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    return service.setSaved(ctx, getParam(request.params, "messageId"), true);
  });

  app.delete("/organizations/:orgId/saved/:messageId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    return service.setSaved(ctx, getParam(request.params, "messageId"), false);
  });

  // --- read state / typing ----------------------------------------------------

  app.post("/organizations/:orgId/channels/:channelId/read", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    const body = readStateSchema.parse(request.body ?? {});
    return service.markRead(ctx, getParam(request.params, "channelId"), body.last_read_seq);
  });

  app.get("/organizations/:orgId/unreads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const result = await service.unreads(ctx);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/unreads/messages", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.attention_v2" });
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    return { ok: true, ...(await service.allUnreadMessages(ctx, { limit: Number(query.limit) || undefined })) };
  });

  app.post("/organizations/:orgId/channels/:channelId/unread", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.attention_v2" });
    const body = unreadStateSchema.parse(request.body ?? {});
    return service.markUnread(ctx, getParam(request.params, "channelId"), body.seq);
  });

  app.post("/organizations/:orgId/read-all", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.attention_v2" });
    return service.markAllRead(ctx);
  });

  app.post("/organizations/:orgId/read-operations/:operationId/undo", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.attention_v2" });
    return service.undoRead(ctx, getParam(request.params, "operationId"));
  });

  app.get("/organizations/:orgId/activity", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.attention_v2" });
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    return {
      ok: true,
      ...(await service.activity(ctx, {
        kind: getParam(query, "kind") || undefined,
        unreadOnly: ["1", "true"].includes(getParam(query, "unread_only")),
        limit: Number(query.limit) || undefined
      }))
    };
  });

  app.patch("/organizations/:orgId/activity/:itemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.attention_v2" });
    const body = attentionPatchSchema.parse(request.body ?? {});
    return { ok: true, item: await service.updateActivity(ctx, getParam(request.params, "itemId"), body) };
  });

  app.post("/organizations/:orgId/activity/read-all", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.attention_v2" });
    return { ok: true, ...(await service.markAllActivityRead(ctx)) };
  });

  app.get("/organizations/:orgId/threads", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.attention_v2" });
    const threads = await service.followedThreads(ctx);
    return { ok: true, threads, count: threads.length };
  });

  app.put("/organizations/:orgId/threads/:rootMessageId/subscription", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.attention_v2" });
    const body = threadSubscriptionSchema.parse(request.body ?? {});
    return {
      ok: true,
      subscription: await service.setThreadSubscription(
        ctx,
        getParam(request.params, "rootMessageId"),
        body.following,
        body.notify_level
      )
    };
  });

  app.post("/organizations/:orgId/threads/:rootMessageId/read", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.attention_v2" });
    const body = request.body && typeof request.body === "object" ? request.body as Record<string, unknown> : {};
    return {
      ok: true,
      subscription: await service.markThreadRead(
        ctx,
        getParam(request.params, "rootMessageId"),
        Math.max(0, Number(body.last_reply_seq) || 0)
      )
    };
  });

  app.get("/organizations/:orgId/collaboration-preferences", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.attention_v2" });
    return { ok: true, preferences: (await service.collaborationPreferences(ctx)) };
  });

  app.patch("/organizations/:orgId/collaboration-preferences", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.attention_v2" });
    const body = collaborationPreferencesSchema.parse(request.body ?? {});
    return { ok: true, preferences: (await service.saveCollaborationPreferences(ctx, body)) };
  });

  app.get("/organizations/:orgId/drafts/:draftKey", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.rich_messages" });
    return { ok: true, draft: (await collaboration.readDraftRecord(orgId, ctx.userId, getParam(request.params, "draftKey"))) };
  });

  app.put("/organizations/:orgId/drafts/:draftKey", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.rich_messages" });
    const body = draftSchema.parse(request.body ?? {});
    await service.requireChannelAccess(ctx, body.channel_id, { write: true });
    return { ok: true, draft: (await collaboration.saveDraftRecord(orgId, ctx.userId, getParam(request.params, "draftKey"), body)) };
  });

  app.delete("/organizations/:orgId/drafts/:draftKey", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.rich_messages" });
    return { ok: true, ...(await collaboration.deleteDraftRecord(orgId, ctx.userId, getParam(request.params, "draftKey"))) };
  });

  app.get("/organizations/:orgId/scheduled-messages", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.rich_messages" });
    await service.deliverDueScheduledMessages(ctx);
    const messages = (await collaboration.listScheduledRecords(orgId, ctx.userId));
    return { ok: true, scheduled_messages: messages, count: messages.length };
  });

  app.post("/organizations/:orgId/scheduled-messages", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.rich_messages" });
    const body = scheduledMessageSchema.parse(request.body ?? {});
    await service.requireChannelAccess(ctx, body.channel_id, { write: true });
    const scheduled = (await collaboration.createScheduledRecord(orgId, ctx.userId, body));
    reply.code(201);
    return { ok: true, scheduled_message: scheduled };
  });

  app.patch("/organizations/:orgId/scheduled-messages/:scheduledId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.rich_messages" });
    const body = scheduledMessagePatchSchema.parse(request.body ?? {});
    return {
      ok: true,
      scheduled_message: (await collaboration.updateScheduledRecord(orgId, ctx.userId, getParam(request.params, "scheduledId"), body))
    };
  });

  app.delete("/organizations/:orgId/scheduled-messages/:scheduledId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.rich_messages" });
    return { ok: true, ...(await collaboration.cancelScheduledRecord(orgId, ctx.userId, getParam(request.params, "scheduledId"))) };
  });

  app.get("/organizations/:orgId/reminders", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.rich_messages" });
    const reminders = await service.messageReminders(ctx);
    return { ok: true, reminders, count: reminders.length };
  });

  app.post("/organizations/:orgId/messages/:messageId/reminders", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.rich_messages" });
    const body = messageReminderSchema.parse(request.body ?? {});
    const reminder = await service.saveMessageReminder(ctx, getParam(request.params, "messageId"), body.remind_at);
    reply.code(201);
    return { ok: true, reminder };
  });

  app.delete("/organizations/:orgId/reminders/:reminderId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.rich_messages" });
    return { ok: true, ...(await service.removeMessageReminder(ctx, getParam(request.params, "reminderId"))) };
  });

  app.post("/organizations/:orgId/messages/:messageId/action-items", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.resources" });
    const body = createActionItemFromMessageSchema.parse(request.body ?? {});
    const result = await service.createActionItemFromMessage(ctx, getParam(request.params, "messageId"), body);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/channels/:channelId/tabs", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.resources" });
    return { ok: true, tabs: await service.listChannelTabs(ctx, getParam(request.params, "channelId")) };
  });

  app.post("/organizations/:orgId/channels/:channelId/tabs", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.resources" });
    const tab = await service.createChannelTab(ctx, getParam(request.params, "channelId"), tabSchema.parse(request.body ?? {}));
    reply.code(201);
    return { ok: true, tab };
  });

  app.patch("/organizations/:orgId/channels/:channelId/tabs/:tabId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.resources" });
    const tab = await service.updateChannelTab(ctx, getParam(request.params, "channelId"), getParam(request.params, "tabId"), tabSchema.partial().parse(request.body ?? {}));
    return { ok: true, tab };
  });

  app.delete("/organizations/:orgId/channels/:channelId/tabs/:tabId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.resources" });
    return { ok: true, ...(await service.deleteChannelTab(ctx, getParam(request.params, "channelId"), getParam(request.params, "tabId"))) };
  });

  app.get("/organizations/:orgId/channels/:channelId/folders", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.resources" });
    return { ok: true, folders: await service.listChannelFolders(ctx, getParam(request.params, "channelId")) };
  });

  app.post("/organizations/:orgId/channels/:channelId/folders", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.resources" });
    const folder = await service.createChannelFolder(ctx, getParam(request.params, "channelId"), folderSchema.parse(request.body ?? {}));
    reply.code(201);
    return { ok: true, folder };
  });

  app.patch("/organizations/:orgId/channels/:channelId/folders/:folderId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.resources" });
    const folder = await service.updateChannelFolder(ctx, getParam(request.params, "channelId"), getParam(request.params, "folderId"), folderSchema.partial().parse(request.body ?? {}));
    return { ok: true, folder };
  });

  app.delete("/organizations/:orgId/channels/:channelId/folders/:folderId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.resources" });
    return { ok: true, ...(await service.deleteChannelFolder(ctx, getParam(request.params, "channelId"), getParam(request.params, "folderId"))) };
  });

  app.get("/organizations/:orgId/channels/:channelId/resources", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.resources" });
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const resources = await service.listChannelResources(ctx, getParam(request.params, "channelId"), {
      type: getParam(query, "type") || undefined,
      folderId: getParam(query, "folder_id") || undefined
    });
    return { ok: true, resources, count: resources.length };
  });

  app.post("/organizations/:orgId/channels/:channelId/resources", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.resources" });
    const resource = await service.createChannelResource(ctx, getParam(request.params, "channelId"), resourceRefSchema.parse(request.body ?? {}));
    reply.code(201);
    return { ok: true, resource };
  });

  app.delete("/organizations/:orgId/channels/:channelId/resources/:refId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.resources" });
    return { ok: true, ...(await service.deleteChannelResource(ctx, getParam(request.params, "channelId"), getParam(request.params, "refId"))) };
  });

  app.get("/organizations/:orgId/sidebar-sections", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.attention_v2" });
    return { ok: true, sections: (await service.sidebarSections(ctx)) };
  });

  app.put("/organizations/:orgId/sidebar-sections/:sectionId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.attention_v2" });
    const body = sidebarSectionSchema.parse({ ...(request.body as Record<string, unknown> ?? {}), id: getParam(request.params, "sectionId") });
    return { ok: true, section: (await service.saveSidebarSection(ctx, body)) };
  });

  app.delete("/organizations/:orgId/sidebar-sections/:sectionId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.attention_v2" });
    return { ok: true, ...(await service.deleteSidebarSection(ctx, getParam(request.params, "sectionId"))) };
  });

  app.post("/organizations/:orgId/channels/:channelId/huddles", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.huddles" });
    const huddle = await service.createHuddle(ctx, getParam(request.params, "channelId"), createHuddleSchema.parse(request.body ?? {}));
    reply.code(201);
    return { ok: true, huddle };
  });

  app.get("/organizations/:orgId/huddles/:huddleId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.huddles" });
    return { ok: true, huddle: await service.getHuddle(ctx, getParam(request.params, "huddleId")) };
  });

  app.post("/organizations/:orgId/huddles/:huddleId/join", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.huddles" });
    return { ok: true, huddle: await service.joinHuddle(ctx, getParam(request.params, "huddleId")) };
  });

  app.post("/organizations/:orgId/huddles/:huddleId/leave", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.huddles" });
    return { ok: true, huddle: await service.leaveHuddle(ctx, getParam(request.params, "huddleId")) };
  });

  app.patch("/organizations/:orgId/huddles/:huddleId/media-state", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.huddles" });
    return {
      ok: true,
      huddle: await service.updateHuddleMediaState(
        ctx,
        getParam(request.params, "huddleId"),
        huddleMediaStateSchema.parse(request.body ?? {})
      )
    };
  });

  app.post("/organizations/:orgId/huddles/:huddleId/end", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.huddles" });
    return { ok: true, huddle: await service.endHuddle(ctx, getParam(request.params, "huddleId")) };
  });

  app.delete("/organizations/:orgId/huddles/:huddleId/participants/:userId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf:true, capability:"channels.huddles" });
    return { ok:true, huddle:await service.removeHuddleParticipant(ctx, getParam(request.params, "huddleId"), getParam(request.params, "userId")) };
  });

  app.post("/organizations/:orgId/huddles/:huddleId/recording", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.recording" });
    const body = huddleRecordingSchema.parse(request.body ?? {});
    const result = await service.saveHuddleRecording(ctx, getParam(request.params, "huddleId"), body.attachment_id);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/huddles/:huddleId/signals", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { capability: "channels.huddles" });
    const query = request.query && typeof request.query === "object" ? request.query as Record<string, unknown> : {};
    const signals = await service.listHuddleSignals(
      ctx,
      getParam(request.params, "huddleId"),
      Math.max(0, Number(query.after) || 0),
      getParam(query, "peer_id")
    );
    return { ok: true, signals, cursor: signals.length ? Number(signals.at(-1)?.seq || 0) : Math.max(0, Number(query.after) || 0) };
  });

  app.post("/organizations/:orgId/huddles/:huddleId/signals", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true, capability: "channels.huddles" });
    const signal = await service.postHuddleSignal(ctx, getParam(request.params, "huddleId"), huddleSignalSchema.parse(request.body ?? {}));
    reply.code(201);
    return { ok: true, signal };
  });

  app.post("/organizations/:orgId/channels/:channelId/typing", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });
    return service.noteTyping(ctx, getParam(request.params, "channelId"));
  });

  // --- search -----------------------------------------------------------------

  app.get("/organizations/:orgId/search", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId);
    const query = searchQuerySchema.parse(request.query ?? {});
    const messages = await service.searchMessages(ctx, query.q, { channelId: query.channel_id, limit: query.limit });
    return { ok: true, messages, count: messages.length };
  });

  // --- uploads ----------------------------------------------------------------

  app.post("/organizations/:orgId/uploads", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await auth(request, orgId, { csrf: true });

    const typed = request as unknown as {
      parts?: () => AsyncIterable<{
        type: "file" | "field";
        fieldname: string;
        value?: unknown;
        filename?: string;
        mimetype?: string;
        toBuffer?: () => Promise<Buffer>;
      }>;
    };
    const parts = typed.parts?.();
    if (!parts) throw badRequest("multipart_required", "Attachment uploads must be multipart/form-data.");

    let bytes: Buffer | null = null;
    let fileName = "upload";
    let contentType = "application/octet-stream";
    let channelId = "";
    for await (const part of parts) {
      if (part.type === "file") {
        const buffer = await part.toBuffer?.();
        if (buffer?.length) {
          bytes = buffer;
          fileName = String(part.filename || "upload");
          contentType = String(part.mimetype || "application/octet-stream");
        }
        continue;
      }
      if (part.fieldname === "channel_id") channelId = String(part.value ?? "").trim();
    }
    if (!bytes) throw badRequest("missing_file", "A file field is required.");
    const channelAccess = channelId ? await service.requireChannelAccess(ctx, channelId, { write: true }) : null;
    const projectId = channelAccess?.channel.project_id || "";

    const media = await storeMediaUpload(orgId, {
      ownerType: projectId ? "project" : "channel",
      ownerId: projectId || channelId || orgId,
      slot: projectId ? "photos" : "attachment",
      collection: projectId ? "projects" : undefined,
      scope: projectId ? "projects" : undefined,
      fileName,
      contentType,
      bytes,
      metadata: {
        uploaded_by: ctx.userId,
        source: channelAccess?.channel.type === "project" ? "project_notes" : "channels",
        channel_id: channelId || null,
        project_id: projectId || null
      }
    });
    const mediaRecord = media as Record<string, unknown>;
    const mediaId = String(mediaRecord.id ?? "");
    if (projectId && (contentType.startsWith("image/") || contentType.startsWith("video/"))) {
      const projectDocument = await readDocument(orgId, "projects", projectId);
      const projectData = projectDocument.data && typeof projectDocument.data === "object"
        ? projectDocument.data as Record<string, unknown>
        : {};
      const currentPhotos = Array.isArray(projectData.photos) ? projectData.photos : [];
      if (!currentPhotos.some((item) => item && typeof item === "object" && String((item as Record<string, unknown>).media_id ?? (item as Record<string, unknown>).id ?? "") === mediaId)) {
        const mediaType = contentType.startsWith("video/") ? "video" : "image";
        await upsertDocument(orgId, "projects", {
          id: projectId,
          data: {
            photos: [
              ...currentPhotos,
              {
                kind: "media_reference",
                id: mediaId,
                media_id: mediaId,
                field: "photos",
                variant: "original",
                media_type: mediaType,
                mime_type: contentType,
                file_name: fileName,
                label: fileName,
                alt: fileName,
                owner: { type: "project", id: projectId, slot: "photos" },
                metadata: {
                  source: "project_note_upload",
                  channel_id: channelId,
                  uploaded_by: ctx.userId
                }
              }
            ]
          },
          metadata: { source: "project_note_upload" }
        });
      }
    }
    const attachment = (await createAttachmentRecord({
      organization_id: orgId,
      channel_id: channelId || null,
      media_id: mediaId,
      file_name: fileName,
      content_type: contentType,
      size_bytes: bytes.length,
      uploaded_by: ctx.userId
    }));
    reply.code(201);
    return { ok: true, attachment };
  });

  // Follow-up sweeps for agents waiting on DM replies (nudge → expire).
  (await startChannelAgentScheduler());
};
