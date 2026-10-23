import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { gunzipSync, gzipSync, zstdDecompressSync } from "node:zlib";

import { closePlatformFixtureStores, nextTestPhone } from "./helpers/platform-fixture.js";

// Session replay archives (docs/architecture/session-replay.md, "Archives"): finished sessions are re-packed on the
// server against shared vocabularies, losslessly. Pages are built with the browser's own codec, so template references
// and patches are real; every test compares restored chunks with the original JSON byte for byte.
// On Postgres: node tests/run-embedded-postgres.mjs tests/session-replay-archive.test.ts

const browserCodec = createRequire(import.meta.url)("../../libraries/session-replay/session-replay-codec.js");
const databaseUrl = String(process.env.TEST_POSTGRES_URL ?? "").trim();
let app: any = null;
let storageRoot = "";
let store: typeof import("../session-replay/storage.js");
let archive: typeof import("../session-replay/archive.js");
let codec: typeof import("../session-replay/archive-codec.js");
type Caller = { email: string; cookie: string; csrf: string; orgId: string };

async function caller(label: string, internal?: Record<string, unknown>): Promise<Caller> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `${label}-${suffix}@example.test`;
  const register = await app.inject({ method: "POST", url: "/v1/platform/auth/register", payload: {
    phone: nextTestPhone(), email, password: "correct horse battery staple", name: label, company: `${label} Co`, organization_id: `org_${label.replace(/\W+/g, "_")}_${suffix}`
  } });
  assert.equal(register.statusCode, 201, register.body);
  const cookie = String(register.headers["set-cookie"]).match(/fm_platform_session=[^;,]+/)?.[0] || "";
  const session = await app.inject({ method: "GET", url: "/v1/platform/auth/session", headers: { cookie } });
  if (internal) {
    const { saveInternalUser } = await import("../internal/storage.js");
    await saveInternalUser({ email, name: label, status: "active", ...internal });
  }
  return { email, cookie, csrf: String(session.json().csrf_token || ""), orgId: register.json().organization.id };
}

async function call(who: Caller | null, method: string, url: string, payload?: unknown) {
  const headers: Record<string, string> = {};
  if (who) { headers.cookie = who.cookie; if (method !== "GET") headers["x-platform-csrf"] = who.csrf; }
  return app.inject({ method, url: `/v1/platform${url}`, payload, headers });
}

// ---------------------------------------------------------------------------
// Synthetic recordings, written with the browser codec (strings interned per page, templates registered in order).
// ---------------------------------------------------------------------------
function pageWriter() {
  const strings = new Map<string, number>();
  let pending: string[] = [];
  const templates = new browserCodec.Templates(true);
  let nextId = 1;
  const sid = (text: string) => {
    let id = strings.get(text);
    if (id === undefined) { id = strings.size; strings.set(text, id); pending.push(text); }
    return id;
  };
  const el = (tag: string, attrs: Array<[string, string]>, ...children: unknown[]) => {
    const node: unknown[] = [sid(tag), attrs.length ? attrs.flatMap(([name, value]) => [sid(name), sid(value)]) : 0];
    for (const child of children) node.push(typeof child === "string" ? sid(child) : child);
    return browserCodec.seal(node, true);
  };
  const doc = (url: string, root: unknown) => browserCodec.sealSpecial({ d: [root], u: sid(url), t: sid("html") });
  const shadow = (...children: unknown[]) => browserCodec.sealSpecial({ r: children });
  /** Wire form plus the base id it was written at (ids are base + pre-order position). */
  const write = (node: any) => { const base = nextId; nextId += browserCodec.nodeCount(node); return { base, wire: browserCodec.encodeTree(node, templates, null) }; };
  const chunk = (t: number, events: unknown[], m: number[] = []) => {
    const json = JSON.stringify({ v: 1, t, s: pending, e: events, m });
    pending = [];
    return json;
  };
  return { sid, el, doc, shadow, write, chunk, next: () => nextId };
}

