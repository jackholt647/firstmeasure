import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { closePlatformFixtureStores, enableExpandedPlatformFixture, nextTestPhone } from "./helpers/platform-fixture.js";

// The feature flag console (docs/architecture/feature-flags.md): read-time percentages over stored values, explicit
// per-organization values, the pasted list, the audit log, access keys, and that all of it reaches the gates code uses.

let app: any = null;
let storageRoot = "";
const FLAG = "firstmeasure.exteriors";
type Caller = { email: string; cookie: string; csrf: string; orgId: string };

async function caller(label: string, internal?: Record<string, unknown>): Promise<Caller> {
  const suffix = Math.random().toString(36).slice(2, 10);
  const email = `${label}-${suffix}@example.test`;
  const orgId = `org_${label.replace(/\W+/g, "_")}_${suffix}`;
  const register = await app.inject({ method: "POST", url: "/v1/platform/auth/register", payload: {
    phone: nextTestPhone(), email, password: "correct horse battery staple", name: label, company: `${label} ${suffix} Co`, organization_id: orgId
  } });
  assert.equal(register.statusCode, 201, register.body);
  const cookie = String(register.headers["set-cookie"]).match(/fm_platform_session=[^;,]+/)?.[0] || "";
  const session = await app.inject({ method: "GET", url: "/v1/platform/auth/session", headers: { cookie } });
  if (internal) await (await import("../internal/storage.js")).saveInternalUser({ email, name: label, status: "active", ...internal });
  if (internal) {
    const storage = await import("../platform/storage.js");
    const identity = await storage.findIdentityByEmail(email);
    const staffOrg = "legacy_internal";
    await storage.readOrganization(staffOrg).catch(() => storage.createOrganization({ id: staffOrg, name: "Internal staff" }));
    const user = await storage.upsertDocument(staffOrg, "users", { id: `staff_${suffix}`, data: { email, name: label }, email, name: label, role: "owner", status: "active" });
    await storage.addIdentityMembership(String(identity!.id), staffOrg, String(user.id), "owner");
  }
  return { email, cookie, csrf: String(session.json().csrf_token || ""), orgId };
}

const flags = (who: Caller, method: string, url: string, payload?: unknown) =>
  app.inject({ method, url: `/v1/internal/flags${url}`, payload, headers: { cookie: who.cookie, origin: "https://app.example.test", ...(method === "GET" ? {} : { "x-platform-csrf": who.csrf }) } });
const withKey = (key: string, method: string, url: string, payload?: unknown) =>
  app.inject({ method, url: `/v1/internal/flags${url}`, payload, headers: { authorization: `Bearer ${key}` } });
const ok = (response: any) => { assert.equal(response.statusCode, 200, response.body); return response.json(); };
async function refreshRollouts() { (await import("../platform/flag-rollouts.js")).readFlagRollouts(true); await (await import("../platform/flag-rollouts.js")).readFlagRollouts(true); }
const enabled = async (orgId: string) => (await import("../platform/capabilities.js")).isCapabilityEnabled(orgId, FLAG);

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-feature-flags-"));
  Object.assign(process.env, {
    NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"), INTERNAL_STORAGE_ROOT: path.join(storageRoot, "internal"),
    CRM_STORAGE_ROOT: path.join(storageRoot, "crm"), FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"),
    FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"), PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"),
    PUBLIC_BASE_URL: "https://app.example.test", CORS_ALLOWED_ORIGINS: "https://app.example.test",
    EMAIL_OUTBOUND_DISABLED: "1", V1_LOG_LEVEL: "error"
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await (await import("../platform/flag-console.js")).closeFlagConsoleStore();
  await closePlatformFixtureStores();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error: any) { if (!["EBUSY", "EPERM"].includes(error?.code)) throw error; }
});

