import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Runs on SQLite by default and on PostgreSQL through tests/run-embedded-postgres.mjs, which sets TEST_POSTGRES_URL.
test("contacts are records of their own; projects link them and show a projection", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "contacts-store-"));
  const url = process.env.TEST_POSTGRES_URL;
  Object.assign(process.env, { NODE_ENV: "test", FIRSTMATE_ENV: "test", PLATFORM_STORAGE_ROOT: path.join(dir, "platform"), PLATFORM_HEARTBEAT_DISABLED: "1",
    FIRSTMEASURE_DATABASE_MODE: url ? "postgres" : "local", DATABASE_URL: url || "", POSTGRES_POOL_MAX: "1", POSTGRES_AUTO_MIGRATE: "false" });
  const storage = await import("../platform/storage.js");
  const contacts = await import("../contacts/records.js");
  const { matchProjectContact } = await import("../comms/matching.js");
  const { resolveContact, contactOptions, saveContactSettings, contactSettings } = await import("../contacts/service.js");
  t.after(async () => { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await (await import("../src/database/postgres.js")).closePostgresPools(); await rm(dir, { recursive: true, force: true }); });
  const ORG = "org_contacts", OTHER = "org_contacts_other";
  await storage.createOrganization({ id: ORG, name: "Contacts" });
  await storage.createOrganization({ id: OTHER, name: "Other" });

  // A contact stands alone: no project is created for it.
  const ana = await contacts.createContact(ORG, { name: "Ana Ruiz", email: "ANA@Example.com", phone: "(555) 010-2000", phones: ["555-010-2001"], address: "12 Oak St", branch_ids: ["default"] });
  assert.deepEqual([ana.email, ana.phone, ana.phones.map(p => p.normalized), ana.revision, ana.contact_kind], ["ana@example.com", "(555) 010-2000", ["+15550102000", "+15550102001"], 1, "human"]);
  assert.deepEqual(await storage.listDocuments(ORG, "projects"), [], "a contact needs no anchor project");
  await assert.rejects(() => contacts.createContact(ORG, { tags: [] }), /needs a name, email, phone or address/);
  await assert.rejects(() => contacts.createContact(ORG, { name: "Ana again" }, { id: ana.id }), /already exists/);

  // Matching uses the normalized point index, never a project scan.
  assert.deepEqual((await contacts.findExactMatches(ORG, { phone: "+1 555 010 2001" })).map(c => c.id), [ana.id]);
  assert.deepEqual((await contacts.findExactMatches(ORG, { email: "ana@example.com" })).map(c => c.id), [ana.id]);
  assert.deepEqual(await contacts.findExactMatches(OTHER, { email: "ana@example.com" }), [], "contacts belong to their organization");
  assert.deepEqual(await contacts.findExactMatches(ORG, { address: "12 Oak St" }), [], "an address never makes an exact match");

  // Updates change only what they name, and a no-op keeps the revision.
  const renamed = await contacts.updateContact(ORG, ana.id, { name: "Ana Ruiz-Lee" });
  assert.deepEqual([renamed.name, renamed.email, renamed.phones.length, renamed.revision], ["Ana Ruiz-Lee", "ana@example.com", 2, 2]);
  assert.equal((await contacts.updateContact(ORG, ana.id, { name: "Ana Ruiz-Lee" })).revision, 2);
  await assert.rejects(() => contacts.updateContact(ORG, ana.id, { name: "x" }, { expectedRevision: 1 }), /changed elsewhere/);

  // A project's contacts are set through the contact service.
  await storage.upsertDocument(ORG, "projects", { id: "job_roof", data: { title: "Roof", branch_id: "default" } });
  await contacts.saveProjectContacts(ORG, "job_roof", [
    { id: ana.id, name: "Ana Ruiz-Lee", email: "ana@example.com", role: "owner" },
    { name: "Ben Ruiz", phone: "555-010-3000", role: "spouse" }
  ]);
  const job = await storage.readDocument(ORG, "projects", "job_roof");
  const ben = (await contacts.findExactMatches(ORG, { phone: "5550103000" }))[0]!;
  assert.ok(ben, "a new entry is created in the store");
  assert.deepEqual((await contacts.projectContactLinks(ORG, "job_roof")).map(l => [l.contact_id, l.role, l.primary]), [[ana.id, "owner", true], [ben.id, "spouse", false]]);
  const shown = job.data.contacts as Array<Record<string, unknown>>;
  assert.deepEqual([shown.map(c => c.id), job.data.primary_contact_id, job.data.customer_email, shown[0]!.phones], [[ana.id, ben.id], ana.id, "ana@example.com", ["(555) 010-2000", "555-010-2001"]], "the project shows the projection");

  // A project write may not change contacts; re-sending the stored list is not a change, and projected keys keep the service's values.
  await assert.rejects(storage.upsertDocument(ORG, "projects", { id: "job_roof", data: { contacts: [] } }), (error: { code?: string }) => error.code === "project_contacts_read_only");
  await assert.rejects(storage.upsertDocument(ORG, "projects", { id: "job_new", data: { title: "New", contacts: [{ name: "Someone" }] } }), /contacts API/);
  await storage.upsertDocument(ORG, "projects", { id: "job_roof", data: { ...job.data, title: "Roof", customer_name: "Someone else" } }, { replace: true });
  const resent = await storage.readDocument(ORG, "projects", "job_roof");
  assert.deepEqual([resent.data.customer_name, (resent.data.contacts as unknown[]).length], ["Ana Ruiz-Lee", 2]);
  assert.deepEqual((await storage.upsertDocument(ORG, "projects", { id: "job_empty", data: { title: "Empty" } })).data.contacts, [], "a project without links shows an empty list");

  // A second project with the same email links the same person (exact match, auto-attach on by default).
  await storage.upsertDocument(ORG, "projects", { id: "job_gutter", data: { title: "Gutters" } });
  await contacts.saveProjectContacts(ORG, "job_gutter", [{ name: "A. Ruiz", email: "ana@example.com" }]);
  assert.deepEqual((await contacts.projectContactLinks(ORG, "job_gutter")).map(l => l.contact_id), [ana.id]);
  assert.deepEqual(await contacts.contactProjectIds(ORG, ana.id), ["job_gutter", "job_roof"]);

  // Editing the contact rewrites every project's projection.
  await contacts.updateContact(ORG, ana.id, { email: "ana.lee@example.com" });
  for (const id of ["job_roof", "job_gutter"]) assert.equal((await storage.readDocument(ORG, "projects", id)).data.customer_email, "ana.lee@example.com");

  // A copy older than the contact is never written back over it; a current copy's changes are applied everywhere.
  const stale = await storage.readDocument(ORG, "projects", "job_gutter");
  await contacts.updateContact(ORG, ana.id, { name: "Ana Lee" });
  const edited = (data: Record<string, unknown>) => (data.contacts as Array<Record<string, unknown>>).map(c => ({ ...c, notes: "Prefers texts" }));
  await storage.upsertDocument(ORG, "projects", { id: "job_gutter", data: { ...stale.data, title: "Gutters (stale save)" } });
  assert.equal((await storage.readDocument(ORG, "projects", "job_gutter")).data.customer_name, "Ana Lee", "a whole-document save from a stale read passes and keeps the current projection");
  await contacts.saveProjectContacts(ORG, "job_gutter", edited(stale.data));
  assert.deepEqual([(await contacts.readContact(ORG, ana.id)).name, (await contacts.readContact(ORG, ana.id)).notes], ["Ana Lee", ""]);
  const current = await storage.readDocument(ORG, "projects", "job_gutter");
  await contacts.saveProjectContacts(ORG, "job_gutter", edited(current.data));
  assert.equal((await contacts.readContact(ORG, ana.id)).notes, "Prefers texts");
  assert.equal(((await storage.readDocument(ORG, "projects", "job_roof")).data.contacts as Array<Record<string, unknown>>)[0]!.notes, "Prefers texts", "other projects get the change too");

  // Writes that leave contacts out leave links alone; removing a contact from the list unlinks it.
  await storage.upsertDocument(ORG, "projects", { id: "job_roof", data: { title: "Roof replacement" } });
  assert.equal((await contacts.projectContactLinks(ORG, "job_roof")).length, 2);
  const roof = await storage.readDocument(ORG, "projects", "job_roof");
  await contacts.saveProjectContacts(ORG, "job_roof", (roof.data.contacts as unknown[]).slice(1));
  assert.deepEqual((await contacts.projectContactLinks(ORG, "job_roof")).map(l => [l.contact_id, l.primary]), [[ben.id, true]], "the remaining contact becomes primary");
  assert.ok(await contacts.readContact(ORG, ana.id), "unlinking never deletes a contact");

  // With auto-attach off, an exact match creates a new contact instead.
  await saveContactSettings(ORG, { ...(await contactSettings(ORG)), auto_attach_exact: false });
  await storage.upsertDocument(ORG, "projects", { id: "job_repair", data: { title: "Repair" } });
  await contacts.saveProjectContacts(ORG, "job_repair", [{ name: "Ana", email: "ana.lee@example.com" }]);
  assert.notEqual((await contacts.projectContactLinks(ORG, "job_repair"))[0]!.contact_id, ana.id);

  // Lists, options, references and comms all read the store.
  assert.deepEqual((await contacts.listContacts(ORG, { q: "ruiz" })).items.map(c => c.name), ["Ben Ruiz"]);
  assert.deepEqual((await contacts.listContacts(ORG, { q: "555-010-3000" })).items.map(c => c.id), [ben.id]);
  const paged = await contacts.listContacts(ORG, { limit: 1 });
  assert.equal(paged.items.length, 1);
  assert.equal((await contacts.listContacts(ORG, { limit: 5, after: paged.next! })).items.length, 2);
  assert.deepEqual((await contacts.listContacts(ORG, { branch_ids: ["north"] })).items.map(c => c.id), [], "branch scope removes contacts of other branches");
  assert.deepEqual((await contactOptions(ORG)).map(o => Object.keys(o).sort()), [["contact_id", "contact_kind", "name"], ["contact_id", "contact_kind", "name"], ["contact_id", "contact_kind", "name"]]);
  assert.equal((await resolveContact(ORG, { contact_id: ben.id, project_id: "ignored" })).contact.id, ben.id);
  const match = await matchProjectContact(ORG, { phone: "555.010.3000" });
  assert.deepEqual([match?.contact_id, match?.project_id], [ben.id, "job_roof"]);
  const loose = await contacts.createContact(ORG, { name: "Walk-in", phone: "555-010-9999" });
  assert.deepEqual([(await matchProjectContact(ORG, { phone: "5550109999" }))?.contact_id, (await matchProjectContact(ORG, { phone: "5550109999" }))?.project_id], [loose.id, ""]);

  // Contact custom fields are stored on the contact.
  const { readFields, writeFields } = await import("../custom_fields/records.js");
  const { systemPublicationContext } = await import("../platform/publication/context.js");
  const ctx = systemPublicationContext({ organizationId: ORG, kind: "work", operations: ["contacts.test"] });
  const read = await readFields(ctx, { scope: "organization", organizationId: ORG, id: ben.id }, "contact");
  const saved = await writeFields(ctx, { scope: "organization", organizationId: ORG, id: ben.id }, "contact", { expectedRevision: read.row?.revision, values: { secondary_phone: "555-010-3001" } });
  assert.equal((await contacts.readContact(ORG, ben.id)).custom_field_values.secondary_phone, "555-010-3001");
  assert.equal(saved.revision, (await contacts.readContact(ORG, ben.id)).revision);

  // Migration copies embedded contacts once, keeping the ids other records point at.
  const LEGACY = "org_contacts_legacy";
  await storage.createOrganization({ id: LEGACY, name: "Legacy" });
  const raw = (id: string, data: Record<string, unknown>) => storage.upsertDocument(LEGACY, "projects", { id, data }, { contactsProjection: true });
  await raw("job_a", { title: "Job A", contacts: [{ id: "contact_shared", name: "Old copy", email: "cara@example.com" }, { name: "No Id", phone: "555-010-4000" }] });
  await raw("anchor_cara", { workflow_state: "contact_only", contacts: [{ id: "contact_shared", name: "Cara Diaz", email: "cara@example.com" }], contact_custom_field_values: { secondary_phone: "555-010-4001" } });
  await raw("job_b", { title: "Job B", customer_name: "Dee Fox", customer_phone: "555-010-5000" });
  await raw("job_c", { title: "Job C", contacts: [{ id: "project_old:contact:0", name: "Eli Gray" }] });
  const { migrateOrganizationContacts } = await import("../contacts/migration.js");
  assert.deepEqual(await migrateOrganizationContacts(LEGACY), { projects: 4, contacts_created: 4, links: 5, skipped: 0 });
  assert.equal((await contacts.readContact(LEGACY, "project_old:contact:0")).name, "Eli Gray", "older derived ids with colons keep working");
  const cara = await contacts.readContact(LEGACY, "contact_shared");
  assert.deepEqual([cara.name, cara.custom_field_values.secondary_phone], ["Cara Diaz", "555-010-4001"], "the standalone record's copy wins and keeps its field values");
  const noId = (await contacts.projectContactLinks(LEGACY, "job_a"))[1]!.contact_id;
  assert.match(noId, /^contact_[0-9a-f]{16}$/);
  assert.equal(((await storage.readDocument(LEGACY, "projects", "job_a")).data.contacts as Array<Record<string, unknown>>)[0]!.name, "Cara Diaz");
  assert.equal((await storage.readDocument(LEGACY, "projects", "job_b")).data.customer_phone, "555-010-5000");
  assert.deepEqual(await migrateOrganizationContacts(LEGACY), { projects: 0, contacts_created: 0, links: 0, skipped: 4 }, "running it again changes nothing");

  // The standalone records then go; one that gathered work stays as a draft project. Running it again changes nothing.
  await raw("anchor_busy", { workflow_state: "contact_only", contacts: [{ id: "contact_busy", name: "Busy Bee" }], events: [{ id: "visit" }] });
  await migrateOrganizationContacts(LEGACY);
  const { removeStandaloneContactRecords } = await import("../contacts/migration.js");
  assert.deepEqual(await removeStandaloneContactRecords(LEGACY), { removed: 1, kept_as_draft: 1 });
  assert.deepEqual(await removeStandaloneContactRecords(LEGACY), { removed: 0, kept_as_draft: 0 });
  await assert.rejects(storage.readDocument(LEGACY, "projects", "anchor_cara"));
  assert.equal((await contacts.readContact(LEGACY, "contact_shared")).name, "Cara Diaz", "the contact outlives its standalone record");
  assert.deepEqual(await contacts.contactProjectIds(LEGACY, "contact_shared"), ["job_a"]);
  assert.equal((await storage.readDocument(LEGACY, "projects", "anchor_busy")).data.workflow_state, "draft");
});
