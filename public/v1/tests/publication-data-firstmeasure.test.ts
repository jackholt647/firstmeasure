import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("completed reports publish linked same-organization measurements and preserve overrides on XML correction",async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"publication-report-"));
 process.env.NODE_ENV="test";process.env.PLATFORM_STORAGE_ROOT=path.join(dir,"platform");process.env.FIRSTMEASURE_STORAGE_ROOT=path.join(dir,"firstmeasure");process.env.FIRSTMEASURE_INDEX_DB_PATH=path.join(dir,"index.sqlite");
 const s=await import("../platform/storage.js");const fm=await import("../firstmeasure/storage.js");
 const {systemPublicationContext}=await import("../platform/publication/context.js");const d=await import("../platform/publication/datasets.js");
 const {effectiveProjectMeasurements}=await import("../platform/publication/firstmeasure-datasets.js");
 try{
  await s.createOrganization({id:"org_projection",name:"Report projection"});
  await s.upsertDocument("org_projection","projects",{id:"project_projection",data:{measurement_project:{id:"report_projection"}}});
  await fm.createProject({id:"report_projection",address:"123 Test Street",organization_ref:{id:"org_projection"}});
  const xml=(area:number)=>`<FACE id="roof"><POLYGON size="${area}" pitch="6"/></FACE>`;
  await fm.saveStoredXml("report_projection",xml(200));
  await fm.updateStatus("report_projection","completed");
  const ctx=systemPublicationContext({kind:"module",organizationId:"org_projection",projectId:"project_projection",operations:["datasets.value","datasets.save"],mode:"command"});
  const first=await effectiveProjectMeasurements(ctx,"project_projection");assert.equal(first.status,"ready");assert.ok(first.datasetId);
  const target={scope:"project" as const,organizationId:"org_projection",projectId:"project_projection",id:first.datasetId!};
  const record=await d.readProjectDataset(ctx,target);
  assert.equal((record.value as any).measurements.roofSquares.value,2);
  await d.saveProjectDataset(ctx,target,{name:record.name,type:"measurements",schemaVersion:"1",expectedRevision:record.storeRevision,value:record.value,overrides:{roofSquares:{value:3,unit:"roofing_square",source:"manual"}},provenance:record.provenance});
  await fm.saveStoredXml("report_projection",xml(400));
  const next=await effectiveProjectMeasurements(ctx,"project_projection");assert.equal((next.value as any).measurements.roofSquares.value,3);assert.equal((next.value as any).measurements.roofArea.value,400);
  const historic=await d.readProjectDataset(ctx,target,first.revision);assert.equal((historic.value as any).measurements.roofArea.value,200);

  const exteriorId="exteriors_"+"a".repeat(32);
  await s.upsertDocument("org_projection","projects",{id:"exterior_project",data:{measurement_project:{id:exteriorId}}});
  await fm.createProject({id:exteriorId,address:"456 Test Street",organization_ref:{id:"org_projection"},measurement_scope:"full_house"},{customerExteriors:true});
  await fm.savePdfState(exteriorId,{exteriorReport:{version:1,units:"ft",totals:{gross:500,net:450}}});
  await fm.updateStatus(exteriorId,"completed");
  const exteriorContext=systemPublicationContext({kind:"module",organizationId:"org_projection",projectId:"exterior_project",operations:["datasets.value"]});
  const exterior=await effectiveProjectMeasurements(exteriorContext,"exterior_project");
  assert.equal(exterior.status,"ready");assert.equal((exterior.value as any).measurements.wallNetArea.value,450);
 }finally{await (await import("../firstmeasure/project_index.js")).closeFirstMeasureProjectIndex();await rm(dir,{recursive:true,force:true});}
});


test("saved exterior quantities and instant estimates carry explicit units without fabricating unavailable fields",async()=>{
 const {measurementPayloadFromExterior,measurementPayloadFromInstant}=await import("../platform/publication/firstmeasure-datasets.js");
 const ext=measurementPayloadFromExterior({version:1,units:"ft",totals:{gross:150,net:125,openingArea:25,outside:30}},"exteriors_test");
 assert.deepEqual(ext.measurements.wallNetArea,{value:125,unit:"ft2",source:"firstmeasure.exterior"});
 assert.equal(ext.measurements.wallTopLf,undefined);
 assert.deepEqual(measurementPayloadFromExterior({version:1,units:"m",totals:{net:125}},"x").measurements,{});
 const instant=measurementPayloadFromInstant({id:"instant_test",lat:35,lng:-90,pins:[],instant_enabled:true} as any,{center:{latitude:35,longitude:-90},solarPotential:{wholeRoofStats:{areaMeters2:92.90304}}});
 assert.ok(Math.abs(instant.measurements.roofArea!.value-1000)<0.00001);
 assert.equal(instant.measurements.roofArea!.source,"firstmeasure.instant");
 assert.equal(instant.measurements.eavesLf,undefined);
});