const NAV = ["Home", "Projects", "Schedule", "People", "Reports", "Settings", "Inbox", "Files"];
/** One page load and some activity. Platform markup is shared by every organization; names belong to one. */
function syntheticPage(org: string, customers: string[], variant: number, url = "https://dev.1m8.ai/portal/") {
  const w = pageWriter();
  const t0 = 1_792_000_000_000 + variant * 600_000;
  // Strings of this visit interned first shift every later string id, as real pages do.
  const visit = w.sid("visit " + variant);
  for (let i = 0; i < variant % 3; i++) w.sid(`visit ${variant} note ${i}`);
  const row = (name: string, index: number) => w.el("div", [["class", "project-row"], ["data-index", String(index)]],
    w.el("span", [["class", "project-name"]], name), w.el("span", [["class", "project-status badge"]], index % 3 ? "Open" : "Sold"),
    w.el("button", [["class", "btn btn-ghost"], ["type", "button"]], "View"));
  const nav = w.el("nav", [["class", "portal-nav"]], ...NAV.map((label, i) => w.el("a", [["class", "nav-item"], ["href", "/portal/#" + label.toLowerCase()]],
    w.el("span", [["class", "icon icon-" + i]]), label)));
  const header = w.el("header", [["class", "portal-header"]], w.el("h1", [["class", "org-name"]], org + " Portal"), w.el("input", [["type", "search"], ["placeholder", "Search projects"]]));
  const list = w.el("main", [["class", "project-list"]], ...customers.map(row));
  const html = w.el("html", [["lang", "en"]], w.el("head", [], w.el("title", [], org)), w.el("body", [["class", "portal"]], header, nav, list));
  const snapshot = w.write(w.doc(url, html));
  const meta = w.sid(JSON.stringify({ url, title: org, viewport: [1440, 900] }));
  const chunks = [w.chunk(t0, [[0, 0, meta], [3, 1, snapshot.base, snapshot.wire], [12, 5, 1440, 900, 100, 1000, 0, 0], [40, 13, 52, 5000, 41000, 82000, 743, 400, 98, 35000, 11000, 0, 0, 0, 900, 12]])];
  // A re-render: the same rows again (references), one changed (a patch), a removal, attribute and text changes.
  const listId = snapshot.base + 4 + 1 + 1;
  const again = customers.map((name, index) => w.write(row(index === 1 ? name + " (" + variant + ")" : name, index)));
  const adds: unknown[] = [];
  for (const added of again) adds.push(listId, 0, added.base, added.wire);
  const extra = w.write(w.el("div", [["class", "toast"], ["role", "status"]], "Saved " + customers[0]));
  adds.push(snapshot.base + 2, 0, extra.base, extra.wire);
  const host = w.write(w.el("fm-widget", [["class", "widget"]]));
  adds.push(listId, 0, host.base, host.wire);
  chunks.push(w.chunk(t0 + 5000, [
    [10, 2, [snapshot.base + 30, snapshot.base + 31], adds, [listId, w.sid("aria-busy"), w.sid("true"), listId, w.sid("data-gone"), -1], [extra.base + 1, w.sid("Saved twice")]],
    [20, 15, host.base, w.next(), w.write(w.shadow(w.el("div", [["class", "shadow-card"]], w.el("b", [], "Inside"), w.el("i", [], "the shadow")))).wire],
    [5, 3, 2, listId, 410, 220, 0, 1, w.sid("View"), w.sid("main.project-list > div > button")],
    [3, 3, 0, listId, 410, 220, 0, 1],
    [30, 4, 0, 0, 640],
    [8, 7, listId, 1],
    [8, 8, listId],
    [8, 8, 0],
    [9, 6, snapshot.base + 9, 0, w.sid("mercer")],
    [9, 6, snapshot.base + 9, 2, 6, 0, w.sid(" island")],
    [9, 6, snapshot.base + 9, 1, 1],
    [4, 9, w.sid("char"), 0, snapshot.base + 9],
    [4, 9, w.sid("Enter"), 2, snapshot.base + 9],
    [50, 10, w.sid(url + "#projects")],
    [7, 16, visit, w.sid(JSON.stringify({ id: variant, name: customers[0] }))],
    [7, 12, w.sid("TypeError: x is undefined — üñî 🚀"), w.sid("https://dev.1m8.ai/app.js"), 10, 4],
    [2, 14, snapshot.base + 3, w.next(), w.write(w.doc("https://dev.1m8.ai/frame.html", w.el("html", [], w.el("body", [], w.el("p", [], "Framed " + org))))).wire],
    [100, 11, 1],
    [1, 17]
  ], [0, 400, 300, 16, 12, -4, 33, 40, 7, 120, -60, -2]));
  return chunks;
}

