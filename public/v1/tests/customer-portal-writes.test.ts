import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";

/**
 * Customer-authored writes — docs/customer-portal-v2-spec.md §5.2–5.4.
 *
 * This is the portal's first real security boundary, so the cases here are
 * mostly negative: what a holder of the portal link must NOT be able to do.
 */

let app: any = null;
let storageRoot = "";

type Json = Record<string, any>;

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
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-portal-writes-test-"));
  process.env.NODE_ENV = "test";
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

beforeEach(async () => {
  // The write-rate bucket is process-global; without this one test's spam would
  // starve the next one.
  const { resetPortalWriteLimits } = await import("../platform/portal_writes.js");
  resetPortalWriteLimits();
});

async function registerOrg(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Portal Writes Test Org",
    organization_id: `org_portal_w_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string };
}

async function seedProject(orgId: string, id: string) {
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument(orgId, "projects", {
    id,
    data: { branch_id: "default", title: `${id} Project`, address: `${id} Address` },
    metadata: { kind: "project" }
  }, { replace: true });
}

/** Create the portal and set its per-project settings through the real API. */
async function setupPortal(
  client: ReturnType<typeof createSessionClient>,
  projectId: string,
  settings: Json = {}
) {
  const { orgId } = await registerOrg(client);
  await seedProject(orgId, projectId);
  const created = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`);
  if (Object.keys(settings).length) {
    await client.request("PATCH", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`, { settings });
  }
  const refreshed = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`);
  return { orgId, projectId, portal: (refreshed.portal || created.portal) as Json };
}

// --- Fixtures ----------------------------------------------------------------

/** Bytes with a real PNG magic header, long enough to sniff. */
function pngBytes(size = 64) {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  return Buffer.concat([header, Buffer.alloc(Math.max(0, size - header.length), 7)]);
}

function pdfBytes() {
  return Buffer.concat([Buffer.from("%PDF-1.7\r\n"), Buffer.alloc(64, 32)]);
}

