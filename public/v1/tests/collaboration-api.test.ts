import { nextTestPhone, enableExpandedPlatformFixture, closePlatformFixtureStores } from "./helpers/platform-fixture.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";



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
  storageRoot = await mkdtemp(path.join(os.tmpdir(), "firstmate-collaboration-test-"));
  process.env.NODE_ENV = "test";
  process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.WORK_SCHEDULER_DISABLED = "1";
  process.env.FIRSTMEASURE_JOB_WORKERS = "0";
  process.env.EMAIL_OUTBOUND_DISABLED = "1";
  process.env.PLATFORM_STORAGE_ROOT = path.join(storageRoot, "platform");
  process.env.CRM_STORAGE_ROOT = path.join(storageRoot, "crm");
  process.env.FIRSTMEASURE_STORAGE_ROOT = path.join(storageRoot, "firstmeasure");
  process.env.FIRSTMEASURE_INDEX_DB_PATH = path.join(storageRoot, "firstmeasure", "projects_index.sqlite");
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(storageRoot, "pricebook");
  process.env.V1_LOG_LEVEL = "error";
  if(process.env.TEST_POSTGRES_URL){process.env.FIRSTMEASURE_DATABASE_MODE="postgres";process.env.DATABASE_URL=process.env.TEST_POSTGRES_URL;process.env.POSTGRES_AUTO_MIGRATE="false";process.env.POSTGRES_POOL_MAX="4";}
  const { buildApp } = await import("../src/app.js");
  app = await buildApp();
  await app.ready();
});

after(async () => {
  const { closeSqlStoresForTests } = await import("../platform/sql_store.js");
  if (app) await app.close();
  await closePlatformFixtureStores();
  const [{ closePayrollDatabase }, { closeWorkforceDatabase }, { closeWorkDatabase }] = await Promise.all([
    import("../payroll/storage.js"),
    import("../workforce/storage.js"),
    import("../work/storage.js")
  ]);
  (await closePayrollDatabase());
  (await closeWorkforceDatabase());
  (await closeWorkDatabase());
  await closeSqlStoresForTests();
  if(process.env.TEST_POSTGRES_URL)await (await import("../src/database/postgres.js")).closePostgresPools();
  try {
    await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error: any) {
    if (error?.code !== "EBUSY" && error?.code !== "EPERM") throw error;
  }
});

async function registerOwner(client: ReturnType<typeof createSessionClient>) {
  const suffix = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const registered = await client.request("POST", "/v1/platform/auth/register", {phone: nextTestPhone(),
    email: `app-groups-owner-${suffix}@example.test`,
    password: "correct horse battery staple",
    name: "Payroll Owner",
    company: "Payroll Test Org",
    organization_id: `org_payroll_${suffix}`
  });
  await enableExpandedPlatformFixture(String(registered.organization.id));
  await enableExpandedPlatformFixture(String(registered.organization.id), { "platform.money": true, "apps.payroll": true, "platform.project_photos": true, "platform.photos_feed": true, "platform.documents": true, "platform.scheduling": true });
  return { orgId: String(registered.organization.id), ownerUserId: String(registered.user.id) };
}

