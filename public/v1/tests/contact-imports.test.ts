import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { parseContactCsv, parseContactFile, parseVcards } from "../platform/contact_import/parse.js";

let app: any = null;
let storageRoot = "";

function readCookie(setCookie: string[] | string | undefined, name: string) {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const match = values.find((value) => value.startsWith(`${name}=`));
  return match?.split(";")[0] || "";
}

function createSessionClient() {
  let cookie = "";
  let csrf = "";
  const raw = async (method: string, url: string, payload?: unknown) => {
    const response = await (app.inject as any)({
      method,
      url,
      payload,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(csrf && !["GET", "HEAD"].includes(method.toUpperCase()) ? { "x-platform-csrf": csrf } : {})
      }
    });
    const setCookie = response.headers["set-cookie"];
    const sessionCookie = readCookie(setCookie, "fm_platform_session");
    const csrfCookie = readCookie(setCookie, "fm_platform_session_csrf");
    if (sessionCookie || csrfCookie) {
      cookie = [
        sessionCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session=")) || "",
        csrfCookie || cookie.split("; ").find((part) => part.startsWith("fm_platform_session_csrf=")) || ""
      ].filter(Boolean).join("; ");
      csrf = decodeURIComponent((csrfCookie || "").split("=")[1] || csrf);
    }
    const data = response.body ? JSON.parse(response.body) : null;
    return { statusCode: response.statusCode, data, body: response.body };
  };
  const request = async (method: string, url: string, payload?: unknown) => {
    const response = await raw(method, url, payload);
    assert.ok(response.statusCode < 400, `${method} ${url} failed: ${response.statusCode} ${response.body}`);
    return response.data;
  };
  return { request, raw };
}

before(async () => {
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-contact-import-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  if (app) await app.close();
  await closePlatformFixtureStores();
  const { closeWorkDatabase } = await import("../work/storage.js");
  (await closeWorkDatabase());
  try {
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error: any) {
    if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
  }
});

