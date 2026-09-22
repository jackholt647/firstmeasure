import type { FastifyPluginAsync } from "fastify";
import { ZodError, z } from "zod";

import { requirePlatformAuth } from "../platform/auth.js";
import { PlatformError } from "../platform/errors.js";
import { archiveScopeTemplate, listScopeLibrary, listScopeTemplates, listScopeTemplateVersions, patchScopeFlags, readScopeFlagState, readScopeTemplate, readScopeTemplateVersion, restoreDefaultScopeTemplates, saveScopeTemplate, setScopeTemplateState } from "./storage.js";
import { saveScopeTemplateSchema } from "./schemas.js";
import { applyExplainerPatch, extractAutomationInventory } from "./inventory.js";
import { registerScopeAgentRoutes } from "./agent/api.js";
import { readIntakeRouting, saveIntakeRouting } from "./router.js";
import { registerBuiltinWorkAutomations } from "../work/automations/builtins.js";
import { buildScopeArtifactMap, patchScopeArtifact, createScopeArtifact } from "./artifacts.js";

const objectSchema = z.object({}).passthrough();
const patchScopeFlagsSchema = z.object({
  expected_revision: z.number().int().positive(),
  flags: z.record(z.boolean())
});
const patchScopeTemplateStateSchema = z.object({
  enabled: z.boolean().optional(),
  trashed: z.boolean().optional()
}).refine((value) => value.enabled !== undefined || value.trashed !== undefined, {
  message: "At least one board state change is required."
});

function getParam(params: unknown, key: string) {
  const value = params && typeof params === "object" ? (params as Record<string, unknown>)[key] : "";
  return String(value ?? "").trim();
}

