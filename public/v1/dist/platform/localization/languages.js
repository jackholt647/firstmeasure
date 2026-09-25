import registry from "./languages.json" with { type: "json" };
/** Only reviewed, shipped packs belong here; live message targets are independent. */
export const LANGUAGE_PACKS = registry.packs;
export const SUPPORTED_LOCALES = LANGUAGE_PACKS.map(pack => pack.code);
export const TRANSLATION_LANGUAGES = registry.translation_targets;
export const TRANSLATION_CODES = TRANSLATION_LANGUAGES.map(language => language.code);
export function normalizeTranslationLanguage(value, fallback = "en-US") {
    const code = String(value ?? "").trim().replaceAll("_", "-").toLowerCase();
    if (code === "en")
        return "en-US"; // Preserve legacy explicit English choices.
    return TRANSLATION_CODES.find(candidate => candidate.toLowerCase() === code)
        || TRANSLATION_CODES.find(candidate => candidate === code.split("-")[0])
        || fallback;
}
export function sameMessageLanguage(source, target) {
    // Detection identifies English, not a reliable national spelling variant.
    return source.toLowerCase().split(/[-_]/)[0] === target.toLowerCase().split(/[-_]/)[0];
}
export function resolveTranslationPreference(preferences, companyLocale) {
    const override = preferences.language == null || preferences.language === ""
        ? null : normalizeTranslationLanguage(preferences.language);
    return {
        language: override,
        translation_language: override || normalizeTranslationLanguage(companyLocale),
        company_locale: companyLocale,
        auto_translate_messages: preferences.auto_translate_messages === true
    };
}
