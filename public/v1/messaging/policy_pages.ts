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

/** A US number as (206) 555-0100; anything else as stored. */
function displayPhone(value: unknown) {
  const digits = clean(value).replace(/\D/g, "");
  const us = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return us.length === 10 ? `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}` : clean(value);
}

/** What the page is given besides the registration: the business's public email (FM-584), from its mail setup. */
export type HostedSmsPolicyOptions = { supportEmail?: string };

function smsPolicyValues(profile: { id: string; external_organization_id: string; brand?: unknown; campaign?: unknown }, options: HostedSmsPolicyOptions = {}): Record<Placeholder, string> {
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
    // The company inbox (its own domain, else FirstMate Mail) so mail reaches Communications; the typed email otherwise.
    support_email: clean(options.supportEmail) || clean(brand.email),
    support_phone: displayPhone(brand.phone),
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
export function hostedSmsPolicyProblems(profile: { id: string; external_organization_id: string; brand?: unknown; campaign?: unknown }, options: HostedSmsPolicyOptions = {}) {
  const values = smsPolicyValues(profile, options);
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

/** URLs and email addresses as links; `names` shows a known URL (the hosted pages) by its name instead. */
function linked(text: string, names: Record<string, string> = {}) {
  return text.split(LINKABLE).map((part, index) => {
    if (index % 2 === 0) return escapeHtml(part);
    const href = /^https?:\/\//.test(part) ? part : `mailto:${part}`;
    return `<a href="${escapeHtml(href)}">${escapeHtml(names[part] || part)}</a>`;
  }).join("");
}

const PAGE_NAMES: Record<SmsPolicyPageId, string> = { privacy: "Privacy policy", terms: "SMS terms" };

/** Up to two initials for the header mark: "Ridgeline Roofing" is RR. */
function initials(name: string) {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.slice(0, 2).map((word) => word[0]!.toUpperCase()).join("") || "?";
}

/** A section's anchor, unique on the page. */
function anchors(headings: string[]) {
  const seen = new Set<string>();
  return headings.map((heading, index) => {
    let id = heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || `section-${index + 1}`;
    while (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    return id;
  });
}

/** A short "Email: …" or "Phone: …" line sits tight under the paragraph before it. */
const isDetailLine = (text: string) => text.length <= 120 && /^[A-Z][A-Za-z ]{1,24}: \S/.test(text);

// No scripts, fonts or images can load (`default-src 'none'`), so the page is inline CSS, system fonts and text.
const PAGE_STYLE = `:root{color-scheme:light dark;--bg:#f4f5f7;--card:#fff;--ink:#1d2433;--muted:#5d6676;--line:#e3e6eb;--accent:#1f5f99;--accent-soft:#e9f1f9;--shadow:0 1px 2px rgba(16,24,40,.05),0 8px 24px rgba(16,24,40,.06)}
@media (prefers-color-scheme:dark){:root{--bg:#0f131a;--card:#171c25;--ink:#e7eaf0;--muted:#a1a9b7;--line:#2a313d;--accent:#7cb4ea;--accent-soft:#1b2a3b;--shadow:none}}
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-underline-offset:2px;word-break:break-word}a:hover{text-decoration-thickness:2px}
.wrap{max-width:1040px;margin:0 auto;padding:0 24px}
.top{background:var(--card);border-bottom:1px solid var(--line)}.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;padding-top:14px;padding-bottom:14px}
.brand{display:flex;align-items:center;gap:12px;min-width:0}.mark{flex:0 0 40px;width:40px;height:40px;border-radius:10px;background:var(--accent);color:var(--card);display:grid;place-items:center;font-weight:700;font-size:15px;letter-spacing:.02em}
.brand strong{display:block;font-size:16px;line-height:1.3}.brand div span{display:block;color:var(--muted);font-size:13px;line-height:1.3}
.tabs{display:flex;gap:4px;background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:3px}.tabs a{color:var(--muted);text-decoration:none;font-size:14px;font-weight:600;padding:6px 14px;border-radius:999px}.tabs a[aria-current=page]{background:var(--card);color:var(--ink);box-shadow:var(--shadow)}
.hero{padding:44px 0 28px}.eyebrow{margin:0 0 6px;color:var(--accent);font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{margin:0 0 14px;font-size:clamp(28px,4vw,38px);line-height:1.15;letter-spacing:-.01em}.lead p{margin:0 0 8px;max-width:680px;color:var(--muted);font-size:17px}
.layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:32px;align-items:start;padding-bottom:48px}
aside{position:sticky;top:20px;display:grid;gap:16px}.box{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px}.box h2{margin:0 0 8px;color:var(--muted);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
.toc ol{list-style:none;margin:0;padding:0;counter-reset:toc}.toc li{counter-increment:toc}.toc a{display:flex;gap:8px;padding:4px 0;color:var(--ink);text-decoration:none;font-size:14px;line-height:1.4}.toc a::before{content:counter(toc);color:var(--muted);font-variant-numeric:tabular-nums;min-width:14px}.toc a:hover{color:var(--accent)}
.contact p{margin:0 0 6px;font-size:14px;line-height:1.45}.contact p:last-child{margin:0}.contact .who{font-weight:600}
article{background:var(--card);border:1px solid var(--line);border-radius:16px;box-shadow:var(--shadow);padding:8px 36px}
article section{padding:26px 0;border-top:1px solid var(--line);scroll-margin-top:20px}article section:first-child{border-top:0}
article h2{display:flex;align-items:center;gap:12px;margin:0 0 10px;font-size:20px;line-height:1.3}.num{flex:0 0 28px;width:28px;height:28px;border-radius:8px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-size:13px;font-weight:700;font-variant-numeric:tabular-nums}
article p{margin:0 0 12px}article p:last-child{margin-bottom:0}article p.detail{margin:-6px 0 4px}article p.detail+p:not(.detail){margin-top:12px}
.foot{border-top:1px solid var(--line);color:var(--muted);font-size:13px}.foot .wrap{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-top:18px;padding-bottom:28px}.foot p{margin:0}
@media (max-width:820px){.layout{grid-template-columns:minmax(0,1fr);gap:20px}aside{display:none}article{padding:4px 20px;border-radius:14px}.hero{padding:30px 0 20px}.wrap{padding:0 16px}}
@media print{:root{--bg:#fff;--card:#fff;--shadow:none}.tabs,.toc{display:none}.layout{display:block}article{border:0;padding:0}aside{margin-top:24px}a{color:inherit}}`;

/** The page as HTML, or null when the registration has none (not hosted, or not ready). */
export function renderHostedSmsPolicyPage(profile: { id: string; external_organization_id: string; brand?: unknown; campaign?: unknown }, page: SmsPolicyPageId, options: HostedSmsPolicyOptions = {}) {
  if (!usesHostedSmsPolicies(profile.campaign) || hostedSmsPolicyProblems(profile, options).length) return null;
  const wording = pageWording(page)!;
  const values = smsPolicyValues(profile, options);
  const title = fill(wording.title, values);
  const names = { [values.privacy_url]: PAGE_NAMES.privacy, [values.terms_url]: PAGE_NAMES.terms };
  const paragraphs = (list: readonly string[]) => list.map((text) => fill(text, values)).filter(Boolean)
    .map((text) => `<p${isDetailLine(text) ? " class=\"detail\"" : ""}>${linked(text, names)}</p>`).join("");
  const sections = wording.sections
    .map((section) => ({ heading: fill(section.heading, values) || section.heading.replace(PLACEHOLDER, ""), body: paragraphs(section.paragraphs) }))
    .filter((section) => section.body);
  const ids = anchors(sections.map((section) => section.heading));
  const footer = wording.footer ? fill(wording.footer, values) : "";
  const urls = { privacy: values.privacy_url, terms: values.terms_url };
  const tabs = SMS_POLICY_PAGES.map((candidate) => `<a href="${escapeHtml(urls[candidate.id])}"${candidate.id === page ? " aria-current=\"page\"" : ""}>${PAGE_NAMES[candidate.id]}</a>`).join("");
  const phoneHref = values.support_phone.replace(/[^\d+]/g, "");
  const contact = [
    `<p class="who">${escapeHtml(values.brand_name)}</p>`,
    values.support_email ? `<p><a href="mailto:${escapeHtml(values.support_email)}">${escapeHtml(values.support_email)}</a></p>` : "",
    values.support_phone ? `<p>${phoneHref ? `<a href="tel:${escapeHtml(phoneHref)}">${escapeHtml(values.support_phone)}</a>` : escapeHtml(values.support_phone)}</p>` : "",
    values.website ? `<p><a href="${escapeHtml(values.website)}">${escapeHtml(values.website.replace(/^https?:\/\//i, "").replace(/\/$/, ""))}</a></p>` : "",
    values.address ? `<p>${escapeHtml(values.address)}</p>` : ""
  ].join("");
  const other = SMS_POLICY_PAGES.find((candidate) => candidate.id !== page)!;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head><body>
<header class="top"><div class="wrap"><div class="brand"><span class="mark" aria-hidden="true">${escapeHtml(initials(values.brand_name))}</span><div><strong>${escapeHtml(values.brand_name)}</strong>${values.legal_name ? `<span>${escapeHtml(values.legal_name)}</span>` : ""}</div></div><nav class="tabs" aria-label="Policies">${tabs}</nav></div></header>
<main class="wrap">
<div class="hero"><p class="eyebrow">${PAGE_NAMES[page]}</p><h1>${escapeHtml(title)}</h1><div class="lead">${paragraphs(wording.intro)}</div></div>
<div class="layout">
<aside><nav class="box toc" aria-label="On this page"><h2>On this page</h2><ol>${sections.map((section, index) => `<li><a href="#${ids[index]}">${escapeHtml(section.heading)}</a></li>`).join("")}</ol></nav><div class="box contact"><h2>Contact</h2>${contact}</div></aside>
<article>${sections.map((section, index) => `<section id="${ids[index]}"><h2><span class="num" aria-hidden="true">${index + 1}</span>${escapeHtml(section.heading)}</h2>${section.body}</section>`).join("")}</article>
</div>
</main>
<footer class="foot"><div class="wrap">${footer ? `<p>${linked(footer)}</p>` : "<p></p>"}<p>Also see: <a href="${escapeHtml(urls[other.id])}">${PAGE_NAMES[other.id]}</a></p></div></footer>
</body></html>`;
}
