import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { after, before } from "node:test";

type TestClient = ReturnType<typeof createSessionClient>;

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-platform-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  process.env.FIRSTMEASURE_INTERNAL_API_SECRET = "isolated-workflow-queue-secret";

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

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...headers,
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
    let json: any = null;
    try {
      json = response.body ? JSON.parse(response.body) : null;
    } catch {
      json = null;
    }
    return { statusCode: response.statusCode, headers: response.headers, body: response.body, data: json };
  };
  const request = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await raw(method, url, payload, headers);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };

  return {
    request,
    raw
  };
}

function readAttributionMetadata(attributionId: string) {
  const dbPath = path.join(storageRoot, "crm", "databases", "referrals.sqlite");
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT metadata_json FROM referral_attributions WHERE id = ?").get(attributionId) as { metadata_json?: string } | undefined;
    return row?.metadata_json ? JSON.parse(row.metadata_json) : {};
  } finally {
    db.close();
  }
}

async function register(client: TestClient, expanded = true) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const email = `owner-${suffix}@example.test`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email,
    password: "correct horse battery staple",
    name: "Owner User",
    company: "Workflow Test Org",
    organization_id: `org_test_${suffix}`
  });
  if (expanded) await enableExpandedPlatformFixture(data.organization.id);
  assert.equal(data.ok, true);
  assert.ok(data.organization.id);
  assert.equal(data.user.data.role, "owner");
  return { orgId: data.organization.id as string, userId: data.user.id as string, email };
}

test("project contacts receive stable ids on save and keep them through renames", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_contact_identity_guard";

  const created = await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      title: "Contact identity guard",
      contacts: [{ name: "Name Only Contact", primary: true }]
    }
  });
  assert.equal(created.document.data.contacts.length, 1);
  const contactId = created.document.data.contacts[0].id;
  assert.match(contactId, /^contact_[a-z0-9_-]+$/);
  assert.equal(created.document.data.contacts[0].contact_id, contactId);
  assert.equal(created.document.data.contact_id, contactId);
  assert.equal(created.document.data.primary_contact_id, contactId);

  const renamed = await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      title: "Contact identity guard",
      contacts: [{ name: "Renamed Contact", primary: true }]
    }
  });
  assert.equal(renamed.document.data.contacts.length, 1);
  assert.equal(renamed.document.data.contacts[0].name, "Renamed Contact");
  assert.equal(renamed.document.data.contacts[0].id, contactId);
  assert.equal(renamed.document.data.contact_id, contactId);

  const legacySplit = await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      title: "Contact identity guard",
      contact_id: contactId,
      primary_contact_id: contactId,
      customer_name: "Renamed Contact",
      contacts: [
        { id: contactId, contact_id: contactId, name: "Renamed Contact", primary: true },
        { name: "Renamed Contact" }
      ]
    }
  });
  assert.equal(legacySplit.document.data.contacts.length, 1);
  assert.equal(legacySplit.document.data.contacts[0].id, contactId);

  const fetched = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  assert.equal(fetched.document.data.contacts.length, 1);
  assert.equal(fetched.document.data.contacts[0].id, contactId);
  assert.ok(fetched.document.data.contacts.every((contact: any) => contact.id && contact.contact_id));
});

test("media files are served with byte ranges so video seeking works", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_media_ranges";
  const payload = Buffer.from(Array.from({ length: 512 }, (_, index) => index % 251));
  const upload = await client.request("POST", `/v1/platform/organizations/${orgId}/media`, {
    owner_type: "project",
    owner_id: projectId,
    slot: "photos",
    collection: "projects",
    scope: "projects",
    file_name: "clip.mp4",
    content_type: "video/mp4",
    base64: payload.toString("base64")
  });
  const mediaId = upload.media.id;
  const fileUrl = `/v1/platform/organizations/${orgId}/media/${mediaId}/file`;

  // A browser <video> reports an empty seekable range unless the server
  // advertises range support, which breaks scrubbing and canvas capture.
  const full = await client.raw("GET", fileUrl);
  assert.equal(full.statusCode, 200);
  assert.equal(full.headers["accept-ranges"], "bytes");
  assert.equal(full.headers["content-length"], String(payload.length));

  const middle = await client.raw("GET", fileUrl, undefined, { range: "bytes=100-149" });
  assert.equal(middle.statusCode, 206);
  assert.equal(middle.headers["content-range"], `bytes 100-149/${payload.length}`);
  assert.equal(middle.headers["content-length"], "50");
  assert.equal(Buffer.byteLength(middle.body, "binary"), 50);

  const openEnded = await client.raw("GET", fileUrl, undefined, { range: "bytes=500-" });
  assert.equal(openEnded.statusCode, 206);
  assert.equal(openEnded.headers["content-range"], `bytes 500-511/${payload.length}`);

  const suffix = await client.raw("GET", fileUrl, undefined, { range: "bytes=-8" });
  assert.equal(suffix.statusCode, 206);
  assert.equal(suffix.headers["content-range"], `bytes 504-511/${payload.length}`);

  const unsatisfiable = await client.raw("GET", fileUrl, undefined, { range: "bytes=9000-9100" });
  assert.equal(unsatisfiable.statusCode, 416);
  assert.equal(unsatisfiable.headers["content-range"], `bytes */${payload.length}`);
});

test("media can be renamed without disturbing tags or stored bytes", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_media_rename";
  const upload = await client.request("POST", `/v1/platform/organizations/${orgId}/media`, {
    owner_type: "project",
    owner_id: projectId,
    slot: "photos",
    collection: "projects",
    scope: "projects",
    file_name: "DSC_0001.mp4",
    content_type: "video/mp4",
    base64: Buffer.from("test-video-bytes").toString("base64")
  });
  const mediaId = upload.media.id;
  await client.request("PATCH", `/v1/platform/organizations/${orgId}/media/${mediaId}`, { tags: ["roof"] });

  const renamed = await client.request("PATCH", `/v1/platform/organizations/${orgId}/media/${mediaId}`, {
    name: "Front elevation walkthrough"
  });
  assert.equal(renamed.media.label, "Front elevation walkthrough");
  // The extension is preserved so downloads still open in the right app.
  assert.equal(renamed.media.file_name, "Front elevation walkthrough.mp4");
  assert.deepEqual(renamed.media.tags, ["roof"]);

  // Downloads read the variant file name, so it must follow the rename.
  const download = await client.raw("GET", `/v1/platform/organizations/${orgId}/media/${mediaId}/file`);
  assert.equal(download.statusCode, 200);
  assert.match(String(download.headers["content-disposition"]), /Front elevation walkthrough\.mp4/);
  assert.equal(download.body, "test-video-bytes");

  // A user typing the extension themselves must not double it up.
  const withExtension = await client.request("PATCH", `/v1/platform/organizations/${orgId}/media/${mediaId}`, {
    name: "Rear elevation.mp4"
  });
  assert.equal(withExtension.media.file_name, "Rear elevation.mp4");

  // Path separators must never reach the stored name.
  const unsafe = await client.request("PATCH", `/v1/platform/organizations/${orgId}/media/${mediaId}`, {
    name: "../../escape/attempt"
  });
  assert.ok(!String(unsafe.media.file_name).includes("/"));
  assert.ok(!String(unsafe.media.file_name).includes(".."));

  const blank = await client.raw("PATCH", `/v1/platform/organizations/${orgId}/media/${mediaId}`, { name: "   " });
  assert.equal(blank.statusCode, 400);
});

