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
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
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
  await client.request("PUT", `/v1/platform/organizations/${data.organization.id}/contacts/settings`,{tags:[{id:"vip",label:"VIP"},{id:"gutter",label:"Gutter Customers"},{id:"imported",label:"Imported from CSV"},{id:"updated",label:"Updated"}]});
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
    tags: ["gutter", "imported"],
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
  assert.deepEqual(ginaContact.tags, ["vip", "gutter", "imported"]);
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
    tags: ["updated"],
    duplicate_action: "update"
  });
  assert.equal(update.counts.created, 0);
  assert.equal(update.counts.updated, 1);
  const afterUpdate = await client.request("GET", `/v1/platform/organizations/${orgId}/projects`);
  const ginaAfter = afterUpdate.documents.map((document: any) => document.data).find((data: any) => data.customer_name === "Gina Torres");
  assert.equal(ginaAfter.contacts[0].company, "Torres Consulting");
  assert.ok(ginaAfter.contacts[0].tags.includes("updated"));
  assert.ok(ginaAfter.contacts[0].tags.includes("vip"));

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


test("typed contact references, defaults, managed tags and required media are enforced in storage",async()=>{
 const client=createSessionClient(),{orgId}=await register(client);
 const {upsertDocument,readDocument,saveBranchModule,storeMediaUpload}=await import("../platform/storage.js");
 const create=async(id:string,c:Record<string,unknown>)=>upsertDocument(orgId,"projects",{id,data:{workflow_state:"contact_only",contacts:[{id:"c_"+id,name:id,...c}]}});
 await create("company",{contact_kind:"org"});await create("person",{contact_kind:"human",tags:["vip"]});
 const company=(await readDocument(orgId,"projects","company")).data.contacts as any[];
 assert.equal(company[0].contact_kind,"org");assert.deepEqual(company[0].tags,["org"]);
 await assert.rejects(create("badtag",{tags:["arbitrary"]}),/catalog/);
 const ref={project_id:"company",contact_id:"c_company"};
 await assert.rejects(create("badspouse",{custom_field_values:{relationships:{spouse:ref}}}),/human/);
 await create("employee",{custom_field_values:{relationships:{employer:ref}}});
 await assert.rejects(create("badref",{custom_field_values:{relationships:{employer:{project_id:"missing",contact_id:"c_missing"}}}}));
 const options=await client.request("GET",`/v1/platform/organizations/${orgId}/contacts/options?kind=org`);
 assert.equal(options.contacts.length,1);assert.equal(options.contacts[0].contact_id,"c_company");
 const fields=(await import("../contacts/contracts.js")).CONTACT_DEFAULT_FIELDS;
 const secondaryPhone=fields.find(field=>field.path==="secondary_phone");
 assert.equal(secondaryPhone?.type,"phone");assert.equal(secondaryPhone?.enabled,true);
 await create("twoPhones",{phone:"(415) 555-0100",custom_field_values:{secondary_phone:"(650) 555-0199",primary_phone_label:"work",secondary_phone_label:"cell"}});
 const twoPhones=(await readDocument(orgId,"projects","twoPhones")).data.contacts as any[];
 assert.equal(twoPhones[0].custom_field_values.secondary_phone,"(650) 555-0199");
 await assert.rejects(create("badSecondaryPhone",{custom_field_values:{secondary_phone:"not a phone"}}),/valid phone/);
 await assert.rejects(create("badPhoneLabel",{custom_field_values:{primary_phone_label:"fax"}}),/Primary Phone Label/);
 await saveBranchModule(orgId,"default","custom_fields",{data:{fields:fields.map(f=>({...f,required:f.path==="relationships.employer"}))}});
 await assert.rejects(create("required",{}),/Employer is required/);
 const person=await readDocument(orgId,"projects","person");
 await assert.rejects(upsertDocument(orgId,"projects",{id:"person",data:{...person.data,title:"Updated"}},{replace:true}),/Employer is required/);
 const contract=(await import("../custom_fields/contracts.js"));
 assert.throws(()=>contract.normalizeDefinitions([{entity:"contact",path:"relationships.spouse",type:"text"}]),/retain their type/);
 assert.throws(()=>contract.normalizeDefinitions([{entity:"contact",path:"secondary_phone",type:"text"}]),/retain their type/);
 const media=await storeMediaUpload(orgId,{bytes:Buffer.from("hello"),contentType:"text/plain",fileName:"note.txt",ownerType:"contact",ownerId:"c_employee",slot:"media",collection:"contacts",scope:"contact",metadata:{contact_record_project_id:"employee"}});
 const employee=await readDocument(orgId,"projects","employee"),contact=(employee.data.contacts as any[])[0];
 await assert.rejects(upsertDocument(orgId,"projects",{id:"employee",data:{...employee.data,contacts:[{...contact,custom_field_values:{...contact.custom_field_values,profile_photo:{media_id:media.id}}}]}},{replace:true}),/requires photo/);
 const foreignMedia=await storeMediaUpload(orgId,{bytes:Buffer.from("hello"),contentType:"text/plain",fileName:"other.txt",ownerType:"contact",ownerId:"c_person",slot:"media",collection:"contacts",scope:"contact",metadata:{contact_record_project_id:"person"}});
 await assert.rejects((await import("../contacts/service.js")).validateReference(orgId,{type:"media"},{media_id:foreignMedia.id},contact,"contact"),/record's library/);
});

test("optional photos import into the contact library while invalid photos report separate failures",async()=>{
 const client=createSessionClient(),{orgId}=await register(client);
 const sharp=(await import("sharp")).default;
 const png=await sharp({create:{width:12,height:12,channels:3,background:"#336699"}}).png().toBuffer();
 const content=["BEGIN:VCARD","VERSION:3.0","FN:Photo Person","PHOTO;ENCODING=b;TYPE=PNG:"+png.toString("base64"),"END:VCARD","BEGIN:VCARD","VERSION:3.0","FN:Unsafe Photo","PHOTO:https://127.0.0.1/private.png","END:VCARD"].join("\r\n");
 const preview=await client.request("POST",`/v1/platform/organizations/${orgId}/contact-imports/preview`,{filename:"photos.vcf",content});
 assert.equal(preview.rows[0].contact.photo_available,true);assert.equal(preview.rows[0].contact.photo_source,undefined);
 const result=await client.request("POST",`/v1/platform/organizations/${orgId}/contact-imports/${preview.import_id}/commit`,{import_photos:true});
 assert.equal(result.counts.created,2);assert.equal(result.counts.photos_imported,1);assert.equal(result.counts.photos_failed,1);
 const {listDocuments,listMedia}=await import("../platform/storage.js"),projects=await listDocuments(orgId,"projects"),media=await listMedia(orgId);
 const c=(projects.find(p=>(p.data.contacts as any[])[0].name==="Photo Person")!.data.contacts as any[])[0];
 assert.equal(c.profile_media_id,media[0]!.id);assert.equal((media[0]!.owner as any).type,"contact");
 assert.deepEqual(c.custom_field_values.profile_photo,{media_id:media[0]!.id});
 const {publicPhotoAddress,photoImportUrl}=await import("../contacts/photo-import.js");
 for(const ip of ["10.0.0.1","127.0.0.1","169.254.169.254","172.16.0.1","192.168.1.1","100.64.0.1","::1"])assert.equal(publicPhotoAddress(ip),false);
 assert.equal(publicPhotoAddress("8.8.8.8"),true);
 for(const url of ["http://example.com/a.png","https://127.0.0.1/a.png","https://user:pass@example.com/a.png"])assert.throws(()=>photoImportUrl(url));
});


test("only admins manage catalogs through dedicated, generic and published APIs; draft uploads support required photos",async()=>{
 const owner=createSessionClient(),{orgId}=await register(owner);
 const suffix=Date.now().toString(36),email=`contact-member-${suffix}@example.test`,password="contact member test password";
 await owner.request("POST",`/v1/platform/organizations/${orgId}/users`,{data:{name:"Contact Member",email,password,status:"active",role:"admin",send_invite:false,permissions:{manage_company_settings:false,view_contacts:true,manage_projects:true}}});
 const member=createSessionClient();await member.request("POST","/v1/platform/auth/login",{email,password,organization_id:orgId});
 const settings=await member.request("GET",`/v1/platform/organizations/${orgId}/contacts/settings`);assert.equal(settings.settings.tags[0].id,"org");
 assert.equal((await member.raw("PUT",`/v1/platform/organizations/${orgId}/contacts/settings`,{tags:[]})).statusCode,403);
 assert.equal((await member.raw("PUT",`/v1/platform/organizations/${orgId}/branch/default/modules/contact_settings`,{data:{tags:[]}})).statusCode,403);
 assert.equal((await member.raw("POST",`/v1/publication/organizations/${orgId}/actions/invoke`,{action:"contacts.settings.save",version:"1",target:{scope:"organization",organizationId:orgId},input:{tags:[]},idempotencyKey:"denied"})).statusCode,403);
 const target={scope:"organization",organizationId:orgId};
 const payload={action:"contacts.settings.save",version:"1",target,input:{tags:[{id:"vip",label:"Priority"}]},idempotencyKey:"admin-save"};
 const action=await owner.request("POST",`/v1/publication/organizations/${orgId}/actions/invoke`,payload);
 assert.equal(action.value.tags[1].label,"Priority");
 const replay=await owner.request("POST",`/v1/publication/organizations/${orgId}/actions/invoke`,payload);assert.equal(replay.receipt.replayed,true);
 const read=await member.request("POST",`/v1/publication/organizations/${orgId}/data/read`,{provider:"contacts",export:"settings",target});assert.equal(read.status,"ready");assert.equal(read.value.tags[1].label,"Priority");
 const photo=await (await import("sharp")).default({create:{width:8,height:8,channels:3,background:"#338877"}}).png().toBuffer();
 const metadata={contact_record_project_id:"project_pending_photo",contact_draft:true};
 const upload=await member.request("POST",`/v1/platform/organizations/${orgId}/media`,{base64:photo.toString("base64"),content_type:"image/png",file_name:"portrait.png",owner_type:"contact",owner_id:"contact_pending_photo",slot:"profile",metadata});
 const invalid=await member.raw("POST",`/v1/platform/organizations/${orgId}/media`,{base64:Buffer.from("not an image").toString("base64"),content_type:"image/png",file_name:"bad.png",owner_type:"contact",owner_id:"contact_pending_photo",slot:"profile",metadata});assert.equal(invalid.statusCode,400);
 const {saveBranchModule}=await import("../platform/storage.js"),defaults=(await import("../contacts/contracts.js")).CONTACT_DEFAULT_FIELDS;
 await saveBranchModule(orgId,"default","custom_fields",{data:{fields:defaults.map(f=>({...f,required:f.path==="profile_photo"}))}});
 await member.request("POST",`/v1/platform/organizations/${orgId}/projects`,{id:"project_pending_photo",data:{workflow_state:"contact_only",contacts:[{id:"contact_pending_photo",name:"Photo Required",custom_field_values:{profile_photo:{media_id:upload.media.id}}}]}});
 const library=await member.request("GET",`/v1/platform/organizations/${orgId}/media?contact_id=contact_pending_photo&contact_project_id=project_pending_photo`);assert.equal(library.media.length,1);
 const other=createSessionClient(),{orgId:otherOrg}=await register(other);
 assert.equal((await other.raw("GET",`/v1/platform/organizations/${orgId}/contacts/options`)).statusCode,403);
 assert.equal((await other.raw("GET",`/v1/platform/organizations/${otherOrg}/media/${upload.media.id}`)).statusCode,404);
});
