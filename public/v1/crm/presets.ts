import type { JsonObject } from "../platform/storage.js";
import { readBranchModule, saveBranchModule } from "../platform/storage.js";
import { PlatformError } from "../platform/errors.js";
import { installPresetViews, type PresetView } from "./views.js";
import { readSourceCatalog, saveSourceCatalog } from "./sources.js";
import { DEFAULT_FUNNEL, FUNNEL_MODULE, saveFunnel } from "./funnel.js";
import { RESCISSION_MODULE, saveRescission } from "./rescission.js";

// CRM presets (docs/architecture/crm.md, "Presets"). Every organization gets the base
// views. A setup applies an industry pack (sources, funnel, cancellation rules, views and
// the industry sales scopes) and a team-size tier (which CRM features are on). Applying
// only adds: nothing an organization already set is replaced, and a preset view someone
// deleted stays deleted.

const any = (field: string, value: unknown[]) => ({ field, operator: "in", value });
const all = (...rules: JsonObject[]) => ({ match: "all", rules });

/** The views every organization starts with. Pinned ones show in everyone's rail. */
export const BASE_VIEWS: PresetView[] = [
  { key: "new_leads", name: "New leads", collection: "opportunities", pinned: true, definition: {
    filter: all(any("state", ["new_lead"])), sort: [{ key: "created_at", dir: "desc" }], columns: ["contact_name", "contact_phone", "source_id", "created_at", "age_days"],
    icon: "fa-bolt", description: "Leads nobody has started a scope on yet." } },
  { key: "pipeline", name: "Pipeline", collection: "opportunities", pinned: true, definition: {
    filter: all(any("state", ["new_lead", "open"])), layout: "board", group_by: "stage_id", sort: [{ key: "created_at", dir: "desc" }],
    icon: "fa-table-columns", description: "Every open lead by stage. Drag a card to move it." } },
  { key: "follow_ups_due", name: "Follow-ups due", collection: "follow_ups", pinned: true, definition: {
    filter: all({ field: "due_at", operator: "before", value: "now+1d" }), sort: [{ key: "due_at", dir: "asc" }],
    icon: "fa-phone-volume", description: "Calls and follow-ups due today or overdue." } },
  { key: "upcoming_appointments", name: "Upcoming appointments", collection: "appointments", pinned: true, definition: {
    filter: all({ field: "upcoming", operator: "equals", value: true }), layout: "calendar", sort: [{ key: "start_at", dir: "asc" }],
    icon: "fa-calendar-check", description: "Booked appointments from now on." } },
  { key: "unconfirmed_soon", name: "Unconfirmed in the next 2 days", collection: "appointments", definition: {
    filter: all({ field: "start_at", operator: "after", value: "now" }, { field: "start_at", operator: "before", value: "now+2d" }, any("confirmation", ["pending"])),
    sort: [{ key: "start_at", dir: "asc" }], icon: "fa-circle-question", description: "Appointments soon that the customer has not confirmed." } },
  { key: "stale_leads", name: "Gone quiet", collection: "opportunities", definition: {
    filter: all(any("state", ["open"]), { match: "any", rules: [{ field: "last_touch_at", operator: "before", value: "now-14d" }, { field: "last_touch_at", operator: "is_missing" }] }),
    sort: [{ key: "last_touch_at", dir: "asc" }], icon: "fa-hourglass-end", description: "Open leads nobody has reached in two weeks." } },
  { key: "won_recently", name: "Won in the last 30 days", collection: "opportunities", definition: {
    filter: all(any("state", ["won"]), { field: "won_at", operator: "after", value: "now-30d" }), sort: [{ key: "won_at", dir: "desc" }],
    columns: ["contact_name", "scope_template_id", "value_cents", "source_id", "won_at"], icon: "fa-trophy" } },
  { key: "lost_recently", name: "Lost in the last 30 days", collection: "opportunities", definition: {
    filter: all(any("state", ["lost"]), { field: "lost_at", operator: "after", value: "now-30d" }), group_by: "lost_reason", sort: [{ key: "lost_at", dir: "desc" }],
    icon: "fa-circle-xmark", description: "Grouped by why they were lost." } },
  { key: "all_contacts", name: "All contacts", collection: "contacts", definition: { sort: [{ key: "last_activity_at", dir: "desc" }], icon: "fa-address-book" } },
  { key: "customers", name: "Customers", collection: "contacts", definition: {
    filter: all({ field: "customer", operator: "equals", value: true }), sort: [{ key: "last_activity_at", dir: "desc" }], icon: "fa-user-check" } },
  { key: "referral_partners", name: "Referral partners", collection: "contacts", definition: {
    filter: all({ field: "leads_referred", operator: "greater_or_equal", value: 1 }), sort: [{ key: "leads_referred", dir: "desc" }],
    columns: ["name", "phone", "leads_referred", "value_won_cents", "last_activity_at"], icon: "fa-handshake", description: "Everyone who has sent you a lead." } }
];

