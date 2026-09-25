import { companyLocalization } from "./settings.js";
import { resolveTranslationPreference } from "./languages.js";
export async function messageTranslationPreferences(orgId, branchId, preferences) {
    const { context } = await companyLocalization(orgId, branchId);
    return resolveTranslationPreference(preferences, context.locale);
}
