import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// docs/architecture/contacts.md "Merge" and opportunities.md "Project merge".
test("merging contacts moves what named the duplicate; merging projects keeps one sale", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "contact-merge-"));
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), CRM_STORAGE_ROOT: path.join(dir, "crm"),
    PLATFORM_HEARTBEAT_DISABLED: "1", WORK_SCHEDULER_DISABLED: "1", FIRSTMEASURE_JOB_WORKERS: "0" });
  const storage = await import("../platform/storage.js");
  const contacts = await import("../contacts/records.js");
  const merge = await import("../contacts/merge.js");
  const { mergeProjects } = await import("../projects/merge.js");
  const { receiveLead } = await import("../leads/receive.js");
  const { saveContactSettings, contactSettings } = await import("../contacts/service.js");
  const { getCommunicationsDatabase } = await import("../messaging/communications_storage.js");
  const { listPlanRecords } = await import("../work/storage.js");
  const { setOpportunityOutcome } = await import("../work/opportunities.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await rm(dir, { recursive: true, force: true }); });
  const ORG = "org_merge";
  await storage.createOrganization({ id: ORG, name: "Merge" });
  await (await import("./helpers/platform-fixture.js")).enableExpandedPlatformFixture(ORG);
  // Two leads for one person that intake could not match: different email, no phone in common.
  await saveContactSettings(ORG, { ...(await contactSettings(ORG)), auto_attach_exact: false });
  const one = await receiveLead(ORG, { project_id: "lead_web", source: { kind: "web_form" }, address: "4 Birch Ln", contacts: [{ name: "Jo Quinn", email: "jo@example.com", phone: "555-040-1000" }], notification: false });
  const two = await receiveLead(ORG, { project_id: "lead_call", source: { kind: "email_lead", provider: "Angi" }, address: "4 Birch Ln", contacts: [{ name: "Jo Quinn", phone: "555-040-1000" }], notification: false });
  const [a, b] = [one.contacts[0]!, two.contacts[0]!];
  assert.notEqual(a.id, b.id);

  // Suggestions: the same phone and name, and two open opportunities in the same sales scope.
  const people = await merge.listDuplicates(ORG, "contact");
  assert.deepEqual(people.map(p => [[p.first_id, p.second_id].sort().join(), p.reasons.sort()]), [[[a.id, b.id].sort().join(), ["same_name", "same_phone"]]]);
  assert.deepEqual(await merge.listDuplicates(ORG, "project"), [], "different contacts: nothing says it is one sale yet");

  // Something else names the duplicate: a call, a relationship field on another contact.
  const comms = getCommunicationsDatabase(), callId = `call_${Date.now().toString(36)}`;
  await comms.prepare("INSERT INTO customer_calls(id,organization_id,branch_id,project_id,contact_id,mode,direction,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(callId, ORG, "default", "lead_call", b.id, "manual", "inbound", "ended", "2026-10-15T00:00:00Z", "2026-10-15T00:00:00Z");
  const spouse = await contacts.createContact(ORG, { name: "Kim Quinn", custom_field_values: { relationships: { spouse: { contact_id: b.id } } } });

  // Contact merge: survivor's values win, blanks fill, points union; the duplicate is kept and resolves to the survivor.
  const result = await merge.mergeContacts(ORG, a.id, b.id, { actor_user_id: "u1" });
  assert.deepEqual([result.contact.id, result.contact.phones.length, result.contact.emails.map(p => p.value)], [a.id, 1, ["jo@example.com"]]);
  assert.equal((await contacts.readContact(ORG, b.id)).id, a.id, "the merged id resolves to the survivor");
  assert.equal((await contacts.readContact(ORG, b.id, { follow: false })).merged_into, a.id);
  assert.deepEqual(await contacts.contactProjectIds(ORG, a.id), ["lead_call", "lead_web"]);
  assert.equal(String((await comms.prepare("SELECT contact_id FROM customer_calls WHERE id=?").get(callId))?.contact_id), a.id);
  assert.deepEqual(((await contacts.readContact(ORG, spouse.id)).custom_field_values.relationships as Record<string, Record<string, string>>).spouse!.contact_id, a.id);
  assert.equal(((await storage.readDocument(ORG, "projects", "lead_call")).data.contacts as Array<Record<string, unknown>>)[0]!.id, a.id);
  assert.deepEqual((await merge.listDuplicates(ORG, "contact")), [], "the pair is settled");
  await assert.rejects(() => merge.mergeContacts(ORG, a.id, b.id), /already merged/);
  assert.deepEqual(await contacts.findExactMatches(ORG, { phone: "5550401000" }).then(rows => rows.map(r => r.id)), [a.id]);
  assert.deepEqual((await merge.listDuplicates(ORG, "project")).map(p => [p.first_id, p.second_id].sort()), [["lead_call", "lead_web"]], "one person now has two open opportunities in the same sales scope");

  // Project merge: one sale. The duplicate's sales scope closes as merged, its call and lead source move.
  const merged = await mergeProjects(ORG, "lead_web", "lead_call", { actor_user_id: "u1" });
  const survivor = merged.project.data as Record<string, unknown>;
  assert.deepEqual((survivor.lead_sources as Array<Record<string, unknown>>).map(s => s.kind), ["web_form", "email_lead"]);
  assert.equal(String((await comms.prepare("SELECT project_id FROM customer_calls WHERE id=?").get(callId))?.project_id), "lead_web");
  const closed = await listPlanRecords(ORG, { project_id: "lead_call", sales: true });
  assert.deepEqual(closed.map(p => [p.status, p.outcome, p.outcome_reason]), [["canceled", "open", "merged"]]);
  assert.equal(((await storage.readDocument(ORG, "projects", "lead_call")).data.merged_into), "lead_web");
  assert.deepEqual(await contacts.contactProjectIds(ORG, a.id), ["lead_web"]);
  assert.equal(((survivor.lifecycle as Record<string, Record<string, number>>).opportunities)!.unresolved, 0, "a merged duplicate is not an unresolved sale");

  // A sold project needs the permission.
  await receiveLead(ORG, { project_id: "lead_three", source: { kind: "web_form" }, address: "4 Birch Ln", contacts: [{ name: "Jo Quinn", email: "jo@example.com" }], notification: false });
  await setOpportunityOutcome(ORG, { project_id: "lead_three", outcome: "won" });
  await assert.rejects(() => mergeProjects(ORG, "lead_web", "lead_three"), /Merge sold projects permission/);
  await mergeProjects(ORG, "lead_web", "lead_three", { allow_committed: true });
});
