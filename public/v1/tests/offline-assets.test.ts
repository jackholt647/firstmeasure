/**
 * The offline asset manifest and its kill switch (docs/architecture/offline.md#asset-manifest,
 * platform/offline/assets.ts, api.ts, switch.ts).
 */
import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";

const SECRET = "offline-assets-fixture-session-secret";
const PUBLIC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const NO_LINK = path.join(os.tmpdir(), `no-release-link-${randomUUID()}`);
let storageRoot = "";
let app: any = null;
let assets: typeof import("../platform/offline/assets.js");

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-offline-assets-"));
  Object.assign(process.env, {
    NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1",
    EMAIL_OUTBOUND_DISABLED: "1", OPENAI_API_KEY: "", V1_LOG_LEVEL: "error", PLATFORM_SESSION_SECRET: SECRET, RELEASE_ID: "fixture-checkout",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"),
    INTERNAL_STORAGE_ROOT: path.join(storageRoot, "internal"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_CURRENT_RELEASE_LINK: NO_LINK
  });
  delete process.env.OFFLINE_ENABLED;
  assets = await import("../platform/offline/assets.js");
  const { default: Fastify } = await import("fastify");
  const { registerOfflineApi } = await import("../platform/offline/api.js");
  app = Fastify();
  await app.register(registerOfflineApi, { prefix: "/v1/platform/offline" });
  await app.ready();
});

after(async () => {
  await app?.close();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
});

const manifest = (headers: Record<string, string> = {}) => app.inject({ method: "GET", url: "/v1/platform/offline/assets", headers });
const sha256 = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** Points the release link at a release folder, the way `fm-release activate` switches `current`. */
function activate(link: string, release: string) {
  try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* No link yet. */ } }
  fs.symlinkSync(release, link, "junction");
}

function writeRelease(dir: string, files: Record<string, string>) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, "public", name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

