import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

let app: any = null;
let storageRoot = "";
let baseUrl = "";

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
      cookie = [sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""]
        .filter(Boolean)
        .join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw, cookieHeader: () => cookie, csrfToken: () => csrf };
}

type TestClient = ReturnType<typeof createSessionClient>;

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-documents-collab-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.DOCUMENTS_STORAGE_ROOT = path.join(storageRoot, "documents");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.V1_LOG_LEVEL = "error";

  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  // The documents API (and its collab routes) are mounted centrally by the
  // integrator in src/app.ts / documents/api.ts; until that lands the test
  // registers the plugin + collab routes itself, mirroring the final layout.
  const appSource = await readFile(new URL("../src/app.ts", import.meta.url), "utf8").catch(() => "");
  const apiSource = await readFile(new URL("../documents/api.ts", import.meta.url), "utf8").catch(() => "");
  const { registerCollabRoutes } = await import("../documents/collab/routes.js");
  const documentsMounted = appSource.includes("registerDocumentsApi");
  const collabMounted = apiSource.includes("registerCollabRoutes") || appSource.includes("registerCollabRoutes");
  if (!documentsMounted) {
    const { registerDocumentsApi } = await import("../documents/api.js");
    await app.register(registerDocumentsApi, { prefix: "/v1/documents" });
  }
  if (!collabMounted) {
    const { PlatformError } = await import("../platform/errors.js");
    await app.register(async (instance: any) => {
      // Mirror the documents API error handler these routes will live under
      // once the integrator wires registerCollabRoutes into documents/api.ts.
      instance.setErrorHandler((error: any, _request: any, reply: any) => {
        if (error instanceof PlatformError) {
          reply.code(error.statusCode);
          return reply.send({ ok: false, error: error.code, message: error.message, details: error.details ?? null });
        }
        reply.code(Number(error?.statusCode) || 500);
        return reply.send({
          ok: false,
          error: String(error?.code ?? "request_error"),
          message: String(error?.message ?? "The request could not be processed.")
        });
      });
      registerCollabRoutes(instance);
    }, { prefix: "/v1/documents" });
  }
  await app.ready();
  // Real sockets for the SSE stream tests (app.inject cannot consume a
  // hijacked, never-ending response).
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  const { resetCollabForTests } = await import("../documents/collab/service.js");
  (await resetCollabForTests());
  if (app) await app.close();
  await closePlatformFixtureStores();
  await closeSqlStoresForTests();
  if (storageRoot) {
    try {
      await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (error: any) {
      if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
    }
  }
});

async function registerOrg(client: TestClient) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const email = `owner-${suffix}@example.test`;
  const data = await client.request("POST", "/v1/platform/auth/register", {phone: nextTestPhone(), 
    email,
    password: "correct horse battery staple",
    name: "Collab Owner",
    company: "Documents Collab Test Org",
    organization_id: `org_documents_collab_${suffix}`
  });
  await enableExpandedPlatformFixture(String(data.organization.id));
  const orgId = data.organization.id as string;
  await enableExpandedPlatformFixture(orgId, {
      "platform.documents": true,
      "documents.templates_studio": true,
      "documents.advanced_definition_editing": true
    });
  return { orgId, suffix, userId: String(data.user.id), email };
}

