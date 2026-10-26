// The assistant docked beside Materials settings (the Materials tab's gear and Settings › Materials,
// libraries/apps/materials/settings.js). It is the shared global assistant in a private per-person conversation with
// the subject `materials-settings`; the context below tells it where it is. It edits with the tools it has everywhere
// (price book, suppliers, measurement defaults), under the person's own permissions.
import type { FastifyInstance } from "fastify";
import { hasPermission, requireCapability, requirePlatformAuth, type PlatformAuthContext } from "../platform/auth.js";
import { getAgentsDatabase, createAgentThread } from "../agents/storage.js";
import { forbidden } from "../platform/errors.js";

export const MATERIALS_SETTINGS_SUBJECT = "materials-settings";
// Any of the permissions a Materials settings sub-tab needs (price book and suppliers, calculations, categories).
const PERMISSIONS = ["manage_company_settings", "manage_report_settings", "manage_projects"];

function allowed(ctx: PlatformAuthContext) {
  return PERMISSIONS.some((permission) => hasPermission(ctx, permission));
}

export async function ensureMaterialsSettingsConversation(ctx: PlatformAuthContext) {
  if (!allowed(ctx)) throw forbidden("materials_settings_permission", "Materials settings need permission to manage company settings or projects.");
  await requireCapability(ctx, "apps.assistant");
  return getAgentsDatabase().transaction(async (database) => {
    const existing = await database
      .prepare("SELECT * FROM agent_threads WHERE agent_id=? AND organization_id=? AND created_by_user_id=? AND subject_id=? ORDER BY created_at LIMIT 1")
      .get("assistant", ctx.orgId, ctx.userId, MATERIALS_SETTINGS_SUBJECT);
    return existing || createAgentThread({ agent_id: "assistant", organization_id: ctx.orgId, branch_id: ctx.branchId || "default", subject_id: MATERIALS_SETTINGS_SUBJECT, title: "Materials settings", created_by_user_id: ctx.userId });
  }, `materials-settings-thread:${ctx.orgId}:${ctx.userId}`);
}

export async function materialsSettingsConversationContext(ctx: PlatformAuthContext | null, subject: string) {
  if (subject !== MATERIALS_SETTINGS_SUBJECT) return "";
  if (!ctx) throw forbidden("materials_settings_user", "Sign in to work on materials settings.");
  if (!allowed(ctx)) throw forbidden("materials_settings_permission", "Materials settings need permission to manage company settings or projects.");
  return `## Materials settings
You are docked beside the organization's Materials settings, in the user's private conversation about them. Its sub-tabs are the price book (material costs and optional labor prices), suppliers (who supplies what, at what cost, and delivery fees), calculations (the materials and labor a project gets from its measurement report when no document defines them) and resource categories (the columns on each project's Materials tab). The page context names the open sub-tab; requests are about it unless the user says otherwise. The settings are on screen beside you and reload after you change them, so do not show them again. Read the current values before changing anything, since the user may have edited them by hand. Supplier prices are costs, not sell prices.`;
}

export function registerMaterialsSettingsAssistantApi(app: FastifyInstance) {
  app.post("/organizations/:orgId/settings/conversation", async (request) => {
    const { orgId } = request.params as { orgId: string };
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true });
    return { ok: true, thread: await ensureMaterialsSettingsConversation(ctx) };
  });
}
