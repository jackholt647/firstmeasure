/**
 * Synthetic leads (dev console, Leads section): N made-up leads, each sent through receiveLead exactly as a real
 * lead arrives, so contact matching, source stamping, intake routing and the organization's lead.received rules
 * all run. Development sandbox organizations only. Never imported by production boot.
 */
import { createHash, randomInt } from "node:crypto";
import { z } from "zod";

import { hasPermission, type PlatformAuthContext } from "../platform/auth.js";
import { readDocument, type JsonObject } from "../platform/storage.js";
import { sandboxError } from "../signup-sandbox/storage.js";
import { requireDevelopmentOrganization } from "./synthetic-data.js";

/** What a synthetic lead can carry; each is a toggle in the section. */
export const LEAD_FIELDS = [
  { id: "name", label: "Name", icon: "fa-user", default: true },
  { id: "phone", label: "Phone", icon: "fa-phone", default: true },
  { id: "email", label: "Email", icon: "fa-envelope", default: true },
  { id: "address", label: "Address", icon: "fa-location-dot", default: true },
  { id: "source", label: "Source", icon: "fa-bullhorn", default: true },
  { id: "note", label: "Note", icon: "fa-comment", default: false }
] as const;
export const MAX_LEADS = 25;

const fields = z.object(Object.fromEntries(LEAD_FIELDS.map(f => [f.id, z.boolean().default(f.default)]))).strict();
const inputSchema = z.object({
  count: z.number().int().min(1).max(MAX_LEADS).default(1),
  fields: fields.default({}),
  /** A source from the organization's catalog; empty picks one at random. */
  source_id: z.string().trim().max(64).default(""),
  request_id: z.string().uuid().optional()
}).strict();

const FIRST = ["Avery", "Jordan", "Taylor", "Morgan", "Riley", "Casey", "Jamie", "Quinn", "Drew", "Skyler", "Parker", "Reese", "Rowan", "Emerson", "Hayden", "Logan", "Sam", "Alex", "Dana", "Kendall"];
const LAST = ["Morgan", "Rivera", "Chen", "Patel", "Nguyen", "Johnson", "Garcia", "Williams", "Brooks", "Foster", "Hughes", "Kim", "Lopez", "Murphy", "Bennett", "Coleman", "Reyes", "Sullivan", "Ward", "Price"];
const STREETS = ["Maple St", "Oak Ave", "Cedar Ln", "Pine Ridge Dr", "Willow Way", "Birch Ct", "Elm St", "Lakeview Dr", "Sunset Blvd", "Hillcrest Rd", "Meadow Ln", "Ridgeview Ct"];
const PLACES = ["Springfield, IL 62704", "Franklin, TN 37064", "Madison, WI 53711", "Fairview, TX 75069", "Greenville, SC 29601", "Salem, OR 97301", "Georgetown, KY 40324", "Clinton, MS 39056"];
const NOTES = ["Saw some shingles in the yard after the storm.", "Wants a quote for a full roof replacement.", "Leak over the kitchen when it rains hard.", "Asked about gutters and a new roof together.", "Neighbor had their roof done and recommended us.", "Insurance adjuster is coming next week."];
const AREA_CODES = [212, 312, 404, 415, 469, 503, 512, 602, 615, 617, 702, 720, 773, 801, 864, 919];
/** Without a source catalog, a source is one of these, as the real intake sources send them. */
const BUILT_IN_SOURCES: JsonObject[] = [
  { kind: "web_form", provider: "Web form", page_url: "https://example.com/roofing?utm_source=google&utm_medium=cpc&utm_campaign=spring_roofs" },
  { kind: "web_form", provider: "Facebook lead ad", page_url: "https://example.com/free-inspection?utm_source=facebook&utm_medium=paid_social" },
  { kind: "referral", provider: "Referral" },
  { kind: "aggregator", provider: "Angi" },
  { kind: "phone_call", provider: "Phone" },
  { kind: "email", provider: "Email" }
];
const KIND_BY_CHANNEL: Record<string, string> = { web: "web_form", paid: "web_form", phone: "phone_call", referral: "referral", canvass: "canvassing", event: "event", aggregator: "aggregator", email: "email", walk_in: "walk_in" };

const pick = <T>(list: readonly T[]): T => list[randomInt(list.length)]!;
const digits = (n: number) => String(randomInt(10 ** n)).padStart(n, "0");

/** The sources the section offers: the organization's active catalog, by path. */
export async function syntheticLeadOptions(ctx: PlatformAuthContext) {
  await requireDevelopmentOrganization(ctx);
  const { readSourceCatalog, withPaths } = await import("../crm/sources.js");
  const sources = withPaths((await readSourceCatalog(ctx.orgId)).sources).filter(s => s.active)
    .map(s => ({ id: s.id, label: s.path_label || s.label, channel: s.channel }));
  return { fields: LEAD_FIELDS, max: MAX_LEADS, sources };
}

