import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { ZodError, z } from "zod";

import { env } from "../src/config/env.js";
import { PlatformError, badRequest, forbidden, notFound } from "../platform/errors.js";
import { isAppFlagEnabled } from "../platform/app_flags.js";
import { buildReportExpediteOptions, isExpeditedReportExpediteKey, normalizeReportExpediteKey } from "../firstmeasure/expedite.js";
import {
  authenticatePublicFirstMeasureRequest,
  requirePublicFirstMeasureScope,
  type PublicFirstMeasureAuthContext
} from "./keys.js";
import {
  chargePublicFirstMeasureOrder,
  firstMeasurePublicReportAmount,
  makeChargeToken,
  publicFirstMeasureBalance,
  refundPublicFirstMeasureOrder
} from "./billing.js";
import {
  createPublicFirstMeasureReportRecord,
  findPublicFirstMeasureReportByIdempotency,
  generatePublicReportId,
  listPublicFirstMeasureReports,
  publicReportSummary,
  readPublicFirstMeasureReport
} from "./reports.js";
import { parseRoofplanMeasurementXml } from "./measurements.js";
import { revealPublicFirstMeasureKeyDelivery } from "./key_delivery.js";
import { asObject, cleanText, maybeJson, parseBoolean, publicBaseUrl, stableHash } from "./util.js";
import { acquirePublicFirstMeasureLock } from "./locks.js";

const pinSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180)
});

