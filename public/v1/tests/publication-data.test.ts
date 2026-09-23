import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("data publications distinguish status, enforce schema/grants, retain dataset revisions and override provenance",async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),"publication-data-"));
 process.env.PLATFORM_STORAGE_ROOT=path.join(root,"platform");process.env.NODE_ENV="test";
 const {systemPublicationContext}=await import("../platform/publication/context.js");
 const {registerDataProvider,readPublishedData,listPublishedData,authorizeSourceSnapshot}=await import("../platform/publication/providers.js");
 const {saveProjectDataset,readProjectDataset,registerDatasetProvider}=await import("../platform/publication/datasets.js");
 const {createOrganization,upsertDocument}=await import("../platform/storage.js");
 try{
  const target={scope:"project" as const,organizationId:"org_data_test",projectId:"project_test"};
  const ctx=systemPublicationContext({kind:"module",organizationId:target.organizationId,projectId:target.projectId,operations:["test-data.value","test-data.pending","test-data.invalid","datasets.save","datasets.value","documents.params"],mode:"command"});
  const access={scopes:["project"] as const,permissions:[],systemKinds:["module"] as const};
  const mutableSchema={type:"array",items:{type:"number"}};
  registerDataProvider({id:"test-data",version:"1",apps:[],exports:{value:{schema:mutableSchema,schemaVersion:"1",description:"test",access,read:async()=>({value:[]}),list:async()=>({items:["invalid"]})},pending:{schema:{type:"number"},schemaVersion:"1",description:"test",access,read:async()=>({status:"pending",code:"waiting",message:"Waiting"})},invalid:{schema:{type:"number"},schemaVersion:"1",description:"test",access,read:async()=>({value:"wrong"})}}});
  mutableSchema.items.type="string";
  const ref={provider:"test-data",export:"value",target};
  assert.equal((await readPublishedData(ctx,ref)).status,"ready");
  assert.equal((await readPublishedData(ctx,{...ref,export:"pending"})).status,"pending");
  assert.equal((await readPublishedData(ctx,{...ref,export:"invalid"})).status,"error");
  assert.equal((await readPublishedData(ctx,{...ref,export:"constructor"})).status,"error");
  assert.equal((await readPublishedData(ctx,{...ref,target:{...target,organizationId:"other"}})).status,"denied");
  assert.equal((await readPublishedData({...ctx,system:{...ctx.system!}},ref)).status,"denied");
  assert.equal((await readPublishedData(ctx,{...ref,path:"/0"})).status,"missing");
  assert.equal((await readPublishedData(ctx,{...ref,revision:"old"})).status,"error");
  assert.equal((await listPublishedData(ctx,ref)).status,"error");
  await createOrganization({id:target.organizationId,name:"Publication test"});
  await upsertDocument(target.organizationId,"projects",{id:target.projectId,data:{name:"Test"}});
  const first=await saveProjectDataset(ctx,target,{name:"Roof",type:"measurements",schemaVersion:"1",value:{measurements:{area:{value:120,unit:"ft2"}}},overrides:{area:{value:125,unit:"ft2",source:"manual"}},provenance:{producer:"firstmeasure",reportId:"report1"}});
  const selected={...target,id:first.id};
  const second=await saveProjectDataset(ctx,selected,{name:"Roof",type:"measurements",schemaVersion:"1",expectedRevision:first.storeRevision,value:{measurements:{area:{value:140,unit:"ft2"}}},provenance:{producer:"firstmeasure",reportId:"report2"}});
  const current=await readProjectDataset(ctx,selected);assert.equal((current.value as any).measurements.area.value,125);
  const old=await readProjectDataset(ctx,selected,first.revision);assert.equal(old.provenance.reportId,"report1");assert.equal(old.revision,first.revision);assert.notEqual(second.revision,first.revision);
  await assert.rejects(()=>saveProjectDataset(ctx,selected,{name:"Roof",type:"measurements",schemaVersion:"1",expectedRevision:first.storeRevision,value:{measurements:{}}}),/revision/i);
  await assert.rejects(()=>saveProjectDataset(ctx,target,{name:"No units",type:"measurements",schemaVersion:"1",value:{measurements:{area:{value:12}}}}),/schema/i);
  const {registerBuiltinDataProviders}=await import("../platform/publication/provider-adapters.js");
  registerBuiltinDataProviders();
  const doc=await upsertDocument(target.organizationId,"documents",{id:"doc_test",data:{project_id:target.projectId,params:{hours:8,privateNotes:"hidden"},publication:{params:["hours"]}}});
  const docRef={provider:"documents",export:"params",target:{...target,id:doc.id},path:"/hours"};
  const captured=await readPublishedData(ctx,docRef);assert.equal(captured.status,"ready");
  if(captured.status!=="ready")throw Error("expected capture");
  assert.equal(captured.value,8);assert.deepEqual(captured.provenance.publishedKeys,["hours"]);
  await authorizeSourceSnapshot(ctx,docRef,captured);
  await upsertDocument(target.organizationId,"documents",{id:doc.id,data:{project_id:target.projectId,params:{hours:9},publication:{params:[]}}});
  await assert.rejects(()=>authorizeSourceSnapshot(ctx,docRef,captured),/no longer published/);

  const published=await readPublishedData(ctx,{provider:"datasets",export:"value",target:selected,revision:first.revision});assert.equal(published.status,"ready");
  const listing=await listPublishedData(ctx,{provider:"datasets",export:"value",target},{limit:1});assert.equal(listing.status,"ready");
  const {measurementPayloadFromRoofplan}=await import("../platform/publication/firstmeasure-datasets.js");
  const converted=measurementPayloadFromRoofplan('<POINT id="a" data="0,0,0"/><POINT id="b" data="3,4,0"/><LINE id="l" type="RIDGE" path="a,b"/><FACE id="f"><POLYGON size="200" pitch="6"/></FACE>',"r1");
  assert.equal(converted.measurements.ridgesLf?.value,5);assert.equal(converted.measurements.ridgesLf?.unit,"ft");assert.equal(converted.measurements.roofSquares?.value,2);
  const invalid=measurementPayloadFromRoofplan('<POINT id="a" data="bad,0,0"/><POINT id="b" data="3,4,0"/><LINE id="l" type="RIDGE" path="a,b"/><FACE id="f"><POLYGON size="bad"/></FACE>',"r2");
  assert.deepEqual(invalid.measurements,{});
 }finally{await rm(root,{recursive:true,force:true});}
});