export const registerScopesApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) return reply.code(400).send({ ok: false, error: "validation_error", issues: error.issues });
    if (error instanceof PlatformError) return reply.code(error.statusCode).send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    app.log.error(error);
    return reply.code(500).send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({ ok: true, api: "scopes" }));

  app.get("/organizations/:orgId/scope-flags", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects|manage_company_settings" });
    const query = objectSchema.parse(request.query ?? {});
    const branchId = String(query.branch_id || query.branchId || "default").trim() || "default";
    return { ok: true, ...(await readScopeFlagState(orgId, branchId)) };
  });

  app.patch("/organizations/:orgId/scope-flags", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const query = objectSchema.parse(request.query ?? {});
    const branchId = String(query.branch_id || query.branchId || "default").trim() || "default";
    return { ok: true, ...(await patchScopeFlags(orgId, patchScopeFlagsSchema.parse(request.body ?? {}), branchId)) };
  });

  app.get("/organizations/:orgId/branches/:branchId/templates", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const templates = (await listScopeTemplates(orgId, getParam(request.params, "branchId") || "default", objectSchema.parse(request.query ?? {})));
    return { ok: true, templates, count: templates.length };
  });

  app.get("/organizations/:orgId/branches/:branchId/library", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    const templates = (await listScopeLibrary(orgId, getParam(request.params, "branchId") || "default"));
    return { ok: true, templates, count: templates.length };
  });

  app.get("/organizations/:orgId/branches/:branchId/intake-routing", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    return { ok: true, routing: await readIntakeRouting(orgId, getParam(request.params, "branchId") || "default") };
  });

  app.put("/organizations/:orgId/branches/:branchId/intake-routing", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    return { ok: true, routing: await saveIntakeRouting(orgId, getParam(request.params, "branchId") || "default", objectSchema.parse(request.body ?? {})) };
  });

  app.get("/organizations/:orgId/branches/:branchId/templates/:templateId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    return { ok: true, template: (await readScopeTemplate(orgId, getParam(request.params, "branchId") || "default", getParam(request.params, "templateId"))) };
  });

  app.get("/organizations/:orgId/branches/:branchId/templates/:templateId/versions/:version", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const version = (await readScopeTemplateVersion(orgId, getParam(request.params, "branchId") || "default", getParam(request.params, "templateId"), Number(getParam(request.params, "version"))));
    return { ok: true, version };
  });

  app.get("/organizations/:orgId/branches/:branchId/templates/:templateId/versions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const versions = (await listScopeTemplateVersions(orgId, getParam(request.params, "branchId") || "default", getParam(request.params, "templateId")));
    return { ok: true, versions, count: versions.length };
  });

  app.put("/organizations/:orgId/branches/:branchId/templates/:templateId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = saveScopeTemplateSchema.parse({ ...objectSchema.parse(request.body ?? {}), id: getParam(request.params, "templateId") });
    return { ok: true, template: (await saveScopeTemplate(orgId, getParam(request.params, "branchId") || "default", body)) };
  });

  app.delete("/organizations/:orgId/branches/:branchId/templates/:templateId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    return { ok: true, template: (await archiveScopeTemplate(orgId, getParam(request.params, "branchId") || "default", getParam(request.params, "templateId"))) };
  });

  app.patch("/organizations/:orgId/branches/:branchId/templates/:templateId/state", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = patchScopeTemplateStateSchema.parse(request.body ?? {});
    return {
      ok: true,
      ...(await setScopeTemplateState(
        orgId,
        getParam(request.params, "branchId") || "default",
        getParam(request.params, "templateId"),
        body
      ))
    };
  });

  app.post("/organizations/:orgId/branches/:branchId/templates/reset-defaults", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = objectSchema.parse(request.body ?? {});
    return { ok: true, templates: (await restoreDefaultScopeTemplates(orgId, getParam(request.params, "branchId") || "default", { force: body.force === true })) };
  });

  app.get("/organizations/:orgId/branches/:branchId/templates/:templateId/event-map", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    const branchId = getParam(request.params, "branchId") || "default";
    const template = (await readScopeTemplate(orgId, branchId, getParam(request.params, "templateId"))) as Record<string, unknown>;
    const { readAutomationRules } = await import("../work/rules.js");
    const { rules } = await readAutomationRules(orgId, branchId);
    registerBuiltinWorkAutomations();
    return { ok:true, template:{ id:template.id, name:template.name, version:template.version }, ...buildScopeArtifactMap(template.definition as Record<string, unknown>, rules) };
  });

  app.get("/organizations/:orgId/branches/:branchId/templates/:templateId/artifacts", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission:"manage_company_settings" });
    const template = (await readScopeTemplate(orgId, getParam(request.params, "branchId"), getParam(request.params, "templateId"))) as Record<string, unknown>;
    registerBuiltinWorkAutomations();
    const { listSites, listSitePages } = await import("../websites/storage.js");
    const sites = (await listSites(orgId)).filter(site => site.site_kind === "customer_portal");
    const pages = (await Promise.all(sites.map(async site => (await listSitePages(orgId, String(site.id))).map(page => ({ ...page, site_active:site.status === "active" }))))).flat();
    const catalog = buildScopeArtifactMap(template.definition as Record<string, unknown>, [], pages);
    const { readDocumentTemplate } = await import("../documents/storage.js");
    await Promise.all(catalog.artifacts.filter((item) => item.type === "documents" && item.config.template_id && !String(item.config.template_id).includes("{{")).map(async (item) => {
      try {
        const document = await readDocumentTemplate(orgId, String(item.config.template_id));
        if (document) item.notes.push(`Document library: ${String(document.title || document.name || item.config.template_id)}`);
      } catch { item.notes.push("This template reference could not be resolved in the document library."); }
    }));
    return { ok:true, template:{ id:template.id, name:template.name, version:template.version }, ...catalog };
  });

  const artifactWriteSchema = z.object({ expected_version:z.number().int().positive(), artifact_id:z.string().optional(), usage_id:z.string().optional(), type:z.string().optional(), changes:objectSchema.default({}), trigger:objectSchema.default({}) });
  app.patch("/organizations/:orgId/branches/:branchId/templates/:templateId/artifacts", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf:true, permission:"manage_company_settings" });
    const branchId = getParam(request.params, "branchId");
    const templateId = getParam(request.params, "templateId");
    const template = (await readScopeTemplate(orgId, branchId, templateId)) as Record<string, unknown>;
    const body = artifactWriteSchema.parse(request.body);
    if (body.expected_version !== Number(template.version)) throw new PlatformError("scope_template_version_conflict", 409, "This scope changed. Reload before saving your edit.");
    const before = buildScopeArtifactMap(template.definition as Record<string, unknown>).artifacts;
    const definition = body.artifact_id
      ? patchScopeArtifact(template.definition as Record<string, unknown>, body.artifact_id, body.changes, body.usage_id)
      : createScopeArtifact(template.definition as Record<string, unknown>, body.type || "", body.changes, body.trigger);
    const saved = (await saveScopeTemplate(orgId, branchId, { ...definition, expected_version:body.expected_version }));
    const after = buildScopeArtifactMap(definition).artifacts;
    const original = before.find(item => item.id === body.artifact_id);
    const sourcePath = original?.edit_targets?.find(item => item.id === body.usage_id)?.path || original?.source_path;
    const changed = original ? after.find(item => JSON.stringify(item.source_path) === JSON.stringify(sourcePath) && item.type === original.type)
      : after.find(item => item.type === body.type && !before.some(old => old.id === item.id));
    return { ok:true, template:saved, artifact_id:changed?.id };
  });

  // Natural-language automation inventory: what customers see instead of raw
  // triggers/bindings. Entries without an explainer are hidden by default.
  app.get("/organizations/:orgId/branches/:branchId/templates/:templateId/automation-inventory", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "manage_company_settings" });
    const query = objectSchema.parse(request.query ?? {});
    const branchId = getParam(request.params, "branchId") || "default";
    const template = (await readScopeTemplate(orgId, branchId, getParam(request.params, "templateId"))) as Record<string, unknown>;
    const includeHidden = ["1", "true", "yes"].includes(String(query.include_hidden ?? "").toLowerCase());
    // Organization-wide rules ride along so the UI can show automations that
    // apply to every board (the agent writes those when a request isn't
    // board-specific, e.g. "text me when any project signs").
    const { readAutomationRules, ruleIsCustomerVisible } = await import("../work/rules.js");
    const { rules } = await readAutomationRules(orgId, branchId);
    const organizationRules = rules
      .filter((rule) => includeHidden || ruleIsCustomerVisible(rule))
      .map((rule) => ({
        key: `org_rule:${rule.id}`,
        kind: "organization_rule",
        explainer: String(rule.explainer || rule.title || ""),
        customer_visible: ruleIsCustomerVisible(rule),
        enabled: rule.enabled !== false
      }));
    return {
      ok: true,
      template: { id: template.id, name: template.name, color: template.color, icon: template.icon, description: template.description, version: template.version, status: template.status, enabled: template.enabled !== false, kind: (template.definition as Record<string, unknown>)?.kind || "production" },
      entries: extractAutomationInventory(template.definition as Record<string, unknown>, { include_hidden: includeHidden }),
      organization_rules: organizationRules
    };
  });

  app.patch("/organizations/:orgId/branches/:branchId/templates/:templateId/automation-inventory", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings" });
    const body = objectSchema.parse(request.body ?? {});
    const branchId = getParam(request.params, "branchId") || "default";
    const templateId = getParam(request.params, "templateId");
    const template = (await readScopeTemplate(orgId, branchId, templateId)) as Record<string, unknown>;
    const patched = applyExplainerPatch(template.definition as Record<string, unknown>, String(body.key ?? ""), {
      ...(body.explainer !== undefined ? { explainer: String(body.explainer ?? "") } : {}),
      ...(body.customer_visible !== undefined ? { customer_visible: body.customer_visible === true } : {})
    });
    const saved = (await saveScopeTemplate(orgId, branchId, { ...patched, expected_version: template.version })) as Record<string, unknown>;
    return { ok: true, template: { id: saved.id, version: saved.version }, entries: extractAutomationInventory(saved.definition as Record<string, unknown>, { include_hidden: true }) };
  });

  await registerScopeAgentRoutes(app);
};