const orderReportSchema = z.object({
  external_id: z.string().optional(),
  address: z.string().min(1),
  project_type: z.enum(["residential", "commercial", "multifamily"]).optional(),
  report_mode: z.enum(["full", "instant", "both"]).optional(),
  include_gutter_measurements: z.boolean().optional(),
  include_weather_report: z.boolean().optional(),
  weather_report_tier: z.string().optional(),
  report_expedite_option: z.string().optional(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  pins: z.array(pinSchema).optional(),
  radius_meters: z.number().optional(),
  customer: z.object({
    name: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional()
  }).partial().optional(),
  issuer: z.object({
    name: z.string().optional(),
    email: z.string().optional()
  }).partial().optional(),
  cc_emails: z.array(z.string()).optional(),
  branding_defaults: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
  process_async: z.boolean().optional()
}).passthrough();

const generatePdfSchema = z.object({
  source: z.enum(["saved", "inline"]).optional(),
  snapshot: z.unknown().optional(),
  persist_files: z.boolean().optional(),
  update_status: z.boolean().optional(),
  outputs: z.array(z.record(z.unknown())).optional()
}).passthrough();

const PUBLIC_MEASUREMENT_FORMATS = new Set(["json", "roofplan"]);

type InjectJsonResult = {
  statusCode: number;
  payload: Record<string, unknown>;
};

type PublicReportOrderBody = z.infer<typeof orderReportSchema>;

type PublicOrderGeocodeResult = {
  lat: number;
  lng: number;
  formatted_address: string;
  provider_status: string;
};

export const registerPublicFirstMeasureApi: FastifyPluginAsync = async (app) => {
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
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: "An unexpected error occurred." });
  });

  app.get("/", async () => ({
    ok: true,
    api: "public_firstmeasure",
    version: "2026-06-10",
    endpoints: {
      pricing: "/pricing",
      balance: "/balance",
      reports: "/reports",
      report: "/reports/:id",
      pdf: "/reports/:id/pdf",
      measurements: "/reports/:id/measurements",
      files: "/reports/:id/files"
    }
  }));

  app.get("/pricing", async (request) => {
    const ctx = await authenticatePublicFirstMeasureRequest(request);
    requirePublicFirstMeasureScope(ctx, "firstmeasure:reports:create");
    const query = asObject(request.query);
    const features = await publicFirstMeasureFeatureFlags(ctx.orgId);
    const quote = buildReportExpediteOptions({
      projectType: query.project_type,
      structureCount: query.structure_count ?? query.structures ?? query.pin_count
    });
    return {
      ok: true,
      mode: ctx.mode,
      test_mode: ctx.mode === "test",
      project_type: cleanText(query.project_type) || "residential",
      structure_count: Math.max(1, Math.round(Number(query.structure_count ?? query.structures ?? query.pin_count ?? 1)) || 1),
      current_wait: {
        generated_at: quote.generated_at,
        estimated_wait_minutes: quote.options.find((option) => option.key === "standard_3_6")?.estimated_wait_minutes ?? null,
        busy_label: quote.options.find((option) => option.key === "standard_3_6")?.busy_label || ""
      },
      feature_flags: features,
      options: quote.options.filter((option) => !option.expedited || features.report_expedite_options),
      add_ons: {
        gutters: {
          enabled: features.gutter_reports,
          request_field: "include_gutter_measurements",
          unit_price: 2,
          unit: "per_structure"
        },
        weather_report: {
          enabled: features.weather_reports,
          request_field: "include_weather_report",
          tier_field: "weather_report_tier",
          default_tier: "history",
          unit_price: 5,
          unit: "per_structure"
        }
      }
    };
  });

  app.get("/balance", async (request) => {
    const ctx = await authenticatePublicFirstMeasureRequest(request);
    requirePublicFirstMeasureScope(ctx, "firstmeasure:billing:read");
    return {
      ok: true,
      mode: ctx.mode,
      test_mode: ctx.mode === "test",
      org_id: ctx.orgId,
      ...(ctx.mode === "test" ? { message: "Test-mode report requests do not charge credits or commission live FirstMeasure work." } : {}),
      ...(await publicFirstMeasureBalance(ctx.orgId))
    };
  });

  app.get("/reports", async (request) => {
    const ctx = await authenticatePublicFirstMeasureRequest(request);
    requirePublicFirstMeasureScope(ctx, "firstmeasure:reports:read");
    const query = asObject(request.query);
    const records = await listPublicFirstMeasureReports({
      orgId: ctx.orgId,
      mode: ctx.mode,
      externalId: cleanText(query.external_id) || null,
      limit: Number(query.limit ?? 100)
    });
    const summaries = await Promise.all(records.map(async (record) => {
      if ((record.mode ?? "live") === "test") return publicReportSummary(record);
      const project = await injectFirstMeasureJson(app, "GET", `/projects/${encodeURIComponent(record.firstmeasure_project_id)}`)
        .then((result) => result.payload.project)
        .catch(() => null);
      return publicReportSummary(record, project);
    }));
    return {
      ok: true,
      count: summaries.length,
      reports: summaries
    };
  });

  app.post("/reports", async (request, reply) => {
    const ctx = await authenticatePublicFirstMeasureRequest(request);
    requirePublicFirstMeasureScope(ctx, "firstmeasure:reports:create");
    const body = await resolvePublicFirstMeasureOrderCoordinates(orderReportSchema.parse(request.body ?? {}));
    const features = await assertPublicFirstMeasureOrderFeatures(ctx.orgId, body);
    assertPublicFirstMeasureOrderCoordinates(body);
    const idempotencyHash = idempotencyHashForRequest(request, ctx);
    const releaseOrderLock = idempotencyHash
      ? await acquirePublicFirstMeasureLock(`order:${ctx.orgId}:${ctx.mode}:${idempotencyHash}`)
      : async () => undefined;
    try {
      const existing = await findPublicFirstMeasureReportByIdempotency(ctx.orgId, idempotencyHash, ctx.mode);
    if (existing) {
      if ((existing.mode ?? "live") === "test") {
        reply.code(200);
        return {
          ok: true,
          mode: "test",
          test_mode: true,
          idempotent_replay: true,
          report: publicReportSummary(existing)
        };
      }
      const project = await injectFirstMeasureJson(app, "GET", `/projects/${encodeURIComponent(existing.firstmeasure_project_id)}`)
        .then((result) => result.payload.project)
        .catch(() => null);
      reply.code(200);
      return {
        ok: true,
        idempotent_replay: true,
        report: publicReportSummary(existing, project)
      };
    }

    const amount = firstMeasurePublicReportAmount({
      project_type: body.project_type,
      report_mode: body.report_mode,
      report_expedite_option: body.report_expedite_option,
      include_gutter_measurements: body.include_gutter_measurements,
      include_weather_report: body.include_weather_report,
      pins: body.pins
    });

    if (ctx.mode === "test") {
      const balance = await publicFirstMeasureBalance(ctx.orgId);
      const reportId = generatePublicReportId();
      const record = await createPublicFirstMeasureReportRecord({
        report_id: reportId,
        org_id: ctx.orgId,
        mode: "test",
        firstmeasure_project_id: `test_${reportId}`,
        external_id: cleanText(body.external_id) || null,
        idempotency_key_hash: idempotencyHash,
        charge_token: null,
        amount_charged: 0,
        quoted_amount: amount,
        created_by_key_id: ctx.keyId,
        request: sanitizeOrderForStorage(body),
        metadata: asObject(body.metadata),
        test_report: buildTestReportData(reportId, body, amount)
      });
      reply.code(201);
      return {
        ok: true,
        mode: "test",
        test_mode: true,
        report: publicReportSummary(record),
        billing: {
          test_mode: true,
          amount_charged: 0,
          quoted_amount: amount,
          balance: balance.balance,
          ledger_count: balance.ledger_count,
          auto_topup: null,
          message: "Test mode validates the request and returns sandbox report data without charging credits or commissioning a live report."
        }
      };
    }

    const chargeToken = makeChargeToken(ctx.orgId, ctx.keyId);
    const charge = await chargePublicFirstMeasureOrder({
      orgId: ctx.orgId,
      amount,
      actorEmail: ctx.actor.email,
      meta: {
        charge_token: chargeToken,
        external_id: body.external_id ?? null,
        address: body.address,
        project_type: body.project_type ?? "residential",
        report_mode: body.report_mode ?? "full",
        source: "public_firstmeasure_api"
      }
    });

    const internalPayload = buildInternalOrderPayload(ctx, body, amount, chargeToken, features);
    const hasStructurePins = Array.isArray(body.pins) && body.pins.length > 0;
    const route = body.report_mode === "instant"
      ? "/instants"
      : hasStructurePins
        ? "/projects/queue"
        : "/projects";
    const internal = await injectFirstMeasureJson(app, "POST", route, internalPayload).catch(async (error) => {
      await refundPublicFirstMeasureOrder({
        orgId: ctx.orgId,
        amount,
        actorEmail: ctx.actor.email,
        meta: {
          charge_token: chargeToken,
          external_id: body.external_id ?? null,
          failed_order_error: error instanceof Error ? error.message : String(error)
        }
      });
      throw error;
    });
    if (internal.statusCode >= 400 || internal.payload.ok === false || internal.payload.success === false) {
      await refundPublicFirstMeasureOrder({
        orgId: ctx.orgId,
        amount,
        actorEmail: ctx.actor.email,
        meta: {
          charge_token: chargeToken,
          external_id: body.external_id ?? null,
          failed_order: internal.payload
        }
      });
      throw badRequest("firstmeasure_order_failed", cleanText(internal.payload.message || internal.payload.error) || "FirstMeasure order creation failed.", internal.payload);
    }

    let project = asObject(internal.payload.project);
    let manifest = asObject(internal.payload.manifest ?? project.manifest);
    const projectId = cleanText(manifest.id || project.id || internal.payload.folder);
    if (!projectId) {
      await refundPublicFirstMeasureOrder({
        orgId: ctx.orgId,
        amount,
        actorEmail: ctx.actor.email,
        meta: { charge_token: chargeToken, external_id: body.external_id ?? null, failed_order: internal.payload }
      });
      throw badRequest("firstmeasure_order_missing_project", "FirstMeasure did not return a project id.", internal.payload);
    }

    if (!hasStructurePins && body.report_mode !== "instant") {
      const pinPatch = await injectFirstMeasureJson(app, "PATCH", `/projects/${encodeURIComponent(projectId)}`, {
        status: "needs_structure_pins",
        pins: [],
        structure_pin_mode: "all_structures_on_parcel",
        structure_pin_status: "needs_structure_pins",
        structure_pin_error: null,
        timestamps: {
          structure_pins_requested_at: new Date().toISOString()
        }
      });
      if (pinPatch.statusCode < 400 && pinPatch.payload.ok !== false && pinPatch.payload.success !== false) {
        const patchedProject = asObject(pinPatch.payload.project);
        project = patchedProject;
        manifest = asObject(patchedProject.manifest);
      }
    }

    const record = await createPublicFirstMeasureReportRecord({
      report_id: generatePublicReportId(),
      org_id: ctx.orgId,
      mode: "live",
      firstmeasure_project_id: projectId,
      external_id: cleanText(body.external_id) || null,
      idempotency_key_hash: idempotencyHash,
      charge_token: chargeToken,
      amount_charged: amount,
      created_by_key_id: ctx.keyId,
      request: sanitizeOrderForStorage(body),
      metadata: asObject(body.metadata)
    });

    reply.code(201);
      return {
        ok: true,
        report: publicReportSummary(record, project),
        billing: {
          amount_charged: amount,
          balance: charge.balance,
          ledger_count: charge.ledger_count,
          auto_topup: asObject(charge).auto_topup ?? null
        }
      };
    } finally {
      await releaseOrderLock();
    }
  });

  app.get("/reports/:id", async (request) => {
    const ctx = await authenticatePublicFirstMeasureRequest(request);
    requirePublicFirstMeasureScope(ctx, "firstmeasure:reports:read");
    const record = await reportForRequest(request, ctx);
    if ((record.mode ?? "live") === "test") {
      return {
        ok: true,
        mode: "test",
        test_mode: true,
        report: publicReportSummary(record),
        project: testProjectDetail(record)
      };
    }
    const project = await injectFirstMeasureJson(app, "GET", `/projects/${encodeURIComponent(record.firstmeasure_project_id)}`).then((result) => result.payload.project);
    return {
      ok: true,
      report: publicReportSummary(record, project),
      project: publicProjectDetail(project)
    };
  });

  app.get("/reports/:id/pdf", async (request, reply) => {
    const ctx = await authenticatePublicFirstMeasureRequest(request);
    requirePublicFirstMeasureScope(ctx, "firstmeasure:pdfs:read");
    const record = await reportForRequest(request, ctx);
    if ((record.mode ?? "live") === "test") {
      reply.code(200);
      reply.type("application/pdf");
      reply.header("Content-Disposition", `attachment; filename="${record.report_id}-test-report.pdf"`);
      return reply.send(testReportPdf(record));
    }
    const query = asObject(request.query);
    const slot = cleanText(query.slot) || "main";
    const response = await app.inject({
      method: "GET",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}/pdf?slot=${encodeURIComponent(slot)}`
    });
    return forwardInjectResponse(response, reply, "application/pdf");
  });

  app.post("/reports/:id/pdf", async (request) => {
    const ctx = await authenticatePublicFirstMeasureRequest(request);
    requirePublicFirstMeasureScope(ctx, "firstmeasure:pdfs:write");
    const record = await reportForRequest(request, ctx);
    const input = generatePdfSchema.parse(request.body ?? {});
    if ((record.mode ?? "live") === "test") {
      return {
        ok: true,
        mode: "test",
        test_mode: true,
        report_id: record.report_id,
        result: {
          ok: true,
          generated: false,
          message: "Test mode returns a deterministic sandbox PDF and does not generate production artifacts.",
          input
        }
      };
    }
    const response = await injectFirstMeasureJson(
      app,
      "POST",
      `/projects/${encodeURIComponent(record.firstmeasure_project_id)}/pdfs/generate`,
      { ...input, actor: ctx.actor }
    );
    return {
      ok: response.payload.ok !== false,
      report_id: record.report_id,
      result: response.payload
    };
  });

  app.get("/reports/:id/measurements", async (request, reply) => {
    const ctx = await authenticatePublicFirstMeasureRequest(request);
    requirePublicFirstMeasureScope(ctx, "firstmeasure:measurements:read");
    const record = await reportForRequest(request, ctx);
    const query = asObject(request.query);
    const format = cleanText(query.format).toLowerCase() || "json";
    if (!PUBLIC_MEASUREMENT_FORMATS.has(format)) {
      throw badRequest("unsupported_measurement_format", "Public FirstMeasure currently supports measurement formats 'json' and 'roofplan'.");
    }
    if ((record.mode ?? "live") === "test") {
      const xml = testMeasurementXml(record);
      if (format !== "json") {
        reply.code(200);
        reply.type(contentTypeForMeasurementFormat(format));
        return reply.send(xml);
      }
      return {
        ok: true,
        mode: "test",
        test_mode: true,
        report_id: record.report_id,
        measurements: parseRoofplanMeasurementXml(xml)
      };
    }
    const xmlFormat = format === "json" ? "roofplan" : format;
    const response = await app.inject({
      method: "GET",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}/xml?format=${encodeURIComponent(xmlFormat)}`
    });
    if (format !== "json") {
      return forwardInjectResponse(response, reply, contentTypeForMeasurementFormat(format));
    }
    if (response.statusCode >= 400) {
      return forwardInjectResponse(response, reply, "application/json; charset=utf-8");
    }
    return {
      ok: true,
      report_id: record.report_id,
      measurements: parseRoofplanMeasurementXml(response.body)
    };
  });

  app.get("/reports/:id/files", async (request) => {
    const ctx = await authenticatePublicFirstMeasureRequest(request);
    requirePublicFirstMeasureScope(ctx, "firstmeasure:files:read");
    const record = await reportForRequest(request, ctx);
    if ((record.mode ?? "live") === "test") {
      return {
        ok: true,
        mode: "test",
        test_mode: true,
        report_id: record.report_id,
        files: testReportFiles(record).map((file) => ({
          ...file,
          url: `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}/files/${encodeURIComponent(cleanText(file.name))}`
        }))
      };
    }
    const project = await injectFirstMeasureJson(app, "GET", `/projects/${encodeURIComponent(record.firstmeasure_project_id)}`).then((result) => asObject(result.payload.project));
    const files = Array.isArray(project.files) ? project.files : [];
    return {
      ok: true,
      report_id: record.report_id,
      files: files.map((file) => ({
        ...asObject(file),
        url: `/v1/public/firstmeasure/reports/${encodeURIComponent(record.report_id)}/files/${encodeURIComponent(cleanText(asObject(file).name))}`
      }))
    };
  });

  app.get("/reports/:id/files/:name", async (request, reply) => {
    const ctx = await authenticatePublicFirstMeasureRequest(request);
    requirePublicFirstMeasureScope(ctx, "firstmeasure:files:read");
    const record = await reportForRequest(request, ctx);
    const name = cleanText(asObject(request.params).name);
    if ((record.mode ?? "live") === "test") {
      const file = testReportFile(record, name);
      reply.code(200);
      reply.type(file.content_type);
      reply.header("Content-Disposition", `attachment; filename="${file.name}"`);
      return reply.send(file.body);
    }
    const response = await app.inject({
      method: "GET",
      url: `/v1/firstmeasure/projects/${encodeURIComponent(record.firstmeasure_project_id)}/artifacts/${encodeURIComponent(name)}`
    });
    return forwardInjectResponse(response, reply, response.headers["content-type"] ? String(response.headers["content-type"]) : "application/octet-stream");
  });

  app.post("/webhooks/test", async (request) => {
    const ctx = await authenticatePublicFirstMeasureRequest(request);
    return {
      ok: true,
      received_at: new Date().toISOString(),
      org_id: ctx.orgId,
      key_id: ctx.keyId,
      body: request.body ?? null
    };
  });

  app.post("/key-delivery/reveal", async (request, reply) => {
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, private");
    reply.header("Pragma", "no-cache");
    reply.header("Expires", "0");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    const body = asObject(request.body);
    const revealed = await revealPublicFirstMeasureKeyDelivery(body.token);
    return {
      ok: true,
      success: true,
      delivery: revealed
    };
  });
};

