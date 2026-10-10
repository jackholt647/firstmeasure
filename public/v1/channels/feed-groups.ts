import { z } from "zod";
import { type PlatformAuthContext } from "../platform/auth.js";
import { conflict, forbidden, notFound } from "../platform/errors.js";
import { readDocument, upsertDocument } from "../platform/storage.js";
import { resolveOrganizationStructure } from "../workforce/organization-structure.js";

import { canManageFeed, canViewAllFeedDepartments } from "./feed-permissions.js";

export const defaultFeedPostActivityTypes = ["media.uploaded", "note.created", "project.created", "project.event_scheduled", "crew.checklist.completed", "payment.received"];

const activityTypes = [
  "payment.received", "payment.refunded", "proposal.payment.received", "document.payment.received",
  "invoice.created", "invoice.sent", "expense.recorded", "receipt.uploaded",
  "proposal.created", "proposal.sent", "proposal.viewed", "proposal.signed",
  "document.sent", "document.opened", "document.viewed", "document.signed", "document.completed", "document.declined", "document.ingested",
  "contract.opened", "contract.viewed", "contract.signed", "call.completed",
  "communication.sent", "communication.received", "communication.auto_replied", "media.uploaded", "media.shared",
  "project.created", "project.contact.attached", "project.event_scheduled", "project.event.started", "project.event.completed",
  "material.delivery.completed", "material.order.placed", "crew.clock.in", "crew.clock.out", "crew.checklist.completed",
  "measurement.report.ordered", "measurement.report.completed", "note.created", "portal.visited", "feedback.request.sent",
  "work.plan.stage_manually_set"
] as const;

const settingsSchema = z.object({
  company_activity_types: z.array(z.string().max(120)).max(200).nullable().default(null),
  department_activity_types: z.record(z.string().max(120), z.array(z.string().max(120)).max(200)).default({})
}).strict();
const saveSchema = settingsSchema.extend({ revision: z.number().int().nonnegative() }).strict();

export async function feedGroupDirectory(orgId: string) {
  const structure = await resolveOrganizationStructure(orgId);
  const userDepartments = Object.fromEntries(structure.users.map(user => [user.id, user.department_ids]));
  return { departments: structure.catalog.departments.filter(department => department.status === "active").map(({ id, label, color }) => ({ id, label, color })), user_departments: userDepartments };
}

export function allowedFeedDepartments(directory: Awaited<ReturnType<typeof feedGroupDirectory>>, userId: string) {
  return directory.user_departments[userId] || [];
}

export function requireFeedDepartment(directory: Awaited<ReturnType<typeof feedGroupDirectory>>, userId: string, departmentId: string, ctx?: PlatformAuthContext) {
  if (!directory.departments.some(department => department.id === departmentId)) throw notFound("feed_department_missing", "This department does not exist.");
  if (!(ctx && canViewAllFeedDepartments(ctx)) && !allowedFeedDepartments(directory, userId).includes(departmentId)) throw forbidden("feed_department_denied", "You are not a member of this department.");
}

export async function readFeedPostSettings(orgId: string) {
  const stored = await readDocument(orgId, "organization_feed_settings", "posts").catch((error: { statusCode?: number }) => {
    if (error.statusCode === 404) return null;
    throw error;
  });
  return { ...settingsSchema.parse(stored?.data || {}), revision: Number(stored?.revision || 0) };
}

export async function saveFeedPostSettings(ctx: PlatformAuthContext, input: unknown) {
  if (!canManageFeed(ctx)) throw forbidden("feed_settings_denied", "Feed manager permission is required.");
  const body = saveSchema.parse(input);
  const current = await readFeedPostSettings(ctx.orgId);
  if (current.revision !== body.revision) throw conflict("feed_settings_stale", "Feed settings changed. Reload before saving.");
  const directory = await feedGroupDirectory(ctx.orgId);
  const departmentIds = new Set(directory.departments.map(department => department.id));
  if (Object.keys(body.department_activity_types).some(id => !departmentIds.has(id))) throw notFound("feed_department_missing", "A department no longer exists.");
  const { revision, ...data } = body;
  try {
    await upsertDocument(ctx.orgId, "organization_feed_settings", { id: "posts", data, expected_revision: revision }, { replace: true, createOnly: revision === 0 });
  } catch (error) {
    if ((error as { statusCode?: number }).statusCode === 409) throw conflict("feed_settings_stale", "Feed settings changed. Reload before saving.");
    throw error;
  }
  return readFeedPostSettings(ctx.orgId);
}

export function feedActivityOptions(extraTypes: string[] = []) {
  const labels: Record<string, string> = {"proposal.signed":"Proposal signed", "contract.signed":"Contract signed", "project.event.completed":"Job completed"};
  return [...new Set([...activityTypes,...extraTypes.filter(Boolean)])].sort().map(type => ({ type, label: labels[type] || type.split(/[._]/).map(part => part[0]?.toUpperCase() + part.slice(1)).join(" ") }));
}
