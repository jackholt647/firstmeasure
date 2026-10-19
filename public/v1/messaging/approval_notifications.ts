import { createHash } from "node:crypto";
import { backgroundAuthContext, hasPermission } from "../platform/auth.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { listDocuments, readOrganization } from "../platform/storage.js";
import type { SmsComplianceProfile } from "./storage.js";
import { getCommunicationsDatabase } from "./communications_storage.js";

const text = (value: unknown) => String(value ?? "").trim();

export function smsCampaignApproval(profile: SmsComplianceProfile) {
  const campaignId = text(profile.provider_refs.telnyx_campaign_id);
  return text(profile.campaign_status).toLowerCase() === "mno_provisioned"
    && !!campaignId && !campaignId.startsWith("mock_")
    && !["deactivated", "deactivation_pending"].includes(text(profile.status).toLowerCase())
    && !profile.events.some(event => event.mock === true && ["brand_submitted", "campaign_submitted"].includes(text(event.type)));
}

/** Called after persisted carrier updates. Stable campaign/branch IDs make webhook and poll replay safe. */
export async function notifySmsCampaignApproved(profile: SmsComplianceProfile) {
  if (!smsCampaignApproval(profile)) return;
  const orgId = profile.external_organization_id;
  const organization = await readOrganization(orgId).catch(error => {
    if (["not_found", "organization_not_found"].includes(error?.code)) return null;
    throw error;
  });
  if (!organization || !await isAppFlagEnabled(orgId, "platform", "sms_settings")) return;
  const audiences = new Map<string, string[]>();
  for (const user of await listDocuments(orgId, "users")) {
    if (user.data.disabled === true || user.data.deleted === true || ["disabled", "inactive", "removed"].includes(text(user.data.status))) continue;
    const auth = await backgroundAuthContext(orgId, user.id).catch(() => null);
    if (!auth || !hasPermission(auth, "manage_company_settings")) continue;
    const branch = auth.branchId || "default";
    audiences.set(branch, [...(audiences.get(branch) || []), user.id]);
  }
  if (!audiences.size) return;
  const business = text(organization.name) || text(profile.brand.displayName) || "Your business";
  const campaignId = text(profile.provider_refs.telnyx_campaign_id);
  const { createPlatformNotification } = await import("../platform/api.js");
  for (const [branch, users] of audiences) {
    const id = "sms_approved_" + createHash("sha256").update(JSON.stringify([orgId, profile.id, campaignId, branch])).digest("hex").slice(0, 32);
    await createPlatformNotification(orgId, {
      id, title: "SMS registration approved", source: "sms_registration", kind: "sms_registration_approved",
      category: "system", preference_key: "sms_registration.approved",
      preference_defaults: { in_app: true, push: false }, delivery_methods: ["in_app", "email"],
      body: `${business}'s SMS campaign has been approved by the carriers. Open Settings > Phone Settings > SMS registration to view your registration and number activation status.`,
      target_user_ids: users, branch_id: branch, passive: true, push: false,
      frontend_action: { kind: "open_sms_registration" },
      context: { compliance_profile_id: profile.id, campaign_id: campaignId }
    });
  }
}

let approvalCursor = "";
/** Bounded recovery for a crash between committing approval and enqueuing its notification. */
export async function recoverSmsApprovalNotifications(limit = 50) {
  const rows = await getCommunicationsDatabase().prepare("SELECT id, data_json FROM sms_compliance_profiles WHERE id > ? ORDER BY id LIMIT ?").all(approvalCursor, limit);
  for (const row of rows) {
    // Approval routing needs only nonsensitive status, provider references and organization ID.
    const profile = JSON.parse(String(row.data_json)) as SmsComplianceProfile;
    if (profile.events.some(event => event.approval_notification_campaign_id === profile.provider_refs.telnyx_campaign_id)) {
      await notifySmsCampaignApproved(profile);
    }
    approvalCursor = String(row.id);
  }
  if (rows.length < limit) approvalCursor = "";
}