test("the manifest lists this checkout's browser files with their hashes, and nothing the rules exclude", async (t) => {
  const response = await manifest();
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body), ["enabled", "release", "generated_at", "files", "shells", "external"]);
  assert.equal(typeof body.enabled, "boolean");
  assert.equal(body.release, "fixture-checkout", "without a release link: the server's own release id");
  assert.ok(Number.isFinite(Date.parse(body.generated_at)));
  assert.deepEqual(body.shells, ["/portal/"]);

  const names = Object.keys(body.files);
  let bytes = 0;
  for (const name of names) {
    const [hash, size] = body.files[name];
    assert.match(hash, /^[0-9a-f]{64}$/, name);
    assert.ok(Number.isInteger(size) && size >= 0, name);
    assert.ok(name.startsWith("/") && !name.includes("\\") && !name.includes(".."), name);
    bytes += size;
  }
  assert.deepEqual(names, [...names].sort(), "listed in order");

  // What an offline portal needs.
  for (const needed of [
    "/libraries/platform-api/platform-api.js", "/libraries/apps/firstmate-apps-manifest.js", "/libraries/calls-runtime/livekit-client.umd.js",
    "/portal/scripts/core.js", "/portal/scripts/topbar.js", "/portal/scripts/project_viewer.js", "/portal/mobile/mobile.js", "/portal/mobile/mobile.css",
    "/portal/landing/shared/signup-widget.js", "/portal/manifest.webmanifest", "/fonts.css", "/fonts/Montserrat-Regular.ttf", "/images/icon.png", "/favicon.ico"
  ]) assert.ok(body.files[needed], `${needed} is in the set`);
  const sample = "/libraries/platform-api/platform-api.js";
  assert.deepEqual(body.files[sample], [sha256(path.join(PUBLIC_ROOT, sample)), fs.statSync(path.join(PUBLIC_ROOT, sample)).size]);

  // Every script and stylesheet the portal page loads from its own origin is in the set.
  const page = fs.readFileSync(path.join(PUBLIC_ROOT, "portal", "index.php"), "utf8");
  const local = [...page.matchAll(/(?:src|href)="((?:\.\.\/|\/)?(?:libraries|scripts|landing|fonts|images|signup-sandbox)[^"?]*\.(?:js|css|png|webmanifest))(?:\?[^"]*)?"/g)]
    .map((match) => path.posix.normalize(match[1]!.startsWith("/") ? match[1]! : `/portal/${match[1]}`));
  assert.ok(local.length > 150, `only ${local.length} local files were found in the page`);
  // The offline engine's own files are added by the session that builds them.
  const missing = [...new Set(local)].filter((name) => !body.files[name] && fs.existsSync(path.join(PUBLIC_ROOT, name)));
  assert.deepEqual(missing, [], "files the portal page loads that are not in the set");

  // What is left out.
  const none = (label: string, test: (name: string) => boolean) => assert.deepEqual(names.filter(test), [], label);
  none("PHP", (name) => name.endsWith(".php"));
  none("Markdown and notes", (name) => /\.(md|txt|map|html|eot)$/.test(name) || /\/LICENSE/.test(name));
  none("the measure editor", (name) => name.startsWith("/measure/"));
  none("marketing pages and samples", (name) => /^\/portal\/(landing\/(?!shared\/)|marketing\/|samples\/)/.test(name));
  none("call background effects", (name) => name.startsWith("/libraries/calls-runtime/effects/"));
  none("the server", (name) => name.startsWith("/v1/") || name.includes("node_modules"));
  none("sample data", (name) => name.endsWith("-sample.json"));

  // Language catalogs: the manifest and exactly the files it names now, though older hashed files are still on disk.
  const catalogDir = "/libraries/platform-language/catalogs/";
  const catalogManifest = JSON.parse(fs.readFileSync(path.join(PUBLIC_ROOT, catalogDir, "manifest.json"), "utf8"));
  const current = Object.values(catalogManifest.namespaces as Record<string, string>).map((file) => catalogDir + file).sort();
  assert.ok(current.length > 50);
  assert.deepEqual(names.filter((name) => name.startsWith(catalogDir) && name !== `${catalogDir}manifest.json`), current);
  assert.ok(body.files[`${catalogDir}manifest.json`]);
  assert.ok(fs.readdirSync(path.join(PUBLIC_ROOT, catalogDir)).length > current.length + 1, "this checkout has older catalogs to leave out");

  const set = await assets.offlineAssetSet();
  assert.equal(set.bytes, bytes);
  assert.ok(bytes < assets.ASSET_BUDGET_BYTES, `the set is ${(bytes / 1048576).toFixed(1)} MB, over its ${assets.ASSET_BUDGET_BYTES / 1048576} MB budget`);
  t.diagnostic(`offline set: ${names.length} files, ${(bytes / 1048576).toFixed(2)} MB (${bytes} bytes); manifest ${(response.body.length / 1024).toFixed(0)} KB`);
  for (const rule of set.excluded) t.diagnostic(`left out by ${rule.match}: ${rule.files} files, ${(rule.bytes / 1048576).toFixed(2)} MB`);
});

