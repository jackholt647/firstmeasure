import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { ZodError } from "zod";

import { PlatformError, badRequest, forbidden } from "../platform/errors.js";
import { requirePlatformAuth } from "../platform/auth.js";
import type { JsonObject } from "../platform/storage.js";
import {
  createTemplateSchema,
  patchTemplateSchema,
  publishTemplateSchema,
  createThemeSchema,
  patchThemeSchema,
  publishThemeSchema,
  createDocumentInstanceSchema,
  patchDocumentInstanceSchema,
  issueDocumentSchema,
  createDocumentSnapshotSchema,
  sendDocumentSchema,
  generateDocumentPdfSchema,
  recordOutputSchema,
  publicViewEventSchema,
  publicPricingPreviewSchema,
  resolveDocumentSchema,
  ingestDocumentSchema,
  voidDocumentInstanceSchema,
  templateFromExamplesSchema,
  uploadFieldsSchema,
  confirmUploadSchema,
  draftUploadTemplateRequestSchema,
  createFolderSchema,
  patchFolderSchema,
  createFolderItemSchema,
  patchFolderItemSchema
} from "./schemas.js";
import { draftUploadTemplateSchema, uploadTemplateDefinition } from "./extraction.js";
import { generateTemplateFromExamples } from "./agent/template_from_examples.js";
// Registers the LLM-backed uploaded-document extractor with the ingestion
// pipeline (side-effect import; falls back to heuristics when unconfigured).
import "./extraction.js";
// Registers the "docs" document-designer agent with the shared agent
// framework (side-effect import — the /v1/agents surface serves its threads).
import "./agent/definition.js";
import {
  createWorkflowSchema,
  patchWorkflowSchema,
  publishWorkflowSchema,
  workflowStateUpdateSchema
} from "./workflows/schemas.js";
import { listWorkflowItemKinds } from "./workflows/kinds.js";
import { listDocumentSources } from "./sources/registry.js";
import { registerBuiltinDocumentSources } from "./sources/builtins.js";
import {
  archiveDocumentTemplate,
  archiveDocumentTheme,
  createDocumentTemplate,
  createDocumentTheme,
  listDocumentEvents,
  listDocumentSnapshots,
  listDocumentTemplateVersions,
  listDocumentTemplates,
  listDocumentThemeVersions,
  listDocumentThemes,
  patchDocumentTemplate,
  patchDocumentTheme,
  publishDocumentTemplate,
  publishDocumentTheme,
  readDocumentTemplate,
  readDocumentTemplateVersion,
  readDocumentTheme,
  readDocumentThemeVersion,
  archiveDocumentWorkflow,
  createDocumentWorkflow,
  listDocumentWorkflowVersions,
  listDocumentWorkflows,
  patchDocumentWorkflow,
  publishDocumentWorkflow,
  readDocumentWorkflow,
  readDocumentWorkflowVersion,
  ensureDefaultDocumentFolders,
  listDocumentFolders,
  readDocumentFolder,
  createDocumentFolder,
  patchDocumentFolder,
  archiveDocumentFolder,
  listDocumentFolderItems,
  listDocumentFolderItemVersions,
  readDocumentFolderItem,
  createDocumentFolderItem,
  patchDocumentFolderItem,
  archiveDocumentFolderItem
} from "./storage.js";
import {
  createDocumentInstance,
  createSnapshot,
  documentWorkflowDetail,
  generateDocumentPdf,
  issueDocument,
  listProjectDocuments,
  patchDocumentInstance,
  publicDocumentWorkflow,
  publicDocumentWorkflowDefinition,
  publicDocumentPaymentIntakeConfig,
  publicDocumentPaymentMethodIntent,
  publicDocumentPricingPreview,
  publicSnapshotView,
  readDocumentInstance,
  readDocumentPdfFile,
  readPublicDocumentPdfFile,
  recordDocumentOutput,
  recordPublicDocumentView,
  resolveDocumentInstance,
  sendDocument,
  updateDocumentWorkflowState,
  voidDocumentInstance,
  updateUploadedDocumentFields,
  confirmUploadedDocument,
  generateFolderItemPdf
} from "./service.js";
import { listDocumentTypes } from "./types/registry.js";
import { listDocumentWidgetResolvers } from "./widgets/registry.js";
import { registerBuiltinDocumentWidgetResolvers } from "./widgets/builtins.js";
import { ensureDefaultDocumentAssets } from "./seeds.js";
import { ingestDocumentUpload } from "./ingestion.js";
import { registerCollabRoutes } from "./collab/routes.js";
import { registerVersionRoutes } from "./versions/routes.js";
import { themeDefinitionWithOrganizationDefaults } from "./theme-defaults.js";
import {
  DOCUMENT_CAPABILITIES,
  capabilityDisabledPatch,
  documentCapabilityEnabled,
  documentCapabilityState,
  documentTypeEnabled,
  requireDocumentTypeEnabled,
  widgetCapability,
  workflowItemCapability
} from "./capability_policy.js";

registerBuiltinDocumentWidgetResolvers();
registerBuiltinDocumentSources();

/** Self-hosted font set shipped with the renderer (doc-renderer/fonts). */
export const DOCUMENT_FONTS = ["Montserrat", "Inter", "Roboto", "Open Sans", "Lato", "Poppins", "Source Sans 3", "Arial"];

