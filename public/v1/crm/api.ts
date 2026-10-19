import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { can, hasPermission, requirePlatformAuth, type PlatformAuthContext } from "../platform/auth.js";
import { badRequest } from "../platform/errors.js";
import type { JsonObject } from "../platform/storage.js";
import { listNodeRecords } from "../work/storage.js";
import { isFollowUpWorkNode } from "../work/followups.js";
import { appointmentRows, contactRows, crmSources, followUpRows, opportunityRows, CRM_COLLECTIONS, type CrmCollection } from "./records.js";
import { canManageSharedViews, collectionPermission, deleteView, listViews, readView, runQuery, saveView, setViewPreference, viewDefinitionSchema } from "./views.js";
import { readSourceCatalog, saveSourceCatalog, listSpend, saveSpend, deleteSpend, withPaths } from "./sources.js";
import { readFunnel, saveFunnel, projectMilestones, milestoneFields, funnelReport, type FunnelGroup } from "./funnel.js";
import { recordResult, resultOutcomes, lastResults, projectResults } from "./results.js";
import { cancelSaleInWindow, readRescission, saveRescission } from "./rescission.js";
import { applyCrmPreset, ensureBaseViews, INDUSTRY_PACKS, isIndustryPack, sizeTier } from "./presets.js";
import { readRouting, saveRouting, ROUTING_PROGRAM, SCORING_PROGRAM, ROUTING_FIELDS } from "./routing.js";
import { readContactRules, saveContactRules } from "./contact-rules.js";

// The CRM routes (docs/architecture/crm.md). Every collection row is filtered by the
// caller's branch scope and department access before a view's filter runs; nothing here
// writes a contact, project or plan except through results, which reuse existing writers.

const text = (value: unknown) => String(value ?? "").trim();
const object = (value: unknown): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const param = (request: { params: unknown }, key: string) => text(object(request.params)[key]);
/** Every CRM route belongs to the CRM tab (docs/architecture/app-experience.md); intake and scope steps read CRM settings in-process, not through these routes. */
const CRM_APP = ["portal.crm"];

const COLLECTION_INFO: Record<CrmCollection, { label: string; term: string; icon: string }> = {
  opportunities: { label: "Leads", term: "crm.leads", icon: "fa-bullseye" },
  contacts: { label: "Contacts", term: "contacts.contacts", icon: "fa-address-book" },
  follow_ups: { label: "Follow-ups", term: "crm.follow_ups", icon: "fa-phone" },
  appointments: { label: "Appointments", term: "crm.appointments", icon: "fa-calendar-check" }
};

async function features(ctx: PlatformAuthContext) {
  const keys = ["crm.views", "crm.worklists", "crm.sources", "crm.source_spend", "crm.funnel", "crm.rescission", "scheduling.appointment_slots", "crm.call_lists"] as const;
  const values = await Promise.all(keys.map(key => can(ctx, key).catch(() => false)));
  return Object.fromEntries(keys.map((key, i) => [key.replace(/^crm\./, "").replace(/^scheduling\./, ""), values[i] === true]));
}

/** The rows of one collection, for one viewer. */
export async function collectionFor(ctx: PlatformAuthContext | null, orgId: string, collection: CrmCollection, options: { withMilestones?: boolean } = {}) {
  const src = await crmSources(orgId);
  if (collection === "contacts") return contactRows(src, ctx);
  if (collection === "follow_ups") return followUpRows(src, ctx);
  if (collection === "appointments") return appointmentRows(src, ctx);
  const [catalog, touches, nodes] = await Promise.all([readSourceCatalog(orgId), lastResults(orgId), listNodeRecords(orgId, { actionable: true, open_only: true })]);
  const followUps = new Map<string, string>();
  for (const node of nodes.filter(isFollowUpWorkNode)) {
    const at = text(node.due_at), projectId = text(node.project_id);
    if (projectId && at && (!followUps.get(projectId) || at < followUps.get(projectId)!)) followUps.set(projectId, at);
  }
  const funnel = options.withMilestones !== false ? await readFunnel(orgId) : null;
  const milestones = funnel ? milestoneFields(await projectMilestones(orgId, funnel)) : undefined;
  const result = await opportunityRows(src, ctx, { sources: new Map(withPaths(catalog.sources).map(s => [s.id, s])), touches, followUps, milestones });
  if (funnel) for (const m of funnel.milestones) result.fields.push({ key: `milestone.${m.id}`, label: m.label, term: m.term || undefined, type: "date", group: "funnel", groupable: false });
  return result;
}