test("a percentage is stable and only grows: raising it keeps everyone it covered", async () => {
  const { percentCovers, flagBucket } = await import("../platform/flag-rollouts.js");
  const ids = Array.from({ length: 5000 }, (_, index) => `org_${index}`);
  const at = (percent: number) => new Set(ids.filter((id) => percentCovers(percent, FLAG, id)));
  const ten = at(10), twenty = at(20);
  for (const id of ten) assert.ok(twenty.has(id), "raising 10% to 20% lost an organization");
  assert.ok(Math.abs(ten.size - 500) < 90, `10% covered ${ten.size} of 5000`);
  assert.ok(Math.abs(twenty.size - 1000) < 120, `20% covered ${twenty.size} of 5000`);
  assert.equal(at(100).size, 5000);
  assert.equal(at(0).size, 0);
  // Independent per flag, so one rollout's first 10% is not every rollout's first 10%.
  assert.notDeepEqual(ids.slice(0, 50).map((id) => flagBucket(FLAG, id)), ids.slice(0, 50).map((id) => flagBucket("firstmeasure.other", id)));
});

test("who may read, change and manage keys", async () => {
  const anonymous = await app.inject({ method: "GET", url: "/v1/internal/flags/catalog" });
  assert.equal(anonymous.statusCode, 401);
  const customer = await caller("flag-customer");
  assert.equal((await flags(customer, "GET", "/catalog")).statusCode, 403);
  const technician = await caller("flag-tech", { role: "technician" });
  assert.equal((await flags(technician, "GET", "/catalog")).statusCode, 403);
  const salesManager = await caller("flag-sales", { role: "sales_manager", permissions: { manage_sales_users: true } });
  assert.equal(ok(await flags(salesManager, "GET", "/me")).can_write, false);
  assert.equal((await flags(salesManager, "GET", "/catalog")).statusCode, 200);
  assert.equal((await flags(salesManager, "PUT", `/catalog/${FLAG}/rollout`, { percent: 5 })).statusCode, 403);
  assert.equal((await flags(salesManager, "PUT", `/orgs/${customer.orgId}/flags/${FLAG}`, { value: true })).statusCode, 403);
  assert.equal((await flags(salesManager, "POST", "/keys", { name: "nope" })).statusCode, 403);
  const admin = await caller("flag-admin", { role: "admin" });
  assert.equal(ok(await flags(admin, "GET", "/me")).can_write, true);
  // Spoofed identity fields grant nothing.
  const spoof = await app.inject({ method: "PUT", url: `/v1/internal/flags/catalog/${FLAG}/rollout`, payload: { percent: 50 }, headers: { "x-internal-user-email": admin.email, "x-internal-user-role": "admin" } });
  assert.equal(spoof.statusCode, 401);
});

test("a customer cannot write an explicit value into their own organization", async () => {
  const customer = await caller("flag-self");
  const response = await app.inject({ method: "PATCH", url: `/v1/platform/organizations/${customer.orgId}/global`, payload: { data: { app_flag_overrides: { [FLAG]: true } } }, headers: { cookie: customer.cookie, "x-platform-csrf": customer.csrf, origin: "https://app.example.test" } });
  assert.notEqual(response.statusCode, 200, response.body);
  assert.equal(await enabled(customer.orgId), false);
});