const ORGS = [
  { name: "Mercer Roofing", customers: ["Alice Mercer", "Bob Lin", "Carla Diaz", "Dev Patel"] },
  { name: "Cascade Siding", customers: ["Erin Holt", "Faisal Khan", "Gina Rossi", "Hugo Brandt"] },
  { name: "Summit Gutters", customers: ["Ivy Chen", "Jon Park", "Kim Ode", "Luis Mora"] }
];

async function storeSession(orgId: string, sessionId: string, pages: string[][], at: number) {
  for (const [pageIndex, chunks] of pages.entries()) {
    for (const [seq, json] of chunks.entries()) {
      const result = await store.storeReplayChunk({
        organization_id: orgId, user_id: "user_" + orgId, user_email: "person@example.test", user_name: "Person", session_id: sessionId,
        page_id: `page${pageIndex}x${sessionId.slice(-4)}`, seq, page_started_at: at + pageIndex * 60_000, t_start: at + pageIndex * 60_000 + seq * 5000,
        t_end: at + pageIndex * 60_000 + seq * 5000 + 4000, events: 3, bytes_raw: json.length, data: gzipSync(Buffer.from(json)),
        meta: seq === 0 ? { url: "https://dev.1m8.ai/portal/" + (pageIndex ? "project" : ""), title: "Portal" } : null
      });
      assert.equal(result.status, "stored");
    }
  }
}

async function originalChunks(sessionId: string) {
  const out = new Map<string, string>();
  for (const page of (await store.readReplaySource(sessionId)).pages) for (const chunk of page.chunks) out.set(`${page.page_id}/${chunk.seq}`, chunk.json);
  return out;
}

async function readBack(sessionId: string) {
  const out = new Map<string, string>();
  const detail = await store.readReplaySession(sessionId);
  for (const page of detail!.pages) for (const chunk of await store.readReplayChunks(sessionId, page.page_id, -1, 500)) out.set(`${page.page_id}/${chunk.seq}`, gunzipSync(chunk.data).toString("utf8"));
  return out;
}

const tokensOf = async (scope: string, generation: number, version: number) => {
  const out: string[] = [];
  for (const blob of await store.readVocabTokenBlobs(scope, generation, version)) out.push(...JSON.parse(zstdDecompressSync(blob.tokens).toString("utf8")));
  return out;
};

let sessionCounter = 0;
const newSessionId = () => `arch${(++sessionCounter).toString().padStart(4, "0")}${Math.random().toString(36).slice(2, 10)}`;

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-session-replay-archive-"));
  Object.assign(process.env, {
    NODE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"), INTERNAL_STORAGE_ROOT: path.join(storageRoot, "internal"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"), FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"), PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"),
    EMAIL_OUTBOUND_DISABLED: "1", V1_LOG_LEVEL: "error"
  });
  if (databaseUrl) {
    const pg = (await import("pg")).default;
    const reset = new pg.Client({ connectionString: databaseUrl });
    await reset.connect();
    await reset.query("DROP SCHEMA IF EXISTS public CASCADE");
    await reset.query("CREATE SCHEMA public");
    await reset.end();
    Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: databaseUrl, POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false", FIRSTMEASURE_ARTIFACT_STORAGE: "local" });
  }
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
  store = await import("../session-replay/storage.js");
  archive = await import("../session-replay/archive.js");
  codec = await import("../session-replay/archive-codec.js");
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  await store?.closeSessionReplayDatabase();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  if (databaseUrl) await (await import("../src/database/postgres.js")).closePostgresPools().catch(() => undefined);
  try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error: any) { if (!["EBUSY", "EPERM"].includes(error?.code)) throw error; }
});

