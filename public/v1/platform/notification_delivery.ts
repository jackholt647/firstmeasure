import { createHash, createPrivateKey, sign } from "node:crypto";
import { connect } from "node:http2";
import { GoogleAuth } from "google-auth-library";
import { badRequest } from "./errors.js";
import { isAppFlagEnabled } from "./app_flags.js";
import { deleteDocument, listDocuments, readDocument, upsertDocument } from "./storage.js";

import { builtInEventDefinitions, notificationCatalog, catalogDefinitions } from "./notification_catalog.js";

type Json = Record<string, unknown>;
export const notificationCategories = ["leads", "messages", "mentions", "tasks", "scheduling", "payments", "celebrations", "measurements", "system"] as const;
export type NotificationCategory = typeof notificationCategories[number];
const categorySet = new Set<string>(notificationCategories);
export const measurementNotificationEvents = ["report_delivered", "report_revised", "report_canceled", "report_rejected", "report_status"] as const;
const preferenceKeys = new Set<string>([...builtInEventDefinitions().map(d=>d.key), ...notificationCategories, ...measurementNotificationEvents.map((event) => `measurements.${event}`)]);
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
const pushTitle = (note: Json) => String(note.title || "Notification").slice(0, 140);
const pushBody = (note: Json) => String(note.body || "").slice(0, 500);

export function categoryForNotification(note: Json): NotificationCategory {
  const explicit = String(note.category || "").trim().toLowerCase();
  if (categorySet.has(explicit)) return explicit as NotificationCategory;
  const kind = String(note.kind || "").toLowerCase();
  const source = String(note.source || "").toLowerCase();
  if (kind === "celebration") return "celebrations";
  if (/firstmeasure|measurement/.test(kind + source)) return "measurements";
  if (/mention/.test(kind + source)) return "mentions";
  if (/lead/.test(kind + source)) return "leads";
  if (/comms|chat|channel|message|draft/.test(kind + source)) return "messages";
  if (/appointment|schedule|reschedule/.test(kind + source)) return "scheduling";
  if (/payment|billing|merchant|payout/.test(kind + source)) return "payments";
  if (/task|todo|work|due|followup/.test(kind + source)) return "tasks";
  return "system";
}

export function preferenceKeyForNotification(note: Json): string {
  const key = String(note.preference_key || "").trim().toLowerCase();
  return preferenceKeys.has(key) || /^workflow\.[a-f0-9]{64}$/.test(key) ? key : categoryForNotification(note);
}

export type NotificationPreferences = { in_app: Record<string, boolean>; push: Record<string, boolean> };
export function normalizeNotificationPreferences(raw: unknown): NotificationPreferences {
  const value = object(raw);
  const inApp = object(value.in_app);
  const push = object(value.push);
  return {
    in_app: Object.fromEntries([...preferenceKeys, ...Object.keys(inApp).filter(k=>/^workflow\.[a-f0-9]{64}$/.test(k))].map((key) => [key, key.startsWith("event.") ? inApp[key] === true : inApp[key] !== false])),
    push: Object.fromEntries([...preferenceKeys, ...Object.keys(push).filter(k=>/^workflow\.[a-f0-9]{64}$/.test(k))].map((key) => [key, key.startsWith("event.") || key.startsWith("workflow.") || key === "celebrations" || key === "measurements.report_status" ? push[key] === true : push[key] !== false]))
  };
}

export function notificationPreferenceEnabled(raw:unknown, note:Json, surface:"in_app"|"push") {
 const key=preferenceKeyForNotification(note);
 if(key.startsWith("workflow.")){const explicit=object(object(raw)[surface])[key];return typeof explicit === "boolean" ? explicit : object(object(raw)[surface])[categoryForNotification(note)] === false ? false : object(note.preference_defaults)[surface] === true;}
 return normalizeNotificationPreferences(raw)[surface][key] === true;
}