function idempotencyHashForRequest(request: FastifyRequest, ctx: PublicFirstMeasureAuthContext) {
  const key = cleanText(request.headers["idempotency-key"]);
  return key ? stableHash(`${ctx.orgId}:${key}`) : null;
}

async function publicFirstMeasureFeatureFlags(orgId: string) {
  const [gutterReports, weatherReports, expediteOptions] = await Promise.all([
    isAppFlagEnabled(orgId, "firstmeasure", "gutter_reports").catch(() => false),
    isAppFlagEnabled(orgId, "firstmeasure", "weather_reports").catch(() => false),
    isAppFlagEnabled(orgId, "firstmeasure", "report_expedite_options").catch(() => false)
  ]);
  return {
    gutter_reports: gutterReports,
    weather_reports: weatherReports,
    report_expedite_options: expediteOptions
  };
}

async function assertPublicFirstMeasureOrderFeatures(orgId: string, body: PublicReportOrderBody) {
  const features = await publicFirstMeasureFeatureFlags(orgId);
  if (body.include_gutter_measurements === true && !features.gutter_reports) {
    throw forbidden("feature_not_enabled", "Gutter measurements are not enabled for this organization.", {
      feature: "firstmeasure.gutter_reports"
    });
  }
  if (body.include_weather_report === true && !features.weather_reports) {
    throw forbidden("feature_not_enabled", "Historical weather reports are not enabled for this organization.", {
      feature: "firstmeasure.weather_reports"
    });
  }
  const expediteKey = cleanText(body.report_expedite_option).toLowerCase();
  const requestedRush = isExpeditedReportExpediteKey(expediteKey);
  if (requestedRush && !features.report_expedite_options) {
    throw forbidden("feature_not_enabled", "Expedited report options are not enabled for this organization.", {
      feature: "firstmeasure.report_expedite_options"
    });
  }
  return features;
}

