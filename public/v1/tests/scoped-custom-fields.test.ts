import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeDefinitions, validateField } from "../custom_fields/contracts.js";
import { FIELD_OWNERS } from "../custom_fields/owners.js";

test("the owner catalog and producer-owned phone contracts are shared",()=>{
  assert.deepEqual(Object.keys(FIELD_OWNERS),["project","contact","organization","user","branch","department","division","team"]);
  for(const entity of Object.keys(FIELD_OWNERS)) assert.equal(normalizeDefinitions([{entity,path:"notes",type:"text"}])[0]!.entity,entity);
  const field=normalizeDefinitions([{entity:"user",path:"lines",type:"platform_phone",cardinality:"many",read_only:false}])[0]!;
  assert.equal(field.read_only,true);assert.equal(field.producer,"phone-system");assert.equal(field.base_type,"phone");
  validateField(field,[{phone_number:"+12065550123",issuance_id:"issued-1"}]);
  for(const value of [["+12065550123"],[{phone_number:"+12065550123"}],[{phone_number:"invalid",issuance_id:"1"}]]) assert.throws(()=>validateField(field,value));
  assert.throws(()=>normalizeDefinitions([{entity:"user",path:"line",type:"platform_phone",default_value:{phone_number:"+12065550123",issuance_id:"1"}}]));
});

