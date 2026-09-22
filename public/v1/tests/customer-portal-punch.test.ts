import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before, beforeEach } from "node:test";

/**
 * Punch lists — docs/customer-portal-v2-spec.md §8.2.
 *
 * The customer AUTHORS the list and gates it on both ends; the company works it
 * in between. These cases pin that ordering, the configurability of every gate,
 * and the fact that a project can carry several lists at different phases.
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
  const raw = async (method: string, url: string, payload?: unknown) => await (app.inject as any)({
    method, url, payload,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
    }
  });
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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-punch-test-"));
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
  if (storageRoot) await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
});

beforeEach(async () => {
  const { resetPortalWriteLimits } = await import("../platform/portal_writes.js");
  resetPortalWriteLimits();
});

async function setupPortal(client: ReturnType<typeof createSessionClient>, projectId: string) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Punch Test Org",
    organization_id: `org_punch_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  const orgId = registered.organization.id as string;
  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument(orgId, "projects", {
    id: projectId,
    data: { branch_id: "default", title: `${projectId} Project`, address: "9 Remodel Way" },
    metadata: { kind: "project" }
  }, { replace: true });
  const created = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`);
  return { orgId, portal: created.portal as Json };
}

/** Create a punch list the way punchlist.request.v1 does. */
async function seedPunchList(orgId: string, projectId: string, config: Json = {}, key = "test") {
  const { ensureProjectChecklists } = await import("../workforce/crew_storage.js");
  const { normalizePunchConfig } = await import("../workforce/punch_lists.js");
  const punch = normalizePunchConfig({ ...config, state: "requested", requested_at: new Date().toISOString() });
  const result = (await ensureProjectChecklists(orgId, projectId, {
    definitions: [{
      id: `checklist_punch_${key}_${projectId}`.slice(0, 60),
      title: "Final walkthrough",
      audience: "crew",
      source: "scope",
      source_key: `punch:${key}:${projectId}`,
      items: [],
      metadata: { punch },
      customer_access: { visible: true, can_complete: false, can_edit_items: true }
    }] as any,
    actorUserId: "system"
  }));
  return String((result.created[0] as Json).id);
}

function punchOf(payload: Json, index = 0) {
  return (payload.resources?.punch_lists || [])[index] as Json;
}

