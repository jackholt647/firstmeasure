import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores, operatorFixtureClient } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

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
    return await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""]
        .filter(Boolean)
        .join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-documents-test-"));
  process.env.NODE_ENV = "test";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  // The documents API is mounted centrally by the integrator in src/app.ts;
  // until that lands the test registers the plugin itself.
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8").catch(() => "");
  const alreadyMounted = appSource.includes("registerDocumentsApi");
  if (!alreadyMounted) {
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

async function registerOrg(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Documents Test Org",
    organization_id: `org_documents_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  const orgId = data.organization.id as string;
  await (await operatorFixtureClient(app, orgId)).request("PUT", `/v1/platform/organizations/${orgId}/capabilities`, {
    values: {
      "platform.documents": true,
      "documents.templates_studio": true,
      "documents.workflow_authoring": true,
      "documents.theme_authoring": true,
      "documents.advanced_definition_editing": true,
      "documents.custom_folders": true,
      "documents.designer_profile": true,
      "documents.esign": true,
      "documents.payments": true,
      "documents.agent": true,
      "documents.ingestion": true,
      "platform.customer_portal": true,
      "customer_portal.payments": true,
      "platform.money": true,
      "money.take_payment": true
    }
  });
  return { orgId, userId: String(data.user.id) };
}

async function createProject(client: ReturnType<typeof createSessionClient>, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "100 Document Lane",
      title: "Jane Homeowner",
      project_type: "residential",
      contacts: [{ name: "Jane Homeowner", email: "jane@example.test", phone: "555-111-2222" }],
      photos: []
    },
    metadata: { kind: "platform_project" }
  });
}

test("signing: assigned signers, immutable revisions, concurrent receipts, executed PDF, stale links and feature gates", async () => {
  const client = createSessionClient(), { orgId, userId } = await registerOrg(client);
  await createProject(client, orgId, "signing_project");
  const storage = await import("../documents/storage.js"), store = await import("../documents/signing/store.js");
  const invokeUrl = `/v1/publication/organizations/${orgId}/actions/invoke`;
  const draftRequest = { action: "documents.instance.create", target: { scope:"project",organizationId:orgId,projectId:"signing_project" }, input:{values:{document_type:"contract",params:{body:"Generated by a bounded workflow"}}}, idempotencyKey:"generated-contract" };
  const generated = await client.request("POST",invokeUrl,draftRequest);
  assert.ok(generated.value.document.id);
  assert.equal((await client.request("POST",invokeUrl,draftRequest)).receipt.replayed,true);
  const sendRequest = { action:"documents.instance.send",target:{scope:"organization",organizationId:orgId,id:generated.value.document.id},input:{recipients:[{signer_id:"customer",name:"Alice",email:"alice@example.test"}],consent_contact:"support@example.test"},idempotencyKey:"generated-send" };
  const dispatched = await client.request("POST",invokeUrl,sendRequest);
  assert.ok(dispatched.value.signing_package_id);
  assert.equal(dispatched.value.signing,undefined,"programmable actions do not expose signing tokens");
  assert.equal((await client.request("POST",invokeUrl,sendRequest)).receipt.replayed,true);
  assert.equal((await store.packagesForDocument(orgId,generated.value.document.id)).length,1);
  const generatedStatus = await client.request("POST",invokeUrl,{action:"documents.signing.status",target:sendRequest.target,input:{}});
  assert.equal(generatedStatus.value.status,"open");
  assert.equal(generatedStatus.value.signers[0].email,undefined);
  const identityStore = await import("../platform/storage.js");
  const ownerBefore = await identityStore.readDocument(orgId,"users",userId);
  await identityStore.upsertDocument(orgId,"users",{id:userId,data:{permission_overrides:{...((ownerBefore.data as any).permission_overrides || {}),issue_documents:false}}});
  const deniedSend = await client.raw("POST",invokeUrl,{...sendRequest,idempotencyKey:"denied-send"});
  assert.equal(deniedSend.statusCode,403);
  await identityStore.upsertDocument(orgId,"users",{id:userId,data:{permission_overrides:(ownerBefore.data as any).permission_overrides || {}}});
  const create = async (defs?: any, recipients?: any[]) => {
    const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/signing_project/documents`, { document_type: "contract", params: { body: "Immutable agreement", effective_date: "2026-09-26" } });
    const id = created.document.id;
    if (defs) await storage.saveDocumentInstance(orgId, id, { ...created.document, output_defs: defs });
    const sent = await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${id}/send`, { recipients: recipients || [{ name: "Alice", email: "alice@example.test", role: "customer" }, ...(defs?.sig_b ? [{ name: "Bob", email: "bob@example.test", signer_id: "second" }] : [])], consent_contact: "support@example.test" });
    return { id, ...sent };
  };
  const prepare = (t: string) => client.request("POST", `/v1/documents/public/${t}/signing/prepare`, {});
  const payload = (r: any, name: string) => ({ value: { type: "typed", signer_name: name, signed_at: "1900-01-01" }, challenge: r.challenge, content_hash: r.content_hash, consent: { intent: true, electronic_records: true, can_access_and_retain: true, disclosure_hash: r.disclosure.hash } });
  const doc = await create({ sig_customer: { type: "signature", signer_id: "customer", required: true }, sig_b: { type: "signature", signer_id: "second", required: true } });
  const a = doc.signing.invitations.find((i: any) => i.signer_id === "customer").token, b = doc.signing.invitations.find((i: any) => i.signer_id === "second").token;
  assert.notEqual(a, b);
  assert.equal((await client.raw("POST", `/v1/documents/public/${doc.snapshot.public_token}/signing/prepare`, {})).statusCode, 403);
  const ar = await prepare(a), br = await prepare(b), ap = payload(ar, "Alice"), bp = payload(br, "Bob");
  assert.equal(ar.content_hash, br.content_hash);
  const base = `/v1/documents/public/${a}/outputs/sig_customer`;
  assert.equal((await client.raw("POST", base, { ...ap, consent: {} })).statusCode, 400);
  assert.equal((await client.raw("POST", base, { ...ap, value: { type: "drawn", signer_name: "Alice", image_data: "invalid" } })).statusCode, 400);
  assert.equal((await client.raw("POST", `/v1/documents/public/${a}/outputs/sig_b`, ap)).statusCode, 403);
  const beforePdf = await client.raw("GET", `/v1/documents/public/${a}/pdf`); assert.equal(beforePdf.statusCode, 200);
  assert.notEqual((await client.request("POST", base, ap)).document.status, "completed");
  assert.equal((await client.raw("PATCH", `/v1/documents/organizations/${orgId}/documents/${doc.id}`, { params: { body: "Changed" } })).statusCode, 409);
  await Promise.all([client.request("POST", base, ap), client.request("POST", `/v1/documents/public/${b}/outputs/sig_b`, bp)]);
  const retained = await storage.readDocumentInstance(orgId, doc.id);
  assert.equal(retained.status, "completed");
  assert.equal((retained.outputs as any).sig_customer.signer_name, "Alice"); assert.equal((retained.outputs as any).sig_b.signer_name, "Bob");
  assert.notEqual((retained.outputs as any).sig_customer.signed_at, "1900-01-01");
  assert.equal((await client.raw("POST", base, { ...ap, value: { text: "Mallory" } })).statusCode, 409);
  assert.equal((await client.raw("POST", base, { value: {} })).statusCode, 400);
  const afterPdf = await client.raw("GET", `/v1/documents/public/${a}/pdf`);
  assert.equal(afterPdf.statusCode, 200); assert.notDeepEqual(afterPdf.rawPayload, beforePdf.rawPayload);
  const pkg = await store.packageForSnapshot(orgId, doc.snapshot.id); assert.equal(Object.keys(pkg!.receipts).length, 2); assert.ok(pkg!.final_pdf_hash);
  await assert.rejects(storage.saveDocumentInstance(orgId, doc.id, { ...retained, params: { body: "Adapter bypass" } }), { code: "document_locked_signed" });
  await assert.rejects(storage.saveDocumentInstance(orgId, doc.id, { ...retained, outputs: {} }), { code: "signature_immutable" });
  const { PDFDocument, PDFRawStream } = await import("pdf-lib");
  const reviewPdf = await PDFDocument.load(beforePdf.rawPayload), executedPdf = await PDFDocument.load(afterPdf.rawPayload);
  assert.ok(executedPdf.getPageCount() > reviewPdf.getPageCount());
  const streams = (pdf: any, page: any) => { const contents = page.node.Contents(); const refs = contents?.asArray ? contents.asArray() : [contents]; return refs.map((r: any) => pdf.context.lookup(r)).filter((s: any) => s instanceof PDFRawStream).map((s: any) => Buffer.from(s.getContents()).toString("base64")); };
  reviewPdf.getPages().forEach((page, n) => { for (const stream of streams(reviewPdf,page)) assert.ok(streams(executedPdf,executedPdf.getPage(n)).includes(stream), "accepted page content stream is retained verbatim"); });
  const events = (await client.request("GET", `/v1/documents/organizations/${orgId}/documents/${doc.id}/events`)).events;
  assert.equal(events.filter((e: any) => e.type === "document.signed").length, 1);
  const parallel = await create({ sig_customer: { type: "signature", required: true }, sig_b: { type: "signature", signer_id: "second", required: true } });
  const parallelInvites = parallel.signing.invitations.filter((i: any) => i.email);
  const parallelReviews = await Promise.all(parallelInvites.map((i: any) => prepare(i.token)));
  await Promise.all(parallelInvites.map((i: any, n: number) => client.request("POST", `/v1/documents/public/${i.token}/outputs/${i.signer_id === "customer" ? "sig_customer" : "sig_b"}`, payload(parallelReviews[n],i.name))));
  assert.equal(Object.keys((await store.packageForSnapshot(orgId,parallel.snapshot.id))!.receipts).length, 2);
  const ordered = await create({ sig_customer: { type: "signature", required: true }, sig_b: { type: "signature", signer_id: "second", signing_order: 1, required: true } });
  const second = ordered.signing.invitations.find((i: any) => i.signer_id === "second");
  assert.equal((await client.raw("POST", `/v1/documents/public/${second.token}/signing/prepare`, {})).statusCode,403);
  const decline = await client.request("POST", `/v1/documents/public/${ordered.signing.invitations[0].token}/signing/decline`, { reason: "Paper process requested" }); assert.equal(decline.status,"declined");
  const internal = await create({ sig_customer: { type: "signature", signer: "internal", signer_id: "company", required: true } }, [{ signer_id: "company", user_id: userId, name: "Owner User" }]);
  const internalBase = `/v1/documents/organizations/${orgId}/documents/${internal.id}`;
  const ir = await client.request("POST", `${internalBase}/signing/prepare`, { signer_id: "company" });
  assert.equal((await client.request("POST", `${internalBase}/outputs/sig_customer`, { ...payload(ir,"Owner User"), signer_id: "company" })).status,"completed");
  const legacy = await import("../proposals/storage.js");
  await assert.rejects(legacy.completePublicProposalESign("any-legacy-token",{ signer_name:"Fake" }), { code:"proposal_signature_reissue_required" });
  const onSite = await create();
  const crew = `/v1/workforce/organizations/${orgId}/crew/projects/signing_project/signatures/${onSite.id}`;
  assert.equal((await client.raw("POST",`${crew}/signing/prepare`,{field:"sig_customer"})).statusCode,403,"presenters need project assignment");
  const platform = await import("../platform/storage.js");
  const projectRecord = await platform.readDocument(orgId,"projects","signing_project");
  await platform.upsertDocument(orgId,"projects",{id:"signing_project",data:{...projectRecord.data,events:[{id:"onsite",kind:"project_work",event_type_default_id:"project_work",status:"scheduled",assigned_user_ids:[userId],start_date:"2026-09-26",end_date:"2026-09-26"}]}},{replace:true});
  const onSiteReview = await client.request("POST", `${crew}/signing/prepare`, { field:"sig_customer" });
  assert.equal(onSiteReview.presenter_attestation_required,true);
  const onSitePayload = payload(onSiteReview,"Alice");
  assert.equal((await client.raw("POST",`${crew}/outputs/sig_customer`,onSitePayload)).statusCode,400);
  await client.request("POST",`${crew}/outputs/sig_customer`,{...onSitePayload,consent:{...onSitePayload.consent,presenter_witnessed:true}});
  assert.equal((await store.packageForSnapshot(orgId,onSite.snapshot.id))!.receipts.sig_customer!.evidence.authentication,"presenter_witnessed_in_person");
  assert.equal((await client.request("GET", `/v1/documents/public/${a}`)).snapshot.outputs.sig_customer.evidence, undefined);
  const stale = await create(), st = stale.signing.invitations[0].token, review = await prepare(st);
  await client.request("PATCH", `/v1/documents/organizations/${orgId}/documents/${stale.id}`, { params: { body: "New terms" } });
  assert.equal((await client.raw("POST", `/v1/documents/public/${st}/outputs/sig_customer`, payload(review, "Alice"))).statusCode, 409);
  await client.request("POST", `/v1/documents/organizations/${orgId}/documents/${stale.id}/send`, { recipients: [{ name: "Alice", email: "alice@example.test", role: "customer" }] });
  assert.equal((await client.raw("POST", `/v1/documents/public/${st}/signing/prepare`, {})).statusCode, 409);
  const rotated = await create(), oldInvite = rotated.signing.invitations[0].token;
  const { invitation: rotation } = await client.request("POST",`/v1/documents/organizations/${orgId}/documents/${rotated.id}/signing/reissue`,{signer_id:"customer"});
  assert.equal((await client.raw("POST",`/v1/documents/public/${oldInvite}/signing/prepare`,{})).statusCode,403);
  assert.ok((await prepare(rotation.token)).challenge);
  const expiring = await store.packageForSnapshot(orgId,rotated.snapshot.id);
  await store.savePackage({...expiring!,expires_at:"2000-01-01T00:00:00.000Z"});
  assert.equal((await client.raw("POST",`/v1/documents/public/${rotation.token}/signing/prepare`,{})).statusCode,409);
  await (await import("../documents/signing/service.js")).drainSigningOutbox();
  assert.equal((await storage.readDocumentInstance(orgId,rotated.id)).status,"expired");
  const voided = await create();
  await client.request("POST",`/v1/documents/organizations/${orgId}/documents/${voided.id}/void`,{});
  assert.equal((await client.raw("POST",`/v1/documents/public/${voided.signing.invitations[0].token}/signing/prepare`,{})).statusCode,409);
  const disabled = await create({ sig_customer: { type: "signature", required: true }, answer: { type: "value" } });
  await (await import("../platform/capabilities.js")).saveCapabilityValues(orgId, { "documents.esign": false });
  assert.notEqual((await client.request("POST", `/v1/documents/public/${disabled.snapshot.public_token}/outputs/answer`, { value: "ok" })).document.status, "completed");
  assert.equal((await client.raw("POST", `/v1/documents/public/${disabled.snapshot.public_token}/outputs/sig_customer`, { value: { text: "Fake" }, evidence: { capture_mode: "imported" } })).statusCode, 403);
});


