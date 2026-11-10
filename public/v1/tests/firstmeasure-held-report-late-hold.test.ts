import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test,{after} from "node:test";
import {closePlatformFixtureStores,enableExpandedPlatformFixture} from "./helpers/platform-fixture.js";

const dir=await mkdtemp(path.join(os.tmpdir(),"publication-held-late-"));
Object.assign(process.env,{NODE_ENV:"test",PLATFORM_STORAGE_ROOT:path.join(dir,"platform"),FIRSTMEASURE_STORAGE_ROOT:path.join(dir,"firstmeasure"),FIRSTMEASURE_INDEX_DB_PATH:path.join(dir,"index.sqlite"),PRICEBOOK_STORAGE_ROOT:path.join(dir,"pricebook"),PLATFORM_HEARTBEAT_DISABLED:"1"});
after(async()=>{await closePlatformFixtureStores();await rm(dir,{recursive:true,force:true}).catch(()=>{});});

// FM-383: completion publishes the report's dataset a moment before delivery decides to hold it. Until the release the
// project must read exactly as it did while the report was on order, or the rail swaps its "on order" status for the
// 3D model, whose held report then says there is no completed report.
test("a report held just after completion published its measurements reads as on order until it is released",async()=>{
 const s=await import("../platform/storage.js");const fm=await import("../firstmeasure/storage.js");
 const {systemPublicationContext}=await import("../platform/publication/context.js");
 const {effectiveProjectMeasurements}=await import("../platform/publication/firstmeasure-datasets.js");
 const {listProjectDatasets,readProjectDataset}=await import("../platform/publication/datasets.js");
 const {readManualMeasurements}=await import("../platform/publication/manual-measurements.js");
 const org="org_held_late",target={scope:"project" as const,organizationId:org,projectId:"project_late"};
 await s.createOrganization({id:org,name:"Held late"});
 await s.saveGlobal(org,{data:{app_flags:{platform:{expanded_access:true,materials:true}}}},{replace:false});
 await enableExpandedPlatformFixture(org,{"platform.materials":true,"platform.pricebook":true});
 await s.upsertDocument(org,"projects",{id:"project_late",data:{measurement_project:{id:"report_late"}}});
 await fm.createProject({id:"report_late",address:"10 Hold Street",organization_ref:{id:org}});
 await fm.saveStoredXml("report_late",`<FACE id="roof"><POLYGON size="300" pitch="6"/></FACE>`);
 const ctx=systemPublicationContext({kind:"module",organizationId:org,projectId:"project_late",operations:["datasets.value","measurement-schemas.manual"]});
 await fm.patchManifest("report_late",{status:"completed"});
 const published=await effectiveProjectMeasurements(ctx,"project_late");
 assert.equal(published.status,"ready");const datasetId=String((published as {datasetId:string}).datasetId);
 assert.equal((await readManualMeasurements(ctx,"project_late")).in_use.source,"report");
 const hold={status:"holding",reason:"vip_p2_release_window",scheduled_release_at:new Date(Date.now()+3600_000).toISOString()};
 await fm.patchManifest("report_late",{delivery_hold_status:"holding",delivery:{release_hold:hold}});
 // Held: no dataset, nothing selected, and the stored one answers like one that does not exist.
 assert.equal((await effectiveProjectMeasurements(ctx,"project_late")).status,"missing");
 assert.deepEqual(await listProjectDatasets(ctx,target),[]);
 await assert.rejects(readProjectDataset(ctx,{...target,id:datasetId}),(error:{statusCode?:number;code?:string})=>error.statusCode===404&&error.code==="not_found");
 assert.deepEqual((await readManualMeasurements(ctx,"project_late")).in_use,{source:"none",dataset_id:"",values:{}});
 await fm.patchManifest("report_late",{delivery_hold_status:"released",delivery:{release_hold:{...hold,status:"released"}}});
 const released=await effectiveProjectMeasurements(ctx,"project_late");
 assert.equal(released.status,"ready");assert.equal((released as {datasetId:string}).datasetId,datasetId);
 assert.equal((await readManualMeasurements(ctx,"project_late")).in_use.source,"report");
});
