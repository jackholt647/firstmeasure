import { createHmac, timingSafeEqual } from "node:crypto";

import {
  createConversationRecord,
  createMessageRecord,
  readConversationRecord,
  touchConversationForMessage
} from "../messaging/communications_storage.js";
import type { PlatformAuthContext } from "../platform/auth.js";
import { badRequest, conflict, forbidden, notFound } from "../platform/errors.js";
import {
  readBranchModule,
  readDocument,
  readGlobal,
  saveBranchModule
} from "../platform/storage.js";
import { env } from "../src/config/env.js";
import { registerWorkEvents } from "../work/events.js";
import {
  createConversationState,
  createVisitor,
  ensureWidgetKey,
  findVisitorByTokenHash,
  findVisitorsByIpHash,
  findWidgetKey,
  generateVisitorToken,
  getChatDatabase,
  lastGlobalPresence,
  listConversationStatesForVisitor,
  listFreshPresence,
  listInboxConversations,
  listMessagesAfter,
  messageCursor,
  readConversationState,
  readVisitor,
  rotateWidgetKey,
  sha256Hex,
  updateConversationState,
  updateVisitor,
  upsertPresence,
  upsertReadState,
  type ChatJson
} from "./storage.js";

export const CHAT_MODULE_ID = "live_chat";
export const PRESENCE_FRESH_MS = 45_000;
const DISCONNECT_RELEASE_MS = 90_000;
// Long enough that a 2.5–3s poll cadence reliably lands inside the window
// while the other side is still composing; clients re-signal every 3s.
const TYPING_TTL_MS = 8_000;

registerWorkEvents([
  { name: "chat.conversation.started", description: "A website or portal visitor started a live chat conversation.", visibility: "activity" },
  { name: "chat.message.received", description: "A live chat visitor sent a message.", visibility: "system" },
  { name: "chat.message.sent", description: "A team member or the AI agent replied in a live chat.", visibility: "system" },
  { name: "chat.conversation.claimed", description: "A team member claimed a live chat conversation.", visibility: "system" },
  { name: "chat.conversation.released", description: "A live chat claim was released.", visibility: "system" },
  { name: "chat.conversation.claim_taken", description: "A live chat conversation was taken over from another team member.", visibility: "system" },
  { name: "chat.ai.replied", description: "The live chat AI agent replied to a visitor.", visibility: "system" },
  { name: "chat.ai.handoff", description: "The live chat AI agent handed a conversation to the team.", visibility: "activity" },
  { name: "chat.offline.message", description: "A visitor left a message while live chat was offline.", visibility: "activity" },
  { name: "chat.conversation.linked", description: "A live chat conversation was linked to a contact or project.", visibility: "activity" },
  { name: "chat.conversation.closed", description: "A live chat conversation was closed.", visibility: "activity" }
]);

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
}

function asObject(value: unknown): ChatJson {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ChatJson : {};
}

function nowIso() {
  return new Date().toISOString();
}

function isoPlus(ms: number, from = Date.now()) {
  return new Date(from + ms).toISOString();
}

function isFresh(timestamp: unknown, windowMs: number) {
  const value = cleanText(timestamp);
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && Date.now() - parsed <= windowMs;
}

// --- Settings --------------------------------------------------------------

const CHAT_FONT_FAMILIES = new Set(["Inter", "Montserrat", "Roboto", "Open Sans", "Lato", "Poppins", "Source Sans 3"]);

function chatFontFamily(value: unknown) {
  const font = cleanText(value);
  return CHAT_FONT_FAMILIES.has(font) ? font : "Inter";
}

async function chatAppearanceDefaults(orgId: string, branchId: string): Promise<ChatJson> {
  const [globalDoc, branchDoc, styleModule] = await Promise.all([
    readGlobal(orgId).catch(() => null),
    readDocument(orgId, "branch", branchId).catch(() => null),
    readBranchModule(orgId, branchId, "presentation_style").catch(() => null)
  ]);
  const globalBranding = asObject(asObject(globalDoc?.data).branding);
  const branchBranding = asObject(asObject(branchDoc?.data).branding);
  const styleData = asObject(styleModule?.data);
  const styleBranding = asObject(styleData.branding);
  const branding: ChatJson = {
    ...globalBranding,
    ...branchBranding,
    ...styleBranding,
    colors: {
      ...asObject(globalBranding.colors),
      ...asObject(branchBranding.colors),
      ...asObject(styleBranding.colors)
    },
    typography: {
      ...asObject(globalBranding.typography),
      ...asObject(branchBranding.typography),
      ...asObject(styleBranding.typography)
    }
  };
  const colors = asObject(branding.colors);
  const typography = asObject(branding.typography);
  const proposalDefaults = asObject(styleData.proposal_defaults);
  return {
    primary_color: cleanText(colors.primary || branding.primary || colors.accent || branding.accent) || "#1f6feb",
    font_family: chatFontFamily(
      typography.primary_font_family
      || typography.font_family
      || proposalDefaults.font_family
      || styleData.proposal_font_family
      || styleData.font_family
    )
  };
}

export function defaultChatSettings(appearanceDefaults: ChatJson = {}): ChatJson {
  return {
    schema_version: 1,
    enabled: false,
    website: { enabled: true },
    portal: { enabled: true },
    appearance: {
      primary_color: cleanText(appearanceDefaults.primary_color) || "#1f6feb",
      background_color: "#ffffff",
      text_color: "#111827",
      font_family: chatFontFamily(appearanceDefaults.font_family),
      position: "bottom_right",
      launcher_label: "Chat with us",
      show_branding: true
    },
    copy: {
      greeting: "Hi there! How can we help?",
      offline_message: "We're offline right now — leave a message and we'll get back to you.",
      team_display: "first_name",
      team_name: "Support"
    },
    pre_chat: { require_name: false, require_email: false, require_phone: false },
    live_hours: {
      timezone: "America/Chicago",
      days: {
        mon: [{ start: "08:00", end: "17:00" }],
        tue: [{ start: "08:00", end: "17:00" }],
        wed: [{ start: "08:00", end: "17:00" }],
        thu: [{ start: "08:00", end: "17:00" }],
        fri: [{ start: "08:00", end: "17:00" }],
        sat: [],
        sun: []
      }
    },
    presence: { require_agent_presence: false, force_status: "auto" },
    mode: "human",
    claiming: {
      mode: "presence",
      auto_claim_on_reply: true,
      allow_takeover: true,
      idle_release_minutes: 10,
      release_on_disconnect: true
    },
    notifications: {
      route: { kind: "all" },
      debounce_seconds: 120,
      escalate_after_seconds: 180,
      escalation_route: { kind: "all" }
    },
    visitor_history: { visible_to_visitor: true },
    transcripts: { offer_email_on_close: false },
    voice: { mode: "attachment", max_seconds: 120 },
    ai: {
      enabled: false,
      disclose: true,
      tone: { preset: "friendly", custom: "" },
      instructions: "",
      knowledge: "",
      tools: {
        capture_contact: true,
        create_lead: true,
        get_business_info: true,
        lookup_customer: false
      },
      suggestions: { enabled: true, auto: true, auto_after_seconds: 5, allow_one_click_send: false }
    }
  };
}