/**
 * Mirror of the client widget library (contracts §2) for the editor palette.
 * Includes client-only widgets (form_field, page_number, video…) that have no
 * server resolver; resolver metadata is merged over these descriptors.
 */
export const DOCUMENT_WIDGET_CATALOG: Array<Record<string, unknown>> = [
  { id: "doc.line_items", version: 1, title: "Line items", category: "data", icon: "fa-table-list" },
  { id: "doc.payment_schedule", version: 1, title: "Payment schedule", category: "commerce", icon: "fa-calendar-days" },
  { id: "doc.pay_now", version: 1, title: "Pay now", category: "commerce", icon: "fa-credit-card" },
  { id: "doc.signature", version: 1, title: "Signature", category: "input", icon: "fa-signature" },
  { id: "doc.form_field", version: 1, title: "Form field", category: "input", icon: "fa-i-cursor" },
  { id: "doc.workflow_field", version: 1, title: "Workflow field", category: "input", icon: "fa-list-check" },
  { id: "doc.choice_group", version: 1, title: "Choice group", category: "input", icon: "fa-list-check" },
  { id: "doc.qr", version: 1, title: "QR code", category: "data", icon: "fa-qrcode" },
  { id: "doc.photo", version: 1, title: "Photo", category: "media", icon: "fa-image" },
  { id: "doc.photo_grid", version: 1, title: "Photo grid", category: "media", icon: "fa-images" },
  { id: "doc.photo_carousel", version: 1, title: "Photo carousel", category: "media", icon: "fa-panorama" },
  { id: "doc.video", version: 1, title: "Video", category: "media", icon: "fa-video" },
  { id: "doc.page_number", version: 1, title: "Page number", category: "layout", icon: "fa-hashtag" },
  { id: "doc.measurement_report", version: 1, title: "Measurement report", category: "data", icon: "fa-ruler-combined" }
];

async function themesWithCurrentDefinitions(orgId: string, themes: JsonObject[]) {
  return await Promise.all(themes.map(async (theme) => {
    const current = Number(theme.current_version || 0);
    const version = current
      ? await readDocumentThemeVersion(orgId, cleanText(theme.id), current).catch(() => null)
      : null;
    return { ...theme, definition: version ? asObject(version).definition : null };
  }));
}

