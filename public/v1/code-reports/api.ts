import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";

import { CodeReportError } from "./errors.js";
import { generateCodeReportPdf } from "./pdf.js";
import { buildCodeReport } from "./reports.js";
import { codeReportRequestSchema } from "./schemas.js";
import { readCodeReport } from "./storage.js";

export const registerCodeReportsApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }
    if (error instanceof CodeReportError) {
      reply.code(error.statusCode);
      return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
    }
    app.log.error(error);
    reply.code(500);
    return reply.send({ ok: false, error: "internal_error", message: error instanceof Error ? error.message : "Unexpected error" });
  });

  app.get("/", async () => ({
    ok: true,
    api: "code-reports",
    endpoints: {
      ping: "/ping",
      sources: "/sources",
      reports: "/reports",
      saved_report: "/reports/:id",
      saved_report_pdf: "/reports/:id/pdf"
    }
  }));

  app.get("/ping", async () => ({ ok: true, api: "code-reports", received_at: new Date().toISOString() }));

  app.get("/sources", async () => ({
    ok: true,
    sources: [
      { id: "census-geocoder", name: "U.S. Census Geocoder", url: "https://geocoding.geo.census.gov/" },
      { id: "usgs-designmaps", name: "USGS Design Maps", url: "https://earthquake.usgs.gov/ws/designmaps/" },
      { id: "fema-nfhl", name: "FEMA National Flood Hazard Layer", url: "https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer" },
      { id: "irc-roofing", name: "2021 IRC Chapter 9 roofing requirements with Washington amendments/local criteria where available", url: "https://codes.iccsafe.org/content/IRC2021P2/chapter-9-roof-assemblies" },
      { id: "firstmeasure", name: "FirstMeasure project artifacts", url: "local-storage" }
    ]
  }));

  app.post("/reports", async (request, reply) => {
    const body = codeReportRequestSchema.parse(request.body ?? {});
    const result = await buildCodeReport(body);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/reports/:id", async (request) => {
    const id = String((request.params as { id?: unknown }).id ?? "");
    return { ok: true, report: await readCodeReport(id) };
  });

  app.get("/reports/:id/pdf", async (request, reply) => {
    const id = String((request.params as { id?: unknown }).id ?? "");
    const result = await generateCodeReportPdf(id);
    reply.type("application/pdf");
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    reply.header("Content-Disposition", `inline; filename="${result.fileName}"`);
    return reply.send(result.bytes);
  });
};