export async function saveNotificationPreferences(orgId: string, userId: string, patch: Json, branch="default") {
  const allowed=new Set(catalogDefinitions(await notificationCatalog(orgId,branch)).map(d=>d.key));
  const doc = await readDocument(orgId, "users", userId);
  const data = object(doc.data);
  const current = {in_app:{...object(object(data.notification_preferences).in_app)},push:{...object(object(data.notification_preferences).push)}};
  for (const surface of ["in_app", "push"] as const) {
    const updates = object(patch[surface]);
    for (const [key, enabled] of Object.entries(updates)) {
      if (!allowed.has(key) || typeof enabled !== "boolean") throw badRequest("invalid_notification_preference", "Use a known notification setting and a boolean value.");
      current[surface][key] = enabled;
    }
  }
  await upsertDocument(orgId, "users", { id: userId, data: { ...data, notification_preferences: { ...object(data.notification_preferences), ...current, ...(Array.isArray(patch.custom_keys) ? {custom_keys: [...new Set([...strings(object(data.notification_preferences).custom_keys), ...strings(patch.custom_keys).filter(k=>allowed.has(k))])]} : {}) } }, metadata: doc.metadata, expected_revision: doc.revision }, { replace: true });
  return current;
}

export async function registerNotificationDevice(orgId: string, userId: string, input: Json) {
  const platform = String(input.platform || "").toLowerCase();
  const token = String(input.token || "").trim();
  if (!["android", "ios"].includes(platform) || !/^[a-zA-Z0-9:_\-.]{32,4096}$/.test(token)) throw badRequest("invalid_push_device", "A valid Android or iOS push token is required.");
  const id = `device_${createHash("sha256").update(`${platform}:${token}`).digest("hex")}`;
  const data = { user_id: userId, platform, token, active: true, branch_id: String(input.branch_id || "default"), environment: input.environment === "sandbox" ? "sandbox" : "production", updated_at: new Date().toISOString() };
  await upsertDocument(orgId, "notification_devices", { id, data, metadata: { kind: "notification_device" } }, { replace: true });
  return { id, platform, active: true };
}

export async function unregisterNotificationDevice(orgId: string, userId: string, deviceId: string) {
  const doc = await readDocument(orgId, "notification_devices", deviceId);
  if (object(doc.data).user_id !== userId) throw badRequest("invalid_push_device", "This device is not registered to your account.");
  await deleteDocument(orgId, "notification_devices", deviceId);
}