test("organization connection approval, private projections, explicit deny and revocation", async () => {
  const a=createSessionClient(),b=createSessionClient(),c=createSessionClient();
  const ao=await registerOwner(a),bo=await registerOwner(b),co=await registerOwner(c);
  const root=(org:string)=>`/v1/collaboration/organizations/${org}`;
  const ar=root(ao.orgId),br=root(bo.orgId),cr=root(co.orgId);
  const {upsertDocument}=await import("../platform/storage.js");
  await upsertDocument(ao.orgId,"projects",{id:"shared_roof",data:{title:"Roof",address:"42 Test St",private_cost:9000,contacts:[{id:"secret",email:"private@example.test"}],photos:[{secret:true}]}});
  const resource={owner_org_id:ao.orgId,type:"project",id:"shared_roof"};
  assert.equal((await b.raw("POST",br+"/resources/read",resource)).statusCode,403);
  const inv=await a.request("POST",ar+"/invitations",{relationship:"partner"});
  const claim=await b.request("POST",br+"/invitations/accept",{token:inv.token});
  assert.equal(claim.invitation.status,"claimed");
  assert.equal((await c.raw("POST",cr+"/invitations/accept",{token:inv.token})).statusCode,403);
  await a.request("POST",ar+`/invitations/${inv.invitation.id}/approve`,{expected_revision:claim.invitation.revision});
  const partners=await a.request("GET",ar+"/partners");
  assert.equal(partners.items[0].classification,"partner");
  assert.ok(partners.items[0].contact_ref);
  const grant=await a.request("POST",ar+"/shares",{resource,recipient_org_id:bo.orgId,operations:["read","details.update"],fields:["title","address"]});
  const shared=await b.request("POST",br+"/resources/read",resource);
  assert.deepEqual(shared.data,{title:"Roof",address:"42 Test St"});
  const publicationSource={provider:"collaboration",export:"resource",target:{scope:"organization",organizationId:bo.orgId},args:{resource}};
  const published=await b.request("POST",`/v1/publication/organizations/${bo.orgId}/data/read`,publicationSource);
  assert.equal(published.status,"ready",JSON.stringify(published));assert.deepEqual(published.value.data,shared.data);

  assert.equal((await c.raw("POST",cr+"/resources/read",resource)).statusCode,403);
  assert.equal((await b.raw("GET",`/v1/platform/organizations/${ao.orgId}/projects/shared_roof`)).statusCode,403);
  assert.equal((await b.raw("PATCH",br+"/resources/details",{resource,input:{expected_revision:shared.revision,fields:{private_cost:"1"}}})).statusCode,403);
  await b.request("PATCH",br+"/resources/details",{resource,input:{expected_revision:shared.revision,fields:{title:"New roof"}}});
  assert.equal((await b.raw("PATCH",br+"/resources/details",{resource,input:{expected_revision:shared.revision,fields:{title:"Stale"}}})).statusCode,409);
  const deny=await a.request("POST",ar+"/shares",{resource,recipient_org_id:bo.orgId,operations:["read"],denied_operations:["details.update"],fields:["title"]});
  await upsertDocument(bo.orgId,"users",{id:"local_reader",data:{name:"Reader",status:"active"}});
  await b.request("PUT",br+`/shares/${deny.share.id}/audience`,{expected_revision:0,audience:{mode:"selected",user_ids:["local_reader"]}});
  const fresh=await b.request("POST",br+"/resources/read",resource);
  assert.equal(fresh.operations.includes("details.update"),false);
  assert.equal((await b.raw("PATCH",br+"/resources/details",{resource,input:{expected_revision:fresh.revision,fields:{title:"Denied"}}})).statusCode,403);
  await a.request("POST",ar+`/shares/${grant.share.id}/revoke`,{expected_revision:1});
  await a.request("POST",ar+`/shares/${deny.share.id}/revoke`,{expected_revision:1});
  assert.equal((await b.raw("POST",br+"/resources/read",resource)).statusCode,403);
  assert.deepEqual((await b.request("GET",br+"/shared")).items,[]);
  assert.equal((await b.request("POST",`/v1/publication/organizations/${bo.orgId}/data/read`,publicationSource)).status,"denied");
});

