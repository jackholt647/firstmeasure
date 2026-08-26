import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ensureLeadDatabase, withLeadDb } from "../internal/crm/leads.js";
import { asObject, readInternalDocument, readInternalUser, saveInternalDocument, saveInternalUser, type JsonObject } from "../internal/storage.js";
import { badRequest } from "../platform/errors.js";
import { env } from "../src/config/env.js";

type GmailData = JsonObject & {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  email?: string;
  history_id?: string;
  scope?: string;
};

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
  "openid",
  "email",
  "profile"
];

function communicationRoot() {
  return path.resolve(process.cwd(), process.env.COMMUNICATIONS_STORAGE_ROOT ?? "./storage/communications");
}

function mailboxRoot() {
  return path.join(communicationRoot(), "gmail_mailboxes");
}

function oauthStateRoot() {
  return path.join(communicationRoot(), "gmail_oauth_state");
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function safeKey(value: unknown) {
  return String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9_.@-]+/g, "_");
}

function stringValue(value: unknown) {
  return String(value ?? "").trim();
}

function unixFromHeader(value: unknown) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : nowUnix();
}

async function pathExists(filePath: string) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, value: unknown) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function serverConfigValue(key: string) {
  const document = await readInternalDocument("server_config", key);
  const data = asObject(document?.data);
  const value = data.value;
  if (value !== undefined && value !== null && value !== "") return value;
  return process.env[key.toUpperCase()] ?? "";
}

async function gmailClientId() {
  return stringValue(await serverConfigValue("gmail_client_id"));
}

async function gmailClientSecret() {
  return stringValue(await serverConfigValue("gmail_client_secret"));
}

function isGmailNodeCallback(value: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.pathname.endsWith("/v1/communications/gmail/oauth/callback")
      || url.pathname.endsWith("/communications/gmail/oauth/callback");
  } catch {
    return value.includes("/communications/gmail/oauth/callback");
  }
}

export async function gmailRedirectUri(baseUrl?: string) {
  const configured = stringValue(await serverConfigValue("gmail_redirect_uri"));
  if (isGmailNodeCallback(configured)) return configured;
  const base = stringValue(baseUrl) || `http://${env.host}:${env.port}/v1`;
  return `${base.replace(/\/$/, "")}/communications/gmail/oauth/callback`;
}

export async function gmailIsConfigured() {
  return Boolean(await gmailClientId()) && Boolean(await gmailClientSecret());
}

function oauthStatePath(state: string) {
  return path.join(oauthStateRoot(), `${safeKey(state)}.json`);
}

async function writeOauthState(state: string, payload: JsonObject) {
  await writeJson(oauthStatePath(state), { ...payload, state, created_at: nowUnix() });
}

async function readOauthState(state: string) {
  const filePath = oauthStatePath(state);
  const payload = await readJson<JsonObject>(filePath, {});
  await rm(filePath, { force: true });
  return payload;
}

function userIntegrations(user: JsonObject | null) {
  return asObject(user?.integrations);
}

async function readGmailData(actorEmail: string): Promise<GmailData> {
  const user = await readInternalUser(actorEmail);
  return asObject(userIntegrations(user).gmail) as GmailData;
}

async function writeGmailData(actorEmail: string, gmail: GmailData) {
  const user = await readInternalUser(actorEmail);
  if (!user) throw badRequest("gmail_actor_not_found", "The Gmail actor does not exist.");
  await saveInternalUser({
    ...user,
    integrations: {
      ...userIntegrations(user),
      gmail: {
        ...gmail,
        updated_at: new Date().toISOString()
      }
    }
  });
}

async function deleteGmailData(actorEmail: string) {
  const user = await readInternalUser(actorEmail);
  if (!user) return;
  const integrations = userIntegrations(user);
  delete integrations.gmail;
  await saveInternalUser({ ...user, integrations });
}

function grantedScopes(gmail: GmailData) {
  return stringValue(gmail.scope).split(/\s+/).filter(Boolean);
}

function hasScope(gmail: GmailData, scope: string) {
  const scopes = grantedScopes(gmail);
  if (scopes.includes(scope)) return true;
  if (scope.startsWith("https://www.googleapis.com/auth/gmail") && scopes.includes("https://mail.google.com/")) return true;
  if (scope.startsWith("https://www.googleapis.com/auth/calendar") && scopes.includes("https://www.googleapis.com/auth/calendar")) return true;
  return false;
}