test("customer portal photo shares include markup by default with an API-only opt-out", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_portal_markup_policy";
  const upload = await client.request("POST", `/v1/platform/organizations/${orgId}/media`, {
    owner_type: "project",
    owner_id: projectId,
    slot: "photos",
    collection: "projects",
    scope: "projects",
    file_name: "portal-photo.png",
    content_type: "image/png",
    base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
  });
  const mediaId = upload.media.id;
  const markup = {
    schema: 1,
    items: [{ id: "stroke_portal", type: "stroke", color: "#d93025", size: 2.2, points: [{ x: 0.1, y: 0.2 }, { x: 0.8, y: 0.7 }] }]
  };
  const marked = await client.request("PUT", `/v1/platform/organizations/${orgId}/media/${mediaId}/markup/photo_markup`, { data: markup });
  assert.ok(marked.media.variants.original);
  assert.ok(marked.media.variants.thumb_320_markup);
  assert.equal(marked.media.markup_thumbnail.revision, marked.layer.revision);
  const markedThumbnail = await client.raw("GET", `/v1/platform/organizations/${orgId}/media/${mediaId}/file?variant=thumb_320_markup`);
  assert.equal(markedThumbnail.statusCode, 200);
  assert.notEqual(markedThumbnail.body, "");
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "12 Markup Way",
      photos: [{ id: mediaId, media_id: mediaId, media_type: "image", label: "Marked photo" }]
    }
  });

  const shared = await client.request("PATCH", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`, {
    share_media_ids: [mediaId]
  });
  assert.equal(shared.portal.shared_items[0].include_markup, true);
  const publicWithMarkup = await client.request("GET", `/v1/platform/customer-portals/${shared.portal.public_uuid}`);
  assert.equal(publicWithMarkup.media[0].include_markup, true);
  assert.deepEqual(publicWithMarkup.media[0].markup, markup);
  assert.match(publicWithMarkup.media[0].thumb, /variant=thumb_320_markup/);
  assert.match(publicWithMarkup.media[0].thumb, new RegExp(`v=${marked.layer.revision}(?:&|$)`));

  const rawOnly = await client.request("PATCH", `/v1/platform/organizations/${orgId}/projects/${projectId}/customer-portal`, {
    share_media_ids: [mediaId],
    include_markup: false
  });
  assert.equal(rawOnly.portal.shared_items[0].include_markup, false);
  const publicWithoutMarkup = await client.request("GET", `/v1/platform/customer-portals/${rawOnly.portal.public_uuid}`);
  assert.equal(publicWithoutMarkup.media[0].include_markup, false);
  assert.deepEqual(publicWithoutMarkup.media[0].markup, {});
  assert.match(publicWithoutMarkup.media[0].thumb, /variant=thumb_320(?:&|$)/);

  const cleared = await client.request("PUT", `/v1/platform/organizations/${orgId}/media/${mediaId}/markup/photo_markup`, {
    data: { schema: 1, items: [] }
  });
  assert.ok(cleared.layer.revision > marked.layer.revision);
  assert.equal(cleared.media.markup_thumbnail.revision, cleared.layer.revision);
  assert.ok(cleared.media.variants.original);
  assert.ok(cleared.media.variants.thumb_320_markup);
  const clearedThumbnail = await client.raw("GET", `/v1/platform/organizations/${orgId}/media/${mediaId}/file?variant=thumb_320_markup`);
  assert.equal(clearedThumbnail.statusCode, 200);
  assert.notEqual(clearedThumbnail.body, markedThumbnail.body);
});

test("application access is enforced independently from authentication and organization permissions", async () => {
  const client = createSessionClient();
  const { orgId, userId, email } = await register(client);
  const { upsertDocument } = await import("../platform/storage.js");
  await client.request("PUT", `/v1/platform/organizations/${orgId}/branch/default`, {
    data: {
      name: "Field Brand",
      branding: {
        logo: "https://cdn.example.test/field-brand.png",
        colors: { primary: "#2468ac", secondary: "#13579b" }
      }
    }
  });
  await upsertDocument(orgId, "users", {
    id: userId,
    data: {
      application_access: {
        management: { enabled: false, role_id: "member", permissions: {} },
        field: { enabled: true, role_id: "worker", permissions: { view_assignments: true } }
      }
    }
  }, { replace: false });

  const session = await client.request("GET", "/v1/platform/me");
  assert.equal(session.authenticated, true);
  assert.equal(session.user.application_access.management.enabled, false);
  assert.equal(session.user.application_access.field.enabled, true);
  assert.equal(session.branch.data.branding.colors.primary, "#2468ac");
  assert.equal(session.branch.data.branding.logo, "https://cdn.example.test/field-brand.png");

  const shellFlags = await client.request("GET", `/v1/platform/organizations/${orgId}/app-flags`);
  assert.equal(shellFlags.ok, true);

  const managementApi = await client.raw("GET", `/v1/platform/organizations/${orgId}/projects`);
  assert.equal(managementApi.statusCode, 403);
  assert.equal(managementApi.data.error, "application_access_denied");

  const portalBridge = await client.raw("POST", "/v1/platform/portal-action", {
    action: "get_credits",
    actor_email: email,
    actor_org_id: orgId
  });
  assert.equal(portalBridge.statusCode, 403);
  assert.equal(portalBridge.data.error, "application_access_denied");

  const authStatus = await client.request("POST", "/v1/platform/portal-action", { action: "auth_status" });
  assert.equal(authStatus.authenticated, true);
  assert.equal(authStatus.application_access.management.enabled, false);
});

test("view-only management users cannot mutate protected canonical documents", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await register(client);
  const projectId = "project_viewer_write_denied";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Viewer write guard" }
  });

  const { upsertDocument } = await import("../platform/storage.js");
  await upsertDocument(orgId, "users", {
    id: userId,
    data: {
      role: "viewer",
      org_permission_level: "viewer",
      org_permissions: { level: "viewer", items: { view_projects: true } },
      permissions: { view_projects: true },
      access_role_ids: ["viewer"],
      application_access: {
        management: { enabled: true, role_id: "viewer", permissions: {} },
        field: { enabled: false, role_id: "", permissions: {} }
      },
      permission_overrides: {}
    }
  }, { replace: false });

  const readable = await client.raw("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  assert.equal(readable.statusCode, 200);
  assert.equal(readable.data.document.data.title, "Viewer write guard");

  for (const [method, payload] of [
    ["PUT", { data: { id: projectId, title: "Replaced by viewer" } }],
    ["PATCH", { data: { title: "Patched by viewer" } }],
    ["DELETE", undefined]
  ] as const) {
    const denied = await client.raw(method, `/v1/platform/organizations/${orgId}/projects/${projectId}`, payload);
    assert.equal(denied.statusCode, 403, `${method} unexpectedly mutated a project`);
    assert.equal(denied.data.error, "permission_denied");
  }

  const unchanged = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  assert.equal(unchanged.document.data.title, "Viewer write guard");

  const adjacentWrites = [
    ["POST", `/v1/platform/organizations/${orgId}/customers`, { data: { id: "customer_viewer_denied", name: "Denied" } }],
    ["POST", `/v1/platform/organizations/${orgId}/notifications`, { id: "notification_viewer_denied", title: "Denied" }],
    ["PUT", `/v1/platform/organizations/${orgId}/calendar_events/event_viewer_denied`, { data: { title: "Denied" } }]
  ] as const;
  for (const [method, url, payload] of adjacentWrites) {
    const denied = await client.raw(method, url, payload);
    assert.equal(denied.statusCode, 403, `${method} ${url} unexpectedly succeeded`);
    assert.equal(denied.data.error, "permission_denied");
  }

  const tracked = await client.request("POST", `/v1/platform/organizations/${orgId}/activity`, {
    data: { type: "viewer_activity", summary: "Viewer may append activity" }
  });
  const activityId = String(tracked.document.id || "");
  assert.ok(activityId);
  for (const [method, payload] of [
    ["PUT", { data: { summary: "Viewer replaced activity" } }],
    ["PATCH", { data: { summary: "Viewer patched activity" } }],
    ["DELETE", undefined]
  ] as const) {
    const denied = await client.raw(method, `/v1/platform/organizations/${orgId}/activity/${activityId}`, payload);
    assert.equal(denied.statusCode, 403, `${method} unexpectedly mutated activity history`);
    assert.equal(denied.data.error, "permission_denied");
  }

  const unknown = await client.raw("GET", `/v1/platform/organizations/${orgId}/not_a_platform_collection`);
  assert.equal(unknown.statusCode, 400);
  assert.equal(unknown.data.error, "unsupported_platform_collection");
});

test("Portal queue rejects commercial reports with more than ten pins", async () => {
  const client = createSessionClient();
  const { orgId, email } = await register(client, false);
  const pins = Array.from({ length: 11 }, (_, index) => ({
    lat: 47.61 + index * 0.0001,
    lng: -122.33 - index * 0.0001
  }));

  const response = await client.raw("POST", "/v1/platform/portal-action", {
      action: "queue",
      actor_email: email,
      actor_name: "Owner User",
      actor_org_id: orgId,
      address: "10 Structure Limit Way, Seattle, WA",
      project_type: "commercial",
      report_mode: "full",
      pins: JSON.stringify(pins)
  });
  const body = response.data;

  assert.equal(response.statusCode, 400);
  assert.equal(body.success, false);
  assert.equal(body.error, "pin_limit_exceeded");
  assert.equal(body.max_pins, 10);
  assert.equal(body.pin_count, 11);
});

test("Portal queue rejects residential reports with more than five pins", async () => {
  const client = createSessionClient();
  const { orgId, email } = await register(client, false);
  const pins = Array.from({ length: 6 }, (_, index) => ({
    lat: 47.62 + index * 0.0001,
    lng: -122.34 - index * 0.0001
  }));

  const response = await client.raw("POST", "/v1/platform/portal-action", {
      action: "queue",
      actor_email: email,
      actor_name: "Owner User",
      actor_org_id: orgId,
      address: "5 Pin Limit Way, Seattle, WA",
      project_type: "residential",
      report_mode: "full",
      pins: JSON.stringify(pins)
  });
  const body = response.data;

  assert.equal(response.statusCode, 400);
  assert.equal(body.success, false);
  assert.equal(body.error, "pin_limit_exceeded");
  assert.equal(body.max_pins, 5);
  assert.equal(body.pin_count, 6);
});

test("Portal queue applies additional structure time to commercial expedite deadlines", async () => {
  const client = createSessionClient();
  const { orgId, email } = await register(client, false);
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      credits_balance: 100,
      app_flags: {
        firstmeasure: {
          report_expedite_options: true
        }
      }
    }
  }, { replace: false });

  const pins = [
    { lat: 47.6101, lng: -122.3301 },
    { lat: 47.6102, lng: -122.3302 },
    { lat: 47.6103, lng: -122.3303 }
  ];

  const queued = await client.request("POST", "/v1/platform/portal-action", {
    action: "queue",
    actor_email: email,
    actor_name: "Owner User",
    actor_org_id: orgId,
    address: "3 Structure Commercial Way, Seattle, WA",
    project_type: "commercial",
    report_mode: "full",
    report_expedite_option: "rush_1_3",
    is_expedited: "1",
    pins: JSON.stringify(pins)
  });

  assert.equal(queued.success, true);
  assert.equal(queued.manifest.project_type, "commercial");
  assert.equal(queued.manifest.report_expedite_option, "rush_1_3");
  assert.equal(queued.manifest.pins.length, 3);
  const submittedMs = Date.parse(`${String(queued.manifest.timestamps.created_at).replace(" ", "T")}Z`);
  const dueStartMs = Date.parse(queued.manifest.report_due_window_start);
  const productionDeadlineMs = Date.parse(queued.manifest.report_production_deadline_at);
  const dueEndMs = Date.parse(queued.manifest.report_due_window_end);
  assert.ok(dueStartMs - submittedMs >= 119 * 60_000, queued.manifest);
  assert.ok(dueStartMs - submittedMs <= 121 * 60_000, queued.manifest);
  assert.equal(productionDeadlineMs - dueStartMs, 60 * 60_000);
  assert.equal(dueEndMs - dueStartMs, 120 * 60_000);
});

test("Platform project event scheduling advances the pipeline stage", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await register(client);
  const projectId = "project_trigger_stage";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "100 Test Lane",
      events: []
    },
    metadata: { kind: "platform_project" }
  });

  const scheduled = await client.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    branch_id: "default",
    event: {
      id: "event_sales_test",
      event_type_default_id: "sales_appointment",
      start_at: new Date(Date.now() + 60_000).toISOString(),
      duration_minutes: 60,
      required_role_ids: ["sales_appointments"],
      allowed_role_ids: ["sales_appointments"],
      assigned_user_ids: []
    }
  });

  assert.equal(scheduled.event.event_type_default_id, "sales_appointment");
  assert.equal(scheduled.event.scheduled_by_user_id, userId);
  assert.equal(scheduled.project.events.length, 1);
  // Scheduling the sales appointment completes the pipeline's contact_lead
  // node through its external trigger, advancing the card to the
  // appointment stage — no platform trigger engine involved.
  const pipelineInstance = scheduled.project.work_projection.active_instances
    .find((instance: any) => instance.kind === "pipeline");
  assert.equal(pipelineInstance.template_id, "sales_pipeline");
  assert.equal(pipelineInstance.stage_id, "appointment_stage");
});

test("Platform project events can be deleted without replacing the project", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_delete_event";
  const eventId = "event_delete_test";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Delete Test", address: "102 Test Lane", events: [] },
    metadata: { kind: "platform_project" }
  });
  await client.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: eventId,
      event_type_default_id: "project_work",
      title: "Temporary Work",
      start_at: new Date(Date.now() + 60_000).toISOString(),
      duration_minutes: 60
    }
  });

  const deleted = await client.request("DELETE", `/v1/platform/organizations/${orgId}/projects/${projectId}/events/${eventId}`);

  assert.equal(deleted.deleted, true);
  assert.equal(deleted.event.id, eventId);
  assert.equal(deleted.project.id, projectId);
  assert.equal(deleted.project.address, "102 Test Lane");
  assert.equal(deleted.project.events.some((event: any) => event.id === eventId), false);
});

test("Project work cannot assign itself as its crew resource", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_self_assigned_work";
  const eventId = "event_self_assigned_work";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, address: "101 Resource Lane", events: [] },
    metadata: { kind: "platform_project" }
  });

  const scheduled = await client.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event: {
      id: eventId,
      event_type_default_id: "project_work",
      title: "Roofing Labor",
      start_at: new Date(Date.now() + 60_000).toISOString(),
      duration_minutes: 120,
      work_resource_ref: { kind: "project_work", id: eventId, name: eventId },
      assigned_resource_kind: "project_work",
      assigned_resource_id: eventId,
      assigned_resource_name: eventId,
      assigned_crew_id: eventId,
      assigned_crew_name: eventId,
      assigned_crew: { id: eventId, name: eventId },
      crew_id: eventId,
      crew_name: eventId,
      resource_id: eventId,
      resource_name: eventId,
      assignee_label: eventId
    }
  });

  assert.equal(scheduled.event.work_resource_ref, null);
  assert.equal(scheduled.event.assigned_resource_id, "");
  assert.equal(scheduled.event.assigned_crew_id, "");
  assert.equal(scheduled.event.assigned_crew, null);
  assert.equal(scheduled.event.crew_id, "");
  assert.equal(scheduled.event.resource_id, "");
  assert.equal(scheduled.event.assignee_label, "");
});

test("Acquisition campaign attribution follows landing traffic through signup and spend", async () => {
  const client = createSessionClient();
  const landingPages = await client.request("GET", "/v1/internal/crm/referrals/acquisition/landing-pages");
  assert.equal(landingPages.success, true);
  assert.ok(landingPages.landing_pages.some((page: any) => page.url_path === "/portal/landing/variants/measurements/"));

  const campaign = await client.request("POST", "/v1/internal/crm/referrals/acquisition/campaigns", {
    display_name: "Facebook Roof Measurements - June",
    code: "fb-roof-measurements-june",
    campaign_type: "facebook",
    channel: "facebook",
    status: "active",
    landing_page: "/portal/landing/variants/measurements/",
    landing_variant: "measurements",
    notes: "Test campaign for analytics reporting"
  });
  assert.equal(campaign.success, true);
  assert.equal(campaign.campaign.type, "acquisition_campaign");
  assert.equal(campaign.campaign.primary_code.code, "fb-roof-measurements-june");

  const campaigns = await client.request("GET", "/v1/internal/crm/referrals/acquisition/campaigns");
  assert.ok(campaigns.campaigns.some((entry: any) => entry.id === campaign.campaign.id));

  const tracked = await client.request("POST", "/v1/platform/acquisition/public/track", {
    campaign: "fb-roof-measurements-june",
    campaign_type: "facebook",
    landing_variant: "measurements",
    landing_page: "/portal/landing/",
    page_url: "https://1m8.ai/portal/landing/?variant=measurements&utm_source=facebook&utm_campaign=fb-roof-measurements-june",
    utm_source: "facebook",
    utm_medium: "paid_social",
    utm_campaign: "fb-roof-measurements-june",
    fbclid: "fbclid_test",
    browser_language: "en-US",
    timezone: "America/Los_Angeles",
    viewport_width: "1440",
    viewport_height: "900",
    screen_width: "1440",
    screen_height: "900",
    connection_effective_type: "4g",
    metadata: {
      browser: {
        browser_language: "en-US",
        timezone: "America/Los_Angeles",
        viewport_width: 1440
      }
    }
  }, {
    "user-agent": "CampaignMetadataTest/1.0",
    "accept-language": "en-US,en;q=0.9",
    "x-forwarded-for": "203.0.113.10, 10.0.0.1",
    "cf-ipcountry": "US",
    "x-vercel-ip-city": "Los Angeles",
    "x-vercel-ip-country-region": "CA"
  });
  assert.equal(tracked.success, true);
  assert.ok(tracked.acquisition_attribution_id);
  assert.equal(tracked.source_type, "marketing");
  const viewMetadata = readAttributionMetadata(tracked.acquisition_attribution_id);
  assert.equal(viewMetadata.user_agent, "CampaignMetadataTest/1.0");
  assert.equal(viewMetadata.client_ip, "203.0.113.10");
  assert.equal(viewMetadata.cf_ipcountry, "US");
  assert.equal(viewMetadata.x_vercel_ip_city, "Los Angeles");
  assert.equal(viewMetadata.browser_language, "en-US");
  assert.equal(viewMetadata.timezone, "America/Los_Angeles");
  assert.equal(viewMetadata.viewport_width, "1440");
  assert.equal((viewMetadata.request as any)?.headers?.["user-agent"], "CampaignMetadataTest/1.0");
  assert.equal((viewMetadata.browser as any)?.viewport_width, 1440);

  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `campaign-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Campaign Owner",
    company: "Campaign Attribution Co",
    organization_id: `org_campaign_${suffix}`,
    acquisition_code: tracked.link.code,
    acquisition_attribution_id: tracked.acquisition_attribution_id,
    campaign: "fb-roof-measurements-june",
    campaign_type: "facebook",
    landing_variant: "measurements",
    utm_source: "facebook",
    utm_medium: "paid_social",
    utm_campaign: "fb-roof-measurements-june",
    fbclid: "fbclid_test",
    browser_language: "en-US",
    timezone: "America/Los_Angeles",
    viewport_width: "1366",
    viewport_height: "768",
    attribution_metadata: JSON.stringify({
      browser: {
        browser_language: "en-US",
        timezone: "America/Los_Angeles",
        viewport_width: 1366
      }
    })
  }, {
    "user-agent": "CampaignSignupMetadataTest/1.0",
    "x-forwarded-for": "198.51.100.20",
    "cf-ipcountry": "US"
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  const orgId = String(registered.organization.id);
  const { readOrganization } = await import("../platform/storage.js");
  const organization = await readOrganization(orgId);
  assert.equal(organization.acquisition_source_type, "marketing");
  assert.equal(organization.acquisition_attribution_id, tracked.acquisition_attribution_id);
  assert.equal(organization.acquisition_landing_variant, "measurements");
  assert.equal(organization.referral_attribution_id, undefined);
  const acquisitionMetadata = organization.acquisition_metadata as any;
  assert.equal(acquisitionMetadata.user_agent, "CampaignSignupMetadataTest/1.0");
  assert.equal(acquisitionMetadata.client_ip, "198.51.100.20");
  assert.equal(acquisitionMetadata.browser_language, "en-US");
  assert.equal(acquisitionMetadata.viewport_width, "1366");
  assert.equal(acquisitionMetadata.browser.viewport_width, 1366);

  await client.request("POST", `/v1/platform/organizations/${orgId}/credits/adjust`, {
    amount: 100,
    reason: "test_credit",
    meta: { acquisition_attribution_id: tracked.acquisition_attribution_id }
  });
  await client.request("POST", `/v1/platform/organizations/${orgId}/credits/charge`, {
    amount: 19,
    reason: "order_submitted",
    meta: { project_id: "project_campaign_order" }
  });
  const credits = await client.request("GET", `/v1/platform/organizations/${orgId}/credits?limit=10`);
  assert.ok(credits.ledger.some((entry: any) => entry.reason === "order_submitted" && entry.delta === -19));

  const today = new Date().toISOString().slice(0, 10);
  const report = await client.request("GET", `/v1/internal/crm/referrals/acquisition/report?campaign_id=${encodeURIComponent(campaign.campaign.id)}&start_date=${today}&end_date=${today}`);
  assert.equal(report.success, true);
  assert.equal(report.selected_campaign_id, campaign.campaign.id);
  assert.equal(report.summary.campaigns, 1);
  assert.equal(report.summary.views, 1);
  assert.equal(report.summary.signups, 1);
  assert.equal(report.summary.spend, 19);
  assert.equal(report.summary.conversion_rate, 1);
  assert.ok(report.daily.some((row: any) => row.signups === 1 && row.spend === 19));
  assert.equal(report.hourly.length, 24);
  assert.ok(report.landing_pages.some((row: any) => row.label === "/portal/landing/" && row.signups === 1));
  assert.ok(report.browsers.some((row: any) => row.label === "Other" && row.count >= 1));
  assert.ok(report.countries.some((row: any) => row.label === "US" && row.count >= 1));
  assert.ok(report.raw.attributions.some((row: any) => row.attribution_id === tracked.acquisition_attribution_id && row.client_ip === "203.0.113.10"));
  assert.ok(report.raw.signups.some((row: any) => row.org_id === orgId && row.spend === 19));
  assert.ok(report.raw.spend_ledger.some((row: any) => row.org_id === orgId && row.amount === 19));
  assert.deepEqual(report.campaign_breakdown.map((row: any) => ({
    id: row.id,
    views: row.views,
    signups: row.signups,
    spend: row.spend
  })), [{
    id: campaign.campaign.id,
    views: 1,
    signups: 1,
    spend: 19
  }]);

  const updatedCampaign = await client.request("POST", "/v1/internal/crm/referrals/acquisition/campaigns", {
    id: campaign.campaign.id,
    display_name: "Facebook Roof Measurements - June Updated",
    code: "fb-roof-measurements-june-updated",
    campaign_type: "facebook",
    channel: "facebook",
    status: "active",
    landing_page: "/portal/landing/variants/customer-referral/",
    landing_variant: "customer-referral",
    notes: "Updated campaign settings"
  });
  assert.equal(updatedCampaign.success, true);
  assert.equal(updatedCampaign.campaign.display_name, "Facebook Roof Measurements - June Updated");
  assert.equal(updatedCampaign.campaign.primary_code.code, "fb-roof-measurements-june-updated");
  assert.equal(updatedCampaign.campaign.landing_page, "/portal/landing/variants/customer-referral/");

  const autoCodeCampaign = await client.request("POST", "/v1/internal/crm/referrals/acquisition/campaigns", {
    display_name: "Google Measurement Search",
    code: "",
    campaign_type: "google",
    channel: "google",
    landing_page: "/portal/landing/variants/measurements/"
  });
  assert.equal(autoCodeCampaign.success, true);
  assert.ok(autoCodeCampaign.campaign.primary_code.code);
  assert.equal(autoCodeCampaign.campaign.primary_code.code, "GOOGLE-MEASUREMENT-SEARCH");
});