function deepMerge(base: ChatJson, patch: ChatJson): ChatJson {
  const result: ChatJson = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      result[key] = deepMerge(asObject(base[key]), asObject(value));
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}

export function normalizeChatSettings(raw: unknown, appearanceDefaults: ChatJson = {}): ChatJson {
  return deepMerge(defaultChatSettings(appearanceDefaults), asObject(raw));
}

export async function loadChatSettings(orgId: string, branchId = "default"): Promise<ChatJson> {
  const appearanceDefaults = await chatAppearanceDefaults(orgId, branchId);
  try {
    const moduleDoc = await readBranchModule(orgId, branchId, CHAT_MODULE_ID);
    return normalizeChatSettings(asObject(moduleDoc?.data), appearanceDefaults);
  } catch {
    return defaultChatSettings(appearanceDefaults);
  }
}

export async function saveChatSettings(orgId: string, branchId: string, input: ChatJson, ctx: PlatformAuthContext) {
  const settings = normalizeChatSettings(input, await chatAppearanceDefaults(orgId, branchId));
  await saveBranchModule(orgId, branchId, CHAT_MODULE_ID, {
    data: settings,
    metadata: { kind: "live_chat_settings", source: "chat_api" }
  }, { replace: true });
  if (settings.enabled) (await ensureWidgetKey(orgId, branchId));
  return (await chatSettingsPayload(orgId, branchId, settings, ctx));
}

export async function chatSettingsPayload(orgId: string, branchId: string, settings: ChatJson, _ctx: PlatformAuthContext) {
  const key = (await ensureWidgetKey(orgId, branchId));
  return {
    settings,
    widget_key: key.widget_key,
    embed_snippet: embedSnippet(cleanText(key.widget_key))
  };
}

export async function rotateChatWidgetKey(orgId: string, branchId = "default") {
  const key = (await rotateWidgetKey(orgId, branchId));
  return { widget_key: key.widget_key, embed_snippet: embedSnippet(cleanText(key.widget_key)) };
}

function embedSnippet(widgetKey: string) {
  // The widget script is served by the web host (nginx/PHP), not the API
  // host — in production they share an origin; in dev the web host is :8011.
  const base = env.isProduction ? "https://app.1m8.ai" : "http://127.0.0.1:8011";
  return `<script src="${base}/libraries/chat-embed/firstmate-chat-embed.js" data-widget-key="${widgetKey}" async></script>`;
}

// --- Live status -----------------------------------------------------------

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function localDayAndTime(timezone: string) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone || "America/Chicago",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
    const parts = formatter.formatToParts(new Date());
    const read = (type: string) => parts.find((part) => part.type === type)?.value || "";
    const weekday = read("weekday").toLowerCase().slice(0, 3) || "mon";
    const hour = read("hour") === "24" ? "00" : read("hour");
    return { day: weekday, time: `${hour}:${read("minute")}` };
  } catch {
    const now = new Date();
    return { day: DAY_KEYS[now.getUTCDay()] || "mon", time: `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}` };
  }
}

export function withinLiveHours(settings: ChatJson) {
  const liveHours = asObject(settings.live_hours);
  const { day, time } = localDayAndTime(cleanText(liveHours.timezone));
  const windows = asObject(liveHours.days)[day];
  if (!Array.isArray(windows) || !windows.length) return false;
  return windows.some((window) => {
    const start = cleanText(asObject(window).start);
    const end = cleanText(asObject(window).end);
    return start && end && time >= start && time < end;
  });
}

export async function chatLiveStatus(orgId: string, settings: ChatJson): Promise<"online" | "offline"> {
  const presence = asObject(settings.presence);
  const force = cleanText(presence.force_status);
  if (force === "online") return "online";
  if (force === "offline") return "offline";
  const freshTeam = (await listFreshPresence(orgId, isoPlus(-PRESENCE_FRESH_MS)))
    .filter((row) => !cleanText(row.conversation_id));
  if (freshTeam.length) return "online";
  if (!withinLiveHours(settings)) return "offline";
  if (presence.require_agent_presence === true) return "offline";
  return "online";
}

// --- Capability helpers ----------------------------------------------------

export async function chatAppEnabled(orgId: string) {
  const { isCapabilityEnabled } = await import("../platform/capabilities.js");
  return await isCapabilityEnabled(orgId, "apps.live_chat");
}

export async function chatAiEnabled(orgId: string, settings: ChatJson) {
  if (asObject(settings.ai).enabled !== true) return false;
  const { isCapabilityEnabled } = await import("../platform/capabilities.js");
  return await isCapabilityEnabled(orgId, "live_chat.ai_agent");
}

export async function chatSuggestionsEnabled(orgId: string, settings: ChatJson) {
  if (asObject(asObject(settings.ai).suggestions).enabled !== true) return false;
  const { isCapabilityEnabled } = await import("../platform/capabilities.js");
  return await isCapabilityEnabled(orgId, "live_chat.suggested_responses");
}

// --- Widget resolution -----------------------------------------------------

export type WidgetContext = {
  orgId: string;
  branchId: string;
  widgetKey: string;
  settings: ChatJson;
};

export async function resolveWidget(widgetKey: string): Promise<WidgetContext> {
  const record = (await findWidgetKey(widgetKey));
  if (!record || cleanText(record.status) !== "active") {
    throw notFound("chat_widget_not_found", "This chat widget is not available.");
  }
  const orgId = cleanText(record.organization_id);
  const branchId = cleanText(record.branch_id) || "default";
  if (!(await chatAppEnabled(orgId))) throw forbidden("chat_disabled", "Live chat is not enabled for this organization.");
  const settings = await loadChatSettings(orgId, branchId);
  if (settings.enabled !== true) throw forbidden("chat_disabled", "Live chat is not enabled for this organization.");
  return { orgId, branchId, widgetKey: cleanText(widgetKey), settings };
}

