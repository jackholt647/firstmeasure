import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test,{after} from "node:test";
import {closePlatformFixtureStores,enableExpandedPlatformFixture} from "./helpers/platform-fixture.js";

const dir=await mkdtemp(path.join(os.tmpdir(),"held-report-events-"));
Object.assign(process.env,{NODE_ENV:"test",PLATFORM_STORAGE_ROOT:path.join(dir,"platform"),FIRSTMEASURE_STORAGE_ROOT:path.join(dir,"firstmeasure"),FIRSTMEASURE_INDEX_DB_PATH:path.join(dir,"index.sqlite"),PRICEBOOK_STORAGE_ROOT:path.join(dir,"pricebook"),PLATFORM_HEARTBEAT_DISABLED:"1"});
after(async()=>{await closePlatformFixtureStores();await rm(dir,{recursive:true,force:true}).catch(()=>{});});

const org="org_held_events";
const pending={submission_status:"submitting",submission_failure:null};
const holding=()=>({delivery_hold_status:"holding",delivery:{release_hold:{status:"holding",reason:"vip_p2_release_window",scheduled_release_at:new Date(Date.now()+3600_000).toISOString()}}});

async function setup(){
 const s=await import("../platform/storage.js");
 if(await s.readOrganization(org).catch(()=>null))return;
 await s.createOrganization({id:org,name:"Held events"});
 await s.saveGlobal(org,{data:{app_flags:{platform:{expanded_access:true,materials:true}}}},{replace:false});
 await enableExpandedPlatformFixture(org,{"platform.materials":true,"platform.pricebook":true});
}
async function linkedReport(projectId:string,reportId:string){
 const s=await import("../platform/storage.js");const fm=await import("../firstmeasure/storage.js");
 await s.upsertDocument(org,"projects",{id:projectId,data:{measurement_project:{id:reportId}}});
 await fm.createProject({id:reportId,address:"10 Hold Street",organization_ref:{id:org}});
 await fm.saveStoredXml(reportId,`<FACE id="roof"><POLYGON size="300" pitch="6"/></FACE>`);
}
async function seen(projectId:string,reportId:string){
 const {listEventRecords}=await import("../work/storage.js");const s=await import("../platform/storage.js");
 const events=(await listEventRecords(org,{project_id:projectId,limit:500})).map(event=>String((event as {type?:unknown}).type));
 const datasets=(await s.listDocuments(org,"project_datasets")).filter(doc=>JSON.stringify(doc).includes(`firstmeasure:${reportId}`));
 return {completed:events.filter(type=>type==="measurement.report.completed").length,datasets:datasets.length};
}

// FM-383: a report is saved completed a moment before its delivery decides to hold it for its release window. While it
// is held the project must change in no way at all, so nothing that runs on delivery (the completed event behind the
// project's "Measurements received" status and the Feed, the measurements, the satellite photo) may run before release.
test("a QA completion that delivery then holds publishes nothing on the project until it is released",async()=>{
 await setup();await linkedReport("project_held","report_held");const fm=await import("../firstmeasure/storage.js");
 await fm.updateStatus("report_held","completed",pending);
 assert.deepEqual(await seen("project_held","report_held"),{completed:0,datasets:0},"completed, delivery not decided yet");
 await fm.patchManifest("report_held",holding());
 await fm.patchManifest("report_held",{submission_status:"submitted"});
 assert.deepEqual(await seen("project_held","report_held"),{completed:0,datasets:0},"held");
 const hold=(await fm.readManifest("report_held")).delivery as {release_hold:Record<string,unknown>};
 await fm.patchManifest("report_held",{delivery_hold_status:"released",delivery:{release_hold:{...hold.release_hold,status:"released"}}});
 assert.deepEqual(await seen("project_held","report_held"),{completed:1,datasets:1},"released");
 await fm.patchManifest("report_held",{submission_status:"submitted"});
 assert.equal((await seen("project_held","report_held")).completed,1,"published once");
});

test("a QA completion that is not held is received once its delivery has run",async()=>{
 await setup();await linkedReport("project_sent","report_sent");const fm=await import("../firstmeasure/storage.js");
 await fm.updateStatus("report_sent","completed",pending);
 assert.equal((await seen("project_sent","report_sent")).completed,0);
 await fm.patchManifest("report_sent",{submission_status:"submitted"});
 assert.deepEqual(await seen("project_sent","report_sent"),{completed:1,datasets:1});
});

test("a report completed without a delivery step is received at once, as before",async()=>{
 await setup();await linkedReport("project_direct","report_direct");const fm=await import("../firstmeasure/storage.js");
 await fm.updateStatus("report_direct","completed");
 assert.deepEqual(await seen("project_direct","report_direct"),{completed:1,datasets:1});
});

test("linking a project to a held report records the order only",async()=>{
 await setup();const fm=await import("../firstmeasure/storage.js");const {publishProjectReportLink}=await import("../firstmeasure/project-events.js");
 await linkedReport("project_link","report_link");
 await fm.updateStatus("report_link","completed",pending);await fm.patchManifest("report_link",{...holding(),submission_status:"submitted"});
 await publishProjectReportLink(org,"project_link",{},{measurement_project:{id:"report_link",status:"completed"}});
 const {listEventRecords}=await import("../work/storage.js");
 const types=(await listEventRecords(org,{project_id:"project_link"})).map(event=>String((event as {type?:unknown}).type));
 assert.deepEqual(types.filter(type=>type.startsWith("measurement.report.")),["measurement.report.ordered"]);
});
