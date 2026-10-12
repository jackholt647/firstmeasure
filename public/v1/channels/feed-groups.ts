import { z } from "zod";
import { type PlatformAuthContext } from "../platform/auth.js";
import { conflict, forbidden, notFound } from "../platform/errors.js";
import { readDocument, upsertDocument } from "../platform/storage.js";
import { resolveOrganizationStructure } from "../workforce/organization-structure.js";

import { canManageFeed, canViewAllFeedDepartments } from "./feed-permissions.js";
import { listWorkEventDefinitions, workEventDefinition } from "../work/events.js";
import { eventGroups } from "../platform/notification_catalog.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";

export const defaultFeedPostActivityTypes = ["media.uploaded", "note.created", "project.created", "project.event_scheduled", "crew.checklist.completed", "payment.received"];

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
  const labels: Record<string, string> = {"proposal.signed":"Proposal signed", "contract.signed":"Contract signed", "project.event.completed":"Scheduled event completed", "work.node.completed":"Task or stage completed", "work.plan.completed":"Scope completed", "work.plan.started":"Scope started", "work.plan.stage_manually_set":"Stage moved manually"};
  const types = listWorkEventDefinitions().filter(event => event.visibility === "activity").map(event => event.name);
  // Keep legacy selections compatible while canonical signing uses document.signed.
  return [...new Set([...types,"proposal.signed","contract.signed",...extraTypes.filter(Boolean)])].sort().map(type => ({ type, label: labels[type] || type.split(/[._]/).map(part => part[0]?.toUpperCase() + part.slice(1)).join(" "), description:workEventDefinition(type).description, group:workEventDefinition(type).notification.group }));
}

export async function configuredFeedActivityOptions(ctx: PlatformAuthContext, observed: string[], saved: string[] = []) {
  const existing = new Set([...observed,...saved]);
  const enabled = new Map<string, Promise<boolean>>();
  return (await Promise.all(feedActivityOptions([...existing]).map(async option => {
    const app = eventGroups[option.type.split('.')[0]!]?.app;
    if (!app) return option;
    if (!enabled.has(app)) enabled.set(app,isAppFlagEnabled(ctx.orgId,'apps',app));
    return await enabled.get(app) || existing.has(option.type) ? option : null;
  }))).filter((option): option is NonNullable<typeof option> => option !== null);
}