test("every outside file the portal page loads is either saved or left out on purpose", () => {
  const page = fs.readFileSync(path.join(PUBLIC_ROOT, "portal", "index.php"), "utf8");
  const outside = [...new Set([...page.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map((match) => match[1]!))];
  assert.ok(outside.length >= 4, outside.join(", "));
  const external = new Set<string>(assets.ASSET_RULES.external);
  const leftOut = new Set<string>(assets.ASSET_RULES.externalLeftOut.map((entry) => entry.host));
  for (const url of outside) {
    assert.ok(external.has(url) || leftOut.has(new URL(url).host), `${url} is in neither ASSET_RULES.external nor externalLeftOut`);
  }
  // Nothing for analytics, pixels or maps is ever saved.
  for (const url of external) assert.doesNotMatch(new URL(url).host, /google|tiktok|facebook|doubleclick/);
  assert.ok([...external].some((url) => url.endsWith("/css/all.min.css")) && [...external].some((url) => url.endsWith("fa-solid-900.woff2")), "the icon stylesheet and its font files");
});

test("the release is the one being served: a switched release link is picked up without a restart, and each release is hashed once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "firstmate-offline-releases-"));
  const link = path.join(dir, "current");
  const catalogs = "libraries/platform-language/catalogs";
  const shared = {
    "libraries/platform-api/platform-api.js": "window.PlatformAPI = 1;",
    "portal/scripts/core.js": "core();",
    "portal/index.php": "<?php echo 'shell';",
    "portal/landing/variants/a/index.js": "marketing();",
    "portal/landing/shared/signup-widget.js": "signup();",
    "libraries/calls-runtime/effects/wasm/vision.wasm": "wasm",
    "libraries/notes/README.md": "# notes",
    "measure/internal/editor.js": "editor();",
    [`${catalogs}/manifest.json`]: JSON.stringify({ namespaces: { platform: "platform.bbbb.json" } }),
    [`${catalogs}/platform.aaaa.json`]: "{\"old\":true}",
    [`${catalogs}/platform.bbbb.json`]: "{\"current\":true}"
  };
  const before = "one();", changed = "two(); // browser-only release";
  const entry = (text: string) => [createHash("sha256").update(text).digest("hex"), Buffer.byteLength(text)];
  writeRelease(path.join(dir, "releases", "20261110-a1"), { ...shared, "libraries/app.js": before });
  writeRelease(path.join(dir, "releases", "20261110-b2"), { ...shared, "libraries/app.js": changed, "libraries/added.css": "body{}" });
  process.env.FIRSTMEASURE_CURRENT_RELEASE_LINK = link;
  try {
    activate(link, path.join(dir, "releases", "20261110-a1"));
    const first = (await manifest()).json();
    assert.equal(first.release, "20261110-a1");
    assert.deepEqual(Object.keys(first.files), [
      "/libraries/app.js", "/libraries/platform-api/platform-api.js",
      `/${catalogs}/manifest.json`, `/${catalogs}/platform.bbbb.json`,
      "/portal/landing/shared/signup-widget.js", "/portal/scripts/core.js"
    ]);
    assert.deepEqual(first.files["/libraries/app.js"], entry(before));

    // A release directory never changes, so it is hashed once per process: the same set object, even if a file were touched.
    const set = await assets.offlineAssetSet();
    fs.writeFileSync(path.join(dir, "releases", "20261110-a1", "public", "libraries", "app.js"), "tampered();");
    assert.equal(await assets.offlineAssetSet(), set);
    assert.deepEqual((await manifest()).json(), first);

    // `fm-release activate --keep-server`: the link moves, this process stays.
    activate(link, path.join(dir, "releases", "20261110-b2"));
    const second = (await manifest()).json();
    assert.equal(second.release, "20261110-b2");
    assert.deepEqual(second.files["/libraries/app.js"], entry(changed));
    assert.ok(second.files["/libraries/added.css"]);
    assert.deepEqual(second.files["/portal/scripts/core.js"], first.files["/portal/scripts/core.js"], "an unchanged file keeps its hash, so the device copies it");
    assert.notEqual(await assets.offlineAssetSet(), set);
  } finally {
    process.env.FIRSTMEASURE_CURRENT_RELEASE_LINK = NO_LINK;
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* Already gone. */ } }
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => undefined);
  }
});