test("the three layers reach the gate exterior ordering uses, and stored values carry over", async () => {
  const admin = await caller("layers-admin", { role: "admin" });
  const storage = await import("../platform/storage.js");
  const { requireExteriorAccess } = await import("../firstmeasure/exteriors.js");
  const { flagBucket } = await import("../platform/flag-rollouts.js");
  const { capabilityState } = await import("../platform/capabilities.js");
  const { valueCapabilities, saveCapabilityValues } = await import("../platform/capabilities.js");
  assert.ok(valueCapabilities().some((node) => node.key === FLAG));

  // Enough organizations that a percentage has some on each side. Signup stamps stored `false` into every one.
  const orgs: string[] = [];
  for (let index = 0; index < 8; index += 1) orgs.push((await caller(`layers-${index}`)).orgId);
  for (const id of orgs) {
    const stored = (await storage.readGlobal(id) as any).data.app_flags?.firstmeasure?.exteriors;
    assert.notEqual(stored, true);
    assert.equal(await enabled(id), false);
    await assert.rejects(requireExteriorAccess(id, "residential"), /not enabled/);
  }
  const buckets = orgs.map((id) => [id, flagBucket(FLAG, id)] as const).sort((a, b) => a[1] - b[1]);
  const low = buckets[0]!, high = buckets[buckets.length - 1]!;
  const percent = Math.min(99.99, (low[1] + high[1]) / 2 / 100);
  assert.ok(low[1] / 100 < percent && high[1] / 100 >= percent, "the sample needs both sides of the percentage");

  // A stored `true` from before this console stays on, and is never counted as explicit.
  const carried = (await caller("layers-carried")).orgId;
  await saveCapabilityValues(carried, { [FLAG]: true });
  assert.equal(await enabled(carried), true);

  const rollout = ok(await flags(admin, "PUT", `/catalog/${FLAG}/rollout`, { percent, note: "pilot" }));
  assert.equal(rollout.rollout.percent, Math.round(percent * 100) / 100);
  await refreshRollouts();
  assert.equal(await enabled(low[0]), true, "the percentage covers a stamped false");
  assert.equal(await enabled(high[0]), false, "above the percentage stays off");
  await requireExteriorAccess(low[0], "residential");
  await assert.rejects(requireExteriorAccess(low[0], "commercial"), /not enabled/);
  assert.equal((await capabilityState(low[0])).effective_by_key[FLAG], true, "the browser's capability state agrees");
  assert.equal(await enabled(carried), true);
  // Nothing was written per organization.
  assert.equal((await storage.readGlobal(low[0]) as any).data.app_flag_overrides, undefined);

  // Explicit beats the percentage both ways.
  ok(await flags(admin, "PUT", `/orgs/${low[0]}/flags/${FLAG}`, { value: false, note: "asked out" }));
  ok(await flags(admin, "PUT", `/orgs/${high[0]}/flags/${FLAG}`, { value: true }));
  assert.equal(await enabled(low[0]), false);
  assert.equal(await enabled(high[0]), true);
  const detail = ok(await flags(admin, "GET", `/orgs/${high[0]}`)).flags.find((flag: any) => flag.key === FLAG);
  assert.equal(detail.source, "explicit");
  assert.equal(detail.effective, true);

  // Raising the percentage does not override an explicit off.
  ok(await flags(admin, "PUT", `/catalog/${FLAG}/rollout`, { percent: 100 }));
  await refreshRollouts();
  assert.equal(await enabled(low[0]), false);
  assert.equal(await enabled(orgs.find((id) => id !== low[0] && id !== high[0])!), true);

  // Off for everyone beats everything; lifting it restores what was there.
  ok(await flags(admin, "PUT", `/catalog/${FLAG}/rollout`, { killed: true }));
  await refreshRollouts();
  assert.equal(await enabled(high[0]), false);
  assert.equal(await enabled(carried), false);
  ok(await flags(admin, "PUT", `/catalog/${FLAG}/rollout`, { killed: false, percent: 0 }));
  await refreshRollouts();
  assert.equal(await enabled(high[0]), true);
  assert.equal(await enabled(carried), true);
  assert.equal(await enabled(orgs.find((id) => id !== low[0] && id !== high[0])!), false);

  // Clearing an explicit value follows the default again.
  ok(await flags(admin, "PUT", `/orgs/${high[0]}/flags/${FLAG}`, { value: null }));
  assert.equal(await enabled(high[0]), false);
  const cleared = (await storage.readGlobal(high[0]) as any).data;
  assert.deepEqual(cleared.app_flag_overrides, {});

  // Another deliberate writer replaces an explicit value rather than being silently ignored.
  ok(await flags(admin, "PUT", `/orgs/${low[0]}/flags/${FLAG}`, { value: false }));
  await saveCapabilityValues(low[0], { [FLAG]: true });
  assert.equal(await enabled(low[0]), true);

  // Rollouts of the rollout ceiling itself are refused.
  assert.equal((await flags(admin, "PUT", `/catalog/platform.expanded_access/rollout`, { percent: 10 })).statusCode, 400);
  assert.equal((await flags(admin, "PUT", `/catalog/nope.nothing/rollout`, { percent: 10 })).statusCode, 404);
  await saveCapabilityValues(low[0], { [FLAG]: false });
  await saveCapabilityValues(carried, { [FLAG]: false });
});