test("Portal onboarding defers signup OTP to final step and records workflow events", async () => {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const email = `onboarding-${suffix}@example.test`;
  const correctedEmail = `onboarding-corrected-${suffix}@example.test`;
  const registered = await client.request("POST", "/v1/platform/auth/legacy-action", {
    phone: nextTestPhone(),
    action: "register",
    email,
    password: "correct horse battery staple",
    name: "Onboarding Owner",
    company: "Onboarding Test Org"
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  assert.equal(registered.success, true);
  assert.equal(registered.first_login, true);
  const orgId = String(registered.organization.id);

  const blocked = await client.request("POST", "/v1/platform/portal-action", {
    action: "onboarding_complete",
    actor_email: email,
    actor_org_id: orgId,
    did_purchase: "0",
    did_add_card: "0"
  });
  assert.equal(blocked.success, false);
  assert.equal(blocked.require_signup_otp, true);

  const tracked = await client.request("POST", "/v1/platform/portal-action", {
    action: "onboarding_track",
    actor_email: email,
    actor_org_id: orgId,
    session_id: `test_session_${suffix}`,
    events_json: JSON.stringify([
      {
        event_name: "step_view",
        step: "branding",
        step_index: 0,
        occurred_at: new Date().toISOString(),
        device: { is_mobile: false, viewport_width: 1440 }
      },
      {
        event_name: "field_input",
        step: "account_load",
        step_index: 2,
        target: "obCustomAmount",
        label: "Custom",
        occurred_at: new Date().toISOString(),
        metadata: {
          control: { id: "obCustomAmount", type: "text" },
          field_value: { value_number: 175, input_type: "text" },
          account_load: { custom_amount: 175, selected_amount: 175 }
        }
      }
    ])
  });
  assert.equal(tracked.success, true);
  assert.equal(tracked.saved, 2);

  const started = await client.request("POST", "/v1/platform/portal-action", {
    action: "onboarding_signup_verification_start",
    actor_email: email,
    actor_org_id: orgId,
    email: correctedEmail
  });
  assert.equal(started.success, true);
  assert.equal(started.email, correctedEmail);
  assert.equal(typeof started.dev_otp, "string");

  const confirmed = await client.request("POST", "/v1/platform/portal-action", {
    action: "onboarding_signup_verification_confirm",
    actor_email: email,
    actor_org_id: orgId,
    email: correctedEmail,
    otp: started.dev_otp,
    did_purchase: "0",
    did_add_card: "0"
  });
  assert.equal(confirmed.success, true);
  assert.equal(confirmed.verified, true);
  assert.equal(confirmed.email, correctedEmail);

  const { findIdentityByEmail, listDocuments, readGlobal } = await import("../platform/storage.js");
  const identity = await findIdentityByEmail(correctedEmail);
  assert.equal(identity.email, correctedEmail);
  assert.equal((identity.metadata as any).email_verified, true);

  const global = await readGlobal(orgId);
  assert.equal((global.data as any).onboarding_completed, true);

  const events = await listDocuments(orgId, "onboarding_events");
  assert.equal(events.length, 2);
  assert.ok(events.some((event) => (event.data as any).event_name === "step_view"));
  const fieldEvent = events.find((event) => (event.data as any).event_name === "field_input");
  assert.equal((fieldEvent!.data as any).target, "obCustomAmount");
  assert.equal(((fieldEvent!.data as any).metadata as any).field_value.value_number, 175);
});

test("Internal campaign tools clone landing page variants", async () => {
  const client = createSessionClient();
  const previousRoot = process.env.PORTAL_LANDING_ROOT;
  const landingRoot = path.join(storageRoot, "landing-clone-root");
  await mkdir(path.join(landingRoot, "variants", "measurements"), { recursive: true });
  await writeFile(path.join(landingRoot, "index.php"), "<?php\n$variants = [\n    'measurements' => __DIR__ . '/variants/measurements/index.php',\n];\n", "utf8");
  await writeFile(path.join(landingRoot, "variants", "measurements", "index.php"), "<?php echo 'measurements';\n", "utf8");
  process.env.PORTAL_LANDING_ROOT = landingRoot;
  try {
    const cloned = await client.request("POST", "/v1/internal/crm/referrals/acquisition/landing-pages/clone", {
      slug: "Facebook Summer",
      source_url_path: "/portal/landing/variants/measurements/"
    });
    assert.equal(cloned.success, true);
    assert.equal(cloned.landing_page.variant, "facebook-summer");
    assert.equal(cloned.landing_page.url_path, "/portal/landing/variants/facebook-summer/");
    const clonedFile = await readFile(path.join(landingRoot, "variants", "facebook-summer", "index.php"), "utf8");
    assert.equal(clonedFile, "<?php echo 'measurements';\n");
    const router = await readFile(path.join(landingRoot, "index.php"), "utf8");
    assert.ok(router.includes("'facebook-summer' => __DIR__ . '/variants/facebook-summer/index.php'"));
  } finally {
    if (previousRoot == null) delete process.env.PORTAL_LANDING_ROOT;
    else process.env.PORTAL_LANDING_ROOT = previousRoot;
  }
});

test("Referral links remain compatible while storing acquisition attribution", async () => {
  const { saveReferralPartner } = await import("../internal/crm/referrals.js");
  const partner = await saveReferralPartner({
    display_name: "Referral Campaign Source",
    type: "manufacturer_rep",
    status: "active",
    contact_email: "referral-source@example.test",
    new_org_offer_id: "referral_week_discount_v1"
  }) as any;
  const client = createSessionClient();
  const lookup = await client.request("GET", `/v1/platform/referrals/public/${encodeURIComponent(partner.primary_code.code)}`);
  assert.equal(lookup.success, true);
  assert.ok(lookup.attribution_id);
  assert.ok(lookup.acquisition_attribution_id);

  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `referral-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Referral Owner",
    company: "Referral Attribution Co",
    organization_id: `org_referral_${suffix}`,
    referral_code: partner.primary_code.code,
    referral_attribution_id: lookup.attribution_id
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  const orgId = String(registered.organization.id);
  const { readGlobal, readOrganization } = await import("../platform/storage.js");
  const organization = await readOrganization(orgId);
  assert.equal(organization.acquisition_source_type, "referral");
  assert.equal(organization.acquisition_attribution_id, lookup.attribution_id);
  assert.equal(organization.referral_attribution_id, lookup.attribution_id);
  assert.equal(organization.referral_code, partner.primary_code.code);

  const global = await readGlobal(orgId);
  const offer = (global.data as any).offers.items.referral_week_discount_v1;
  assert.equal(offer.status, "active");
  assert.equal(offer.metadata.attribution_id, lookup.attribution_id);
});

test("Custom pipeline templates and intake routing drive custom stage workflows", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);

  // Author a custom pipeline template whose stages react to a custom event
  // and fire a notification automation — all template data, no engine code.
  const sales = await client.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/templates/sales_pipeline`);
  await client.request("PUT", `/v1/scopes/organizations/${orgId}/branches/default/templates/custom_pipeline`, {
    ...sales.template.definition,
    id: "custom_pipeline",
    kind: "pipeline",
    name: "Custom Pipeline",
    work_plan: {
      title: "Custom Pipeline",
      root_nodes: [{
        id: "custom_phase",
        title: "Custom Pipeline",
        terminology_key: "work.phase",
        completion_mode: "all_children",
        children: [
          {
            id: "job_pending_stage",
            title: "Job Pending",
            terminology_key: "work.stage",
            completion_mode: "all_children",
            children: [{
              id: "sell_job",
              title: "Sell the job",
              terminology_key: "work.task",
              actionable: true,
              external_triggers: [{ event: "test.sell_job", transition: "completed" }],
              automation_bindings: {
                onCompleted: [{
                  id: "job_sold_notification",
                  automation: "notification.create.v1",
                  input: {
                    id: "notification_job_sold_{{project.id}}",
                    title: "Job sold",
                    body: "{{project.address}} moved to job sold.",
                    target_role_ids: ["sales_appointments"],
                    manual_dismissible: true
                  }
                }]
              }
            }]
          },
          {
            id: "job_sold_stage",
            title: "Job Sold",
            terminology_key: "work.stage",
            completion_mode: "all_children",
            depends_on: ["job_pending_stage"],
            children: [{ id: "finish_up", title: "Finish up", terminology_key: "work.task", actionable: true }]
          }
        ]
      }]
    }
  });

  // Route all new projects into the custom pipeline.
  await client.request("PUT", `/v1/platform/organizations/${orgId}/branch/default/modules/intake_routing`, {
    data: { default_template_id: "custom_pipeline", rules: [] }
  });

  const projectId = "project_custom_stage";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, address: "200 Custom Way", events: [] },
    metadata: { kind: "platform_project" }
  });
  let project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  let instance = project.document.data.work_projection.active_instances[0];
  assert.equal(instance.template_id, "custom_pipeline");
  assert.equal(instance.stage_id, "job_pending_stage");

  await client.request("POST", `/v1/work/organizations/${orgId}/events/emit`, {
    event: "test.sell_job",
    project_id: projectId,
    payload: { project_id: projectId }
  });

  project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  instance = project.document.data.work_projection.active_instances[0];
  assert.equal(instance.stage_id, "job_sold_stage");

  const notifications = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.ok(notifications.notifications.some((item: any) => item.id === "notification_job_sold_project_custom_stage"));
});

