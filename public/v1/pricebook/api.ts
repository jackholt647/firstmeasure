import path from "node:path";

import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";

import { PricebookError } from "./errors.js";
import {
  assetUploadJsonSchema,
  clonePricebookSchema,
  createItemSchema,
  createPricebookSchema,
  deleteByRevisionSchema,
  patchPricebookItemSchema,
  patchPricebookSchema,
  pricebookQuerySchema,
  saveCatalogSchema
} from "./schemas.js";
import {
  clonePricebook,
  createItem,
  createPricebook,
  deleteAsset,
  deleteItem,
  getPricebookDetail,
  listAssetEntries,
  listPricebookManifests,
  listTemplates,
  patchItem,
  patchManifest,
  readAsset,
  readCatalog,
  readTemplateCatalog,
  saveAsset,
  saveCatalog,
  sanitizePricebookId
} from "./storage.js";

export const registerPricebookApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }

    if (error instanceof PricebookError) {
      reply.code(error.statusCode);
      return reply.send({
        ok: false,
        error: error.code,
        message: error.message,
        details: error.details ?? null
      });
    }

    if (typeof (error as { statusCode?: unknown }).statusCode === "number") {
      const statusCode = Number((error as { statusCode: number }).statusCode);
      reply.code(statusCode);
      return reply.send({
        ok: false,
        error: String((error as { code?: unknown }).code ?? "request_error"),
        message: String((error as { message?: unknown }).message ?? "The request could not be processed.")
      });
    }

    app.log.error(error);
    reply.code(500);
    return reply.send({
      ok: false,
      error: "internal_error",
      message: "An unexpected error occurred."
    });
  });

  app.get("/", async () => ({
    ok: true,
    api: "pricebook",
    message: "pricebook API is mounted",
    endpoints: {
      pricebooks: "/pricebooks",
      templates: "/templates",
      catalog: "/pricebooks/:id/catalog",
      items: "/pricebooks/:id/items",
      assets: "/pricebooks/:id/assets"
    }
  }));

  app.get("/ping", async (request) => ({
    ok: true,
    api: "pricebook",
    route: "/ping",
    method: request.method,
    query: request.query,
    receivedAt: new Date().toISOString()
  }));

  app.post("/echo", async (request) => ({
    ok: true,
    api: "pricebook",
    route: "/echo",
    method: request.method,
    url: request.url,
    query: request.query,
    body: request.body ?? null,
    receivedAt: new Date().toISOString()
  }));

  app.get("/templates", async () => ({ ok: true, templates: listTemplates() }));

  app.get("/templates/:key", async (request) => {
    const key = String(asRecord(request.params).key ?? "");
    return { ok: true, template: { key, catalog: readTemplateCatalog(key) } };
  });

  app.get("/pricebooks", async () => {
    const pricebooks = await listPricebookManifests();
    return { ok: true, count: pricebooks.length, pricebooks };
  });

  app.post("/pricebooks", async (request, reply) => {
    const body = createPricebookSchema.parse(request.body ?? {});
    const created = await createPricebook(body);
    reply.code(201);
    return { ok: true, pricebook: created };
  });

  app.post("/pricebooks/query", async (request) => {
    const query = pricebookQuerySchema.parse(request.body ?? {});
    const pricebooks = await listPricebookManifests();
    const filtered = pricebooks.filter((manifest) => matchesQuery(manifest, query)).slice(0, query.limit ?? 100);
    return { ok: true, count: filtered.length, pricebooks: filtered };
  });

  app.get("/pricebooks/:id", async (request) => ({
    ok: true,
    pricebook: await getPricebookDetail(getPricebookId(request.params))
  }));

  app.patch("/pricebooks/:id", async (request) => {
    const pricebookId = getPricebookId(request.params);
    const body = patchPricebookSchema.parse(request.body ?? {});
    const manifest = await patchManifest(pricebookId, stripExpectedRevision(body), body.expected_revision);
    return { ok: true, pricebook: { manifest, catalog: await readCatalog(pricebookId) } };
  });

  app.post("/pricebooks/:id/clone", async (request, reply) => {
    const body = clonePricebookSchema.parse(request.body ?? {});
    const created = await clonePricebook(getPricebookId(request.params), body);
    reply.code(201);
    return { ok: true, pricebook: created };
  });

  app.get("/pricebooks/:id/catalog", async (request) => ({
    ok: true,
    catalog: await readCatalog(getPricebookId(request.params))
  }));

  app.put("/pricebooks/:id/catalog", async (request) => {
    const body = saveCatalogSchema.parse(request.body ?? {});
    const updated = await saveCatalog(getPricebookId(request.params), body.catalog, body.expected_revision);
    return { ok: true, manifest: updated.manifest, catalog: updated.catalog };
  });

  app.post("/pricebooks/:id/items", async (request, reply) => {
    const body = createItemSchema.parse(request.body ?? {});
    const updated = await createItem(getPricebookId(request.params), stripExpectedRevision(body), body.expected_revision);
    reply.code(201);
    return { ok: true, manifest: updated.manifest, catalog: updated.catalog };
  });

  app.patch("/pricebooks/:id/items/:itemId", async (request) => {
    const body = patchPricebookItemSchema.parse(request.body ?? {});
    const itemId = String(asRecord(request.params).itemId ?? "");
    const updated = await patchItem(getPricebookId(request.params), itemId, stripExpectedRevision(body), body.expected_revision);
    return { ok: true, manifest: updated.manifest, catalog: updated.catalog };
  });

  app.delete("/pricebooks/:id/items/:itemId", async (request) => {
    const body = deleteByRevisionSchema.parse(request.body ?? {});
    const itemId = String(asRecord(request.params).itemId ?? "");
    const updated = await deleteItem(getPricebookId(request.params), itemId, body.expected_revision);
    return { ok: true, manifest: updated.manifest, catalog: updated.catalog, deleted_item_id: itemId };
  });

  app.get("/pricebooks/:id/assets", async (request) => ({
    ok: true,
    assets: await listAssetEntries(getPricebookId(request.params))
  }));

  app.post("/pricebooks/:id/assets", async (request, reply) => {
    const pricebookId = getPricebookId(request.params);
    const contentType = String(request.headers["content-type"] ?? "");

    if (contentType.includes("multipart/form-data")) {
      const file = await (request as {
        file: () => Promise<{
          filename: string;
          mimetype: string;
          fields?: Record<string, { value: unknown }>;
          toBuffer: () => Promise<Buffer>;
        } | undefined>;
      }).file();
      if (!file) {
        reply.code(400);
        return { ok: false, error: "missing_file" };
      }
      const fields = file.fields ?? {};
      const saved = await saveAsset(pricebookId, {
        fileName: file.filename,
        content: await file.toBuffer(),
        contentType: file.mimetype,
        label: toOptionalString(fields.label?.value) ?? null,
        altText: toOptionalString(fields.alt_text?.value) ?? null,
        kind: toOptionalString(fields.kind?.value) ?? null,
        metadata: tryParseJsonString(fields.metadata?.value, {}) as Record<string, unknown>,
        expectedRevision: toOptionalNumber(fields.expected_revision?.value)
      });
      reply.code(201);
      return { ok: true, manifest: saved.manifest, asset: saved.asset };
    }

    const body = assetUploadJsonSchema.parse(request.body ?? {});
    const saved = await saveAsset(pricebookId, {
      fileName: body.file_name,
      content: body.content_base64 ? Buffer.from(body.content_base64, "base64") : body.content_text ?? "",
      contentType: body.content_type,
      label: body.label ?? null,
      altText: body.alt_text ?? null,
      kind: body.kind ?? null,
      metadata: body.metadata ?? {},
      expectedRevision: body.expected_revision
    });
    reply.code(201);
    return { ok: true, manifest: saved.manifest, asset: saved.asset };
  });

  app.get("/pricebooks/:id/assets/:assetId", async (request, reply) => {
    const asset = await readAsset(getPricebookId(request.params), String(asRecord(request.params).assetId ?? ""));
    reply.type(resolveMimeType(String(asset.asset.file_name), String(asset.asset.content_type ?? "")));
    reply.header("Content-Disposition", `inline; filename="${String(asset.asset.file_name)}"`);
    return reply.send(asset.content);
  });

  app.delete("/pricebooks/:id/assets/:assetId", async (request) => {
    const body = deleteByRevisionSchema.parse(request.body ?? {});
    const assetId = String(asRecord(request.params).assetId ?? "");
    const updated = await deleteAsset(getPricebookId(request.params), assetId, body.expected_revision);
    return { ok: true, manifest: updated.manifest, catalog: updated.catalog, deleted_asset_id: assetId };
  });
};