test("the archive codec writes every event type canonically and restores each chunk exactly", () => {
  const chunks = syntheticPage("Mercer Roofing", ORGS[0]!.customers, 1).map((json, seq) => ({ seq, json }));
  const strings = codec.pageStrings(chunks);
  assert.ok(strings.length > 60);
  const events = chunks.flatMap((chunk) => JSON.parse(chunk.json).e.map((event: unknown[]) => event[1]));
  assert.deepEqual([...new Set(events)].sort((a, b) => a - b), Array.from({ length: 18 }, (_, i) => i), "every event type is exercised");
  for (const vocabulary of [
    codec.EMPTY_VOCABULARY,
    codec.combineVocabularies(strings.filter((_, i) => i % 2 === 0), strings.filter((_, i) => i % 3 === 0)),
    codec.combineVocabularies([], strings)
  ]) {
    const result = codec.archivePage("page0001", chunks, vocabulary);
    assert.equal(result.canonical, true, result.reason);
    const restored = codec.restorePage(JSON.parse(JSON.stringify(result.page)), vocabulary);
    assert.deepEqual(restored, chunks);
  }
  // With every string known, the table carries ids only and the same markup in another session gives the same canonical events.
  const other = syntheticPage("Mercer Roofing", ["Zed Extra", ...ORGS[0]!.customers], 2).map((json, seq) => ({ seq, json }));
  const known = codec.combineVocabularies([], [...strings, ...codec.pageStrings(other)]);
  const one = codec.archivePage("a", chunks, known).page, two = codec.archivePage("b", other, known).page;
  assert.ok(one.c![0]![3].every((entry) => typeof entry === "number"));
  // The wire nav differs (string ids shifted by the visit string and the extra row); canonically it is the same bytes.
  const navOf = (snapshot: any) => JSON.stringify(snapshot[3].d[0][3][3]);
  assert.notEqual(navOf(JSON.parse(chunks[0]!.json).e[1]), navOf(JSON.parse(other[0]!.json).e[1]));
  const canonicalNav = (page: any) => JSON.stringify(page.c[0][4][1][3].d[0][3][3]);
  assert.equal(canonicalNav(one), canonicalNav(two), "the same markup is the same canonical bytes in both sessions");
  // Dictionary pieces carry no literal text.
  const piece = codec.dictionaryPiece(codec.archivePage("p", chunks, codec.combineVocabularies(["html"], [])).page)!;
  assert.ok(!piece.includes("Alice Mercer") && !piece.includes("Mercer Roofing"));
});

test("pages the codec does not understand are kept verbatim and still restore exactly", () => {
  const good = syntheticPage("Cascade Siding", ORGS[1]!.customers, 3);
  const cases = [
    good.map((json, seq) => seq === 1 ? json.replace('"e":[', '"e":[[1,99,"future"],') : json),
    good.map((json, seq) => seq === 0 ? json.replace('{"v":1,', '{"v":1,"x":1,') : json),
    good.map((json) => json.replace('{"v":1,', '{"v":2,')),
    good.map((json, seq) => seq === 1 ? json.replace('"m":[', '"m":[0.5,') : json),
    ["not json at all"]
  ];
  for (const variant of cases) {
    const chunks = variant.map((json, seq) => ({ seq, json }));
    const result = codec.archivePage("pagex", chunks, codec.EMPTY_VOCABULARY);
    if (variant[0] === "not json at all" || variant !== cases[3]) assert.equal(result.canonical, false);
    assert.deepEqual(codec.restorePage(JSON.parse(JSON.stringify(result.page)), codec.EMPTY_VOCABULARY), chunks);
  }
  // A string the vocabulary does not have cannot be restored: the archive pins its vocabulary for this reason.
  const chunks = good.map((json, seq) => ({ seq, json }));
  const vocabulary = codec.combineVocabularies(codec.pageStrings(chunks), []);
  const page = codec.archivePage("pagey", chunks, vocabulary).page;
  assert.throws(() => codec.restorePage(page, codec.combineVocabularies(codec.pageStrings(chunks).slice(0, 5), [])));
});