async function sendAndroid(token: string, note: Json, category: NotificationCategory, environment: string) {
  const development = environment === "sandbox";
  const projectId = String((development && process.env.FIREBASE_DEVELOPMENT_PROJECT_ID) || process.env.FIREBASE_PROJECT_ID || "").trim();
  const credentialsJson = String((development && process.env.FIREBASE_DEVELOPMENT_SERVICE_ACCOUNT_JSON) || process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!projectId || !credentialsJson) return "unconfigured";
  const credentials = JSON.parse(credentialsJson);
  const auth = new GoogleAuth({ credentials, scopes: ["https://www.googleapis.com/auth/firebase.messaging"] });
  const client = await auth.getClient();
  const access = await client.getAccessToken();
  if (!access.token) return "auth_failed";
  const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/messages:send`, {
    method: "POST", headers: { authorization: `Bearer ${access.token}`, "content-type": "application/json" },
    body: JSON.stringify({ message: {
      token,
      notification: { title: pushTitle(note), body: pushBody(note) },
      data: { notification_id: String(note.id || ""), category },
      android: { notification: { channel_id: `firstmate_${category}`, tag: String(note.id || "") } }
    } }),
    signal: AbortSignal.timeout(10000)
  });
  if (response.ok) return "sent";
  const failure = await response.json().catch(() => ({})) as Json;
  const details = JSON.stringify(failure);
  return /UNREGISTERED/.test(details) ? "invalid_token" : `provider_${response.status}`;
}

async function sendIos(token: string, note: Json, category: NotificationCategory, environment: string) {
  const key = String(process.env.APNS_AUTH_KEY_P8 || "").replace(/\\n/g, "\n");
  const keyId = String(process.env.APNS_KEY_ID || "");
  const teamId = String(process.env.APNS_TEAM_ID || "");
  const topic = String((environment === "sandbox" && process.env.APNS_DEVELOPMENT_BUNDLE_ID) || process.env.APNS_BUNDLE_ID || (environment === "sandbox" ? "ai.firstmeasure.mobile.dev" : "ai.firstmeasure.mobile"));
  if (!key || !keyId || !teamId) return "unconfigured";
  const base64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${base64({ alg: "ES256", kid: keyId })}.${base64({ iss: teamId, iat: Math.floor(Date.now() / 1000) })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: createPrivateKey(key), dsaEncoding: "ieee-p1363" }).toString("base64url");
  const host = environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com";
  const session = connect(host);
  try {
    return await new Promise<string>((resolve, reject) => {
      const request = session.request({ ":method": "POST", ":path": `/3/device/${token}`, authorization: `bearer ${unsigned}.${signature}`, "apns-topic": topic, "apns-push-type": "alert", "apns-priority": "10" });
      const timer = setTimeout(() => { request.close(); reject(new Error("APNs timeout")); }, 10000);
      let status = 0;
      let body = "";
      request.on("response", (headers) => { status = Number(headers[":status"] || 0); });
      request.on("data", (chunk) => { body += String(chunk).slice(0, 1024); });
      request.on("end", () => { clearTimeout(timer); resolve(status === 200 ? "sent" : status === 410 || /BadDeviceToken|Unregistered/.test(body) ? "invalid_token" : `provider_${status}`); });
      request.on("error", (error) => { clearTimeout(timer); reject(error); });
      session.on("error", (error) => { clearTimeout(timer); reject(error); });
      request.end(JSON.stringify({ aps: { alert: { title: pushTitle(note), body: pushBody(note) }, category: `FIRSTMATE_${category.toUpperCase()}`, "thread-id": category, "interruption-level": "active" }, notification_id: String(note.id || ""), category }));
    });
  } finally { session.close(); }
}

export async function deliverNotificationPush(orgId: string, note: Json) {
  if (note.push !== true) return [];
  if (!await isAppFlagEnabled(orgId, "apps", "notifications")) return [];
  const category = categoryForNotification(note);
  if (category === "measurements" && !await isAppFlagEnabled(orgId, "apps", "firstmeasure")) return [];
  const targetUsers = new Set(strings(note.target_user_ids));
  const targetRoles = new Set(strings(note.target_role_ids));
  const [users, devices] = await Promise.all([listDocuments(orgId, "users"), listDocuments(orgId, "notification_devices")]);
  const eligible = new Set(users.filter((doc) => {
    const user = object(doc.data);
    if (user.disabled === true || user.deleted === true) return false;
    const roles = strings(user.roles);
    if (!roles.length && ["owner", "admin", "super_admin"].includes(String(user.role || ""))) roles.push("inside_sales", "sales_appointments");
    return (targetUsers.size === 0 && targetRoles.size === 0 || targetUsers.has(doc.id) || roles.some((role) => targetRoles.has(role)))
      && notificationPreferenceEnabled(user.notification_preferences,note,"push");
  }).map((doc) => doc.id));
  const log: Json[] = [];
  for (const doc of devices) {
    const device = object(doc.data);
    if (!eligible.has(String(device.user_id || "")) || device.active === false || String(device.branch_id || "default") !== String(note.branch_id || "default")) continue;
    let status: string;
    try { status = device.platform === "android" ? await sendAndroid(String(device.token), note, category, String(device.environment || "production")) : await sendIos(String(device.token), note, category, String(device.environment || "production")); }
    catch (error) { status = "error"; console.error("notification push delivery failed", error instanceof Error ? error.message : "unknown error"); }
    log.push({ user_id: device.user_id, device_id: doc.id, platform: device.platform, category, status, at: new Date().toISOString() });
    if (status === "invalid_token") await deleteDocument(orgId, "notification_devices", doc.id);
  }
  return log;
}