function mailboxEmailForActor(actorEmail: string, gmail: GmailData) {
  return normalizeEmail(gmail.email || actorEmail);
}

function mailboxKey(mailboxEmail: string) {
  return safeKey(mailboxEmail);
}

function mailboxDir(mailboxEmail: string) {
  return path.join(mailboxRoot(), mailboxKey(mailboxEmail));
}

function mailboxStatePath(mailboxEmail: string) {
  return path.join(mailboxDir(mailboxEmail), "mailbox.json");
}

function messagePath(mailboxEmail: string, messageId: string) {
  return path.join(mailboxDir(mailboxEmail), "messages", `${safeKey(messageId)}.json`);
}

function unmatchedPath(mailboxEmail: string, messageId: string) {
  return path.join(mailboxDir(mailboxEmail), "unmatched", `${safeKey(messageId)}.json`);
}

function syncRunPath(mailboxEmail: string, runId: string) {
  return path.join(mailboxDir(mailboxEmail), "sync_runs", `${safeKey(runId)}.json`);
}

async function readMailboxState(mailboxEmail: string) {
  return await readJson<JsonObject>(mailboxStatePath(mailboxEmail), {
    mailbox_email: normalizeEmail(mailboxEmail),
    mailbox_key: mailboxKey(mailboxEmail),
    actors: [],
    history_id: "",
    initial_sync_complete: false,
    message_count: 0,
    unmatched_count: 0,
    sync_run_count: 0
  });
}

async function writeMailboxState(mailboxEmail: string, state: JsonObject) {
  await writeJson(mailboxStatePath(mailboxEmail), {
    ...state,
    mailbox_email: normalizeEmail(mailboxEmail),
    mailbox_key: mailboxKey(mailboxEmail),
    updated_at: nowUnix()
  });
}

async function registerMailbox(actorEmail: string, gmail: GmailData) {
  const mailboxEmail = mailboxEmailForActor(actorEmail, gmail);
  const state = await readMailboxState(mailboxEmail);
  const actors = new Set(Array.isArray(state.actors) ? state.actors.map(String) : []);
  actors.add(normalizeEmail(actorEmail));
  await writeMailboxState(mailboxEmail, {
    ...state,
    actors: [...actors],
    history_id: stringValue(gmail.history_id || state.history_id)
  });
}