test("a dry run reports ratios and writes nothing; a run archives, verifies and serves the same chunks", async () => {
  const admin = await caller("archive-admin", { role: "admin" });
  const owner = await caller("archive-owner");
  assert.equal((await call(owner, "POST", "/session-replay/admin/archive", { dry_run: true })).statusCode, 403);
  const orgId = owner.orgId;
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const id = newSessionId();
    ids.push(id);
    await storeSession(orgId, id, [syntheticPage(ORGS[0]!.name, ORGS[0]!.customers, i), syntheticPage(ORGS[0]!.name, ORGS[0]!.customers.slice(1), i + 10)], 1_792_000_000_000 + i * 3_600_000);
  }
  const originals = new Map<string, Map<string, string>>();
  for (const id of ids) originals.set(id, await originalChunks(id));

  // Nothing is old enough under the default setting.
  assert.equal((await archive.runReplayArchive({ dryRun: true, organizationId: orgId })).sessions.length, 0);
  const dry = (await call(admin, "POST", "/session-replay/admin/archive", { dry_run: true, older_than_hours: 0, organization_id: orgId })).json().report;
  assert.equal(dry.dry_run, true);
  assert.equal(dry.sessions.length, 4);
  assert.ok(dry.sessions.every((row: any) => row.status === "dry_run" && row.pages_verbatim === 0), JSON.stringify(dry.sessions));
  assert.ok(dry.totals.ratio_archives > 1 && dry.totals.ratio_with_vocabulary > 1, JSON.stringify(dry.totals));
  assert.ok(dry.sessions[3].ratio > dry.sessions[0].ratio, "later sessions compress better as the vocabulary grows");
  assert.equal((await store.listVocabVersions(orgId)).length, 0, "a dry run writes no vocabulary");
  assert.equal((await store.readStringCounts(orgId, ["x"])).size, 0);
  for (const id of ids) assert.equal((await store.readReplaySession(id))!.session.archived_at, 0);
  assert.ok((await call(admin, "GET", "/session-replay/admin/archive")).json().last_dry_run);

  const real = (await call(admin, "POST", "/session-replay/admin/archive", { dry_run: false, older_than_hours: 0, organization_id: orgId })).json().report;
  assert.deepEqual(real.sessions.map((row: any) => row.status), ["archived", "archived", "archived", "archived"], JSON.stringify(real.sessions));
  assert.deepEqual(real.sessions.map((row: any) => row.bytes_archive), dry.sessions.map((row: any) => row.bytes_archive), "the dry run predicted the real run");
  archive.clearArchiveCaches();
  for (const id of ids) {
    const detail = await store.readReplaySession(id);
    assert.ok(detail!.session.archived_at > 0 && detail!.session.archive_bytes > 0);
    assert.deepEqual(await readBack(id), originals.get(id), "every chunk restores to its original JSON");
    // Through the admin route the viewer uses.
    for (const page of detail!.pages) {
      const served = (await call(admin, "GET", `/session-replay/admin/sessions/${id}/chunks?page_id=${page.page_id}`)).json().chunks;
      for (const chunk of served) assert.equal(gunzipSync(Buffer.from(chunk.data, "base64")).toString("utf8"), originals.get(id)!.get(`${page.page_id}/${chunk.seq}`));
    }
  }
  // Token-level reading: the archive's canonical pages name strings by stable vocabulary ids.
  const canonical = await archive.readArchiveCanonical(ids[3]!);
  assert.ok(canonical && canonical.pages.every((page) => page.c));
  const tableIds = codec.pageTableIds(canonical!.pages[0]!)!;
  const firstChunk = JSON.parse(originals.get(ids[3]!)!.get(`${canonical!.pages[0]!.i}/0`)!);
  firstChunk.s.forEach((text: string, at: number) => {
    const id = tableIds[at]!;
    if (id >= 0) assert.equal(canonical!.vocabulary.textOf(id), text);
  });
  const known = tableIds.filter((id) => id >= 0).length;
  assert.ok(known > tableIds.length / 2, `${known} of ${tableIds.length} strings are vocabulary ids`);
  const current = await archive.organizationVocabulary(orgId);
  const id = current.idOf("project-row");
  assert.ok(id !== undefined && current.textOf(id) === "project-row");
  const orgVocabulary = await archive.readVocabulary(orgId);
  assert.equal(orgVocabulary!.generation, current.organization.generation);
  assert.equal(orgVocabulary!.version, current.organization.version);
  assert.equal(orgVocabulary!.tokens[orgVocabulary!.indexOf("Alice Mercer")!], "Alice Mercer");
  assert.equal(await archive.readArchiveCanonical("notarchived0000"), null);
  // Chunk rows stay as an index with empty bodies; sizes for the growth chart are unchanged.
  assert.ok((await store.readReplayChunkSizes(ids[0]!)).every((row) => row.bytes_stored > 0));
  // An archived session takes no more chunks (the recorder starts a new session on 409).
  await call(admin, "PUT", `/session-replay/admin/organizations/${orgId}`, { enabled: true });
  const late = await call(owner, "POST", "/session-replay/chunks", { session_id: ids[0], page_id: "page9999", seq: 0, page_started_at: 1, t_start: 1, t_end: 2, events: 0, raw_bytes: 2, encoding: "json", json: "{}" });
  assert.equal(late.statusCode, 409);
  assert.equal((await store.storeReplayChunk({ organization_id: orgId, user_id: "user_" + orgId, user_email: "", user_name: "", session_id: ids[0]!, page_id: "page9999", seq: 0,
    page_started_at: 1, t_start: 1, t_end: 2, events: 0, bytes_raw: 2, data: gzipSync(Buffer.from("{}")), meta: null })).status, "archived");
  // Stats and the Storage panel's numbers.
  const stats = (await call(admin, "GET", "/session-replay/admin/stats")).json();
  const row = stats.organizations.find((o: any) => o.organization_id === orgId);
  assert.equal(row.archived_sessions, 4);
  assert.ok(row.archived_bytes > 0 && row.archived_bytes < row.archived_bytes_live && row.vocabulary_bytes > 0);
  assert.ok(stats.archive.archived.ratio_with_vocabulary > 1);
  // Nothing left to archive.
  assert.equal((await archive.runReplayArchive({ olderThanMs: 0, organizationId: orgId })).sessions.length, 0);
  // Deleting an archived session deletes its archive.
  assert.equal((await call(admin, "DELETE", `/session-replay/admin/sessions/${ids[0]}`)).json().deleted, true);
  assert.equal(await store.readReplayArchive(ids[0]!), null);
});