export const registerDocumentsApi: FastifyPluginAsync = async (app) => {
  // Collaboration (presence + serialized command log) and version-history
  // checkpoints live in their own modules; they self-manage auth per route.
  registerCollabRoutes(app);
  registerVersionRoutes(app);
  // Every organization-scoped document route belongs to the Documents app.
  // Public snapshot reads stay available for issued-document continuity and
  // audit, while their new signature/payment writes are gated below.
  app.addHook("preHandler", async (request) => {
    const orgId = getParam(request.params, "orgId");
    if (!orgId) return;
    await requirePlatformAuth(request, { orgId, capability: DOCUMENT_CAPABILITIES.app });
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof PlatformError) {
      reply.code(error.statusCode);
      return reply.send({
        ok: false,
        error: error.code,
        message: error.message,
        details: error.details ?? null
      });
    }
    if (typeof (error as { statusCode?: unknown }).statusCode === "number") {
      reply.code(Number((error as { statusCode: number }).statusCode));
      return reply.send({
        ok: false,
        error: String((error as { code?: unknown }).code ?? "request_error"),
        message: String((error as { message?: unknown }).message ?? "The request could not be processed.")
      });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "documents",
    message: "documents API is mounted",
    endpoints: {
      templates: "/organizations/:orgId/templates",
      themes: "/organizations/:orgId/themes",
      catalog: "/organizations/:orgId/catalog",
      projectDocuments: "/organizations/:orgId/projects/:projectId/documents",
      document: "/organizations/:orgId/documents/:documentId",
      resolve: "/organizations/:orgId/documents/:documentId/resolve",
      publicSnapshot: "/public/:token",
      publicPdf: "/public/:token/pdf"
    }
  }));

  // -------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------

  app.get("/organizations/:orgId/templates", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    await ensureDefaultDocumentAssets(orgId);
    const query = asObject(request.query);
    const capabilityState = await documentCapabilityState(orgId);
    const templates = (await listDocumentTemplates(orgId, {
      document_type: cleanText(query.document_type) || undefined,
      status: cleanText(query.status) || undefined
    })).filter((template) => documentTypeEnabled(capabilityState, template.document_type));
    return { ok: true, templates, count: templates.length };
  });

  app.post("/organizations/:orgId/templates", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.studio });
    const body = createTemplateSchema.parse(request.body ?? {});
    const capabilityState = await documentCapabilityState(orgId);
    requireDocumentTypeEnabled(capabilityState, body.document_type);
    const template = await createDocumentTemplate(orgId, body, ctx);
    reply.code(201);
    return { ok: true, template };
  });

  // Vision template generation: uploaded example documents → a drafted
  // DocModel template, refined afterwards with the docs agent in the studio.
  app.post("/organizations/:orgId/templates/from-examples", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, {
      orgId,
      csrf: true,
      permission: "manage_company_settings",
      capability: DOCUMENT_CAPABILITIES.studio
    });
    await requireDocumentCapabilityEnabled(orgId, DOCUMENT_CAPABILITIES.ingestion);
    await requireDocumentCapabilityEnabled(orgId, DOCUMENT_CAPABILITIES.agent);
    const body = templateFromExamplesSchema.parse(request.body ?? {});
    const result = await generateTemplateFromExamples(orgId, body as never, ctx);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/organizations/:orgId/templates/:templateId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    await ensureDefaultDocumentAssets(orgId);
    const template = await readDocumentTemplate(orgId, getParam(request.params, "templateId"));
    const current = Number(template.current_version || 0);
    const version = current ? await readDocumentTemplateVersion(orgId, cleanText(template.id), current) : null;
    return { ok: true, template: { ...template, definition: version ? asObject(version).definition : null } };
  });

  app.patch("/organizations/:orgId/templates/:templateId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.studio });
    const body = patchTemplateSchema.parse(request.body ?? {});
    const template = await patchDocumentTemplate(orgId, getParam(request.params, "templateId"), body, ctx);
    return { ok: true, template };
  });

  app.delete("/organizations/:orgId/templates/:templateId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.studio });
    const template = await archiveDocumentTemplate(orgId, getParam(request.params, "templateId"), ctx);
    return { ok: true, template };
  });

  app.get("/organizations/:orgId/templates/:templateId/versions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const versions = await listDocumentTemplateVersions(orgId, getParam(request.params, "templateId"));
    return { ok: true, versions, count: versions.length };
  });

  app.get("/organizations/:orgId/templates/:templateId/versions/:version", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const version = await readDocumentTemplateVersion(orgId, getParam(request.params, "templateId"), Number(getParam(request.params, "version")) || undefined);
    if (!version) throw badRequest("document_template_version_not_found", "That template version was not found.");
    return { ok: true, version };
  });

  app.post("/organizations/:orgId/templates/:templateId/publish", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.studio });
    const body = publishTemplateSchema.parse(request.body ?? {});
    const capabilityState = await documentCapabilityState(orgId);
    const currentTemplate = await readDocumentTemplate(orgId, getParam(request.params, "templateId"));
    requireDocumentTypeEnabled(capabilityState, currentTemplate.document_type);
    const template = await publishDocumentTemplate(orgId, getParam(request.params, "templateId"), body, ctx);
    reply.code(201);
    return { ok: true, template };
  });

  // -------------------------------------------------------------------------
  // Themes (same family as templates)
  // -------------------------------------------------------------------------

  app.get("/organizations/:orgId/themes", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    await ensureDefaultDocumentAssets(orgId);
    const query = asObject(request.query);
    const themes = await themesWithCurrentDefinitions(orgId, await listDocumentThemes(orgId, { status: cleanText(query.status) || undefined }));
    return { ok: true, themes, count: themes.length };
  });

  app.post("/organizations/:orgId/themes", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.themeAuthoring });
    const body = createThemeSchema.parse(request.body ?? {});
    const definition = body.use_company_defaults === false
      ? asObject(body.definition)
      : await themeDefinitionWithOrganizationDefaults(orgId, asObject(body.definition), ctx.branchId);
    const theme = await createDocumentTheme(orgId, { ...body, definition }, ctx);
    reply.code(201);
    return { ok: true, theme };
  });

  app.get("/organizations/:orgId/themes/:themeId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    await ensureDefaultDocumentAssets(orgId);
    const theme = await readDocumentTheme(orgId, getParam(request.params, "themeId"));
    const current = Number(theme.current_version || 0);
    const version = current ? await readDocumentThemeVersion(orgId, cleanText(theme.id), current) : null;
    return { ok: true, theme: { ...theme, definition: version ? asObject(version).definition : null } };
  });

  app.patch("/organizations/:orgId/themes/:themeId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.themeAuthoring });
    const body = patchThemeSchema.parse(request.body ?? {});
    const theme = await patchDocumentTheme(orgId, getParam(request.params, "themeId"), body, ctx);
    return { ok: true, theme };
  });

  app.delete("/organizations/:orgId/themes/:themeId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.themeAuthoring });
    const theme = await archiveDocumentTheme(orgId, getParam(request.params, "themeId"), ctx);
    return { ok: true, theme };
  });

  app.get("/organizations/:orgId/themes/:themeId/versions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const versions = await listDocumentThemeVersions(orgId, getParam(request.params, "themeId"));
    return { ok: true, versions, count: versions.length };
  });

  app.get("/organizations/:orgId/themes/:themeId/versions/:version", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const version = await readDocumentThemeVersion(orgId, getParam(request.params, "themeId"), Number(getParam(request.params, "version")) || undefined);
    if (!version) throw badRequest("document_theme_version_not_found", "That theme version was not found.");
    return { ok: true, version };
  });

  app.post("/organizations/:orgId/themes/:themeId/publish", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.themeAuthoring });
    const body = publishThemeSchema.parse(request.body ?? {});
    const theme = await publishDocumentTheme(orgId, getParam(request.params, "themeId"), body, ctx);
    reply.code(201);
    return { ok: true, theme };
  });

  // -------------------------------------------------------------------------
  // Workflows (versioned intake definitions — same asset family as templates)
  // -------------------------------------------------------------------------

  app.get("/organizations/:orgId/workflows", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    await ensureDefaultDocumentAssets(orgId);
    const query = asObject(request.query);
    const workflows = await listDocumentWorkflows(orgId, { status: cleanText(query.status) || undefined });
    return { ok: true, workflows, count: workflows.length };
  });

  app.post("/organizations/:orgId/workflows", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.workflowAuthoring });
    const body = createWorkflowSchema.parse(request.body ?? {});
    const workflow = await createDocumentWorkflow(orgId, body, ctx);
    reply.code(201);
    return { ok: true, workflow };
  });

  app.get("/organizations/:orgId/workflows/:workflowId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    await ensureDefaultDocumentAssets(orgId);
    const workflow = await readDocumentWorkflow(orgId, getParam(request.params, "workflowId"));
    const current = Number(workflow.current_version || 0);
    const version = current ? await readDocumentWorkflowVersion(orgId, cleanText(workflow.id), current) : null;
    return { ok: true, workflow: { ...workflow, definition: version ? asObject(version).definition : null } };
  });

  app.patch("/organizations/:orgId/workflows/:workflowId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.workflowAuthoring });
    const body = patchWorkflowSchema.parse(request.body ?? {});
    const workflow = await patchDocumentWorkflow(orgId, getParam(request.params, "workflowId"), body, ctx);
    return { ok: true, workflow };
  });

  app.delete("/organizations/:orgId/workflows/:workflowId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.workflowAuthoring });
    const workflow = await archiveDocumentWorkflow(orgId, getParam(request.params, "workflowId"), ctx);
    return { ok: true, workflow };
  });

  app.get("/organizations/:orgId/workflows/:workflowId/versions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const versions = await listDocumentWorkflowVersions(orgId, getParam(request.params, "workflowId"));
    return { ok: true, versions, count: versions.length };
  });

  app.get("/organizations/:orgId/workflows/:workflowId/versions/:version", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const version = await readDocumentWorkflowVersion(orgId, getParam(request.params, "workflowId"), Number(getParam(request.params, "version")) || undefined);
    if (!version) throw badRequest("document_workflow_version_not_found", "That workflow version was not found.");
    return { ok: true, version };
  });

  app.post("/organizations/:orgId/workflows/:workflowId/publish", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.workflowAuthoring });
    const body = publishWorkflowSchema.parse(request.body ?? {});
    const workflow = await publishDocumentWorkflow(orgId, getParam(request.params, "workflowId"), body, ctx);
    reply.code(201);
    return { ok: true, workflow };
  });

  // -------------------------------------------------------------------------
  // Folders (Doc Studio marketing/custom tabs) + folder items
  // -------------------------------------------------------------------------

  app.get("/organizations/:orgId/folders", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    await ensureDefaultDocumentFolders(orgId);
    const query = asObject(request.query);
    const folders = await listDocumentFolders(orgId, { status: cleanText(query.status) || undefined });
    return { ok: true, folders, count: folders.length };
  });

  // Custom-folder creation is the only surface behind the feature flag —
  // rename/delete/items stay open so flipping it off never strands data.
  app.post("/organizations/:orgId/folders", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, {
      orgId,
      csrf: true,
      permission: "manage_company_settings",
      capability: "documents.custom_folders"
    });
    const body = createFolderSchema.parse(request.body ?? {});
    const folder = await createDocumentFolder(orgId, body, ctx);
    reply.code(201);
    return { ok: true, folder };
  });

  app.patch("/organizations/:orgId/folders/:folderId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.customFolders });
    const body = patchFolderSchema.parse(request.body ?? {});
    const folder = await patchDocumentFolder(orgId, getParam(request.params, "folderId"), body, ctx);
    return { ok: true, folder };
  });

  app.delete("/organizations/:orgId/folders/:folderId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.customFolders });
    const folder = await archiveDocumentFolder(orgId, getParam(request.params, "folderId"), ctx);
    return { ok: true, folder };
  });

  app.get("/organizations/:orgId/folders/:folderId/items", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const items = await listDocumentFolderItems(orgId, getParam(request.params, "folderId"), {
      status: cleanText(asObject(request.query).status) || undefined
    });
    return { ok: true, items, count: items.length };
  });

  app.post("/organizations/:orgId/folders/:folderId/items", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.studio });
    await requireFolderAuthoringCapability(orgId, getParam(request.params, "folderId"));
    const body = createFolderItemSchema.parse(request.body ?? {});
    const item = await createDocumentFolderItem(orgId, getParam(request.params, "folderId"), body, ctx);
    reply.code(201);
    return { ok: true, item };
  });

  app.get("/organizations/:orgId/folders/:folderId/items/:itemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const item = await readDocumentFolderItem(orgId, getParam(request.params, "itemId"));
    return { ok: true, item };
  });

  app.get("/organizations/:orgId/folders/:folderId/items/:itemId/versions", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const versions = await listDocumentFolderItemVersions(orgId, getParam(request.params, "itemId"));
    return { ok: true, versions, count: versions.length };
  });

  app.patch("/organizations/:orgId/folders/:folderId/items/:itemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.studio });
    await requireFolderAuthoringCapability(orgId, getParam(request.params, "folderId"));
    const body = patchFolderItemSchema.parse(request.body ?? {});
    const item = await patchDocumentFolderItem(orgId, getParam(request.params, "itemId"), body, ctx);
    return { ok: true, item };
  });

  app.delete("/organizations/:orgId/folders/:folderId/items/:itemId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.studio });
    await requireFolderAuthoringCapability(orgId, getParam(request.params, "folderId"));
    const item = await archiveDocumentFolderItem(orgId, getParam(request.params, "itemId"), ctx);
    return { ok: true, item };
  });

  app.get("/organizations/:orgId/folders/:folderId/items/:itemId/pdf", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const rendered = await generateFolderItemPdf(orgId, getParam(request.params, "itemId"));
    return sendPdf(reply, { contentType: "application/pdf", fileName: rendered.fileName, bytes: rendered.bytes });
  });

  // -------------------------------------------------------------------------
  // Catalog (editor palette data)
  // -------------------------------------------------------------------------

  app.get("/organizations/:orgId/catalog", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const capabilityState = await documentCapabilityState(orgId);
    await ensureDefaultDocumentAssets(orgId);
    const themes = await themesWithCurrentDefinitions(orgId, await listDocumentThemes(orgId));
    const workflows = await listDocumentWorkflows(orgId);
    const resolverMeta = new Map(listDocumentWidgetResolvers().map((entry) => [cleanText(entry.id), entry]));
    return {
      ok: true,
      capabilities: capabilityState.effectiveByKey,
      widgets: DOCUMENT_WIDGET_CATALOG
        .map((descriptor) => {
          const capability = widgetCapability(descriptor.id);
          return capability && !documentCapabilityEnabled(capabilityState, capability)
            ? { ...descriptor, ...capabilityDisabledPatch(capability) }
            : descriptor;
        })
        .map((descriptor) => ({
          ...descriptor,
          ...asObject(resolverMeta.get(cleanText(descriptor.id))),
          has_server_resolver: resolverMeta.has(cleanText(descriptor.id))
        })),
      types: listDocumentTypes().filter((type) => documentTypeEnabled(capabilityState, type.id)).map((type) => ({
        id: type.id,
        label: type.label,
        icon: type.icon,
        param_schema: type.param_schema,
        output_schema: type.output_schema,
        default_theme_id: type.default_theme_id || null,
        default_workflow_id: type.default_workflow_id || null
      })),
      themes,
      workflows,
      item_kinds: listWorkflowItemKinds().map((item) => {
        const capability = workflowItemCapability(item);
        return capability && !documentCapabilityEnabled(capabilityState, capability)
          ? { ...item, ...capabilityDisabledPatch(capability) }
          : item;
      }),
      sources: listDocumentSources().map((source) => cleanText(source.id).startsWith("payments.") && !documentCapabilityEnabled(capabilityState, DOCUMENT_CAPABILITIES.payments)
        ? { ...source, ...capabilityDisabledPatch(DOCUMENT_CAPABILITIES.payments) }
        : source),
      fonts: DOCUMENT_FONTS
    };
  });

  // -------------------------------------------------------------------------
  // Document instances
  // -------------------------------------------------------------------------

  app.get("/organizations/:orgId/projects/:projectId/documents", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const documents = await listProjectDocuments(orgId, getParam(request.params, "projectId"));
    return { ok: true, documents, count: documents.length };
  });

  app.post("/organizations/:orgId/projects/:projectId/documents", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const body = createDocumentInstanceSchema.parse(request.body ?? {});
    const result = await createDocumentInstance(orgId, getParam(request.params, "projectId"), body, ctx);
    reply.code(201);
    return { ok: true, document: result.document, missing_params: result.missing_params };
  });

  /** Standalone documents (doc-first flows): drafts with no project yet.
   *  Powers the My Projects "Drafts" view. */
  app.get("/organizations/:orgId/documents", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const documents = await listProjectDocuments(orgId, "");
    return { ok: true, documents, count: documents.length };
  });

  /** Standalone create (doc-first flows): no project yet. Attach one later via
   *  PATCH /documents/:id { project_id } while the document is unattached. */
  app.post("/organizations/:orgId/documents", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const body = createDocumentInstanceSchema.parse(request.body ?? {});
    const result = await createDocumentInstance(orgId, "", body, ctx);
    reply.code(201);
    return { ok: true, document: result.document, missing_params: result.missing_params };
  });

  app.get("/organizations/:orgId/documents/:documentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const document = await readDocumentInstance(orgId, getParam(request.params, "documentId"));
    return { ok: true, document };
  });

  app.patch("/organizations/:orgId/documents/:documentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const body = patchDocumentInstanceSchema.parse(request.body ?? {});
    const document = await patchDocumentInstance(orgId, getParam(request.params, "documentId"), body, ctx);
    return { ok: true, document };
  });

  app.delete("/organizations/:orgId/documents/:documentId", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const document = await voidDocumentInstance(orgId, getParam(request.params, "documentId"), ctx);
    return { ok: true, document };
  });

  /** Cancel/revoke a sent document or workflow: revokes every public token,
   *  records the cancellation (reason + customer visibility), emits
   *  document.voided. The item remains visible as canceled in timelines. */
  app.post("/organizations/:orgId/documents/:documentId/void", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const body = voidDocumentInstanceSchema.parse(request.body ?? {});
    const document = await voidDocumentInstance(orgId, getParam(request.params, "documentId"), ctx, body);
    return { ok: true, document };
  });

  /** Live resolution for the editor/preview: overrides+bindings+widgets+theme. */
  app.post("/organizations/:orgId/documents/:documentId/resolve", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const body = resolveDocumentSchema.parse(request.body ?? {});
    const document = await readDocumentInstance(orgId, getParam(request.params, "documentId"));
    const resolved = await resolveDocumentInstance(orgId, document, {
      params: asObject(body.params),
      overrides: Object.prototype.hasOwnProperty.call(body, "overrides") ? (body.overrides as unknown[]) : undefined,
      themeRef: Object.prototype.hasOwnProperty.call(body, "theme_ref") ? asObject(body.theme_ref) : undefined,
      themeOverrides: asObject(body.theme_overrides),
      checkout: Object.prototype.hasOwnProperty.call(body, "checkout") ? asObject(body.checkout) : undefined
    });
    return {
      ok: true,
      resolved_definition: resolved.resolved_definition,
      widget_data: resolved.widget_data,
      sources: resolved.sources,
      theme: resolved.theme,
      theme_vars: resolved.theme_vars,
      // Enriched binding scope (params carry scope_rows etc.) — the editor's
      // client-side live preview resolves the WORKING doc against this, so it
      // must match what the server resolved with.
      scope: resolved.scope
    };
  });

  /** Workflow definition + navigation state for the internal fill stepper. */
  app.get("/organizations/:orgId/documents/:documentId/workflow", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const detail = await documentWorkflowDetail(orgId, getParam(request.params, "documentId"));
    return {
      ok: true,
      workflow_ref: detail.workflow_ref,
      workflow: detail.definition,
      state: detail.state,
      contract: detail.contract,
      sources: detail.sources
    };
  });

  /**
   * Navigation-state updates only. Workflow item WRITES go through the
   * existing PATCH params / outputs routes — there is no second write path.
   */
  app.post("/organizations/:orgId/documents/:documentId/workflow/state", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const body = workflowStateUpdateSchema.parse(request.body ?? {});
    const result = await updateDocumentWorkflowState(orgId, getParam(request.params, "documentId"), body, ctx);
    return { ok: true, state: result.state, document: result.document };
  });

  app.post("/organizations/:orgId/documents/:documentId/issue", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const body = issueDocumentSchema.parse(request.body ?? {});
    const result = await issueDocument(orgId, getParam(request.params, "documentId"), body, ctx);
    return { ok: true, document: result.document, missing_params: result.missing_params };
  });

  app.post("/organizations/:orgId/documents/:documentId/send", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const body = sendDocumentSchema.parse(request.body ?? {});
    const result = await sendDocument(orgId, getParam(request.params, "documentId"), body, ctx);
    return { ok: true, document: result.document, snapshot: result.snapshot, portal_url: result.portal_url, emailed: result.emailed, texted: result.texted };
  });

  app.get("/organizations/:orgId/documents/:documentId/snapshots", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const snapshots = await listDocumentSnapshots(orgId, getParam(request.params, "documentId"));
    return { ok: true, snapshots, count: snapshots.length };
  });

  app.post("/organizations/:orgId/documents/:documentId/snapshots", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const body = createDocumentSnapshotSchema.parse(request.body ?? {});
    const snapshot = await createSnapshot(orgId, getParam(request.params, "documentId"), body, ctx);
    reply.code(201);
    return { ok: true, snapshot };
  });

  app.get("/organizations/:orgId/documents/:documentId/events", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const events = await listDocumentEvents(orgId, getParam(request.params, "documentId"));
    return { ok: true, events, count: events.length };
  });

  app.post("/organizations/:orgId/documents/:documentId/pdf", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const body = generateDocumentPdfSchema.parse(request.body ?? {});
    const result = await generateDocumentPdf(orgId, getParam(request.params, "documentId"), body, ctx);
    return {
      ok: true,
      file_name: result.fileName,
      page_count: result.pageCount,
      media: result.media ?? null,
      media_ref: result.media_ref ?? null,
      snapshot: result.snapshot ?? null
    };
  });

  app.get("/organizations/:orgId/documents/:documentId/pdf", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, permission: "view_projects" });
    const query = asObject(request.query);
    const file = await readDocumentPdfFile(orgId, getParam(request.params, "documentId"), cleanText(query.media_id), cleanText(query.snapshot_id));
    return sendPdf(reply, file);
  });

  /** Internal fill — record an output value on behalf of the org user. */
  app.post("/organizations/:orgId/documents/:documentId/outputs/:key", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects" });
    const body = recordOutputSchema.parse(request.body ?? {});
    const result = await recordDocumentOutput(
      orgId,
      getParam(request.params, "documentId"),
      getParam(request.params, "key"),
      body,
      publicRequestAudit(request),
      ctx,
      { surface: "internal" }
    );
    return { ok: true, document: result.document, snapshot: result.snapshot, status: result.status };
  });

  // -------------------------------------------------------------------------
  // Ingestion (v1: upload → media store → needs_review instance)
  // -------------------------------------------------------------------------

  app.post("/organizations/:orgId/documents/ingest", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects", capability: DOCUMENT_CAPABILITIES.ingestion });
    const body = ingestDocumentSchema.parse(request.body ?? {});
    let bytes: Buffer;
    try {
      bytes = Buffer.from(cleanText(body.data_base64), "base64");
    } catch {
      throw badRequest("invalid_document_upload", "data_base64 must be a base64-encoded file.");
    }
    const result = await ingestDocumentUpload(orgId, {
      bytes,
      fileName: cleanText(body.file_name),
      contentType: cleanText(body.content_type),
      projectId: cleanText(body.project_id),
      documentType: cleanText(body.document_type),
      templateId: cleanText(body.template_id),
      title: cleanText(body.title),
      metadata: asObject(body.metadata)
    }, ctx);
    reply.code(201);
    return { ok: true, document: result.document, extraction: result.extraction, media_id: cleanText(asObject(result.media).id) };
  });

  /** Field-definition + value edits for uploaded (paper) documents. */
  app.post("/organizations/:orgId/documents/:documentId/upload-fields", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects", capability: DOCUMENT_CAPABILITIES.ingestion });
    const body = uploadFieldsSchema.parse(request.body ?? {});
    const document = await updateUploadedDocumentFields(orgId, getParam(request.params, "documentId"), body, ctx);
    return { ok: true, document };
  });

  /**
   * Reviewer sign-off for a paper upload: applies final edits, re-records the
   * confirmed outputs through the standard machinery (document.signed fires,
   * receivables mint), and moves the document out of needs_review.
   */
  app.post("/organizations/:orgId/documents/:documentId/confirm-upload", async (request) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "view_projects", capability: DOCUMENT_CAPABILITIES.ingestion });
    const body = confirmUploadSchema.parse(request.body ?? {});
    const document = await confirmUploadedDocument(orgId, getParam(request.params, "documentId"), body, ctx);
    return { ok: true, document };
  });

  /** Agent-drafted field schema for a paper-upload template from an example contract. */
  app.post("/organizations/:orgId/templates/upload-intake/draft", async (request) => {
    const orgId = getParam(request.params, "orgId");
    await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.ingestion });
    await requireDocumentCapabilityEnabled(orgId, DOCUMENT_CAPABILITIES.studio);
    await requireDocumentCapabilityEnabled(orgId, DOCUMENT_CAPABILITIES.agent);
    const body = draftUploadTemplateRequestSchema.parse(request.body ?? {});
    let bytes: Buffer;
    try {
      bytes = Buffer.from(cleanText(body.data_base64), "base64");
    } catch {
      throw badRequest("invalid_document_upload", "data_base64 must be a base64-encoded file.");
    }
    const draft = await draftUploadTemplateSchema({
      bytes,
      fileName: cleanText(body.file_name),
      contentType: cleanText(body.content_type),
      name: cleanText(body.name),
      documentTypeHint: cleanText(body.document_type)
    });
    return { ok: true, draft };
  });

  /** Save an uploaded document's field contract as a reusable paper-upload template. */
  app.post("/organizations/:orgId/templates/upload-intake/from-document/:documentId", async (request, reply) => {
    const orgId = getParam(request.params, "orgId");
    const ctx = await requirePlatformAuth(request, { orgId, csrf: true, permission: "manage_company_settings", capability: DOCUMENT_CAPABILITIES.ingestion });
    await requireDocumentCapabilityEnabled(orgId, DOCUMENT_CAPABILITIES.studio);
    const body = asObject(request.body);
    const document = await readDocumentInstance(orgId, getParam(request.params, "documentId"));
    if (cleanText(document.source) !== "uploaded") {
      throw badRequest("document_not_uploaded", "Only uploaded documents can seed an upload template.");
    }
    const name = cleanText(body.name) || `${cleanText(document.title) || "Contract"} — Paper Upload`;
    const definition = uploadTemplateDefinition(name, asObject(document.param_defs), asObject(document.output_defs));
    const template = await createDocumentTemplate(orgId, {
      name,
      document_type: cleanText(document.document_type) || "generic",
      description: cleanText(body.description) || "Paper contract upload with agent-assisted field extraction.",
      definition,
      metadata: { intake: "upload", created_from_document_id: cleanText(document.id) }
    }, ctx);
    reply.code(201);
    return { ok: true, template };
  });

  // -------------------------------------------------------------------------
  // Public (token-only) routes
  // -------------------------------------------------------------------------

  app.get("/public/:token", async (request) => {
    const token = getParam(request.params, "token");
    const found = await publicDocumentWorkflow(token);
    return {
      ok: true,
      snapshot: publicSnapshotView(found.snapshot, token),
      document: {
        id: cleanText(found.document.id),
        status: cleanText(found.document.status),
        document_type: cleanText(found.document.document_type)
      },
      capabilities: found.capabilities,
      workflow: found.workflow
    };
  });

  app.post("/public/:token/view", async (request) => {
    const token = getParam(request.params, "token");
    const body = publicViewEventSchema.parse(request.body ?? {});
    const result = await recordPublicDocumentView(token, body, publicRequestAudit(request));
    return {
      ok: true,
      snapshot: publicSnapshotView(result.snapshot, token),
      document: {
        id: cleanText(result.document.id),
        status: cleanText(result.document.status),
        document_type: cleanText(result.document.document_type)
      }
    };
  });

  app.post("/public/:token/outputs/:key", async (request) => {
    const token = getParam(request.params, "token");
    const body = recordOutputSchema.parse(request.body ?? {});
    const found = await publicDocumentWorkflow(token);
    await requireDocumentCapabilityEnabled(found.orgId, DOCUMENT_CAPABILITIES.app);
    const result = await recordDocumentOutput(
      found.orgId,
      cleanText(found.document.id),
      getParam(request.params, "key"),
      body,
      publicRequestAudit(request),
      null,
      { snapshotId: cleanText(found.snapshot.id), surface: "public" }
    );
    const refreshed = await publicDocumentWorkflow(token);
    return {
      ok: true,
      snapshot: publicSnapshotView(refreshed.snapshot, token),
      document: {
        id: cleanText(result.document.id),
        status: cleanText(result.document.status),
        document_type: cleanText(result.document.document_type)
      },
      workflow: refreshed.workflow
    };
  });

  /**
   * Customer-audience workflow for the portal wizard. Internal-only steps and
   * audiences.customer.hide_steps are filtered out; documents without a
   * workflow return a 404-style ok:false so the portal falls back to the
   * plain snapshot experience.
   */
  app.get("/public/:token/workflow", async (request) => {
    const token = getParam(request.params, "token");
    const found = await publicDocumentWorkflowDefinition(token);
    return {
      ok: true,
      workflow_ref: found.workflow_ref,
      workflow: found.definition,
      state: found.state,
      contract: found.contract,
      params: found.params,
      outputs: found.outputs,
      sources: found.sources,
      capabilities: found.capabilities,
      document: {
        id: cleanText(found.document.id),
        status: cleanText(found.document.status),
        document_type: cleanText(found.document.document_type)
      }
    };
  });

  /**
   * Authoritative pricing preview for the portal pay flow (spec 10.4):
   * re-evaluates the snapshot's conditional rows + totals server-side under
   * the supplied checkout state ({ checkout: { payment_method } }). The mock
   * deposit/payment path recomputes its amount through the same evaluation —
   * client totals are never trusted.
   */
  app.post("/public/:token/pricing", async (request) => {
    const token = getParam(request.params, "token");
    const found = await publicDocumentWorkflow(token);
    await requireDocumentCapabilityEnabled(found.orgId, DOCUMENT_CAPABILITIES.payments);
    await requireDocumentCapabilityEnabled(found.orgId, DOCUMENT_CAPABILITIES.portalPayments);
    const body = publicPricingPreviewSchema.parse(request.body ?? {});
    const result = await publicDocumentPricingPreview(token, body);
    return {
      ok: true,
      document_id: result.document_id,
      snapshot_id: result.snapshot_id,
      checkout: result.checkout,
      rows: result.rows,
      conditional_rows: result.conditional_rows,
      totals: result.totals
    };
  });

  // --- Public payment intake (provider tokenization over the document token).
  // The portal's doc-widget checkout only ever talks to the documents public
  // API, so these thin shims resolve the org from the token (same pattern as
  // proposals/api.ts) and delegate to the payments intake module. When no
  // provider is configured they answer provider:null and the portal keeps its
  // legacy flow byte-identical.

  app.get("/public/:token/payments/intake-config", async (request) => {
    const config = await publicDocumentPaymentIntakeConfig(getParam(request.params, "token"));
    return { ok: true, ...config };
  });

  app.post("/public/:token/payments/payment-method-intent", async (request, reply) => {
    const body = asObject(request.body);
    const result = await publicDocumentPaymentMethodIntent(getParam(request.params, "token"), body);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/public/:token/pdf", async (request, reply) => {
    const file = await readPublicDocumentPdfFile(getParam(request.params, "token"));
    return sendPdf(reply, file);
  });
};