async function googleRequest(actorEmail: string, method: string, url: string, body?: unknown, headers: Record<string, string> = {}, retry = true): Promise<JsonObject> {
  const gmail = await connectedGmailData(actorEmail);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${gmail.access_token}`,
      ...headers
    },
    body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const data = text ? safeJsonParse(text) : {};
  if (response.status === 401 && retry) {
    await refreshAccessToken(actorEmail);
    return await googleRequest(actorEmail, method, url, body, headers, false);
  }
  if (!response.ok) {
    return { ok: false, success: false, error: String(asObject(data).error_description ?? asObject(asObject(data).error).message ?? response.statusText), status_code: response.status, data };
  }
  return { ok: true, success: true, data };
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function exchangeCode(code: string, redirectUri?: string) {
  const body = new URLSearchParams({
    code,
    client_id: await gmailClientId(),
    client_secret: await gmailClientSecret(),
    redirect_uri: stringValue(redirectUri) || await gmailRedirectUri(),
    grant_type: "authorization_code"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const data = safeJsonParse(await response.text());
  if (!response.ok) return { ok: false, success: false, error: String(asObject(data).error_description ?? response.statusText), data };
  return { ok: true, success: true, data: asObject(data) };
}

export async function refreshAccessToken(actorEmail: string) {
  const gmail = await readGmailData(actorEmail);
  const refreshToken = stringValue(gmail.refresh_token);
  if (!refreshToken) return { ok: false, success: false, error: "Gmail refresh token is missing." };
  const body = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: await gmailClientId(),
    client_secret: await gmailClientSecret(),
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", body });
  const data = asObject(safeJsonParse(await response.text()));
  if (!response.ok) return { ok: false, success: false, error: String(data.error_description ?? response.statusText), data };
  const updated = {
    ...gmail,
    access_token: stringValue(data.access_token),
    token_type: stringValue(data.token_type || gmail.token_type || "Bearer"),
    scope: stringValue(data.scope || gmail.scope || GMAIL_SCOPES.join(" ")),
    expires_at: nowUnix() + Math.max(60, Number(data.expires_in ?? 3600) || 3600) - 30
  };
  await writeGmailData(actorEmail, updated);
  return { ok: true, success: true, gmail: updated };
}

export async function connectedGmailData(actorEmail: string) {
  const gmail = await readGmailData(actorEmail);
  if (!gmail.access_token && !gmail.refresh_token) throw badRequest("gmail_not_connected", "Gmail is not connected for this user.");
  if (!gmail.access_token || Number(gmail.expires_at ?? 0) <= nowUnix() + 30) {
    const refreshed = await refreshAccessToken(actorEmail);
    if (!refreshed.ok) throw badRequest("gmail_refresh_failed", String(refreshed.error ?? "Could not refresh Gmail token."));
    return asObject(refreshed.gmail) as GmailData;
  }
  return gmail;
}

export async function gmailConnectionStatus(actorEmail: string) {
  const gmail = await readGmailData(actorEmail);
  const tokenConnected = Boolean(gmail.refresh_token || (gmail.access_token && Number(gmail.expires_at ?? 0) > nowUnix()));
  const connected = tokenConnected && hasScope(gmail, "https://www.googleapis.com/auth/gmail.send") && hasScope(gmail, "https://www.googleapis.com/auth/gmail.readonly");
  const mailboxEmail = connected ? mailboxEmailForActor(actorEmail, gmail) : "";
  const mailboxState = mailboxEmail ? await readMailboxState(mailboxEmail) : {};
  return {
    configured: await gmailIsConfigured(),
    connected,
    connected_email: stringValue(gmail.email),
    mailbox_email: mailboxEmail,
    mailbox_key: mailboxEmail ? mailboxKey(mailboxEmail) : "",
    expires_at: Number(gmail.expires_at ?? 0),
    redirect_uri: await gmailRedirectUri(),
    has_refresh_token: Boolean(gmail.refresh_token),
    scopes: grantedScopes(gmail),
    signature_scope_granted: hasScope(gmail, "https://www.googleapis.com/auth/gmail.settings.basic"),
    signature_html: stringValue(gmail.signature_html),
    signature_text: htmlToText(stringValue(gmail.signature_html)),
    signature_updated_at: stringValue(gmail.signature_updated_at),
    send_as_email: stringValue(gmail.send_as_email || gmail.email),
    send_as_display_name: stringValue(gmail.send_as_display_name),
    sync: {
      initial_sync_complete: Boolean(mailboxState.initial_sync_complete),
      last_sync_at: Number(mailboxState.last_sync_at ?? 0),
      last_sync_started_at: Number(mailboxState.last_sync_started_at ?? 0),
      last_sync_status: stringValue(mailboxState.last_sync_status),
      last_sync_reason: stringValue(mailboxState.last_sync_reason),
      message_count: Number(mailboxState.message_count ?? 0),
      thread_count: Number(mailboxState.thread_count ?? 0)
    }
  };
}

export async function beginGmailConnect(actorEmail: string, baseUrl?: string) {
  const actor = normalizeEmail(actorEmail);
  if (!actor) throw badRequest("missing_actor", "An actor email is required to connect Gmail.");
  if (!(await gmailIsConfigured())) throw badRequest("gmail_not_configured", "Gmail OAuth is not configured.");
  const state = randomBytes(24).toString("hex");
  const redirectUri = await gmailRedirectUri(baseUrl);
  await writeOauthState(state, { actor_email: actor, redirect_uri: redirectUri });
  const params = new URLSearchParams({
    client_id: await gmailClientId(),
    redirect_uri: redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: GMAIL_SCOPES.join(" "),
    state,
    include_granted_scopes: "true"
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

export async function finishGmailConnect(query: JsonObject) {
  const state = stringValue(query.state);
  const code = stringValue(query.code);
  if (stringValue(query.error)) return popupHtml("Google Connection", `Google returned an error: ${stringValue(query.error)}`, { type: "firstmate-gmail-error" });
  const statePayload = state ? await readOauthState(state) : {};
  const actorEmail = normalizeEmail(statePayload.actor_email);
  if (!state || !code || !actorEmail) return popupHtml("Google Connection", "The Google connection state could not be verified.", { type: "firstmate-gmail-error" });
  const token = await exchangeCode(code, stringValue(statePayload.redirect_uri));
  if (!token.ok) return popupHtml("Google Connection", `Could not finish the Google connection: ${String(token.error ?? "Unknown error")}`, { type: "firstmate-gmail-error" });
  const tokenData = asObject(token.data);
  const existing = await readGmailData(actorEmail);
  const gmail: GmailData = {
    ...existing,
    access_token: stringValue(tokenData.access_token),
    refresh_token: stringValue(tokenData.refresh_token || existing.refresh_token),
    token_type: stringValue(tokenData.token_type || "Bearer"),
    scope: stringValue(tokenData.scope || GMAIL_SCOPES.join(" ")),
    expires_at: nowUnix() + Math.max(60, Number(tokenData.expires_in ?? 3600) || 3600) - 30,
    connected_at: existing.connected_at || new Date().toISOString()
  };
  await writeGmailData(actorEmail, gmail);
  const profile = await googleRequest(actorEmail, "GET", "https://gmail.googleapis.com/gmail/v1/users/me/profile");
  const profileData = asObject(profile.data);
  const next = {
    ...(await readGmailData(actorEmail)),
    email: stringValue(profileData.emailAddress || gmail.email || actorEmail),
    history_id: stringValue(profileData.historyId || gmail.history_id)
  };
  await writeGmailData(actorEmail, next);
  await registerMailbox(actorEmail, next);
  await refreshSignature(actorEmail).catch(() => null);
  return popupHtml("Google Connected", "Your Google account is now connected to FirstMate communications.", {
    type: "firstmate-gmail-connected",
    gmail: await gmailConnectionStatus(actorEmail)
  });
}

function popupHtml(title: string, message: string, payload: JsonObject) {
  const safeTitle = escapeHtml(title);
  const safeMessage = escapeHtml(message);
  const payloadJson = JSON.stringify(payload).replace(/</g, "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${safeTitle}</title></head><body style="font-family:Arial,sans-serif;padding:28px"><h2>${safeTitle}</h2><p>${safeMessage}</p><script>try{window.opener&&window.opener.postMessage(${payloadJson},"*")}catch(e){};setTimeout(()=>window.close(),900);</script></body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#039;" }[char] ?? char));
}

export async function disconnectGmail(actorEmail: string) {
  await deleteGmailData(actorEmail);
  return { ok: true, success: true, gmail: await gmailConnectionStatus(actorEmail) };
}

export async function refreshSignature(actorEmail: string) {
  const gmail = await readGmailData(actorEmail);
  if (!hasScope(gmail, "https://www.googleapis.com/auth/gmail.settings.basic")) return { ok: false, success: false, error: "missing_signature_scope" };
  const response = await googleRequest(actorEmail, "GET", "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs");
  if (!response.ok) return response;
  const items = Array.isArray(asObject(response.data).sendAs) ? asObject(response.data).sendAs as JsonObject[] : [];
  const connectedEmail = normalizeEmail(gmail.email);
  const selected = items.find((item) => normalizeEmail(item.sendAsEmail) === connectedEmail)
    ?? items.find((item) => item.isPrimary || item.isDefault)
    ?? items[0]
    ?? {};
  const next = {
    ...gmail,
    signature_html: stringValue(selected.signature),
    signature_text: htmlToText(stringValue(selected.signature)),
    signature_updated_at: new Date().toISOString(),
    send_as_email: stringValue(selected.sendAsEmail || gmail.email || actorEmail),
    send_as_display_name: stringValue(selected.displayName),
    send_as_reply_to: stringValue(selected.replyToAddress)
  };
  await writeGmailData(actorEmail, next);
  return { ok: true, success: true, gmail: next, signature_html: next.signature_html };
}

function htmlToText(html: string) {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function base64Url(value: string | Buffer) {
  return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(normalized, "base64").toString("utf8");
}

function mimeHeader(value: unknown) {
  return String(value ?? "").replace(/\r?\n/g, " ").trim();
}

function mimeBoundary(prefix: string) {
  return `${prefix}_${randomBytes(10).toString("hex")}`;
}

function mimeMessage(payload: JsonObject) {
  const to = mimeHeader(payload.to);
  const subject = mimeHeader(payload.subject);
  if (!to) throw badRequest("gmail_missing_to", "At least one recipient is required.");
  const bodyText = String(payload.body_text ?? payload.body ?? "");
  const bodyHtml = String(payload.body_html ?? "");
  const messageId = stringValue(payload.message_id || `<${randomBytes(16).toString("hex")}@firstmate.local>`);
  const headers = [
    "MIME-Version: 1.0",
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`
  ];
  if (payload.from) headers.push(`From: ${mimeHeader(payload.from)}`);
  if (payload.reply_to) headers.push(`Reply-To: ${mimeHeader(payload.reply_to)}`);
  if (payload.cc) headers.push(`Cc: ${mimeHeader(payload.cc)}`);
  if (payload.bcc) headers.push(`Bcc: ${mimeHeader(payload.bcc)}`);
  if (payload.in_reply_to) headers.push(`In-Reply-To: ${mimeHeader(payload.in_reply_to)}`);
  if (payload.references) headers.push(`References: ${mimeHeader(payload.references)}`);
  if (bodyHtml && bodyText) {
    const boundary = mimeBoundary("alt");
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return `${headers.join("\r\n")}\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${bodyText}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${bodyHtml}\r\n--${boundary}--`;
  }
  if (bodyHtml) {
    headers.push("Content-Type: text/html; charset=UTF-8");
    return `${headers.join("\r\n")}\r\n\r\n${bodyHtml}`;
  }
  headers.push("Content-Type: text/plain; charset=UTF-8");
  return `${headers.join("\r\n")}\r\n\r\n${bodyText}`;
}

