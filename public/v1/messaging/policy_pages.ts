import { env } from "../src/config/env.js";
import { libraryData } from "../config-library/library.js";
import type { SmsPolicyPage } from "../config-library/kinds/sms_policy_page.js";

/**
 * Privacy policy and SMS terms pages FirstMate hosts for a business's 10DLC registration (FM-585,
 * docs/architecture/phone-settings.md, "Hosted policy pages"). Carriers need both pages to name the registered brand,
 * be public, and say mobile opt-in data is never shared for marketing; they do not need them on the brand's own
 * domain. A registration opts in with `campaign.policyPages: "firstmate"`; its links are then always these URLs, and
 * only such a registration has pages. The wording is config library data (`sms_policy_page`); the brand details are
 * the registration's own.
 */
type JsonObject = Record<string, unknown>;

export const SMS_POLICY_PAGES = [
  { id: "privacy", entry: "privacy_policy", field: "privacyPolicyLink" },
  { id: "terms", entry: "sms_terms", field: "termsAndConditionsLink" }
] as const;
export type SmsPolicyPageId = typeof SMS_POLICY_PAGES[number]["id"];

export const SMS_POLICY_PLACEHOLDERS = [
  "brand_name", "legal_name", "website", "support_email", "support_phone", "address", "message_types", "privacy_url", "terms_url"
] as const;
type Placeholder = typeof SMS_POLICY_PLACEHOLDERS[number];

const PLACEHOLDER = /\{\{\s*([a-z_]+)\s*\}\}/g;
const clean = (value: unknown) => String(value ?? "").trim();
const asObject = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

/** The registration chose FirstMate's hosted pages. */
export function usesHostedSmsPolicies(campaign: unknown) {
  return clean(asObject(campaign).policyPages) === "firstmate";
}

export function hostedSmsPolicyUrl(orgId: string, profileId: string, page: SmsPolicyPageId) {
  return `${env.publicBaseUrl}/v1/messaging/sms/policies/${encodeURIComponent(orgId)}/${encodeURIComponent(profileId)}/${page}`;
}

export function hostedSmsPolicyUrls(profile: { id: string; external_organization_id: string }) {
  return Object.fromEntries(SMS_POLICY_PAGES.map((page) => [page.id, hostedSmsPolicyUrl(profile.external_organization_id, profile.id, page.id)])) as Record<SmsPolicyPageId, string>;
}

/** The campaign with its policy links set to the hosted pages when it chose them; unchanged otherwise. */
export function withHostedSmsPolicyLinks<T extends JsonObject>(campaign: T, profile: { id: string; external_organization_id: string }): T {
  if (!usesHostedSmsPolicies(campaign)) return campaign;
  const urls = hostedSmsPolicyUrls(profile);
  return { ...campaign, privacyPolicyLink: urls.privacy, termsAndConditionsLink: urls.terms };
}

/** `value` is this registration's hosted page and the registration chose hosted pages. */
export function isHostedSmsPolicyUrl(profile: { id: string; external_organization_id: string; campaign?: unknown }, value: unknown, page: SmsPolicyPageId) {
  return usesHostedSmsPolicies(profile.campaign) && clean(value) === hostedSmsPolicyUrl(profile.external_organization_id, profile.id, page);
}

const FEATURE_MESSAGES: Record<string, string> = {
  crm_conversations: "replies to your questions",
  operations: "appointment reminders, project updates, estimates and billing notices",
  customer_growth: "marketing and promotional offers"
};