const row = (catalog: any, key: string) => catalog.flags.find((flag: any) => flag.key === key);

test("counts agree with resolving each organization, and a percentage preview matches what it covers", async () => {
  const admin = await caller("counts-admin", { role: "admin" });
  const { effectiveCapabilities, valueCapabilities } = await import("../platform/capabilities.js");
  const { listOrganizations } = await import("../platform/storage.js");
  const { percentCovers } = await import("../platform/flag-rollouts.js");
  ok(await flags(admin, "PUT", `/catalog/firstmeasure.exteriors_commercial/rollout`, { percent: 50 }));
  ok(await flags(admin, "PUT", `/catalog/${FLAG}/rollout`, { percent: 40 }));
  await refreshRollouts();
  const catalog = ok(await flags(admin, "GET", "/catalog?fresh=1"));
  const orgs = await listOrganizations();
  assert.equal(catalog.total_orgs, orgs.length);
  const resolved = await Promise.all(orgs.map((org) => effectiveCapabilities(String(org.id))));
  for (const node of valueCapabilities().filter((candidate) => candidate.type === "boolean")) {
    const expected = resolved.filter((resolution) => resolution.effectiveByKey[node.key] === true).length;
    const row = catalog.flags.find((flag: any) => flag.key === node.key);
    // Entitlements and the expanded access ceiling come from elsewhere; only the FirstMeasure flags are comparable here.
    if (node.key.startsWith("firstmeasure.")) assert.equal(row.stats.on, expected, node.key);
  }
  // A write here keeps the counts current without another full read.
  const target = String(orgs.find((org) => String(org.id) !== "legacy_internal")!.id);
  const before = row(catalog, "firstmeasure.exteriors_multifamily").stats.explicit_on;
  ok(await flags(admin, "PUT", `/orgs/${target}/flags/firstmeasure.exteriors_multifamily`, { value: true }));
  assert.equal(row(ok(await flags(admin, "GET", "/catalog")), "firstmeasure.exteriors_multifamily").stats.explicit_on, before + 1);
  ok(await flags(admin, "PUT", `/orgs/${target}/flags/firstmeasure.exteriors_multifamily`, { value: null }));
  assert.equal(row(ok(await flags(admin, "GET", "/catalog")), "firstmeasure.exteriors_multifamily").stats.explicit_on, before);
  const preview = ok(await flags(admin, "GET", `/catalog/${FLAG}/coverage?percent=33.3`));
  assert.equal(preview.covered, orgs.filter((org) => percentCovers(33.3, FLAG, String(org.id))).length);
  ok(await flags(admin, "PUT", `/catalog/firstmeasure.exteriors_commercial/rollout`, { percent: 0 }));
  ok(await flags(admin, "PUT", `/catalog/${FLAG}/rollout`, { percent: 0 }));
  await refreshRollouts();
});