test("individual invitations bind verified identity without creating an organization partnership",async()=>{
  const a=createSessionClient(),b=createSessionClient(),c=createSessionClient();
  const ao=await registerOwner(a),bo=await registerOwner(b),co=await registerOwner(c);
  const {readDocument,readIdentity,patchIdentity,upsertDocument}=await import("../platform/storage.js");
  const user=await readDocument(bo.orgId,"users",bo.ownerUserId),identity=await readIdentity(String(user.data.identity_id));
  await patchIdentity(String(identity.id),{metadata:{...identity.metadata as any,email_verified:true}});
  await upsertDocument(ao.orgId,"projects",{id:"individual_project",data:{title:"Individual access",private_cost:4000}});
  const ar=`/v1/collaboration/organizations/${ao.orgId}`,br=`/v1/collaboration/organizations/${bo.orgId}`,cr=`/v1/collaboration/organizations/${co.orgId}`;
  const resource={owner_org_id:ao.orgId,type:"project",id:"individual_project"};
  const invitation=await a.request("POST",ar+"/invitations",{kind:"share",recipient_kind:"individual",email:identity.email,grant:{resource,operations:["read"],fields:["title"]}});
  assert.equal((await c.raw("POST",cr+"/invitations/accept",{token:invitation.token})).statusCode,403);
  const accepted=await b.request("POST",br+"/invitations/accept",{token:invitation.token});
  assert.equal(accepted.connection,null);
  assert.deepEqual((await b.request("GET",br+"/partners")).items,[]);
  assert.deepEqual((await b.request("POST",br+"/resources/read",resource)).data,{title:"Individual access"});
  const repeat=await b.request("POST",br+"/invitations/accept",{token:invitation.token});
  assert.equal(repeat.invitation.id,accepted.invitation.id);
  const shares=await a.request("GET",ar+"/shares");
  assert.equal(shares.items.length,1);
  await a.request("POST",ar+`/shares/${shares.items[0].id}/revoke`,{expected_revision:1});
  assert.equal((await b.raw("POST",br+"/resources/read",resource)).statusCode,403);
});

test("project photo grants exclude files, validate editable fields, and recheck privacy",async()=>{
  const a=createSessionClient(),b=createSessionClient();
  const ao=await registerOwner(a),bo=await registerOwner(b);
  const {upsertDocument,storeMediaUpload}=await import("../platform/storage.js");
  const ar=`/v1/collaboration/organizations/${ao.orgId}`,br=`/v1/collaboration/organizations/${bo.orgId}`;
  const inv=await a.request("POST",ar+"/invitations",{});
  const claimed=await b.request("POST",br+"/invitations/accept",{token:inv.token});
  await a.request("POST",ar+`/invitations/${inv.invitation.id}/approve`,{expected_revision:claimed.invitation.revision});
  await upsertDocument(ao.orgId,"projects",{id:"media_project",data:{title:"Photos"}});
  await storeMediaUpload(ao.orgId,{id:"private_contract",ownerType:"project",ownerId:"media_project",fileName:"contract.pdf",contentType:"application/pdf",bytes:Buffer.from("private contract")});
  const resource={owner_org_id:ao.orgId,type:"project",id:"media_project"};
  assert.equal((await a.raw("POST",ar+"/shares",{resource,recipient_org_id:bo.orgId,operations:["read"],fields:["private_cost"]})).statusCode,400);
  const grant=await a.request("POST",ar+"/shares",{resource,recipient_org_id:bo.orgId,operations:["read","photos.read"],fields:["title"],include_future:true});
  assert.deepEqual((await b.request("POST",br+"/resources/photos",resource)).items,[]);
  assert.equal((await b.raw("GET",br+`/shares/${grant.share.id}/files/private_contract`)).statusCode,403);
  const policy=await a.request("GET",ar+"/privacy");
  await a.request("PUT",ar+"/privacy",{expected_revision:policy.revision,policy:{...policy.policy,send_shares:false}});
  assert.equal((await b.raw("POST",br+"/resources/read",resource)).statusCode,403);
});

test("email invitations require verified matching accounts and tokens cannot be replayed across orgs",async()=>{
  const a=createSessionClient(),b=createSessionClient();
  const ao=await registerOwner(a),bo=await registerOwner(b);
  const {readDocument,readIdentity,patchIdentity}=await import("../platform/storage.js");
  const user=await readDocument(bo.orgId,"users",bo.ownerUserId),identity=await readIdentity(String(user.data.identity_id));
  const ar=`/v1/collaboration/organizations/${ao.orgId}`,br=`/v1/collaboration/organizations/${bo.orgId}`;
  const invitation=await a.request("POST",ar+"/invitations",{email:identity.email});
  assert.equal((await b.raw("POST",br+"/invitations/accept",{token:invitation.token})).statusCode,403);
  await patchIdentity(String(identity.id),{metadata:{...identity.metadata as any,email_verified:true}});
  const results=await Promise.all([1,2].map(()=>b.request("POST",br+"/invitations/accept",{token:invitation.token})));
  assert.equal(results[0].connection.id,results[1].connection.id);
  const p=await a.request("GET",ar+"/privacy");
  await a.request("PUT",ar+"/privacy",{expected_revision:p.revision,policy:{...p.policy,enabled:false}});
  assert.equal((await b.raw("POST",br+"/invitations/preview",{token:invitation.token})).statusCode,403);
});