test("vocabularies are append-only and versioned; every archive keeps decoding with the version it pinned", async () => {
  const orgId = "org_archive_versions";
  const settings = { versionBatchTokens: 1, youngSessions: 0, versionEveryMs: 0, maxVersions: 3, dictionaryMinBytes: 1, dictionaryEvery: 1, platformMinOrgs: 9 };
  const ids: string[] = [];
  const originals = new Map<string, Map<string, string>>();
  for (let run = 0; run < 4; run++) {
    for (let i = 0; i < 2; i++) {
      const id = newSessionId();
      ids.push(id);
      const customers = [...ORGS[1]!.customers.slice(0, 2), `Run ${run} Customer ${i}`, `Shared ${run}`];
      await storeSession(orgId, id, [syntheticPage(ORGS[1]!.name, customers, run * 10 + i)], 1_792_100_000_000 + (run * 2 + i) * 3_600_000);
      originals.set(id, await originalChunks(id));
    }
    const report = await archive.runReplayArchive({ olderThanMs: 0, organizationId: orgId, settings });
    assert.ok(report.sessions.every((row) => row.status === "archived"), JSON.stringify(report.sessions));
  }
  const versions = await store.listVocabVersions(orgId);
  assert.ok(versions.length >= 4, "each run adds versions");
  assert.ok(new Set(versions.map((v) => v.generation)).size >= 2, "a full generation gives way to a fresh one");
  // Within a generation each version's token list extends the previous one.
  for (const generation of new Set(versions.map((v) => v.generation))) {
    const list = versions.filter((v) => v.generation === generation);
    let previous: string[] = [];
    for (const version of list) {
      const tokens = await tokensOf(orgId, generation, version.version);
      assert.equal(tokens.length, version.token_count);
      assert.deepEqual(tokens.slice(0, previous.length), previous, `version ${generation}.${version.version} keeps every earlier token in place`);
      previous = tokens;
    }
  }
  // An older version's tokens are a prefix of the newest version's in the same generation: ids are stable.
  const newest = versions.filter((v) => v.generation === versions[0]!.generation).at(-1)!;
  const oldest = await archive.readVocabulary(orgId, { generation: versions[0]!.generation, version: versions[0]!.version });
  const later = await archive.readVocabulary(orgId, { generation: newest.generation, version: newest.version });
  assert.deepEqual(later!.tokens.slice(0, oldest!.tokens.length), oldest!.tokens);
  // Archives pin different versions and all still decode exactly, oldest first, from cold caches.
  const pins = new Set<string>();
  archive.clearArchiveCaches();
  for (const id of ids) {
    const row = await store.readReplayArchive(id);
    pins.add(`${row!.org_generation}.${row!.org_version}`);
    assert.deepEqual(await readBack(id), originals.get(id));
  }
  assert.ok(pins.size >= 3, [...pins].join(" "));
  // Org strings seen in two sessions entered the vocabulary; a string seen once did not.
  const latest = await store.latestVocabVersion(orgId);
  const tokens = await tokensOf(orgId, latest!.generation, latest!.version);
  assert.ok(!tokens.includes("Run 3 Customer 1"));
});