// ---------------------------------------------------------------------------
// Helpers (same conventions as proposals/api.ts)
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};
}

function cleanText(value: unknown) {
  return String(value ?? "").trim();
}

function getParam(params: unknown, key: string) {
  return cleanText(asObject(params)[key]);
}

async function requireFolderAuthoringCapability(orgId: string, folderId: string) {
  const folder = await readDocumentFolder(orgId, folderId);
  if (asObject(folder).system === true) return;
  const state = await documentCapabilityState(orgId);
  if (documentCapabilityEnabled(state, DOCUMENT_CAPABILITIES.customFolders)) return;
  throw forbidden("capability_disabled", "Custom Studio folders are disabled for this organization.", { capability: DOCUMENT_CAPABILITIES.customFolders });
}

async function requireDocumentCapabilityEnabled(orgId: string, capability: string) {
  const state = await documentCapabilityState(orgId);
  if (documentCapabilityEnabled(state, capability)) return state;
  throw forbidden("capability_disabled", `The '${capability}' capability is disabled for this organization.`, { capability });
}

function sendPdf(reply: FastifyReply, file: { contentType: string; fileName: string; bytes: Buffer }) {
  reply.header("Content-Type", file.contentType || "application/pdf");
  reply.header("Content-Disposition", `inline; filename="${String(file.fileName || "document.pdf").replace(/"/g, "")}"`);
  return reply.send(file.bytes);
}