test("scope library keeps installed templates available as bases for additional scopes", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const library = await client.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/library`);
  const roof = library.templates.find((template: any) => template.id === "roof_replacement");
  assert.ok(roof?.definition);
  assert.equal(roof.enabled_count, 1);

  const alternate = {
    ...roof.definition,
    id: "roof_replacement_alternate",
    name: "Roof Replacement - Alternate",
    metadata: {
      ...roof.definition.metadata,
      preset: false,
      based_on_preset: roof.id,
      library_template_id: roof.id
    }
  };
  await client.request("PUT", `/v1/scopes/organizations/${orgId}/branches/default/templates/${alternate.id}`, alternate);

  const refreshed = await client.request("GET", `/v1/scopes/organizations/${orgId}/branches/default/library`);
  const refreshedRoof = refreshed.templates.find((template: any) => template.id === "roof_replacement");
  assert.equal(refreshedRoof.enabled_count, 2);
  assert.deepEqual(new Set(refreshedRoof.installed_scope_ids), new Set(["roof_replacement", "roof_replacement_alternate"]));
  assert.equal(refreshedRoof.definition.id, "roof_replacement");
  assert.equal(refreshedRoof.definition.name, "Roof Replacement");
});

test("Deposit payment fires the roof scope's celebration binding", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);

  // Production-only routing: new projects go straight into the roof
  // replacement scope with no sales pipeline in front of it.
  await client.request("PUT", `/v1/platform/organizations/${orgId}/branch/default/modules/intake_routing`, {
    data: { default_template_id: "roof_replacement", rules: [] }
  });

  const projectId = "project_newly_sold";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: { id: projectId, title: "Bill's Fredo", address: "300 Sold Street", customer_name: "Bill's Fredo", events: [] },
    metadata: { kind: "platform_project" }
  });
  let project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  let instance = project.document.data.work_projection.active_instances[0];
  assert.equal(instance.template_id, "roof_replacement");
  assert.equal(instance.kind, "production");
  assert.equal(instance.stage_id, "signed_pending_payment_stage");

  await client.request("POST", `/v1/work/organizations/${orgId}/events/emit`, {
    event: "payment.received",
    project_id: projectId,
    payload: {
      project_id: projectId,
      payment_kind: "deposit",
      payment_id: "payment_test_deposit",
      amount_cents: 250_000,
      payment: { id: "payment_test_deposit", amount_cents: 250_000, currency: "USD", kind: "deposit" }
    }
  });

  project = await client.request("GET", `/v1/platform/organizations/${orgId}/projects/${projectId}`);
  instance = project.document.data.work_projection.active_instances[0];
  assert.ok(["newly_sold_stage", "scheduled_stage"].includes(instance.stage_id));
  assert.ok(project.document.data.lifecycle.sold_at);

  const notifications = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  const celebration = notifications.notifications.find((item: any) => item.kind === "celebration");
  assert.ok(celebration);
  assert.equal(celebration.celebration.size, "large");
  assert.equal(celebration.celebration.text, "Bill's Fredo paid $2,500.00.");
  assert.equal(celebration.context.celebration.reason, "proposal_paid");
});

test("Notifications target roles and preserve per-user state", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  await client.request("POST", `/v1/platform/organizations/${orgId}/notifications`, {
    id: "notification_role_test",
    title: "Role notification",
    body: "Only sales appointment users should see this.",
    target_role_ids: ["sales_appointments"],
    manual_dismissible: true,
    push: true
  });

  const visible = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.equal(visible.notifications.length, 1);
  assert.equal(visible.unread_count, 1);
  assert.equal(visible.notifications[0].push_log.length, 1);

  await client.request("PATCH", `/v1/platform/organizations/${orgId}/notifications/notification_role_test/user-state`, { seen: true });
  const seen = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.equal(seen.unread_count, 0);
  assert.equal(seen.notifications.length, 1);

  await client.request("PATCH", `/v1/platform/organizations/${orgId}/notifications/notification_role_test/user-state`, { dismissed: true });
  const hidden = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.equal(hidden.notifications.length, 0);
  const included = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications?include_dismissed=1`);
  assert.equal(included.notifications.length, 1);
  assert.ok(included.notifications[0].user_state.dismissed_at);

  await client.request("PATCH", `/v1/platform/organizations/${orgId}/notifications/notification_role_test/user-state`, { dismissed: false });
  const restored = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.equal(restored.notifications.length, 1);
  assert.equal(restored.notifications[0].user_state.dismissed_at, undefined);
});