export async function sendGmailMessage(actorEmail: string, payload: JsonObject) {
  const gmail = await readGmailData(actorEmail);
  const fromEmail = stringValue(gmail.send_as_email || gmail.email || actorEmail);
  const fromName = stringValue(gmail.send_as_display_name);
  const message = mimeMessage({
    ...payload,
    from: payload.from || (fromName ? `${fromName} <${fromEmail}>` : fromEmail),
    reply_to: payload.reply_to || stringValue(gmail.send_as_reply_to || fromEmail)
  });
  const request: JsonObject = { raw: base64Url(message) };
  if (payload.thread_id) request.threadId = stringValue(payload.thread_id);
  const sent = await googleRequest(actorEmail, "POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", request, { "Content-Type": "application/json" });
  if (!sent.ok) return sent;
  return { ok: true, success: true, ...asObject(sent.data), data: sent.data };
}

function headerValue(headers: JsonObject[], name: string) {
  const target = name.toLowerCase();
  return stringValue(headers.find((header) => stringValue(header.name).toLowerCase() === target)?.value);
}

function payloadText(payload: JsonObject): string {
  const mimeType = stringValue(payload.mimeType).toLowerCase();
  const body = asObject(payload.body);
  const data = stringValue(body.data);
  if (data && mimeType === "text/plain") return base64UrlDecode(data);
  const parts = Array.isArray(payload.parts) ? payload.parts : [];
  for (const part of parts) {
    const text = payloadText(asObject(part));
    if (text) return text;
  }
  if (data) return mimeType === "text/html" ? htmlToText(base64UrlDecode(data)) : base64UrlDecode(data);
  return "";
}