function hasUsableCoordinatePair(body: PublicReportOrderBody) {
  return typeof body.lat === "number"
    && typeof body.lng === "number"
    && Number.isFinite(body.lat)
    && Number.isFinite(body.lng)
    && !(body.lat === 0 && body.lng === 0);
}

async function resolvePublicFirstMeasureOrderCoordinates(body: PublicReportOrderBody): Promise<PublicReportOrderBody> {
  const hasStructurePins = Array.isArray(body.pins) && body.pins.length > 0;
  if (hasStructurePins || body.report_mode === "instant" || hasUsableCoordinatePair(body)) return body;

  const geocoded = await geocodePublicFirstMeasureAddress(body.address);
  return {
    ...body,
    lat: geocoded.lat,
    lng: geocoded.lng,
    metadata: {
      ...asObject(body.metadata),
      geocoding: {
        provider: "google_maps",
        formatted_address: geocoded.formatted_address,
        provider_status: geocoded.provider_status
      }
    }
  };
}

async function geocodePublicFirstMeasureAddress(address: string): Promise<PublicOrderGeocodeResult> {
  const key = cleanText(env.googleMapsApiKey);
  if (!key) {
    throw badRequest("geocoding_unavailable", "Server-side address geocoding is not configured. Send lat and lng, or try again later.");
  }
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", key);

  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    throw badRequest("geocode_failed", "Unable to geocode the report address.");
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    payload = {};
  }

  const providerStatus = cleanText(payload.status);
  const first = asObject(Array.isArray(payload.results) ? payload.results[0] : null);
  const location = asObject(asObject(first.geometry).location);
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  if (!response.ok || !Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) {
    throw badRequest("geocode_failed", "Unable to geocode the report address.", {
      provider_status: providerStatus || String(response.status),
      provider_error: cleanText(payload.error_message) || null
    });
  }

  return {
    lat,
    lng,
    formatted_address: cleanText(first.formatted_address) || address,
    provider_status: providerStatus || "OK"
  };
}

