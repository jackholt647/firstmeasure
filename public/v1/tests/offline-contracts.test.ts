/**
 * Offline contracts against the real server (docs/architecture/offline.md, "Contracts").
 *
 * Every contract file listed in public/libraries/platform-offline/contracts/index.js is loaded into the real
 * engine. The test fails when a contract names a route the server does not register, when a write cannot be
 * queued properly (no `respond`, `scope` or `label`), and when a read made with POST names a route that is not
 * on the list of routes checked to change nothing. Each write that has a case below is also run with the
 * server unreachable and its answer compared with what the real route answers for the same request.
 */
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { closePlatformFixtureStores } from "./helpers/platform-fixture.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const LIBRARY = path.resolve(here, "../../libraries/platform-offline");
const ORIGIN = "https://app.example.test";

type Json = Record<string, any>;
let app: any = null;
let storageRoot = "";

/**
 * POST routes a contract may declare as a read. Each was read in the server and changes nothing: no store
 * write, no event, nothing sent. Add a route here only after checking its handler the same way.
 */
const READ_ONLY_POST_ROUTES: Record<string, string> = {
  // firstmeasure/api.ts projects/list: reads the project index; a refresh cursor is a signed token, nothing is stored.
  "POST /v1/firstmeasure/projects/list": "firstmeasure/api.ts",
  // platform/publication/api.ts: providers and widget types only read ("Reads must not create or mutate domain records").
  "POST /v1/publication/organizations/:p/data/read": "platform/publication/api.ts",
  "POST /v1/publication/organizations/:p/data/list": "platform/publication/api.ts",
  "POST /v1/publication/organizations/:p/widgets/resolve": "platform/publication/api.ts",
  // workforce/api.ts: resolveAssignableSubjects reads the configuration and the people it names.
  "POST /v1/workforce/organizations/:p/branches/:p/assignable-subjects/resolve": "workforce/api.ts",
  // channels/feed.ts: resolves each source with the caller's access; no feed post is made here.
  "POST /v1/channels/organizations/:p/feed/authorize": "channels/feed.ts",
  // labor/requirements.ts projectRequirements: coverage computed from the lists as they stand; it only reads.
  "POST /v1/materials/organizations/:p/projects/:p/requirements": "labor/requirements.ts",
  // platform/api.ts handlePortalAction: only the actions in PORTAL_READ_ACTIONS (checked below).
  "POST /v1/platform/portal-action": "platform/api.ts",
  // documents/api.ts resolve: bindings and widget data for display; nothing is saved.
  "POST /v1/documents/organizations/:p/documents/:p/resolve": "documents/api.ts"
};

/**
 * Portal actions that only read (platform/api.ts handlePortalAction). Left out on purpose:
 * portal_bonus_upfront_match_status (the first view starts the offer clock: markBonusOfferInstanceViewed),
 * portal_customer_referral_status (ensurePrimaryCode writes on every call) and auth_status (the session).
 */
const PORTAL_READ_ACTIONS = new Set([
  "org_get_my", "get_credits", "org_users_list_my", "org_billing_history_my", "org_monthly_statement",
  "pj_search", "development_report_capability", "portal_acquisition_bonus_offer_status"
]);

function loadContracts() {
  const context = vm.createContext({ URL, URLSearchParams, Request, Response, Headers, Blob, File, FormData, AbortController, TextEncoder, TextDecoder, crypto: webcrypto, console, setTimeout, clearTimeout, navigator: { onLine: true }, location: { origin: ORIGIN } });
  (context as any).self = context;
  vm.runInContext(readFileSync(path.join(LIBRARY, "offline-core.js"), "utf8"), context, { filename: "offline-core.js" });
  const FM = (context as any).FMOffline;
  const raw: Json[] = [];
  const add = FM.contracts.add;
  FM.contracts.add = (contract: Json) => { raw.push(contract); return add(contract); };
  vm.runInContext(readFileSync(path.join(LIBRARY, "contracts/index.js"), "utf8"), context, { filename: "contracts/index.js" });
  const files: string[] = [...((context as any).FM_OFFLINE_CONTRACTS || [])];
  for (const file of files) {
    const full = path.join(LIBRARY, "contracts", file);
    assert.ok(existsSync(full), `contracts/index.js lists ${file}, which does not exist`);
    vm.runInContext(readFileSync(full, "utf8"), context, { filename: `contracts/${file}` });
  }
  return { FM, raw, files, context };
}

const loaded = loadContracts();

/** "POST /v1/a/:org/b/*" as Fastify names it, parameters numbered, and as the allow list above writes it. */
function routeOf(pattern: string) {
  const text = String(pattern).trim();
  const space = text.indexOf(" ");
  const method = space > 0 ? text.slice(0, space).toUpperCase() : "";
  let count = 0;
  const segments = (space > 0 ? text.slice(space + 1).trim() : text).split("/");
  const url = segments.map((segment) => (segment.startsWith(":") || segment === "*" ? `:p${++count}` : segment)).join("/");
  const key = `${method} ${segments.map((segment) => (segment.startsWith(":") || segment === "*" ? ":p" : segment)).join("/")}`;
  return { method, url, key, wild: segments.includes("**") };
}

const each = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : ([] as T[]).concat(value as T[]));

/**
 * The platform's document collections are served by one route with the collection as a parameter
 * (/organizations/:orgId/:collection[/:documentId]); a pattern that names one of them is that route.
 */
const COLLECTIONS = ["projects", "users", "branch", "notifications", "action_items", "calendar_events"];