test("partner engagements grant access only after acceptance and revoke only their own grant",async()=>{
  const a=createSessionClient(),b=createSessionClient();
  const ao=await registerOwner(a),bo=await registerOwner(b);
  const ar=`/v1/collaboration/organizations/${ao.orgId}`,br=`/v1/collaboration/organizations/${bo.orgId}`;
  const invitation=await a.request("POST",ar+"/invitations",{relationship:"partner"});
  const claim=await b.request("POST",br+"/invitations/accept",{token:invitation.token});
  await a.request("POST",ar+`/invitations/${invitation.invitation.id}/approve`,{expected_revision:claim.invitation.revision});
  const relationship=(await a.request("GET",ar+"/partners")).items[0];
  const {upsertDocument}=await import("../platform/storage.js");
  await upsertDocument(ao.orgId,"projects",{id:"engagement_project",data:{title:"Roof work"}});
  const resource={owner_org_id:ao.orgId,type:"project",id:"engagement_project"};
  const input={relationship_id:relationship.id,project_id:resource.id,title:"Install roof",grant:{operations:["read"],fields:["title"]},client_operation_id:"offer_once"};
  const proposal=(await a.request("POST",ar+"/engagements",input)).engagement;
  assert.equal((await a.request("POST",ar+"/engagements",input)).engagement.id,proposal.id);
  assert.equal((await b.raw("POST",br+"/resources/read",resource)).statusCode,403);
  assert.equal((await a.raw("PATCH",ar+`/engagements/${proposal.id}`,{expected_revision:1,status:"accepted"})).statusCode,403);
  const accepted=(await b.request("PATCH",br+`/engagements/${proposal.id}`,{expected_revision:1,status:"accepted"})).engagement;
  assert.equal((await b.request("POST",br+"/resources/read",resource)).data.title,"Roof work");
  const scheduleInput={expected_revision:accepted.revision,start_at:"2026-10-05T16:00:00Z",end_at:"2026-10-05T18:00:00Z",client_operation_id:"schedule_once"};
  await a.request("PUT",ar+`/partners/${relationship.id}/assignments`,{expected_revision:0,enable_kind_ids:["crew"],mappings:[{local_kind_id:"crew",organization:true,group_kind_ids:[]}]});
  const scheduled=await a.request("POST",ar+`/engagements/${proposal.id}/schedule`,scheduleInput);
  assert.equal((await a.request("POST",ar+`/engagements/${proposal.id}/schedule`,scheduleInput)).event_id,scheduled.event_id);
  const project=await (await import("../platform/storage.js")).readDocument(ao.orgId,"projects",resource.id);
  assert.equal((project.data.events as any[])[0].work_resource_ref.kind,"organization_connection");

  const other=(await a.request("POST",ar+"/shares",{resource,recipient_org_id:bo.orgId,operations:["read"],fields:["title"]})).share;
  await b.request("PATCH",br+`/engagements/${proposal.id}`,{expected_revision:accepted.revision,status:"canceled"});
  assert.equal((await b.request("POST",br+"/resources/read",resource)).data.title,"Roof work");
  await a.request("POST",ar+`/shares/${other.id}/revoke`,{expected_revision:other.revision});
  assert.equal((await b.raw("POST",br+"/resources/read",resource)).statusCode,403);
});