function multipart(fields: { file?: { name: string; bytes: Buffer }; caption?: string }) {
  const boundary = "----portalwritestest";
  const chunks: Buffer[] = [];
  if (fields.file) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fields.file.name}"\r\n` +
      "Content-Type: application/octet-stream\r\n\r\n"
    ));
    chunks.push(fields.file.bytes);
    chunks.push(Buffer.from("\r\n"));
  }
  if (fields.caption !== undefined) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${fields.caption}\r\n`));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function uploadTo(portalUuid: string, payload: ReturnType<typeof multipart>) {
  return await (app.inject as any)({
    method: "POST",
    url: `/v1/platform/customer-portals/${portalUuid}/uploads`,
    payload: payload.body,
    headers: { "content-type": payload.contentType }
  });
}

// --- Sniffing (pure unit) ----------------------------------------------------

test("upload sniffing identifies real types and rejects everything else", async () => {
  const { sniffUploadMime } = await import("../platform/portal_writes.js");

  assert.equal(sniffUploadMime(pngBytes()), "image/png");
  assert.equal(sniffUploadMime(pdfBytes()), "application/pdf");
  assert.equal(sniffUploadMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), "image/jpeg");

  // The case this exists for: an HTML/script payload named .png. Storing it and
  // later serving it back would be a stored-XSS vector.
  assert.equal(sniffUploadMime(Buffer.from("<html><script>alert(1)</script></html>")), "");
  assert.equal(sniffUploadMime(Buffer.from("#!/bin/sh\nrm -rf /\n\n\n\n")), "");
  assert.equal(sniffUploadMime(Buffer.alloc(4)), "", "too short to identify");
});

// --- Route behavior ----------------------------------------------------------

test("uploads are refused until the org enables them", async () => {
  const client = createSessionClient();
  const { portal } = await setupPortal(client, "proj_upload_off");

  const denied = await uploadTo(String(portal.public_uuid), multipart({ file: { name: "a.png", bytes: pngBytes() } }));
  assert.equal(denied.statusCode, 403, denied.body);
  assert.match(denied.body, /portal_uploads_disabled/);
});

test("an enabled portal accepts a photo and surfaces it in the public payload", async () => {
  const client = createSessionClient();
  const { portal } = await setupPortal(client, "proj_upload_on", { uploads: { photos: true } });

  const response = await uploadTo(String(portal.public_uuid), multipart({
    file: { name: "roof.png", bytes: pngBytes(256) },
    caption: "Water stain on the ceiling"
  }));
  assert.equal(response.statusCode, 201, response.body);
  const created = JSON.parse(response.body);
  assert.equal(created.upload.kind, "photo");
  assert.equal(created.upload.content_type, "image/png");
  assert.equal(created.upload.caption, "Water stain on the ceiling");

  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  assert.equal(payload.customer_uploads.length, 1);
  assert.equal(payload.customer_uploads[0].media_id, created.upload.media_id);
});

test("a disguised payload is rejected on its sniffed bytes", async () => {
  const client = createSessionClient();
  const { portal } = await setupPortal(client, "proj_upload_sniff", { uploads: { photos: true, documents: true } });

  const response = await uploadTo(String(portal.public_uuid), multipart({
    file: { name: "totally-an-image.png", bytes: Buffer.from("<html><script>alert(1)</script></html>    ") }
  }));
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.body, /portal_upload_unsupported/);
});

test("photo permission does not imply document permission", async () => {
  const client = createSessionClient();
  const { portal } = await setupPortal(client, "proj_upload_docs", { uploads: { photos: true, documents: false } });

  const response = await uploadTo(String(portal.public_uuid), multipart({ file: { name: "contract.pdf", bytes: pdfBytes() } }));
  assert.equal(response.statusCode, 403, response.body);
  assert.match(response.body, /portal_uploads_disabled/);
});

test("require_caption is enforced server-side", async () => {
  const client = createSessionClient();
  const { portal } = await setupPortal(client, "proj_upload_caption", {
    uploads: { photos: true, require_caption: true }
  });

  const bare = await uploadTo(String(portal.public_uuid), multipart({ file: { name: "a.png", bytes: pngBytes() } }));
  assert.equal(bare.statusCode, 400, bare.body);
  assert.match(bare.body, /portal_upload_caption_required/);

  const captioned = await uploadTo(String(portal.public_uuid), multipart({
    file: { name: "a.png", bytes: pngBytes() },
    caption: "Front elevation"
  }));
  assert.equal(captioned.statusCode, 201, captioned.body);
});

test("withdrawing an upload hides it without destroying the record", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_upload_withdraw", { uploads: { photos: true } });

  const created = JSON.parse((await uploadTo(String(portal.public_uuid), multipart({
    file: { name: "a.png", bytes: pngBytes() }
  }))).body);
  const mediaId = created.upload.media_id;

  await client.request("DELETE", `/v1/platform/customer-portals/${portal.public_uuid}/uploads/${mediaId}`);
  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  assert.equal(payload.customer_uploads.length, 0, "withdrawn uploads leave the customer view");

  // The row survives with a withdrawn_at stamp: a bearer token must never be
  // able to destroy what the business was already sent.
  const { readDocument } = await import("../platform/storage.js");
  const { customerPortalDocumentId } = await import("../platform/portal_settings.js");
  const record = await readDocument(orgId, "customer_portals", customerPortalDocumentId("proj_upload_withdraw"));
  const stored = (record.data as Json).customer_uploads;
  assert.equal(stored.length, 1, "the audit row is retained");
  assert.ok(stored[0].withdrawn_at, "withdrawal is a soft stamp");
});

test("a link holder cannot withdraw media they did not upload", async () => {
  const client = createSessionClient();
  const { portal } = await setupPortal(client, "proj_withdraw_forge", { uploads: { photos: true } });

  const forged = await client.raw("DELETE", `/v1/platform/customer-portals/${portal.public_uuid}/uploads/media_business_owned`);
  assert.equal(forged.statusCode, 404, forged.body);
});

test("withdrawing an upload does not refund daily quota", async () => {
  const client = createSessionClient();
  const { portal } = await setupPortal(client, "proj_quota", { uploads: { photos: true, max_files: 2 } });

  const first = JSON.parse((await uploadTo(String(portal.public_uuid), multipart({ file: { name: "1.png", bytes: pngBytes() } }))).body);
  await uploadTo(String(portal.public_uuid), multipart({ file: { name: "2.png", bytes: pngBytes() } }));

  // Withdraw one, then try again: if withdrawal refunded quota, upload-withdraw-
  // repeat would be an unbounded loop.
  await client.request("DELETE", `/v1/platform/customer-portals/${portal.public_uuid}/uploads/${first.upload.media_id}`);
  const third = await uploadTo(String(portal.public_uuid), multipart({ file: { name: "3.png", bytes: pngBytes() } }));
  assert.equal(third.statusCode, 403, third.body);
  assert.match(third.body, /portal_upload_quota/);
});

test("comments require the setting and a media id belonging to this portal", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_comments", {
    uploads: { photos: true },
    comments: { photos: false }
  });

  const created = JSON.parse((await uploadTo(String(portal.public_uuid), multipart({
    file: { name: "a.png", bytes: pngBytes() }
  }))).body);
  const mediaId = created.upload.media_id;

  const denied = await client.raw("POST", `/v1/platform/customer-portals/${portal.public_uuid}/media/${mediaId}/comments`, { body: "Looks great" });
  assert.equal(denied.statusCode, 403, "comments are off by default");
  assert.match(denied.body, /portal_comments_disabled/);

  await client.request("PATCH", `/v1/platform/organizations/${orgId}/projects/proj_comments/customer-portal`, {
    settings: { uploads: { photos: true }, comments: { photos: true } }
  });

  // Commenting on an arbitrary media id would let a link holder probe for (and
  // annotate) media belonging to other projects.
  const probe = await client.raw("POST", `/v1/platform/customer-portals/${portal.public_uuid}/media/media_someone_else/comments`, { body: "hi" });
  assert.equal(probe.statusCode, 404, probe.body);

  const allowed = await client.request("POST", `/v1/platform/customer-portals/${portal.public_uuid}/media/${mediaId}/comments`, {
    body: "This is the spot that leaks"
  });
  assert.equal(allowed.comment.body, "This is the spot that leaks");

  const listed = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}/media/${mediaId}/comments`);
  assert.equal(listed.comments.length, 1);
});