test("mention events create notifications, including self-mentions", async () => {
  const client = createSessionClient();
  const { orgId, userId, email } = await register(client);
  const mentioned = await client.request("POST", `/v1/platform/organizations/${orgId}/tagging/mention-events`, {
    source: "project_note",
    target_user_ids: [userId],
    mention_users: [{ id: userId, name: "Owner User", email }],
    context: { project_id: "project_self_mention", project_title: "Self Mention Project", project_tab: "materials", note_id: "note_self_mention" },
    comment: { id: "note_self_mention", text: "Reminder for @Owner User" }
  });

  assert.equal(mentioned.ok, true);
  assert.deepEqual(mentioned.event.target_user_ids, [userId]);
  assert.equal(mentioned.notification.data.kind, "mention");
  assert.deepEqual(mentioned.notification.data.target_user_ids, [userId]);
  assert.equal(mentioned.notification.data.push_log[0].user_id, userId);
  assert.deepEqual(mentioned.notification.data.frontend_action, {
    kind: "open_project_note",
    project_id: "project_self_mention",
    project_tab: "materials",
    note_id: "note_self_mention"
  });

  const visible = await client.request("GET", `/v1/platform/organizations/${orgId}/notifications`);
  assert.equal(visible.unread_count, 1);
  assert.equal(visible.notifications.length, 1);
  assert.equal(visible.notifications[0].kind, "mention");
  assert.equal(visible.notifications[0].context.mention_source, "project_note");
  assert.equal(visible.notifications[0].context.project_id, "project_self_mention");
});

