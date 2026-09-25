import assert from "node:assert/strict";
import test from "node:test";
import { LANGUAGE_PACKS, SUPPORTED_LOCALES, TRANSLATION_CODES, normalizeTranslationLanguage, resolveTranslationPreference, sameMessageLanguage } from "../platform/localization/languages.js";
import { localeSchema } from "../platform/localization/settings.js";
import { reportPreferencesSchema } from "../firstmeasure/report_preferences.js";
import { detectMessageLanguage, translationDirection, translateMessageText } from "../channels/translation.js";

test("interface and company reports validate the same installed language registry", () => {
  assert.deepEqual(SUPPORTED_LOCALES, LANGUAGE_PACKS.map(pack => pack.code));
  for (const locale of SUPPORTED_LOCALES) {
    assert.equal(localeSchema.parse(locale), locale);
    assert.equal(reportPreferencesSchema.parse({report_language:locale}).report_language, locale);
  }
  assert.ok(TRANSLATION_CODES.includes("fr"));
  assert.equal(localeSchema.safeParse("fr").success,false);
  assert.equal(reportPreferencesSchema.safeParse({report_language:"fr"}).success,false);
});

test("translation inherits company language independently of interface overrides", () => {
  assert.equal(resolveTranslationPreference({interface_locale:"en-US"},"en-GB").translation_language,"en-GB");
  assert.equal(resolveTranslationPreference({language:null},"fr-FR").translation_language,"fr");
  assert.equal(resolveTranslationPreference({language:"es",interface_locale:"en-GB"},"fr-FR").translation_language,"es");
  assert.equal(resolveTranslationPreference({language:"en"},"en-GB").language,"en-US");
  assert.equal(resolveTranslationPreference({language:null},"en-US").translation_language,"en-US");
});

test("English target variants remain distinct while detected English avoids redundant translation", async () => {
  assert.equal(normalizeTranslationLanguage("en_GB"),"en-GB");
  assert.equal(normalizeTranslationLanguage("en-US"),"en-US");
  assert.notEqual(normalizeTranslationLanguage("en-GB"),normalizeTranslationLanguage("en-US"));
  assert.equal(sameMessageLanguage("en","en-GB"),true);
  const text="The colour of the roof is grey.";
  assert.equal(await translateMessageText({text,sourceLanguage:"en",targetLanguage:"en-GB"}),text);
  assert.match(translationDirection("fr","en-GB"),/French to English \(UK\).*British English/);
  assert.match(translationDirection("fr","en-US"),/French to English \(US\).*American English/);
});

test("French-to-Spanish translation uses detected French as the source", () => {
  const french="Bonjour à toute l'équipe, nous allons commencer les travaux sur la toiture demain matin.";
  assert.equal(detectMessageLanguage(french).code,"fr");
  assert.equal(translationDirection("fr","es"),"Translate the message from French to Spanish.");
  assert.equal(sameMessageLanguage("fr","es"),false);
});