test("partner checkout uses the mock provider once and offline reports do not settle invoices",async()=>{
  const a=createSessionClient(),b=createSessionClient();
  const ao=await registerOwner(a),bo=await registerOwner(b);
  const ar=`/v1/collaboration/organizations/${ao.orgId}`,br=`/v1/collaboration/organizations/${bo.orgId}`;
  const invitation=await a.request("POST",ar+"/invitations",{relationship:"partner"});
  const claim=await b.request("POST",br+"/invitations/accept",{token:invitation.token});
  await a.request("POST",ar+`/invitations/${invitation.invitation.id}/approve`,{expected_revision:claim.invitation.revision});
  await enableExpandedPlatformFixture(ao.orgId,{"platform.money":true,"money.merchant_processing":true,"money.invoices":true});
  const {upsertDocument,listDocuments}=await import("../platform/storage.js"),{saveObligation}=await import("../payments/storage.js"),{upsertMerchantConfig}=await import("../payments/merchant_config.js");
  await upsertDocument(ao.orgId,"projects",{id:"invoice_project",data:{title:"Invoice job"}});
  await saveObligation(ao.orgId,{id:"partner_due",project_id:"invoice_project",direction:"inbound",amount_cents:25000,allocated_cents:0,status:"due",due_at:"2026-01-01T00:00:00Z",currency:"USD"});
  await upsertDocument(ao.orgId,"payment_invoices",{id:"partner_invoice",data:{id:"partner_invoice",project_id:"invoice_project",invoice_number:"PARTNER-1",obligation_ids:["partner_due"],status:"due",total_cents:25000,currency:"USD"}});
  const resource={owner_org_id:ao.orgId,type:"invoice",id:"partner_invoice"};
  await a.request("POST",ar+"/shares",{resource,recipient_org_id:bo.orgId,operations:["read","invoice.read","invoice.pay"],fields:["invoice_number","balance_due_cents","currency"]});
  assert.equal((await b.request("POST",br+"/resources/checkout",resource)).online_available,false);
  const offline={resource,input:{amount_cents:1000,method:"check",paid_at:"2026-09-30T00:00:00Z",client_operation_id:"offline_once"}};
  const report=await b.request("POST",br+"/resources/offline-payment",offline);
  assert.equal(report.payment.status,"reported_paid");
  assert.equal((await b.request("POST",br+"/resources/offline-payment",offline)).payment.id,report.payment.id);
  assert.equal((await b.request("POST",br+"/resources/read",resource)).data.balance_due_cents,25000);
  await upsertMerchantConfig(ao.orgId,{provider:"mock",forward:{account_id:"mock_partner_account",boarding_status:"APPROVED",processing_enabled:true,enabled_rails:{card:true,bank:true}}});
  const config=await b.request("POST",br+"/resources/checkout",resource);
  assert.equal(config.online_available,true);assert.equal(config.saved_methods,undefined);
  const quote=await b.request("POST",br+"/resources/payment-quote",{resource,method:"card"});
  const token=await b.request("POST",br+"/resources/payment-method",{resource,input:{type:"card",card:{number:"4242424242424242",exp_month:12,exp_year:2030,cvc:"123"}}});
  const input={client_operation_id:"pay_once",payment_method_id:token.payment_method.id,method:"card",expected_total_cents:quote.total_cents,expected_invoice_revision:quote.invoice_revision};
  await assert.rejects(()=>b.request("POST",br+"/resources/pay",{resource,input:{...input,client_operation_id:"wrong_rail",method:"bank"}}),/payment_method_mismatch|does not match/);
  const results=await Promise.all([1,2].map(()=>b.request("POST",br+"/resources/pay",{resource,input})));
  assert.ok(results.some(result=>result.payment.status==="paid"),JSON.stringify(results));
  const replay=await b.request("POST",br+"/resources/pay",{resource,input});assert.equal(replay.payment.status,"paid");
  const payments=(await listDocuments(ao.orgId,"payment_transactions")).filter(p=>p.data.kind==="partner_invoice");assert.equal(payments.length,1);
  assert.equal((await b.request("POST",br+"/resources/read",resource)).data.balance_due_cents,0);
});