/**
 * One made-up lead. Phones are 555-01xx (reserved for fiction) and emails @example.com, so nothing reaches a real
 * person even if a rule on lead.received calls, texts or emails it.
 */
export function syntheticLead(chosen: Record<string, boolean>, sources: { id: string; label: string; channel: string }[], sourceId = "") {
  const first = pick(FIRST), last = pick(LAST);
  const contact: JsonObject = {};
  if (chosen.name) Object.assign(contact, { name: `${first} ${last}`, first_name: first, last_name: last });
  if (chosen.phone) contact.phone = `(${pick(AREA_CODES)}) 555-01${digits(2)}`;
  if (chosen.email) contact.email = `${first}.${last}.${digits(4)}@example.com`.toLowerCase();
  const address = chosen.address ? `${100 + randomInt(9800)} ${pick(STREETS)}, ${pick(PLACES)}` : "";
  let source: JsonObject = { kind: "manual_lead" };
  if (chosen.source) {
    const catalog = sourceId ? sources.find(s => s.id === sourceId) : sources.length ? pick(sources) : undefined;
    source = catalog ? { kind: KIND_BY_CHANNEL[catalog.channel] || "manual_lead", provider: catalog.label, source_id: catalog.id } : { ...pick(BUILT_IN_SOURCES) };
  }
  return { contact, address, summary: chosen.note ? pick(NOTES) : "", source: { ...source, synthetic: true } };
}

export async function generateSyntheticLeads(ctx: PlatformAuthContext, raw: unknown) {
  await requireDevelopmentOrganization(ctx);
  if (!hasPermission(ctx, "manage_projects")) throw sandboxError(403, "permission_denied", "You need manage_projects access to add leads.");
  const parsed = inputSchema.safeParse(raw ?? {});
  if (!parsed.success) throw sandboxError(400, "invalid_leads", `Choose 1 to ${MAX_LEADS} leads and on/off fields.`);
  const chosen = parsed.data.fields as Record<string, boolean>;
  if (!chosen.name && !chosen.phone && !chosen.email && !chosen.address && !chosen.note) throw sandboxError(400, "empty_lead", "Turn on at least a name, phone, email, address or note.");
  const branchId = String(ctx.branchId || "") || "default";
  (await import("../workforce/branch-guards.js")).assertBranchManageable(ctx, branchId);
  const { sources } = await syntheticLeadOptions(ctx);
  if (parsed.data.source_id && !sources.some(s => s.id === parsed.data.source_id)) throw sandboxError(400, "unknown_source", "Choose a source from this organization's catalog.");

  const { receiveLead } = await import("../leads/receive.js");
  const leads: JsonObject[] = [];
  let skipped = 0;
  for (let index = 0; index < parsed.data.count; index++) {
    // A retry of the same request (request_id) names the same projects, so leads already made are not made twice.
    const projectId = parsed.data.request_id ? `project_synthetic_${createHash("sha256").update(`${ctx.orgId}:${parsed.data.request_id}:${index}`).digest("hex").slice(0, 32)}` : "";
    if (projectId && await readDocument(ctx.orgId, "projects", projectId).then(() => true, () => false)) { skipped++; continue; }
    const lead = syntheticLead(chosen, sources, parsed.data.source_id);
    const contacts = Object.keys(lead.contact).length ? [lead.contact] : [];
    const result = await receiveLead(ctx.orgId, {
      branch_id: branchId,
      ...(projectId ? { project_id: projectId } : {}),
      source: lead.source as never,
      contacts: contacts as never,
      address: lead.address,
      summary: lead.summary
    });
    const data = (result.project.data ?? {}) as JsonObject, source = (data.lead_source ?? {}) as JsonObject;
    // Where intake routing put it: a scope and its stage, or nothing yet (a new lead).
    const scope = (((data.work_projection ?? {}) as JsonObject).active_instances as JsonObject[] | undefined)?.[0];
    leads.push({
      project_id: result.project.id, title: data.title ?? "", name: lead.contact.name ?? "", phone: lead.contact.phone ?? "", email: lead.contact.email ?? "",
      address: lead.address, source: String(source.source_path || source.provider || ""), matched: result.matched_contact_ids.length > 0,
      new_lead: ((data.lifecycle ?? {}) as JsonObject).new_lead === true, routed: scope ? [scope.title, scope.stage_title].map(v => String(v ?? "")).filter(Boolean).join(" › ") : ""
    });
  }
  return { organization_id: ctx.orgId, created: leads.length, skipped, leads };
}