async function createOrgUser(owner: TestClient, orgId: string, suffix: string, name: string) {
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${suffix}@example.test`;
  const password = `${name} test password`;
  const created = await owner.request("POST", `/v1/platform/organizations/${orgId}/users`, {
    data: { email, password, name, status: "active", role: "admin", send_invite: false }
  });
  const client = createSessionClient();
  await client.request("POST", "/v1/platform/auth/login", { email, password, organization_id: orgId });
  return { userId: String(created.document.id), email, client };
}

async function createProject(client: TestClient, orgId: string, projectId: string) {
  await client.request("PUT", `/v1/platform/organizations/${orgId}/projects/${projectId}`, {
    data: {
      id: projectId,
      address: "100 Collab Lane",
      title: "Jane Homeowner",
      project_type: "residential",
      contacts: [{ name: "Jane Homeowner", email: "jane@example.test", phone: "555-111-2222" }],
      photos: []
    },
    metadata: { kind: "platform_project" }
  });
}

async function createDocument(client: TestClient, orgId: string, projectId: string) {
  const created = await client.request("POST", `/v1/documents/organizations/${orgId}/projects/${projectId}/documents`, {
    document_type: "proposal",
    template_id: null,
    workflow_id: null,
    title: "Collab Test Document"
  });
  return String(created.document.id);
}

/** Read the SSE collab stream until predicate matches or timeout; raw frames. */
async function collectStream(
  cookie: string,
  documentId: string,
  options: { until: (frames: string[]) => boolean; timeoutMs?: number }
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
  const frames: string[] = [];
  try {
    const response = await fetch(`${baseUrl}/v1/documents/${documentId}/collab/stream`, {
      headers: { cookie },
      signal: controller.signal
    });
    assert.equal(response.status, 200);
    assert.match(String(response.headers.get("content-type")), /text\/event-stream/);
    assert.equal(response.headers.get("x-accel-buffering"), "no");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        frames.push(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf("\n\n");
      }
      if (options.until(frames)) return frames;
    }
  } catch (error: any) {
    if (error?.name !== "AbortError" && error?.code !== "ABORT_ERR" && !controller.signal.aborted) throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  return frames;
}

function parseEvents(frames: string[]) {
  return frames
    .filter((frame) => frame.includes("data: "))
    .map((frame) => {
      const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "))!;
      return { event: eventLine ? eventLine.slice(7).trim() : "", data: JSON.parse(dataLine.slice(6)) as Json };
    });
}

test("joining the stream sends hello with the revision and the actor's own presence", async () => {
  const client = createSessionClient();
  const { orgId, userId, email } = await registerOrg(client);
  const projectId = "project_collab_hello";
  await createProject(client, orgId, projectId);
  const documentId = await createDocument(client, orgId, projectId);

  const frames = await collectStream(client.cookieHeader(), documentId, {
    until: (collected) => collected.some((frame) => frame.includes("event: hello"))
  });
  const hello = parseEvents(frames).find((event) => event.event === "hello");
  assert.ok(hello, "stream opens with a hello event");
  assert.equal(hello!.data.revision, 0, "fresh documents start at revision 0");
  assert.equal(hello!.data.presence.length, 1, "the joining actor is on the roster");
  const self = hello!.data.presence[0];
  assert.equal(self.actor.id, userId);
  assert.equal(self.actor.email, email);
  assert.match(String(self.color), /^#[0-9A-Fa-f]{6}$/, "the server assigns the presence color");
  assert.ok(self.last_seen, "presence entries carry last_seen");
});

test("command batches append at the current revision and bump it", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_collab_commands";
  await createProject(client, orgId, projectId);
  const documentId = await createDocument(client, orgId, projectId);

  const first = await client.request("POST", `/v1/documents/${documentId}/collab/commands`, {
    base_revision: 0,
    commands: [{ type: "text.edit", node_id: "node_a", block_id: "blk_1", value: "Hello" }]
  });
  assert.equal(first.ok, true);
  assert.equal(first.revision, 1);

  const second = await client.request("POST", `/v1/documents/${documentId}/collab/commands`, {
    base_revision: 1,
    commands: [
      { type: "text.edit", node_id: "node_a", block_id: "blk_1", value: "Hello world" },
      { type: "node.move", node_id: "node_b", index: 2 }
    ],
    actor_cursor: { node_id: "node_a", block_id: "blk_1", offset: 11 }
  });
  assert.equal(second.ok, true);
  assert.equal(second.revision, 2);
});

test("a stale base revision is rejected with the missed batches for replay", async () => {
  const client = createSessionClient();
  const { orgId, userId } = await registerOrg(client);
  const projectId = "project_collab_stale";
  await createProject(client, orgId, projectId);
  const documentId = await createDocument(client, orgId, projectId);

  await client.request("POST", `/v1/documents/${documentId}/collab/commands`, {
    base_revision: 0,
    commands: [{ type: "text.edit", node_id: "node_a", block_id: "blk_1", value: "one" }]
  });
  await client.request("POST", `/v1/documents/${documentId}/collab/commands`, {
    base_revision: 1,
    commands: [{ type: "text.edit", node_id: "node_a", block_id: "blk_2", value: "two" }]
  });

  const staleResponse = await client.raw("POST", `/v1/documents/${documentId}/collab/commands`, {
    base_revision: 0,
    commands: [{ type: "text.edit", node_id: "node_a", block_id: "blk_1", value: "conflicting" }]
  });
  assert.equal(staleResponse.statusCode, 409, "stale appends conflict instead of clobbering");
  const stale = JSON.parse(staleResponse.body) as Json;
  assert.equal(stale.ok, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.revision, 2);
  assert.equal(stale.missed.length, 2, "every batch after the stale base comes back for replay");
  assert.deepEqual(stale.missed.map((entry: Json) => entry.revision), [1, 2]);
  assert.equal(stale.missed[0].actor_id, userId);
  assert.equal(stale.missed[0].commands[0].value, "one");
  assert.equal(stale.missed[1].commands[0].value, "two");

  // Nothing was appended by the stale request: the next append at the real
  // revision succeeds and lands at 3.
  const retried = await client.request("POST", `/v1/documents/${documentId}/collab/commands`, {
    base_revision: 2,
    commands: [{ type: "text.edit", node_id: "node_a", block_id: "blk_1", value: "rebased" }]
  });
  assert.equal(retried.revision, 3);

  // The command log is durable: a fresh session (cold in-memory state) resumes
  // from the persisted revision rather than 0.
  const { resetCollabForTests, listMissedCollabCommands } = await import("../documents/collab/service.js");
  (await resetCollabForTests());
  const replayed = (await listMissedCollabCommands(orgId, documentId, 0));
  assert.deepEqual(replayed.map((entry) => entry.revision), [1, 2, 3]);
  const reloaded = await client.raw("POST", `/v1/documents/${documentId}/collab/commands`, {
    base_revision: 0,
    commands: [{ type: "noop.probe" }]
  });
  assert.equal(reloaded.statusCode, 409);
  assert.equal((JSON.parse(reloaded.body) as Json).revision, 3, "revision is restored from the sqlite log");
});

test("presence updates build the roster and stale entries are pruned", async () => {
  const client = createSessionClient();
  const { orgId, suffix, userId } = await registerOrg(client);
  const projectId = "project_collab_presence";
  await createProject(client, orgId, projectId);
  const documentId = await createDocument(client, orgId, projectId);
  const mate = await createOrgUser(client, orgId, suffix, "Collab Mate");

  const ownerRoster = await client.request("POST", `/v1/documents/${documentId}/collab/presence`, {
    cursor: { node_id: "node_a", block_id: "blk_1", offset: 4 }
  });
  assert.equal(ownerRoster.ok, true);
  assert.equal(ownerRoster.presence.length, 1);

  const mateRoster = await mate.client.request("POST", `/v1/documents/${documentId}/collab/presence`, {
    cursor: { node_id: "node_b", block_id: "blk_9", offset: 0 },
    selection: { node_id: "node_b", block_ids: ["blk_9", "blk_10"] }
  });
  assert.equal(mateRoster.presence.length, 2, "both actors are on the roster");
  const ownerEntry = mateRoster.presence.find((entry: Json) => entry.actor.id === userId);
  const mateEntry = mateRoster.presence.find((entry: Json) => entry.actor.id === mate.userId);
  assert.ok(ownerEntry && mateEntry);
  assert.deepEqual(ownerEntry.cursor, { node_id: "node_a", block_id: "blk_1", offset: 4 });
  assert.deepEqual(mateEntry.selection.block_ids, ["blk_9", "blk_10"]);
  assert.notEqual(ownerEntry.color, mateEntry.color, "each actor gets a distinct color");

  // Prune with a zero TTL: no live SSE connections back these entries, so
  // both fall off the roster (production runs this sweep on the 15s heartbeat
  // with a 30s TTL).
  const { pruneStaleCollabPresence, collabHello } = await import("../documents/collab/service.js");
  const pruned = (await pruneStaleCollabPresence(0));
  assert.ok(pruned >= 2, `expected both presence entries pruned, got ${pruned}`);
  assert.equal((await collabHello(orgId, documentId)).presence.length, 0, "the roster is empty after pruning");
});

test("the SSE stream delivers command and presence broadcasts to other collaborators", async () => {
  const client = createSessionClient();
  const { orgId, suffix } = await registerOrg(client);
  const projectId = "project_collab_broadcast";
  await createProject(client, orgId, projectId);
  const documentId = await createDocument(client, orgId, projectId);
  const mate = await createOrgUser(client, orgId, suffix, "Collab Streamer");

  const streaming = collectStream(client.cookieHeader(), documentId, {
    until: (frames) => frames.some((frame) => frame.includes("event: commands"))
  });
  // Give the stream a beat to connect before posting.
  await new Promise((resolve) => setTimeout(resolve, 300));

  await mate.client.request("POST", `/v1/documents/${documentId}/collab/presence`, {
    cursor: { node_id: "node_z", block_id: "blk_z", offset: 1 }
  });
  await mate.client.request("POST", `/v1/documents/${documentId}/collab/commands`, {
    base_revision: 0,
    commands: [{ type: "text.edit", node_id: "node_z", block_id: "blk_z", value: "streamed edit" }]
  });

  const frames = await streaming;
  const events = parseEvents(frames);

  const hello = events.find((event) => event.event === "hello");
  assert.ok(hello, "the stream opened with hello");
  assert.equal(hello!.data.revision, 0);

  const presenceEvent = events.find(
    (event) => event.event === "presence"
      && event.data.presence?.some((entry: Json) => entry.actor.id === mate.userId)
  );
  assert.ok(presenceEvent, "the collaborator's presence update reached the stream");

  const commandsEvent = events.find((event) => event.event === "commands");
  assert.ok(commandsEvent, "the collaborator's command batch reached the stream");
  assert.equal(commandsEvent!.data.revision, 1);
  assert.equal(commandsEvent!.data.actor.id, mate.userId);
  assert.equal(commandsEvent!.data.actor.name, "Collab Streamer");
  assert.equal(commandsEvent!.data.commands[0].value, "streamed edit");
});

test("collab is org-scoped: users cannot join or edit documents outside their org", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_collab_isolation";
  await createProject(client, orgId, projectId);
  const documentId = await createDocument(client, orgId, projectId);

  const outsider = createSessionClient();
  await registerOrg(outsider);

  const denied = await outsider.raw("POST", `/v1/documents/${documentId}/collab/commands`, {
    base_revision: 0,
    commands: [{ type: "text.edit", node_id: "node_a", block_id: "blk_1", value: "intruder" }]
  });
  assert.equal(denied.statusCode, 404, "foreign documents are indistinguishable from missing ones");

  const presenceDenied = await outsider.raw("POST", `/v1/documents/${documentId}/collab/presence`, {
    cursor: { node_id: "node_a", block_id: "blk_1", offset: 0 }
  });
  assert.equal(presenceDenied.statusCode, 404);

  const streamDenied = await fetch(`${baseUrl}/v1/documents/${documentId}/collab/stream`, {
    headers: { cookie: outsider.cookieHeader() }
  });
  assert.equal(streamDenied.status, 404, "the stream refuses cross-org joins before hijacking the socket");
  await streamDenied.body?.cancel();

  const anonymous = await fetch(`${baseUrl}/v1/documents/${documentId}/collab/stream`);
  assert.equal(anonymous.status, 401, "the stream requires a platform session");
  await anonymous.body?.cancel();
});

test("command bodies are validated with the shared error shape", async () => {
  const client = createSessionClient();
  const { orgId } = await registerOrg(client);
  const projectId = "project_collab_validation";
  await createProject(client, orgId, projectId);
  const documentId = await createDocument(client, orgId, projectId);

  const invalid = await client.raw("POST", `/v1/documents/${documentId}/collab/commands`, {
    base_revision: 0,
    commands: []
  });
  assert.equal(invalid.statusCode, 400);
  const body = JSON.parse(invalid.body) as Json;
  assert.equal(body.error, "validation_error");
});
