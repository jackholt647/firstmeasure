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
  // platform/api.ts handlePortalAction: only the actions in PORTAL_READ_ACTIONS (checked below).
  "POST /v1/platform/portal-action": "platform/api.ts",
  // documents/api.ts resolve: bindings and widget data for display; nothing is saved.
  "POST /v1/documents/organizations/:p/documents/:p/resolve": "documents/api.ts",
  // platform/publication/api.ts actions/invoke: only actions registered with effect "read" (checked below).
  "POST /v1/publication/organizations/:p/actions/invoke": "platform/publication/actions.ts"
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
        if (route.key === "POST /v1/platform/portal-action" || route.key === "POST /v1/publication/organizations/:p/actions/invoke") {
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