function smsPolicyValues(profile: { id: string; external_organization_id: string; brand?: unknown; campaign?: unknown }): Record<Placeholder, string> {
  const brand = asObject(profile.brand);
  const person = [clean(brand.firstName), clean(brand.lastName)].filter(Boolean).join(" ");
  const brandName = clean(brand.displayName) || clean(brand.companyName) || person;
  const legalName = clean(brand.companyName) || person;
  const website = clean(brand.website);
  const features = Array.isArray(asObject(profile.campaign).enabledFeatures) ? (asObject(profile.campaign).enabledFeatures as unknown[]).map(clean) : [];
  const messages = [...new Set(features.map((feature) => FEATURE_MESSAGES[feature]).filter(Boolean))];
  const urls = hostedSmsPolicyUrls(profile);
  return {
    brand_name: brandName,
    legal_name: legalName.toLowerCase() === brandName.toLowerCase() ? "" : legalName,
    website: website && !/^https?:\/\//i.test(website) ? `https://${website}` : website,
    support_email: clean(brand.email),
    support_phone: clean(brand.phone),
    address: [clean(brand.street), clean(brand.address2), clean(brand.city), [clean(brand.state), clean(brand.postalCode)].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    message_types: messages.length > 1 ? `${messages.slice(0, -1).join(", ")} and ${messages[messages.length - 1]}` : messages[0] || "updates about your service",
    privacy_url: urls.privacy,
    terms_url: urls.terms
  };
}

/** Save-time checks for a page's wording (config library `validate`): known placeholders and what carriers look for. */
export function smsPolicyPageProblems(page: SmsPolicyPageId, data: SmsPolicyPage) {
  const problems: string[] = [];
  const texts = [data.title, ...data.intro, ...data.sections.flatMap((section) => [section.heading, ...section.paragraphs]), data.footer || ""];
  for (const text of texts) {
    for (const match of text.matchAll(PLACEHOLDER)) {
      if (!(SMS_POLICY_PLACEHOLDERS as readonly string[]).includes(match[1]!)) problems.push(`Unknown placeholder {{${match[1]}}}: use ${SMS_POLICY_PLACEHOLDERS.map((name) => `{{${name}}}`).join(", ")}.`);
    }
  }
  const all = texts.join("\n");
  if (!/\{\{\s*brand_name\s*\}\}/.test(data.title)) problems.push("The title must name the business: {{brand_name}}.");
  if (!/\{\{\s*(?:support_email|support_phone)\s*\}\}/.test(all)) problems.push("The page must give the business's contact details ({{support_email}} or {{support_phone}}).");
  if (page === "privacy") {
    if (!/\b(?:not|never)\b[^.]{0,120}\b(?:sold|shared|sell|share)\b[^.]{0,160}\bthird[ -]?part/i.test(all)) {
      problems.push("The privacy policy must say mobile information and SMS opt-in data are not sold or shared with third parties for marketing.");
    }
  } else {
    if (!/\bSTOP\b/.test(all) || !/\bHELP\b/.test(all)) problems.push("The SMS terms must explain STOP and HELP.");
    if (!/data rates may apply/i.test(all)) problems.push("The SMS terms must say message and data rates may apply.");
    if (!/frequency/i.test(all)) problems.push("The SMS terms must say how often messages are sent (message frequency).");
    if (!/\{\{\s*privacy_url\s*\}\}/.test(all)) problems.push("The SMS terms must link the privacy policy: {{privacy_url}}.");
  }
  return problems;
}

function pageWording(page: SmsPolicyPageId) {
  const entry = SMS_POLICY_PAGES.find((candidate) => candidate.id === page)!.entry;
  return libraryData<SmsPolicyPage>("sms_policy_page", entry);
}

/** Why this registration's hosted pages cannot be published yet (empty when they can). */
export function hostedSmsPolicyProblems(profile: { id: string; external_organization_id: string; brand?: unknown; campaign?: unknown }) {
  const values = smsPolicyValues(profile);
  const problems: string[] = [];
  if (!values.brand_name) problems.push("Add the business name before using FirstMate's hosted policy pages.");
  if (!values.support_email && !values.support_phone) problems.push("Add a support email or phone number before using FirstMate's hosted policy pages.");
  for (const page of SMS_POLICY_PAGES) if (!pageWording(page.id)) problems.push(`The hosted ${page.id} page wording is missing from the config library.`);
  return problems;
}

function fill(text: string, values: Record<Placeholder, string>) {
  let empty = false;
  const filled = text.replace(PLACEHOLDER, (_match, name: string) => {
    const value = values[name as Placeholder] ?? "";
    if (!value) empty = true;
    return value;
  });
  return empty ? "" : filled;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
const LINKABLE = /(https?:\/\/[^\s<>"]*[^\s<>".,;:!?)]|[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,})/gi;

function linked(text: string) {
  return text.split(LINKABLE).map((part, index) => {
    if (index % 2 === 0) return escapeHtml(part);
    const href = /^https?:\/\//.test(part) ? part : `mailto:${part}`;
    return `<a href="${escapeHtml(href)}">${escapeHtml(part)}</a>`;
  }).join("");
}

/** The page as HTML, or null when the registration has none (not hosted, or not ready). */
export function renderHostedSmsPolicyPage(profile: { id: string; external_organization_id: string; brand?: unknown; campaign?: unknown }, page: SmsPolicyPageId) {
  if (!usesHostedSmsPolicies(profile.campaign) || hostedSmsPolicyProblems(profile).length) return null;
  const wording = pageWording(page)!;
  const values = smsPolicyValues(profile);
  const title = fill(wording.title, values);
  const paragraphs = (list: readonly string[]) => list.map((text) => fill(text, values)).filter(Boolean).map((text) => `<p>${linked(text)}</p>`).join("");
  const sections = wording.sections.map((section) => {
    const body = paragraphs(section.paragraphs);
    return body ? `<section><h2>${escapeHtml(fill(section.heading, values) || section.heading.replace(PLACEHOLDER, ""))}</h2>${body}</section>` : "";
  }).join("");
  const footer = wording.footer ? fill(wording.footer, values) : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{margin:0;background:#f7f7f8;color:#1f2328;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}main{max-width:760px;margin:0 auto;padding:40px 24px 56px;background:#fff;min-height:100vh;box-sizing:border-box}h1{font-size:28px;line-height:1.25;margin:0 0 16px}h2{font-size:19px;margin:32px 0 8px}p{margin:0 0 12px}a{color:#0b5cad;word-break:break-word}footer{margin-top:40px;padding-top:16px;border-top:1px solid #e4e6ea;color:#5f6670;font-size:13px}</style>
</head><body><main><h1>${escapeHtml(title)}</h1>${paragraphs(wording.intro)}${sections}${footer ? `<footer>${linked(footer)}</footer>` : ""}</main></body></html>`;
}
