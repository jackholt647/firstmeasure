import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("a report held for its release window publishes no measurements until it is released",async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),"publication-held-"));
 process.env.NODE_ENV="test";process.env.PLATFORM_STORAGE_ROOT=path.join(dir,"platform");process.env.FIRSTMEASURE_STORAGE_ROOT=path.join(dir,"firstmeasure");process.env.FIRSTMEASURE_INDEX_DB_PATH=path.join(dir,"index.sqlite");
 const s=await import("../platform/storage.js");const fm=await import("../firstmeasure/storage.js");
 const {systemPublicationContext}=await import("../platform/publication/context.js");
 const {effectiveProjectMeasurements}=await import("../platform/publication/firstmeasure-datasets.js");
 try{
  await s.createOrganization({id:"org_held",name:"Held report"});
  await s.upsertDocument("org_held","projects",{id:"project_held",data:{measurement_project:{id:"report_held"}}});
  await fm.createProject({id:"report_held",address:"9 Hold Street",organization_ref:{id:"org_held"}});
  await fm.saveStoredXml("report_held",`<FACE id="roof"><POLYGON size="300" pitch="6"/></FACE>`);
  const hold={status:"holding",reason:"vip_p2_release_window",scheduled_release_at:new Date(Date.now()+3600_000).toISOString()};
  await fm.patchManifest("report_held",{status:"completed",delivery_hold_status:"holding",delivery:{release_hold:hold}});
  const ctx=systemPublicationContext({kind:"module",organizationId:"org_held",projectId:"project_held",operations:["datasets.value"]});
  assert.equal((await effectiveProjectMeasurements(ctx,"project_held")).status,"missing");
  await fm.patchManifest("report_held",{delivery_hold_status:"released",delivery:{release_hold:{...hold,status:"released"}}});
  assert.equal((await effectiveProjectMeasurements(ctx,"project_held")).status,"ready");
 }finally{await rm(dir,{recursive:true,force:true});}
});