type SourceSeed = { id: string; label: string; channel: string; parent_id?: string; rules?: JsonObject };
const rule = (field: string, operator: string, value: unknown) => all({ field, operator, value });
const COMMON_SOURCES: SourceSeed[] = [
  { id: "website", label: "Website", channel: "web", rules: rule("lead_source.kind", "in", ["web_form", "live_chat"]) },
  { id: "google_ads", label: "Google Ads", channel: "paid", parent_id: "website", rules: { match: "any", rules: [{ field: "lead_source.utm_source", operator: "contains", value: "google" }, { field: "lead_source.gclid", operator: "is_present" }] } },
  { id: "meta_ads", label: "Facebook and Instagram", channel: "paid", parent_id: "website", rules: { match: "any", rules: [{ field: "lead_source.utm_source", operator: "in", value: ["facebook", "fb", "instagram", "ig", "meta"] }, { field: "lead_source.fbclid", operator: "is_present" }] } },
  { id: "phone", label: "Phone call", channel: "phone", rules: rule("lead_source.kind", "in", ["missed_call", "call"]) },
  { id: "referral", label: "Referral", channel: "referral", rules: rule("lead_source.kind", "in", ["referral", "partner_referral"]) },
  { id: "repeat_customer", label: "Repeat customer", channel: "referral" }
];
const PACK_SOURCES: Record<string, SourceSeed[]> = {
  roofing: [
    { id: "canvassing", label: "Door knocking", channel: "canvass", rules: rule("lead_source.kind", "equals", "canvassing") },
    { id: "storm", label: "Storm response", channel: "canvass", parent_id: "canvassing" },
    { id: "lead_vendors", label: "Lead vendors", channel: "aggregator" },
    { id: "angi", label: "Angi", channel: "aggregator", parent_id: "lead_vendors", rules: rule("lead_source.provider", "contains", "angi") },
    { id: "homeadvisor", label: "HomeAdvisor", channel: "aggregator", parent_id: "lead_vendors", rules: rule("lead_source.provider", "contains", "homeadvisor") },
    { id: "yard_signs", label: "Yard signs", channel: "other" },
    { id: "insurance_agents", label: "Insurance agents", channel: "referral", parent_id: "referral" }
  ],
  in_home: [
    { id: "events", label: "Home shows and events", channel: "event" },
    { id: "canvassing", label: "Door knocking", channel: "canvass", rules: rule("lead_source.kind", "equals", "canvassing") },
    { id: "lead_vendors", label: "Lead vendors", channel: "aggregator" },
    { id: "direct_mail", label: "Direct mail", channel: "email" },
    { id: "tv_radio", label: "TV and radio", channel: "paid" }
  ],
  home_services: [
    { id: "lead_vendors", label: "Lead vendors", channel: "aggregator" },
    { id: "google_lsa", label: "Google local services", channel: "paid", parent_id: "lead_vendors" },
    { id: "yard_signs", label: "Yard signs and trucks", channel: "other" }
  ],
  appointments: [
    { id: "walk_in", label: "Walk-in", channel: "walk_in" },
    { id: "online_booking", label: "Online booking", channel: "web", parent_id: "website" },
    { id: "social", label: "Social media", channel: "paid" }
  ],
  general: []
};

