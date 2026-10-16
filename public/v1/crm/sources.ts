import { randomBytes } from "node:crypto";
import { z } from "zod";
import { badRequest, PlatformError } from "../platform/errors.js";
import { readBranchModule, saveBranchModule, type JsonObject } from "../platform/storage.js";
import { evaluateConditions, validateConditions } from "../work/conditions.js";
import { crmViewStore } from "./views.js";

// The source catalog (docs/architecture/crm.md, "Sources and attribution"): a tree of
// source, sub-source and campaign or event, each with a channel and match rules in the
// condition contract over the arriving lead. receiveLead stamps the first matching
// source; spend per source and period is entered by the organization.

export const SOURCES_MODULE = "crm_sources";
export const CHANNELS = ["web", "phone", "referral", "canvass", "event", "aggregator", "paid", "email", "walk_in", "other"] as const;

const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};

const sourceSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "Source ids use lower-case letters, numbers, underscores and hyphens."),
  label: z.string().trim().min(1).max(120),
  parent_id: z.string().trim().max(64).default(""),
  channel: z.enum(CHANNELS).default("other"),
  rules: z.object({}).passthrough().default({}),
  active: z.boolean().default(true),
  position: z.number().int().min(0).max(100000).default(0)
}).strict();
export type LeadSource = z.infer<typeof sourceSchema> & { path_label?: string; depth?: number };
const catalogSchema = z.object({ version: z.literal(1).default(1), sources: z.array(sourceSchema).max(500).default([]) }).strict();

export function normalizeSourceCatalog(value: unknown) {
  const catalog = catalogSchema.parse({ ...object(value), version: 1 });
  const ids = new Set<string>();
  for (const source of catalog.sources) {
    if (ids.has(source.id)) throw badRequest("crm_source_duplicate", `The source id "${source.id}" is used more than once.`);
    ids.add(source.id);
    const issues = validateConditions(source.rules, `source "${source.id}" rules`);
    if (issues.length) throw badRequest("crm_source_rules_invalid", issues[0]!, { issues });
  }
  for (const source of catalog.sources) {
    if (source.parent_id && !ids.has(source.parent_id)) throw badRequest("crm_source_parent_missing", `"${source.label}" names a parent that is not in the catalog.`);
    let seen = new Set([source.id]), parent = source.parent_id;
    while (parent) {
      if (seen.has(parent)) throw badRequest("crm_source_cycle", `"${source.label}" is inside itself.`);
      seen.add(parent); parent = catalog.sources.find(s => s.id === parent)?.parent_id || "";
    }
  }
  return catalog;
}

/** Each source with its full path label ("Paid › Google › Spring roofs") and depth. */
export function withPaths(sources: LeadSource[]) {
  const byId = new Map(sources.map(s => [s.id, s]));
  return sources.map(source => {
    const chain: string[] = []; let node: LeadSource | undefined = source;
    while (node) { chain.unshift(node.label); node = node.parent_id ? byId.get(node.parent_id) : undefined; }
    return { ...source, path_label: chain.join(" › "), depth: chain.length - 1 };
  });
}

export async function readSourceCatalog(orgId: string) {
  try { return normalizeSourceCatalog((await readBranchModule(orgId, "default", SOURCES_MODULE)).data); }
  catch (error) { if (error instanceof PlatformError && error.statusCode === 404) return normalizeSourceCatalog({}); throw error; }
}

export async function saveSourceCatalog(orgId: string, value: unknown) {
  const catalog = normalizeSourceCatalog(object(value).data ?? value);
  await saveBranchModule(orgId, "default", SOURCES_MODULE, { data: catalog, metadata: { kind: "crm_sources" } }, { replace: true });
  return catalog;
}

/**
 * The first active source whose rules match the arriving project, deepest first so a
 * campaign wins over its source. A source with no rules never matches by itself.
 */
export function matchSource(sources: LeadSource[], project: JsonObject) {
  const candidates = withPaths(sources).filter(s => s.active && Object.keys(object(s.rules)).length)
    .sort((a, b) => (b.depth || 0) - (a.depth || 0) || a.position - b.position);
  const context = { ...project, project, lead_source: object(project.lead_source) };
  return candidates.find(s => evaluateConditions(s.rules, context, { caseInsensitive: true, commaLists: true, payloadFallback: false })) || null;
}

const TRACKING_PARAMS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid", "msclkid"] as const;

/** The ad tracking tags in the page a lead came from, for any the source did not record itself. */
export function trackingTags(lead: JsonObject) {
  const tags: JsonObject = {};
  for (const url of [text(lead.page_url), text(object(lead.provider_fields).page_url)].filter(Boolean)) {
    let params: URLSearchParams;
    try { params = new URL(url).searchParams; } catch { continue; }
    for (const key of TRACKING_PARAMS) if (!text(lead[key]) && !text(tags[key]) && text(params.get(key))) tags[key] = text(params.get(key)).slice(0, 200);
  }
  return tags;
}

