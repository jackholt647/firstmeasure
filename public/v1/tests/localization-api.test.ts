import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("company and personal language endpoints enforce rollout and preserve independent preferences", async () => {
  const root=await mkdtemp(path.join(os.tmpdir(),"language-api-"));
  Object.assign(process.env,{NODE_ENV:"test",FIRSTMATE_ENV:"test",FIRSTMEASURE_DATABASE_MODE:"sqlite",DATABASE_URL:"",PLATFORM_HEARTBEAT_DISABLED:"1",FIRSTMEASURE_JOB_WORKERS:"0",EMAIL_OUTBOUND_DISABLED:"1",V1_LOG_LEVEL:"error",FIRSTMEASURE_INDEX_DB_PATH:path.join(root,"index.sqlite")});
  for(const name of ["PLATFORM","FIRSTMEASURE","MESSAGING","CHANNELS","CALLS","INTERNAL","PRICEBOOK"])process.env[`${name}_STORAGE_ROOT`]=path.join(root,name.toLowerCase());
  const {buildApp}=await import("../src/app.js");
  const platform=await import("../platform/storage.js");
  const app=await buildApp();
  let cookie="",csrf="";
  async function request(method:string,url:string,payload?:any){
    const response=await app.inject({method:method as any,url,payload,headers:{cookie,...(csrf?{"x-platform-csrf":csrf}:{})}});
    const set=response.headers["set-cookie"];
    if(set){const pairs=(Array.isArray(set)?set:[set]).map(value=>value.split(";")[0] || "");cookie=pairs.join("; ");csrf=decodeURIComponent(pairs.find(value=>value.startsWith("fm_platform_session_csrf="))?.split("=")[1]||"");}
    return {status:response.statusCode,data:response.json()};
  }
  try {
    const registered=await request("POST","/v1/platform/auth/register",{phone:"+12025550881",email:"localization@example.test",password:"language-test-password",name:"Language Test",company:"Language Test Company"});
    assert.equal(registered.status,201,JSON.stringify(registered.data));
    const org=registered.data.organization.id;
    assert.equal((await request("GET","/v1/platform/me/localization")).data.context.locale,"en-US");
    assert.equal((await request("PATCH","/v1/platform/me/preferences",{interface_locale:"en-GB"})).status,403);
    await platform.saveGlobal(org,{data:{app_flags:{firstmeasure:{report_localization:true,metric_measurements:false}}}});
    await platform.upsertDocument(org,"branch",{id:"default",data:{localization:{locale:"en-GB",measurement_system:"metric"}}});
    const company=(await request("GET","/v1/platform/me/localization")).data;
    assert.deepEqual(company.context,{locale:"en-GB",measurement_system:"metric"});
    const personal=await request("PATCH","/v1/platform/me/preferences",{interface_locale:"en-US",language:"es",auto_translate_messages:true});
    assert.equal(personal.status,200);
    const override=(await request("GET","/v1/platform/me/localization")).data;
    assert.equal(override.context.locale,"en-US");assert.equal(override.company.locale,"en-GB");assert.equal(override.context.measurement_system,"metric");
    assert.equal((await request("PATCH","/v1/platform/me/preferences",{interface_locale:"unknown"})).status,400);
    const inherited=await request("PATCH","/v1/platform/me/preferences",{interface_locale:null});
    assert.equal(inherited.data.preferences.language,"es");assert.equal(inherited.data.preferences.auto_translate_messages,true);
    assert.equal((await request("GET","/v1/platform/me/localization")).data.context.locale,"en-GB");
    const {companyDocumentLanguage}=await import("../platform/localization/documents.js");
    const snapshot=await companyDocumentLanguage(org);
    await platform.saveGlobal(org,{data:{app_flags:{firstmeasure:{report_localization:false}}}});
    assert.equal((await request("GET","/v1/platform/me/localization")).data.context.locale,"en-US");
    assert.equal(snapshot.locale,"en-GB");assert.ok(snapshot.catalog_versions["doc-widgets"]);
  } finally { await app.close(); await (await import("../firstmeasure/project_index.js")).closeFirstMeasureProjectIndex(); }
});
