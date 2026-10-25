/**
 * `/v1/public/firstmeasure` (customer API keys), `/v1/firstmeasure-remote`
 * (the remote analytics key) and the Prices admin
 * (docs/architecture/request-security.md#route-access-declarations).
 */
import { registerRouteAccessTable, type RouteAccess } from "../platform/security/route-access.js";

const apiKey: RouteAccess = { public: "public API: the handler requires a valid organization API key (public-firstmeasure/keys.ts)" };
const remoteKey: RouteAccess = { public: "remote analytics API: its guard requires the remote key and allowed address (firstmeasure-remote/auth.ts)" };

registerRouteAccessTable({
  "GET /v1/public/firstmeasure": { public: "API index: route names only" },
  "GET /v1/public/firstmeasure/pricing": apiKey,
  "GET /v1/public/firstmeasure/balance": apiKey,
  "GET /v1/public/firstmeasure/reports": apiKey,
  "POST /v1/public/firstmeasure/reports": apiKey,
  "GET /v1/public/firstmeasure/reports/:id": apiKey,
  "GET /v1/public/firstmeasure/reports/:id/pdf": apiKey,
  "POST /v1/public/firstmeasure/reports/:id/pdf": apiKey,
  "GET /v1/public/firstmeasure/reports/:id/measurements": apiKey,
  "GET /v1/public/firstmeasure/reports/:id/files": apiKey,
  "GET /v1/public/firstmeasure/reports/:id/files/:name": apiKey,
  "POST /v1/public/firstmeasure/webhooks/test": apiKey,
  "POST /v1/public/firstmeasure/key-delivery/reveal": { public: "one-time key delivery: the 256-bit delivery token is the credential" },

  "GET /v1/firstmeasure-remote/ping": remoteKey,
  "GET /v1/firstmeasure-remote/openapi.json": remoteKey,
  "GET /v1/firstmeasure-remote/summary": remoteKey,
  "POST /v1/firstmeasure-remote/query": remoteKey,

  "GET /v1/firstmeasure/admin/prices/commercial": { staff: "admin" },
  "PUT /v1/firstmeasure/admin/prices/commercial": { staff: "admin" },
  "GET /v1/firstmeasure/admin/prices": { staff: "admin" },
  "POST /v1/firstmeasure/admin/prices/preview": { staff: "admin" },
  "PUT /v1/firstmeasure/admin/prices": { staff: "admin" }
});
