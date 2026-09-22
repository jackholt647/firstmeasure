/** Isolated local preview: fictional accounts/data and blocked provider traffic. */
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
const root = path.resolve(".tmp/integration-preview");
await mkdir(root, { recursive: true });
await writeFile(path.join(root, "no-provider-credentials.json"), JSON.stringify({ application: { internal_api_secret: "preview-internal-only" } }));
Object.assign(process.env, {
  FIRSTMATE_ENV: "test", NODE_ENV: "test", DEPLOYMENT_TOPOLOGY: "single",
  FIRSTMEASURE_DATABASE_MODE: "sqlite", DATABASE_URL: "", V1_HOST: "127.0.0.1", V1_PORT: "3101",
  PUBLIC_BASE_URL: "http://127.0.0.1:8011", CORS_ALLOWED_ORIGINS: "http://127.0.0.1:8011,http://localhost:8011",
  PLATFORM_HEARTBEAT_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", V1_WEB_WORKERS: "1",
  EMAIL_OUTBOUND_DISABLED: "1", STATS_SCHEDULER_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1",
  PROVIDER_KEYS_PATH: path.join(root, "no-provider-credentials.json"), V1_LOG_LEVEL: "warn",
  STRIPE_TEST_MODE: "1", STRIPE_TEST_SECRET_KEY: "sk_test_local_preview_fake",
  PLATFORM_SESSION_SECRET: "local-integration-preview-only"
});
for (const name of ["PLATFORM", "FIRSTMEASURE", "CRM", "INTERNAL", "PRICEBOOK", "MESSAGING", "CHANNELS", "CALLS", "CANVASSING", "WEATHER", "CODE_REPORT"]) {
  process.env[`${name}_STORAGE_ROOT`] = path.join(root, name.toLowerCase());
}
process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(root, "firstmeasure/index.sqlite");
const checkoutFixtures = new Map<string, any>();
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (["127.0.0.1", "localhost"].includes(url.hostname)) return originalFetch(input, init);
  if (url.hostname === "api.stripe.com") {
    if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") {
      const form = new URLSearchParams(String(init.body || ""));
      const id = `cs_test_local_${Date.now()}`;
      const metadata = Object.fromEntries([...form].filter(([key]) => key.startsWith("metadata[")).map(([key, value]) => [key.slice(9, -1), value]));
      const session = { id, object: "checkout.session", livemode: false, mode: "payment", payment_status: "unpaid",
        customer: "cus_local_preview", amount_total: Number(metadata.paid_dollars || 0) * 100, currency: "usd", metadata,
        success_url: String(form.get("success_url") || "").replace("{CHECKOUT_SESSION_ID}", id),
        url: `http://127.0.0.1:8011/v1/local-preview/checkout/${id}` };
      checkoutFixtures.set(id, session); return Response.json(session);
    }
    if (url.pathname.startsWith("/v1/checkout/sessions/")) {
      const session = checkoutFixtures.get(url.pathname.split("/").pop()!);
      return Response.json(session || { error: { message: "Local fixture session not found" } }, { status: session ? 200 : 404 });
    }
    if (url.pathname.startsWith("/v1/customers")) return Response.json({ id: "cus_local_preview", invoice_settings: {} });
    throw new Error(`Unmocked Stripe operation in local preview: ${url.pathname}`);
  }
  if (url.hostname === "maps.googleapis.com" && url.pathname.endsWith("/geocode/json")) {
    return Response.json({ status: "OK", results: [{ formatted_address: "123 Preview Lane, Seattle, WA", geometry: { location: { lat: 47.6101, lng: -122.3301 } } }] });
  }
  throw new Error(`External provider traffic is disabled in the integration preview (${url.hostname}).`);
}) as typeof fetch;
const { buildApp } = await import("../src/app.js");
const storage = await import("../platform/storage.js");
const app = await buildApp();
app.get("/v1/local-preview/checkout/:id", async (request, reply) => {
  const id = String((request.params as any).id), session = checkoutFixtures.get(id);
  if (!session) return reply.code(404).send({ error: "local_checkout_not_found" });
  return reply.type("text/html").send(`<!doctype html><meta charset="utf-8"><title>Local checkout rehearsal</title><h1>Local checkout rehearsal</h1><p>Fictional credit: $${session.amount_total / 100}. No payment provider is connected.</p><form method="post"><button>Simulate successful payment</button></form>`);
});
app.post("/v1/local-preview/checkout/:id", async (request, reply) => {
  const session = checkoutFixtures.get(String((request.params as any).id));
  if (!session) return reply.code(404).send({ error: "local_checkout_not_found" });
  session.payment_status = "paid";
  return reply.redirect(session.success_url);
});
app.addHook("onSend", async (request, reply, payload) => {
  if (reply.statusCode >= 400) console.warn("Preview request failed", JSON.stringify({
    method: request.method, path: request.url.split("?")[0], status: reply.statusCode,
    action: (request.body as any)?.action, hasCookie: !!request.headers.cookie,
    error: (() => { try { return JSON.parse(String(payload)).error; } catch { return "non-json"; } })()
  }));
  return payload;
});
await app.ready();
const email = "preview-owner@example.test", password = "LocalPreview123!";
let response = await app.inject({ method: "POST", url: "/v1/platform/auth/register", payload: { email, phone: "2025550177", password, name: "Preview Owner", company: "Preview Roofing" } });
if (response.statusCode === 409) response = await app.inject({ method: "POST", url: "/v1/platform/auth/login", payload: { email, password } });
if (response.statusCode >= 400) throw new Error(response.body);
const orgId = response.json().organization.id;
const cookies = String(response.headers["set-cookie"]);
const cookie = cookies.match(/fm_platform_session=[^;,]+/)![0]!;
const csrf = decodeURIComponent(cookies.match(/fm_platform_session_csrf=([^;,]+)/)![1]!);
const global = await storage.readGlobal(orgId);
if (!(global.data as any)?.preview_seeded) {
  await storage.saveGlobal(orgId, { data: { credits_balance: 100, onboarding_completed: true, preview_seeded: true } });
  for (const address of ["123 Preview Lane, Seattle, WA", "456 Test Avenue, Seattle, WA"]) {
    const ordered = await app.inject({ method: "POST", url: "/v1/platform/portal-action", headers: { cookie, "x-platform-csrf": csrf }, payload: {
      action: "queue", actor_email: email, actor_name: "Preview Owner", actor_org_id: orgId,
      address, project_type: "residential", report_mode: "full", pins: JSON.stringify([{ lat: 47.6101, lng: -122.3301 }])
    }});
    if (ordered.statusCode >= 400) throw new Error(ordered.body);
  }
}
// Rehearsal controls affect only this explicitly isolated fictional workspace.
const balanceArg = process.argv.find(value => value.startsWith("--balance="));
if (balanceArg) await storage.saveGlobal(orgId, { data: { credits_balance: Number(balanceArg.split("=")[1]) } });
if (process.argv.includes("--expanded") || process.argv.includes("--firstmeasure-only")) {
  const { saveCapabilityValues } = await import("../platform/capabilities.js");
  await saveCapabilityValues(orgId, { "platform.expanded_access": process.argv.includes("--expanded"), "platform.more_apps": false });
}
if (process.argv.includes("--ready-report")) {
  const fm = await import("../firstmeasure/storage.js");
  const fixture = (await fm.listProjectManifests()).find(item => String(item.address).startsWith("456 Test Avenue"));
  if (!fixture) throw new Error("The fictional delivered-report fixture is missing.");
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create(); pdf.addPage().drawText("Fictional local report - integration rehearsal", { x: 40, y: 700, size: 16 });
  const bytes = await pdf.save();
  await fm.saveStoredPdf(String(fixture.id), "main", bytes);
  await fm.saveStoredPdf(String(fixture.id), "summary", bytes);
  await fm.saveStoredXml(String(fixture.id), '<ROOT><POINTS><POINT id="P1" data="0,0,0"/><POINT id="P2" data="10,0,0"/></POINTS><LINES><LINE id="L1" type="EAVE" path="P1,P2"/></LINES><FACES><FACE id="F1" type="ROOF" area="1000" pitch="6"/></FACES></ROOT>');
  await fm.patchManifest(String(fixture.id), { status: "completed", report_release_hold_enabled: false, report_due_window_start: null, report_due_window_end: null, timestamps: { completed_at: new Date().toISOString(), updated_at: new Date().toISOString() } });
}
if (process.argv.includes("--rejected-report")) {
  const fm = await import("../firstmeasure/storage.js");
  const fixture = (await fm.listProjectManifests()).find(item => String(item.address).startsWith("123 Preview Lane"));
  if (!fixture) throw new Error("The fictional rejection fixture is missing.");
  await fm.patchManifest(String(fixture.id), { status: "rejected", rejection_reason: "incorrect_structure_type", correct_project_type: "commercial", customer_rejection_message: "Local mobile QA: this structure requires a commercial report.", timestamps: { updated_at: new Date().toISOString() } });
}
await app.listen({ host: "127.0.0.1", port: 3101 });
console.log(`Isolated preview ready. Portal http://127.0.0.1:8011/portal/; fictional login ${email} / ${password}`);
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => void app.close().then(() => process.exit(0)));