const step = (id: string, label: string, term: string, when: JsonObject[], extra: JsonObject = {}) => ({ id, label, term, when, ...extra });
const nodeDone = (templateNodeId: string) => [
  { event: "work.node.completed", conditions: { "node.template_node_id": templateNodeId } },
  { event: "work.node.skipped", conditions: { "node.template_node_id": templateNodeId } }
];
const [LEAD, SET, SAT, WON] = DEFAULT_FUNNEL.milestones;
const PACK_FUNNELS: Record<string, JsonObject[] | null> = {
  roofing: [LEAD!, { ...SET!, label: "Inspection set" }, { ...SAT!, label: "Inspected" },
    step("contingency", "Contingency signed", "", [{ event: "work.node.completed", conditions: { "node.template_node_id": "sign_contingency" } }]),
    WON!, step("net", "Sale stands", "", nodeDone("rescission_window"))],
  in_home: [LEAD!, SET!, { ...SAT!, label: "Sat" }, { ...WON!, label: "Sold" }, step("net", "Net sale", "", nodeDone("rescission_window"))],
  home_services: null,
  appointments: [{ ...LEAD!, label: "New client" }, step("booked", "Booked", "", [{ event: "project.event_scheduled" }], { credit: "actor" }), step("visited", "Visited", "", [{ event: "project.event.completed" }], { credit: "assignee" })],
  general: null
};

const FEDERAL_RULE = { id: "federal_cooling_off", label: "Federal cooling-off rule", days: 3, count: "business", holidays: "us_federal", conditions: {}, note: "Sales made in the customer's home over $25 (16 CFR 429). Check your state's rules; some are longer, such as for older customers or insurance work." };
const PACK_RESCISSION: Record<string, JsonObject | null> = {
  roofing: { enabled: true, rules: [FEDERAL_RULE] },
  in_home: { enabled: true, rules: [FEDERAL_RULE] },
  home_services: null, appointments: null, general: null
};

const PACK_VIEWS: Record<string, PresetView[]> = {
  roofing: [
    { key: "roofing_claims_open", name: "Open claims", collection: "opportunities", definition: {
      filter: all(any("state", ["open"]), any("cf.claim.status", ["filed", "adjuster_scheduled", "supplement"])), group_by: "cf.claim.status", sort: [{ key: "created_at", dir: "asc" }],
      icon: "fa-file-contract", description: "Insurance sales waiting on the carrier." } }
  ],
  in_home: [
    { key: "in_home_in_window", name: "In the cancellation window", collection: "opportunities", definition: {
      filter: all({ field: "rescission_until", operator: "after", value: "now" }), sort: [{ key: "rescission_until", dir: "asc" }], columns: ["contact_name", "value_cents", "won_at", "rescission_until"],
      icon: "fa-hourglass-half", description: "Sold, and the customer can still cancel." } }
  ],
  appointments: [
    { key: "appointments_rebook", name: "Due to rebook", collection: "contacts", definition: {
      filter: all({ field: "customer", operator: "equals", value: true }, { field: "next_appointment_at", operator: "is_missing" }, { field: "last_activity_at", operator: "before", value: "now-42d" }),
      sort: [{ key: "last_activity_at", dir: "asc" }], icon: "fa-rotate", description: "Clients with nothing booked who have not been in for six weeks." } }
  ]
};

export const INDUSTRY_PACKS = {
  roofing: { label: "Roofing and exteriors", scopes: ["insurance_roof_sale"], description: "Inspections, insurance claims and contingency agreements, canvassing and storm leads, a cancellation window." },
  in_home: { label: "In-home sales", scopes: ["in_home_sale"], description: "Set, sit and sell at the table, with a cancellation window before production." },
  home_services: { label: "Home services and repair", scopes: [], description: "Fast response, same-day visits and repeat customers." },
  appointments: { label: "Appointment businesses", scopes: [], description: "Clients who book visits, such as salons, clinics and studios. Booked and visited, and who is due back." },
  general: { label: "Something else", scopes: [], description: "The base CRM: leads, follow-ups, appointments and sources." }
} as const;
export type IndustryPack = keyof typeof INDUSTRY_PACKS;
export const isIndustryPack = (value: unknown): value is IndustryPack => typeof value === "string" && value in INDUSTRY_PACKS;

/**
 * Which CRM features a team of this size starts with. A one-person shop sees a list, its
 * appointments and its follow-ups; worklists, the funnel and spend arrive as the team grows.
 * Every value is an ordinary capability the company can change later.
 */