/** Multipart body carrying one PNG-sniffed file, for the evidence route. */
function evidenceMultipart(name = "proof.png", contentType = "image/png") {
  const boundary = "----punchevidencetest";
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`
    ),
    Buffer.concat([header, Buffer.alloc(64, 7)]),
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

async function attachEvidence(base: string, checklistId: string, itemId: string, payload = evidenceMultipart()) {
  return await (app.inject as any)({
    method: "POST",
    url: `${base}/checklists/${checklistId}/items/${itemId}/attachments`,
    payload: payload.body,
    headers: { "content-type": payload.contentType }
  });
}

test("a punch list surfaces on its own key and never as a plain checklist", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_basic");
  const checklistId = await seedPunchList(orgId, "proj_punch_basic");

  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  const punch = punchOf(payload);
  assert.ok(punch, "punch list should surface on resources.punch_lists");
  assert.equal(punch.state, "requested");
  assert.equal(punch.can_add_items, true);
  // It must not ALSO appear as an ordinary checklist the customer ticks off —
  // the customer authors punch items, they do not complete them.
  assert.equal((payload.resources.checklists || []).some((entry: Json) => entry.id === checklistId), false);
  assert.equal(punch.labels.noun, "punch list");
});

test("terminology and copy are configurable, and {noun} flows into unset strings", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_terms");
  await seedPunchList(orgId, "proj_punch_terms", {
    terminology_key: "snag_list",
    labels: { noun: "snag list", submit_cta: "Send my snags" }
  });

  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  const punch = punchOf(payload);
  assert.equal(punch.labels.noun, "snag list");
  assert.equal(punch.labels.submit_cta, "Send my snags");
  // Strings the org did NOT override still read naturally.
  assert.equal(punch.labels.request_title, "Create your snag list");
});

test("full lifecycle: customer authors, submits, company completes, customer accepts", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_flow");
  const checklistId = await seedPunchList(orgId, "proj_punch_flow", {
    require_submit_signature: true,
    require_accept_signature: true
  });
  const base = `/v1/platform/customer-portals/${portal.public_uuid}`;
  const staffBase = `/v1/platform/organizations/${orgId}/projects/proj_punch_flow/punch-lists/${checklistId}`;

  // 1. The customer authors the list through the existing checklist item route.
  await client.request("POST", `${base}/checklists/${checklistId}/items`, { title: "Touch up paint by the stairs" });
  await client.request("POST", `${base}/checklists/${checklistId}/items`, { title: "Cabinet door sits proud" });

  // 2. Customer signs off that this is everything outstanding.
  const submitted = await client.request("POST", `${base}/punch-lists/${checklistId}/submit`, {
    signature: { type: "typed", signer_name: "Dana Reyes" }
  });
  assert.equal(submitted.punch_list.state, "submitted");
  assert.equal(submitted.punch_list.submitted_by, "Dana Reyes");

  // The list is now a commitment the company prices work against.
  const lateAdd = await client.raw("POST", `${base}/checklists/${checklistId}/items`, { title: "One more thing" });
  assert.equal(lateAdd.statusCode, 403, lateAdd.body);
  assert.match(lateAdd.body, /punch_list_locked/);

  // 3. The company cannot hand it back before the work is actually done —
  // asking the customer to confirm unfinished work trains rubber-stamping.
  const premature = await client.raw("POST", `${staffBase}/complete-work`, {});
  assert.equal(premature.statusCode, 409, premature.body);
  assert.match(premature.body, /punch_list_items_outstanding/);

  const listing = await client.request("GET", `/v1/workforce/organizations/${orgId}/crew/projects/proj_punch_flow/checklists`);
  const items = (listing.checklists.find((entry: Json) => entry.id === checklistId) as Json).items as Json[];
  for (const item of items) {
    await client.request(
      "PATCH",
      `/v1/workforce/organizations/${orgId}/crew/projects/proj_punch_flow/checklists/${checklistId}/items/${item.id}`,
      { completed: true }
    );
  }
  const completed = await client.request("POST", `${staffBase}/complete-work`, {});
  assert.equal(completed.punch_list.state, "work_complete");

  // 4. Customer signs off that the work is done.
  const accepted = await client.request("POST", `${base}/punch-lists/${checklistId}/accept`, {
    signature: { type: "typed", signer_name: "Dana Reyes" }
  });
  assert.equal(accepted.punch_list.state, "accepted");
  assert.equal(accepted.punch_list.accepted_by, "Dana Reyes");
});

test("the customer can attach evidence and edit notes while authoring, but never complete", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_evidence");
  const checklistId = await seedPunchList(orgId, "proj_punch_evidence");
  const base = `/v1/platform/customer-portals/${portal.public_uuid}`;

  // Items can carry a description from the moment they are created — the add
  // form sends title + note together.
  const added = await client.request("POST", `${base}/checklists/${checklistId}/items`, {
    title: "Chipped tile",
    description: "Left of the tub, second row up"
  });
  const itemId = String(added.item.id);
  assert.equal(added.item.description, "Left of the tub, second row up");

  // Punch lists grant authoring, not completion, so evidence must ride the
  // editing grant — gating it on can_complete made customer photos impossible.
  const attached = await attachEvidence(base, checklistId, itemId);
  assert.equal(attached.statusCode, 200, attached.body);
  assert.equal(JSON.parse(attached.body).attachment.kind, "photo");

  // Audio notes are first-class evidence too.
  const voice = await attachEvidence(base, checklistId, itemId, evidenceMultipart("note.webm", "audio/webm"));
  assert.equal(voice.statusCode, 200, voice.body);
  assert.equal(JSON.parse(voice.body).attachment.kind, "audio");

  // A note is part of authoring the item, so the customer may edit it.
  const noted = await client.request("PATCH", `${base}/checklists/${checklistId}/items/${itemId}`, {
    note: "Spare tiles are in the garage"
  });
  assert.equal(noted.item.note, "Spare tiles are in the garage");

  // Completion stays the company's: the read-only gate still holds.
  const completed = await client.raw("PATCH", `${base}/checklists/${checklistId}/items/${itemId}`, { completed: true });
  assert.equal(completed.statusCode, 403, completed.body);
  assert.match(completed.body, /customer_checklist_read_only/);
  // Combining an allowed note with a protected completion field must not bypass either grant.
  assert.equal((await client.raw("PATCH", `${base}/checklists/${checklistId}/items/${itemId}`, { note: "Updated note", completed: true })).statusCode, 403);
  assert.equal((await client.raw("POST", `${base}/checklists/${checklistId}/items`, { title: "Prematurely done", status: "completed" })).statusCode, 403);
  assert.equal((await client.raw("PATCH", `${base}/checklists/${checklistId}/items/${itemId}`, { note: "Updated note", metadata: { required_attachments: [] } })).statusCode, 400);
});

test("evidence locks with the rest of the list once it is submitted", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_evlock");
  const checklistId = await seedPunchList(orgId, "proj_punch_evlock");
  const base = `/v1/platform/customer-portals/${portal.public_uuid}`;

  const added = await client.request("POST", `${base}/checklists/${checklistId}/items`, { title: "Sticky window" });
  const itemId = String(added.item.id);
  await client.request("POST", `${base}/punch-lists/${checklistId}/submit`, {});

  const late = await attachEvidence(base, checklistId, itemId);
  assert.equal(late.statusCode, 403, late.body);
  assert.match(late.body, /punch_list_locked/);
});

test("acceptance cannot be signed before the company finishes the work", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_order");
  const checklistId = await seedPunchList(orgId, "proj_punch_order");

  const early = await client.raw(
    "POST",
    `/v1/platform/customer-portals/${portal.public_uuid}/punch-lists/${checklistId}/accept`,
    {}
  );
  assert.equal(early.statusCode, 409, early.body);
  assert.match(early.body, /punch_list_not_complete/);
});

test("a required signature cannot be skipped", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_sig");
  const checklistId = await seedPunchList(orgId, "proj_punch_sig", { require_submit_signature: true });

  const unsigned = await client.raw(
    "POST",
    `/v1/platform/customer-portals/${portal.public_uuid}/punch-lists/${checklistId}/submit`,
    {}
  );
  assert.equal(unsigned.statusCode, 400, unsigned.body);
  // The shared portal signature primitive owns this code — punch, completion,
  // and document signatures all report it the same way.
  assert.match(unsigned.body, /signature_name_required/);
});

test("signature-free punch lists submit and accept without one", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_nosig");
  const checklistId = await seedPunchList(orgId, "proj_punch_nosig", {
    require_submit_signature: false,
    require_accept_signature: false
  });
  const base = `/v1/platform/customer-portals/${portal.public_uuid}`;
  const staffBase = `/v1/platform/organizations/${orgId}/projects/proj_punch_nosig/punch-lists/${checklistId}`;

  // allow_empty defaults true: "nothing is outstanding" is a real answer.
  const submitted = await client.request("POST", `${base}/punch-lists/${checklistId}/submit`, {});
  assert.equal(submitted.punch_list.state, "submitted");

  await client.request("POST", `${staffBase}/complete-work`, {});
  const accepted = await client.request("POST", `${base}/punch-lists/${checklistId}/accept`, {});
  assert.equal(accepted.punch_list.state, "accepted");
});

test("max_items caps how much the customer can add", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_cap");
  const checklistId = await seedPunchList(orgId, "proj_punch_cap", { max_items: 2 });
  const base = `/v1/platform/customer-portals/${portal.public_uuid}/checklists/${checklistId}/items`;

  await client.request("POST", base, { title: "One" });
  await client.request("POST", base, { title: "Two" });
  const third = await client.raw("POST", base, { title: "Three" });
  assert.equal(third.statusCode, 403, third.body);
  assert.match(third.body, /punch_list_full/);
});

test("allow_empty false requires at least one item before submitting", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_empty");
  const checklistId = await seedPunchList(orgId, "proj_punch_empty", { allow_empty: false });

  const empty = await client.raw(
    "POST",
    `/v1/platform/customer-portals/${portal.public_uuid}/punch-lists/${checklistId}/submit`,
    {}
  );
  assert.equal(empty.statusCode, 400, empty.body);
  assert.match(empty.body, /punch_list_empty/);
});

test("reopening clears prior sign-offs and lets the customer add again", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_reopen");
  const checklistId = await seedPunchList(orgId, "proj_punch_reopen", { require_submit_signature: true });
  const base = `/v1/platform/customer-portals/${portal.public_uuid}`;

  await client.request("POST", `${base}/checklists/${checklistId}/items`, { title: "Scuff on trim" });
  await client.request("POST", `${base}/punch-lists/${checklistId}/submit`, {
    signature: { type: "typed", signer_name: "Dana Reyes" }
  });

  const reopened = await client.request(
    "POST",
    `/v1/platform/organizations/${orgId}/projects/proj_punch_reopen/punch-lists/${checklistId}/reopen`,
    {}
  );
  assert.equal(reopened.punch_list.state, "requested");
  // A signature attests to a list state that no longer holds once the list is
  // editable again, so it must not survive the reopen.
  assert.equal(reopened.punch_list.submitted_by, "");
  assert.equal(reopened.punch_list.submitted_at, "");

  const added = await client.request("POST", `${base}/checklists/${checklistId}/items`, { title: "Also the doorstop" });
  assert.ok(added.item.id);
});

test("a project can carry several independent punch lists at different phases", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_multi");
  await seedPunchList(orgId, "proj_punch_multi", { labels: { noun: "rough-in list" } }, "roughin");
  await seedPunchList(orgId, "proj_punch_multi", { labels: { noun: "finish list" } }, "finish");

  const payload = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  const lists = payload.resources.punch_lists as Json[];
  assert.equal(lists.length, 2, `expected two punch lists, got ${lists.length}`);
  assert.deepEqual(lists.map((entry) => entry.labels.noun).sort(), ["finish list", "rough-in list"]);
  // They advance independently — one phase closing out must not close another.
  assert.deepEqual([...new Set(lists.map((entry) => entry.state))], ["requested"]);
});

test("punch config layering: org defaults apply, instance config wins", async () => {
  const { normalizePunchConfig } = await import("../workforce/punch_lists.js");

  const orgDefaults = { require_accept_signature: true, max_items: 10, labels: { noun: "snag list" } };

  // House rule applies when the template says nothing.
  const inherited = normalizePunchConfig({}, orgDefaults);
  assert.equal(inherited.require_accept_signature, true);
  assert.equal(inherited.max_items, 10);
  assert.equal(inherited.labels.noun, "snag list");

  // A template that specifies a value overrides the house rule.
  const overridden = normalizePunchConfig({ require_accept_signature: false, max_items: 3 }, orgDefaults);
  assert.equal(overridden.require_accept_signature, false);
  assert.equal(overridden.max_items, 3);
});

test("punchlist.request.v1 is registered and documents its gates", async () => {
  const { registerBuiltinWorkAutomations } = await import("../work/automations/builtins.js");
  registerBuiltinWorkAutomations();
  const { listWorkAutomationDefinitions } = await import("../work/registry.js");
  const automations = listWorkAutomationDefinitions();
  const punch = automations.find((entry) => entry.id === "punchlist.request.v1") as Json | undefined;
  assert.ok(punch, `punchlist.request.v1 should be registered; saw ${automations.length} automations`);
  // Scope authors pick automations out of this list in the builder UI, so the
  // gates have to be discoverable without reading the source.
  assert.ok(String(punch!.input?.config || "").includes("require_submit_signature"));
  assert.ok(String(punch!.input?.instance_key || "").length > 0);
});

test("the punch tab appears only when a list exists and carries the org's own term", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_tab");

  const before = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  assert.equal(before.tabs.some((tab: Json) => tab.id === "punch_lists"), false);

  await seedPunchList(orgId, "proj_punch_tab", { labels: { noun: "snag list" } });

  const after = await client.request("GET", `/v1/platform/customer-portals/${portal.public_uuid}`);
  const tab = after.tabs.find((entry: Json) => entry.id === "punch_lists") as Json;
  assert.ok(tab, "punch tab should appear once a list is requested");
  // The tab label follows the configured terminology, not a hardcoded string.
  assert.equal(tab.label, "Snag List");
  // And it lands after the blessed band, so existing portals do not reorder.
  const ids = after.tabs.map((entry: Json) => entry.id);
  assert.deepEqual(ids.slice(0, before.tabs.length), before.tabs.map((tab: Json) => tab.id));
});

test("punch state projects onto the project so scope conditions can gate on it", async () => {
  const client = createSessionClient();
  const { orgId, portal } = await setupPortal(client, "proj_punch_projection");
  const checklistId = await seedPunchList(orgId, "proj_punch_projection", { required: true }, "gate");
  const base = `/v1/platform/customer-portals/${portal.public_uuid}`;
  const staffBase = `/v1/platform/organizations/${orgId}/projects/proj_punch_projection/punch-lists/${checklistId}`;
  const { readDocument } = await import("../platform/storage.js");
  const punchOfProject = async () => {
    const record = await readDocument(orgId, "projects", "proj_punch_projection");
    return ((record.data as Json).punch || {}) as Json;
  };

  await client.request("POST", `${base}/punch-lists/${checklistId}/submit`, {});
  let projection = await punchOfProject();
  // This is the fact a scope author gates on: conditions read dot-paths over
  // `project`, so "project.punch.required_outstanding" == "0" is the gate.
  assert.equal(projection.required_total, 1);
  assert.equal(projection.required_outstanding, 1, "a submitted-but-unaccepted required list is still outstanding");
  assert.equal(projection.awaiting_company, 1);

  await client.request("POST", `${staffBase}/complete-work`, {});
  await client.request("POST", `${base}/punch-lists/${checklistId}/accept`, {});

  projection = await punchOfProject();
  assert.equal(projection.required_outstanding, 0, "acceptance clears the gate");
  assert.equal(projection.all_accepted, true);
  // Per-list keys let a scope gate on one specific list rather than the whole set.
  assert.equal((projection.by_key as Json).gate.state, "accepted");
});
