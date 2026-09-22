import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

/**
 * Paper contract upload: template-driven and free-form ingestion, reviewer
 * confirm (which re-records outputs through the standard machinery so
 * document.signed fires), field-definition editing on uploads, and
 * save-as-upload-template. AI extraction falls back to heuristics here (no
 * API key in tests) — the review flow is exactly the manual-edit path.
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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-paper-upload-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.DOCUMENT_AI_DISABLED = "1";
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
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

// A 1x1 white JPEG — enough for the media store; extraction is heuristic here.
const TINY_JPEG_BASE64 = "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

async function registerOrg(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `paper-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Paper Owner",
    company: "Paper Upload Test Org",
    organization_id: `org_paper_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id, { "platform.documents": true, "documents.ingestion": true, "documents.templates_studio": true });
  return { orgId: data.organization.id as string };
}

async function createProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "9 Scan Street",
      title: "Paula Paper",
      project_type: "residential",
      contacts: [{ name: "Paula Paper", email: "paula@example.test", primary: true }],
      photos: []
    },
    metadata: { kind: "platform_project" }
  });
}

test("template-driven paper upload: declared fields, review edits, confirm fires document.signed", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_paper_template";
  await createProject(client, orgId, projectId);
  await client.request("GET", `/v1/documents/organizations/${orgId}/catalog`);

  // The seeded roofing paper-upload template is listed with intake:"upload".
  const templates = await client.request("GET", `/v1/documents/organizations/${orgId}/templates`);
  const uploadTemplate = (templates.templates || []).find((tpl: any) => tpl.id === "tpl_roofing_paper_upload");
  assert.ok(uploadTemplate, "roofing paper-upload template seeded");
  assert.equal(uploadTemplate.metadata.intake, "upload");

  // Upload against it: the instance carries EXACTLY the template's fields.
  const ingested = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/ingest`, {
    file_name: "signed-roofing-contract.jpg",
    data_base64: TINY_JPEG_BASE64,
    project_id: projectId,
    template_id: "tpl_roofing_paper_upload"
  });
  const documentId = String(ingested.document.id);
  assert.equal(ingested.document.status, "needs_review");
  assert.equal(ingested.document.document_type, "contract");
  assert.equal(ingested.document.template_ref.template_id, "tpl_roofing_paper_upload");
  assert.equal(ingested.document.metadata.intake, "upload");
  assert.ok(ingested.document.param_defs.shingle_selection, "template fields land on the instance");
  assert.equal(ingested.document.output_defs.sig_customer.required, true);

  // Reviewer fills what the (disabled) agent could not, then confirms with a
  // verified customer signature from the paper.
  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/upload-fields`, {
    params: {
      customer_name: "Paula Paper",
      contract_date: "2026-07-28",
      shingle_selection: "Duration Storm — Onyx Black",
      total_cents: 1885000,
      deposit_cents: 500000
    }
  });
  const confirmed = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/confirm-upload`, {
    outputs: {
      sig_customer: { type: "wet_ink", signer_name: "Paula Paper", text: "Paula Paper", signed_at: "2026-07-28" }
    }
  });
  assert.equal(confirmed.document.status, "completed", "confirmed signature completes the contract (no payment gate)");
  assert.equal(confirmed.document.params.shingle_selection, "Duration Storm — Onyx Black");
  assert.ok(confirmed.document.metadata.upload_review.confirmed_at, "review sign-off recorded");
  assert.equal(confirmed.document.outputs.sig_customer.evidence.capture_mode, "imported");

  const events = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}/events`);
  const types = events.events.map((event: any) => event.type);
  assert.ok(types.includes("document.ingested"), "ingest event recorded");
  assert.ok(types.includes("document.signed"), "confirm re-records the signature through the standard machinery");
  assert.ok(types.includes("document.upload.confirmed"), "confirmation audit event recorded");
});

test("free-form paper upload: manual fields, reject a detected signature, save as upload template", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_paper_freeform";
  await createProject(client, orgId, projectId);
  await client.request("GET", `/v1/documents/organizations/${orgId}/catalog`);

  // Free-form: no template — heuristics classify from the filename.
  const ingested = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/ingest`, {
    file_name: "old-agreement-scan.jpg",
    data_base64: TINY_JPEG_BASE64,
    project_id: projectId,
    document_type: "contract",
    title: "Legacy HVAC Agreement"
  });
  const documentId = String(ingested.document.id);
  assert.equal(ingested.document.status, "needs_review");

  // Add custom fields manually (the "upload without a template" path).
  const withFields = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/upload-fields`, {
    param_defs: {
      customer_name: { type: "string", label: "Customer name", required: true },
      system_tonnage: { type: "number", label: "System tonnage" },
      agreement_total_cents: { type: "currency", label: "Agreement total" }
    },
    output_defs: {
      sig_customer: { type: "signature", required: true, signer: "customer", label: "Customer signature" }
    },
    params: { customer_name: "Paula Paper", system_tonnage: 3, agreement_total_cents: 942500 }
  });
  assert.equal(withFields.document.param_defs.system_tonnage.type, "number");

  // Field edits are rejected for generated (non-uploaded) documents.
  const generated = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "contract",
    title: "Generated Contract",
    params: { body: "terms", effective_date: "2026-08-01" }
  });
  const rejected = await client.raw("POST", `/v1/documents/organizations/${orgId}/documents/${generated.document.id}/upload-fields`, {
    params: { body: "sneaky" }
  });
  assert.equal(rejected.statusCode, 400, "generated documents cannot edit field definitions");

  // Confirm as NOT signed (outputs.sig_customer: null rejects any detection):
  // the upload becomes a live issued document instead of a signed one.
  const confirmed = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${documentId}/confirm-upload`, {
    outputs: { sig_customer: null }
  });
  assert.equal(confirmed.document.status, "issued", "unsigned upload confirms to issued, not signed");
  const events = await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${documentId}/events`);
  assert.ok(!events.events.some((event: any) => event.type === "document.signed"), "no signature event without a confirmed signature");

  // Save the field contract as a reusable upload template.
  const saved = await client.request("POST", `/v1/documents/organizations/${orgId}/templates/upload-intake/from-document/${documentId}`, {
    name: "HVAC Agreement — Paper Upload"
  });
  assert.equal(saved.template.metadata.intake, "upload");

  // Drafting endpoint returns the fallback schema when AI is disabled.
  const draft = await client.request("POST", `/v1/documents/organizations/${orgId}/templates/upload-intake/draft`, {
    file_name: "example-contract.jpg",
    data_base64: TINY_JPEG_BASE64
  });
  assert.ok(draft.draft.params.customer_name, "draft carries starter fields");
  assert.ok(draft.draft.definition.pages, "draft includes a ready-to-create definition");

  // A new upload against the saved template inherits its fields.
  const reIngested = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/ingest`, {
    file_name: "another-agreement.jpg",
    data_base64: TINY_JPEG_BASE64,
    project_id: projectId,
    template_id: String(saved.template.id)
  });
  assert.ok(reIngested.document.param_defs.system_tonnage, "saved template drives the next upload's fields");
});
