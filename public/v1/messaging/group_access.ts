import { hasPermission, requireCapability, type PlatformAuthContext } from "../platform/auth.js";
import { forbidden } from "../platform/errors.js";
import { projectContext, manageCalls } from "../comms/calls/service.js";
import type { CommunicationsJson } from "./communications_storage.js";

export async function requireGroupAccess(ctx: PlatformAuthContext, organizationId: string, record: CommunicationsJson, write = false) {
  if (ctx.orgId !== organizationId) throw forbidden("organization_forbidden", "This session cannot access this organization.");
  if (!hasPermission(ctx, write ? "send_communications|send_comms|manage_company_settings" : "view_comms|send_communications|manage_company_settings")) throw forbidden("group_mms_permission", "You do not have access to this group conversation.");
  await requireCapability(ctx, "apps.comms");
  await requireCapability(ctx, "comms.sms");
  if (!manageCalls(ctx) && String(record.branch_id || "default") !== (ctx.branchId || "default")) throw forbidden("group_mms_branch", "This group belongs to another branch.");
  const context = (record.context || {}) as CommunicationsJson;
  await projectContext(ctx, String(record.project_id || context.project_id || ""));
}