export async function publicWidgetConfig(context: WidgetContext) {
  const { settings, orgId } = context;
  const appearance = asObject(settings.appearance);
  const copy = asObject(settings.copy);
  const preChat = asObject(settings.pre_chat);
  const status = (await chatLiveStatus(orgId, settings));
  const aiActive = await chatAiEnabled(orgId, settings);
  const mode = cleanText(settings.mode);
  const aiFronts = aiActive && (mode === "ai" || mode === "ai_first_then_human" || (mode === "ai_when_offline" && status === "offline"));
  return {
    status,
    accepting: status === "online" || aiFronts,
    ai: aiFronts,
    ai_disclose: asObject(settings.ai).disclose !== false,
    appearance: {
      primary_color: cleanText(appearance.primary_color) || "#1f6feb",
      background_color: cleanText(appearance.background_color) || "#ffffff",
      text_color: cleanText(appearance.text_color) || "#111827",
      font_family: cleanText(appearance.font_family) || "Inter",
      position: cleanText(appearance.position) === "bottom_left" ? "bottom_left" : "bottom_right",
      launcher_label: cleanText(appearance.launcher_label) || "Chat with us",
      show_branding: appearance.show_branding !== false
    },
    copy: {
      greeting: cleanText(copy.greeting) || "Hi there! How can we help?",
      offline_message: cleanText(copy.offline_message) || "We're offline right now — leave a message and we'll get back to you."
    },
    pre_chat: {
      require_name: preChat.require_name === true,
      require_email: preChat.require_email === true,
      require_phone: preChat.require_phone === true
    },
    history_visible: asObject(settings.visitor_history).visible_to_visitor !== false,
    voice: {
      mode: ["attachment", "dictation", "off"].includes(cleanText(asObject(settings.voice).mode))
        ? cleanText(asObject(settings.voice).mode)
        : "attachment",
      max_seconds: Math.max(5, Math.min(300, Number(asObject(settings.voice).max_seconds || 120)))
    }
  };
}

// --- Portal grants ---------------------------------------------------------

export function mintPortalGrant(orgId: string, customerId: string, contactId: string, name = "", email = "") {
  const payload = Buffer.from(JSON.stringify({
    org_id: orgId, customer_id: customerId, contact_id: contactId, name, email,
    expires_at: Date.now() + 15 * 60_000
  })).toString("base64url");
  const signature = createHmac("sha256", env.platformSessionSecret).update(payload).digest("base64url");
  return `pg.${payload}.${signature}`;
}