function normalizeMessage(message: JsonObject, mailboxEmail: string, actorEmail: string): JsonObject {
  const payload = asObject(message.payload);
  const headers = Array.isArray(payload.headers) ? payload.headers.map(asObject) : [];
  const from = headerValue(headers, "From");
  const to = headerValue(headers, "To");
  const cc = headerValue(headers, "Cc");
  const date = headerValue(headers, "Date");
  const labelIds = Array.isArray(message.labelIds) ? message.labelIds.map(String) : [];
  return {
    mailbox_email: mailboxEmail,
    actor_email: normalizeEmail(actorEmail),
    gmail_message_id: stringValue(message.id),
    gmail_thread_id: stringValue(message.threadId),
    gmail_history_id: stringValue(message.historyId),
    message_id_header: headerValue(headers, "Message-ID"),
    in_reply_to: headerValue(headers, "In-Reply-To"),
    references: headerValue(headers, "References"),
    subject: headerValue(headers, "Subject") || "Gmail message",
    snippet: stringValue(message.snippet),
    body_text: payloadText(payload),
    from,
    from_email: extractEmails(from)[0] ?? "",
    to,
    to_emails: extractEmails(to),
    cc,
    cc_emails: extractEmails(cc),
    label_ids: labelIds,
    direction: labelIds.includes("SENT") ? "out" : "in",
    read_status: labelIds.includes("UNREAD") ? "unread" : "read",
    happened_at: unixFromHeader(date)
  };
}

