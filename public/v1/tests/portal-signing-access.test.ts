import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// A customer signs from their own project portal, and the link in their email
// opens that portal on the document. The shared read-only link still cannot sign.

test("the customer's portal can sign its own project's agreement, and nothing else can", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "portal-signing-"));
  Object.assign(process.env, { NODE_ENV: "test", V1_LOG_LEVEL: "error", EMAIL_OUTBOUND_DISABLED: "1", PUBLIC_BASE_URL: "https://app.test", PLATFORM_HEARTBEAT_DISABLED: "1",
    PLATFORM_STORAGE_ROOT: root, PRICEBOOK_STORAGE_ROOT: path.join(root, "pricebook"), SIGNUP_SANDBOX_STORAGE_ROOT: path.join(root, "signup") });
  const storage = await import("../platform/storage.js");
  const signup = await import("../signup-sandbox/service.js");
  const documents = await import("../documents/service.js");
  const { ensureDefaultDocumentAssets } = await import("../documents/seeds.js");
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  const { buildApp } = await import("../src/app.js");
  await signup.ensureSeedData();
  const { authContext: ctx } = await signup.createTestInstance("swf_instant_full_org") as { authContext: any };
  await ensureDefaultDocumentAssets(ctx.orgId, ctx);
  const app = await buildApp();
  try {
    const projectData = (id: string) => ({ id, data: { title: id, branch_id: "default", contacts: [{ name: "Dana Whitfield", email: "dana@example.test", primary: true }] } });
    await storage.upsertDocument(ctx.orgId, "projects", projectData("project_mine"));
    await storage.upsertDocument(ctx.orgId, "projects", projectData("project_other"));
    const send = async (projectId: string) => {
      const created = await documents.createDocumentInstance(ctx.orgId, projectId, { document_type: "proposal", template_id: "tpl_instant_roofing_detailed" }, ctx) as any;
      return await documents.sendDocument(ctx.orgId, String(created.document.id), { recipients: [{ signer_id: "customer", name: "Dana Whitfield", email: "dana@example.test" }], include_pdf: false }, ctx) as any;
    };
    const mine = await send("project_mine");
    const other = await send("project_other");
    const documentId = String(mine.document.id);

    // The emailed link is the project's portal, opened on the document, with the signer's credential in the fragment.
    const link = new URL(String(mine.signing.invitations[0].portal_url));
    assert.equal(link.pathname, "/customer_portal/");
    assert.equal(link.searchParams.get("document"), documentId);
    assert.match(link.hash, /^#sign=.{20,}/);
    const portalId = String(link.searchParams.get("id"));
    assert.ok(portalId, "the portal id is in the link");
    assert.equal(new URL(String(mine.portal_url)).hash, "", "a link that is not a signer's carries no credential");

    const access = (portal: string, doc: string) => app.inject({ method: "POST", url: `/v1/platform/customer-portals/${portal}/documents/${doc}/signing-access`, payload: {} });
    // Not a portal, or an agreement of another project: nothing.
    assert.ok((await access("00000000-0000-4000-8000-000000000000", documentId)).statusCode >= 400);
    assert.equal((await access(portalId, String(other.document.id))).statusCode, 404);
    assert.equal((await access(portalId, "doc_missing")).statusCode, 404);
    // The portal's own agreement: a credential for its one outside signer.
    const granted = await access(portalId, documentId);
    assert.equal(granted.statusCode, 200, granted.body);
    const credential = String(granted.json().token);
    assert.equal(granted.json().signer_id, "customer");
    const prepare = (token: string) => app.inject({ method: "POST", url: `/v1/documents/public/${encodeURIComponent(token)}/signing/prepare`, payload: { field: "sig_customer" } });
    assert.equal((await prepare(credential)).statusCode, 200, "the portal's credential prepares the signing review");
    // The emailed credential still works; the shared read-only link still does not.
    assert.equal((await prepare(decodeURIComponent(link.hash.slice("#sign=".length)))).statusCode, 200);
    assert.equal((await prepare(String(mine.snapshot.public_token))).statusCode, 403);
  } finally {
    await app.close();
    await closeSqlStoresForTests().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
});