test("shared signatures use the verified account and recheck read access at acceptance",async()=>{
  const a=createSessionClient(),b=createSessionClient();
  const ao=await registerOwner(a),bo=await registerOwner(b);
  await enableExpandedPlatformFixture(ao.orgId,{"platform.documents":true,"documents.esign":true});
  await enableExpandedPlatformFixture(bo.orgId,{"platform.documents":true,"documents.esign":true});
  const storage=await import("../platform/storage.js");
  const user=await storage.readDocument(bo.orgId,"users",bo.ownerUserId),identity=await storage.readIdentity(String(user.data.identity_id));
  await storage.patchIdentity(String(identity.id),{metadata:{...identity.metadata as any,email_verified:true}});
  const ar=`/v1/collaboration/organizations/${ao.orgId}`,br=`/v1/collaboration/organizations/${bo.orgId}`;
  const inv=await a.request("POST",ar+"/invitations",{email:identity.email});
  await b.request("POST",br+"/invitations/accept",{token:inv.token});
  await storage.upsertDocument(ao.orgId,"projects",{id:"signed_partner_job",data:{title:"Partner agreement",contacts:[]}});
  const doc=await a.request("POST",`/v1/documents/organizations/${ao.orgId}/projects/signed_partner_job/documents`,{document_type:"contract",params:{body:"Partner scope agreement"}});
  const sent=await a.request("POST",`/v1/documents/organizations/${ao.orgId}/documents/${doc.document.id}/send`,{recipients:[{name:"Partner signer",email:identity.email,role:"customer"}],consent_contact:"support@example.test",include_portal:false,include_pdf:false,prepare_pdf:true});
  const resource={owner_org_id:ao.orgId,type:"document",id:doc.document.id};
  const share=(await a.request("POST",ar+"/shares",{resource,recipient_org_id:bo.orgId,operations:["read","documents.read","documents.respond"],fields:["title"],child_ids:[sent.snapshot.id]})).share;
  const info=await b.request("POST",br+"/resources/document",resource);
  assert.equal(info.signers.length,1);assert.equal(info.signers[0].email,undefined);
  const selection={snapshot_id:sent.snapshot.id,signer_id:info.signers[0].signer_id};
  const review=await b.request("POST",br+"/resources/signatures/prepare",{resource,input:selection});
  const input={...selection,field:info.signers[0].fields[0],value:{type:"typed",signer_name:"Partner signer"},content_hash:review.content_hash,challenge:review.challenge,consent:{intent:true,electronic_records:true,can_access_and_retain:true,disclosure_hash:review.disclosure.hash}};
  const deny=(await a.request("POST",ar+"/shares",{resource,recipient_org_id:bo.orgId,operations:["read"],denied_operations:["documents.read"],fields:["title"]})).share;
  assert.equal((await b.raw("POST",br+"/resources/signatures/accept",{resource,input})).statusCode,403);
  await a.request("POST",ar+`/shares/${deny.id}/revoke`,{expected_revision:deny.revision});
  const result=await b.request("POST",br+"/resources/signatures/accept",{resource,input});
  assert.ok(result.receipt.receipt_id);
  await a.request("POST",ar+`/shares/${share.id}/revoke`,{expected_revision:share.revision});
  assert.equal((await b.raw("POST",br+"/resources/document",resource)).statusCode,403);
});


