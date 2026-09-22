export type SmsComplianceRuleProfile = Record<string, unknown>;

const PURPOSES_BY_REGISTERED_USECASE: Readonly<Record<string, readonly string[]>> = {
  ACCOUNT_NOTIFICATION: ["account_notification"],
  CUSTOMER_CARE: ["customer_care"],
  DELIVERY_NOTIFICATION: ["delivery_notification"],
  FRAUD_ALERT: ["fraud_alert"],
  HIGHER_EDUCATION: ["higher_education"],
  MARKETING: ["marketing"],
  POLLING_VOTING: ["polling_voting"],
  PUBLIC_SERVICE_ANNOUNCEMENT: ["public_service_announcement"],
  SECURITY_ALERT: ["security_alert"],
  "2FA": ["two_factor_auth"]
};

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function outboundSmsComplianceIssue(profile: SmsComplianceRuleProfile | null | undefined, purposeValue: unknown, textValue: unknown) {
  if (!profile) return { code: "sms_campaign_not_active", message: "No active registered SMS campaign is available for this organization." };
  const campaign = asObject(profile.campaign);
  const brand = asObject(profile.brand);
  const purpose = cleanText(purposeValue || "customer_care").toLowerCase();
  const usecase = cleanText(campaign.usecase).toUpperCase();
  const configuredFeatures = Array.isArray(campaign.enabledFeatures) ? campaign.enabledFeatures.map((value) => cleanText(value)) : [];
  const allowed = new Set<string>();

  if (["AGENTS_FRANCHISES", "MIXED", "SOLE_PROPRIETOR"].includes(usecase)) {
    if (configuredFeatures.includes("crm_conversations")) allowed.add("customer_care");
    if (configuredFeatures.includes("operations")) {
      for (const value of ["transactional", "appointment", "project_update", "billing"]) allowed.add(value);
    }
    if (configuredFeatures.includes("customer_growth")) allowed.add("marketing");
  } else {
    for (const value of PURPOSES_BY_REGISTERED_USECASE[usecase] ?? []) allowed.add(value);
  }

  if (!allowed.has(purpose)) {
    return { code: "sms_purpose_not_registered", message: `The active 10DLC campaign does not cover SMS purpose '${purpose}'.` };
  }
  if (purpose === "marketing") {
    const text = cleanText(textValue);
    const brandName = cleanText(brand.displayName || brand.companyName);
    if (!brandName || !text.toLowerCase().includes(brandName.toLowerCase())) {
      return { code: "sms_marketing_identity_required", message: "Marketing SMS must identify the registered business name." };
    }
    if (!/\bSTOP\b/i.test(text)) {
      return { code: "sms_marketing_optout_required", message: "Marketing SMS must include STOP opt-out instructions." };
    }
  }
  return null;
}

export function smsConsentPurposesAllow(purposesValue: unknown, purposeValue: unknown) {
  const purposes = Array.isArray(purposesValue) ? purposesValue.map((value) => cleanText(value).toLowerCase()) : [];
  const purpose = cleanText(purposeValue || "customer_care").toLowerCase();
  return purposes.includes(purpose);
}