test("a pasted list resolves with a preview, and turning a flag on for it is one audited action", async () => {
  const admin = await caller("paste-admin", { role: "admin" });
  const byEmail = await caller("paste-owner");
  const byId = await caller("paste-byid");
  const storage = await import("../platform/storage.js");
  const named = await caller("paste-named");
  await storage.patchOrganization(named.orgId, { name: "Acme Roofing, LLC" });
  const twinA = await caller("paste-twin-a"), twinB = await caller("paste-twin-b");
  await storage.patchOrganization(twinA.orgId, { name: "Twin Roofing" });
  await storage.patchOrganization(twinB.orgId, { name: "Twin Roofing" });

  const resolved = ok(await flags(admin, "POST", "/resolve", { text: `${byEmail.email}\n${byId.orgId}, nobody-here@example.test\nAcme Roofing, LLC\nTwin Roofing\nno such company zzz` }));
  const entry = (input: string) => resolved.entries.find((row: any) => row.input.toLowerCase() === input.toLowerCase());
  assert.equal(entry(byEmail.email).status, "matched");
  assert.equal(entry(byEmail.email).matched_by, "email");
  assert.equal(entry(byEmail.email).organizations[0].id, byEmail.orgId);
  assert.equal(entry(byEmail.email).organizations[0].owner_email, byEmail.email.toLowerCase());
  // Several memberships in one organization are one organization, not a choice.
  const owner = await storage.findIdentityByEmail(byEmail.email);
  const userId = String((await storage.listIdentityMemberships(String(owner!.id)))[0]!.user.id);
  await storage.patchIdentity(String(owner!.id), { memberships: [...(owner!.memberships as unknown[]), { organization_id: byEmail.orgId, user_id: userId, role: "member", status: "active" }] });
  assert.equal(ok(await flags(admin, "POST", "/resolve", { text: byEmail.email })).entries[0].status, "matched");
  assert.equal(entry(byId.orgId).status, "matched");
  assert.equal(entry(byId.orgId).matched_by, "id");
  assert.equal(entry("nobody-here@example.test").status, "unmatched");
  assert.equal(entry("Acme Roofing, LLC").status, "matched", "a comma inside a name is not a separator");
  assert.equal(entry("Twin Roofing").status, "ambiguous");
  assert.equal(entry("Twin Roofing").organizations.length, 2);
  assert.equal(entry("no such company zzz").status, "unmatched");
  assert.equal(await enabled(byEmail.orgId), false, "resolving applies nothing");

  const ids = [byEmail.orgId, byId.orgId, named.orgId];
  const applied = ok(await flags(admin, "POST", "/bulk", { flag: FLAG, value: true, org_ids: [...ids, "org_does_not_exist"], note: "pilot group" }));
  assert.equal(applied.changed, 3);
  assert.equal(applied.failed.length, 1);
  for (const id of ids) assert.equal(await enabled(id), true);
  const again = ok(await flags(admin, "POST", "/bulk", { flag: FLAG, value: true, org_ids: ids }));
  assert.equal(again.changed, 0);
  assert.equal(again.unchanged, 3);

  const audit = ok(await flags(admin, "GET", `/audit?flag=${FLAG}&limit=5`)).entries;
  const entryRow = audit.find((row: any) => row.id === applied.audit_id);
  assert.equal(entryRow.actor, admin.email.toLowerCase());
  assert.equal(entryRow.action, "bulk_set");
  assert.equal(entryRow.org_count, 3);
  assert.equal(entryRow.note, "pilot group");
  const full = ok(await flags(admin, "GET", `/audit/${applied.audit_id}`)).entry;
  assert.equal(full.orgs.length, 3);
  const row = full.orgs.find((org: any) => org.org_id === named.orgId);
  assert.equal(row.org_name, "Acme Roofing, LLC");
  assert.equal(row.before.explicit, null);
  assert.equal(row.after.explicit, true);
  const orgHistory = ok(await flags(admin, "GET", `/audit?org=${named.orgId}`)).entries;
  assert.ok(orgHistory.some((item: any) => item.id === applied.audit_id));

  // Search by the three things a person knows.
  assert.ok(ok(await flags(admin, "GET", `/orgs?q=${encodeURIComponent(byEmail.email)}`)).organizations.some((org: any) => org.id === byEmail.orgId));
  assert.ok(ok(await flags(admin, "GET", `/orgs?q=${byId.orgId}`)).organizations.some((org: any) => org.id === byId.orgId));
  assert.ok(ok(await flags(admin, "GET", "/orgs?q=acme%20roof")).organizations.some((org: any) => org.id === named.orgId));
});

