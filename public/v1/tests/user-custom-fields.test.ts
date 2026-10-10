import test from "node:test";
import assert from "node:assert/strict";
import {mkdtemp,mkdir,writeFile,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {normalizeDefinitions} from "../custom_fields/contracts.js";
import {withoutUserFieldValues} from "../custom_fields/user-view.js";

test("user definitions and public user projections preserve the shared contract",()=>{
  assert.equal(normalizeDefinitions([{entity:"user",path:"employee_number",type:"integer"}])[0]!.entity,"user");
  const stored={name:"Ada",permissions:{manage_company_users:true},custom_fields:{secret:1},custom_field_values:{secret:1}};
  assert.deepEqual(withoutUserFieldValues(stored),{name:"Ada",permissions:{manage_company_users:true}});
  assert.equal(stored.custom_fields.secret,1);
});

test("user fields share organization definitions, validate storage and ownership, and publish with revisions",async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"user-fields-"));process.env.PLATFORM_STORAGE_ROOT=root;
  if(process.env.TEST_POSTGRES_URL)Object.assign(process.env,{FIRSTMATE_ENV:"test",FIRSTMEASURE_DATABASE_MODE:"postgres",DATABASE_URL:process.env.TEST_POSTGRES_URL,POSTGRES_POOL_MAX:"1",POSTGRES_AUTO_MIGRATE:"false",FIRSTMEASURE_ARTIFACT_STORAGE:"local"});
  const storage=await import("../platform/storage.js"),fields=await import("../custom_fields/records.js");
  const {systemPublicationContext}=await import("../platform/publication/context.js");
  const {readPublishedData}=await import("../platform/publication/providers.js");
  const {registerCustomFieldPublication}=await import("../custom_fields/publication.js");registerCustomFieldPublication();
  const org="user_fields_test",user="member";
  try{
    await storage.createOrganization({id:org,name:"User fields"});
    const defs=[{entity:"user",path:"employee_number",type:"integer",min:1},{entity:"user",path:"licenses",type:"array",schema:{items:{type:"object",properties:{name:{type:"string"}},required:["name"],additionalProperties:false}}},{entity:"user",path:"reference_photo",type:"photo"},{entity:"user",path:"private_note",type:"text",private:true},{entity:"user",path:"readonly",type:"text",read_only:true},{entity:"user",path:"manager",type:"organization_user"}];
    await storage.saveBranchModule(org,"default","custom_fields",{data:{fields:defs}},{replace:true});
    await assert.rejects(()=>storage.saveBranchModule(org,"east","custom_fields",{data:{fields:defs}},{replace:true}));
    for(const [id,owner] of [["portrait",user],["foreign","other"]]){
      const dir=path.join(root,"organizations",org,"media",id!);await mkdir(dir,{recursive:true});await writeFile(path.join(dir,"metadata.json"),JSON.stringify({id,owner:{type:"user",id:owner},content_type:"image/jpeg"}));
    }
    const permissions={manage_company_users:true};
    let saved=await storage.upsertDocument(org,"users",{id:user,data:{name:"Ada",branch_id:"east",permissions,role:"member",custom_field_values:{employee_number:7,licenses:[{name:"Roofing"}],reference_photo:{media_id:"portrait"},private_note:"private",readonly:"fixed"}}});
    assert.equal((await fields.definitions(org,"east","user",saved.data)).find(f=>f.path==="employee_number")!.entity,"user");
    for(const values of [{employee_number:1.5},{employee_number:0},{licenses:[{}]},{reference_photo:{media_id:"foreign"}},{manager:{subject_type:"organization_user",subject_id:"foreign"}}])await assert.rejects(()=>storage.upsertDocument(org,"users",{id:user,data:{custom_fields:values}}));
    saved=await storage.upsertDocument(org,"users",{id:user,data:{name:"Ada renamed",branch_id:"east",permissions,role:"member"}},{replace:true});
    assert.equal((saved.data.custom_fields as any).employee_number,7);
    assert.equal((saved.data.custom_fields as any).licenses[0].name,"Roofing");
    const ctx=systemPublicationContext({kind:"module",organizationId:org,operations:["custom-fields-user.contract","custom-fields-user.values","custom-fields.user.write"],mode:"command"});
    const target={scope:"organization" as const,organizationId:org,id:user};
    const result=await readPublishedData(ctx,{provider:"custom-fields-user",export:"values",target});
    assert.equal(result.status,"ready");assert.equal((result as any).value.employee_number,7);assert.equal((result as any).value.private_note,undefined);
    await assert.rejects(()=>fields.writeFields(ctx,target,"user",{values:{readonly:"changed"},expectedRevision:saved.revision}));
    await assert.rejects(()=>fields.authorizeRecordFieldMutation(ctx,"users",user,{data:{custom_fields:{private_note:"changed"}}}));
    await fields.writeFields(ctx,target,"user",{values:{employee_number:8},expectedRevision:saved.revision});
    await assert.rejects(()=>fields.writeFields(ctx,target,"user",{values:{employee_number:9},expectedRevision:saved.revision}));
    await assert.rejects(()=>fields.readFieldRecord(ctx,{...target,organizationId:"other"},"user"));
    await assert.rejects(()=>fields.readFieldRecord(ctx,{...target,id:"missing"},"user"));
    saved=await storage.readDocument(org,"users",user);
    assert.equal((saved.data.custom_fields as any).employee_number,8);assert.equal((saved.data.custom_fields as any).private_note,"private");
    assert.deepEqual(saved.data.permissions,permissions);assert.equal(saved.data.name,"Ada renamed");
    const denied=systemPublicationContext({kind:"module",organizationId:org,operations:["custom-fields-project.values"],mode:"evaluate"});
    assert.equal((await readPublishedData(denied,{provider:"custom-fields-user",export:"values",target})).status,"denied");
  }finally{await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
});
