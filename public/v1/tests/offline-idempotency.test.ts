/**
 * Idempotency receipts for queued offline changes (docs/architecture/offline.md#server,
 * platform/offline/idempotency.ts).
 *
 * Two Fastify apps stand for two web nodes: they share nothing but the store,
 * which is the only place a receipt may live.
 */
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const SECRET = "offline-idempotency-fixture-session-secret";
let storageRoot = "";
let nodeA: any = null;
let nodeB: any = null;
let idempotency: typeof import("../platform/offline/idempotency.js");

/** How often each stand-in handler ran, by a name the request chooses. */
const runs = new Map<string, number>();
const ran = (name: string) => { const count = (runs.get(name) ?? 0) + 1; runs.set(name, count); return count; };
const count = (name: string) => runs.get(name) ?? 0;

/** Holds a `/slow` handler (named by the request's x-gate header) until the test opens it. */
type Gate = { entered: Promise<void>; enter: () => void; opened: Promise<void>; open: () => void };
const gates = new Map<string, Gate>();
function gate() {
  const id = randomUUID();
  let enter!: () => void, open!: () => void;
  const made: Gate = { entered: new Promise<void>((resolve) => { enter = resolve; }), enter: () => enter(), opened: new Promise<void>((resolve) => { open = resolve; }), open: () => open() };
  gates.set(id, made);
  return { ...made, header: { "x-gate": id } };
}

async function webNode() {
  const { default: Fastify } = await import("fastify");
  const { default: multipart } = await import("@fastify/multipart");
  const app = Fastify({ bodyLimit: 8 * 1024 * 1024 });
  idempotency.installOfflineIdempotency(app);
  await app.register(multipart);

  app.post("/things", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    reply.code(201);
    return { ok: true, id: body.id ?? null, run: ran(String(body.name ?? "things")), made_at: randomUUID() };
  });
  // What the compatibility host serves behind the web node's proxy.
  app.post("/v1/internal/things", async (request) => ({ ok: true, run: ran(String(((request.body ?? {}) as Record<string, unknown>).name)) }));
  app.put("/things", async (request) => ({ ok: true, run: ran(String(((request.body ?? {}) as Record<string, unknown>).name ?? "things")) }));
  app.get("/things", async (request) => ({ ok: true, run: ran(String((request.query as Record<string, unknown>).name)) }));
  app.delete("/things/:name", async (request, reply) => { ran(String((request.params as Record<string, unknown>).name)); return reply.code(204).send(); });
  app.post("/slow", async (request) => {
    const name = String(((request.body ?? {}) as Record<string, unknown>).name);
    const run = ran(name);
    const waiting = gates.get(String(request.headers["x-gate"] ?? ""));
    waiting?.enter();
    await waiting?.opened;
    return { ok: true, run };
  });
  // Answers the statuses in `plan` in turn, then 200. "throw" throws an ordinary error.
  app.post("/plan", async (request, reply) => {
    const body = (request.body ?? {}) as { name: string; plan: Array<number | "throw"> };
    const step = body.plan[ran(body.name) - 1];
    if (step === "throw") throw new Error("The handler broke.");
    if (step) return reply.code(step).send({ ok: false, error: `status_${step}` });
    return { ok: true, run: count(body.name) };
  });
  app.post("/big", async (request) => {
    ran(String(((request.body ?? {}) as Record<string, unknown>).name));
    return { ok: true, filler: "x".repeat(idempotency.MAX_STORED_BODY_BYTES + 10) };
  });
  // A route that reads Idempotency-Key itself, as the payment receipts route does.
  app.post("/own-key", async (request) => ({ ok: true, key: request.headers["idempotency-key"] ?? null, run: ran("own-key") }));
  app.post("/upload", async (request) => {
    let bytes = 0;
    const fields: Record<string, unknown> = {};
    for await (const part of (request as any).parts()) {
      if (part.type === "file") bytes += (await part.toBuffer()).length;
      else fields[part.fieldname] = part.value;
    }
    return { ok: true, bytes, run: ran(String(fields.name)) };
  });
  await app.ready();
  return app;
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-offline-idempotency-"));
  Object.assign(process.env, {
    NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1",
    EMAIL_OUTBOUND_DISABLED: "1", OPENAI_API_KEY: "", V1_LOG_LEVEL: "error", PLATFORM_SESSION_SECRET: SECRET,
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"),
    INTERNAL_STORAGE_ROOT: path.join(storageRoot, "internal"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    // SQLite by default; PostgreSQL through tests/run-embedded-postgres.mjs, which sets TEST_POSTGRES_URL.
    FIRSTMEASURE_DATABASE_MODE: process.env.TEST_POSTGRES_URL ? "postgres" : "local", DATABASE_URL: process.env.TEST_POSTGRES_URL || "",
    POSTGRES_POOL_MAX: "4", POSTGRES_AUTO_MIGRATE: "false", FIRSTMEASURE_ARTIFACT_STORAGE: "local"
  });
  idempotency = await import("../platform/offline/idempotency.js");
  nodeA = await webNode();
  nodeB = await webNode();
});