function assertPublicFirstMeasureOrderCoordinates(body: PublicReportOrderBody) {
  const hasLat = typeof body.lat === "number";
  const hasLng = typeof body.lng === "number";
  if (hasLat && hasLng && body.lat === 0 && body.lng === 0) {
    throw badRequest("invalid_coordinates", "lat and lng cannot both be 0 for FirstMeasure report orders.", {
      fields: ["lat", "lng"]
    });
  }
  const hasStructurePins = Array.isArray(body.pins) && body.pins.length > 0;
  if (!hasStructurePins && body.report_mode !== "instant" && (!hasLat || !hasLng)) {
    throw badRequest("coordinates_required", "lat and lng are required when pins are omitted so staff pin placement can load property imagery.", {
      fields: ["lat", "lng"],
      alternative: "Send at least one structure pin in pins."
    });
  }
}

function getPublicReportId(params: unknown) {
  return cleanText(asObject(params).id);
}

async function reportForRequest(request: FastifyRequest, ctx: PublicFirstMeasureAuthContext) {
  const record = await readPublicFirstMeasureReport(getPublicReportId(request.params), ctx.orgId);
  if ((record.mode ?? "live") !== ctx.mode) {
    throw notFound("report_not_found", "The requested report was not found.");
  }
  return record;
}