test("a chunk that arrives while a session is archived keeps the session live", async () => {
  const orgId = "org_archive_late";
  const id = newSessionId();
  await storeSession(orgId, id, [syntheticPage(ORGS[2]!.name, ORGS[2]!.customers, 1)], 1_792_200_000_000);
  const before = await originalChunks(id);
  const report = await archive.runReplayArchive({
    olderThanMs: 0, organizationId: orgId,
    beforeCommit: async () => { await storeSession(orgId, id, [[], syntheticPage(ORGS[2]!.name, ORGS[2]!.customers, 2)], 1_792_200_100_000); }
  });
  assert.equal(report.sessions[0]!.status, "changed");
  assert.equal(await store.readReplayArchive(id), null);
  assert.equal((await store.readReplaySession(id))!.session.archived_at, 0);
  const after = await originalChunks(id);
  for (const [key, json] of before) assert.equal(after.get(key), json);
  assert.ok(after.size > before.size);
});

test("deleting an organization removes its replays and vocabulary and leaves shared vocabulary as it was", async () => {
  const orgIds = ["org_archive_a", "org_archive_b", "org_archive_c"];
  const settings = { platformMinOrgs: 3, versionBatchTokens: 1, youngSessions: 100 };
  const ids = new Map<string, string[]>();
  const originals = new Map<string, Map<string, string>>();
  for (const [index, orgId] of orgIds.entries()) {
    const org = ORGS[index]!;
    for (let i = 0; i < 2; i++) {
      const id = newSessionId();
      ids.set(orgId, [...(ids.get(orgId) || []), id]);
      await storeSession(orgId, id, [syntheticPage(org.name, org.customers, i)], 1_792_300_000_000 + (index * 2 + i) * 3_600_000);
      originals.set(id, await originalChunks(id));
    }
  }
  const report = await archive.runReplayArchive({ olderThanMs: 0, sessionIds: [...ids.values()].flat(), settings });
  assert.ok(report.sessions.every((row) => row.status === "archived"), JSON.stringify(report.sessions));
  const platformVersion = await store.latestVocabVersion(store.PLATFORM_SCOPE);
  assert.ok(platformVersion);
  const platformTokens = await tokensOf(store.PLATFORM_SCOPE, platformVersion!.generation, platformVersion!.version);
  // Shared markup is platform vocabulary; one organization's names never are, but are in its own vocabulary.
  assert.ok(platformTokens.includes("project-row") && platformTokens.includes("Projects"));
  for (const org of ORGS) for (const text of [...org.customers, org.name, org.name + " Portal"]) assert.ok(!platformTokens.includes(text), text);
  const orgA = await store.latestVocabVersion("org_archive_a");
  assert.ok((await tokensOf("org_archive_a", orgA!.generation, orgA!.version)).includes("Alice Mercer"));

  const platformRows = async () => JSON.stringify((await store.listVocabVersions(store.PLATFORM_SCOPE)).map((v) => [v.generation, v.version, v.token_count, v.tokens_added]))
    + (await store.readVocabTokenBlobs(store.PLATFORM_SCOPE, platformVersion!.generation, platformVersion!.version)).map((b) => codec.sha256(b.tokens)).join(",");
  const platformBefore = await platformRows();
  const { deleteOrganization } = await import("../platform/storage.js");
  await deleteOrganization("org_archive_a");
  archive.clearArchiveCaches();
  for (const id of ids.get("org_archive_a")!) {
    assert.equal(await store.readReplaySession(id), null);
    assert.equal(await store.readReplayArchive(id), null);
  }
  assert.equal((await store.listVocabVersions("org_archive_a")).length, 0);
  const { createHash } = await import("node:crypto");
  const hash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24);
  assert.equal((await store.readStringCounts("org_archive_a", [hash("Alice Mercer"), hash("Projects")])).size, 0);
  assert.equal((await store.readStringCounts("org_archive_b", [hash("Projects")])).size, 1);
  assert.equal((await store.listArchiveCandidates({ before: Date.now() + 1, limit: 10, organizationId: "org_archive_a" })).length, 0);
  assert.equal(await platformRows(), platformBefore, "the platform vocabulary is untouched");
  for (const orgId of orgIds.slice(1)) for (const id of ids.get(orgId)!) assert.deepEqual(await readBack(id), originals.get(id));
});
