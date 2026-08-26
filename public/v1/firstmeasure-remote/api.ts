import type { FastifyPluginAsync } from "fastify";

import { applyRemoteSecurityHeaders, createRemoteRequestGuard } from "./auth.js";
import { buildRemoteSummary, RemoteMetricsInputError, runRemoteAggregateQuery } from "./metrics.js";

type JsonObject = Record<string, unknown>;

export type FirstMeasureRemoteDataProvider = {
  summary(input: JsonObject): Promise<unknown>;
  query(input: JsonObject): Promise<unknown> | unknown;
};

export type FirstMeasureRemoteApiOptions = {
  dataProvider?: FirstMeasureRemoteDataProvider;
};

const defaultProvider: FirstMeasureRemoteDataProvider = {
  summary: buildRemoteSummary,
  query: runRemoteAggregateQuery
};

function objectBody(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const body = value as JsonObject;
  if (JSON.stringify(body).length > 16_384) throw new RemoteMetricsInputError("request_too_large", "The request is too large.");
  return body;
}

export const registerFirstMeasureRemoteApi: FastifyPluginAsync<FirstMeasureRemoteApiOptions> = async (app, options) => {
  const provider = options.dataProvider ?? defaultProvider;
  const guard = createRemoteRequestGuard();

  app.addHook("onSend", async (_request, reply, payload) => {
    applyRemoteSecurityHeaders(reply);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof RemoteMetricsInputError) {
      return reply.code(400).send({ ok: false, error: error.code, message: error.message });
    }
    request.log.error({ err: error }, "FirstMeasure Remote request failed");
    return reply.code(500).send({ ok: false, error: "internal_error", message: "The request could not be completed." });
  });

  app.get("/ping", { preHandler: guard }, async () => ({
    ok: true,
    api: "firstmeasure-remote",
    version: 1,
    received_at: new Date().toISOString()
  }));

  app.get("/summary", { preHandler: guard }, async (request) => {
    return provider.summary(objectBody(request.query));
  });

  app.post("/query", { preHandler: guard }, async (request) => {
    return provider.query(objectBody(request.body));
  });
};
