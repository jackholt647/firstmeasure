import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { LEGACY_PROFILE, type CommercialProfile } from "../commerce/profile.js";
import { stripeCreditLineItem, stripeCreditReceiptDescription, stripeCustomerLocaleFields, stripeLocale } from "../payments/stripe_receipt.js";
import { SUPPORTED_LOCALES } from "../platform/localization/core.js";

const EURO: CommercialProfile = { ...LEGACY_PROFILE, country: "FR", tier: "international", currency: "EUR", local_currency: "EUR", locale: "fr-FR", preferred_locale: "fr-FR", measurement_system: "metric" };

test("credit purchases use the requested Stripe receipt description", async () => {
  assert.equal(
    await stripeCreditReceiptDescription(250),
    "$250 in credits added to your FirstMate balance. Roof reports come out of this balance; you won't be charged again until you reload."
  );
  assert.equal(
    await stripeCreditReceiptDescription(312.5),
    "$312.50 in credits added to your FirstMate balance. Roof reports come out of this balance; you won't be charged again until you reload."
  );
  assert.equal(
    await stripeCreditReceiptDescription(50, EURO, "en-GB"),
    "€50 in credits added to your FirstMate balance. Roof reports come out of this balance; you won't be charged again until you reload."
  );
});

test("FM-622: the receipt description is in the organization's language", async () => {
  const french = await stripeCreditReceiptDescription(312.5, EURO, "fr-FR");
  assert.match(french, /^312,50\s€ de crédit ajoutés à votre solde FirstMate\. /);
  assert.equal(await stripeCreditReceiptDescription(50, EURO, "de-DE"), "50 € Guthaben wurde Ihrem FirstMate-Konto gutgeschrieben. Dachreports werden von diesem Guthaben abgebucht; Sie werden erst wieder belastet, wenn Sie Guthaben aufladen.");
  assert.match(await stripeCreditReceiptDescription(50, EURO, "ja-JP"), /^FirstMate の残高に €50 分のクレジットが追加されました。/);
  // Every shipped language has its own sentence (no English fallback on a customer's receipt).
  for (const locale of SUPPORTED_LOCALES.filter((code) => !code.startsWith("en-"))) {
    const text = await stripeCreditReceiptDescription(50, EURO, locale);
    assert.doesNotMatch(text, /added to your FirstMate balance/, locale);
    assert.match(text, /FirstMate/, locale);
  }
  const line = await stripeCreditLineItem({ paid: 50, bonus: 0, total: 50, matchPercent: 0, bonusOffer: false, vatIncluded: true }, EURO, "fr-FR");
  assert.equal(line.name, "Crédit FirstMate");
  assert.equal(line.description, "Crédits FirstMate. TVA incluse.");
  const english = await stripeCreditLineItem({ paid: 100, bonus: 50, total: 150, matchPercent: 50, bonusOffer: true, vatIncluded: false });
  assert.deepEqual(english, { name: "FirstMate Credits With Limited-Time Bonus", description: "$100 purchased + $50 limited-time bonus (50% bonus) = $150 added to your account" });
});

test("FM-634: Checkout says FirstMate credit, never roof measurement credit, in every language and currency", async () => {
  assert.deepEqual(
    await stripeCreditLineItem({ paid: 250, bonus: 0, total: 250, matchPercent: 0, bonusOffer: false, vatIncluded: false }),
    { name: "FirstMate Credit", description: "FirstMate Credits" }
  );
  for (const locale of SUPPORTED_LOCALES) {
    for (const bonusOffer of [false, true]) {
      const line = await stripeCreditLineItem({ paid: 100, bonus: bonusOffer ? 50 : 0, total: bonusOffer ? 150 : 100, matchPercent: bonusOffer ? 50 : 0, bonusOffer, vatIncluded: false }, EURO, locale);
      assert.match(line.name, /FirstMate/, `${locale} name`);
      assert.doesNotMatch(`${line.name} ${line.description}`, /roof|toit|dach|tejad|telhad|tetto|屋根/i, `${locale} ${line.name}`);
    }
  }
  // Every checkout builds its own line item: a fixed Stripe price shows the dashboard product's old name.
  const platformSource = await readFile(path.resolve(process.cwd(), "platform/api.ts"), "utf8");
  assert.doesNotMatch(platformSource, /line_items\[0\]\[price\]"/);
  assert.match(platformSource, /"line_items\[0\]\[price_data\]\[product_data\]\[name\]"\] = lineItem\.name/);
});

test("FM-622: our languages map to Stripe's Checkout and receipt languages", () => {
  assert.deepEqual(SUPPORTED_LOCALES.map(stripeLocale), ["en", "en-GB", "pt-BR", "es", "fr", "it", "el", "de", "da", "pl", "cs", "nl", "nb", "sv", "lt", "fi", "ja"]);
  assert.equal(stripeLocale("xx-YY"), "en");
  assert.deepEqual(stripeCustomerLocaleFields({}, "de-DE"), { "preferred_locales[0]": "de" });
  assert.equal(stripeCustomerLocaleFields({ preferred_locale: "de" }, "de-DE"), null);
});

test("checkout and both automatic top-up paths send the localized description and language to Stripe", async () => {
  const [platformSource, publicApiSource] = await Promise.all([
    readFile(path.resolve(process.cwd(), "platform/api.ts"), "utf8"),
    readFile(path.resolve(process.cwd(), "public-firstmeasure/billing.ts"), "utf8")
  ]);

  assert.match(platformSource, /"payment_intent_data\[description\]": await stripeCreditReceiptDescription\(totalCredit, currentProfile\(\), locale\)/);
  assert.match(platformSource, /locale: stripeLocale\(locale\),\n\s+"payment_intent_data\[setup_future_usage\]"/);
  assert.match(platformSource, /"preferred_locales\[0\]": preferredLocale/);
  assert.match(platformSource, /description: await stripeCreditReceiptDescription\(topup, profile, locale\)/);
  assert.match(platformSource, /await stripeSyncCustomerLocale\(orgId, customerId, stripe, locale\);\n\s+const result = await stripeApiRequest\("POST", "\/v1\/payment_intents"/);
  assert.match(publicApiSource, /description: await stripeCreditReceiptDescription\(topup, profile, locale\)/);
  assert.match(publicApiSource, /stripeCustomerLocaleFields\(stripe, locale\)/);
});
