import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

// Contact automations (docs/architecture/crm.md, "Contact automations"): rules that start from a contact.
// Contact writers emit contact events; CRM settings generate contact_rule_* organization rules on them
// and on contact dates; the engine gives the rules the contact for conditions and actions.

let app: any = null;
let storageRoot = "";
function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  return values.find((value) => value.startsWith(`${name}=`))?.split(";")[0] || "";
}
function createSessionClient() {
  let cookie = "", csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => await (app.inject as any)({
    method, url, payload, headers: { ...(cookie ? { cookie } : {}), ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {}) }
  });
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session"), csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) { cookie = [sessionCookie || "", csrfCookie || ""].filter(Boolean).join("; "); csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf); }
    const json = response.body ? JSON.parse(response.body) : null;
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return json;
  };
  return { request, raw };
}
before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-contact-triggers-test-"));
  Object.assign(process.env, {
    NODE_ENV: "test", PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    PLATFORM_STORAGE_ROOT: path.join(storageRoot, "platform"), CRM_STORAGE_ROOT: path.join(storageRoot, "crm"),
    FIRSTMEASURE_STORAGE_ROOT: path.join(storageRoot, "firstmeasure"), FIRSTMEASURE_INDEX_DB_PATH: path.join(storageRoot, "firstmeasure", "projects_index.sqlite"),
    PRICEBOOK_STORAGE_ROOT: path.join(storageRoot, "pricebook"), EMAIL_OUTBOUND_DISABLED: "1", V1_LOG_LEVEL: "error"
  });
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});
after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  await (await import("../platform/sql_store.js")).closeSqlStoresForTests();
  try { await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error: any) { if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error; }
});


