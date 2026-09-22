import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Kitchen Remodel end-to-end: the allowance/selections self-serve upsell loop.
 *
 *  1. Instantiating the kitchen_remodel scope issues the base estimate
 *     (document-only, allowances as line items) to the portal.
 *  2. The customer signs it → deposit/draw/final receivables mint, the
 *     contract node completes, and the selections workflow-document issues.
 *  3. The customer picks upgrade materials → the AUTHORITATIVE total becomes
 *     the upgrade delta (allowance standards price at $0).
 *  4. Signing the selections appends the delta to receivables (change-order
 *     append) and unblocks the Finishes stage once construction is done.
 */

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""]
        .filter(Boolean)
        .join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    let data: any = null;
    try { data = response.body ? JSON.parse(response.body) : null; } catch { data = null; }
    return { statusCode: response.statusCode, body: response.body, data };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-kitchen-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8").catch(() => "");
  if (!appSource.includes("registerDocumentsApi")) {
    const { registerDocumentsApi } = await import("../documents/api.js");
    await app.register(registerDocumentsApi, { prefix: "/v1/documents" });
  }
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const [{ closeWorkDatabase }] = await Promise.all([import("../work/storage.js")]);
  (await closeWorkDatabase());
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

test("kitchen remodel: allowance estimate → customer selections → delta receivables → gated finishes", async () => {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const orgId = `org_kitchen_${suffix}`;
  await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `kitchen-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Kitchen Owner",
    company: "Kitchen Test Org",
    organization_id: orgId
  });
  await enableExpandedPlatformFixture(orgId);

  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: { app_flags: { platform: { expanded_access: true, money: true, proposals: true, documents: true, customer_portal: true }, customer_portal: { payments: true } } }
  }, { replace: false });

  const projectId = "project_kitchen";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      title: "Jane Homeowner",
      address: "42 Remodel Road",
      project_type: "residential",
      contacts: [{ id: "contact_jane", name: "Jane Homeowner", email: "jane@example.test", phone: "555-111-2222", primary: true }],
      photos: []
    },
    metadata: { kind: "platform_project" }
  });

  // Force the document seed pass (templates + workflows) before automations run.
  await client.request("GET", `/v1/documents/organizations/${orgId}/catalog`);

  // Instantiate the preset the same way Add Work / scope transitions do.
  const { readScopeTemplate } = await import("../scopes/storage.js");
  const { instantiateScopeTemplateWorkPlan } = await import("../scopes/service.js");
  const template = (await readScopeTemplate(orgId, "default", "kitchen_remodel"));
  assert.ok(template, "kitchen_remodel preset is seeded");
  await instantiateScopeTemplateWorkPlan(orgId, {
    project_id: projectId,
    branch_id: "default",
    template,
    source_type: "test",
    source_id: "kitchen",
    source_key: `kitchen:${projectId}`
  });

  // --- 1. The base estimate was issued to the portal --------------------------
  const docs1 = await client.request("GET", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`);
  const estimateRef = (docs1.documents || []).find((doc: any) => doc.title === "Kitchen Remodel Estimate");
  assert.ok(estimateRef, "base estimate issued on instantiation");
  const estimate = (await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${estimateRef.id}`)).document;
  assert.equal(estimate.status, "sent", "estimate delivered to the portal");
  const estimateToken = String(estimate.delivery.public_token);
  assert.ok(estimateToken, "estimate has a public token");
  assert.ok(!(docs1.documents || []).some((doc: any) => doc.title === "Kitchen Finish Selections"),
    "selections are NOT issued before the contract is signed");

  // Base total: $16,600 base scope + $7,800 allowances = $24,400.
  const estimatePricing = await client.request("POST", `/v1/documents/public/${estimateToken}/pricing`, {});
  assert.equal(estimatePricing.totals.total_cents, 2_440_000, "allowances price into the base estimate");

  // --- 2. Customer signs the estimate ----------------------------------------
  const signedEstimate = await client.request("POST", `/v1/documents/public/${estimateToken}/outputs/sig_customer`, {
    value: { type: "typed", text: "Jane Homeowner", signer_name: "Jane Homeowner" }
  });
  assert.equal(signedEstimate.document.status, "signed", "estimate signed (deposit still outstanding)");

  const { listProjectObligations } = await import("../payments/storage.js");
  const baseObligations = await listProjectObligations(orgId, projectId);
  const cents = (row: any) => Number(row.amount_cents || 0);
  assert.equal(baseObligations.reduce((sum: number, row: any) => sum + cents(row), 0), 2_440_000,
    "signing mints the full base schedule");
  assert.ok(baseObligations.some((row: any) => cents(row) === 732_000), "30% deposit obligation exists");
  assert.ok(baseObligations.some((row: any) => cents(row) === 976_000), "40% rough-in draw exists");

  // --- 3. Signing completed the contract node and issued the selections ------
  const docs2 = await client.request("GET", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`);
  const selectionsRef = (docs2.documents || []).find((doc: any) => doc.title === "Kitchen Finish Selections");
  assert.ok(selectionsRef, "selections document issued once the estimate is signed");
  const selections = (await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${selectionsRef.id}`)).document;
  assert.equal(selections.document_type, "change_order");
  const selectionsToken = String(selections.delivery.public_token);
  assert.ok(selectionsToken, "selections delivered to the portal");

  const nodes1 = await client.request("GET", `/v1/work/organizations/${orgId}/nodes?project_id=${projectId}`);
  const nodeByTemplate = (id: string) => (nodes1.nodes || []).find((node: any) => node.template_node_id === id);
  assert.equal(nodeByTemplate("kitchen_send_estimate")?.status, "completed", "estimate node completed by document.signed");

  // Customer-facing workflow hides the internal prep step.
  const publicWorkflow = await client.request("GET", `/v1/documents/public/${selectionsToken}/workflow`);
  const stepIds = (publicWorkflow.workflow.steps || []).map((step: any) => step.id);
  assert.deepEqual(stepIds, ["st_choose", "st_review", "st_sign"], "customer sees choose → review → sign");

  // Standard selections price at $0 before any upgrade.
  const beforeUpgrade = await client.request("POST", `/v1/documents/public/${selectionsToken}/pricing`, {});
  assert.equal(beforeUpgrade.totals.total_cents, 0, "allowance-standard selections cost nothing");

  // --- 4. Customer upsells themselves ----------------------------------------
  await client.request("POST", `/v1/documents/public/${selectionsToken}/outputs/selections`, {
    value: {
      selections: {
        grp_flooring: "floor_walnut",     // +$2,400
        grp_counters: "counter_quartz",   // +$1,650
        extra_pot_filler: true            // +$780
      }
    }
  });
  const afterUpgrade = await client.request("POST", `/v1/documents/public/${selectionsToken}/pricing`, {});
  assert.equal(afterUpgrade.totals.total_cents, 483_000, "authoritative total is the upgrade delta ($4,830)");

  // --- 5. Signing the selections appends the delta and completes the node ----
  const signedSelections = await client.request("POST", `/v1/documents/public/${selectionsToken}/outputs/sig_customer`, {
    value: { type: "typed", text: "Jane Homeowner", signer_name: "Jane Homeowner" }
  });
  assert.equal(signedSelections.document.status, "completed", "selections complete on signature (payment gate removed)");

  const withDelta = await listProjectObligations(orgId, projectId);
  assert.equal(withDelta.reduce((sum: number, row: any) => sum + cents(row), 0), 2_440_000 + 483_000,
    "selection delta APPENDS to receivables; base schedule untouched");
  assert.ok(withDelta.some((row: any) => cents(row) === 483_000), "the $4,830 selections adjustment exists");

  const nodes2 = await client.request("GET", `/v1/work/organizations/${orgId}/nodes?project_id=${projectId}`);
  const nodeAfter = (id: string) => (nodes2.nodes || []).find((node: any) => node.template_node_id === id);
  assert.equal(nodeAfter("kitchen_collect_selections")?.status, "completed", "selections node completed by document.signed");
  assert.notEqual(nodeAfter("kitchen_install_finishes")?.status, "ready",
    "finishes stay blocked until construction completes");

  // --- 6. Finish construction → Finishes unblocks -----------------------------
  for (const templateNodeId of ["kitchen_demo", "kitchen_rough_in", "kitchen_drywall"]) {
    const node = nodeAfter(templateNodeId) || nodeByTemplate(templateNodeId);
    assert.ok(node, `${templateNodeId} exists`);
    await client.request("POST", `/v1/work/organizations/${orgId}/nodes/${node.id}/transition`, { status: "completed" });
  }
  const nodes3 = await client.request("GET", `/v1/work/organizations/${orgId}/nodes?project_id=${projectId}`);
  const finishes = (nodes3.nodes || []).find((node: any) => node.template_node_id === "kitchen_install_finishes");
  assert.ok(["ready", "active"].includes(String(finishes?.status)), "finish work unblocked after selections + construction");
});