export function sizeTier(employees: number) {
  const n = Number.isFinite(employees) && employees > 0 ? Math.floor(employees) : 1;
  const tier = n <= 2 ? "solo" : n <= 10 ? "small" : n <= 50 ? "mid" : n <= 250 ? "large" : "enterprise";
  const at = (min: "solo" | "small" | "mid" | "large") => ["solo", "small", "mid", "large", "enterprise"].indexOf(tier) >= ["solo", "small", "mid", "large"].indexOf(min);
  return {
    tier,
    capabilities: {
      "crm.views": true,
      "crm.sources": true,
      "crm.worklists": at("small"),
      "crm.funnel": at("small"),
      "crm.call_lists": at("small"),
      "crm.source_spend": at("mid")
    } as Record<string, boolean>
  };
}

async function hasModule(orgId: string, moduleId: string) {
  try { await readBranchModule(orgId, "default", moduleId); return true; }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return false; throw error; }
}

const baseInstalled = new Set<string>();
/** Installs the base views once per organization (cheap after the first call in a process). */
export async function ensureBaseViews(orgId: string) {
  if (baseInstalled.has(orgId)) return 0;
  const installed = await installPresetViews(orgId, BASE_VIEWS);
  baseInstalled.add(orgId);
  return installed;
}

/**
 * Applies an industry pack: views, sources, funnel, cancellation rules and scopes the
 * organization does not have yet. With `capabilities`, also turns CRM features on or off for
 * the team size. Returns what it changed.
 */
export async function applyCrmPreset(orgId: string, input: { industry: IndustryPack; employees?: number; capabilities?: boolean }) {
  const pack = input.industry;
  const added: JsonObject = { views: 0, sources: 0, funnel: false, rescission: false, scopes: [] as string[], capabilities: {} };
  added.views = Number(await installPresetViews(orgId, [...BASE_VIEWS, ...(PACK_VIEWS[pack] || [])]));

  const catalog = await readSourceCatalog(orgId);
  if (!catalog.sources.length) {
    const seeds = [...COMMON_SOURCES, ...(PACK_SOURCES[pack] || [])];
    const ids = new Set(seeds.map(s => s.id));
    const sources = seeds.filter((s, i) => seeds.findIndex(x => x.id === s.id) === i).map((s, position) => ({ id: s.id, label: s.label, channel: s.channel, parent_id: s.parent_id && ids.has(s.parent_id) ? s.parent_id : "", rules: s.rules || {}, active: true, position }));
    await saveSourceCatalog(orgId, { sources });
    added.sources = sources.length;
  }
  const funnel = PACK_FUNNELS[pack];
  if (funnel && !(await hasModule(orgId, FUNNEL_MODULE))) { await saveFunnel(orgId, { milestones: funnel }); added.funnel = true; }
  const rescission = PACK_RESCISSION[pack];
  if (rescission && !(await hasModule(orgId, RESCISSION_MODULE))) { await saveRescission(orgId, rescission); added.rescission = true; }

  // The pack's scopes are scope library entries (scopes/library.ts), copied once.
  const { scopeLibraryEntry } = await import("../scopes/library.js");
  const { installLibraryScopeTemplate, readScopeTemplate } = await import("../scopes/storage.js");
  for (const id of INDUSTRY_PACKS[pack].scopes) {
    if (!scopeLibraryEntry(id)) continue;
    const exists = await readScopeTemplate(orgId, "default", id).then(() => true, (error) => { if (error instanceof PlatformError && error.statusCode === 404) return false; throw error; });
    if (exists) continue;
    await installLibraryScopeTemplate(orgId, "default", id);
    (added.scopes as string[]).push(id);
  }

  // Features follow the team size only when the person setting up asked for it.
  if (input.capabilities === true) {
    const { saveCapabilityValues } = await import("../platform/capabilities.js");
    const wanted: Record<string, boolean> = { ...sizeTier(Number(input.employees || 1)).capabilities, ...(PACK_RESCISSION[pack] ? { "crm.rescission": true } : {}) };
    await saveCapabilityValues(orgId, wanted);
    added.capabilities = wanted;
  }
  return added;
}