function extractEmails(value: unknown) {
  return [...String(value ?? "").matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)]
    .map((match) => normalizeEmail(match[0]))
    .filter(Boolean);
}

function leadAddressIndex(db: DatabaseSync) {
  const index = new Map<string, Set<string>>();
  const add = (email: unknown, leadId: unknown) => {
    const key = normalizeEmail(email);
    const id = stringValue(leadId);
    if (!key || !id) return;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key)?.add(id);
  };
  const leads = db.prepare("SELECT id, email FROM lead_memberships WHERE COALESCE(email, '') != ''").all() as JsonObject[];
  for (const lead of leads) add(lead.email, lead.id);
  const contacts = db.prepare("SELECT lead_id, email FROM lead_contacts WHERE COALESCE(email, '') != ''").all() as JsonObject[];
  for (const contact of contacts) add(contact.email, contact.lead_id);
  return index;
}

function leadIdsForMessage(index: Map<string, Set<string>>, message: JsonObject) {
  const ids = new Set<string>();
  for (const email of [...extractEmails(message.from), ...extractEmails(message.to), ...extractEmails(message.cc), ...extractEmails(message.body_text)]) {
    for (const id of index.get(email) ?? []) ids.add(id);
  }
  return [...ids];
}

function upsertLeadActivity(db: DatabaseSync, leadId: string, actorEmail: string, message: JsonObject) {
  const relatedId = stringValue(message.gmail_message_id);
  const existing = db.prepare("SELECT id FROM lead_activity_items WHERE lead_id = :lead_id AND activity_type = 'email' AND related_id = :related_id LIMIT 1")
    .get({ lead_id: leadId, related_id: relatedId } as never) as JsonObject | undefined;
  const id = stringValue(existing?.id || `activity_${randomBytes(8).toString("hex")}`);
  const now = nowUnix();
  const params = {
    id,
    lead_id: leadId,
    owner_email: actorEmail,
    direction: stringValue(message.direction),
    subject: stringValue(message.subject),
    body_text: stringValue(message.body_text || message.snippet),
    related_id: relatedId,
    metadata_json: JSON.stringify({ transport: "gmail", ...message }),
    happened_at: Number(message.happened_at ?? now),
    created_at: now,
    updated_at: now,
    actor: actorEmail
  };
  if (existing) {
    db.prepare(`
      UPDATE lead_activity_items
      SET owner_email = :owner_email, direction = :direction, subject = :subject, body_text = :body_text,
          metadata_json = :metadata_json, happened_at = :happened_at, updated_at = :updated_at, updated_by_email = :actor
      WHERE id = :id
    `).run(params as never);
  } else {
    db.prepare(`
      INSERT INTO lead_activity_items
      (id, lead_id, owner_email, activity_type, direction, subject, body_text, related_id, metadata_json, happened_at, created_at, updated_at, created_by_email, updated_by_email)
      VALUES (:id, :lead_id, :owner_email, 'email', :direction, :subject, :body_text, :related_id, :metadata_json, :happened_at, :created_at, :updated_at, :actor, :actor)
    `).run(params as never);
  }
}

async function writeMatchedMessage(mailboxEmail: string, message: JsonObject, leadIds: string[]) {
  await writeJson(messagePath(mailboxEmail, stringValue(message.gmail_message_id)), { ...message, lead_ids: leadIds, association_status: "matched", updated_at: nowUnix() });
  await rm(unmatchedPath(mailboxEmail, stringValue(message.gmail_message_id)), { force: true });
}

async function writeUnmatchedMessage(mailboxEmail: string, message: JsonObject) {
  await writeJson(unmatchedPath(mailboxEmail, stringValue(message.gmail_message_id)), { ...message, lead_ids: [], association_status: "unmatched", updated_at: nowUnix() });
}

async function listCollection(dir: string, limit = 100) {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });
  const rows: JsonObject[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    rows.push(await readJson<JsonObject>(path.join(dir, entry.name), {}));
  }
  return rows.sort((a, b) => Number(b.happened_at ?? b.started_at ?? 0) - Number(a.happened_at ?? a.started_at ?? 0)).slice(0, limit);
}