test("Action items are org-scoped, assignment-filtered, and keep per-user state", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const created = await client.request("POST", `/v1/platform/organizations/${orgId}/action-items`, {
    id: "action_item_manual_followup",
    kind: "manual_followup",
    title: "Call the homeowner",
    body: "Confirm the appointment details.",
    due_at: "2026-06-30T16:00:00.000Z",
    assigned_role_ids: ["sales_appointments"],
    assigned_resource_group_ids: ["resource_group_action_items"],
    project_ids: ["project_action_manual"],
    contact_refs: [{ project_id: "project_action_manual", name: "Jane Contact", email: "jane@example.test" }],
    frontend_action: { kind: "open_project", project_id: "project_action_manual" }
  });
  assert.equal(created.action_item.kind, "manual_followup");
  assert.equal(created.action_item.external_id, "action_item_manual_followup");
  assert.deepEqual(created.action_item.assigned_resource_group_ids, ["resource_group_action_items"]);
  const actionItemId = created.action_item.id;
  assert.ok(actionItemId);

  const { listDocuments } = await import("../platform/storage.js");
  assert.deepEqual(await listDocuments(orgId, "action_items"), []);

  const visible = await client.request("GET", `/v1/platform/organizations/${orgId}/action-items?project_id=project_action_manual`);
  assert.equal(visible.action_items.length, 1);
  assert.equal(visible.action_items[0].title, "Call the homeowner");
  assert.equal(visible.unread_count, 1);

  await client.request("PATCH", `/v1/platform/organizations/${orgId}/action-items/${actionItemId}/user-state`, { seen: true, pinned: true });
  const seen = await client.request("GET", `/v1/platform/organizations/${orgId}/action-items?project_id=project_action_manual`);
  assert.equal(seen.unread_count, 0);
  assert.equal(seen.action_items[0].user_state.pinned, true);

  await client.request("POST", `/v1/platform/organizations/${orgId}/action-items/${actionItemId}/complete`, { reason: "done_in_test" });
  const hidden = await client.request("GET", `/v1/platform/organizations/${orgId}/action-items?project_id=project_action_manual`);
  assert.equal(hidden.action_items.length, 0);
  const completed = await client.request("GET", `/v1/platform/organizations/${orgId}/action-items?project_id=project_action_manual&include_completed=1`);
  assert.equal(completed.action_items[0].status, "completed");
  assert.equal(completed.action_items[0].completion_reason, "done_in_test");

  const legacyRoute = await app.inject({
    method: "GET",
    url: `/v1/platform/organizations/${orgId}/action_items`
  });
  assert.equal(legacyRoute.statusCode, 400);
  assert.equal(legacyRoute.json().error, "action_items_are_work_nodes");
});

