/**
 * Who may call each `/v1/firstmeasure` route
 * (docs/architecture/request-security.md#route-access-declarations).
 *
 * Customers reach only the routes their apps call, and `firstmeasure/access.ts`
 * then limits them to their own organization's projects. Everything else is
 * staff work or our own service code (`"service"`: in-process calls the
 * platform makes after authorizing the customer itself). Callers per route
 * were inventoried on 2026-10-24; routes nothing calls are admin-only until a
 * caller needs them.
 */
import { registerRouteAccessTable, type RouteAccess } from "../platform/security/route-access.js";

const P = "/v1/firstmeasure";
const any: RouteAccess = { staff: "any" };
const qa: RouteAccess = { staff: "qa" };
const manager: RouteAccess = { staff: "manager" };
const admin: RouteAccess = { staff: "admin" };
const customer: RouteAccess = "customer_or_staff";
const service: RouteAccess = "service";
/** Thumbnails and report files: a signed link or a session that may read the project. */
export const SIGNED_FILE_ACCESS: RouteAccess = { public: "customer file: needs a signed link or a session that may read the project (firstmeasure/access.ts)" };

const entries: Record<string, RouteAccess> = {
  "GET /": admin,
  "GET /ping": { public: "liveness check used by deploy scripts" },
  "GET /health/background": { public: "worker liveness check used by deploy scripts" },
  "POST /echo": admin,
  "GET /report-expedite-options": { public: "turnaround prices; quotes for a property still require a session (rate-limit hook)" },
  "POST /report-expedite-options": any,
  "POST /admin/index-status": admin,
  "POST /admin/reindex": admin,
  "POST /admin/jobs/status": admin,
  "POST /admin/jobs/enqueue-stress": admin,
  "POST /admin/jobs/:id": admin,
  "GET /rush/current": any,
  "POST /admin/rush-modes/list": admin,
  "POST /admin/rush-modes": admin,
  "POST /admin/rush-modes/automation": admin,
  "POST /admin/rush-modes/automation/update": admin,
  "POST /ai/gemini-image": any,
  "GET /apple-key": any,
  "POST /apple-key": admin,
  "POST /apple-key/ingest": { public: "Apple key harvester: the handler requires its ingest token or a staff admin session" },

  // Full House drafts keep their own HMAC/session gate (firstmeasure/full_house.ts).
  "GET /internal-exteriors/capability": any,
  "GET /internal-exteriors/projects": any,
  "POST /internal-exteriors/projects": any,

  // Ordering: customers order through the platform (portal-action), which
  // charges and then queues as the service.
  "POST /projects/queue": any,
  "POST /projects": service,
  "POST /instants": service,

  // Lists and search: customers are limited to their organization in SQL.
  "POST /projects/list": customer,
  "GET /projects": any,
  "POST /projects/query": any,
  "POST /projects/find-by-address": any,

  // One project. A customer reaches only their organization's projects.
  "GET /projects/:id": customer,
  "PATCH /projects/:id": customer,
  "POST /projects/:id/status": any,
  "GET /projects/:id/instant": customer,
  "GET /instants/:id": customer,
  "POST /projects/:id/instant/ensure": customer,
  "POST /instants/:id/ensure": customer,
  "POST /projects/:id/instant/pdf": customer,
  "POST /instants/:id/pdf": customer,
  "POST /projects/:id/instant/refund": service,
  "POST /projects/:id/weather/order": customer,
  "GET /projects/:id/exterior-measurements": customer,
  "GET /projects/:id/exterior-model": customer,
  "GET /projects/:id/exterior-design": customer,
  "PUT /projects/:id/exterior-design": customer,
  "GET /projects/:id/thumbnail": SIGNED_FILE_ACCESS,
  "GET /projects/:id/artifacts/:name": SIGNED_FILE_ACCESS,
  "GET /projects/:id/pdf": customer,
  "GET /projects/:id/pdfs/report": customer,
  "GET /projects/:id/artifacts": any,
  "POST /projects/:id/artifacts": any,
  "GET /projects/:id/app-metadata": any,
  "PUT /projects/:id/app-metadata": admin,
  "GET /projects/:id/pdf-state": any,
  "PUT /projects/:id/pdf-state": any,
  "GET /projects/:id/branding-defaults": any,
  "PUT /projects/:id/branding-defaults": admin,
  "GET /projects/:id/xml": any,
  "GET /projects/:id/previous-report-candidate": any,

  // Editor and production.
  "GET /projects/:id/editor": any,
  "GET /projects/:id/editor/feedback": any,
  "GET /projects/:id/editor/pdf-state": any,
  "POST /projects/:id/editor/save": any,
  "POST /projects/:id/editor/qa-thread-drafts": any,
  "POST /projects/:id/editor/presence": any,
  "GET /projects/:id/google-3d/manifest.json": any,
  "GET /projects/:id/google-3d/tiles/:name": any,
  "POST /projects/:id/google-3d/capture": any,
  "POST /projects/:id/mask/ensure": any,
  "POST /projects/:id/process/imagery": any,
  "POST /projects/:id/process/mask": admin,
  "POST /projects/:id/process/insights": admin,
  "POST /projects/:id/pdfs/generate": any,
  "POST /projects/:id/pdfs/sync": any,
  "POST /projects/:id/pdfs/sync/uploads": any,
  "POST /projects/:id/pdfs/sync/uploads/:uploadId/chunks/:chunkIndex": any,
  "POST /projects/:id/pdfs/sync/uploads/:uploadId/complete": any,
  "GET /projects/:id/pdfs/sync/:jobId": any,
  "POST /projects/:id/pdfs/sync/:jobId/client-checksums": any,
  "GET /projects/:id/pdfs/runtime": any,
  "POST /projects/:id/pdfs/generate/server": admin,
  "POST /projects/:id/pdfs/preview": admin,
  "POST /projects/:id/pdf/assemble": admin,
  "POST /projects/:id/pdfs/report/assemble": admin,
  "POST /projects/:id/xml/assemble": admin,
  "POST /projects/:id/render/report": admin,
  "POST /projects/:id/render/pdf": admin,
  "POST /projects/:id/render/pages": admin,
  "POST /projects/:id/render/page": admin,
  "POST /render/report": admin,
  "POST /render/pdf": admin,
  "POST /render/page": admin,

  // Static report runtime for the editor, the settings preview and headless rendering.
  "GET /pdf-runtime/manifest": { public: "report renderer file list (static)" },
  "GET /pdf-runtime/blank": { public: "report renderer page (static)" },
  "GET /pdf-runtime/assets/:asset": { public: "report renderer scripts (static, allowlisted)" },
  "GET /pdf-runtime/fonts/:name": { public: "report fonts (static, allowlisted)" },
  "GET /pdf-runtime/images/:name": { public: "report default images (static, allowlisted)" },

  // Queue and QA.
  "POST /queue/status": any,
  "POST /queue/status/compat": any,
  "POST /queue/claim-next": admin,
  "POST /queue/claim-next/compat": any,
  "POST /queue/admin/overview": any,
  "POST /queue/admin/overview/compat": any,
  "POST /queue/counts": any,
  "POST /queue/bucket": any,
  "GET /queue/changes": admin,
  "POST /queue/changes": admin,
  "POST /status/snapshot": any,
  "POST /portal/heartbeat": admin,
  "POST /projects/:id/queue/reserve": any,
  "POST /projects/:id/queue/claim": any,
  "POST /projects/:id/queue/release-reservation": any,
  "POST /projects/:id/queue/release-assignment": manager,
  "POST /projects/:id/vip": manager,
  "POST /projects/:id/expedited": manager,
  "POST /projects/:id/priority-flag": manager,
  "POST /projects/:id/qa/priority": manager,
  "POST /projects/:id/coverage/reject": qa,
  "POST /projects/:id/coverage/push-forward": qa,
  "POST /projects/:id/requeue/send-to-queue": qa,
  "POST /projects/:id/requeue/force": manager,
  "POST /projects/:id/force-kick/status": any,
  "POST /projects/:id/force-kick/acknowledge": any,
  "POST /projects/:id/afk-kick": manager,
  "POST /qa/session/heartbeat": any,
  "POST /qa/session/release": any,
  "POST /qa/me/status": any,
  "POST /qa/bootstrap": any,
  "POST /qa/leaderboard": any,
  "POST /qa/queue/peek": any,
  "POST /qa/queue/pull": any,
  "POST /qa/bulk-approve": admin,
  "POST /qa/reservation/users": any,
  "POST /projects/:id/qa/reservation": any,
  "POST /projects/:id/qa/claim": any,
  "POST /projects/:id/qa/release-claim": any,
  "POST /projects/:id/qa/decision": any,
  "POST /projects/:id/manager/decision": any,
  "POST /projects/:id/drafter/qa-response": any,
  "GET /projects/:id/email/status": any,
  "POST /projects/:id/email/send-report": qa,
  "POST /projects/:id/release/force": manager,
  "POST /projects/:id/email/send-rejection": qa
};

registerRouteAccessTable({
  [`GET ${P}`]: admin,
  ...Object.fromEntries(Object.entries(entries).map(([route, access]) => {
    const [method, url] = route.split(" ");
    return [`${method} ${P}${url === "/" ? "" : url}`, access];
  }))
});