function getPricebookId(params: unknown) {
  return sanitizePricebookId(String(asRecord(params).id ?? ""));
}

function matchesQuery(manifest: Record<string, unknown>, query: Record<string, unknown>) {
  const statuses = Array.isArray(query.statuses) ? query.statuses.map((value) => String(value)) : null;
  if (statuses && statuses.length && !statuses.includes(String(manifest.status ?? ""))) return false;
  if (query.organization_id && String(asRecord(manifest.organization_ref).id ?? "") !== String(query.organization_id)) return false;
  if (query.owner_email && String(asRecord(manifest.owner_ref).email ?? "").toLowerCase() !== String(query.owner_email).toLowerCase()) return false;
  if (query.template_key && String(asRecord(manifest.template_ref).key ?? "") !== String(query.template_key)) return false;
  const needle = String(query.search ?? "").trim().toLowerCase();
  if (!needle) return true;
  const hay = [
    manifest.id,
    manifest.name,
    manifest.description,
    asRecord(manifest.organization_ref).id,
    asRecord(manifest.owner_ref).email
  ].map((value) => String(value ?? "").toLowerCase()).join(" ");
  return hay.includes(needle);
}

function stripExpectedRevision(value: Record<string, unknown>) {
  const next = { ...value };
  delete next.expected_revision;
  delete next.actor;
  return next;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function toOptionalString(value: unknown) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

function toOptionalNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function tryParseJsonString(value: unknown, fallback: unknown) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function resolveMimeType(fileName: string, declaredContentType: string) {
  if (declaredContentType) return declaredContentType;
  const extension = path.extname(fileName).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".json") return "application/json; charset=utf-8";
  return "application/octet-stream";
}