async function register(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const data = await client.request("POST", "/v1/platform/auth/register", {
    phone: nextTestPhone(),
    email: `contacts-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Contacts Owner",
    company: "Contacts Test Org",
    organization_id: `org_contacts_${suffix}`
  });
  await enableExpandedPlatformFixture(data.organization.id);
  return { orgId: data.organization.id as string };
}

// ---------------------------------------------------------------------------
// Parsers

test("parses vCard 3.0 blocks with folding, escapes, and categories", () => {
  const vcf = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    "N:Smith;Jane;Q;;",
    "FN:Jane Smith",
    "ORG:Smith Roofing\\, LLC;Operations",
    "TEL;TYPE=CELL:(555) 010-2000",
    "TEL;TYPE=HOME:555-010-2001",
    "EMAIL;TYPE=HOME:jane@example.com",
    "ADR;TYPE=HOME:;;123 Main St;Springfield;IL;62704;USA",
    "NOTE:Prefers text messages\\nSecond line",
    "CATEGORIES:Gutter Customers,VIP",
    "BDAY:1985-04-12",
    "END:VCARD",
    "BEGIN:VCARD",
    "VERSION:3.0",
    "FN:Bob Long",
    "EMAIL:bob@exam",
    " ple.org",
    "END:VCARD"
  ].join("\r\n");
  const result = parseVcards(vcf);
  assert.equal(result.rows.length, 2);
  const jane = result.rows[0]!;
  assert.equal(jane.name, "Jane Smith");
  assert.equal(jane.email, "jane@example.com");
  assert.equal(jane.phone, "(555) 010-2000");
  assert.ok(jane.extra_phones.includes("555-010-2001"));
  assert.equal(jane.company, "Smith Roofing, LLC");
  assert.equal(jane.address, "123 Main St, Springfield, IL, 62704 USA");
  assert.equal(jane.birthday, "1985-04-12");
  assert.deepEqual(jane.tags, ["Gutter Customers", "VIP"]);
  assert.match(jane.notes, /Prefers text messages\nSecond line/);
  // Folded continuation line joins the email.
  assert.equal(result.rows[1]!.email, "bob@example.org");
});

test("parses vCard 2.1 quoted-printable values", () => {
  const vcf = [
    "BEGIN:VCARD",
    "VERSION:2.1",
    "N;ENCODING=QUOTED-PRINTABLE;CHARSET=UTF-8:Garc=C3=ADa;Jos=C3=A9",
    "TEL;CELL:+1 555 010 3000",
    "END:VCARD"
  ].join("\r\n");
  const result = parseVcards(vcf);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.name, "José García");
  assert.equal(result.rows[0]!.phone, "+1 555 010 3000");
});

test("maps Google Contacts CSV headers automatically", () => {
  const csv = [
    'Name,Given Name,Family Name,E-mail 1 - Value,E-mail 2 - Value,Phone 1 - Type,Phone 1 - Value,Address 1 - Formatted,Organization 1 - Name,Group Membership,Notes',
    '"Ann Lee",Ann,Lee,ann@example.com,ann.work@example.com,Mobile,555-010-4000,"9 Oak Ave, Boston, MA 02101","Lee Homes","* myContacts ::: Gutter Customers","Referred by Bob"'
  ].join("\n");
  const result = parseContactCsv(csv);
  assert.equal(result.rows.length, 1);
  const ann = result.rows[0]!;
  assert.equal(ann.name, "Ann Lee");
  assert.equal(ann.email, "ann@example.com");
  assert.deepEqual(ann.extra_emails, ["ann.work@example.com"]);
  assert.equal(ann.phone, "555-010-4000");
  assert.equal(ann.address, "9 Oak Ave, Boston, MA 02101");
  assert.equal(ann.company, "Lee Homes");
  assert.deepEqual(ann.tags, ["Gutter Customers"]); // myContacts noise dropped
  assert.equal(ann.notes, "Referred by Bob");
});

test("maps Outlook CSV headers and assembles split addresses", () => {
  const csv = [
    "First Name,Last Name,E-mail Address,Mobile Phone,Home Street,Home City,Home State,Home Postal Code,Company,Categories",
    "Sam,Reed,sam@example.com,555-010-5000,44 Pine Rd,Austin,TX,78701,Reed LLC,Gutters;Leads"
  ].join("\r\n");
  const result = parseContactCsv(csv);
  const sam = result.rows[0]!;
  assert.equal(sam.name, "Sam Reed");
  assert.equal(sam.address, "44 Pine Rd, Austin, TX, 78701");
  assert.deepEqual(sam.tags, ["Gutters", "Leads"]);
});

test("supports explicit mapping overrides and delimiter detection", () => {
  const tsv = "Person\tMail\tCell\nPat Doe\tpat@example.com\t555-010-6000";
  const auto = parseContactFile("contacts.tsv", tsv);
  assert.equal(auto.delimiter, "\t");
  // "Person" is unrecognized without an override.
  assert.equal(auto.rows[0]?.name ?? "", "");
  const mapped = parseContactCsv(tsv, { Person: "name", Mail: "email", Cell: "phone" });
  assert.equal(mapped.rows[0]!.name, "Pat Doe");
  assert.equal(mapped.rows[0]!.email, "pat@example.com");
  assert.equal(mapped.rows[0]!.phone, "555-010-6000");
});

test("detects vCard content regardless of file name", () => {
  const vcf = "BEGIN:VCARD\nVERSION:3.0\nFN:Misnamed File\nEMAIL:x@example.com\nEND:VCARD";
  const result = parseContactFile("export.csv", vcf);
  assert.equal(result.format, "vcard");
  assert.equal(result.rows[0]!.name, "Misnamed File");
});

// ---------------------------------------------------------------------------
// Import pipeline

const IMPORT_CSV = [
  "Name,Email,Phone,Address,Tags",
  "Gina Torres,gina@example.com,555-010-7000,1 Elm St,VIP",
  "Hank Voight,hank@example.com,555-010-7001,2 Elm St,",
  "Gina Torres,gina@example.com,555-010-7000,1 Elm St,", // in-file duplicate
  ",,,," // invalid
].join("\n");

test("preview -> commit creates tagged contact_only records; undo removes them", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);

  const preview = await client.request("POST", `/v1/platform/organizations/${orgId}/contact-imports/preview`, {
    content: IMPORT_CSV,
    filename: "gutters.csv"
  });
  assert.ok(preview.import_id);
  assert.equal(preview.format, "csv");
  assert.equal(preview.summary.total, 3); // blank row dropped at parse time
  assert.equal(preview.summary.new_count, 2);
  assert.equal(preview.summary.duplicate_count, 1);
  const fileDuplicate = preview.rows.find((row: any) => row.status === "duplicate");
  assert.equal(fileDuplicate.match.kind, "file");

  const commit = await client.request("POST", `/v1/platform/organizations/${orgId}/contact-imports/${preview.import_id}/commit`, {
    tags: ["Gutter Customers", "Imported from CSV"],
    duplicate_action: "skip"
  });
  assert.equal(commit.counts.created, 2);
  assert.equal(commit.counts.skipped, 1);
  assert.equal(commit.status, "committed");

  const projects = await client.request("GET", `/v1/platform/organizations/${orgId}/projects`);
  const imported = projects.documents.filter((document: any) => document.data.workflow_state === "contact_only");
  assert.equal(imported.length, 2);
  const gina = imported.map((document: any) => document.data).find((data: any) => data.customer_name === "Gina Torres");
  assert.ok(gina, "Gina should exist as a contact_only record");
  const ginaContact = gina.contacts[0];
  assert.deepEqual(ginaContact.tags, ["VIP", "Gutter Customers", "Imported from CSV"]);
  assert.equal(ginaContact.import_id, preview.import_id);
  assert.ok(ginaContact.imported_at);
  assert.equal(ginaContact.import_source, "CSV file");

  // Re-importing the same file classifies everything as an existing duplicate.
  const second = await client.request("POST", `/v1/platform/organizations/${orgId}/contact-imports/preview`, {
    content: IMPORT_CSV,
    filename: "gutters.csv"
  });
  assert.equal(second.summary.new_count, 0);
  assert.equal(second.summary.duplicate_count, 3);
  await client.request("DELETE", `/v1/platform/organizations/${orgId}/contact-imports/${second.import_id}`);

  // Update action merges blanks and tags instead of creating records.
  const updateCsv = "Name,Email,Phone,Company\nGina Torres,gina@example.com,555-010-7000,Torres Consulting";
  const third = await client.request("POST", `/v1/platform/organizations/${orgId}/contact-imports/preview`, {
    content: updateCsv,
    filename: "gutters-update.csv"
  });
  const update = await client.request("POST", `/v1/platform/organizations/${orgId}/contact-imports/${third.import_id}/commit`, {
    tags: ["Updated"],
    duplicate_action: "update"
  });
  assert.equal(update.counts.created, 0);
  assert.equal(update.counts.updated, 1);
  const afterUpdate = await client.request("GET", `/v1/platform/organizations/${orgId}/projects`);
  const ginaAfter = afterUpdate.documents.map((document: any) => document.data).find((data: any) => data.customer_name === "Gina Torres");
  assert.equal(ginaAfter.contacts[0].company, "Torres Consulting");
  assert.ok(ginaAfter.contacts[0].tags.includes("Updated"));
  assert.ok(ginaAfter.contacts[0].tags.includes("VIP"));

  // History lists both commits, newest first.
  const history = await client.request("GET", `/v1/platform/organizations/${orgId}/contact-imports`);
  const committed = history.imports.filter((record: any) => record.status === "committed");
  assert.equal(committed.length, 2);
  assert.ok(!("rows" in committed[0]), "history summaries must not carry raw rows");

  // Undo removes only records created by the first import.
  const undo = await client.request("POST", `/v1/platform/organizations/${orgId}/contact-imports/${preview.import_id}/undo`);
  assert.equal(undo.removed, 2);
  const afterUndo = await client.request("GET", `/v1/platform/organizations/${orgId}/projects`);
  assert.equal(afterUndo.documents.filter((document: any) => document.data.workflow_state === "contact_only").length, 0);
  const undoneHistory = await client.request("GET", `/v1/platform/organizations/${orgId}/contact-imports`);
  assert.equal(undoneHistory.imports.find((record: any) => record.id === preview.import_id).status, "undone");
});

test("commit rejects a second run and preview validates content", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);
  const preview = await client.request("POST", `/v1/platform/organizations/${orgId}/contact-imports/preview`, {
    content: "Name,Email\nSolo Contact,solo@example.com",
    filename: "solo.csv"
  });
  await client.request("POST", `/v1/platform/organizations/${orgId}/contact-imports/${preview.import_id}/commit`, {});
  const again = await client.raw("POST", `/v1/platform/organizations/${orgId}/contact-imports/${preview.import_id}/commit`, {});
  assert.equal(again.statusCode, 409);
  const empty = await client.raw("POST", `/v1/platform/organizations/${orgId}/contact-imports/preview`, { content: "   ", filename: "empty.csv" });
  assert.equal(empty.statusCode, 400);
});

// ---------------------------------------------------------------------------
// Contact-scoped to-dos

test("to-dos can be scoped to a contact and unioned with the contact's projects", async () => {
  const client = createSessionClient();
  const { orgId } = await register(client);

  // A project linked to the contact.
  await client.request("POST", `/v1/platform/organizations/${orgId}/projects`, {
    id: "project_contact_todo",
    data: {
      id: "project_contact_todo",
      title: "Roof for Rita",
      workflow_state: "draft",
      contacts: [{ id: "contact_rita", name: "Rita Ortiz", email: "rita@example.com", primary: true }]
    },
    metadata: { kind: "platform_project" }
  });

  // A contact-scoped to-do (no project) with a due date -> onDue notification binding.
  const contactTodo = await client.request("POST", `/v1/work/organizations/${orgId}/todos`, {
    title: "Wish Rita a happy birthday",
    contact_id: "contact_rita",
    contact_name: "Rita Ortiz",
    contact_email: "rita@example.com",
    due_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString()
  });
  assert.deepEqual(contactTodo.todo.metadata.contact_refs, [{
    contact_id: "contact_rita",
    name: "Rita Ortiz",
    email: "rita@example.com",
    phone: ""
  }]);
  assert.equal(contactTodo.todo.automation_bindings.onDue[0].automation, "notification.create.v1");

  // A project to-do on the contact's project.
  await client.request("POST", `/v1/work/organizations/${orgId}/todos`, {
    title: "Order materials for Rita",
    project_id: "project_contact_todo"
  });
  // An unrelated to-do that must stay out of the contact view.
  await client.request("POST", `/v1/work/organizations/${orgId}/todos`, { title: "Unrelated task" });

  const byContact = await client.request("GET", `/v1/work/organizations/${orgId}/todos?contact_id=contact_rita&include_future=1`);
  assert.deepEqual(byContact.todos.map((todo: any) => todo.title), ["Wish Rita a happy birthday"]);

  const unioned = await client.request(
    "GET",
    `/v1/work/organizations/${orgId}/todos?contact_id=contact_rita&project_ids=project_contact_todo&include_future=1`
  );
  const unionedTitles = unioned.todos.map((todo: any) => todo.title);
  // The union carries the contact to-do plus everything on the contact's
  // project — including pipeline to-dos the intake router seeded there.
  assert.ok(unionedTitles.includes("Wish Rita a happy birthday"));
  assert.ok(unionedTitles.includes("Order materials for Rita"));
  assert.ok(!unionedTitles.includes("Unrelated task"));
  assert.ok(unioned.todos.every((todo: any) => todo.project_id === "project_contact_todo" || (todo.metadata?.contact_refs || []).some((ref: any) => ref.contact_id === "contact_rita")));

  // Email matching works when no contact id was stored.
  const byEmail = await client.request("GET", `/v1/work/organizations/${orgId}/todos?contact_email=rita@example.com&include_future=1`);
  assert.deepEqual(byEmail.todos.map((todo: any) => todo.title), ["Wish Rita a happy birthday"]);
});
