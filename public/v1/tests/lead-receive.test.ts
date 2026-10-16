import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Every lead source goes through receiveLead (docs/architecture/opportunities.md).
test("a lead is a contact plus a project; existing people are matched, never rewritten", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "lead-receive-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), CRM_STORAGE_ROOT: path.join(dir, "crm"),
    PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0",
    // Runs on SQLite by default and on PostgreSQL through tests/run-embedded-postgres.mjs, which sets TEST_POSTGRES_URL.
    FIRSTMEASURE_DATABASE_MODE: process.env.TEST_POSTGRES_URL ? "postgres" : "local", DATABASE_URL: process.env.TEST_POSTGRES_URL || "", POSTGRES_POOL_MAX: "4", POSTGRES_AUTO_MIGRATE: "false" });
  const storage = await import("../platform/storage.js");
  const contacts = await import("../contacts/records.js");
  const { receiveLead } = await import("../leads/receive.js");
  const { receiveChatLead } = await import("../chat/service.js");
  const { listEventRecords } = await import("../work/storage.js");
  const { readSmsConsent } = await import("../messaging/communications_storage.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await (await import("../src/database/postgres.js")).closePostgresPools(); await rm(dir, { recursive: true, force: true }); });
  const ORG = "org_leads";
  await storage.createOrganization({ id: ORG, name: "Leads" });
  await (await import("./helpers/platform-fixture.js")).enableExpandedPlatformFixture(ORG);

  const first = await receiveLead(ORG, { project_id: "lead_one", source: { kind: "web_form", provider: "Web form", form_id: "f1" }, address: "1 Elm St",
    contacts: [{ name: "Gia Park", email: "gia@example.com", phone: "555-020-1000" }], consent: { sms: true, disclosure_text: "Text me about my estimate." } });
  const gia = first.contacts[0]!;
  assert.deepEqual([first.project.id, first.matched_contact_ids, (first.project.data.contacts as unknown[]).length, first.project.data.primary_contact_id], ["lead_one", [], 1, gia.id]);
  assert.deepEqual((first.project.data.lead_source as Record<string, unknown>).form_id, "f1", "source fields stay on the project");
  assert.deepEqual(await contacts.contactProjectIds(ORG, gia.id), ["lead_one"]);
  assert.equal((await readSmsConsent(ORG, "+15550201000"))?.status, "opted_in", "a ticked SMS consent is recorded");
  assert.equal((await listEventRecords(ORG, { project_id: "lead_one", type: "lead.received" })).length, 1);
  await assert.rejects(() => receiveLead(ORG, { project_id: "lead_one", source: { kind: "web_form" }, address: "1 Elm St" }), /already exists/, "a retried submission never makes a second lead");

  // A returning person is matched by phone; the lead's different email does not change the contact on file.
  const second = await receiveLead(ORG, { source: { kind: "email_lead" }, contacts: [{ name: "G. Park", email: "attacker@example.com", phone: "(555) 020-1000" }], summary: "Gutters too" });
  assert.deepEqual([second.contacts[0]!.id, second.matched_contact_ids], [gia.id, [gia.id]]);
  const onFile = await contacts.readContact(ORG, gia.id);
  assert.deepEqual([onFile.name, onFile.email], ["Gia Park", "gia@example.com"]);
  assert.deepEqual(((second.project.data.lead_source as Record<string, unknown>).contacts as Array<Record<string, unknown>>)[0]!.email, "attacker@example.com", "what the lead said is kept on the lead source");
  assert.equal(await readSmsConsent(ORG, "+15559999999"), null);

  await assert.rejects(() => receiveLead(ORG, { source: { kind: "manual_lead" } }), /needs at least/);
  const noContact = await receiveLead(ORG, { source: { kind: "manual_lead" }, address: "9 Pine Rd", notification: false });
  assert.deepEqual(noContact.contacts, []);

  // Live chat: one lead per conversation, however often the visitor shares details.
  const visitor = { display_name: "Hal", email: "hal@example.com", phone: "" };
  const chatLead = await receiveChatLead(ORG, "default", "conv_1", visitor);
  assert.ok(chatLead.startsWith("lead_chat_"));
  assert.equal(await receiveChatLead(ORG, "default", "conv_1", { ...visitor, phone: "555-020-3000" }), chatLead);
  assert.equal(((await storage.readDocument(ORG, "projects", chatLead)).data.contacts as Array<Record<string, unknown>>)[0]!.email, "hal@example.com");

  // Deleting a project drops its links; the contact stays.
  await storage.deleteDocument(ORG, "projects", chatLead);
  const hal = (await contacts.findExactMatches(ORG, { email: "hal@example.com" }))[0]!;
  assert.deepEqual(await contacts.contactProjectIds(ORG, hal.id), []);
});
