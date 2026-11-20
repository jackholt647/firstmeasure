import { currentProfile, type CommercialProfile } from "../commerce/profile.js";
import { resolveContext, supportedLocale, type Locale } from "../platform/localization/core.js";
import { serverLanguage } from "../platform/localization/server.js";
import { companyLocalization } from "../platform/localization/settings.js";

/**
 * FM-622: what Stripe shows and sends for a credit purchase is in the organization's language: the Checkout page
 * (`locale`), Stripe's own receipt email (the customer's `preferred_locales`) and our text on it (the payment's
 * description, the line item). The language is the company's (portal) language, read from its default branch.
 */
export async function stripeReceiptLocale(orgId: string): Promise<Locale> {
  const localization = await companyLocalization(orgId).catch(() => null);
  return localization?.context.locale || resolveContext().locale;
}

/** Stripe's language code for one of our language packs (Checkout `locale`, customer `preferred_locales`). */
const STRIPE_LOCALES: Record<string, string> = { "en-US": "en", "en-GB": "en-GB", "pt-BR": "pt-BR" };
export function stripeLocale(locale: string) {
  const ours = supportedLocale(locale);
  return STRIPE_LOCALES[ours] || ours.split("-")[0] || "en";
}

/**
 * The customer fields that tell Stripe the organization's language, or null when Stripe already has it
 * (`billing.stripe.preferred_locale` records what we last sent).
 */
export function stripeCustomerLocaleFields(savedStripe: Record<string, unknown>, locale: string) {
  const code = stripeLocale(locale);
  return savedStripe.preferred_locale === code ? null : { "preferred_locales[0]": code };
}

/** An amount of credit as the organization reads it: its currency, or a number of credits. */
export function stripeCreditAmount(creditDollars: number, profile: CommercialProfile, locale: string) {
  const amount = Math.round((Number.isFinite(creditDollars) ? Math.max(0, creditDollars) : 0) * 100) / 100;
  const digits = Number.isInteger(amount) ? 0 : 2;
  const options: Intl.NumberFormatOptions = profile.credit_display === "credits"
    ? { minimumFractionDigits: digits, maximumFractionDigits: digits }
    : { style: "currency", currency: profile.currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: digits, maximumFractionDigits: digits };
  return new Intl.NumberFormat(supportedLocale(locale), options).format(amount);
}

async function billingLanguage(locale: string) {
  return serverLanguage(resolveContext({ locale: supportedLocale(locale) }), ["billing"]);
}

export async function stripeCreditReceiptDescription(creditDollars: number, profile: CommercialProfile = currentProfile(), locale = "en-US") {
  const language = await billingLanguage(locale);
  const amount = stripeCreditAmount(creditDollars, profile, locale);
  return profile.credit_display === "credits"
    ? language.text("billing", "stripe_receipt_credits_units", `${amount} credits added to your FirstMate balance. Roof reports come out of this balance; you won't be charged again until you reload.`, { amount })
    : language.text("billing", "stripe_receipt_credits_currency", `${amount} in credits added to your FirstMate balance. Roof reports come out of this balance; you won't be charged again until you reload.`, { amount });
}

/** The Checkout line item for credits bought without a Stripe price (outside USD, or with a bonus offer). */
export async function stripeCreditLineItem(input: { paid: number; bonus: number; total: number; matchPercent: number; bonusOffer: boolean; vatIncluded: boolean }, profile: CommercialProfile = currentProfile(), locale = "en-US") {
  const language = await billingLanguage(locale);
  const money = (value: number) => stripeCreditAmount(value, profile, locale);
  const name = input.bonusOffer
    ? language.text("billing", "stripe_line_credits_bonus", "Roof Measurement Credits With Limited-Time Bonus")
    : language.text("billing", "stripe_line_credits", "Roof Measurement Credits");
  const percent = new Intl.NumberFormat(supportedLocale(locale), { maximumFractionDigits: 2 }).format(input.matchPercent);
  const description = input.bonusOffer
    ? language.text("billing", "stripe_line_bonus", `${money(input.paid)} purchased + ${money(input.bonus)} limited-time bonus (${percent}% bonus) = ${money(input.total)} added to your account`, { paid: money(input.paid), bonus: money(input.bonus), percent, total: money(input.total) })
    : language.text("billing", "stripe_line_added", `${money(input.total)} added to your FirstMate account`, { amount: money(input.total) });
  // Outside the US and Canada the charged amount includes VAT (commercial policy international_prices.vat_included).
  return { name, description: input.vatIncluded ? language.text("billing", "stripe_line_with_vat", `${description}. VAT included.`, { description }) : description };
}
