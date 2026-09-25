import type { ProjectManifest } from "./storage.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { createPlatformNotification } from "../platform/api.js";
import { listDocuments } from "../platform/storage.js";

type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const clean = (value: unknown) => String(value ?? "").trim();
const email = (value: unknown) => clean(value).toLowerCase();
const sentAt = (manifest: Json) => clean(manifest.report_sent_at || object(manifest.delivery).report_sent_at);
const revisedAt = (manifest: Json) => clean(object(manifest.delivery).rework_report_sent_at);

export type MeasurementNotificationEvent = "report_delivered" | "report_revised" | "report_canceled" | "report_rejected" | "report_status";
export function measurementNotificationTransition(previous: Json, current: Json): { event: MeasurementNotificationEvent; status: string } | null {
  if (revisedAt(current) && revisedAt(previous) !== revisedAt(current)) return { event: "report_revised", status: "revised" };
  if (!sentAt(previous) && sentAt(current)) return { event: "report_delivered", status: "delivered" };
  const before = clean(previous.status).toLowerCase();
  const after = clean(current.status).toLowerCase();
  if (!after || before === after) return null;
  if (after === "cancelled" || after === "canceled") return { event: "report_canceled", status: "canceled" };
  if (after === "rejected" || after === "rejected_no_coverage") return { event: "report_rejected", status: "rejected" };
  if (after === "queued" || after === "processing") return { event: "report_status", status: after };
  return null;
}

export async function publishMeasurementNotification(previous: ProjectManifest, current: ProjectManifest) {
  const transition = measurementNotificationTransition(previous, current);
  if (!transition) return;
  const orgId = clean(object(current.organization_ref).id || current.organization_id).toLowerCase();
  if (!orgId || !await isAppFlagEnabled(orgId, "apps", "notifications") || !await isAppFlagEnabled(orgId, "apps", "firstmeasure")) return;
  const recipients = new Set([
    email(object(current.issuer).email), email(object(current.owner_ref).email), email(current.owner_email),
    ...(["report_delivered", "report_revised"].includes(transition.event) && Array.isArray(current.cc_emails) ? current.cc_emails.map(email) : [])
  ].filter(Boolean));
  if (!recipients.size) return;
  const users = await listDocuments(orgId, "users");
  const userIds = users.filter((doc) => {
    const user = object(doc.data);
    return user.disabled !== true && user.deleted !== true && recipients.has(email(user.email || object(user.profile).email));
  }).map((doc) => doc.id);
  if (!userIds.length) return;
  const projectId = clean(current.id);
  if (!projectId) return;
  const address = clean(current.address) || "your property";
  const copy = {
    report_delivered: ["Measurement report delivered", `Your measurement report for ${address} is ready.`],
    report_revised: ["Corrected measurement report delivered", `A corrected measurement report for ${address} is ready.`],
    report_canceled: ["Measurement order canceled", `Your measurement order for ${address} was canceled.`],
    report_rejected: ["Measurement order could not be completed", `Your measurement order for ${address} could not be completed. Open the order for details.`],
    report_status: ["Measurement order update", `Your measurement order for ${address} is ${transition.status}.`]
  }[transition.event];
  await createPlatformNotification(orgId, {
    id: `notification_measurements_${transition.event}_${transition.status}_${projectId}${transition.event === "report_revised" ? `_${revisedAt(current).replace(/[^0-9a-z]/gi, "")}` : ""}`,
    title: copy[0], body: copy[1], kind: "firstmeasure_report", source: "firstmeasure",
    category: "measurements", preference_key: `measurements.${transition.event}`,
    target_user_ids: userIds, branch_id: clean(current.branch_id || object(current.team_ref).branch_id || object(current.team_ref).id) || "default",
    context: { project_id: projectId, report_status: transition.status },
    frontend_action: { kind: "open_measurement_report", project_id: projectId }, push: true
  });
}