test("shared channels exclude history and private audiences and deduplicate posts and events",async()=>{
  const a=createSessionClient(),b=createSessionClient();const ao=await registerOwner(a),bo=await registerOwner(b);
  await enableExpandedPlatformFixture(ao.orgId,{"apps.channels":true});await enableExpandedPlatformFixture(bo.orgId,{"apps.channels":true});
  const ar=`/v1/collaboration/organizations/${ao.orgId}`,br=`/v1/collaboration/organizations/${bo.orgId}`;
  const inv=await a.request("POST",ar+"/invitations",{}),claim=await b.request("POST",br+"/invitations/accept",{token:inv.token});
  await a.request("POST",ar+`/invitations/${inv.invitation.id}/approve`,{expected_revision:claim.invitation.revision});
  const channels=await import("../channels/storage.js");
  const channel=await channels.createChannelRecord({organization_id:ao.orgId,type:"public",name:"Joint project",created_by:ao.ownerUserId});
  await channels.upsertChannelMember({organization_id:ao.orgId,channel_id:channel.id,user_id:ao.ownerUserId,role:"owner"});
  await channels.createMessageRecord({organization_id:ao.orgId,channel_id:channel.id,author_id:ao.ownerUserId,text:"Old internal history"});
  const resource={owner_org_id:ao.orgId,type:"channel",id:channel.id};
  await a.request("POST",ar+"/shares",{resource,recipient_org_id:bo.orgId,operations:["read","messages.read","messages.post"],fields:["name"],include_future:true});
  const body={resource,input:{text:"Partner message",client_operation_id:"once"}};
  const posted=await b.request("POST",br+"/resources/messages",body);
  assert.equal((await b.request("POST",br+"/resources/messages",body)).id,posted.id);
  assert.equal((await b.raw("POST",br+"/resources/messages",{resource,input:{...body.input,text:"Changed"}})).statusCode,409);
  await channels.createMessageRecord({organization_id:ao.orgId,channel_id:channel.id,author_id:ao.ownerUserId,text:"Private audience",audience:[ao.ownerUserId]});
  const read=await b.request("POST",br+"/resources/messages/read",{resource});
  assert.deepEqual(read.items.map((m:any)=>m.text),["Partner message"]);
  assert.equal(read.items[0].author.phone,undefined);
  assert.equal(read.items[0].metadata,undefined);
  const {verifiedMessageContributor}=await import("../collaboration/service.js");
  assert.equal(await verifiedMessageContributor({id:"forged",client_msg_id:"forged",author_id:`external_${bo.orgId}_${bo.ownerUserId}`,metadata:{collaboration_actor:{organization_id:bo.orgId,user_id:bo.ownerUserId}}}),null);
  const stored=await channels.readMessageRecord(ao.orgId,posted.id);assert.ok(stored);
  assert.equal((await verifiedMessageContributor(stored!))?.organization_id,bo.orgId);
  const {collaborationStore}=await import("../collaboration/storage.js");
  assert.equal((await collaborationStore().prepare("SELECT id FROM collaboration_audit WHERE owner_org_id=? AND event_type=?").all(ao.orgId,"collaboration.message.posted")).length,1);
});


