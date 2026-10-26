import { nextTestPhone, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// Opening a project by its link must never write over it (2026-10-26: a sample
// project's link opened a blank "New Project" window). A project window that
// never read the project from the server saves with `create_only`: the save
// may create the project, and the server refuses it (409 project_exists) when a
// project with that id is stored, leaving the stored record as it was.

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}
function createSessionClient() {
  let cookie = "", csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({ method, url, payload,
      headers: { ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}) } });
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session"), csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    return { status: response.statusCode as number, body: response.body ? JSON.parse(response.body) : null };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.status < 400, `${method} ${url} failed: ${response.status} ${JSON.stringify(response.body)}`);
    return response.body;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-project-open-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMEASURE_JOB_WORKERS: "0", WORK_SCHEDULER_DISABLED: "1", PLATFORM_HEARTBEAT_DISABLED: "1", EMAIL_OUTBOUND_DISABLED: "1", V1_LOG_LEVEL: "error",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"), CRM_STORAGE_ROOT: path.join(storageRoot, "crm"), FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"), PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook") });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});
after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

test("a whole-project save from a window that never read the project cannot replace it", async () => {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", { phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple", name: "Owner User", company: "Open Link Org", organization_id: `org_open_${suffix}` });
  const orgId = String(registered.organization.id);
  const base = `/v1/platform/organizations/${orgId}/projects`;
  // A stored project whose id is not project_-prefixed, like the signup sandbox's sample projects.
  const storage = await import("../platform/storage.js");
  const sampleId = "sample_9ccd4530b2b5940488d0388a";
  await storage.upsertDocument(orgId, "projects", { id: sampleId, data: { id: sampleId, title: "Harbor Office — leak repair (Sample)", address: "360 Example Harbor Way", workflow_state: "project", branch_id: "default" }, metadata: { synthetic: true } }, { createOnly: true });

  // The blank stand-in the window used to save: refused, and the record is unchanged.
  const blank = { data: { id: sampleId, title: "New Project", address: "", workflow_state: "measurement_ordered" }, metadata: { kind: "platform_project" }, create_only: true };
  const refused = await client.raw("PUT", `${base}/${sampleId}`, blank);
  assert.equal(refused.status, 409);
  assert.equal(refused.body?.error || refused.body?.code, "project_exists");
  const stored = (await client.request("GET", `${base}/${sampleId}`)).document;
  assert.equal(stored.revision, 1);
  assert.equal(stored.data.title, "Harbor Office — leak repair (Sample)");
  assert.equal(stored.data.address, "360 Example Harbor Way");
  assert.equal(stored.data.workflow_state, "project");
  assert.equal("create_only" in stored.data, false);

  // A new project still saves with create_only, and the flag is not stored.
  const created = await client.request("PUT", `${base}/project_open_link_new`, { data: { id: "project_open_link_new", title: "12 New Street", address: "12 New Street" }, metadata: { kind: "platform_project" }, create_only: true });
  assert.equal(created.document.data.title, "12 New Street");
  assert.equal("create_only" in created.document, false);
  assert.equal("create_only" in created.document.data, false);
  // Its second whole save without a revision is refused the same way; edits go through PATCH (must exist).
  assert.equal((await client.raw("PUT", `${base}/project_open_link_new`, { data: { id: "project_open_link_new", title: "" }, create_only: true })).status, 409);
  const patched = await client.request("PATCH", `${base}/project_open_link_new`, { data: { title: "12 New Street (edited)" } });
  assert.equal(patched.document.data.title, "12 New Street (edited)");
  assert.equal(patched.document.data.address, "12 New Street");
});
