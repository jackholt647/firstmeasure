import { matchesDepartmentNotificationTarget } from "./department-targets.js";
import { resolveOrganizationStructure, departmentIdsForUser } from "../../workforce/organization-structure.js";
import { readEventRecord } from "../../work/storage.js";
// Shared recipient/effective-preference view. Reads do not materialize or replay occurrences.
import type { PlatformAuthContext } from "../auth.js";
import { isAppFlagEnabled } from "../app_flags.js";
import { readDocument, listDocuments } from "../storage.js";
import { categoryForNotification, isMessageInboxNotification, notificationPreferenceEnabled, notificationPresentation } from "../notification_delivery.js";
import { effectivePreferences } from "./configuration.js";
import { baselinePlan, recipientDeliveries } from "./delivery.js";
const NOTIFICATION_COLLECTION = "notifications";
const asObject = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
const normalizeStringArray = (value: unknown): string[] => Array.isArray(value) ? value.map(String).map(v=>v.trim()).filter(Boolean) : [];
function userRoleIds(user: Record<string, unknown>) { const roles = normalizeStringArray(user.roles); return !roles.length && ["owner","admin","super_admin"].includes(String(user.role || "").trim()) ? ["sales_appointments","inside_sales"] : roles; }
function notificationExpired(note: Record<string, unknown>) { const value = String(note.expires_at || note.expiresAt || ""); if (!value) return false; const time = new Date(value).getTime(); return Number.isFinite(time) && time <= Date.now(); }

export async function listMessageInboxNotifications(ctx: PlatformAuthContext): Promise<Record<string, unknown>[]> {
  const result = await listVisibleNotifications(ctx.orgId, ctx.userId, { branchId: ctx.branchId || "default", includeMessageAlerts:true });
  const user = await readDocument(ctx.orgId, "users", ctx.userId);
  const preferences = await effectivePreferences(ctx.orgId, ctx.userId, ctx.branchId || "default", asObject(user.data).notification_preferences);
  return result.notifications.filter(item => isMessageInboxNotification(item) && notificationPreferenceEnabled(preferences, item, "in_app"));
}

export async function listVisibleNotifications(orgId: string, userId: string, options: { includeDismissed?: boolean; branchId?: string; ignorePreferences?: boolean; includeMessageAlerts?: boolean } = {}) {
  if (!options.includeMessageAlerts && !await isAppFlagEnabled(orgId, "apps", "notifications")) return { notifications: [], unread_count: 0, active_count: 0 };
  const measurementsEnabled = await isAppFlagEnabled(orgId, "apps", "firstmeasure");
  const [userDoc, notificationDocs] = await Promise.all([
    readDocument(orgId, "users", userId),
    listDocuments(orgId, NOTIFICATION_COLLECTION)
  ]);
  const user = { id: userId, ...asObject(userDoc.data) };
  const states = asObject(asObject(userDoc.data).notification_state);
  const roles = new Set(userRoleIds(user));
  const departmentIds = notificationDocs.some(row => normalizeStringArray(asObject(row.data).target_department_ids).length) ? departmentIdsForUser(await resolveOrganizationStructure(orgId),userId) : [];
  const rawPreferences = await effectivePreferences(orgId,userId,options.branchId||"default",asObject(userDoc.data).notification_preferences);
  const deliveryRecords = await recipientDeliveries(orgId, userId);
  const notifications = (await Promise.all(notificationDocs.map(async document => {
    const data = asObject(document.data), eventId = String(asObject(data.context).event_id || "");
    const event = eventId ? await readEventRecord(orgId, eventId) : null;
    const payload = asObject(event?.payload);
    // Only bounded routing identifiers; never publish a raw event body.
    return { document, data: event && String(event.type).startsWith("channels.") ? {...data, inbox_event:{type:event.type, channel_id:payload.channel_id, message_id:payload.message_id, seq:payload.seq, parent_id:payload.parent_id}} : data };
  })))
    .filter(({ data }) => String(data.status || "active") === "active")
    .filter(({ document, data }) => {
      if (data.delivery_version !== 2) return true;
      const delivery = deliveryRecords.get(String(data.id || document.id));
      if (!delivery) return false;
      if (options.ignorePreferences) return true;
      return ["in_app","audio","toast","celebration"].some(method=>["available", "presented"].includes(String(asObject(asObject(delivery.methods)[method]).state)));
    })
    .filter(({ data }) => data.delivery_version === 2 || data.passive !== false || isMessageInboxNotification(data))
    .filter(({ data }) => categoryForNotification(data) !== "measurements" || measurementsEnabled)
    .filter(({ data }) => !notificationExpired(data))
    .filter(({ data }) => options.ignorePreferences || data.delivery_version === 2 || notificationPreferenceEnabled(rawPreferences,data,"in_app"))
    .filter(({ data }) => !data.branch_id || String(data.branch_id) === String(options.branchId || "default"))
    .filter(({ data }) => {
      if (normalizeStringArray(data.target_department_ids).length && !matchesDepartmentNotificationTarget(data,userId,[...roles],departmentIds)) return false;
      if (data.delivery_version === 2) return true; // Still recheck current department membership above.
      const targetUserIds = normalizeStringArray(data.target_user_ids);
      const targetRoleIds = normalizeStringArray(data.target_role_ids);
      if (normalizeStringArray(data.target_department_ids).some(id=>departmentIds.includes(id))) return true;
      if (!targetUserIds.length && !targetRoleIds.length && !normalizeStringArray(data.target_department_ids).length) return true;
      if (targetUserIds.includes(userId)) return true;
      return targetRoleIds.some((roleId) => roles.has(roleId));
    })
    .map(({ document, data }) => {
      const state = asObject(states[String(data.id || document.id)]);
      return { ...data, id: String(data.id || document.id), user_state: state, presentation: (() => { const p = notificationPresentation(rawPreferences, data), d = deliveryRecords.get(String(data.id || document.id)); if (!d) return p; const m = asObject(d.methods); return {...p, bell: p.bell && ["available","presented"].includes(String(asObject(m.in_app).state)), sound: asObject(m.audio).state === "available" && baselinePlan(data,rawPreferences).audio?.decision !== "suppress", celebration: asObject(m.celebration).state === "available" && baselinePlan(data,rawPreferences).celebration?.decision !== "suppress", toast: asObject(m.toast).state === "available" && baselinePlan(data,rawPreferences).toast?.decision !== "suppress"}; })(), deliveries: deliveryRecords.get(String(data.id || document.id)), document_revision: document.revision };
    })
    .filter((item) => options.includeDismissed || !item.user_state.dismissed_at && !item.user_state.completed_at)
    .sort((a, b) => String((b as Record<string, unknown>).created_at).localeCompare(String((a as Record<string, unknown>).created_at)));
  return {
    notifications: notifications.filter(item => options.includeMessageAlerts || item.presentation.bell),
    in_app_alerts: options.includeMessageAlerts ? [] : notifications.filter(item => !item.presentation.bell),
    unread_count: notifications.filter((item) => item.presentation.bell && item.presentation.badge && !item.user_state.seen_at).length,
    active_count: notifications.filter(item => item.presentation.bell).length
  };
}

