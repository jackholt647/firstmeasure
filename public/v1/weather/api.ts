import type { FastifyPluginAsync } from "fastify";
import { ZodError } from "zod";

import { WeatherError } from "./errors.js";
import { generateWeatherReportPdf } from "./pdf.js";
import { buildWeatherReport, pullWeatherData } from "./reports.js";
import { weatherDataRequestSchema, weatherReportRequestSchema } from "./schemas.js";
import { readWeatherReport } from "./storage.js";

export const registerWeatherApi: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      reply.code(400);
      return reply.send({ ok: false, error: "validation_error", issues: error.issues });
    }

    if (error instanceof WeatherError) {
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
    return reply.send({
      ok: false,
      error: "internal_error",
      message: error instanceof Error ? error.message : "An unexpected error occurred."
    });
  });

  app.get("/", async () => ({
    ok: true,
    api: "weather",
    message: "weather API is mounted",
    endpoints: {
      ping: "/ping",
      sources: "/sources",
      data: "/data/pull",
      reports: "/reports",
      history: "/reports/history",
      reviewed: "/reports/reviewed",
      complex: "/reports/complex",
      comprehensive: "/reports/comprehensive",
      saved_report: "/reports/:id",
      saved_report_pdf: "/reports/:id/pdf"
    }
  }));

  app.get("/ping", async () => ({
    ok: true,
    api: "weather",
    received_at: new Date().toISOString()
  }));

  app.get("/sources", async () => ({
    ok: true,
    sources: [
      {
        id: "noaa-swdi",
        name: "NOAA Severe Weather Data Inventory",
        datasets: ["nx3hail", "plsr", "warn", "nx3structure", "nx3meso", "nx3tvs"],
        url: "https://www.ncei.noaa.gov/maps/swdi/",
        coverage_note: "NOAA SWDI metadata lists the dataset time period as 1995-01-01 to present; this API defaults history reports to 2011-01-01."
      },
      {
        id: "nexrad-level2",
        name: "NEXRAD Level-II archive",
        url: "https://registry.opendata.aws/noaa-nexrad/"
      },
      {
        id: "mrms",
        name: "NOAA MRMS",
        url: "https://www.nssl.noaa.gov/projects/mrms/"
      },
      {
        id: "iem",
        name: "Iowa Environmental Mesonet warning/text archives",
        url: "https://mesonet.agron.iastate.edu/",
        coverage_note: "IEM archives are useful for NWS Local Storm Reports and warning metadata, but the archive is not official or complete."
      },
      {
        id: "census-geocoder",
        name: "U.S. Census Geocoder",
        url: "https://geocoding.geo.census.gov/"
      }
    ]
  }));

  app.post("/data/pull", async (request) => {
    const body = weatherDataRequestSchema.parse(request.body ?? {});
    return { ok: true, data: await pullWeatherData(body) };
  });

  app.post("/reports", async (request, reply) => {
    const body = weatherReportRequestSchema.parse(request.body ?? {});
    const result = await buildWeatherReport(body);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.post("/reports/history", async (request, reply) => {
    const body = weatherReportRequestSchema.parse({ ...(request.body as Record<string, unknown> ?? {}), tier: "history" });
    const result = await buildWeatherReport(body);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.post("/reports/reviewed", async (request, reply) => {
    const body = weatherReportRequestSchema.parse({ ...(request.body as Record<string, unknown> ?? {}), tier: "reviewed" });
    const result = await buildWeatherReport(body);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.post("/reports/complex", async (request, reply) => {
    const body = weatherReportRequestSchema.parse({ ...(request.body as Record<string, unknown> ?? {}), tier: "complex" });
    const result = await buildWeatherReport(body);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.post("/reports/comprehensive", async (request, reply) => {
    const body = weatherReportRequestSchema.parse({ ...(request.body as Record<string, unknown> ?? {}), tier: "comprehensive" });
    const result = await buildWeatherReport(body);
    reply.code(201);
    return { ok: true, ...result };
  });

  app.get("/reports/:id", async (request) => {
    const id = String((request.params as { id?: unknown }).id ?? "");
    return { ok: true, report: await readWeatherReport(id) };
  });

  app.get("/reports/:id/pdf", async (request, reply) => {
    const id = String((request.params as { id?: unknown }).id ?? "");
    const result = await generateWeatherReportPdf(id);
    reply.type("application/pdf");
    reply.header("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    reply.header("Pragma", "no-cache");
    reply.header("Expires", "0");
    reply.header("Content-Disposition", `inline; filename="${result.fileName}"`);
    return reply.send(result.bytes);
  });
};