function buildTestReportData(reportId: string, body: PublicReportOrderBody, quotedAmount: number) {
  const now = new Date().toISOString();
  return {
    report_id: reportId,
    status: "completed",
    address: body.address,
    project_type: body.project_type ?? "residential",
    report_mode: body.report_mode ?? "full",
    include_gutter_measurements: body.include_gutter_measurements === true,
    include_weather_report: body.include_weather_report === true,
    weather_report_tier: cleanText(body.weather_report_tier) || (body.include_weather_report === true ? "history" : null),
    quoted_amount: quotedAmount,
    completed_at: now,
    lat: body.lat ?? null,
    lng: body.lng ?? null,
    pin_count: Array.isArray(body.pins) ? body.pins.length : 0,
    artifacts: {
      has_report_pdf: true,
      has_summary_pdf: true,
      has_model_data: true,
      has_pdf_state: false
    }
  };
}

function testProjectDetail(record: Awaited<ReturnType<typeof readPublicFirstMeasureReport>>) {
  const testReport = asObject(record.test_report);
  return {
    mode: "test",
    test_mode: true,
    status: cleanText(testReport.status) || "completed",
    address: cleanText(testReport.address || asObject(record.request).address),
    project_type: cleanText(testReport.project_type || asObject(record.request).project_type) || "residential",
    lat: testReport.lat ?? null,
    lng: testReport.lng ?? null,
    timestamps: {
      created_at: record.created_at,
      queued_at: null,
      started_at: null,
      uploaded_at: record.created_at,
      completed_at: testReport.completed_at ?? record.created_at,
      updated_at: record.updated_at
    },
    artifacts: {
      has_report_pdf: true,
      has_summary_pdf: true,
      has_model_data: true,
      has_pdf_state: false
    }
  };
}