function assertCollection(value: unknown): CrmCollection {
  const id = text(value) as CrmCollection;
  if (!CRM_COLLECTIONS.includes(id)) throw badRequest("crm_collection_unknown", "Choose leads, contacts, follow-ups or appointments.");
  return id;
}

export async function registerCrmAppApi(app: FastifyInstance) {
  app.get("/", async () => ({ ok: true, api: "crm" }));

  app.get("/organizations/:orgId/meta", async request => {
    const orgId = param(request, "orgId");
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, capability: "crm.views" });
    const collections = CRM_COLLECTIONS.filter(c => hasPermission(ctx, collectionPermission(c))).map(id => ({ id, ...COLLECTION_INFO[id] }));
    return { ok: true, collections, features: await features(ctx), can_share_views: canManageSharedViews(ctx), outcomes: await resultOutcomes(orgId, ctx.branchId || "default"), user_id: ctx.userId };
  });

  app.get("/organizations/:orgId/views", async request => {
    const orgId = param(request, "orgId");
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, capability: "crm.views" });
    await ensureBaseViews(orgId);
    return { ok: true, views: (await listViews(ctx)).filter(v => hasPermission(ctx, collectionPermission(v.collection))) };
  });
  app.post("/organizations/:orgId/views", async (request, reply) => {
    const orgId = param(request, "orgId");
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, capability: "crm.views" });
    const body = object(request.body);
    if (!hasPermission(ctx, collectionPermission(text(body.collection)))) throw badRequest("crm_collection_denied", "You cannot see that collection.");
    reply.code(201);
    return { ok: true, view: await saveView(ctx, "", body) };
  });
  app.put("/organizations/:orgId/views/:viewId", async request => {
    const orgId = param(request, "orgId");
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, capability: "crm.views" });
    return { ok: true, view: await saveView(ctx, param(request, "viewId"), request.body) };
  });
  app.delete("/organizations/:orgId/views/:viewId", async request => {
    const orgId = param(request, "orgId");
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, capability: "crm.views" });
    return { ok: true, ...(await deleteView(ctx, param(request, "viewId"))) };
  });
  app.put("/organizations/:orgId/views/:viewId/preference", async request => {
    const orgId = param(request, "orgId");
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, capability: "crm.views" });
    return { ok: true, ...(await setViewPreference(ctx, param(request, "viewId"), request.body)) };
  });

  /** Rows of a collection through a saved view, a definition sent by the browser (an unsaved change), or both. */
  app.post("/organizations/:orgId/query", async request => {
    const orgId = param(request, "orgId");
    const body = z.object({
      collection: z.string().trim().max(40).optional(), view_id: z.string().trim().max(120).optional(),
      definition: viewDefinitionSchema.partial().optional(), search: z.string().max(200).optional(),
      offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).optional()
    }).strict().parse(request.body ?? {});
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, capability: "crm.views" });
    const view = body.view_id ? await readView(ctx, body.view_id) : null;
    const collection = assertCollection(body.collection || view?.collection);
    if (!hasPermission(ctx, collectionPermission(collection))) throw badRequest("crm_collection_denied", "You cannot see that collection.");
    const definition = { ...(view?.definition || {}), ...(body.definition || {}) };
    const result = await collectionFor(ctx, orgId, collection, { withMilestones: await can(ctx, "crm.funnel").catch(() => false) });
    return { ok: true, collection, view_id: view?.id || "", ...runQuery(result, { definition, search: body.search, offset: body.offset, limit: body.limit }, ctx) };
  });

  // ---- Results (worklists) ----
  app.post("/organizations/:orgId/results", async (request, reply) => {
    const orgId = param(request, "orgId");
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, permission: "manage_projects", capability: "crm.views" });
    reply.code(201);
    return { ok: true, result: await recordResult(ctx, request.body) };
  });
  app.get("/organizations/:orgId/projects/:projectId/results", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, permission: "view_projects", capability: "crm.views" });
    return { ok: true, results: await projectResults(orgId, param(request, "projectId")) };
  });

  // ---- Sources and spend ----
  app.get("/organizations/:orgId/sources", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, capability: "crm.sources" });
    const catalog = await readSourceCatalog(orgId);
    return { ok: true, sources: withPaths(catalog.sources), channels: ["web", "phone", "referral", "canvass", "event", "aggregator", "paid", "email", "walk_in", "other"] };
  });
  app.put("/organizations/:orgId/sources", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, permission: "manage_company_settings", capability: "crm.sources" });
    return { ok: true, sources: withPaths((await saveSourceCatalog(orgId, request.body)).sources) };
  });
  app.get("/organizations/:orgId/spend", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, permission: "manage_company_settings", capability: "crm.source_spend" });
    const query = object(request.query);
    return { ok: true, spend: await listSpend(orgId, { from: text(query.from), to: text(query.to) }) };
  });
  app.put("/organizations/:orgId/spend/:spendId", async request => {
    const orgId = param(request, "orgId");
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, permission: "manage_company_settings", capability: "crm.source_spend" });
    return { ok: true, spend: await saveSpend(orgId, ctx.userId, param(request, "spendId") === "new" ? "" : param(request, "spendId"), request.body) };
  });
  app.delete("/organizations/:orgId/spend/:spendId", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, permission: "manage_company_settings", capability: "crm.source_spend" });
    return { ok: true, ...(await deleteSpend(orgId, param(request, "spendId"))) };
  });

  // ---- Funnel ----
  app.get("/organizations/:orgId/funnel", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, capability: "crm.funnel" });
    return { ok: true, funnel: await readFunnel(orgId) };
  });
  app.put("/organizations/:orgId/funnel", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, permission: "manage_company_settings", capability: "crm.funnel" });
    return { ok: true, funnel: await saveFunnel(orgId, request.body) };
  });
  app.get("/organizations/:orgId/funnel/report", async request => {
    const orgId = param(request, "orgId");
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, permission: "view_projects", capability: "crm.funnel" });
    const query = z.object({
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      group: z.enum(["source", "source_kind", "scope", "branch", "month", "setter", "rep", "owner", "none"]).default("source"),
      owner_field: z.string().trim().max(200).optional()
    }).parse(object(request.query));
    const funnel = await readFunnel(orgId);
    const src = await crmSources(orgId);
    const milestones = await projectMilestones(orgId, funnel);
    const rows = (await collectionFor(ctx, orgId, "opportunities", { withMilestones: false })).rows;
    const report = await funnelReport(orgId, rows, milestones, funnel, { from: query.from, to: query.to, group: query.group as FunnelGroup, owner_field: query.owner_field }, src.people);
    const spendVisible = await can(ctx, "crm.source_spend").catch(() => false) && hasPermission(ctx, "manage_company_settings");
    if (!spendVisible) {
      const strip = (g: JsonObject) => ({ ...g, spend_cents: null, milestones: (g.milestones as JsonObject[]).map(m => ({ ...m, cost_cents: null })) });
      return { ok: true, ...report, groups: report.groups.map(strip), totals: report.totals ? strip(report.totals) : null, spend_cents: null };
    }
    return { ok: true, ...report };
  });

  // ---- Rescission ----
  app.get("/organizations/:orgId/rescission", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, capability: "crm.rescission" });
    return { ok: true, rescission: await readRescission(orgId) };
  });
  app.put("/organizations/:orgId/rescission", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, permission: "manage_company_settings", capability: "crm.rescission" });
    return { ok: true, rescission: await saveRescission(orgId, request.body) };
  });
  // ---- Presets: an industry pack and a team size ----
  app.get("/organizations/:orgId/presets", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, permission: "manage_company_settings", capability: "crm.views" });
    const employees = Number(object(request.query).employees || 0);
    return { ok: true, packs: Object.entries(INDUSTRY_PACKS).map(([id, pack]) => ({ id, ...pack })), ...(employees ? { tier: sizeTier(employees) } : {}) };
  });
  // ---- Lead routing and scoring: settings that generate organization rules running sandbox programs ----
  app.get("/organizations/:orgId/routing", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, permission: "manage_company_settings", capability: "crm.views" });
    return { ok: true, routing: await readRouting(orgId), presets: { routing_source: ROUTING_PROGRAM.trim(), scoring_source: SCORING_PROGRAM.trim() }, fields: ROUTING_FIELDS.map(f => ({ path: f.path, label: f.label, type: f.type })) };
  });
  app.put("/organizations/:orgId/routing", async request => {
    const orgId = param(request, "orgId");
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, permission: "manage_company_settings", capability: "crm.views" });
    return { ok: true, routing: await saveRouting(orgId, request.body, ctx.userId) };
  });

  // ---- Contact automations: settings that generate organization rules on contact events and dates ----
  app.get("/organizations/:orgId/contact-rules", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, permission: "manage_company_settings", capability: "crm.views" });
    const [settings, roles, defs, contacts] = await Promise.all([
      readContactRules(orgId),
      (await import("../workforce/access.js")).listAccessRoles(orgId).catch(() => []),
      (await import("../custom_fields/records.js")).definitions(orgId, "default", "contact").catch(() => []),
      collectionFor(null, orgId, "contacts").catch(() => null)
    ]);
    // What a rule's conditions can read about the contact, in the CRM's field shape.
    const kindOf = (type: string) => ["date", "datetime"].includes(type) ? "date" : type === "boolean" ? "bool" : ["integer", "number", "money"].includes(type) ? "number" : ["select", "multi_select"].includes(type) ? (type === "select" ? "select" : "multi") : ["text", "textarea", "email", "phone", "url"].includes(type) ? "text" : "";
    const tagOptions = (contacts?.fields || []).find((f: JsonObject) => f.key === "tags")?.options || [];
    const custom = (defs as JsonObject[]).filter(f => !f.inferred && kindOf(String(f.type || "")) && f.enabled !== false)
      .map(f => ({ key: `contact.cf.${String(f.path || f.key)}`, label: String(f.label || f.path), type: kindOf(String(f.type)), group: "fields", ...(Array.isArray(f.options) && f.options.length ? { options: (f.options as unknown[]).map(o => typeof o === "object" && o ? { value: String((o as JsonObject).value ?? (o as JsonObject).id ?? ""), label: String((o as JsonObject).label ?? (o as JsonObject).value ?? "") } : { value: String(o), label: String(o) }) } : {}) }));
    const fields = [
      { key: "contact.name", label: "Name", type: "text" }, { key: "contact.first_name", label: "First name", type: "text" },
      { key: "contact.email", label: "Email", type: "text" }, { key: "contact.phone", label: "Phone", type: "text" },
      { key: "contact.address", label: "Address", type: "text" }, { key: "contact.company", label: "Company", type: "text" },
      { key: "contact.kind", label: "Kind", type: "select", options: [{ value: "human", label: "Person" }, { value: "org", label: "Company" }] },
      { key: "contact.tags", label: "Tags", type: "multi", options: tagOptions }, { key: "contact.birthday", label: "Birthday", type: "date" },
      ...custom
    ];
    return { ok: true, contact_rules: settings, fields,
      date_fields: [{ key: "birthday", label: "Birthday" }, ...custom.filter(f => f.type === "date").map(f => ({ key: f.key.slice("contact.".length), label: f.label }))],
      roles: (roles as JsonObject[]).map(r => ({ id: String(r.id), label: String(r.name || r.label || r.id) })),
      tags: tagOptions };
  });
  app.put("/organizations/:orgId/contact-rules", async request => {
    const orgId = param(request, "orgId");
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, permission: "manage_company_settings", capability: "crm.views" });
    return { ok: true, contact_rules: await saveContactRules(orgId, request.body, ctx.userId) };
  });

  app.post("/organizations/:orgId/presets/apply", async request => {
    const orgId = param(request, "orgId");
    await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, permission: "manage_company_settings", capability: "crm.views" });
    const body = object(request.body);
    if (!isIndustryPack(body.industry)) throw badRequest("crm_preset_unknown", "Choose one of the industry presets.");
    return { ok: true, applied: await applyCrmPreset(orgId, { industry: body.industry, employees: Number(body.employees || 1), capabilities: body.capabilities === true }) };
  });

  app.post("/organizations/:orgId/projects/:projectId/cancel-sale", async request => {
    const orgId = param(request, "orgId");
    const ctx = await requirePlatformAuth(request, { app: CRM_APP, orgId, csrf: true, permission: "manage_projects", capability: "crm.rescission" });
    const reason = typeof (request.body as JsonObject | null)?.reason === "string" ? String((request.body as JsonObject).reason).slice(0, 500) : "";
    return { ok: true, ...(await cancelSaleInWindow(orgId, param(request, "projectId"), { reason, actor_user_id: ctx.userId })) };
  });
}