test("empty and oversized comments are rejected", async () => {
  const client = createSessionClient();
  const { portal } = await setupPortal(client, "proj_comment_bounds", {
    uploads: { photos: true },
    comments: { photos: true }
  });
  const created = JSON.parse((await uploadTo(String(portal.public_uuid), multipart({
    file: { name: "a.png", bytes: pngBytes() }
  }))).body);
  const mediaId = created.upload.media_id;
  const base = `/v1/platform/customer-portals/${portal.public_uuid}/media/${mediaId}/comments`;

  const empty = await client.raw("POST", base, { body: "   " });
  assert.equal(empty.statusCode, 400);
  assert.match(empty.body, /portal_comment_empty/);

  const huge = await client.raw("POST", base, { body: "x".repeat(5000) });
  assert.equal(huge.statusCode, 400);
  assert.match(huge.body, /portal_comment_too_long/);
});

test("portal writes are rate limited per portal", async () => {
  const client = createSessionClient();
  const { PORTAL_WRITE_RATE_PER_MINUTE } = await import("../platform/portal_settings.js");
  const { portal } = await setupPortal(client, "proj_rate", {
    uploads: { photos: true },
    comments: { photos: true }
  });

  const created = JSON.parse((await uploadTo(String(portal.public_uuid), multipart({
    file: { name: "a.png", bytes: pngBytes() }
  }))).body);
  const mediaId = created.upload.media_id;

  let limited = false;
  for (let index = 0; index < PORTAL_WRITE_RATE_PER_MINUTE + 5; index += 1) {
    const response = await client.raw("POST", `/v1/platform/customer-portals/${portal.public_uuid}/media/${mediaId}/comments`, { body: `spam ${index}` });
    if (response.statusCode === 403 && response.body.includes("portal_rate_limited")) {
      limited = true;
      break;
    }
  }
  assert.ok(limited, `bucket should empty within ${PORTAL_WRITE_RATE_PER_MINUTE + 5} writes`);
});

test("preview portals are read-only", async () => {
  const client = createSessionClient();
  const { portal } = await setupPortal(client, "proj_preview_write", { uploads: { photos: true } });

  // Writing through a preview uuid would attribute a staff action to the
  // customer and pollute the project's audit trail.
  const response = await uploadTo(String(portal.preview_uuid), multipart({ file: { name: "a.png", bytes: pngBytes() } }));
  assert.ok(
    response.statusCode === 403 || response.statusCode === 404,
    `preview writes must be refused, got ${response.statusCode} ${response.body}`
  );
});

test("an inactive portal refuses writes", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_inactive", { uploads: { photos: true } });

  await client.request("PATCH", `/v1/platform/organizations/${orgId}/projects/proj_inactive/customer-portal`, {
    status: "revoked"
  });

  const response = await uploadTo(String(portal.public_uuid), multipart({ file: { name: "a.png", bytes: pngBytes() } }));
  assert.ok(response.statusCode >= 400, "a revoked portal must not accept uploads");
});

test("the My Files tab appears only once customer document uploads are on", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_myfiles");

  const before = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  assert.equal(before.tabs.some((tab: Json) => tab.id === "my_documents"), false);

  await client.request("PATCH", `/v1/platform/organizations/${orgId}/projects/proj_myfiles/customer-portal`, {
    settings: { uploads: { documents: true } }
  });

  const after = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  const ids = after.tabs.map((tab: Json) => tab.id);
  assert.ok(ids.includes("my_documents"), `expected my_documents in ${JSON.stringify(ids)}`);
  // Enabling a feature must never reorder the tabs an existing portal shows.
  assert.deepEqual(ids.slice(0, before.tabs.length), before.tabs.map((tab: Json) => tab.id));
});