test("grouping fields use existing owners, independent revisions, and phone issuance authority",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"scope-fields-"));process.env.PLATFORM_STORAGE_ROOT=root;
  if(process.env.TEST_POSTGRES_URL) Object.assign(process.env,{FIRSTMATE_ENV:"test",FIRSTMEASURE_DATABASE_MODE:"postgres",DATABASE_URL:process.env.TEST_POSTGRES_URL,POSTGRES_POOL_MAX:"1",POSTGRES_AUTO_MIGRATE:"false",FIRSTMEASURE_ARTIFACT_STORAGE:"local"});
  const storage=await import("../platform/storage.js"),records=await import("../custom_fields/records.js");
  const {systemPublicationContext}=await import("../platform/publication/context.js");
  const {readPublishedData,authorizeSourceSnapshot}=await import("../platform/publication/providers.js");
  const {registerCustomFieldPublication}=await import("../custom_fields/publication.js");registerCustomFieldPublication();
  const phones=await import("../custom_fields/platform-phone.js");
  const org="scoped_fields_test";
  try {
    await storage.createOrganization({id:org,name:"Scoped fields"});
    await storage.upsertDocument(org,"branch",{id:"east",data:{name:"East"}});
    await storage.upsertDocument(org,"organization_departments",{id:"catalog",data:{departments:[{id:"sales",label:"Sales"}],groups:[],divisions:[{id:"north",label:"North",kind:"Region"}]}});
    const workforce=await import("../workforce/storage.js");
    const team=await workforce.createResourceGroup(org,{name:"Field crew",branch_id:"east"});
    const owners={branch:"east",department:"sales",division:"north",team:team.id};
    await storage.saveBranchModule(org,"default","custom_fields",{data:{fields:[...Object.keys(owners).map(entity=>({entity,path:"priority",type:"integer"})),{entity:"user",path:"lines",type:"platform_phone",cardinality:"many"},{entity:"user",path:"external",type:"phone"}]}},{replace:true});
    for(const [entity,id] of Object.entries(owners)) {
      const ctx=systemPublicationContext({kind:"module",organizationId:org,operations:[`custom-fields-${entity}.contract`,`custom-fields-${entity}.values`,`custom-fields.${entity}.write`],mode:"command"});
      const target={scope:"organization" as const,organizationId:org,id:String(id)};
      const contract=await readPublishedData(ctx,{provider:`custom-fields-${entity}`,export:"contract",target});
      assert.equal(contract.status,"ready");assert.equal((contract as any).value.recordRevision,0);
      assert.equal((await storage.listDocuments(org,"resource_custom_fields")).length,Object.keys(owners).indexOf(entity));
      await records.writeFields(ctx,target,entity as any,{values:{priority:3},expectedRevision:0});
      await assert.rejects(()=>records.writeFields(ctx,target,entity as any,{values:{priority:4},expectedRevision:0}));
      const value=await readPublishedData(ctx,{provider:`custom-fields-${entity}`,export:"values",target});assert.equal((value as any).value.priority,3);
      await assert.rejects(()=>records.readFieldRecord(ctx,{...target,id:"missing"},entity as any));
      await assert.rejects(()=>records.readFieldRecord(ctx,{...target,organizationId:"foreign"},entity as any));
    }
    await storage.upsertDocument(org,"users",{id:"member",data:{name:"Ada",custom_field_values:{external:"+12065550111"}}});
    const ctx=systemPublicationContext({kind:"module",organizationId:org,operations:["custom-fields-user.values","custom-fields-user.phones","custom-fields.user.write"],mode:"command"});
    const target={scope:"organization" as const,organizationId:org,id:"member"};
    const communication=await import("../messaging/communications_storage.js");
    await communication.claimPhoneNumberOwnership({organization_id:org,phone_number:"+12065550123",provider_phone_number_id:"issued-1",status:"active"});
    const ref={phone_number:"+12065550123",issuance_id:"issued-1"};
    await assert.rejects(()=>storage.upsertDocument(org,"users",{id:"member",data:{custom_fields:{lines:[ref]}}}));
    await assert.rejects(()=>records.writeFields(ctx,target,"user",{values:{lines:[ref]},expectedRevision:1}));
    await assert.rejects(()=>phones.setPlatformPhoneField(ctx,target,"user","lines",[ref],1));
    // Only server phone-domain code has this capability; neither HTTP nor a
    // generic module operation grant can populate or remove the managed value.
    const phoneCtx={...ctx,system:undefined,auth:{orgId:org,userId:"manager",role:"member",permissions:{manage_communications:true,manage_company_users:true},applicationAccess:{management:{enabled:true,permissions:{"*":true}}}}} as any;
    const {invokeAction}=await import("../platform/publication/actions.js");
    const action={action:"platform-phones.user.assignment.set",target};
    const input={field:"lines",phoneNumbers:[ref.phone_number],expectedRevision:1};
    const assigned=await invokeAction(phoneCtx,action,input,{idempotencyKey:"assign-line"});assert.equal(assigned.receipt.status,"succeeded");
    assert.equal((await invokeAction(phoneCtx,action,input,{idempotencyKey:"assign-line"})).receipt.status,"succeeded");
    phoneCtx.auth.permissions.manage_company_users=false;
    await assert.rejects(()=>invokeAction(phoneCtx,action,input,{idempotencyKey:"assign-line"}));
    phoneCtx.auth.permissions.manage_company_users=true;
    const published=await readPublishedData(ctx,{provider:"custom-fields-user",export:"phones",target});
    assert.equal(published.status,"ready");assert.equal((published as any).value.find((p:any)=>p.type === "platform_phone").available,true);
    for(const values of [{lines:[]},{lines:null},{lines:[{...ref,issuance_id:"forged"}]}]) await assert.rejects(()=>storage.upsertDocument(org,"users",{id:"member",data:{custom_fields:values}}));
    await storage.upsertDocument(org,"users",{id:"member",data:{name:"Renamed"}},{replace:true});
    assert.deepEqual((await storage.readDocument(org,"users","member")).data.custom_field_values,{external:"+12065550111",lines:[ref]});
    await communication.releasePhoneNumberOwnership(ref.phone_number,org,true);
    assert.equal((await phones.resolvePlatformPhone(org,ref)).available,false);
    await assert.rejects(()=>authorizeSourceSnapshot(ctx,{provider:"custom-fields-user",export:"phones",target},published as any));
    await communication.claimPhoneNumberOwnership({organization_id:org,phone_number:ref.phone_number,provider_phone_number_id:"reissued-2",status:"active"});
    assert.equal((await phones.resolvePlatformPhone(org,ref)).available,false);
    const unavailable=await readPublishedData(ctx,{provider:"custom-fields-user",export:"phones",target});assert.equal((unavailable as any).value.find((p:any)=>p.type === "platform_phone").available,false);
    const member=await storage.readDocument(org,"users","member");
    await phones.setPlatformPhoneField(phoneCtx,target,"user","lines",[],member.revision);
    await assert.rejects(()=>storage.saveBranchModule(org,"default","custom_fields",{data:{fields:[{entity:"user",path:"lines",type:"text"}]}},{replace:true}));
  } finally {await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
