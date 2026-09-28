import { companyLocalization } from "./settings.js";
import { resolveTranslationPreference } from "./languages.js";

export async function messageTranslationPreferences(orgId: string, branchId: string, preferences: Record<string, unknown>) {
  const { context } = await companyLocalization(orgId, branchId);
  return resolveTranslationPreference(preferences, context.locale);
}
