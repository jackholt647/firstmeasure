const basePath = "/v1/firstmeasure-remote";

const bearerSecurity = [{ bearerAuth: [] }];

export const remoteOpenApi = {
  openapi: "3.1.0",
  info: {
    title: "FirstMeasure Remote Metrics API",
    version: "1.0.0",
    description: "Read-only aggregate production metrics. No project, customer, or employee records are returned. All operations require the existing Remote API bearer key."
  },
  servers: [{ url: "/" }],
  security: bearerSecurity,
  paths: {
    [`${basePath}/openapi.json`]: {
      get: {
        summary: "Discover this API",
        operationId: "getRemoteOpenApi",
        responses: { "200": { description: "This OpenAPI document." } }
      }
    },
    [`${basePath}/ping`]: {
      get: {
        summary: "Check authenticated API availability",
        operationId: "pingRemoteMetrics",
        responses: {
          "200": {
            description: "The authenticated API is available.",
            content: { "application/json": { schema: {
              type: "object",
              properties: { ok: { type: "boolean" }, api: { type: "string" }, version: { type: "integer" }, received_at: { type: "string", format: "date-time" } }
            } } }
          }
        }
      }
    },
    [`${basePath}/summary`]: {
      get: {
        summary: "Current-day orders, completions, and queue counts",
        description: "Day boundaries use the requested IANA timezone. completed_today counts projects completed during that local day, regardless of order date. Counts exclude instant and full-house projects.",
        operationId: "getRemoteSummary",
        parameters: [
          { name: "timezone", in: "query", schema: { type: "string", default: "America/Los_Angeles" }, description: "IANA timezone, for example America/Chicago." },
          { name: "team_id", in: "query", schema: { type: "string", maxLength: 100 }, description: "Optional team filter." }
        ],
        responses: {
          "200": {
            description: "Current-day aggregate summary.",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" }, generated_at: { type: "string", format: "date-time" }, timezone: { type: "string" }, local_date: { type: "string", format: "date" },
                projects: { type: "object", properties: {
                  total: { type: "integer" }, ordered_today: { type: "integer" }, ordered_today_completed: { type: "integer" }, completed_today: { type: "integer" }
                } },
                queue: { type: "object", additionalProperties: { type: "integer" } }, queue_total: { type: "integer" }, queue_version: { type: "integer" },
                definitions: { type: "object", additionalProperties: { type: "string" } }
              }
            } } }
          }
        }
      }
    },
    [`${basePath}/query`]: {
      post: {
        summary: "Query historical aggregate project counts",
        description: "This POST is read-only. Dates are ISO-8601 timestamps; start is inclusive and end is exclusive. Day grouping uses UTC. Results contain at most 500 groups, and total sums the returned groups only. Counts exclude instant and full-house projects. No SQL or record-level access is accepted.",
        operationId: "queryRemoteMetrics",
        requestBody: {
          required: true,
          content: { "application/json": { schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              date_field: { type: "string", enum: ["created", "queued", "started", "completed", "updated"], default: "created" },
              start: { type: "string", format: "date-time" }, end: { type: "string", format: "date-time" },
              group_by: { type: "string", enum: ["none", "day", "status", "project_type", "team_id"], default: "status" },
              statuses: { type: "array", maxItems: 20, items: { type: "string" } },
              project_types: { type: "array", maxItems: 20, items: { type: "string" } },
              team_id: { type: "string", maxLength: 100 }
            },
            examples: [{ date_field: "completed", start: "2026-09-24T00:00:00Z", end: "2026-09-25T00:00:00Z", group_by: "none" }]
          } } }
        },
        responses: {
          "200": {
            description: "Aggregate project counts.",
            content: { "application/json": { schema: {
              type: "object",
              properties: {
                ok: { type: "boolean" }, generated_at: { type: "string", format: "date-time" }, metric: { type: "string", const: "project_count" },
                date_field: { type: "string" }, group_by: { type: "string" }, total: { type: "integer" },
                rows: { type: "array", items: { type: "object", properties: { group: { type: "string" }, project_count: { type: "integer" } } } }
              }
            } } }
          }
        }
      }
    }
  },
  components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", description: "Existing FirstMeasure Remote API key." } } }
} as const;