function registered(pattern: string) {
  const route = routeOf(pattern);
  if (app.hasRoute({ method: route.method, url: route.url })) return true;
  const generic = route.url.split("/").map((segment) => (COLLECTIONS.includes(segment) ? ":collection" : segment)).join("/");
  return generic !== route.url && app.hasRoute({ method: route.method, url: generic });
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-offline-contracts-"));
  Object.assign(process.env, {
    NODE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0", EMAIL_OUTBOUND_DISABLED: "1", OPENAI_API_KEY: "", V1_LOG_LEVEL: "error",
    PUBLIC_BASE_URL: ORIGIN, CORS_ALLOWED_ORIGINS: ORIGIN,
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"),
    INTERNAL_STORAGE_ROOT: path.join(storageRoot, "internal"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"),
    FIRSTMEASURE_INTERNAL_API_SECRET: "offline-contracts-fixture-secret"
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  await app?.close();
  await closePlatformFixtureStores();
  await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
});

test("every listed contract file loads into the engine", () => {
  assert.ok(loaded.files.includes("core.js"), "the core contract is listed");
  assert.ok(loaded.raw.length >= loaded.files.length, "each file registers at least one contract");
  const ids = loaded.raw.map((contract) => contract.id);
  assert.equal(new Set(ids).size, ids.length, `contract ids are unique: ${ids.join(", ")}`);
});

test("every write and read names a route the server registers", () => {
  const missing: string[] = [];
  for (const contract of loaded.raw) {
    for (const item of [...(contract.writes || []), ...(contract.reads || [])]) {
      for (const pattern of each<string>(item.match)) {
        const route = routeOf(pattern);
        assert.ok(route.method, `${contract.id}/${item.id}: "${pattern}" needs a method`);
        assert.ok(!route.wild, `${contract.id}/${item.id}: "${pattern}" must name one route, not "**"`);
        if (!registered(pattern)) missing.push(`${contract.id}/${item.id}: ${pattern}`);
      }
    }
    // A boot pattern that is no route would never keep anything.
    for (const pattern of each<string>(contract.boot)) {
      const route = routeOf(pattern);
      if (route.wild || !route.method) continue;
      if (!registered(pattern)) missing.push(`${contract.id}/boot: ${pattern}`);
    }
  }
  assert.deepEqual(missing, [], "contract routes the server does not register");
});

test("every write can be queued: a kind, respond, scope and label", () => {
  for (const contract of loaded.raw) {
    for (const write of contract.writes || []) {
      const name = `${contract.id}/${write.id}`;
      assert.equal(typeof write.respond, "function", `${name} needs respond(ctx)`);
      assert.equal(typeof write.scope, "function", `${name} needs scope(ctx)`);
      assert.equal(typeof write.label, "function", `${name} needs label(ctx)`);
      if (write.kind === "patch" && write.conflict) {
        for (const part of ["current", "pick", "send"]) assert.equal(typeof write.conflict[part], "function", `${name} conflict.${part}`);
      }
    }
  }
});

test("a read made with POST only names a route that changes nothing", () => {
  for (const contract of loaded.raw) {
    for (const read of contract.reads || []) {
      for (const pattern of each<string>(read.match)) {
        const route = routeOf(pattern);
        if (route.method === "GET") continue;
        assert.ok(READ_ONLY_POST_ROUTES[route.key], `${contract.id}/${read.id}: ${pattern} is not on the list of POST routes checked to change nothing`);
        if (route.key === "POST /v1/platform/portal-action") {
          assert.equal(typeof read.when, "function", `${contract.id}/${read.id}: a route that carries several actions needs when(ctx)`);
        }
      }
    }
  }
});

test("portal actions declared as reads are only the ones that read", async () => {
  // Every action the server knows, from the handler itself.
  const source = readFileSync(path.resolve(here, "../platform/api.ts"), "utf8");
  const start = source.indexOf("async function handlePortalAction(");
  const handler = source.slice(start, source.indexOf("\nasync function ", start + 10));
  const actions = new Set<string>();
  for (const found of handler.matchAll(/case "([a-z_]+)":/g)) actions.add(found[1]!);
  for (const found of handler.matchAll(/action === "([a-z_]+)"/g)) actions.add(found[1]!);
  assert.ok(actions.size > 30, "the handler's actions were found");
  for (const action of PORTAL_READ_ACTIONS) assert.ok(actions.has(action), `${action} is a portal action`);
  const reads = loaded.raw.flatMap((contract) => (contract.reads || []).filter((read: Json) => each<string>(read.match).some((pattern) => routeOf(pattern).key === "POST /v1/platform/portal-action")));
  assert.ok(reads.length, "a contract declares the portal's read actions");
  for (const action of actions) {
    const declared = (await Promise.all(reads.map((read: Json) => read.when({ body: { action } })))).some(Boolean);
    assert.equal(declared, PORTAL_READ_ACTIONS.has(action), `${action}: ${declared ? "is declared as a read but is not on the checked list" : "is on the checked list but no contract declares it"}`);
  }
  // The offer's test mode writes; the read must not cover it.
  for (const read of reads) assert.equal(!!(await read.when({ body: { action: "portal_acquisition_bonus_offer_status", bonus_test: "1" } })), false);
  // An action the server does not know is never a read.
  for (const read of reads) assert.equal(!!(await read.when({ body: { action: "queue" } })), false);
});

// ---------------------------------------------------------------------------------------------------------------
// Each write, with the server unreachable and then reachable again, against the real routes
// ---------------------------------------------------------------------------------------------------------------

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}

/** Signs up an owner the way the portal does and keeps their session. */
async function owner() {
  const { randomUUID } = await import("node:crypto");
  const { enableExpandedPlatformFixture, nextTestPhone } = await import("./helpers/platform-fixture.js");
  let cookie = "", csrf = "";
  const raw = async (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const response = await app.inject({ method, url, payload, headers: { ...headers, ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method) ? { "x-platform-csrf": csrf } : {}) } });
    const session = readCookie(response.headers["set-cookie"], "fm_platform_session"), token = readCookie(response.headers["set-cookie"], "fm_platform_session_csrf");
    if (session || token) {
      cookie = [session || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "", token || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""].filter(Boolean).join("; ");
      csrf = decodeURIComponent((token || "").split("=")[1] || csrf);
    }
    return response;
  };
  const suffix = randomUUID().slice(0, 8);
  const registered = await raw("POST", "/v1/platform/auth/register", { phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple", name: "Owner", company: "Offline Contracts Org", organization_name: "Offline Contracts Org" });
  assert.equal(registered.statusCode < 400, true, registered.body);
  const orgId = String(registered.json().organization.id), userId = String(registered.json().user.id);
  await enableExpandedPlatformFixture(orgId, { "platform.contacts": true, "platform.scheduling": true, "apps.channels": true, "channels.project_notes": true });
  return { orgId, userId, raw, csrf: () => csrf };
}

/** The engine with the real app as its network, and a switch that drops every request. */
function device(me: Awaited<ReturnType<typeof owner>>) {
  const FM = loaded.FM;
  const net = { down: false, sent: [] as string[] };
  const identity = { user: me.userId, org: me.orgId };
  FM.configure({
    identity: async () => identity,
    csrf: async () => me.csrf(),
    limits: { readTimeoutMs: 20000, readTimeoutAfterFailureMs: 20000 },
    fetch: async (input: any, init?: any) => {
      const request: Request = input instanceof Request ? input : new Request(input, init);
      if (net.down) throw new TypeError("Failed to fetch");
      const url = new URL(request.url);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, name) => { if (name !== "cookie" && name !== "x-platform-csrf") headers[name] = value; });
      // (Bytes, not text: an uploaded picture must arrive as it was.)
      const payload = ["GET", "HEAD"].includes(request.method) ? undefined : Buffer.from(await request.arrayBuffer());
      net.sent.push(`${request.method} ${url.pathname}`);
      const response = await me.raw(request.method, url.pathname + url.search, payload && payload.length ? payload : undefined, headers);
      return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers: { "content-type": String(response.headers["content-type"] || "application/json") } });
    }
  });
  const waits: Promise<unknown>[] = [];
  /** One request as the service worker would answer it for a page of this person. */
  const ask = async (method: string, target: string, json?: unknown) => {
    const request = new Request(ORIGIN + target, { method, headers: json === undefined ? {} : { "content-type": "application/json" }, body: json === undefined ? undefined : JSON.stringify(json) });
    const plan = FM.api.plan(request, identity, { waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    assert.ok(plan, `${method} ${target} is answered by the worker`);
    const response: Response = await plan();
    const data = await response.json().catch(() => null);
    while (waits.length) await waits.shift();
    return { status: response.status, queued: response.headers.get("x-fm-offline-queued"), from: response.headers.get("x-fm-offline"), data };
  };
  const entries = async () => [...(await FM.queue.list(identity))].map((entry: Json) => `${entry.state} ${entry.contract}/${entry.write}${entry.error ? ` ${entry.error.status} ${entry.error.code}` : ""}`);
  return { FM, net, identity, ask, entries };
}

/** The keys an offline answer lacks or adds, next to the real one. `serverOnly` are values only the server can make. */
function keyDifference(fake: Json, real: Json, serverOnly: string[] = []) {
  return {
    missing: Object.keys(real || {}).filter((key) => !(key in (fake || {})) && !serverOnly.includes(key)).sort(),
    extra: Object.keys(fake || {}).filter((key) => !(key in (real || {}))).sort()
  };
}
const NONE = { missing: [], extra: [] };

test("each write answers offline as its route would, and reaches the server once when the connection returns", async () => {
  const me = await owner();
  const d = device(me);
  const org = `/v1/platform/organizations/${me.orgId}`;
  const work = `/v1/work/organizations/${me.orgId}`;
  const channels = `/v1/channels/organizations/${me.orgId}`;
  const real = async (method: string, target: string, payload?: unknown) => { const response = await me.raw(method, target, payload); return { status: response.statusCode, json: response.json() as Json }; };
  const rid = () => `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  const todosUrl = (project: string) => `${work}/todos?project_id=${project}&branch_id=default&include_completed=1&include_future=1&include_unassigned=1&all_users=1`;
  const note = (text: string, extra: Json = {}) => ({ text, project_note: true, pin: false, client_msg_id: `note_${rid()}`, audience: [], tags: [], mention_users: [], attachment_ids: [], metadata: {}, ...extra });

  // What the real routes answer, for records made the ordinary way.
  const refProject = `project_${rid()}`;
  const realProject = await real("PUT", `${org}/projects/${refProject}`, { data: { id: refProject, title: "Reference", address: "1 Real Road" }, metadata: { kind: "platform_project", workflow_state: "", measurement_keys: [] }, create_only: true });
  assert.equal(realProject.status, 200, JSON.stringify(realProject.json));
  const realContact = await real("POST", `${org}/contacts`, { id: `contact_${rid()}`, contact_kind: "human", name: "Rea Lity", first_name: "Rea", last_name: "Lity", email: "rea@example.test", phone: "555-010-3301" });
  assert.equal(realContact.status, 200, JSON.stringify(realContact.json));
  const realTodo = await real("POST", `${work}/todos`, { id: `action_item_manual_${rid()}`, kind: "manual", title: "Reference to-do", body: "", branch_id: "default", source: "manual", frontend_action: { kind: "manual" }, metadata: { created_from: "test" }, project_id: refProject });
  assert.equal(realTodo.status, 201, JSON.stringify(realTodo.json));
  const realChannel = await real("POST", `${channels}/channels/project/${refProject}`);
  assert.equal(realChannel.status, 200, JSON.stringify(realChannel.json));
  const realNote = await real("POST", `${channels}/channels/${realChannel.json.channel.id}/messages`, note("Reference note"));
  assert.equal(realNote.status, 201, JSON.stringify(realNote.json));
  const realEvent = await real("POST", `${org}/projects/${refProject}/events`, { event: { id: `event_${rid()}`, title: "Reference visit", start_at: "2027-01-05T15:00:00.000Z", end_at: "2027-01-05T16:00:00.000Z", status: "scheduled" }, branch_id: "default" });
  assert.equal(realEvent.status, 200, JSON.stringify(realEvent.json));
  const realLinks = await real("PUT", `${org}/projects/${refProject}/contacts`, { contacts: [{ contact_id: realContact.json.contact.id, primary: true }] });
  assert.equal(realLinks.status, 200, JSON.stringify(realLinks.json));

  // The page read these while it had a connection: they are on the device.
  const refNotes = `${channels}/channels/${realChannel.json.channel.id}/messages?limit=200&view=notes`;
  for (const target of ["/v1/platform/me", `${org}/projects`, `${org}/contacts?limit=200`, `${work}/todos?branch_id=default&include_completed=1&include_future=1`, `${org}/projects/${refProject}`, refNotes, todosUrl(refProject)]) {
    assert.equal((await d.ask("GET", target)).status, 200, target);
  }

  // ---- no connection ----
  d.net.down = true;
  const project = `project_${rid()}`, contact = `contact_${rid()}`, todoPageId = `action_item_manual_${rid()}`, eventId = `event_${rid()}`;

  const madeProject = await d.ask("PUT", `${org}/projects/${project}`, { data: { id: project, title: "Made offline", address: "2 Queue Street" }, metadata: { kind: "platform_project", workflow_state: "", measurement_keys: [] }, create_only: true });
  assert.ok(madeProject.queued, "the create is queued");
  assert.deepEqual(keyDifference(madeProject.data, realProject.json), NONE);
  assert.deepEqual(keyDifference(madeProject.data.document, realProject.json.document), NONE);
  assert.equal(madeProject.data.document.data.title, "Made offline");
  // The new project answers its own reads and is in the list.
  const seeded = await d.ask("GET", `${org}/projects/${project}`);
  assert.deepEqual([seeded.status, seeded.from, seeded.data.document.id], [200, "queued", project]);
  assert.ok((await d.ask("GET", `${org}/projects`)).data.documents.some((item: Json) => item.id === project), "the list shows the new project");
  assert.deepEqual((await d.ask("GET", todosUrl(project))).data.todos, [], "a new project has no to-dos yet");

  const patchedProject = await d.ask("PATCH", `${org}/projects/${project}`, { data: { title: "Made offline, renamed", updated_at: new Date().toISOString() }, metadata: { workflow_state: "", measurement_keys: [] } });
  assert.ok(patchedProject.queued);
  assert.deepEqual(keyDifference(patchedProject.data.document, realProject.json.document), NONE);
  assert.deepEqual([patchedProject.data.document.data.title, patchedProject.data.document.data.address], ["Made offline, renamed", "2 Queue Street"], "the answer is the whole project with the change");
  assert.equal((await d.ask("GET", `${org}/projects/${project}`)).data.document.data.title, "Made offline, renamed");

  const madeContact = await d.ask("POST", `${org}/contacts`, { id: contact, contact_kind: "human", name: "Olive Queue", first_name: "Olive", last_name: "Queue", email: "Olive@Example.test", phone: "555-010-4400" });
  assert.ok(madeContact.queued);
  assert.deepEqual(keyDifference(madeContact.data.contact, realContact.json.contact), NONE);
  assert.deepEqual([madeContact.data.contact.id, madeContact.data.contact.email, madeContact.data.contact.emails[0].value], [contact, "olive@example.test", "olive@example.test"]);
  assert.deepEqual(Object.keys(madeContact.data.contact.phones[0]).sort(), Object.keys(realContact.json.contact.phones[0]).sort());
  assert.ok((await d.ask("GET", `${org}/contacts?limit=200`)).data.contacts.some((item: Json) => item.id === contact), "the contact list shows the new contact");
  const editedContact = await d.ask("PATCH", `${org}/contacts/${contact}`, { contact: { company: "Queue & Sons", phone: "555-010-4411" } });
  assert.deepEqual([!!editedContact.queued, editedContact.data.contact.company, editedContact.data.contact.phone, editedContact.data.contact.name], [true, "Queue & Sons", "555-010-4411", "Olive Queue"]);

  const linked = await d.ask("PUT", `${org}/projects/${project}/contacts`, { contacts: [{ contact_id: contact, primary: true }] });
  assert.ok(linked.queued);
  assert.deepEqual(keyDifference(linked.data, realLinks.json), NONE);
  assert.deepEqual(linked.data.contacts, [{ contact_id: contact, role: "", primary: true }]);
  const withContact = (await d.ask("GET", `${org}/projects/${project}`)).data.document.data;
  assert.deepEqual([withContact.contacts.length, withContact.contacts[0].name, withContact.customer_name, withContact.primary_contact_id], [1, "Olive Queue", "Olive Queue", contact]);
  const realProjection = (await real("GET", `${org}/projects/${refProject}`)).json.document.data.contacts[0];
  assert.deepEqual(keyDifference(withContact.contacts[0], realProjection), NONE, "the project's copy of a contact has the server's fields");

  const madeTodo = await d.ask("POST", `${work}/todos`, { id: todoPageId, kind: "manual", title: "Offline to-do", body: "", branch_id: "default", source: "manual", frontend_action: { kind: "manual" }, metadata: { created_from: "test" }, project_id: project });
  assert.ok(madeTodo.queued);
  assert.deepEqual(keyDifference(madeTodo.data, realTodo.json), NONE);
  // Raw storage columns (`*_json`) and the tree's own lists are the server's; the app reads the parsed fields.
  const todoServerOnly = Object.keys(realTodo.json.todo).filter((key) => key.endsWith("_json")).concat(["dependencies", "children"]);
  assert.deepEqual(keyDifference(madeTodo.data.todo, realTodo.json.todo, todoServerOnly), { missing: [], extra: ["project_address", "project_title"] }, "a to-do as lists show it");
  const todoId = madeTodo.data.todo.id;
  assert.deepEqual((await d.ask("GET", todosUrl(project))).data.todos.map((todo: Json) => [todo.id, todo.status]), [[todoId, "ready"]]);
  const done = await d.ask("POST", `${work}/nodes/${todoId}/transition`, { status: "completed", reason: "manual" });
  assert.deepEqual([!!done.queued, done.data.node.id, done.data.node.status, done.data.node.title], [true, todoId, "completed", "Offline to-do"]);
  assert.deepEqual((await d.ask("GET", todosUrl(project))).data.todos.map((todo: Json) => todo.status), ["completed"]);
  // A to-do the server already had is completed and renamed from the list that showed it.
  const refTodoId = realTodo.json.todo.id;
  const refDone = await d.ask("POST", `${work}/nodes/${refTodoId}/transition`, { status: "completed", reason: "manual" });
  assert.deepEqual([refDone.data.node.title, refDone.data.node.status], ["Reference to-do", "completed"]);
  const refRenamed = await d.ask("PATCH", `${work}/nodes/${refTodoId}`, { title: "Reference to-do, renamed" });
  assert.deepEqual([!!refRenamed.queued, refRenamed.data.node.title], [true, "Reference to-do, renamed"]);

  const localNotes = `${channels}/channels/chan_local_${project}/messages?limit=200&view=notes`;
  assert.deepEqual((await d.ask("GET", `${channels}/channels/project/${project}`)).data.channel.id, `chan_local_${project}`, "a project made here has a local channel");
  const noteNew = await d.ask("POST", `${channels}/channels/project/${project}/messages`, note("Note on the new project"));
  assert.ok(noteNew.queued);
  assert.deepEqual(keyDifference(noteNew.data.message, realNote.json.message), NONE);
  assert.deepEqual((await d.ask("GET", localNotes)).data.messages.map((message: Json) => message.text), ["Note on the new project"]);
  const noteOld = await d.ask("POST", `${channels}/channels/${realChannel.json.channel.id}/messages`, note("Note on a known project"));
  assert.ok(noteOld.queued);
  assert.deepEqual(keyDifference(noteOld.data, realNote.json), NONE);
  assert.deepEqual((await d.ask("GET", refNotes)).data.messages.map((message: Json) => message.text), ["Reference note", "Note on a known project"]);
  // A reply, or a note with an uploaded file, is not queued.
  assert.equal((await d.ask("POST", `${channels}/channels/${realChannel.json.channel.id}/messages`, { text: "A reply", parent_id: realNote.json.message.id, client_msg_id: `note_${rid()}` })).data.error, "offline_unavailable");

  const madeEvent = await d.ask("POST", `${org}/projects/${project}/events`, { event: { id: eventId, title: "Offline visit", start_at: "2027-01-06T15:00:00.000Z", end_at: "2027-01-06T16:30:00.000Z", status: "scheduled" }, branch_id: "default" });
  assert.ok(madeEvent.queued);
  assert.deepEqual(keyDifference(madeEvent.data, realEvent.json), NONE);
  assert.deepEqual([madeEvent.data.event.id, madeEvent.data.event.event_revision, madeEvent.data.event.duration_minutes, madeEvent.data.document.data.events.length], [eventId, 1, 90, 1]);
  assert.deepEqual((await d.ask("GET", `${org}/projects/${project}`)).data.document.data.events.map((event: Json) => event.title), ["Offline visit"]);

  // Every queued change has a title for the sync tray and a scope of its record.
  for (const entry of await d.FM.queue.list(d.identity)) {
    assert.ok(entry.label && entry.label.key && entry.label.title, `${entry.contract}/${entry.write} has a label`);
    assert.match(entry.scope, /^(project|contact|todo|channel):/, `${entry.write} scope`);
  }
  assert.equal((await d.entries()).length, 12);

  // ---- the connection returns ----
  d.net.down = false;
  await d.FM.replay.run();
  for (let round = 0; round < 3 && (await d.entries()).some((entry: string) => entry.startsWith("waiting")); round++) await d.FM.replay.run({ force: true });
  assert.deepEqual(await d.entries(), [], "everything was sent");

  const serverProject = (await real("GET", `${org}/projects/${project}`)).json.document;
  assert.deepEqual([serverProject.data.title, serverProject.data.address], ["Made offline, renamed", "2 Queue Street"]);
  assert.deepEqual(serverProject.data.contacts.map((entry: Json) => [entry.contact_id, entry.name, entry.primary]), [[contact, "Olive Queue", true]]);
  assert.deepEqual(serverProject.data.events.map((event: Json) => [event.id, event.title]), [[eventId, "Offline visit"]]);
  assert.equal((await real("GET", `${org}/projects`)).json.documents.filter((item: Json) => item.id === project).length, 1);
  const serverContact = (await real("GET", `${org}/contacts/${contact}`)).json.contact;
  assert.deepEqual([serverContact.name, serverContact.company, serverContact.phone], ["Olive Queue", "Queue & Sons", "555-010-4411"]);
  assert.equal((await real("GET", `${org}/contacts?limit=200`)).json.contacts.filter((item: Json) => item.id === contact).length, 1);
  const serverTodos = (await real("GET", todosUrl(project))).json.todos.filter((todo: Json) => todo.title === "Offline to-do");
  assert.deepEqual(serverTodos.map((todo: Json) => [todo.id, todo.status]), [[todoId, "completed"]], "the to-do has the id the device gave it");
  const refTodo = (await real("GET", todosUrl(refProject))).json.todos.find((todo: Json) => todo.id === refTodoId);
  assert.deepEqual([refTodo.title, refTodo.status], ["Reference to-do, renamed", "completed"]);
  const newChannel = (await real("GET", `${channels}/channels/project/${project}`)).json.channel;
  assert.deepEqual((await real("GET", `${channels}/channels/${newChannel.id}/messages?limit=200&view=notes`)).json.messages.map((message: Json) => message.text), ["Note on the new project"]);
  assert.deepEqual((await real("GET", refNotes)).json.messages.map((message: Json) => message.text), ["Reference note", "Note on a known project"]);
  // After the sync the device's reads are the server's again.
  assert.equal((await d.ask("GET", `${org}/projects/${project}`)).from, null);

  // ---- a create whose first answer was lost: the server says it is there, and that is the end of it ----
  d.net.down = true;
  await d.ask("PUT", `${org}/projects/${project}`, { data: { id: project, title: "Made offline" }, metadata: { kind: "platform_project" }, create_only: true });
  await d.ask("POST", `${org}/contacts`, { id: contact, contact_kind: "human", name: "Olive Queue" });
  d.net.down = false;
  await d.FM.replay.run({ force: true });
  assert.deepEqual(await d.entries(), [], "project_exists and contact_exists mean done");
  assert.equal((await real("GET", `${org}/projects/${project}`)).json.document.data.title, "Made offline, renamed", "the repeat changed nothing");

  // ---- an edit made offline while the server's copy changed: different fields merge, the same field asks ----
  const shown = (await d.ask("GET", `${org}/projects/${project}`)).data.document.data.events[0];
  await d.ask("GET", `${org}/contacts/${contact}`);
  d.net.down = true;
  // An event edit carries the revision the page saw; the server's event moved on meanwhile (its start changed).
  const editedEvent = await d.ask("POST", `${org}/projects/${project}/events`, { event: { id: eventId, title: "Offline visit, renamed", expected_event_revision: shown.event_revision }, branch_id: "default" });
  assert.deepEqual([!!editedEvent.queued, editedEvent.data.event.title, editedEvent.data.event.start_at, editedEvent.data.event.event_revision], [true, "Offline visit, renamed", shown.start_at, shown.event_revision + 1]);
  d.net.down = false;
  assert.equal((await real("POST", `${org}/projects/${project}/events`, { event: { id: eventId, start_at: "2027-01-07T15:00:00.000Z", end_at: "2027-01-07T16:30:00.000Z", expected_event_revision: shown.event_revision }, branch_id: "default" })).status, 200);
  const stale = await real("POST", `${org}/projects/${project}/events`, { event: { id: eventId, title: "Stale", expected_event_revision: shown.event_revision }, branch_id: "default" });
  assert.deepEqual([stale.status, stale.json.error], [409, "stale_event"], "the route refuses a revision the event has moved past");
  await d.FM.replay.run({ force: true });
  assert.deepEqual(await d.entries(), []);
  const serverEvent = (await real("GET", `${org}/projects/${project}`)).json.document.data.events[0];
  assert.deepEqual([serverEvent.title, serverEvent.start_at, serverEvent.event_revision], ["Offline visit, renamed", "2027-01-07T15:00:00.000Z", shown.event_revision + 2], "the rename is merged onto the moved event");
  await d.ask("GET", `${org}/projects/${project}`);
  d.net.down = true;
  await d.ask("PATCH", `${org}/projects/${project}`, { data: { title: "Renamed on the device" }, metadata: {} });
  await d.ask("PATCH", `${org}/contacts/${contact}`, { contact: { company: "Device Co", notes: "From the device" } });
  d.net.down = false;
  assert.equal((await real("PATCH", `${org}/projects/${project}`, { data: { address: "3 Server Avenue" }, metadata: {} })).status, 200);
  assert.equal((await real("PATCH", `${org}/contacts/${contact}`, { contact: { company: "Server Co", birthday: "1990-01-01" } })).status, 200);
  await d.FM.replay.run({ force: true });
  const merged = (await real("GET", `${org}/projects/${project}`)).json.document.data;
  assert.deepEqual([merged.title, merged.address], ["Renamed on the device", "3 Server Avenue"], "both changes are kept");
  assert.deepEqual(await d.entries(), ["conflict contacts/contact.patch"], "the company was changed on both sides");
  const conflict = (await d.FM.queue.list(d.identity))[0];
  assert.deepEqual([...conflict.conflict.fields].map((field: Json) => [field.path, field.mine, field.theirs]), [["company", "Device Co", "Server Co"]]);
  await d.FM.queue.resolve(conflict.id, { company: "theirs" });
  await d.FM.replay.run({ force: true });
  const settled = (await real("GET", `${org}/contacts/${contact}`)).json.contact;
  assert.deepEqual([settled.company, settled.notes, settled.birthday], ["Server Co", "From the device", "1990-01-01"]);
  assert.deepEqual(await d.entries(), []);
});

test("the to-do widget's published actions are queued with their own key and run once", async () => {
  const me = await owner();
  const d = device(me);
  const work = `/v1/work/organizations/${me.orgId}`;
  const publication = `/v1/publication/organizations/${me.orgId}`;
  const real = async (method: string, target: string, payload?: unknown) => { const response = await me.raw(method, target, payload); return { status: response.statusCode, json: response.json() as Json }; };
  const made = await real("POST", `${work}/todos`, { id: `action_item_manual_${Date.now().toString(36)}_widget01`, kind: "manual", title: "Widget to-do", body: "", branch_id: "default", source: "manual", frontend_action: { kind: "manual" }, metadata: {} });
  assert.equal(made.status, 201, JSON.stringify(made.json));
  const id = made.json.todo.id;
  const target = { scope: "organization", organizationId: me.orgId };
  const read = { provider: "todos", export: "items", target, args: { includeCompleted: true, includeFuture: true } };
  const items = await d.ask("POST", `${publication}/data/read`, read);
  assert.equal(items.data.status, "ready", JSON.stringify(items.data));
  assert.equal(items.data.value.find((item: Json) => item.id === id).status, "open");
  // What the real route answers for the same action on another to-do.
  const other = await real("POST", `${work}/todos`, { id: `action_item_manual_${Date.now().toString(36)}_widget02`, kind: "manual", title: "Other", body: "", branch_id: "default", source: "manual", frontend_action: { kind: "manual" }, metadata: {} });
  const realAction = await real("POST", `${publication}/actions/invoke`, { action: "work.todos.transition", target: { ...target, id: other.json.todo.id }, input: { status: "completed" }, idempotencyKey: "todo-widget-real-1" });
  assert.equal(realAction.status, 200, JSON.stringify(realAction.json));

  d.net.down = true;
  const body = { action: "work.todos.transition", target: { ...target, id }, input: { status: "completed" }, idempotencyKey: "todo-widget-offline-1" };
  const queued = await d.ask("POST", `${publication}/actions/invoke`, body);
  assert.ok(queued.queued, "the action is queued");
  assert.deepEqual(keyDifference(queued.data, realAction.json), NONE);
  assert.deepEqual(keyDifference(queued.data.receipt, realAction.json.receipt), NONE);
  assert.equal(queued.data.receipt.status, "succeeded", "the widget reads the receipt");
  assert.equal((await d.ask("POST", `${publication}/data/read`, read)).data.value.find((item: Json) => item.id === id).status, "completed", "the widget's list shows it done");
  // Any other published action needs a connection.
  assert.equal((await d.ask("POST", `${publication}/actions/invoke`, { ...body, action: "work.configuration.save", idempotencyKey: "x" })).data.error, "offline_unavailable");

  d.net.down = false;
  await d.FM.replay.run({ force: true });
  assert.deepEqual(await d.entries(), []);
  const after = await real("GET", `${work}/nodes/${id}`);
  assert.equal(after.json.node.status, "completed");
  // The same key again is the first answer, not a second run.
  const repeat = await real("POST", `${publication}/actions/invoke`, body);
  assert.deepEqual([repeat.status, repeat.json.receipt.replayed], [200, true]);
});

test("photo edits and the uploads of other apps answer offline as their routes would, and arrive once", async () => {
  const me = await owner();
  const { enableExpandedPlatformFixture } = await import("./helpers/platform-fixture.js");
  await enableExpandedPlatformFixture(me.orgId, { "platform.contacts": true, "apps.channels": true, "channels.project_notes": true, "platform.project_docs": true, "platform.project_photos": true });
  const d = device(me);
  const org = `/v1/platform/organizations/${me.orgId}`;
  const channels = `/v1/channels/organizations/${me.orgId}`;
  const real = async (method: string, target: string, payload?: unknown) => { const response = await me.raw(method, target, payload); return { status: response.statusCode, json: response.json() as Json }; };
  const hex = (length: number) => { let out = ""; while (out.length < length) out += Math.random().toString(16).slice(2); return out.slice(0, length); };
  const mediaId = () => `media_${hex(16)}`;
  /** One multipart request as the service worker would answer it: sent when there is a connection, kept when not. */
  const askForm = async (target: string, fields: Record<string, unknown>, file: { name: string; type: string; text?: string; bytes?: Buffer }) => {
    const body = new FormData();
    body.append("file", new File([file.bytes ? new Uint8Array(file.bytes) : String(file.text)], file.name, { type: file.type }));
    for (const [name, value] of Object.entries(fields)) if (value !== undefined) body.append(name, typeof value === "object" ? JSON.stringify(value) : String(value));
    const waits: Promise<unknown>[] = [];
    const plan = d.FM.api.plan(new Request(ORIGIN + target, { method: "POST", body }), d.identity, { waitUntil: (promise: Promise<unknown>) => waits.push(promise) });
    assert.ok(plan, `POST ${target} is answered by the worker`);
    const response: Response = await plan();
    const data = await response.json().catch(() => null);
    while (waits.length) await waits.shift();
    return { status: response.status, queued: response.headers.get("x-fm-offline-queued"), data: data as Json };
  };
  const jpeg = (name: string) => ({ name, type: "image/jpeg", text: `not-really-a-jpeg ${name}` });
  const pdf = (name: string) => ({ name, type: "application/pdf", text: `%PDF-1.4 ${name}` });

  // ---- records made the ordinary way ----
  const project = `project_${hex(12)}`;
  assert.equal((await real("PUT", `${org}/projects/${project}`, { data: { id: project, title: "Uploads", address: "4 Queue Street" }, metadata: { kind: "platform_project", workflow_state: "", measurement_keys: [] }, create_only: true })).status, 200);
  const contact = `contact_${hex(12)}`;
  assert.equal((await real("POST", `${org}/contacts`, { id: contact, contact_kind: "human", name: "Uma Pload" })).status, 200);
  const channel = (await real("POST", `${channels}/channels/project/${project}`)).json.channel.id as string;
  const checklistsUrl = `/v1/workforce/organizations/${me.orgId}/crew/projects/${project}/checklists`;
  const madeChecklist = await real("POST", checklistsUrl, { title: "Site photos", assignment_policy: { schema_version: 1, mode: "any", allow_unassigned: true, rules: [] }, items: [{ title: "Photograph the deck" }, { title: "Photograph the gutters" }] });
  assert.equal(madeChecklist.status, 201, JSON.stringify(madeChecklist.json));
  const checklist = madeChecklist.json.checklist.id as string;
  const items = (await real("GET", checklistsUrl)).json.checklists.find((entry: Json) => entry.id === checklist).items as Json[];
  const photoForm = (id: string) => ({ id, owner_type: "project", owner_id: project, slot: "photos", collection: "projects", scope: "projects", replace_slot: "false", thumbnails: "true", metadata: { field: "photos", source: "project_photo_upload" } });
  const contactForm = (id: string, slot: string) => ({ id, owner_type: "contact", owner_id: contact, slot, collection: "contacts", scope: "contact", metadata: { contact_draft: false } });
  const docForm = (id: string, title: string) => ({ id, metadata: { title, label: title, document_type: "document", source: "project_document_upload" } });
  const notesUrl = `${channels}/channels/${channel}/messages?limit=200&view=notes`;
  const noteBody = (text: string, attachment: string) => ({ text, project_note: true, pin: false, client_msg_id: `note_${hex(12)}`, audience: [], tags: [], mention_users: [], attachment_ids: [attachment], metadata: {} });

  // ---- what the real routes answer, with a connection (the worker passes these through) ----
  const realPhoto = await askForm(`${org}/media`, photoForm(mediaId()), jpeg("Ridge.jpg"));
  assert.deepEqual([realPhoto.status, realPhoto.queued], [201, null], JSON.stringify(realPhoto.data));
  const photo = realPhoto.data.media.id as string;
  const realRename = await d.ask("PATCH", `${org}/media/${photo}`, { name: "Ridge line" });
  assert.deepEqual([realRename.status, realRename.queued, realRename.data.media.label, realRename.data.media.file_name], [200, null, "Ridge line", "Ridge line.jpg"]);
  const realContactFile = await askForm(`${org}/media`, contactForm(mediaId(), "document"), pdf("Old warranty.pdf"));
  assert.equal(realContactFile.status, 201, JSON.stringify(realContactFile.data));
  const realDocument = await askForm(`${org}/projects/${project}/documents`, docForm(mediaId(), "Permit.pdf"), pdf("Permit.pdf"));
  assert.equal(realDocument.status, 201, JSON.stringify(realDocument.data));
  const realEvidence = await askForm(`${checklistsUrl}/${checklist}/items/${items[1]!.id}/attachments`, { media_id: mediaId() }, jpeg("Gutters.jpg"));
  assert.equal(realEvidence.status, 200, JSON.stringify(realEvidence.data));
  const realUpload = await askForm(`${channels}/uploads`, { channel_id: channel, attachment_id: `att_${hex(32)}`, media_id: mediaId() }, jpeg("Before.jpg"));
  assert.equal(realUpload.status, 201, JSON.stringify(realUpload.data));
  const realNote = await real("POST", `${channels}/channels/${channel}/messages`, noteBody("With a file", realUpload.data.attachment.id));
  assert.equal(realNote.status, 201, JSON.stringify(realNote.json));
  assert.equal(realNote.json.message.attachments.length, 1);

  // The page read these while it had a connection.
  for (const target of ["/v1/platform/me", `${org}/projects/${project}`, `${org}/media`, `${org}/media?contact_id=${contact}`, `${org}/projects/${project}/documents`, checklistsUrl, notesUrl, `${org}/contacts/${contact}`]) {
    assert.equal((await d.ask("GET", target)).status, 200, target);
  }

  // ---- no connection ----
  d.net.down = true;
  const before = (await d.entries()).length;

  // Renaming and tagging: a photo the server has, and one that is itself still waiting.
  const tagged = await d.ask("PATCH", `${org}/media/${photo}`, { tags: ["Storm Damage", "#ridge"] });
  assert.ok(tagged.queued);
  assert.deepEqual(keyDifference(tagged.data, realRename.data), NONE);
  assert.deepEqual(keyDifference(tagged.data.media, realRename.data.media), { missing: [], extra: ["tags"] }, "a record that was never tagged has no tags yet");
  assert.deepEqual([tagged.data.media.tags, tagged.data.media.metadata.tags, tagged.data.media.label], [["storm_damage", "ridge"], ["storm_damage", "ridge"], "Ridge line"]);
  const newPhoto = mediaId();
  const waitingPhoto = await askForm(`${org}/media`, photoForm(newPhoto), jpeg("Valley.jpg"));
  assert.ok(waitingPhoto.queued);
  const renamedWaiting = await d.ask("PATCH", `${org}/media/${newPhoto}`, { name: "North valley" });
  assert.deepEqual([!!renamedWaiting.queued, renamedWaiting.data.media.label, renamedWaiting.data.media.file_name, renamedWaiting.data.media.owner.id], [true, "North valley", "North valley.jpg", project]);
  assert.deepEqual((await d.ask("GET", `${org}/media`)).data.media.filter((item: Json) => [photo, newPhoto].includes(item.id)).map((item: Json) => [item.id, item.label, item.tags || []]), [[photo, "Ridge line", ["storm_damage", "ridge"]], [newPhoto, "North valley", []]]);

  // A contact's picture and a contact's file.
  const picture = mediaId(), contactFile = mediaId();
  // (A real picture: the route checks that a contact's picture decodes.)
  const png = await (await import("sharp")).default({ create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 120, b: 200 } } }).png().toBuffer();
  const offPicture = await askForm(`${org}/media`, contactForm(picture, "profile"), { name: "profile-photo.png", type: "image/png", bytes: png });
  assert.ok(offPicture.queued);
  const offContactFile = await askForm(`${org}/media`, contactForm(contactFile, "document"), pdf("Warranty.pdf"));
  assert.deepEqual(keyDifference(offContactFile.data, realContactFile.data), NONE);
  // (Who uploaded it by name and e-mail, and the checksum of the stored bytes, are the server's to add.)
  const mediaServerOnly = Object.keys(realContactFile.data.media).filter((key) => !(key in offContactFile.data.media));
  assert.deepEqual(mediaServerOnly.filter((key) => !["checksum", "sha256", "etag", "storage"].includes(key)), [], `server-only media fields: ${mediaServerOnly.join(", ")}`);
  assert.deepEqual(keyDifference(offContactFile.data.media, realContactFile.data.media, mediaServerOnly).extra, []);
  assert.deepEqual([offContactFile.data.media.owner, offContactFile.data.media.kind, offContactFile.data.media.file_name], [{ type: "contact", id: contact, slot: "document" }, realContactFile.data.media.kind, "Warranty.pdf"]);
  const patched = await d.ask("PATCH", `${org}/contacts/${contact}`, { contact: { custom_field_values: { profile_photo: { media_id: picture } } } });
  assert.ok(patched.queued, "the contact's own save follows in the contact's scope");
  assert.deepEqual((await d.ask("GET", `${org}/media?contact_id=${contact}`)).data.media.map((item: Json) => item.id).sort(), [realContactFile.data.media.id, picture, contactFile].sort());

  // A file added to the project's documents list.
  const documentId = mediaId();
  const offDocument = await askForm(`${org}/projects/${project}/documents`, docForm(documentId, "Signed contract.pdf"), pdf("Signed contract.pdf"));
  assert.ok(offDocument.queued);
  assert.deepEqual(keyDifference(offDocument.data, realDocument.data), NONE);
  assert.deepEqual(keyDifference(offDocument.data.document, realDocument.data.document), NONE);
  assert.deepEqual(Object.keys(offDocument.data.document.metadata).sort(), Object.keys(realDocument.data.document.metadata).filter((key) => key !== "uploaded_by_email").sort());
  assert.deepEqual([offDocument.data.document.title, offDocument.data.document.type_label, offDocument.data.document.icon, offDocument.data.document.color], ["Signed contract.pdf", realDocument.data.document.type_label, realDocument.data.document.icon, realDocument.data.document.color]);
  assert.deepEqual(offDocument.data.uploaded_documents.map((item: Json) => item.id), [realDocument.data.document.id, documentId]);
  assert.deepEqual((await d.ask("GET", `${org}/projects/${project}/documents`)).data.uploaded_documents.map((item: Json) => item.id), [realDocument.data.document.id, documentId]);

  // Checklist evidence.
  const evidenceId = mediaId();
  const evidenceUrl = `${checklistsUrl}/${checklist}/items/${items[0]!.id}/attachments`;
  const offEvidence = await askForm(evidenceUrl, { media_id: evidenceId }, jpeg("Deck.jpg"));
  assert.ok(offEvidence.queued);
  assert.deepEqual(keyDifference(offEvidence.data, realEvidence.data), NONE);
  assert.deepEqual(keyDifference(offEvidence.data.attachment, realEvidence.data.attachment), NONE);
  assert.deepEqual(keyDifference(offEvidence.data.item, realEvidence.data.item), NONE, "the item as the checklist read gave it");
  assert.deepEqual(Object.keys(offEvidence.data.item.metadata.attachments[0]).sort(), Object.keys(realEvidence.data.item.metadata.attachments[0]).sort());
  const shownItem = (await d.ask("GET", checklistsUrl)).data.checklists.find((entry: Json) => entry.id === checklist).items.find((item: Json) => item.id === items[0]!.id);
  assert.deepEqual(shownItem.metadata.attachments.map((attachment: Json) => attachment.media_id), [evidenceId]);

  // A note with a file.
  const attachmentId = `att_${hex(32)}`, noteMedia = mediaId();
  const offUpload = await askForm(`${channels}/uploads`, { channel_id: channel, attachment_id: attachmentId, media_id: noteMedia }, jpeg("Leak.jpg"));
  assert.ok(offUpload.queued);
  assert.deepEqual(keyDifference(offUpload.data, realUpload.data), NONE);
  assert.deepEqual(keyDifference(offUpload.data.attachment, realUpload.data.attachment), NONE);
  const offNoteBody = noteBody("Leak by the chimney", attachmentId);
  const offNote = await d.ask("POST", `${channels}/channels/${channel}/messages`, offNoteBody);
  assert.ok(offNote.queued);
  assert.deepEqual(keyDifference(offNote.data.message, realNote.json.message), NONE);
  assert.deepEqual(keyDifference(offNote.data.message.attachments[0], realNote.json.message.attachments[0]), NONE);
  assert.deepEqual((await d.ask("GET", notesUrl)).data.messages.map((message: Json) => [message.text, message.attachments.length]), [["With a file", 1], ["Leak by the chimney", 1]]);
  // A note on a file the device does not hold, and a receipt, need a connection.
  assert.equal((await d.ask("POST", `${channels}/channels/${channel}/messages`, noteBody("No file here", `att_${hex(32)}`))).data.error, "offline_unavailable");
  assert.equal(d.FM.api.plan(new Request(`${ORIGIN}/v1/payments/organizations/${me.orgId}/projects/${project}/receipts`, { method: "POST", body: new FormData() }), d.identity, {}), null, "payments routes are never answered by the worker");

  const queued = await d.FM.queue.list(d.identity);
  for (const entry of queued) {
    assert.ok(entry.label && entry.label.key && entry.label.title, `${entry.contract}/${entry.write} has a label`);
    assert.match(entry.scope, /^(project|contact|media|attachment):/, `${entry.write} scope`);
  }
  assert.equal(queued.length - before, 10);

  // ---- the connection returns ----
  d.net.down = false;
  await d.FM.replay.run();
  for (let round = 0; round < 4 && (await d.entries()).some((entry: string) => entry.startsWith("waiting")); round++) await d.FM.replay.run({ force: true });
  assert.deepEqual(await d.entries(), [], "everything was sent");

  const library = (await real("GET", `${org}/media`)).json.media as Json[];
  const stored = (id: string) => library.filter((item) => item.id === id);
  assert.deepEqual(stored(photo).map((item) => [item.label, item.tags]), [["Ridge line", ["storm_damage", "ridge"]]]);
  assert.deepEqual(stored(newPhoto).map((item) => [item.label, item.file_name, item.owner.id]), [["North valley", "North valley.jpg", project]], "the rename was sent after the photo's own upload");
  assert.deepEqual((await real("GET", `${org}/media?contact_id=${contact}`)).json.media.map((item: Json) => item.id).sort(), [realContactFile.data.media.id, picture, contactFile].sort());
  assert.equal((await real("GET", `${org}/contacts/${contact}`)).json.contact.profile_media_id, picture);
  const documents = (await real("GET", `${org}/projects/${project}/documents`)).json;
  assert.deepEqual(documents.uploaded_documents.map((item: Json) => [item.id, item.title]), [[realDocument.data.document.id, "Permit.pdf"], [documentId, "Signed contract.pdf"]]);
  const serverItem = (await real("GET", checklistsUrl)).json.checklists.find((entry: Json) => entry.id === checklist).items.find((item: Json) => item.id === items[0]!.id);
  assert.deepEqual(serverItem.metadata.attachments.map((attachment: Json) => [attachment.media_id, attachment.kind]), [[evidenceId, "photo"]]);
  assert.equal(stored(evidenceId).length, 1);
  const notes = (await real("GET", notesUrl)).json.messages as Json[];
  assert.deepEqual(notes.map((message) => [message.text, message.attachments.map((attachment: Json) => [attachment.id, attachment.media_id])]), [["With a file", [[realUpload.data.attachment.id, realUpload.data.attachment.media_id]]], ["Leak by the chimney", [[attachmentId, noteMedia]]]]);

  // ---- each upload again, as a retry whose first answer was lost: nothing is there twice ----
  d.net.down = true;
  await askForm(`${org}/projects/${project}/documents`, docForm(documentId, "Signed contract.pdf"), pdf("Signed contract.pdf"));
  await askForm(evidenceUrl, { media_id: evidenceId }, jpeg("Deck.jpg"));
  await askForm(`${channels}/uploads`, { channel_id: channel, attachment_id: attachmentId, media_id: noteMedia }, jpeg("Leak.jpg"));
  await askForm(`${org}/media`, contactForm(contactFile, "document"), pdf("Warranty.pdf"));
  d.net.down = false;
  await d.FM.replay.run({ force: true });
  assert.deepEqual(await d.entries(), []);
  assert.equal((await real("GET", `${org}/projects/${project}/documents`)).json.uploaded_documents.length, 2);
  assert.equal((await real("GET", checklistsUrl)).json.checklists.find((entry: Json) => entry.id === checklist).items.find((item: Json) => item.id === items[0]!.id).metadata.attachments.length, 1);
  assert.deepEqual((await real("GET", notesUrl)).json.messages.map((message: Json) => message.attachments.length), [1, 1]);
  assert.equal((await real("GET", `${org}/media?contact_id=${contact}`)).json.media.length, 3);
  // Ids someone else holds are refused, not overwritten.
  const stolen = await askForm(`${channels}/uploads`, { channel_id: channel, attachment_id: attachmentId, media_id: mediaId() }, jpeg("Other.jpg"));
  assert.deepEqual([stolen.status, stolen.data.error], [409, "attachment_id_taken"]);
  const wrongOwner = await askForm(`${org}/projects/${project}/documents`, docForm(photo, "Not a document"), pdf("x.pdf"));
  assert.deepEqual([wrongOwner.status, wrongOwner.data.error], [409, "media_id_taken"]);
  const wrongItem = await askForm(`${checklistsUrl}/${checklist}/items/${items[1]!.id}/attachments`, { media_id: evidenceId }, jpeg("Deck.jpg"));
  assert.deepEqual([wrongItem.status, wrongItem.data.error], [409, "media_id_taken"]);
});