test("access keys read or change flags as created, are audited, and cannot manage keys", async () => {
  const admin = await caller("key-admin", { role: "admin" });
  const target = await caller("key-target");
  const readKey = ok(await flags(admin, "POST", "/keys", { name: "Team reader", scope: "read", days: 30 }));
  const writeKey = ok(await flags(admin, "POST", "/keys", { name: "Jack's Claude Code", scope: "write" }));
  assert.match(readKey.key, /^fmfk_[A-Za-z0-9_-]{40,}$/);
  const listed = ok(await flags(admin, "GET", "/keys")).keys;
  assert.ok(listed.every((key: any) => !("key" in key) && !("key_hash" in key)), "no key material is listed");

  assert.equal(ok(await withKey(readKey.key, "GET", "/catalog")).flags.length > 0, true);
  assert.equal((await withKey(readKey.key, "PUT", `/orgs/${target.orgId}/flags/${FLAG}`, { value: true })).statusCode, 403);
  ok(await withKey(writeKey.key, "PUT", `/orgs/${target.orgId}/flags/${FLAG}`, { value: true, note: "agent" }));
  assert.equal(await enabled(target.orgId), true);
  const audit = ok(await flags(admin, "GET", `/audit?org=${target.orgId}`)).entries[0];
  assert.equal(audit.actor_kind, "key");
  assert.match(audit.actor, /Jack's Claude Code/);
  assert.match(audit.actor, new RegExp(admin.email.toLowerCase()));

  assert.equal((await withKey(writeKey.key, "GET", "/keys")).statusCode, 401, "the key route's gate wants a staff session");
  assert.equal((await withKey(writeKey.key, "POST", "/keys", { name: "self" })).statusCode, 401);
  // A flag key opens this API only.
  assert.equal((await app.inject({ method: "GET", url: "/v1/internal/stats/overview", headers: { authorization: `Bearer ${writeKey.key}` } })).statusCode, 401);
  assert.equal((await withKey("fmfk_not_a_real_key_not_a_real_key_not_a_real_key", "GET", "/catalog")).statusCode, 401);

  ok(await flags(admin, "DELETE", `/keys/${writeKey.id}`));
  assert.equal((await withKey(writeKey.key, "GET", "/catalog")).statusCode, 401);
});

test("the CLI reads and changes flags with a key, and a read key cannot change them", async () => {
  const admin = await caller("cli-admin", { role: "admin" });
  const target = await caller("cli-target");
  const { createFlagKey } = await import("../platform/flag-console.js");
  const write = await createFlagKey({ name: "cli test", scope: "write", createdBy: admin.email });
  const read = await createFlagKey({ name: "cli reader", scope: "read", createdBy: admin.email });
  const origin = await app.listen({ port: 0, host: "127.0.0.1" });
  const { execFile } = await import("node:child_process");
  const cli = path.resolve(process.cwd(), "../../tools/feature-flags/cli.mjs");
  const run = (key: string, ...args: string[]) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(process.execPath, [cli, ...args], { env: { ...process.env, FM_FLAGS_ORIGIN: origin, FM_FLAGS_KEY: key } }, (error, stdout, stderr) => resolve({ code: error ? Number(error.code) || 1 : 0, out: stdout, err: stderr }));
  });
  const flagLine = await run(read.key, "list", "firstmeasure.exteriors_multifamily");
  assert.equal(flagLine.code, 0, flagLine.err);
  assert.match(flagLine.out, /firstmeasure\.exteriors_multifamily/);
  const refused = await run(read.key, "set", target.orgId, FLAG, "on");
  assert.equal(refused.code, 1);
  assert.match(refused.err, /403/);
  const set = await run(write.key, "set", target.orgId, FLAG, "on", "--note", "from the cli");
  assert.equal(set.code, 0, set.err);
  assert.equal(await enabled(target.orgId), true);
  const shown = await run(read.key, "org", target.email);
  assert.match(shown.out, /on\s+firstmeasure\.exteriors\s+\(explicit/);
  const history = await run(read.key, "audit", "--org", target.orgId);
  assert.match(history.out, /cli test.*from the cli/);
  assert.ok(![flagLine, set, shown, history].some((result) => result.out.includes(write.key) || result.out.includes(read.key)), "the CLI never prints a key");
});