test("Manual action items with the same title get separate records", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);

  const first = await client.request("POST", `/v1/platform/organizations/${orgId}/action-items`, {
    kind: "manual",
    title: "Follow up with Sam",
    due_at: "2026-06-30"
  });
  const second = await client.request("POST", `/v1/platform/organizations/${orgId}/action-items`, {
    kind: "manual",
    title: "Follow up with Sam",
    due_at: "2026-06-30"
  });

  assert.notEqual(first.action_item.id, second.action_item.id);
  const visible = await client.request("GET", `/v1/platform/organizations/${orgId}/action-items?kind=manual`);
  assert.equal(visible.action_items.length, 2);
  assert.deepEqual(visible.action_items.map((item: any) => item.title), ["Follow up with Sam", "Follow up with Sam"]);
});

test("Left column to-do list app flag persists in platform flag state", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      app_flags: {
        platform: { expanded_access: true, left_column_todo_list: true }
      }
    }
  }, { replace: false });

  const flags = await client.request("GET", `/v1/platform/organizations/${orgId}/app-flags`);
  assert.equal(flags.raw.platform.left_column_todo_list, true);
  assert.equal(flags.effective.platform.left_column_todo_list, true);
  assert.equal(flags.enabled.platform.includes("left_column_todo_list"), true);
});

test("Left column to-do list app flag saves through app flag API", async () => {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: "notifications@1m8.ai",
    password: "correct horse battery staple",
    name: "Flag Admin",
    company: "Flag Test Org",
    organization_id: `org_test_flags_${suffix}`
  });
  await enableExpandedPlatformFixture(registered.organization.id);
  const orgId = registered.organization.id as string;

  const initial = await client.request("GET", `/v1/platform/organizations/${orgId}/app-flags`);
  assert.equal(initial.raw.platform.free_storage_gb, 1);
  assert.equal(initial.effective.platform.free_storage_gb, 1);
  assert.equal(initial.raw.platform.new_button_mode, "report");
  assert.equal(initial.effective.platform.new_button_mode, "report");

  const saved = await client.request("PUT", `/v1/platform/organizations/${orgId}/app-flags`, {
    app_flags: {
      platform: {
        left_column_todo_list: true,
        storage_limits: true,
        free_storage_gb: 2.5,
        proposals: true,
        proposal_agent: true,
        cobrand_sidebar_logo: true,
        new_button_mode: "selector"
      }
    }
  });

  assert.equal(saved.raw.platform.left_column_todo_list, true);
  assert.equal(saved.effective.platform.left_column_todo_list, true);
  assert.equal(saved.enabled.platform.includes("left_column_todo_list"), true);
  assert.equal(saved.raw.platform.free_storage_gb, 2.5);
  assert.equal(saved.effective.platform.free_storage_gb, 2.5);
  assert.equal(saved.raw.platform.proposal_agent, true);
  assert.equal(saved.effective.platform.proposal_agent, true);
  assert.equal(saved.raw.platform.cobrand_sidebar_logo, true);
  assert.equal(saved.effective.platform.cobrand_sidebar_logo, true);
  assert.equal(saved.raw.platform.new_button_mode, "selector");
  assert.equal(saved.effective.platform.new_button_mode, "selector");
  assert.equal(saved.enabled.platform.includes("new_button_mode"), false);

  const reloaded = await client.request("GET", `/v1/platform/organizations/${orgId}/app-flags`);
  assert.equal(reloaded.raw.platform.left_column_todo_list, true);
  assert.equal(reloaded.effective.platform.left_column_todo_list, true);
  assert.equal(reloaded.raw.platform.free_storage_gb, 2.5);
  assert.equal(reloaded.effective.platform.free_storage_gb, 2.5);
  assert.equal(reloaded.raw.platform.proposal_agent, true);
  assert.equal(reloaded.effective.platform.proposal_agent, true);
  assert.equal(reloaded.raw.platform.cobrand_sidebar_logo, true);
  assert.equal(reloaded.effective.platform.cobrand_sidebar_logo, true);
  assert.equal(reloaded.raw.platform.new_button_mode, "selector");
  assert.equal(reloaded.effective.platform.new_button_mode, "selector");
});