test("contact automations: created, tagged, changed and dated contacts run their rules with the contact", async () => {
  const client = createSessionClient();
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", { phone: nextTestPhone(), email: `owner-${suffix}@example.test`, password: "correct horse battery staple", name: "Owner User", company: "Contact Rules Co", organization_id: `org_contact_rules_${suffix}` });
  const orgId = registered.organization.id as string;
  await enableExpandedPlatformFixture(orgId);
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const birthday = `1990-${today.slice(5)}`;

  const contactSettings = (await client.request("GET", `/v1/platform/organizations/${orgId}/contacts/settings`)).settings;
  await client.request("PUT", `/v1/platform/organizations/${orgId}/contacts/settings`, { ...contactSettings, tags: [...contactSettings.tags.filter((t: any) => !t.builtin), { id: "vip", label: "VIP", enabled: true }] });
  const empty = await client.request("GET", `/v1/crm/organizations/${orgId}/contact-rules`);
  assert.deepEqual(empty.contact_rules.rules, []);
  assert.ok(empty.date_fields.some((f: any) => f.key === "birthday"));
  const saved = await client.request("PUT", `/v1/crm/organizations/${orgId}/contact-rules`, { rules: [
    { id: "vip", title: "Welcome VIPs", trigger: { kind: "tagged", tag: "vip" }, actions: [{ kind: "todo", title: "Welcome {{contact.name}}", role_ids: ["owner"] }] },
    { id: "companies", title: "Companies become leads", trigger: { kind: "created" }, conditions: { match: "all", rules: [{ field: "contact.company", operator: "equals", value: "Acme" }] }, actions: [{ kind: "lead", summary: "New company account" }] },
    { id: "email_changed", title: "Check a changed email", trigger: { kind: "updated", field: "emails" }, actions: [{ kind: "todo", title: "Confirm the new email for {{contact.name}}" }] },
    { id: "birthday", title: "Birthday call", trigger: { kind: "date", date_field: "birthday", offset_days: 0, yearly: true, time: "09:00" }, actions: [{ kind: "todo", title: "Birthday: {{contact.first_name}}" }] }
  ] });
  assert.equal(saved.contact_rules.rules.length, 4);
  const orgRules = (await client.request("GET", `/v1/work/organizations/${orgId}/branches/default/automation-rules`)).rules;
  const generated = orgRules.filter((r: any) => String(r.id).startsWith("contact_rule_"));
  assert.deepEqual(generated.map((r: any) => r.event).sort(), ["contact.created", "contact.date", "contact.tagged", "contact.updated"]);
  assert.equal(generated.find((r: any) => r.id === "contact_rule_birthday").schedule.contact_date.field, "birthday");

  const { listPlanRecords } = await import("../work/storage.js");
  const todos = async () => (await listPlanRecords(orgId, { source_type: "automation_todo" })).map((plan: any) => ({ title: plan.title, contact_id: plan.metadata?.contact_id || plan.context?.contact_id || "" }));

  // A new contact: created (Acme becomes a lead) and tagged vip (a welcome to-do that opens the contact).
  const created = (await client.request("POST", `/v1/platform/organizations/${orgId}/contacts`, { name: "Ana Acme", first_name: "Ana", company: "Acme", email: "ana@acme.test", tags: ["vip"], birthday })).contact;
  const { drainWorkEvents } = await import("../work/engine.js");
  await drainWorkEvents();
  assert.ok((await todos()).some((t) => t.title === "Welcome Ana Acme" && t.contact_id === created.id), "the tag rule made a to-do for the contact");
  const { contactProjectIds } = await import("../contacts/records.js");
  const projects = await contactProjectIds(orgId, created.id);
  assert.equal(projects.length, 1, "the created rule started a lead for the existing contact");
  const { readDocument } = await import("../platform/storage.js");
  const lead = (await readDocument(orgId, "projects", projects[0]!)).data as any;
  assert.equal(lead.source, "contact_rule");
  assert.equal(lead.summary, "New company account");

  // A contact that is not Acme makes no lead; changing an email runs the changed rule.
  const other = (await client.request("POST", `/v1/platform/organizations/${orgId}/contacts`, { name: "Bo Other", email: "bo@other.test" })).contact;
  await client.request("PATCH", `/v1/platform/organizations/${orgId}/contacts/${other.id}`, { email: "bo@new.test" });
  await drainWorkEvents();
  assert.equal((await contactProjectIds(orgId, other.id)).length, 0);
  assert.ok((await todos()).some((t) => t.title === "Confirm the new email for Bo Other"));
  await client.request("PATCH", `/v1/platform/organizations/${orgId}/contacts/${other.id}`, { company: "Still Other" });
  await drainWorkEvents();
  assert.equal((await todos()).filter((t) => t.title === "Confirm the new email for Bo Other").length, 1, "a change to another field does not match");

  // The birthday rule: the scheduler's firing finds the contacts whose date is today.
  const { emitContactDateEvents } = await import("../work/scheduler.js");
  const rule = generated.find((r: any) => r.id === "contact_rule_birthday");
  assert.equal(await emitContactDateEvents(orgId, "default", rule, new Date().toISOString()), 1);
  assert.equal(await emitContactDateEvents(orgId, "default", rule, new Date().toISOString()), 1, "a second sweep the same day finds the same contact");
  await drainWorkEvents();
  assert.equal((await todos()).filter((t) => t.title === "Birthday: Ana").length, 1, "and the event identity keeps it to one to-do");
});

test("contact automations are validated, and a date rule must follow a date", async () => {
  const { normalizeContactRules } = await import("../crm/contact-rules.js");
  assert.throws(() => normalizeContactRules({ rules: [{ id: "x", title: "X", trigger: { kind: "date", date_field: "name" }, actions: [{ kind: "todo", title: "t" }] }] }), /birthday or a date field/);
  assert.throws(() => normalizeContactRules({ rules: [{ id: "x", title: "X", trigger: { kind: "tagged" }, actions: [] }] }));
  assert.throws(() => normalizeContactRules({ rules: [{ id: "x", title: "X", trigger: { kind: "created" }, conditions: { match: "all", rules: [{ field: "contact.tags", operator: "nope", value: 1 }] }, actions: [{ kind: "todo", title: "t" }] }] }));
});