test("an agent machine enrolls its own write key by SSH signature; only development serves the route", async () => {
  const { execFileSync } = await import("node:child_process");
  const { writeFileSync, readFileSync } = await import("node:fs");
  const dir = await mkdtemp(path.join(os.tmpdir(), "firstmate-flag-enroll-"));
  const signing = path.join(dir, "signing");
  execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-q", "-f", signing]);
  const machines = path.join(dir, "machines.json");
  writeFileSync(machines, JSON.stringify({ machines: [{ name: "agents:test-box", public_key: readFileSync(`${signing}.pub`, "utf8").trim() }] }));
  process.env.CONFIG_LIBRARY_AGENT_MACHINES = machines;
  const { enrollFlagKey, flagEnrollMessage, FLAG_ENROLL_NAMESPACE, verifyFlagKey } = await import("../platform/flag-console.js");
  const sign = (message: string, namespace = FLAG_ENROLL_NAMESPACE) => {
    const file = path.join(dir, `m${Math.random().toString(36).slice(2)}`);
    writeFileSync(file, message);
    execFileSync("ssh-keygen", ["-Y", "sign", "-q", "-f", signing, "-n", namespace, file], { stdio: "ignore" });
    return readFileSync(`${file}.sig`, "utf8");
  };
  const attempt = (timestamp: number, nonce: string, namespace?: string, machine = "agents:test-box") =>
    enrollFlagKey({ machine, timestamp, nonce, signature: sign(flagEnrollMessage(machine, timestamp, nonce), namespace) });
  const at = Date.now();
  const first = await attempt(at, "a".repeat(32));
  const found = await verifyFlagKey(first.key);
  assert.equal(found?.scope, "write");
  assert.equal(found?.name, "agents:test-box");
  await assert.rejects(attempt(at, "b".repeat(32)), /already used/, "a signature is used once");
  await assert.rejects(attempt(at + 1, "c".repeat(32), "fm-config-library"), /does not match/, "a config library signature does not enroll here");
  await assert.rejects(attempt(at + 2, "d".repeat(32), undefined, "agents:unlisted"), /not a listed/);
  await assert.rejects(attempt(at - 600_000, "e".repeat(32)), /older than five minutes/);
  const second = await attempt(at + 3, "f".repeat(32));
  assert.equal(await verifyFlagKey(first.key), null, "enrolling again revokes the earlier key");
  assert.equal((await verifyFlagKey(second.key))?.name, "agents:test-box");
  delete process.env.CONFIG_LIBRARY_AGENT_MACHINES;
  // This test server is not development, as production is not: the route answers as if it did not exist.
  const refused = await app.inject({ method: "POST", url: "/v1/internal/flags/keys/enroll", payload: { machine: "agents:test-box", timestamp: Date.now(), nonce: "a".repeat(32), signature: "x" } });
  assert.equal(refused.statusCode, 404);
  await rm(dir, { recursive: true, force: true }).catch(() => {});
});

// FM-432: the camera document scanner is an ordinary Documents feature: listed in the console, off unless set (the
// MVP platform configuration turns it on), and off whenever the Documents app is.
test("the document scanner is a Documents feature, off unless set, and only on with the Documents app", async () => {
  const admin = await caller("scanner-admin", { role: "admin" });
  const row = ok(await flags(admin, "GET", "/catalog")).flags.find((flag: any) => flag.key === "documents.scanner");
  assert.ok(row, "documents.scanner is in the console");
  assert.equal(row.parent, "platform.documents");
  assert.equal(row.type, "boolean");
  assert.notEqual(row.default, true);
  const org = await caller("scanner-org");
  const { isCapabilityEnabled, saveCapabilityValues } = await import("../platform/capabilities.js");
  await enableExpandedPlatformFixture(org.orgId, { "platform.documents": true });
  assert.equal(await isCapabilityEnabled(org.orgId, "documents.scanner"), false);
  await saveCapabilityValues(org.orgId, { "documents.scanner": true });
  assert.equal(await isCapabilityEnabled(org.orgId, "documents.scanner"), true);
  await saveCapabilityValues(org.orgId, { "platform.documents": false });
  assert.equal(await isCapabilityEnabled(org.orgId, "documents.scanner"), false, "it follows the Documents app");
});