/** Browser evidence capture, copied from proposals' publicRequestAudit. */
function publicRequestAudit(request: { ip?: string; headers?: Record<string, unknown> }): JsonObject {
  const headers = request.headers || {};
  const header = (name: string) => cleanText(headers[name] || headers[name.toLowerCase()]);
  const forwarded = header("x-forwarded-for").split(",")[0]?.trim();
  return {
    ip_address: forwarded || header("cf-connecting-ip") || cleanText(request.ip),
    user_agent: header("user-agent"),
    accept_language: header("accept-language"),
    referrer: header("referer") || header("referrer"),
    forwarded_for: header("x-forwarded-for"),
    request_id: header("x-request-id") || header("cf-ray") || header("x-vercel-id"),
    geo: {
      country: header("cf-ipcountry") || header("x-vercel-ip-country") || header("x-appengine-country"),
      region: header("x-vercel-ip-country-region") || header("x-appengine-region"),
      city: header("x-vercel-ip-city") || header("x-appengine-city"),
      latitude: header("x-vercel-ip-latitude") || header("x-appengine-citylatlong").split(",")[0],
      longitude: header("x-vercel-ip-longitude") || header("x-appengine-citylatlong").split(",")[1],
      source: header("cf-ipcountry") ? "cloudflare_headers" : header("x-vercel-ip-country") ? "vercel_headers" : header("x-appengine-country") ? "appengine_headers" : ""
    }
  };
}