function xmlEscape(value: unknown) {
  return cleanText(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function testMeasurementXml(record: Awaited<ReturnType<typeof readPublicFirstMeasureReport>>) {
  const request = asObject(record.request);
  const testReport = asObject(record.test_report);
  const address = xmlEscape(testReport.address || request.address || "Test Mode Address");
  const lat = xmlEscape(testReport.lat ?? request.lat ?? "37.422");
  const lng = xmlEscape(testReport.lng ?? request.lng ?? "-122.0841");
  return `<?xml version="1.0" encoding="UTF-8"?>
<DATA_EXPORT>
  <LOCATION address="${address}" city="Test City" state="TS" postal="00000" lat="${lat}" long="${lng}"/>
  <STRUCTURES>
    <ROOF id="TEST_ROOF">
      <FACES>
        <FACE id="F1" type="ROOF"><POLYGON id="P1" path="L1,L2,L3,L4" pitch="6" size="1200"/></FACE>
        <FACE id="F2" type="ROOF"><POLYGON id="P2" path="L5,L6,L7,L8" pitch="8" size="900"/></FACE>
      </FACES>
      <LINES>
        <LINE id="L1" path="P1A,P1B" type="EAVE" width="30" height="0"/>
        <LINE id="L2" path="P1B,P1C" type="RAKE" width="24" height="0"/>
        <LINE id="L3" path="P1C,P1D" type="RIDGE" width="30" height="0"/>
        <LINE id="L4" path="P1D,P1A" type="VALLEY" width="24" height="0"/>
      </LINES>
      <POINTS>
        <POINT id="P1A" data="0,0,0"/>
        <POINT id="P1B" data="30,0,0"/>
        <POINT id="P1C" data="30,40,8"/>
        <POINT id="P1D" data="0,40,8"/>
      </POINTS>
    </ROOF>
  </STRUCTURES>
</DATA_EXPORT>`;
}

function testReportPdf(record: Awaited<ReturnType<typeof readPublicFirstMeasureReport>>) {
  const title = `FirstMeasure Test Report ${record.report_id}`;
  const createdAt = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  const pdfDate = `D:${createdAt.getUTCFullYear()}${pad(createdAt.getUTCMonth() + 1)}${pad(createdAt.getUTCDate())}${pad(createdAt.getUTCHours())}${pad(createdAt.getUTCMinutes())}${pad(createdAt.getUTCSeconds())}+00'00'`;
  return Buffer.from(`%PDF-1.4
1 0 obj
<< /Type /Catalog /Pages 2 0 R >>
endobj
2 0 obj
<< /Type /Pages /Kids [3 0 R] /Count 1 >>
endobj
3 0 obj
<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>
endobj
4 0 obj
<< /Length ${title.length + 64} >>
stream
BT /F1 18 Tf 72 720 Td (${title}) Tj 0 -28 Td (Sandbox fixture. No live report was commissioned.) Tj ET
endstream
endobj
5 0 obj
<< /Title (${title}) /Author (FirstMate) /Creator (FirstMate) /Producer (FirstMate) /Subject (FirstMate FirstMeasure sandbox test report) /Keywords (FirstMate, FirstMeasure, test report) /CreationDate (${pdfDate}) /ModDate (${pdfDate}) >>
endobj
trailer
<< /Root 1 0 R /Info 5 0 R >>
%%EOF
`, "utf8");
}

function testReportFiles(record: Awaited<ReturnType<typeof readPublicFirstMeasureReport>>) {
  return [
    { name: "Report.pdf", content_type: "application/pdf", size: testReportPdf(record).length },
    { name: "model_data.xml", content_type: "application/xml; charset=utf-8", size: Buffer.byteLength(testMeasurementXml(record)) },
    { name: "summary.json", content_type: "application/json; charset=utf-8", size: Buffer.byteLength(JSON.stringify(publicReportSummary(record))) }
  ];
}

function testReportFile(record: Awaited<ReturnType<typeof readPublicFirstMeasureReport>>, rawName: string) {
  const name = cleanText(rawName);
  if (name === "Report.pdf") return { name, content_type: "application/pdf", body: testReportPdf(record) };
  if (name === "model_data.xml") return { name, content_type: "application/xml; charset=utf-8", body: testMeasurementXml(record) };
  if (name === "summary.json") return { name, content_type: "application/json; charset=utf-8", body: Buffer.from(JSON.stringify(publicReportSummary(record), null, 2), "utf8") };
  throw notFound("file_not_found", "The requested file was not found.");
}

function buildInternalOrderPayload(
  ctx: PublicFirstMeasureAuthContext,
  body: z.infer<typeof orderReportSchema>,
  amount: number,
  chargeToken: string,
  features: Awaited<ReturnType<typeof publicFirstMeasureFeatureFlags>>
) {
  const customer = asObject(body.customer);
  const issuer = asObject(body.issuer);
  const pins = Array.isArray(body.pins) ? body.pins : [];
  const needsStructurePins = pins.length === 0 && body.report_mode !== "instant";
  const quote = buildReportExpediteOptions({
    projectType: body.project_type,
    structureCount: Math.max(1, pins.length || 1)
  });
  const normalizedExpediteKey = normalizeReportExpediteKey(cleanText(body.report_expedite_option).toLowerCase() || "standard_3_6");
  const expediteOption = quote.options.find((option) => option.key === normalizedExpediteKey)
    ?? quote.options.find((option) => option.key === "standard_3_6");
  return {
    address: body.address,
    status: needsStructurePins ? "needs_structure_pins" : undefined,
    project_type: body.project_type ?? "residential",
    report_mode: body.report_mode ?? "full",
    include_gutter_measurements: body.include_gutter_measurements === true,
    include_weather_report: body.include_weather_report === true,
    weather_report_tier: cleanText(body.weather_report_tier) || (body.include_weather_report === true ? "history" : undefined),
    report_expedite_option: expediteOption?.key ?? body.report_expedite_option,
    report_expedite_label: expediteOption?.label ?? null,
    report_due_window_start: expediteOption?.due_window_start ?? null,
    report_due_window_end: expediteOption?.due_window_end ?? null,
    report_due_window_label: expediteOption?.window_label ?? null,
    report_production_deadline_at: expediteOption?.production_deadline_at ?? null,
    report_release_hold_enabled: features.report_expedite_options,
    lat: body.lat,
    lng: body.lng,
    pins,
    radius_meters: body.radius_meters,
    cc_emails: body.cc_emails ?? [],
    resident: {
      name: cleanText(customer.name),
      email: cleanText(customer.email),
      phone: cleanText(customer.phone)
    },
    issuer: {
      name: cleanText(issuer.name) || ctx.keyName,
      email: cleanText(issuer.email) || ctx.actor.email
    },
    actor: ctx.actor,
    owner_ref: {
      id: ctx.actor.id,
      email: ctx.actor.email,
      name: ctx.actor.name
    },
    organization_ref: { id: ctx.orgId },
    team_ref: { id: "default" },
    branding_defaults: body.branding_defaults,
    amount_charged: amount,
    charge_token: chargeToken,
    process_async: body.process_async !== false,
    structure_pin_mode: needsStructurePins ? "all_structures_on_parcel" : "customer_supplied",
    structure_pin_status: needsStructurePins ? "needs_structure_pins" : "supplied",
    public_api: {
      external_id: body.external_id ?? null,
      key_id: ctx.keyId,
      mode: ctx.mode
    }
  };
}

function sanitizeOrderForStorage(body: Record<string, unknown>) {
  const copy = { ...body };
  delete copy.google_api_key;
  delete copy.gemini_api_key;
  return copy;
}

async function injectFirstMeasureJson(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH",
  path: string,
  payload?: unknown
): Promise<InjectJsonResult> {
  const response = await app.inject({
    method,
    url: `/v1/firstmeasure${path.startsWith("/") ? path : `/${path}`}`,
    headers: {
      "content-type": "application/json",
      ...(env.firstMeasureInternalApiSecret ? { "x-firstmeasure-internal": env.firstMeasureInternalApiSecret } : {})
    },
    payload: payload as object | string | Buffer | undefined
  });
  const parsed = maybeJson(response.body);
  const body = asObject(parsed);
  if (response.statusCode >= 500) {
    throw badRequest("firstmeasure_request_failed", cleanText(body.message || body.error) || `FirstMeasure request failed with status ${response.statusCode}.`, body);
  }
  return {
    statusCode: response.statusCode,
    payload: body
  };
}

function forwardInjectResponse(response: Awaited<ReturnType<FastifyInstance["inject"]>>, reply: FastifyReply, fallbackContentType: string) {
  reply.code(response.statusCode);
  reply.type(String(response.headers["content-type"] || fallbackContentType));
  const disposition = response.headers["content-disposition"];
  if (disposition) reply.header("Content-Disposition", disposition);
  const cacheControl = response.headers["cache-control"];
  if (cacheControl) reply.header("Cache-Control", cacheControl);
  return reply.send(response.rawPayload);
}

function contentTypeForMeasurementFormat(format: string) {
  if (format === "applicad" || format === "rxf") return "text/plain; charset=utf-8";
  return "application/xml; charset=utf-8";
}

function publicProjectDetail(project: unknown) {
  const detail = asObject(project);
  const manifest = asObject(detail.manifest);
  const timestamps = asObject(manifest.timestamps);
  const artifacts = asObject(manifest.artifacts);
  return {
    status: cleanText(manifest.status),
    address: cleanText(manifest.address),
    project_type: cleanText(manifest.project_type),
    lat: manifest.lat ?? null,
    lng: manifest.lng ?? null,
    timestamps: {
      created_at: timestamps.created_at ?? null,
      queued_at: timestamps.queued_at ?? null,
      started_at: timestamps.started_at ?? null,
      uploaded_at: timestamps.uploaded_at ?? null,
      completed_at: timestamps.completed_at ?? null,
      updated_at: timestamps.updated_at ?? null
    },
    artifacts: {
      has_report_pdf: artifacts.has_report_pdf === true || artifacts.has_main_pdf === true,
      has_summary_pdf: artifacts.has_summary_pdf === true,
      has_model_data: artifacts.has_model_data === true,
      has_pdf_state: artifacts.has_pdf_state === true
    }
  };
}
