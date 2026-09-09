import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("manual QA reservations persist, enforce ownership, and clear at terminal state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qa-manual-reservation-"));
  Object.assign(process.env, {
    FIRSTMATE_ENV:"test", FIRSTMEASURE_DATABASE_MODE:"sqlite", FIRSTMEASURE_STORAGE_ROOT:root,
    FIRSTMEASURE_INDEX_DB_PATH:path.join(root,"index.sqlite"), INTERNAL_STORAGE_ROOT:path.join(root,"internal"),
    PLATFORM_STORAGE_ROOT:path.join(root,"platform"), CRM_STORAGE_ROOT:path.join(root,"crm"),
    FIRSTMEASURE_JOB_WORKERS:"0", PLATFORM_HEARTBEAT_DISABLED:"1"
  });
  const { buildApp } = await import("../src/app.js");
  const storage = await import("../firstmeasure/storage.js");
  const internal = await import("../internal/storage.js");
  const index = await import("../firstmeasure/project_index.js");
  const app = await buildApp();
  await app.ready();
  try {
    const identities: Record<string, { cookie:string; csrf:string }> = {};
    for (const [name,role] of [["manager","manager"],["qa","qa"],["other","qa"],["tech","technician"]]) {
      const email = name+"@example.test";
      const response = await app.inject({method:"POST",url:"/v1/platform/auth/register",payload:{email,password:"test-strong-password-169",name,phone:"+1 555 100 200"+Object.keys(identities).length}});
      assert.equal(response.statusCode,201,response.body);
      const cookie = String(response.headers["set-cookie"]).match(/fm_platform_session=[^;,]+/)?.[0] || "";
      const session = await app.inject({method:"GET",url:"/v1/platform/auth/session",headers:{cookie}});
      identities[name!] = {cookie,csrf:session.json().csrf_token};
      await internal.saveInternalUser({ email,name,role,status:"active",training_complete:true,permissions:role==="qa"?{manage_qa:true}:{} });
    }
    const actor = (name:string) => ({email:name+"@example.test",name});
    const headers = (name:string) => ({cookie:identities[name]!.cookie,"x-platform-csrf":identities[name]!.csrf});
    const save = async (id:string,extra:Record<string,unknown>={}) => {
      await storage.saveManifest(id, {id,schema_version:2,status:"awaiting_review",address:id,
        priority_level:3,workflow:{history:[{event:"existing"}],custom:"preserved"},
        timestamps:{created_at:new Date().toISOString()},...extra} as any);
      await storage.saveStoredPdf(id,"main",Buffer.from("%PDF-1.4\nfixture\n%%EOF"));
    };
    await save("reserved");
    const reserve = (name:string,target:string|null,extraHeaders={}) => app.inject({
      method:"POST",url:"/v1/firstmeasure/projects/reserved/qa/reservation",
      headers:{...headers(name),...extraHeaders},payload:{actor:actor("manager"),reserved_for:target?actor(target):null}
    });
    const unauth = await app.inject({method:"POST",url:"/v1/firstmeasure/projects/reserved/qa/reservation",payload:{actor:actor("manager"),reserved_for:actor("qa")}});
    assert.equal(unauth.statusCode,401);
    assert.equal((await reserve("qa","qa")).statusCode,403,"forged manager actor cannot elevate");
    assert.equal((await reserve("manager","qa",{"x-platform-csrf":""})).statusCode,403);
    assert.equal((await reserve("manager","tech")).statusCode,400,"non-QA target rejected");
    let result = await reserve("manager","qa");
    assert.equal(result.statusCode,200,result.body);
    let manifest = await storage.readManifest("reserved");
    assert.equal((manifest.workflow as any).custom,"preserved");
    assert.equal((manifest.work_history as any[])[0].event,"existing");
    assert.equal(manifest.qa_reserved_to_email,"qa@example.test");
    const versionBefore = Number((index.getFirstMeasureProjectIndexDb().prepare("SELECT MAX(version) AS value FROM project_queue_events").get() as any).value);
    await reserve("manager","other");
    const versionAfter = Number((index.getFirstMeasureProjectIndexDb().prepare("SELECT MAX(version) AS value FROM project_queue_events").get() as any).value);
    assert.ok(versionAfter > versionBefore,"reservation-only reassign bumps shared queue version");
    await reserve("manager","qa");
    const claim = (name:string,claimedName=name) => app.inject({method:"POST",url:"/v1/firstmeasure/projects/reserved/qa/claim",headers:headers(name),payload:{actor:actor(claimedName)}});
    assert.equal((await claim("other")).json().error,"item_reserved_for_other_qa");
    assert.equal((await claim("other","qa")).statusCode,403,"spoofed target identity blocked");
    const anonClaim=await app.inject({method:"POST",url:"/v1/firstmeasure/projects/reserved/qa/claim",payload:{actor:actor("qa")}});
    assert.equal(anonClaim.statusCode,401);
    const pull=(name:string,claimedName=name)=>app.inject({method:"POST",url:"/v1/firstmeasure/qa/queue/pull",headers:headers(name),payload:{actor:actor(claimedName),count:1}});
    assert.equal((await pull("other","qa")).json().projects.length,0,"spoofed batch target blocked");
    await save("higher-priority",{priority_level:1});
    const pulled=await pull("qa");
    assert.equal(pulled.json().projects[0]?.id,"reserved",pulled.body);
    assert.equal((await reserve("manager","other")).statusCode,409,"active claim not hijacked");
    assert.equal((await pull("other","qa")).json().projects.some((p:any)=>p.id==="reserved"),false,"existing claims do not bypass authenticated reservation");
    await app.inject({method:"POST",url:"/v1/firstmeasure/projects/reserved/qa/release-claim",payload:{actor:actor("qa"),reason:"manual"}});
    manifest=await storage.readManifest("reserved");
    assert.equal(manifest.qa_reserved_to_email,"qa@example.test","break/release does not lose reservation");
    assert.equal((await claim("other")).json().error,"item_reserved_for_other_qa");
    assert.equal((await reserve("manager",null)).statusCode,200);
    assert.equal((await storage.readManifest("reserved")).qa_reserved_to_email,null);
    await reserve("manager","qa");
    await storage.patchManifest("reserved",{status:"completed"});
    manifest=await storage.readManifest("reserved");
    assert.equal(manifest.qa_reserved_to_email,null);
    assert.equal((manifest.workflow as any).qa_reserved_to,null);
    assert.equal((manifest.workflow as any).custom,"preserved");
    assert.equal((await reserve("manager","qa")).statusCode,409);
    await save("reserved",{qa_claimed_by_email:"other@example.test",qa_claimed_at:"2000-01-01T00:00:00Z",workflow:{qa_claim:{email:"other@example.test",claimed_at:"2000-01-01T00:00:00Z"}}});
    await internal.patchInternalUser("other@example.test",{last_qa_activity_at:"2000-01-01T00:00:00Z",last_qa_heartbeat_at:"2000-01-01T00:00:00Z"});
    result=await reserve("manager","qa");
    assert.equal(result.statusCode,200,result.body);
    assert.equal((await storage.readManifest("reserved")).qa_claimed_by_email,null,"stale conflicting claim cleared on reassignment");
    const staleDecision=await app.inject({method:"POST",url:"/v1/firstmeasure/projects/reserved/qa/decision",headers:headers("other"),payload:{actor:actor("other"),status:"approved"}});
    assert.equal(staleDecision.statusCode,403,"stale prior reviewer cannot decide reserved work");
    for(const status of ["cancelled","rejected"]){
      await save("terminal-"+status,{qa_reserved_to_email:"qa@example.test",workflow:{qa_reserved_to:actor("qa")}});
      await storage.patchManifest("terminal-"+status,{status});
      assert.equal((await storage.readManifest("terminal-"+status)).qa_reserved_to_email,null);
    }
  } finally { await app.close(); await index.closeFirstMeasureProjectIndex(); await rm(root,{recursive:true,force:true}); }
});
