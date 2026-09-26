import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeDefinitions, validateField, calculateFormula, validatePattern } from "../custom_fields/contracts.js";

test("field contracts validate integers, formats, nested arrays/dictionaries and bounded schemas", async () => {
  const field = normalizeDefinitions([{entity:"organization",path:"inventory",type:"array",schema:{items:{type:"object",properties:{quantity:{type:"integer",minimum:0},email:{type:"string",format:"email"}},required:["quantity","email"],additionalProperties:false}}}])[0]!;
  validateField(field,[{quantity:2,email:"a@example.com"}]);
  for (const v of [[{quantity:1.5,email:"a@example.com"}],[{quantity:2,email:"bad"}],[{quantity:2}],[{quantity:2,email:"a@example.com",unknown:true}]]) assert.throws(() => validateField(field,v));
  for (const [type,value] of [["integer",1.2],["date","2026-02-30"],["email","wrong"],["phone","hi"],["number","42"],["boolean","false"]]) assert.throws(() => validateField({type,path:"test"},value));
  validateField({type:"boolean",path:"test",required:true},false);
  validateField({type:"integer",path:"test",required:true},0);
  assert.throws(() => normalizeDefinitions([{path:"constructor.bad",type:"text"}]));
  assert.throws(() => normalizeDefinitions([{path:"a",type:"object"},{path:"a.b",type:"text"}]));
  assert.throws(() => normalizeDefinitions([{path:"a",type:"object",schema:{properties:{bad:{$ref:"https://example.com"}}}}]));
  await validatePattern({path:"code",pattern:"^[A-Z]{2}$"},"AB");
  await assert.rejects(() => validatePattern({path:"code",pattern:"^[A-Z]{2}$"},"no"));
  assert.equal(calculateFormula("{{count}} * (2 + 1)",() => 4),12);
  assert.throws(() => calculateFormula("1 / 0",() => 0));
});