test("a conditional request costs nothing: ETag, no-cache and 304", async () => {
  const first = await manifest();
  const etag = String(first.headers.etag);
  assert.match(etag, /^W\/"[A-Za-z0-9_-]{20,}"$/);
  assert.equal(first.headers["cache-control"], "private, no-cache");

  for (const sent of [etag, etag.replace(/^W\//, ""), `"something-else", ${etag}`]) {
    const again = await manifest({ "if-none-match": sent });
    assert.deepEqual([again.statusCode, again.body, again.headers.etag, again.headers["cache-control"]], [304, "", etag, "private, no-cache"]);
  }
  const changed = await manifest({ "if-none-match": "W/\"an-older-release\"" });
  assert.equal(changed.statusCode, 200);
  assert.deepEqual(changed.json(), first.json(), "the same list, byte for byte, while nothing changed");

  // Switched off, the answer is a different one: a device holding the old tag must hear about it.
  process.env.OFFLINE_ENABLED = "0";
  try {
    const off = await manifest({ "if-none-match": etag });
    assert.equal(off.statusCode, 200);
    assert.equal(off.json().enabled, false);
    assert.notEqual(off.headers.etag, etag);
  } finally {
    delete process.env.OFFLINE_ENABLED;
  }
});

test("the kill switch: the host setting, the flag for an organization, and Off for everyone", async () => {
  const storage = await import("../platform/storage.js");
  const { enableExpandedPlatformFixture } = await import("./helpers/platform-fixture.js");
  const { saveFlagRollout, readFlagRollouts } = await import("../platform/flag-rollouts.js");
  const { OFFLINE_FLAG } = await import("../platform/offline/switch.js");
  assert.equal(OFFLINE_FLAG, "platform.offline");

  const signedIn = async (label: string) => {
    const orgId = String((await storage.createOrganization({ name: `${label} roofing` })).id);
    const email = `${label}-${randomUUID()}@example.test`, userId = `${label}_owner`;
    const identity = await storage.createIdentity({ email, name: label, memberships: [{ organization_id: orgId, user_id: userId }] });
    await storage.upsertDocument(orgId, "users", { id: userId, data: { identity_id: identity.id, email, name: label, status: "active", org_permissions: { level: "owner", items: {} } } });
    const session = await storage.createAuthSession({ identity_id: identity.id, organization_id: orgId, user_id: userId, role: "owner" });
    return { orgId, headers: { cookie: `fm_platform_session=${session.sessionId}.${createHmac("sha256", SECRET).update(session.sessionId).digest("base64url")}` } };
  };
  const enabled = async (headers: Record<string, string> = {}) => (await manifest(headers)).json().enabled;
  const offForEveryone = async (killed: boolean) => { await saveFlagRollout(OFFLINE_FLAG, () => ({ percent: 0, killed })); await readFlagRollouts(true); };

  const on = await signedIn("offline-on");
  const off = await signedIn("offline-off");
  // The organization's own switch, with or without expanded access.
  await enableExpandedPlatformFixture(on.orgId, { [OFFLINE_FLAG]: true });
  await enableExpandedPlatformFixture(off.orgId, { [OFFLINE_FLAG]: false });
  const reportsOnly = await signedIn("offline-reports-only");
  await (await import("../platform/capabilities.js")).saveCapabilityValues(reportsOnly.orgId, { [OFFLINE_FLAG]: true });
  assert.equal(await enabled(reportsOnly.headers), true, "offline does not need expanded access: an account that only orders reports gets it too");

  // The organization's flag decides for its people. Nobody in particular keeps what the device has.
  assert.deepEqual([await enabled(on.headers), await enabled(off.headers), await enabled()], [true, false, true]);
  // The answer differs by caller, so the tag does too and nothing shared may keep it.
  const [forOn, forOff] = [await manifest(on.headers), await manifest(off.headers)];
  assert.notEqual(forOn.headers.etag, forOff.headers.etag);
  assert.equal((await manifest({ ...off.headers, "if-none-match": String(forOn.headers.etag) })).statusCode, 200);
  // A header naming an organization is not a session.
  assert.equal(await enabled({ "x-fm-offline-org": off.orgId, "x-internal-user-organization": off.orgId }), true);

  // Off for everyone in the flag console: no release, read within the rollout cache's 15 seconds.
  await offForEveryone(true);
  try {
    assert.deepEqual([await enabled(on.headers), await enabled(off.headers), await enabled()], [false, false, false]);
  } finally {
    await offForEveryone(false);
  }
  assert.deepEqual([await enabled(on.headers), await enabled()], [true, true]);

  // OFFLINE_ENABLED=0 on the host beats the flag.
  process.env.OFFLINE_ENABLED = "0";
  try {
    assert.deepEqual([await enabled(on.headers), await enabled()], [false, false]);
  } finally {
    delete process.env.OFFLINE_ENABLED;
  }
  assert.equal(await enabled(on.headers), true);
});