async function refreshMailboxCounts(mailboxEmail: string) {
  const state = await readMailboxState(mailboxEmail);
  const messages = await listCollection(path.join(mailboxDir(mailboxEmail), "messages"), 100000);
  const unmatched = await listCollection(path.join(mailboxDir(mailboxEmail), "unmatched"), 100000);
  const runs = await listCollection(path.join(mailboxDir(mailboxEmail), "sync_runs"), 100000);
  await writeMailboxState(mailboxEmail, {
    ...state,
    message_count: messages.length,
    unmatched_count: unmatched.length,
    sync_run_count: runs.length,
    thread_count: new Set(messages.map((row) => stringValue(row.gmail_thread_id)).filter(Boolean)).size
  });
}

export async function syncMailboxForActor(actorEmail: string, options: JsonObject = {}) {
  await ensureLeadDatabase();
  const force = Boolean(options.force);
  const reason = stringValue(options.reason || "background");
  const gmail = await connectedGmailData(actorEmail);
  const mailboxEmail = mailboxEmailForActor(actorEmail, gmail);
  await registerMailbox(actorEmail, gmail);
  const state = await readMailboxState(mailboxEmail);
  const startedAt = nowUnix();
  const runId = `${startedAt}_${randomBytes(4).toString("hex")}`;
  const query = force || !state.initial_sync_complete ? "newer_than:30d" : "newer_than:10d";
  const listed = await googleRequest(actorEmail, "GET", `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(query)}`);
  if (!listed.ok) return listed;
  const messageRefs = Array.isArray(asObject(listed.data).messages) ? asObject(listed.data).messages as JsonObject[] : [];
  let matched = 0;
  let unmatched = 0;
  const index = withLeadDb((db) => leadAddressIndex(db));
  for (const ref of messageRefs) {
    const id = stringValue(ref.id);
    if (!id) continue;
    const fetched = await googleRequest(actorEmail, "GET", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`);
    if (!fetched.ok) continue;
    const record = normalizeMessage(asObject(fetched.data), mailboxEmail, actorEmail);
    const leadIds = leadIdsForMessage(index, record);
    if (leadIds.length) {
      matched += 1;
      await writeMatchedMessage(mailboxEmail, record, leadIds);
      withLeadDb((db) => {
        for (const leadId of leadIds) upsertLeadActivity(db, leadId, actorEmail, record);
      });
    } else {
      unmatched += 1;
      await writeUnmatchedMessage(mailboxEmail, record);
    }
  }
  await writeMailboxState(mailboxEmail, {
    ...state,
    initial_sync_complete: true,
    last_sync_started_at: startedAt,
    last_sync_at: nowUnix(),
    last_sync_status: "ok",
    last_sync_reason: reason,
    history_id: stringValue(gmail.history_id || state.history_id)
  });
  await writeJson(syncRunPath(mailboxEmail, runId), {
    id: runId,
    status: "ok",
    mode: force ? "force" : "recent",
    reason,
    started_at: startedAt,
    finished_at: nowUnix(),
    examined_message_ids: messageRefs.length,
    stored_messages: matched,
    unmatched_messages: unmatched,
    assigned_activities: matched
  });
  await refreshMailboxCounts(mailboxEmail);
  return { ok: true, success: true, mailbox_email: mailboxEmail, examined: messageRefs.length, matched, unmatched };
}

export async function debugSnapshot(actorEmail: string, mailboxKeyValue = "", limit = 150) {
  await mkdir(mailboxRoot(), { recursive: true });
  const entries = await readdir(mailboxRoot(), { withFileTypes: true }).catch(() => []);
  const states: JsonObject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const state = await readJson<JsonObject>(path.join(mailboxRoot(), entry.name, "mailbox.json"), {});
    if (state.mailbox_email) states.push(state);
  }
  const current = await readGmailData(actorEmail);
  const viewerMailbox = mailboxEmailForActor(actorEmail, current);
  const selected = states.find((state) => stringValue(state.mailbox_key) === stringValue(mailboxKeyValue))
    ?? states.find((state) => normalizeEmail(state.mailbox_email) === viewerMailbox)
    ?? states[0]
    ?? null;
  const detail = selected ? await mailboxDetail(selected, limit) : null;
  return {
    viewer: { actor_email: actorEmail, current_mailbox_email: viewerMailbox, can_view_all: true },
    mailboxes: states.map((state) => ({ ...state, lead_count: 0 })),
    selected_mailbox: detail
  };
}

async function mailboxDetail(state: JsonObject, limit: number) {
  const mailboxEmail = normalizeEmail(state.mailbox_email);
  const messages = await listCollection(path.join(mailboxDir(mailboxEmail), "messages"), limit);
  const unmatched = await listCollection(path.join(mailboxDir(mailboxEmail), "unmatched"), limit);
  const runs = await listCollection(path.join(mailboxDir(mailboxEmail), "sync_runs"), 50);
  return {
    summary: state,
    matched_messages: messages,
    unmatched_messages: unmatched,
    inbox: [...messages, ...unmatched].sort((a, b) => Number(b.happened_at ?? 0) - Number(a.happened_at ?? 0)).slice(0, limit),
    sync_runs: runs,
    associated_leads: []
  };
}

export async function syncLeadGmail(actorEmail: string, leadId: string) {
  const sync = await syncMailboxForActor(actorEmail, { force: true, reason: "lead_force_sync" });
  return { ok: true, success: true, sync, lead_id: leadId };
}

export async function cacheSentMessageForLead(actorEmail: string, leadId: string, sent: JsonObject, payload: JsonObject) {
  const gmail = await readGmailData(actorEmail);
  const mailboxEmail = mailboxEmailForActor(actorEmail, gmail);
  const now = nowUnix();
  const record = {
    mailbox_email: mailboxEmail,
    actor_email: normalizeEmail(actorEmail),
    gmail_message_id: stringValue(sent.id || asObject(sent.data).id || payload.gmail_message_id),
    gmail_thread_id: stringValue(sent.threadId || asObject(sent.data).threadId || payload.thread_id),
    subject: stringValue(payload.subject),
    body_text: stringValue(payload.body_text || payload.body),
    from_email: normalizeEmail(actorEmail),
    to: stringValue(payload.to),
    to_emails: extractEmails(payload.to),
    direction: "out",
    read_status: "read",
    happened_at: now,
    association_status: "matched",
    lead_ids: [leadId]
  };
  if (record.gmail_message_id) await writeMatchedMessage(mailboxEmail, record, [leadId]);
  await ensureLeadDatabase();
  withLeadDb((db) => upsertLeadActivity(db, leadId, actorEmail, record));
  await refreshMailboxCounts(mailboxEmail);
}

export async function legacyGmailAction(action: string, body: JsonObject, actorEmail: string) {
  switch (action) {
    case "gmail_connection_status":
    case "google_connection_status":
      return { ok: true, success: true, gmail: await gmailConnectionStatus(actorEmail) };
    case "gmail_disconnect":
    case "google_disconnect":
      return await disconnectGmail(actorEmail);
    case "gmail_background_sync":
      return { ok: true, success: true, sync: await syncMailboxForActor(actorEmail, { reason: "background" }), gmail: await gmailConnectionStatus(actorEmail) };
    case "gmail_debug_snapshot":
      return { ok: true, success: true, debug: await debugSnapshot(actorEmail, stringValue(body.mailbox_key), Math.max(25, Math.min(300, Number(body.limit ?? 150) || 150))) };
    case "lead_sync_gmail":
      return await syncLeadGmail(actorEmail, stringValue(body.lead_id || body.id));
    case "lead_send_email": {
      const sent = await sendGmailMessage(actorEmail, body);
      if (sent.ok && body.lead_id) await cacheSentMessageForLead(actorEmail, stringValue(body.lead_id), sent, body);
      return sent;
    }
    case "lead_bulk_email_bootstrap":
      return { ok: true, success: true, templates: [], users: [], lists: [], stages: [] };
    case "lead_bulk_email_preview":
      return { ok: true, success: true, rows: [], counts: { matched: 0, with_email: 0, existing_thread: 0, ready_to_send: 0, skipped_no_email: 0, skipped_no_gmail: 0, skipped_dnc: 0 } };
    case "lead_bulk_email_send":
      return { ok: true, success: true, results: [], summary: { sent: 0, skipped: 0, errors: 0 } };
    default:
      return { ok: false, success: false, error: "unsupported_gmail_action" };
  }
}