test("custom fields publish all owners, enforce writes, reauthorize snapshots and retain unrelated values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),"custom-field-publication-"));
  process.env.PLATFORM_STORAGE_ROOT = path.join(root,"platform");
  process.env.PLATFORM_ACTIONS_DB_PATH = path.join(root,"actions.sqlite");
  process.env.NODE_ENV = "test";
  if (process.env.TEST_POSTGRES_URL) Object.assign(process.env,{FIRSTMATE_ENV:"test",FIRSTMEASURE_DATABASE_MODE:"postgres",DATABASE_URL:process.env.TEST_POSTGRES_URL,POSTGRES_POOL_MAX:"8",POSTGRES_AUTO_MIGRATE:"false",FIRSTMEASURE_ARTIFACT_STORAGE:"local"});
  const storage = await import("../platform/storage.js");
  const { registerCustomFieldPublication } = await import("../custom_fields/publication.js");
  const { systemPublicationContext } = await import("../platform/publication/context.js");
  const { readPublishedData, authorizeSourceSnapshot } = await import("../platform/publication/providers.js");
  const { invokeAction, closeActionDatabase } = await import("../platform/publication/actions.js");
  const { authorizeRecordFieldMutation } = await import("../custom_fields/records.js");
  registerCustomFieldPublication();
  const org = "org_custom_fields_test";
  const definitions = [
    {entity:"project",path:"count",type:"integer"},
    {entity:"project",path:"double",type:"formula",formula:"{{count}} * 2",read_only:true},
    {entity:"project",path:"locked",type:"text",read_only:true,background_only:true},
    {entity:"project",path:"secret",type:"text",private:true},
    {entity:"project",path:"details",type:"object",schema:{properties:{email:{type:"string",format:"email"}},additionalProperties:false}},
    {entity:"contact",path:"count",type:"integer"},
    {entity:"organization",path:"count",type:"integer"}
  ];
  try {
    await storage.createOrganization({id:org,name:"Fields"});
    await storage.saveBranchModule(org,"default","custom_fields",{data:{fields:definitions}},{replace:true});
    await storage.upsertDocument(org,"projects",{id:"project",data:{name:"Untouched",contacts:[{id:"embedded",name:"Contact",custom_field_values:{count:8}}],custom_field_values:{count:2,locked:"stored",secret:"restricted",details:{email:"a@example.com"},legacy_variable:9}}});
    await storage.upsertDocument(org,"customers",{id:"contact",data:{contact_custom_field_values:{count:3}}});
    const operations = ["project","contact","organization"].flatMap(entity => [`custom-fields-${entity}.contract`,`custom-fields-${entity}.values`,`custom-fields.${entity}.write`]);
    const ctx = systemPublicationContext({kind:"module",organizationId:org,operations,mode:"command"});
    const target = {scope:"project" as const,organizationId:org,projectId:"project"};
    const ref = {provider:"custom-fields-project",export:"values",target};
    const result = await readPublishedData(ctx,ref);
    assert.equal(result.status,"ready");
    if(result.status !== "ready") throw Error(JSON.stringify(result));
    assert.deepEqual(result.value,{count:2,double:4,locked:"stored",details:{email:"a@example.com"},legacy_variable:9});
    assert.equal((await readPublishedData(ctx,{...ref,args:{field:"secret"}})).status,"denied");
    assert.equal((await readPublishedData(ctx,{...ref,path:"/secret"})).status,"missing");
    const privileged = {...ctx,auth:{orgId:org,permissions:{"*":true},applicationAccess:{management:{enabled:true,permissions:{"*":true}}}}} as any;
    const privateRead = await readPublishedData(privileged,{...ref,args:{field:"secret"},path:"/secret"});
    assert.equal(privateRead.status,"ready"); if(privateRead.status === "ready") assert.equal(privateRead.value,"restricted");
    assert.equal((await readPublishedData(ctx,{...ref,target:{...target,organizationId:"other"}})).status,"denied");
    assert.equal((await readPublishedData(ctx,{...ref,target:{...target,id:"other"}})).status,"denied");
    const contact = await readPublishedData(ctx,{provider:"custom-fields-contact",export:"values",target:{scope:"organization",organizationId:org,id:"contact"}});
    assert.equal(contact.status,"ready"); if(contact.status === "ready") assert.deepEqual(contact.value,{count:3});
    const embeddedRef = {provider:"custom-fields-contact",export:"values",target:{...target,id:"embedded"}};
    const embedded = await readPublishedData(ctx,embeddedRef);
    assert.equal(embedded.status,"ready"); if (embedded.status === "ready") assert.deepEqual(embedded.value,{count:8});
    assert.equal((await readPublishedData(ctx,{...embeddedRef,target:{...target,id:"stranger"}})).status,"denied");
    const action = {action:"custom-fields.project.write",target};
    await assert.rejects(() => invokeAction(ctx,action,{values:{count:2.2},expectedRevision:1},{idempotencyKey:"bad-number"}));
    await assert.rejects(() => invokeAction(ctx,action,{values:{locked:"changed"},expectedRevision:1},{idempotencyKey:"readonly"}));
    await assert.rejects(() => invokeAction(ctx,action,{values:{details:{email:"bad"}},expectedRevision:1},{idempotencyKey:"nested-invalid"}));
    const change = {values:{count:7,details:{}},expectedRevision:1};
    await invokeAction(ctx,action,change,{idempotencyKey:"write"});
    await invokeAction(ctx,action,change,{idempotencyKey:"write"});
    const row = await storage.readDocument(org,"projects","project");
    assert.equal(row.revision,2); assert.equal(row.data.name,"Untouched");
    assert.deepEqual((row.data.custom_field_values as any).details,{});
    await assert.rejects(() => invokeAction(ctx,action,{values:{count:8},expectedRevision:1},{idempotencyKey:"stale"}));
    await assert.rejects(() => storage.upsertDocument(org,"projects",{id:"project",data:{custom_field_values:{count:1.2}}}));
    await assert.rejects(() => storage.upsertDocument(org,"customers",{id:"contact",data:{contact_custom_field_values:{count:1.2}}}));
    await assert.rejects(() => authorizeRecordFieldMutation(ctx,"projects","project",{data:{custom_field_values:{locked:"bad"}}}));
    await assert.rejects(() => storage.upsertDocument(org,"projects",{id:"project",data:{contacts:[{id:"embedded",custom_field_values:{count:1.5}}]}}));
    await invokeAction(ctx,{action:"custom-fields.contact.write",target:{...target,id:"embedded"}},{values:{count:11},expectedRevision:2},{idempotencyKey:"embedded-write"});
    assert.equal(((await storage.readDocument(org,"projects","project")).data.contacts as any[])[0].custom_field_values.count,11);
    const concurrent = await Promise.allSettled([12,13].map((count,i) => invokeAction(ctx,action,{values:{count},expectedRevision:3},{idempotencyKey:`concurrent-${i}`})));
    assert.equal(concurrent.filter(r => r.status === "fulfilled").length,1);
    await storage.upsertDocument(org,"projects",{id:"project",data:{custom_fields:{count:19}}});
    const compatibility = await storage.readDocument(org,"projects","project");
    assert.equal((compatibility.data.custom_field_values as any).count,19);
    assert.equal((compatibility.data.custom_fields as any).locked,"stored");
    const orgTarget = {scope:"organization" as const,organizationId:org};
    const orgRef = {provider:"custom-fields-organization",export:"contract",target:orgTarget};
    const before = await readPublishedData(ctx,orgRef); assert.equal(before.status,"ready");
    await assert.rejects(() => storage.readDocument(org,"organization_custom_fields","values")); // read never creates
    await invokeAction(ctx,{action:"custom-fields.organization.write",target:orgTarget},{values:{count:5},expectedRevision:0},{idempotencyKey:"org-write"});
    assert.equal((await storage.readDocument(org,"organization_custom_fields","values")).revision,1);
    await storage.saveBranchModule(org,"default","custom_fields",{data:{fields:definitions.map(f => f.path === "count" && f.entity === "project" ? {...f,private:true} : f)}},{replace:true});
    await assert.rejects(() => authorizeSourceSnapshot(ctx,ref,result),/accessible/);
    await storage.saveBranchModule(org,"default","custom_fields",{data:{fields:definitions.filter(f => f.path !== "secret")}},{replace:true});
    assert.equal((await readPublishedData(ctx,{...ref,args:{field:"secret"}})).status,"denied", "Deleting a definition must not turn private stored values into public inferred fields.");
  } finally {
    await closeActionDatabase();
    if(process.env.TEST_POSTGRES_URL) { await (await import("../platform/sql_store.js")).closeSqlStoresForTests(); await (await import("../src/database/postgres.js")).closePostgresPools(); }
    await rm(root,{recursive:true,force:true});
  }
});