function verifyPortalGrant(grant: string, orgId: string): ChatJson | null {
  const [tag = "", payloadPart = "", signaturePart = ""] = cleanText(grant).split(".");
  if (tag !== "pg" || !payloadPart || !signaturePart) return null;
  const expected = createHmac("sha256", env.platformSessionSecret).update(payloadPart).digest("base64url");
  const provided = Buffer.from(signaturePart);
  const wanted = Buffer.from(expected);
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) return null;
  try {
    const payload = asObject(JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")));
    if (cleanText(payload.org_id) !== orgId) return null;
    if (Number(payload.expires_at || 0) < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

// --- Sessions --------------------------------------------------------------

function hashIp(orgId: string, ip: string) {
  return ip ? sha256Hex(`${orgId}:${ip}`) : "";
}

export async function createOrResumeSession(context: WidgetContext, input: ChatJson, requestMeta: ChatJson) {
  const { orgId, branchId, settings } = context;
  const ipHash = hashIp(orgId, cleanText(requestMeta.ip));
  const grant = cleanText(input.portal_grant) ? verifyPortalGrant(cleanText(input.portal_grant), orgId) : null;

  let visitor: ChatJson | null = null;
  let token = cleanText(input.visitor_token);
  if (token) {
    visitor = (await findVisitorByTokenHash(orgId, sha256Hex(token)));
  }
  if (!visitor) {
    token = generateVisitorToken();
    visitor = (await createVisitor({
      organization_id: orgId,
      branch_id: branchId,
      token_hash: sha256Hex(token),
      ip_hash: ipHash,
      user_agent: cleanText(requestMeta.user_agent).slice(0, 500),
      page_url: cleanText(input.page_url),
      ...(grant ? {
        contact_id: cleanText(grant.contact_id),
        portal_customer_id: cleanText(grant.customer_id),
        display_name: cleanText(grant.name),
        email: cleanText(grant.email)
      } : {})
    }));
  } else {
    visitor = (await updateVisitor(orgId, cleanText(visitor.id), {
      last_ip_hash: ipHash,
      page_url: cleanText(input.page_url),
      ...(grant ? { contact_id: cleanText(grant.contact_id), portal_customer_id: cleanText(grant.customer_id) } : {})
    }));
  }

  const historyVisible = asObject(settings.visitor_history).visible_to_visitor !== false || Boolean(grant);
  const states = (await listConversationStatesForVisitor(orgId, cleanText(visitor.id), 20));
  const conversations = historyVisible
    ? (await Promise.all(states.map(async (state) => (await publicConversationSummary(orgId, state)))))
    : (await Promise.all(states.filter((state) => !cleanText(state.closed_at)).slice(0, 1).map(async (state) => (await publicConversationSummary(orgId, state)))));

  return {
    visitor_token: token,
    visitor_id: visitor.id,
    identified: Boolean(cleanText(visitor.contact_id)),
    display_name: cleanText(visitor.display_name),
    conversations
  };
}

async function publicConversationSummary(orgId: string, state: ChatJson) {
  const messages = (await listMessagesAfter(orgId, cleanText(state.conversation_id), "", { public_only: true, limit: 500 }));
  const last = messages[messages.length - 1];
  return {
    id: state.conversation_id,
    status: cleanText(state.closed_at) ? "closed" : "open",
    created_at: state.created_at,
    last_message: last ? { text: cleanText(last.text_body).slice(0, 200), direction: last.direction, created_at: last.created_at } : null,
    message_count: messages.length
  };
}

export async function requireVisitor(context: WidgetContext, token: string) {
  const visitor = token ? (await findVisitorByTokenHash(context.orgId, sha256Hex(token))) : null;
  if (!visitor) throw forbidden("chat_visitor_unauthorized", "This chat session is no longer valid.");
  return visitor;
}

// --- Conversation lifecycle ------------------------------------------------

async function decideHandling(context: WidgetContext) {
  const { orgId, settings } = context;
  const status = (await chatLiveStatus(orgId, settings));
  const aiActive = await chatAiEnabled(orgId, settings);
  const mode = cleanText(settings.mode);
  if (aiActive && (mode === "ai" || mode === "ai_first_then_human")) return { handling: "ai", status };
  if (aiActive && mode === "ai_when_offline" && status === "offline") return { handling: "ai", status };
  if (status === "offline") return { handling: "offline_capture", status };
  return { handling: "human", status };
}

export async function startConversation(context: WidgetContext, visitor: ChatJson, input: ChatJson, requestMeta: ChatJson) {
  const { orgId, branchId, settings } = context;
  const preChatPatch: ChatJson = {};
  if (cleanText(input.name)) preChatPatch.display_name = cleanText(input.name);
  if (cleanText(input.email)) preChatPatch.email = cleanText(input.email);
  if (cleanText(input.phone)) preChatPatch.phone = cleanText(input.phone);
  const updatedVisitor = Object.keys(preChatPatch).length
    ? (await updateVisitor(orgId, cleanText(visitor.id), preChatPatch))
    : visitor;

  const { handling, status } = await decideHandling(context);
  const visitorName = cleanText(updatedVisitor.display_name) || "Website visitor";
  const conversation = (await createConversationRecord({
    organization_id: orgId,
    branch_id: branchId,
    channel_strategy: "webchat",
    subject: `Live chat with ${visitorName}`,
    status: "open",
    participants: [{ address: cleanText(updatedVisitor.id), name: visitorName, type: "to", contact_id: cleanText(updatedVisitor.contact_id) || undefined }],
    context: { contact_id: cleanText(updatedVisitor.contact_id) || undefined },
    metadata: { source: cleanText(requestMeta.source) || "website", visitor_id: updatedVisitor.id }
  }));

  const escalateAfter = Number(asObject(settings.notifications).escalate_after_seconds || 0);
  const state = (await createConversationState({
    conversation_id: conversation.id,
    organization_id: orgId,
    branch_id: branchId,
    visitor_id: updatedVisitor.id,
    widget_key: context.widgetKey,
    origin_url: cleanText(input.page_url) || cleanText(updatedVisitor.page_url),
    source: cleanText(requestMeta.source) || "website",
    handling_mode: handling,
    ai_status: handling === "ai" ? "active" : null,
    first_response_due_at: handling === "human" && escalateAfter > 0 ? isoPlus(escalateAfter * 1000) : null
  }));

  await emitChatEvent("chat.conversation.started", orgId, branchId, state, {
    visitor_name: visitorName,
    origin_url: cleanText(state.origin_url),
    handling_mode: handling,
    status
  });

  const message = await recordVisitorMessage(context, updatedVisitor, state, input);
  return {
    conversation: (await publicConversationState(context, (await readConversationState(orgId, cleanText(conversation.id))), status)),
    message
  };
}

export async function recordVisitorMessage(context: WidgetContext, visitor: ChatJson, state: ChatJson, input: ChatJson) {
  const { orgId, branchId, settings } = context;
  const conversationId = cleanText(state.conversation_id);
  const now = nowIso();
  const { message } = (await createMessageRecord({
    organization_id: orgId,
    branch_id: branchId,
    conversation_id: conversationId,
    direction: "inbound",
    channel: "webchat",
    purpose: "customer_care",
    status: "delivered",
    text_body: cleanText(input.message),
    sender: { kind: "visitor", visitor_id: visitor.id, name: cleanText(visitor.display_name) || "Website visitor" },
    recipients: [{ address: "team", type: "to" }],
    context: { contact_id: cleanText(visitor.contact_id) || undefined },
    source: { type: "api", id: "live_chat_widget" },
    metadata: {
      ...(cleanText(asObject(input.audio_note).media_id) ? { audio_note: asObject(input.audio_note) } : {}),
      ...(Object.keys(asObject(input.page_context)).length ? { page_context: asObject(input.page_context) } : {})
    },
    idempotency_key: cleanText(input.idempotency_key) || undefined,
    delivered_at: now
  }));
  (await touchConversationForMessage(orgId, conversationId, cleanText(message.created_at) || now));
  (await updateConversationState(orgId, conversationId, { visitor_last_seen_at: now, visitor_typing_until: null }));
  if (cleanText(input.page_url)) (await updateVisitor(orgId, cleanText(visitor.id), { page_url: cleanText(input.page_url) }));

  await emitChatEvent("chat.message.received", orgId, branchId, state, {
    message_id: message.id,
    preview: cleanText(input.message).slice(0, 140)
  });

  await dispatchInbound(context, visitor, (await readConversationState(orgId, conversationId)), message);
  return publicMessageShape(settings, message);
}

async function dispatchInbound(context: WidgetContext, visitor: ChatJson, state: ChatJson, message: ChatJson) {
  const { orgId, settings } = context;
  const handling = cleanText(state.handling_mode);
  const aiActive = cleanText(state.ai_status) === "active" && await chatAiEnabled(orgId, settings);
  if (handling === "ai" && aiActive) {
    const { scheduleChatAgentTurn } = await import("./agent.js");
    scheduleChatAgentTurn(orgId, cleanText(state.branch_id) || "default", cleanText(state.conversation_id));
    return;
  }
  if (handling === "offline_capture") return;
  await notifyTeam(orgId, settings, state, {
    title: "New live chat message",
    body: `${cleanText(visitor.display_name) || "A website visitor"}: “${cleanText(message.text_body).slice(0, 120)}”`
  });
}

export async function publicConversationState(context: WidgetContext, state: ChatJson, status?: string) {
  const teamPresent = (await listFreshPresence(context.orgId, isoPlus(-PRESENCE_FRESH_MS)))
    .some((row) => cleanText(row.conversation_id) === cleanText(state.conversation_id));
  const liveStatus = teamPresent ? "online" : (status || (await chatLiveStatus(context.orgId, context.settings)));
  return {
    id: state.conversation_id,
    status: cleanText(state.closed_at) ? "closed" : "open",
    handling: cleanText(state.handling_mode),
    live_status: liveStatus,
    team_present: teamPresent,
    agent_typing: cleanText(state.agent_typing_until) > nowIso(),
    agent_typing_name: cleanText(state.agent_typing_until) > nowIso() ? cleanText(state.agent_typing_name) : ""
  };
}

export function publicMessageShape(settings: ChatJson, message: ChatJson) {
  const sender = asObject(message.sender);
  const copy = asObject(settings.copy);
  let senderName = "";
  const kind = cleanText(sender.kind);
  if (kind === "user") {
    senderName = cleanText(copy.team_display) === "team_name"
      ? cleanText(copy.team_name) || "Support"
      : cleanText(sender.name).split(/\s+/)[0] || cleanText(copy.team_name) || "Support";
  } else if (kind === "ai_agent") {
    senderName = cleanText(copy.team_name) || "Assistant";
  }
  return {
    id: message.id,
    direction: message.direction,
    text: cleanText(message.text_body),
    sender: { kind: kind || (message.direction === "inbound" ? "visitor" : "user"), name: senderName },
    created_at: message.created_at,
    metadata: asObject(message.metadata),
    cursor: messageCursor(message)
  };
}

export async function conversationFeed(context: WidgetContext, visitor: ChatJson, conversationId: string, cursor: string) {
  const { orgId, settings } = context;
  const state = (await readConversationState(orgId, conversationId));
  if (cleanText(state.visitor_id) !== cleanText(visitor.id)) {
    throw forbidden("chat_visitor_unauthorized", "This conversation belongs to a different visitor.");
  }
  (await updateConversationState(orgId, conversationId, { visitor_last_seen_at: nowIso() }));
  await maybeEscalate(orgId, settings, state);
  const refreshed = (await refreshClaim(orgId, settings, (await readConversationState(orgId, conversationId))));
  const messages = (await listMessagesAfter(orgId, conversationId, cursor, { public_only: true }))
    .map((message) => publicMessageShape(settings, message));
  return {
    conversation: (await publicConversationState(context, refreshed)),
    messages,
    cursor: messages.at(-1)?.cursor || cursor || ""
  };
}

export async function visitorTyping(context: WidgetContext, visitor: ChatJson, conversationId: string) {
  const state = (await readConversationState(context.orgId, conversationId));
  if (cleanText(state.visitor_id) !== cleanText(visitor.id)) {
    throw forbidden("chat_visitor_unauthorized", "This conversation belongs to a different visitor.");
  }
  (await updateConversationState(context.orgId, conversationId, {
    visitor_typing_until: isoPlus(TYPING_TTL_MS),
    visitor_last_seen_at: nowIso()
  }));
}

export async function closeConversation(orgId: string, branchId: string, conversationId: string, closedBy: string) {
  const state = (await readConversationState(orgId, conversationId));
  if (cleanText(state.closed_at)) return state;
  const updated = (await updateConversationState(orgId, conversationId, {
    closed_at: nowIso(),
    closed_by: closedBy,
    agent_typing_until: null,
    claimed_by_user_id: null,
    claimed_at: null,
    claim_expires_at: null
  }));
  (await getChatDatabase().prepare("UPDATE communication_conversations SET status = 'closed', updated_at = ? WHERE organization_id = ? AND id = ?")
    .run(nowIso(), orgId, conversationId));
  await emitChatEvent("chat.conversation.closed", orgId, branchId, updated, { closed_by: closedBy });
  return updated;
}

export async function captureOfflineDetails(context: WidgetContext, visitor: ChatJson, conversationId: string, input: ChatJson) {
  const { orgId, branchId } = context;
  const state = (await readConversationState(orgId, conversationId));
  if (cleanText(state.visitor_id) !== cleanText(visitor.id)) {
    throw forbidden("chat_visitor_unauthorized", "This conversation belongs to a different visitor.");
  }
  const patch: ChatJson = {};
  if (cleanText(input.name)) patch.display_name = cleanText(input.name);
  if (cleanText(input.email)) patch.email = cleanText(input.email);
  if (cleanText(input.phone)) patch.phone = cleanText(input.phone);
  const updated = Object.keys(patch).length ? (await updateVisitor(orgId, cleanText(visitor.id), patch)) : visitor;

  let leadId = "";
  if (cleanText(updated.email) || cleanText(updated.phone)) {
    try {
      const { createPlatformLead } = await import("../platform/api.js");
      const messages = (await listMessagesAfter(orgId, conversationId, "", { public_only: true, limit: 10 }));
      const lead = await createPlatformLead(orgId, {
        name: cleanText(updated.display_name) || "Live chat visitor",
        email: cleanText(updated.email),
        phone: cleanText(updated.phone),
        source: "live_chat",
        notes: messages.map((message) => `${message.direction === "inbound" ? "Visitor" : "Team"}: ${cleanText(message.text_body)}`).join("\n").slice(0, 4000),
        metadata: { chat_conversation_id: conversationId }
      } as never);
      leadId = cleanText(asObject(lead).id);
    } catch {
      // Lead creation is best-effort; the offline message event still fires.
    }
  }
  await emitChatEvent("chat.offline.message", orgId, branchId, state, {
    visitor_name: cleanText(updated.display_name),
    visitor_email: cleanText(updated.email),
    visitor_phone: cleanText(updated.phone),
    lead_id: leadId
  });
  return { lead_id: leadId };
}

// --- Claiming --------------------------------------------------------------

/** Lazily releases expired or disconnected claims. Returns fresh state. */
export async function refreshClaim(orgId: string, settings: ChatJson, state: ChatJson): Promise<ChatJson> {
  const owner = cleanText(state.claimed_by_user_id);
  if (!owner) return state;
  const claiming = asObject(settings.claiming);
  const expired = cleanText(state.claim_expires_at) && cleanText(state.claim_expires_at) < nowIso();
  let disconnected = false;
  if (!expired && claiming.release_on_disconnect !== false) {
    const lastSeen = (await lastGlobalPresence(orgId, owner));
    disconnected = Boolean(lastSeen) && !isFresh(lastSeen, DISCONNECT_RELEASE_MS);
  }
  if (!expired && !disconnected) return state;
  const updated = (await updateConversationState(orgId, cleanText(state.conversation_id), {
    claimed_by_user_id: null, claimed_at: null, claim_expires_at: null
  }));
  void emitChatEvent("chat.conversation.released", orgId, cleanText(state.branch_id) || "default", updated, {
    released_from: owner,
    reason: expired ? "idle" : "disconnected"
  });
  return updated;
}

export async function claimConversation(orgId: string, ctx: PlatformAuthContext, settings: ChatJson, conversationId: string) {
  const state = (await refreshClaim(orgId, settings, (await readConversationState(orgId, conversationId))));
  const claiming = asObject(settings.claiming);
  const owner = cleanText(state.claimed_by_user_id);
  const takeover = Boolean(owner) && owner !== ctx.userId;
  if (takeover && claiming.allow_takeover === false && !["owner", "admin", "super_admin"].includes(ctx.role)) {
    throw conflict("chat_claim_held", "This conversation is claimed by another team member.");
  }
  const idleMinutes = Math.max(1, Number(claiming.idle_release_minutes || 10));
  const updated = (await updateConversationState(orgId, conversationId, {
    claimed_by_user_id: ctx.userId,
    claimed_at: nowIso(),
    claim_expires_at: isoPlus(idleMinutes * 60_000)
  }));
  await emitChatEvent(takeover ? "chat.conversation.claim_taken" : "chat.conversation.claimed", orgId, cleanText(state.branch_id) || "default", updated, {
    user_id: ctx.userId,
    ...(takeover ? { taken_from: owner } : {})
  });
  return updated;
}

export async function releaseConversation(orgId: string, ctx: PlatformAuthContext, conversationId: string) {
  const state = (await readConversationState(orgId, conversationId));
  const owner = cleanText(state.claimed_by_user_id);
  if (!owner) return state;
  if (owner !== ctx.userId && !["owner", "admin", "super_admin"].includes(ctx.role)) {
    throw forbidden("chat_claim_held", "Only the claim owner can release this conversation.");
  }
  const updated = (await updateConversationState(orgId, conversationId, {
    claimed_by_user_id: null, claimed_at: null, claim_expires_at: null
  }));
  await emitChatEvent("chat.conversation.released", orgId, cleanText(state.branch_id) || "default", updated, {
    released_from: owner, reason: "manual"
  });
  return updated;
}

// --- Team messaging --------------------------------------------------------

export async function teamSendMessage(orgId: string, ctx: PlatformAuthContext, settings: ChatJson, conversationId: string, input: ChatJson, senderOverride?: ChatJson) {
  let state = (await refreshClaim(orgId, settings, (await readConversationState(orgId, conversationId))));
  if (cleanText(state.closed_at)) throw badRequest("chat_conversation_closed", "This conversation is closed.");
  const claiming = asObject(settings.claiming);
  const internalNote = input.internal_note === true;
  const isAi = cleanText(asObject(senderOverride).kind) === "ai_agent";

  if (!internalNote && !isAi && cleanText(claiming.mode) === "claim") {
    const owner = cleanText(state.claimed_by_user_id);
    if (owner && owner !== ctx.userId) throw conflict("chat_claim_held", "This conversation is claimed by another team member.");
    if (!owner && claiming.auto_claim_on_reply !== false) {
      state = await claimConversation(orgId, ctx, settings, conversationId);
    }
  }

  const now = nowIso();
  const sender = senderOverride || { kind: "user", user_id: ctx.userId, name: cleanText(asObject(ctx.identity as never).name) || cleanText(asObject(ctx.identity as never).email) || "Team member" };
  const { message } = (await createMessageRecord({
    organization_id: orgId,
    branch_id: cleanText(state.branch_id) || "default",
    conversation_id: conversationId,
    direction: "outbound",
    channel: "webchat",
    purpose: internalNote ? "internal" : "customer_care",
    status: "delivered",
    text_body: cleanText(input.message),
    sender,
    recipients: [{ address: cleanText(state.visitor_id), type: "to" }],
    source: { type: isAi ? "automation" : "user", user_id: isAi ? undefined : ctx.userId, id: isAi ? "chat_ai_agent" : undefined },
    metadata: {
      ...(cleanText(input.suggestion_id) ? { ai: { suggested: true, suggestion_id: cleanText(input.suggestion_id), edited: input.suggestion_edited === true } } : {}),
      ...asObject(input.metadata)
    },
    idempotency_key: cleanText(input.idempotency_key) || undefined,
    created_by_user_id: isAi ? "" : ctx.userId,
    delivered_at: now
  }));
  (await touchConversationForMessage(orgId, conversationId, cleanText(message.created_at) || now));

  const statePatch: ChatJson = { agent_typing_until: null, first_response_due_at: null, escalated_at: null };
  if (!internalNote && !isAi && cleanText(state.ai_status) === "active") statePatch.ai_status = "handed_off";
  if (!internalNote && !isAi && cleanText(state.handling_mode) !== "human") statePatch.handling_mode = "human";
  if (!isAi && cleanText(state.claimed_by_user_id) === ctx.userId) {
    const idleMinutes = Math.max(1, Number(claiming.idle_release_minutes || 10));
    statePatch.claim_expires_at = isoPlus(idleMinutes * 60_000);
  }
  const updated = (await updateConversationState(orgId, conversationId, statePatch));
  if (!isAi) (await upsertReadState(orgId, ctx.userId, conversationId, cleanText(message.created_at) || now));

  if (!internalNote) {
    await emitChatEvent(isAi ? "chat.ai.replied" : "chat.message.sent", orgId, cleanText(state.branch_id) || "default", updated, {
      message_id: message.id,
      sender_kind: cleanText(asObject(sender).kind),
      user_id: isAi ? "" : ctx.userId
    });
  }
  return { message, state: updated };
}

export async function teamTyping(orgId: string, ctx: PlatformAuthContext, conversationId: string) {
  const identity = asObject(ctx.identity as never);
  (await updateConversationState(orgId, conversationId, {
    agent_typing_user_id: ctx.userId,
    agent_typing_name: (cleanText(identity.name) || cleanText(identity.email)).split(/\s+/)[0] || "Team",
    agent_typing_until: isoPlus(TYPING_TTL_MS)
  }));
}

// --- Team inbox ------------------------------------------------------------

export async function inboxSnapshot(orgId: string, ctx: PlatformAuthContext, settings: ChatJson, options: ChatJson = {}) {
  const conversations = (await Promise.all((await listInboxConversations(orgId, ctx.userId, options)).map(async (row) => (await refreshClaimRow(orgId, settings, row)))));
  const presence = (await listFreshPresence(orgId, isoPlus(-PRESENCE_FRESH_MS)));
  const presenceByConversation: Record<string, Array<{ user_id: string; user_name: string }>> = {};
  const onlineUsers: Array<{ user_id: string; user_name: string }> = [];
  for (const row of presence) {
    const entry = { user_id: cleanText(row.user_id), user_name: cleanText(row.user_name) };
    const conversationId = cleanText(row.conversation_id);
    if (!conversationId) onlineUsers.push(entry);
    else (presenceByConversation[conversationId] ||= []).push(entry);
  }
  const activeId = cleanText(options.active);
  let thread: ChatJson | null = null;
  if (activeId) {
    const messages = (await listMessagesAfter(orgId, activeId, cleanText(options.after), { limit: 300 }));
    const lastMessage = messages.at(-1);
    thread = {
      conversation_id: activeId,
      messages: messages.map(teamMessageShape),
      cursor: lastMessage ? messageCursor(lastMessage) : cleanText(options.after)
    };
  }
  return {
    live_status: (await chatLiveStatus(orgId, settings)),
    conversations: conversations.map((row) => inboxRowShape(row, presenceByConversation)),
    online_users: onlineUsers,
    unread_total: conversations.reduce((total, row) => total + Number(row.unread_count || 0), 0),
    thread
  };
}

async function refreshClaimRow(orgId: string, settings: ChatJson, row: ChatJson) {
  if (!cleanText(row.claimed_by_user_id)) return row;
  const refreshed = (await refreshClaim(orgId, settings, row));
  return { ...row, claimed_by_user_id: refreshed.claimed_by_user_id, claimed_at: refreshed.claimed_at, claim_expires_at: refreshed.claim_expires_at };
}

function inboxRowShape(row: ChatJson, presenceByConversation: Record<string, Array<{ user_id: string; user_name: string }>>) {
  return {
    id: row.conversation_id,
    subject: row.subject,
    status: cleanText(row.closed_at) ? "closed" : "open",
    handling_mode: row.handling_mode,
    ai_status: row.ai_status,
    source: row.source,
    visitor: {
      id: row.visitor_id,
      name: cleanText(row.visitor_name) || "Website visitor",
      email: cleanText(row.visitor_email),
      phone: cleanText(row.visitor_phone),
      contact_id: cleanText(row.visitor_contact_id) || cleanText(row.conversation_contact_id),
      page_url: cleanText(row.visitor_page_url),
      portal_customer_id: cleanText(row.portal_customer_id),
      online: isFresh(row.visitor_last_seen_at, 30_000)
    },
    project_id: cleanText(row.conversation_project_id),
    claimed_by_user_id: cleanText(row.claimed_by_user_id),
    viewers: presenceByConversation[cleanText(row.conversation_id)] || [],
    unread_count: Number(row.unread_count || 0),
    last_message: cleanText(row.last_message_text) ? {
      text: cleanText(row.last_message_text).slice(0, 160),
      direction: row.last_message_direction,
      sender: row.last_message_sender
    } : null,
    last_message_at: row.last_message_at,
    last_inbound_at: row.last_inbound_at,
    waiting_since: !cleanText(row.closed_at) && cleanText(row.last_inbound_at) && cleanText(row.last_inbound_at) > cleanText(row.last_read_message_at || "")
      ? row.last_inbound_at : null,
    visitor_typing: cleanText(row.visitor_typing_until) > nowIso(),
    created_at: row.created_at,
    closed_at: row.closed_at
  };
}

export function teamMessageShape(message: ChatJson) {
  return {
    id: message.id,
    direction: message.direction,
    text: cleanText(message.text_body),
    internal: cleanText(message.purpose) === "internal",
    sender: asObject(message.sender),
    metadata: asObject(message.metadata),
    created_at: message.created_at,
    cursor: messageCursor(message)
  };
}

export async function teamConversationDetail(orgId: string, ctx: PlatformAuthContext, settings: ChatJson, conversationId: string) {
  const state = (await refreshClaim(orgId, settings, (await readConversationState(orgId, conversationId))));
  const conversation = (await readConversationRecord(orgId, conversationId));
  const visitor = (await readVisitor(orgId, cleanText(state.visitor_id)));
  const messages = (await listMessagesAfter(orgId, conversationId, "", { limit: 500 }));
  const lastMessage = messages.at(-1);
  const history = (await Promise.all((await listConversationStatesForVisitor(orgId, cleanText(state.visitor_id), 20))
    .filter((item) => cleanText(item.conversation_id) !== conversationId)
    .map(async (item) => (await publicConversationSummary(orgId, item)))));
  const ipHints = (await findVisitorsByIpHash(orgId, cleanText(visitor.ip_hash), cleanText(visitor.id)))
    .map((hint) => ({ visitor_id: hint.id, name: cleanText(hint.display_name), email: cleanText(hint.email), last_seen_at: hint.last_seen_at }));
  const presence = (await listFreshPresence(orgId, isoPlus(-PRESENCE_FRESH_MS)))
    .filter((row) => cleanText(row.conversation_id) === conversationId)
    .map((row) => ({ user_id: cleanText(row.user_id), user_name: cleanText(row.user_name) }));
  return {
    conversation: {
      id: conversation.id,
      subject: conversation.subject,
      status: cleanText(state.closed_at) ? "closed" : "open",
      contact_id: cleanText(conversation.contact_id) || cleanText(visitor.contact_id),
      project_id: cleanText(conversation.project_id),
      created_at: conversation.created_at
    },
    state: {
      handling_mode: state.handling_mode,
      ai_status: state.ai_status,
      claimed_by_user_id: cleanText(state.claimed_by_user_id),
      claimed_at: state.claimed_at,
      origin_url: state.origin_url,
      source: state.source,
      visitor_online: isFresh(state.visitor_last_seen_at, 30_000),
      visitor_typing: cleanText(state.visitor_typing_until) > nowIso(),
      closed_at: state.closed_at,
      closed_by: state.closed_by
    },
    visitor: {
      id: visitor.id,
      name: cleanText(visitor.display_name),
      email: cleanText(visitor.email),
      phone: cleanText(visitor.phone),
      contact_id: cleanText(visitor.contact_id),
      portal_customer_id: cleanText(visitor.portal_customer_id),
      page_url: cleanText(visitor.page_url),
      first_seen_at: visitor.first_seen_at,
      last_seen_at: visitor.last_seen_at
    },
    messages: messages.map(teamMessageShape),
    cursor: lastMessage ? messageCursor(lastMessage) : "",
    history,
    ip_hints: ipHints,
    viewers: presence
  };
}

export async function linkConversation(orgId: string, ctx: PlatformAuthContext, conversationId: string, input: ChatJson) {
  const state = (await readConversationState(orgId, conversationId));
  const contactId = cleanText(input.contact_id);
  const projectId = cleanText(input.project_id);
  const db = getChatDatabase();
  const now = nowIso();
  if (contactId || projectId) {
    (await db.prepare(`UPDATE communication_conversations SET
      contact_id = COALESCE(NULLIF(?, ''), contact_id),
      project_id = COALESCE(NULLIF(?, ''), project_id),
      updated_at = ?
      WHERE organization_id = ? AND id = ?`)
      .run(contactId, projectId, now, orgId, conversationId));
    if (contactId) (await updateVisitor(orgId, cleanText(state.visitor_id), { contact_id: contactId }));
    await emitChatEvent("chat.conversation.linked", orgId, cleanText(state.branch_id) || "default", state, {
      contact_id: contactId, project_id: projectId, user_id: ctx.userId
    });
  }
  return (await readConversationRecord(orgId, conversationId));
}

export async function presenceHeartbeat(orgId: string, ctx: PlatformAuthContext, conversationId = "") {
  const identity = asObject(ctx.identity as never);
  const name = cleanText(identity.name) || cleanText(identity.email) || "Team member";
  (await upsertPresence(orgId, ctx.userId, name, ""));
  if (conversationId) (await upsertPresence(orgId, ctx.userId, name, conversationId));
}

export async function markConversationRead(orgId: string, ctx: PlatformAuthContext, conversationId: string) {
  (await upsertReadState(orgId, ctx.userId, conversationId, nowIso()));
}

export async function setAiHandling(orgId: string, ctx: PlatformAuthContext, settings: ChatJson, conversationId: string, aiActive: boolean) {
  const state = (await readConversationState(orgId, conversationId));
  if (aiActive && !(await chatAiEnabled(orgId, settings))) {
    throw forbidden("chat_ai_disabled", "The AI agent is not enabled for this organization.");
  }
  const updated = (await updateConversationState(orgId, conversationId, aiActive
    ? { handling_mode: "ai", ai_status: "active" }
    : { handling_mode: "human", ai_status: cleanText(state.ai_status) ? "handed_off" : null }));
  if (!aiActive) {
    await emitChatEvent("chat.ai.handoff", orgId, cleanText(state.branch_id) || "default", updated, { user_id: ctx.userId, direction: "to_human" });
  }
  return updated;
}

// --- Notifications ---------------------------------------------------------

function routeTargets(route: ChatJson) {
  const kind = cleanText(route.kind);
  if (kind === "roles") return { target_role_ids: (route.role_ids as string[]) || [] };
  if (kind === "users") return { target_user_ids: (route.user_ids as string[]) || [] };
  return {};
}

export async function notifyTeam(orgId: string, settings: ChatJson, state: ChatJson, content: { title: string; body: string }, options: ChatJson = {}) {
  const notifications = asObject(settings.notifications);
  const escalation = options.escalation === true;
  const debounceSeconds = Math.max(0, Number(notifications.debounce_seconds ?? 120));
  if (!escalation && isFresh(state.last_notified_at, debounceSeconds * 1000)) return null;
  const conversationId = cleanText(state.conversation_id);
  if (!escalation) {
    const viewing = (await listFreshPresence(orgId, isoPlus(-PRESENCE_FRESH_MS)))
      .some((row) => cleanText(row.conversation_id) === conversationId);
    if (viewing) return null;
  }
  const route = asObject(escalation ? notifications.escalation_route : notifications.route);
  try {
    const { createPlatformNotification } = await import("../platform/api.js");
    const notification = await createPlatformNotification(orgId, {
      id: `notification_chat_${conversationId}_${Date.now()}`,
      title: content.title,
      body: content.body,
      kind: "chat_message",
      channel: "passive",
      push: true,
      manual_dismissible: true,
      branch_id: cleanText(state.branch_id) || "default",
      source: "live_chat",
      ...routeTargets(route),
      frontend_action: { kind: "open_chat_conversation", conversation_id: conversationId },
      context: { conversation_id: conversationId, visitor_id: cleanText(state.visitor_id), escalation }
    });
    (await updateConversationState(orgId, conversationId, { last_notified_at: nowIso() }));
    return notification;
  } catch {
    return null;
  }
}

async function maybeEscalate(orgId: string, settings: ChatJson, state: ChatJson) {
  const due = cleanText(state.first_response_due_at);
  if (!due || cleanText(state.escalated_at) || cleanText(state.closed_at)) return;
  if (due > nowIso()) return;
  const escalateAfter = Number(asObject(settings.notifications).escalate_after_seconds || 0);
  if (escalateAfter <= 0) return;
  (await updateConversationState(orgId, cleanText(state.conversation_id), { escalated_at: nowIso() }));
  await notifyTeam(orgId, settings, state, {
    title: "Live chat needs attention",
    body: "A website chat has been waiting with no reply."
  }, { escalation: true });
}

/** Called by the AI agent when it decides the team should take over. */
export async function aiRequestHandoff(orgId: string, branchId: string, settings: ChatJson, conversationId: string, reason: string) {
  const updated = (await updateConversationState(orgId, conversationId, {
    handling_mode: "human",
    ai_status: "handed_off",
    first_response_due_at: isoPlus(Math.max(30, Number(asObject(settings.notifications).escalate_after_seconds || 180)) * 1000)
  }));
  await emitChatEvent("chat.ai.handoff", orgId, branchId, updated, { direction: "to_team", reason: reason.slice(0, 300) });
  await notifyTeam(orgId, settings, updated, {
    title: "AI handed off a live chat",
    body: reason ? `The AI agent needs help: ${reason.slice(0, 120)}` : "The AI agent handed a conversation to the team."
  });
  return updated;
}

// --- Work events -----------------------------------------------------------

export async function emitChatEvent(type: string, orgId: string, branchId: string, state: ChatJson, payload: ChatJson = {}) {
  try {
    const conversation = (await readConversationRecord(orgId, cleanText(state.conversation_id)));
    const { emitWorkEvent } = await import("../work/engine.js");
    await emitWorkEvent({
      organization_id: orgId,
      branch_id: branchId,
      ...(cleanText(conversation.project_id) ? { project_id: cleanText(conversation.project_id) } : {}),
      type,
      idempotency_key: `${type}:${cleanText(state.conversation_id)}:${cleanText(payload.message_id) || Date.now()}`,
      payload: {
        conversation_id: state.conversation_id,
        visitor_id: state.visitor_id,
        contact_id: cleanText(conversation.contact_id) || undefined,
        project_id: cleanText(conversation.project_id) || undefined,
        channel: "webchat",
        ...payload
      },
      context: { source: "live_chat" }
    });
  } catch {
    // Event emission must never break the chat flow.
  }
}