after(async () => {
  for (const each of gates.values()) each.open();
  await nodeA?.close();
  await nodeB?.close();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  await (await import("../src/database/postgres.js")).closePostgresPools().catch(() => undefined);
  await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

type Person = { orgId: string; userId: string; cookie: string };
async function person(label: string, orgId?: string): Promise<Person> {
  const storage = await import("../platform/storage.js");
  const org = orgId ?? String((await storage.createOrganization({ name: `${label} roofing` })).id);
  const email = `${label}-${randomUUID()}@example.test`;
  const userId = `${label}_${randomUUID().slice(0, 8)}`;
  const identity = await storage.createIdentity({ email, name: label, memberships: [{ organization_id: org, user_id: userId }] });
  await storage.upsertDocument(org, "users", { id: userId, data: { identity_id: identity.id, email, name: label, status: "active", org_permissions: { level: "owner", items: {} } } });
  const session = await storage.createAuthSession({ identity_id: identity.id, organization_id: org, user_id: userId, role: "owner" });
  const cookie = `fm_platform_session=${session.sessionId}.${createHmac("sha256", SECRET).update(session.sessionId).digest("base64url")}`;
  return { orgId: org, userId, cookie };
}

const newKey = () => `fmo1-${randomUUID()}`;
const send = (app: any, who: Person | null, method: string, url: string, payload: unknown, key?: string, headers: Record<string, string> = {}) =>
  app.inject({ method, url, payload, headers: { ...(who ? { cookie: who.cookie } : {}), ...(key ? { "idempotency-key": key } : {}), ...headers } });
const rowFor = async (who: Person, key: string) =>
  await idempotency.offlineIdempotencyStore().prepare("SELECT * FROM offline_idempotency WHERE organization_id = ? AND user_id = ? AND idempotency_key = ?").get(who.orgId, who.userId, key);

test("the first request runs; a repeat gets its answer and the handler does not run again", async () => {
  const ana = await person("ana");
  const key = newKey();
  const first = await send(nodeA, ana, "POST", "/things", { name: "first-repeat", id: "thing_1" }, key);
  assert.equal(first.statusCode, 201);
  assert.equal(first.headers["idempotency-replayed"], undefined);
  assert.equal(first.json().run, 1);

  // The repeat reaches the other web node, which has only the store to go on.
  for (const node of [nodeB, nodeA]) {
    const repeat = await send(node, ana, "POST", "/things", { name: "first-repeat", id: "thing_1" }, key);
    assert.equal(repeat.statusCode, 201, "the first status");
    assert.equal(repeat.headers["idempotency-replayed"], "true");
    assert.match(String(repeat.headers["content-type"]), /application\/json/);
    assert.deepEqual(repeat.json(), first.json(), "the first answer, byte for byte the same JSON");
  }
  assert.equal(count("first-repeat"), 1);

  // The same content with its keys in another order is the same request.
  const reordered = await send(nodeA, ana, "POST", "/things", { id: "thing_1", name: "first-repeat" }, key);
  assert.equal(reordered.headers["idempotency-replayed"], "true");
  // Upper case in the header is the same key.
  const upper = await send(nodeA, ana, "POST", "/things", { name: "first-repeat", id: "thing_1" }, key.toUpperCase());
  assert.equal(upper.headers["idempotency-replayed"], "true");
  assert.equal(count("first-repeat"), 1);

  const row = await rowFor(ana, key);
  assert.equal(idempotency.offlineIdempotencyStore().isPostgres, Boolean(process.env.TEST_POSTGRES_URL), "the store this run was asked to use");
  assert.equal(row?.state, "done");
  assert.ok(Math.abs(Number(row?.expires_at) - (Date.now() + idempotency.RECEIPT_TTL_MS)) < 60_000, "kept for 30 days");
});

test("a repeat while the first is running is told so, and the handler runs once", async () => {
  const ana = await person("busy");
  const key = newKey();
  const slow = gate();
  const first = send(nodeA, ana, "POST", "/slow", { name: "slow" }, key, slow.header);
  await slow.entered;

  const during = await send(nodeB, ana, "POST", "/slow", { name: "slow" }, key);
  assert.equal(during.statusCode, 409);
  assert.deepEqual([during.json().ok, during.json().error], [false, "idempotency_in_progress"]);
  assert.equal(during.headers["retry-after"], "2");
  assert.equal(count("slow"), 1, "the second request did not reach the handler");

  slow.open();
  assert.deepEqual((await first).json(), { ok: true, run: 1 });
  const afterwards = await send(nodeB, ana, "POST", "/slow", { name: "slow" }, key);
  assert.equal(afterwards.headers["idempotency-replayed"], "true");
  assert.deepEqual(afterwards.json(), { ok: true, run: 1 });
  assert.equal(count("slow"), 1);
});

test("many requests at once with one key, across both nodes: exactly one runs", async () => {
  const ana = await person("race");
  const key = newKey();
  const responses = await Promise.all(Array.from({ length: 12 }, (_unused, index) =>
    send(index % 2 ? nodeA : nodeB, ana, "POST", "/things", { name: "race", id: "raced" }, key)));
  const ranIt = responses.filter((response) => response.statusCode === 201 && !response.headers["idempotency-replayed"]);
  const replayed = responses.filter((response) => response.statusCode === 201 && response.headers["idempotency-replayed"] === "true");
  const busy = responses.filter((response) => response.statusCode === 409 && response.json().error === "idempotency_in_progress");
  assert.equal(ranIt.length, 1, "one request ran the handler");
  assert.equal(ranIt.length + replayed.length + busy.length, responses.length, "every other one was a replay or was told to wait");
  for (const response of replayed) assert.deepEqual(response.json(), ranIt[0]!.json());
  assert.equal(count("race"), 1);
});

test("a key used again for a different request is refused", async () => {
  const ana = await person("reuse");
  const key = newKey();
  assert.equal((await send(nodeA, ana, "POST", "/things?view=1", { name: "reuse", id: "a" }, key)).statusCode, 201);

  const otherBody = await send(nodeB, ana, "POST", "/things?view=1", { name: "reuse", id: "b" }, key);
  assert.equal(otherBody.statusCode, 422);
  assert.deepEqual([otherBody.json().ok, otherBody.json().error], [false, "idempotency_key_reused"]);
  assert.equal((await send(nodeA, ana, "PUT", "/things?view=1", { name: "reuse", id: "a" }, key)).statusCode, 422, "another method");
  assert.equal((await send(nodeA, ana, "POST", "/things?view=2", { name: "reuse", id: "a" }, key)).statusCode, 422, "another path");
  assert.equal((await send(nodeA, ana, "POST", "/plan?view=1", { name: "reuse", id: "a" }, key)).statusCode, 422, "another route");
  assert.equal(count("reuse"), 1, "none of them ran");

  // Also while the first is still running.
  const running = newKey();
  const slow = gate();
  const first = send(nodeA, ana, "POST", "/slow", { name: "reuse-running" }, running, slow.header);
  await slow.entered;
  assert.equal((await send(nodeB, ana, "POST", "/slow", { name: "something-else" }, running)).statusCode, 422);
  slow.open();
  await first;
});

test("a receipt belongs to one person in one organization, and the offline identity headers only refuse", async () => {
  const ana = await person("owner");
  const ben = await person("colleague", ana.orgId);
  const eve = await person("elsewhere");
  const key = newKey();
  const said = (who: Person) => ({ "x-fm-offline-user": who.userId, "x-fm-offline-org": who.orgId });

  assert.equal((await send(nodeA, ana, "POST", "/things", { name: "identity" }, key, said(ana))).json().run, 1);

  // Queued by Ana, sent with another session: refused before anything runs, whoever is signed in.
  for (const session of [ben, eve]) {
    const refused = await send(nodeB, session, "POST", "/things", { name: "identity" }, key, said(ana));
    assert.equal(refused.statusCode, 409);
    assert.deepEqual([refused.json().ok, refused.json().error], [false, "offline_identity_mismatch"]);
  }
  // One header is enough to refuse, with or without a key.
  assert.equal((await send(nodeA, ben, "POST", "/things", { name: "identity" }, undefined, { "x-fm-offline-user": ana.userId })).statusCode, 409);
  assert.equal((await send(nodeA, eve, "POST", "/things", { name: "identity" }, newKey(), { "x-fm-offline-org": ana.orgId })).statusCode, 409);
  assert.equal(count("identity"), 1);
  assert.equal(await rowFor(ben, key), undefined, "a refused request claims nothing");

  // The same key from another person is their own change: it runs, and Ana's receipt is not theirs to read.
  const bens = await send(nodeA, ben, "POST", "/things", { name: "identity" }, key, said(ben));
  assert.deepEqual([bens.statusCode, bens.headers["idempotency-replayed"], bens.json().run], [201, undefined, 2]);
  const eves = await send(nodeA, eve, "POST", "/things", { name: "identity" }, key);
  assert.deepEqual([eves.statusCode, eves.headers["idempotency-replayed"], eves.json().run], [201, undefined, 3]);

  // Nobody signed in: the headers and the key do nothing at all (the real handlers answer 401).
  const anonymous = await send(nodeA, null, "POST", "/things", { name: "identity" }, key, said(ana));
  assert.deepEqual([anonymous.statusCode, anonymous.headers["idempotency-replayed"], anonymous.json().run], [201, undefined, 4]);
  const again = await send(nodeA, null, "POST", "/things", { name: "identity" }, key, said(ana));
  assert.equal(again.json().run, 5, "no receipt is kept without a session");
});

test("a 5xx or a thrown error frees the key; the change runs again", async () => {
  const ana = await person("retry");
  const key = newKey();
  const body = { name: "retry", plan: [503, "throw", 500] };
  assert.equal((await send(nodeA, ana, "POST", "/plan", body, key)).statusCode, 503);
  assert.equal(await rowFor(ana, key), undefined, "nothing is kept for a 5xx");
  assert.equal((await send(nodeB, ana, "POST", "/plan", body, key)).statusCode, 500, "the thrown error");
  assert.equal((await send(nodeA, ana, "POST", "/plan", body, key)).statusCode, 500);
  const fourth = await send(nodeB, ana, "POST", "/plan", body, key);
  assert.deepEqual([fourth.statusCode, fourth.json()], [200, { ok: true, run: 4 }]);
  const fifth = await send(nodeA, ana, "POST", "/plan", body, key);
  assert.deepEqual([fifth.headers["idempotency-replayed"], fifth.json()], ["true", { ok: true, run: 4 }]);
  assert.equal(count("retry"), 4);
});

test("a 4xx about the request is kept; one about the moment frees the key", async () => {
  const ana = await person("refusals");
  for (const status of [400, 404, 422]) {
    const key = newKey(), name = `kept-${status}`;
    const first = await send(nodeA, ana, "POST", "/plan", { name, plan: [status] }, key);
    const repeat = await send(nodeB, ana, "POST", "/plan", { name, plan: [status] }, key);
    assert.deepEqual([first.statusCode, repeat.statusCode, repeat.headers["idempotency-replayed"]], [status, status, "true"]);
    assert.deepEqual(repeat.json(), first.json());
    assert.equal(count(name), 1);
  }
  // Signed out, a stale CSRF token, a revision that moved, a rate limit: the same change is sent again and must run.
  for (const status of [401, 403, 408, 409, 423, 429]) {
    const key = newKey(), name = `freed-${status}`;
    assert.equal((await send(nodeA, ana, "POST", "/plan", { name, plan: [status] }, key)).statusCode, status);
    const second = await send(nodeB, ana, "POST", "/plan", { name, plan: [status] }, key);
    assert.deepEqual([second.statusCode, second.headers["idempotency-replayed"], second.json().run], [200, undefined, 2]);
  }
  // After a 409 the merged change is sent under the same key with a new body, and is not taken for a reused key.
  const key = newKey();
  assert.equal((await send(nodeA, ana, "POST", "/plan", { name: "merge", plan: [409], expected_revision: 3 }, key)).statusCode, 409);
  const merged = await send(nodeA, ana, "POST", "/plan", { name: "merge", plan: [409], expected_revision: 4 }, key);
  assert.deepEqual([merged.statusCode, merged.json().run], [200, 2]);
});

test("a receipt answers for 30 days, then the key is new again; expired receipts are pruned in batches", async () => {
  const ana = await person("expiry");
  const key = newKey();
  assert.equal((await send(nodeA, ana, "POST", "/things", { name: "expiry" }, key)).json().run, 1);
  const db = idempotency.offlineIdempotencyStore();
  const setExpiry = (at: number) => db.prepare("UPDATE offline_idempotency SET expires_at = ? WHERE organization_id = ? AND user_id = ? AND idempotency_key = ?").run(at, ana.orgId, ana.userId, key);

  await setExpiry(Date.now() + 60_000);
  assert.equal((await send(nodeB, ana, "POST", "/things", { name: "expiry" }, key)).headers["idempotency-replayed"], "true", "a minute before it expires");
  await setExpiry(Date.now() - 1);
  const afterExpiry = await send(nodeB, ana, "POST", "/things", { name: "expiry" }, key);
  assert.deepEqual([afterExpiry.headers["idempotency-replayed"], afterExpiry.json().run], [undefined, 2]);
  assert.equal((await send(nodeA, ana, "POST", "/things", { name: "expiry" }, key)).headers["idempotency-replayed"], "true", "the new receipt");

  const keys = Array.from({ length: 5 }, newKey);
  for (const each of keys) await send(nodeA, ana, "POST", "/things", { name: "prune" }, each);
  for (const each of keys) await db.prepare("UPDATE offline_idempotency SET expires_at = ? WHERE organization_id = ? AND user_id = ? AND idempotency_key = ?").run(Date.now() - 1000, ana.orgId, ana.userId, each);
  assert.equal(await idempotency.pruneOfflineIdempotency(Date.now(), 2), 2);
  assert.equal(await idempotency.pruneOfflineIdempotency(Date.now(), 2), 2);
  assert.equal(await idempotency.pruneOfflineIdempotency(Date.now(), 2), 1);
  assert.equal(await idempotency.pruneOfflineIdempotency(Date.now(), 2), 0);
  assert.equal((await rowFor(ana, key))?.state, "done", "a receipt that has not expired stays");
});

test("a request that died without answering is taken over after two minutes, not before", async () => {
  const ana = await person("abandoned");
  const db = idempotency.offlineIdempotencyStore();
  // What a web node that was killed mid-request leaves behind: its claim, last marked a while ago.
  const leftRunning = async (key: string, claimedAgoMs: number, name: string) => {
    const slow = gate();
    const request = send(nodeA, ana, "POST", "/slow", { name }, key, slow.header);
    await slow.entered;
    await db.prepare("UPDATE offline_idempotency SET claimed_at = ? WHERE organization_id = ? AND user_id = ? AND idempotency_key = ?").run(Date.now() - claimedAgoMs, ana.orgId, ana.userId, key);
    return { request, open: slow.open };
  };

  const recent = newKey();
  const stillRunning = await leftRunning(recent, idempotency.ABANDONED_AFTER_MS - 20_000, "recent");
  assert.equal((await send(nodeB, ana, "POST", "/slow", { name: "recent" }, recent)).statusCode, 409, "under two minutes: still in progress");
  stillRunning.open();
  await stillRunning.request;

  const dead = newKey();
  const zombie = await leftRunning(dead, idempotency.ABANDONED_AFTER_MS + 1000, "dead");
  const takeover = gate();
  const second = send(nodeB, ana, "POST", "/slow", { name: "dead" }, dead, takeover.header);
  await takeover.entered;
  assert.equal(count("dead"), 2, "the repeat took the abandoned claim and ran");
  takeover.open();
  assert.deepEqual((await second).json(), { ok: true, run: 2 });
  // The first request finishing late does not overwrite the answer of the one that took over.
  zombie.open();
  assert.deepEqual((await zombie.request).json(), { ok: true, run: 1 });
  const replay = await send(nodeA, ana, "POST", "/slow", { name: "dead" }, dead);
  assert.deepEqual([replay.headers["idempotency-replayed"], replay.json()], ["true", { ok: true, run: 2 }]);
});

test("keys that are not ours pass through untouched; a malformed one of ours is refused", async () => {
  const ana = await person("own-key");
  for (const key of ["receipt-2026-11-10-0001", "5f0c9e0e-5b7e-4a53-9a39-9a6a3a1a2b3c", "sandbox-same-order"]) {
    const before = count("own-key");
    const first = await send(nodeA, ana, "POST", "/own-key", { amount: 1 }, key);
    const second = await send(nodeA, ana, "POST", "/own-key", { amount: 2 }, key);
    assert.deepEqual([first.statusCode, first.json().key, first.headers["idempotency-replayed"]], [200, key, undefined]);
    assert.deepEqual([second.statusCode, second.json().key, second.json().run], [200, key, before + 2], "the route sees its key and runs every time");
    assert.equal(await rowFor(ana, key.toLowerCase()), undefined, "no receipt is kept for it");
  }
  for (const key of ["fmo1-", "fmo1-not-a-uuid", `fmo1-${randomUUID()}-extra`, `fmo1-${"a".repeat(400)}`]) {
    const response = await send(nodeA, ana, "POST", "/own-key", {}, key);
    assert.deepEqual([response.statusCode, response.json().error], [400, "idempotency_key_invalid"]);
  }
  // Reads are never claimed.
  const key = newKey();
  assert.equal((await send(nodeA, ana, "GET", "/things?name=reads", undefined, key)).json().run, 1);
  assert.equal((await send(nodeA, ana, "GET", "/things?name=reads", undefined, key)).json().run, 2);
  assert.equal(await rowFor(ana, key), undefined);
});

test("an answer over 1 MB is not kept: a repeat gets the status and { ok, replayed }; an empty answer stays empty", async () => {
  const ana = await person("sizes");
  const big = newKey();
  const first = await send(nodeA, ana, "POST", "/big", { name: "big" }, big);
  assert.ok(first.body.length > idempotency.MAX_STORED_BODY_BYTES);
  const repeat = await send(nodeB, ana, "POST", "/big", { name: "big" }, big);
  assert.deepEqual([repeat.statusCode, repeat.headers["idempotency-replayed"], repeat.json()], [200, "true", { ok: true, replayed: true }]);
  assert.equal(count("big"), 1);

  const gone = newKey();
  assert.equal((await send(nodeA, ana, "DELETE", "/things/deleted", undefined, gone)).statusCode, 204);
  const again = await send(nodeB, ana, "DELETE", "/things/deleted", undefined, gone);
  assert.deepEqual([again.statusCode, again.body, again.headers["idempotency-replayed"]], [204, "", "true"]);
  assert.equal(count("deleted"), 1);
});

test("an upload is told apart by its length, whatever boundary its sender chose", async () => {
  const ana = await person("upload");
  const form = (boundary: string, name: string, fileBytes: number) => ({
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n${name}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="roof.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
      Buffer.alloc(fileBytes, 7),
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` }
  });
  const upload = (node: any, key: string, boundary: string, fileBytes: number) => {
    const { payload, headers } = form(boundary, "photo", fileBytes);
    return node.inject({ method: "POST", url: "/upload", payload, headers: { ...headers, cookie: ana.cookie, "idempotency-key": key } });
  };
  const key = newKey();
  const first = await upload(nodeA, key, "----WebKitFormBoundaryAbCdEfGhIjKlMnOp", 50_000);
  assert.deepEqual(first.json(), { ok: true, bytes: 50_000, run: 1 });
  assert.equal((await rowFor(ana, key))?.body_kind, "multipart");

  // The native uploader sends the same file with its own, longer boundary.
  const fromHost = await upload(nodeB, key, "9f1c2b7e-3d4a-4c5b-8e6f-7a8b9c0d1e2f-okhttp-boundary", 50_000);
  assert.deepEqual([fromHost.headers["idempotency-replayed"], fromHost.json()], ["true", { ok: true, bytes: 50_000, run: 1 }]);
  // Another file under the same key.
  assert.equal((await upload(nodeA, key, "----WebKitFormBoundaryAbCdEfGhIjKlMnOp", 90_000)).statusCode, 422);
  assert.equal(count("photo"), 1);
});

test("an answer the device never received is still the answer a repeat gets", async () => {
  const ana = await person("lost");
  const key = newKey();
  await nodeA.listen({ port: 0, host: "127.0.0.1" });
  const port = (nodeA.server.address() as AddressInfo).port;
  const slow = gate();
  const body = JSON.stringify({ name: "lost" });
  const request = http.request({ host: "127.0.0.1", port, method: "POST", path: "/slow", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body), cookie: ana.cookie, "idempotency-key": key, ...slow.header } });
  request.on("error", () => undefined);
  request.end(body);
  await slow.entered;
  // The connection drops while the handler is still working.
  request.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  slow.open();

  let row: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 50 && row?.state !== "done"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    row = await rowFor(ana, key);
  }
  assert.equal(row?.state, "done", "the work was done, so its receipt is kept");
  const repeat = await send(nodeB, ana, "POST", "/slow", { name: "lost" }, key);
  assert.deepEqual([repeat.statusCode, repeat.headers["idempotency-replayed"], repeat.json()], [200, "true", { ok: true, run: 1 }]);
  assert.equal(count("lost"), 1);
});

test("a route the web node forwards keeps its receipt on the host that runs it", async () => {
  const ana = await person("proxied");
  const ben = await person("proxied-other");
  // The compatibility host: the real handler and the hook.
  if (!nodeB.server.listening) await nodeB.listen({ port: 0, host: "127.0.0.1" });
  const upstream = `http://127.0.0.1:${(nodeB.server.address() as AddressInfo).port}`;
  // The web node: the same hook in front of @fastify/http-proxy, as in src/app.ts.
  const { default: Fastify } = await import("fastify");
  const { default: httpProxy } = await import("@fastify/http-proxy");
  const web = Fastify();
  idempotency.installOfflineIdempotency(web);
  await web.register(httpProxy, { upstream, prefix: "/v1/internal", rewritePrefix: "/v1/internal", http2: false });
  await web.ready();
  try {
    const key = newKey();
    const first = await send(web, ana, "POST", "/v1/internal/things", { name: "proxied" }, key, { "content-type": "application/json" });
    assert.deepEqual([first.statusCode, first.json()], [200, { ok: true, run: 1 }], "the web node did not claim the key ahead of the host that runs the handler");
    const repeat = await send(web, ana, "POST", "/v1/internal/things", { name: "proxied" }, key, { "content-type": "application/json" });
    assert.deepEqual([repeat.statusCode, repeat.headers["idempotency-replayed"], repeat.json()], [200, "true", { ok: true, run: 1 }]);
    assert.equal(count("proxied"), 1);
    // The identity headers are still checked before anything is forwarded.
    const refused = await send(web, ben, "POST", "/v1/internal/things", { name: "proxied" }, newKey(), { "content-type": "application/json", "x-fm-offline-user": ana.userId });
    assert.deepEqual([refused.statusCode, refused.json().error], [409, "offline_identity_mismatch"]);
    assert.equal(count("proxied"), 1);
  } finally {
    await web.close();
  }
});