test("Post-order report expedite upgrade includes gutter add-on cost", async () => {
  const client = createSessionClient();
  const { orgId, email: actorEmail } = await register(client, false);
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      credits_balance: 100,
      app_flags: {
        firstmeasure: {
          report_expedite_options: true
        }
      }
    }
  }, { replace: false });

  const projectId = `post_order_gutter_expedite_${Date.now()}`;
  const queuedAt = new Date().toISOString();
  const created = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/projects",
    payload: {
      id: projectId,
      address: `${projectId} Test Way, Seattle, WA`,
      status: "queued",
      project_type: "residential",
      report_mode: "full",
      include_gutter_measurements: true,
      amount_charged: 9,
      is_expedited: false,
      report_expedite_option: "standard_3_6",
      report_expedite_label: "3-6 hrs",
      report_due_window_start: new Date(Date.now() + 3 * 60_000 * 60).toISOString(),
      report_due_window_end: new Date(Date.now() + 6 * 60_000 * 60).toISOString(),
      pins: [{ lat: 47.61, lng: -122.33 }],
      organization_ref: { id: orgId },
      issuer: { name: "Expedite Upgrade Tester", email: actorEmail },
      timestamps: { created_at: queuedAt, queued_at: queuedAt }
    },
    headers: { "content-type": "application/json" }
  });
  assert.equal(created.statusCode, 201, created.body);

  const upgraded = await client.request("POST", "/v1/platform/portal-action", {
    action: "expedite_queued_report",
    actor_email: actorEmail,
    actor_name: "Expedite Upgrade Tester",
    actor_org_id: orgId,
    project_id: projectId,
    report_expedite_option: "rush_1_3"
  });

  assert.equal(upgraded.success, true);
  assert.equal(upgraded.manifest.expedite_upgrade_credited_amount, 7);
  assert.equal(
    upgraded.charge_amount,
    Math.round((upgraded.manifest.report_original_amount - upgraded.manifest.expedite_upgrade_credited_amount) * 100) / 100
  );
  assert.equal(Math.round((upgraded.charge_amount - Math.max(0, upgraded.manifest.report_original_amount - 9)) * 100) / 100, 2);
  assert.equal(upgraded.manifest.amount_charged, Math.round((9 + upgraded.charge_amount) * 100) / 100);
});

test("Post-order commercial expedite upgrade applies additional structure time", async () => {
  const client = createSessionClient();
  const { orgId, email: actorEmail } = await register(client, false);
  const { saveGlobal } = await import("../platform/storage.js");
  await saveGlobal(orgId, {
    data: {
      credits_balance: 100,
      app_flags: {
        firstmeasure: {
          report_expedite_options: true
        }
      }
    }
  }, { replace: false });

  const projectId = `post_order_commercial_expedite_${Date.now()}`;
  const queuedAt = new Date().toISOString();
  const created = await (app.inject as any)({
    method: "POST",
    url: "/v1/firstmeasure/projects",
    payload: {
      id: projectId,
      address: `${projectId} Test Way, Seattle, WA`,
      status: "queued",
      project_type: "commercial",
      report_mode: "full",
      amount_charged: 36,
      is_expedited: false,
      report_expedite_option: "standard_3_6",
      report_expedite_label: "3-6 hrs",
      report_due_window_start: new Date(Date.now() + 4 * 60_000 * 60).toISOString(),
      report_due_window_end: new Date(Date.now() + 7 * 60_000 * 60).toISOString(),
      pins: [
        { lat: 47.6101, lng: -122.3301 },
        { lat: 47.6102, lng: -122.3302 },
        { lat: 47.6103, lng: -122.3303 }
      ],
      organization_ref: { id: orgId },
      issuer: { name: "Commercial Expedite Tester", email: actorEmail },
      timestamps: { created_at: queuedAt, queued_at: queuedAt }
    },
    headers: { "content-type": "application/json" }
  });
  assert.equal(created.statusCode, 201, created.body);

  const requestStartedMs = Date.now();
  const upgraded = await client.request("POST", "/v1/platform/portal-action", {
    action: "expedite_queued_report",
    actor_email: actorEmail,
    actor_name: "Commercial Expedite Tester",
    actor_org_id: orgId,
    project_id: projectId,
    report_expedite_option: "rush_1_3"
  });
  const requestEndedMs = Date.now();

  assert.equal(upgraded.success, true);
  assert.equal(upgraded.manifest.project_type, "commercial");
  assert.equal(upgraded.manifest.pins.length, 3);
  assert.equal(upgraded.manifest.report_expedite_option, "rush_1_3");
  const dueStartMs = Date.parse(upgraded.manifest.report_due_window_start);
  const productionDeadlineMs = Date.parse(upgraded.manifest.report_production_deadline_at);
  const dueEndMs = Date.parse(upgraded.manifest.report_due_window_end);
  assert.ok(dueStartMs >= requestStartedMs + 119 * 60_000, upgraded.manifest);
  assert.ok(dueStartMs <= requestEndedMs + 121 * 60_000, upgraded.manifest);
  assert.equal(productionDeadlineMs - dueStartMs, 60 * 60_000);
  assert.equal(dueEndMs - dueStartMs, 120 * 60_000);
});

test("A scheduling work node created from template data completes when project work is scheduled", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const projectId = "project_action_schedule_sold";
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      title: "Action Item Roof",
      address: "400 Todo Lane",
      events: []
    },
    metadata: { kind: "platform_project" }
  });

  await client.request("POST", `/v1/work/organizations/${orgId}/projects/${projectId}/plans`, {
    id: "plan_schedule_sold",
    title: "Schedule sold project",
    source_key: "test:schedule-sold",
    metadata: { hide_from_boards: true },
    root_nodes: [{
      id: "schedule_sold_project",
      title: "Schedule the project",
      terminology_key: "work.task",
      actionable: true,
      show_in_todo_list: true,
      external_triggers: [{
        event: "project.event_scheduled",
        transition: "completed",
        conditions: { "payload.event_kind": "project_work" }
      }],
      metadata: {
        kind: "schedule_sold_project",
        frontend_action: { kind: "open_project_scheduling", tab: "schedule" }
      }
    }]
  });

  const open = await client.request("GET", `/v1/work/organizations/${orgId}/todos?project_id=${projectId}&all_users=1&include_unassigned=1`);
  const schedulingNode = open.todos.find((item: any) => item.metadata?.kind === "schedule_sold_project");
  assert.ok(schedulingNode);
  assert.equal(schedulingNode.metadata.frontend_action.kind, "open_project_scheduling");

  const appointment = await client.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event_type_default_id: "sales_appointment",
    start_at: new Date(Date.now() + 86_400_000).toISOString(),
    duration_minutes: 60,
    assigned_user_ids: []
  });
  const afterAppointment = await client.request("GET", `/v1/work/organizations/${orgId}/nodes/${schedulingNode.id}`);
  assert.notEqual(afterAppointment.node.status, "completed");

  const scheduled = await client.request("POST", `/v1/platform/organizations/${orgId}/projects/${projectId}/events`, {
    event_type_default_id: "project_work",
    title: "Install",
    start_at: new Date(Date.now() + 172_800_000).toISOString(),
    end_at: new Date(Date.now() + 259_200_000).toISOString(),
    all_day: true,
    schedule_granularity: "date"
  });
  assert.equal(scheduled.event.event_type_default_id, "project_work");
  const after = await client.request("GET", `/v1/work/organizations/${orgId}/nodes/${schedulingNode.id}`);
  assert.equal(after.node.status, "completed");
});