test("partner assignment eligibility, privacy, isolation and withdrawal",async()=>{
 const a=createSessionClient(),b=createSessionClient(),c=createSessionClient();
 const ao=await registerOwner(a),bo=await registerOwner(b),co=await registerOwner(c);
 const ar=`/v1/collaboration/organizations/${ao.orgId}`,br=`/v1/collaboration/organizations/${bo.orgId}`,cr=`/v1/collaboration/organizations/${co.orgId}`;
 const inv=await a.request("POST",ar+"/invitations",{relationship:"partner"});
 const claim=await b.request("POST",br+"/invitations/accept",{token:inv.token});
 await a.request("POST",ar+`/invitations/${inv.invitation.id}/approve`,{expected_revision:claim.invitation.revision});
 const rel=(await a.request("GET",ar+"/partners")).items[0],reverse=(await b.request("GET",br+"/partners")).items[0];
 const url=ar+`/partners/${rel.id}/assignments`,back=br+`/partners/${reverse.id}/assignments`;
 const {readWorkforceConfiguration,saveWorkforceConfiguration,createResourceGroup}=await import("../workforce/storage.js");
 const {listAssignableResources,resolveAssignableSubjects}=await import("../workforce/service.js");
 const {defaultAssignmentPolicy}=await import("../workforce/assignability.js");
 const bc=await readWorkforceConfiguration(bo.orgId);
 await saveWorkforceConfiguration(bo.orgId,{expected_revision:bc.revision,resource_group_kinds:[{id:"sales_team",name:"Sales teams"}]});
 const crew=await createResourceGroup(bo.orgId,{id:"same_group",name:"Private roof team",kind_id:"crew",member_user_ids:[bo.ownerUserId]});
 await createResourceGroup(bo.orgId,{id:"sales_group",name:"Secret sales team",kind_id:"sales_team"});
 assert.equal((await c.raw("GET",cr+`/partners/${rel.id}/assignments`)).statusCode,403);
 const initial=await a.request("GET",url);assert.equal(initial.available.groups.length,0);assert.equal(initial.available.organization,true);
 assert.equal((await listAssignableResources(ao.orgId,"default")).organization_connections.length,0);
 await b.request("PUT",back,{expected_revision:0,exposure:{organization:true,group_kind_ids:["crew"],group_ids:[crew.id],include_future:false,fields:[]}});
 const exposed=await a.request("GET",url);assert.deepEqual(exposed.available.groups,[{id:crew.id,kind_id:"crew",name:"Private roof team"}]);
 assert.equal(JSON.stringify(exposed.available).includes("Secret sales"),false);
 assert.equal((await a.raw("PUT",url,{expected_revision:0,mappings:[{local_kind_id:"crew",organization:true}]})).statusCode,400);
 assert.equal((await a.raw("PUT",url,{expected_revision:0,enable_kind_ids:["crew"],mappings:[{local_kind_id:"crew",organization:false,group_kind_ids:["sales_team"]}]})).statusCode,403);
 assert.notEqual((await readWorkforceConfiguration(ao.orgId)).resource_group_kinds.find((k:any)=>k.id==="crew")?.external_assignment,true);
 await a.request("PUT",url,{expected_revision:0,enable_kind_ids:["crew"],mappings:[{local_kind_id:"crew",organization:true,group_kind_ids:["crew"]}]});
 const catalog=await resolveAssignableSubjects(ao.orgId,"default",defaultAssignmentPolicy("project_work"));
 const external=catalog.organization_connections;assert.equal(external.length,2);assert.ok(external.some(s=>String(s.id).startsWith("external_")));
 assert.ok(external.every(s=>s.linked_organization_id===bo.orgId));
 const sales=await resolveAssignableSubjects(ao.orgId,"default",defaultAssignmentPolicy("sales_appointment"));assert.equal(sales.organization_connections.length,0);
 const {upsertDocument}=await import("../platform/storage.js");await upsertDocument(ao.orgId,"projects",{id:"external_team_job",data:{title:"Assigned team"}});
 const offer=(await a.request("POST",ar+"/engagements",{relationship_id:rel.id,project_id:"external_team_job",title:"Crew assignment",grant:{operations:["read"],fields:["title"]},client_operation_id:"team_offer"})).engagement;
 const accepted=(await b.request("PATCH",br+`/engagements/${offer.id}`,{expected_revision:offer.revision,status:"accepted"})).engagement;
 const schedule={expected_revision:accepted.revision,assignment_id:external.find(s=>String(s.id).startsWith("external_"))!.id,start_at:"2026-10-15T16:00:00Z",end_at:"2026-10-15T17:00:00Z",client_operation_id:"team_booking"};
 const booking=await a.request("POST",ar+`/engagements/${offer.id}/schedule`,schedule);assert.ok(booking.event_id);
 assert.equal((await a.raw("PUT",url,{expected_revision:0,mappings:[]})).statusCode,409);
 const ac=await readWorkforceConfiguration(ao.orgId);await saveWorkforceConfiguration(ao.orgId,{expected_revision:ac.revision,resource_group_kinds:[{id:"crew",name:"Crew",external_assignment:false}]});
 assert.equal((await listAssignableResources(ao.orgId,"default")).organization_connections.length,0);
 const ac2=await readWorkforceConfiguration(ao.orgId);await saveWorkforceConfiguration(ao.orgId,{expected_revision:ac2.revision,resource_group_kinds:[{id:"crew",name:"Crew",external_assignment:true}]});
 await b.request("PUT",back,{expected_revision:1,exposure:{organization:true,group_kind_ids:["crew"],group_ids:[crew.id],fields:["headcount","member_names"]}});
 const details=await a.request("GET",url);assert.equal(details.available.groups[0].headcount,1);assert.deepEqual(details.available.groups[0].member_names,["Payroll Owner"]);
 const privacy=await b.request("GET",br+"/privacy");await b.request("PUT",br+"/privacy",{expected_revision:privacy.revision,policy:{...privacy.policy,disclose_name:false}});
 assert.equal((await a.request("GET",url)).available.groups[0].member_names,undefined);
 await b.request("PUT",back,{expected_revision:2,exposure:{organization:false,group_kind_ids:[],group_ids:[],fields:[]}});
 assert.equal((await listAssignableResources(ao.orgId,"default")).organization_connections.length,0);
 assert.equal((await a.raw("POST",ar+`/engagements/${offer.id}/schedule`,{...schedule,client_operation_id:"withdrawn_booking"})).statusCode,403);
});
