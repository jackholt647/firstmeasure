import { TRANSLATION_LANGUAGES, normalizeTranslationLanguage, sameMessageLanguage } from "../platform/localization/languages.js";
import { createHash } from "node:crypto";
import { francAll } from "franc-min";
import { env } from "../src/config/env.js";
import { openAIErrorMessage, openAIResponseText, requestOpenAIResponse } from "../src/openai/responses.js";
const ISO3_TO_LANGUAGE = {
    eng: "en", spa: "es", fra: "fr", deu: "de", por: "pt", ita: "it",
    nld: "nl", pol: "pl", rus: "ru", ukr: "uk", ara: "ar", hin: "hi",
    ben: "bn", urd: "ur", cmn: "zh", jpn: "ja", kor: "ko", vie: "vi",
    tha: "th", ind: "id", tgl: "tl", tur: "tr", heb: "he"
};
export const SUPPORTED_LANGUAGES = { en: "English", ...Object.fromEntries(TRANSLATION_LANGUAGES.map(language => [language.code, language.name])) };
const DETECTION_CODES = Object.keys(ISO3_TO_LANGUAGE);
const PLACEHOLDER_PATTERN = /\[\[FM_(?:MENTION|URL|EMAIL)_\d+\]\]/g;
export const normalizeLanguage = normalizeTranslationLanguage;
function lettersOnly(text) {
    return text.replace(/https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|@\S+/g, " ").replace(/[^\p{L}\p{M}\s]/gu, " ").replace(/\s+/g, " ").trim();
}
export function detectMessageLanguage(textValue) {
    const text = lettersOnly(String(textValue ?? ""));
    const letterCount = (text.match(/\p{L}/gu) || []).length;
    if (letterCount < 3)
        return { code: "und", confidence: 0 };
    const scripted = [
        [/\p{Script=Hiragana}|\p{Script=Katakana}/u, "ja"],
        [/\p{Script=Hangul}/u, "ko"],
        [/\p{Script=Han}/u, "zh"],
        [/\p{Script=Arabic}/u, "ar"],
        [/\p{Script=Devanagari}/u, "hi"],
        [/\p{Script=Bengali}/u, "bn"],
        [/\p{Script=Thai}/u, "th"],
        [/\p{Script=Hebrew}/u, "he"]
    ];
    for (const [pattern, code] of scripted) {
        if (pattern.test(text))
            return { code, confidence: 1 };
    }
    // Franc is a local trigram classifier. Restricting the candidate set to the
    // languages FirstMate can translate prevents obscure false positives.
    const ranked = francAll(text, { only: DETECTION_CODES, minLength: 3 });
    const [best, second] = ranked;
    if (!best || best[0] === "und")
        return { code: "und", confidence: 0 };
    const confidence = Math.max(0, Math.min(1, Number(best[1]) - Number(second?.[1] ?? 0) + 0.5));
    // Very short Latin-script notes are frequently names, SKUs, or ambiguous
    // acknowledgements. Leave them unknown rather than showing a wrong button.
    if (letterCount < 6 || (letterCount < 12 && confidence < 0.62))
        return { code: "und", confidence };
    return { code: ISO3_TO_LANGUAGE[best[0]] || "und", confidence };
}
export function translationSourceHash(text) {
    return createHash("sha256").update(text).digest("hex");
}
function protectTokens(text, mentionUsers) {
    const replacements = new Map();
    let index = 0;
    const protect = (value, kind) => {
        const token = `[[FM_${kind}_${++index}]]`;
        replacements.set(token, value);
        return token;
    };
    let protectedText = text.replace(/https?:\/\/[^\s]+/g, (value) => protect(value, "URL"));
    protectedText = protectedText.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, (value) => protect(value, "EMAIL"));
    const mentions = mentionUsers
        .map((user) => String(user.name ?? "").trim())
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
    for (const name of mentions) {
        const literal = `@${name}`;
        protectedText = protectedText.split(literal).join(protect(literal, "MENTION"));
    }
    return { protectedText, replacements };
}
function restoreTokens(text, replacements) {
    return text.replace(PLACEHOLDER_PATTERN, (token) => replacements.get(token) ?? token);
}
export async function translateMessageText(input) {
    const sourceLanguage = input.sourceLanguage === "en" ? "en" : normalizeLanguage(input.sourceLanguage, "und");
    const targetLanguage = normalizeLanguage(input.targetLanguage, "en-US");
    if (sameMessageLanguage(sourceLanguage, targetLanguage))
        return input.text;
    const { protectedText, replacements } = protectTokens(input.text, input.mentionUsers ?? []);
    const result = await requestOpenAIResponse({
        model: env.openaiTranslationModel,
        reasoning: { effort: "none" },
        store: false,
        max_output_tokens: Math.min(4_000, Math.max(160, input.text.length * 2)),
        instructions: [
            translationDirection(sourceLanguage, targetLanguage),
            "Return only the translated message, with the same paragraph and line-break structure.",
            "Preserve every [[FM_*]] placeholder exactly and do not translate it.",
            "Preserve emoji, numbers, measurements, product names, and formatting.",
            "Do not add commentary or quotation marks."
        ].join(" "),
        input: protectedText
    }, { timeoutMs: env.openaiTranslationTimeoutMs });
    if (!result.ok)
        throw new Error(openAIErrorMessage(result, "Translation failed."));
    const translated = openAIResponseText(result.json);
    if (!translated)
        throw new Error("Translation returned no text.");
    const expectedTokens = [...replacements.keys()];
    if (expectedTokens.some((token) => !translated.includes(token))) {
        throw new Error("Translation could not safely preserve message references.");
    }
    return restoreTokens(translated, replacements);
}
export function translationDirection(source, target) {
    const spelling = target === "en-GB" ? " Use British English spelling and phrasing." : target === "en-US" ? " Use American English spelling and phrasing." : "";
    return `Translate the message from ${SUPPORTED_LANGUAGES[source] ?? source} to ${SUPPORTED_LANGUAGES[target] ?? target}.` + spelling;
}