/**
 * Stamps a project that just arrived (receiveLead) with the tracking tags of its page and the
 * matching source. Never overwrites a source a person set.
 */
export async function stampLeadSource(orgId: string, projectId: string) {
  const { readDocument } = await import("../platform/storage.js");
  const { updateProjectData } = await import("../platform/project_document_mutation.js");
  const catalog = await readSourceCatalog(orgId);
  const project: JsonObject = { id: projectId, ...object((await readDocument(orgId, "projects", projectId)).data) };
  const lead = object(project.lead_source);
  const tags = trackingTags(lead);
  if (!catalog.sources.length && !Object.keys(tags).length) return null;
  const tagged = { ...project, lead_source: { ...lead, ...tags } };
  const match = text(lead.source_id) || !catalog.sources.length ? null : matchSource(catalog.sources, tagged);
  if (!match && !Object.keys(tags).length) return text(lead.source_id) || null;
  await updateProjectData(orgId, projectId, data => ({ ...data, lead_source: { ...object(object(data).lead_source), ...tags, ...(match ? { source_id: match.id, source_path: match.path_label, source_channel: match.channel } : {}) } }));
  return match?.id || text(lead.source_id) || null;
}

// ---- Spend ------------------------------------------------------------------

const spendSchema = z.object({
  source_id: z.string().trim().min(1).max(64),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount_cents: z.number().int().min(0).max(1_000_000_000_00),
  note: z.string().trim().max(500).default("")
}).strict();

export async function listSpend(orgId: string, options: { from?: string; to?: string } = {}) {
  const rows = await crmViewStore().prepare("SELECT * FROM crm_source_spend WHERE organization_id=? AND (?='' OR period_end>=?) AND (?='' OR period_start<=?) ORDER BY period_start DESC, source_id")
    .all(orgId, text(options.from), text(options.from), text(options.to), text(options.to));
  return rows.map(r => ({ id: text(r.id), source_id: text(r.source_id), period_start: text(r.period_start), period_end: text(r.period_end), amount_cents: Number(r.amount_cents || 0), note: text(r.note), created_at: text(r.created_at) }));
}

export async function saveSpend(orgId: string, userId: string, id: string, value: unknown) {
  const input = spendSchema.parse(value);
  if (input.period_end < input.period_start) throw badRequest("crm_spend_period", "The period ends before it starts.");
  const catalog = await readSourceCatalog(orgId);
  if (!catalog.sources.some(s => s.id === input.source_id)) throw badRequest("crm_spend_source", "Choose a source from the catalog.");
  const db = crmViewStore(), time = new Date().toISOString(), spendId = id || `spend_${randomBytes(8).toString("hex")}`;
  await db.prepare(`INSERT INTO crm_source_spend(organization_id,id,source_id,period_start,period_end,amount_cents,note,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(organization_id,id) DO UPDATE SET source_id=excluded.source_id,period_start=excluded.period_start,period_end=excluded.period_end,amount_cents=excluded.amount_cents,note=excluded.note,updated_at=excluded.updated_at`)
    .run(orgId, spendId, input.source_id, input.period_start, input.period_end, input.amount_cents, input.note, userId, time, time);
  return { id: spendId, ...input };
}

export async function deleteSpend(orgId: string, id: string) {
  await crmViewStore().prepare("DELETE FROM crm_source_spend WHERE organization_id=? AND id=?").run(orgId, text(id));
  return { id, deleted: true };
}

/**
 * Spend falling inside [from, to], prorated by days when a period straddles the window,
 * per source. A source's spend also counts for its parents.
 */
/**
 * Spend in a period, prorated by the days it overlaps: `direct` is what was entered on each
 * source, `rolled` adds every source's spend to its parents for a tree.
 */
export async function spendBySource(orgId: string, from: string, to: string) {
  const day = 86_400_000;
  const catalog = withPaths((await readSourceCatalog(orgId)).sources);
  const byId = new Map(catalog.map(s => [s.id, s]));
  const direct = new Map<string, number>(), rolled = new Map<string, number>();
  const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`) + day;
  for (const row of await listSpend(orgId, { from, to })) {
    const ps = Date.parse(`${row.period_start}T00:00:00Z`), pe = Date.parse(`${row.period_end}T00:00:00Z`) + day;
    const overlap = Math.max(0, Math.min(pe, end) - Math.max(ps, start));
    if (!overlap || !Number.isFinite(overlap)) continue;
    const share = Math.round(row.amount_cents * overlap / Math.max(day, pe - ps));
    direct.set(row.source_id, (direct.get(row.source_id) || 0) + share);
    let node = byId.get(row.source_id);
    while (node) { rolled.set(node.id, (rolled.get(node.id) || 0) + share); node = node.parent_id ? byId.get(node.parent_id) : undefined; }
  }
  return { direct, rolled };
}
