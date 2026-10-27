import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// 1M8-228: every organization has a country of record — set at signup, backfilled, edited by staff —
// that feature-flag country rules and pricing can select on.
let app:any,storage:typeof import("../platform/storage.js"),country:typeof import("../platform/organization_country.js"),profile:typeof import("../commerce/profile.js");
before(async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"organization-country-"));
  Object.assign(process.env,{NODE_ENV:"test",FIRSTMATE_ENV:"test",FIRSTMEASURE_DATABASE_MODE:"sqlite",DATABASE_URL:"",PLATFORM_HEARTBEAT_DISABLED:"1",WORK_SCHEDULER_DISABLED:"1",EMAIL_OUTBOUND_DISABLED:"1",CUSTOMER_CALL_WORKER_DISABLED:"1",FIRSTMEASURE_JOB_WORKERS:"0",V1_LOG_LEVEL:"error",FIRSTMEASURE_INDEX_DB_PATH:path.join(root,"measure/index.sqlite")});
  for(const name of ["PLATFORM","INTERNAL","CRM","FIRSTMEASURE","MESSAGING","CHANNELS","CALLS","PRICEBOOK"])process.env[name+"_STORAGE_ROOT"]=path.join(root,name.toLowerCase());
  app=await(await import("../src/app.js")).buildApp();await app.ready();
  storage=await import("../platform/storage.js");country=await import("../platform/organization_country.js");profile=await import("../commerce/profile.js");
  const internal=await import("../internal/storage.js");
  await internal.saveInternalUser({email:"staff@country.example.test",name:"Staff",role:"admin",status:"active",permissions:{}});
});
after(async()=>{await app?.close();await(await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();});

let seq=0;
async function signup(payload:Record<string,unknown>){
  const response=await app.inject({method:"POST",url:"/v1/platform/auth/register",payload:{email:`org-${++seq}@country.example.test`,password:"organization-country-1",phone:"(415) 555-01"+String(seq).padStart(2,"0"),...payload}});
  assert.equal(response.statusCode,201,response.body);
  return String(response.json().organization.id);
}
const staff=(action:string,payload:Record<string,unknown>)=>app.inject({method:"POST",url:"/v1/internal/legacy-action",headers:{"x-internal-user-email":"staff@country.example.test"},payload:{action,...payload}});
const stored=async(org:string)=>country.storedOrganizationCountry((await storage.readGlobal(org)).data as any);

test("signup stores the country of record with the billing profile",async()=>{
  const fr=await signup({signup_country:"FR",phone:"+33612345601"});
  assert.deepEqual({...await stored(fr),updated_at:""},{code:"FR",source:"signup_choice",updated_at:""});
  assert.equal(await country.organizationCountryCode(fr),"FR");
  const us=await signup({});
  assert.equal((await stored(us))?.source,"signup_detected","a US number with no choice is detected");
  assert.equal((await stored(us))?.code,"US");
});

test("addresses and orders give older organizations a country; US only without evidence",()=>{
  assert.equal(country.addressCountry("12 Rue de Rivoli, 75001 Paris, France"),"FR");
  assert.equal(country.addressCountry("1 Main St, Austin, TX 78701, USA"),"US");
  assert.equal(country.addressCountry("100 Queen St W, Toronto, ON M5H 2N2, Canada"),"CA");
  assert.equal(country.addressCountry("10 Downing Street, London SW1A 2AA, UK"),"GB");
  assert.equal(country.addressCountry("no country here"),"");
  assert.deepEqual(country.derivedOrganizationCountry({},[{address:"1 Yonge St, Toronto, ON, Canada"},{address:"2 Bay St, Toronto, ON, Canada"},{address:"9 Main St, Buffalo, NY, USA"}]),["CA","orders"]);
  assert.deepEqual(country.derivedOrganizationCountry({contact:{address:"Calle Mayor 1, Madrid, Spain"}}),["ES","contact"]);
  assert.deepEqual(country.derivedOrganizationCountry({}),["US","legacy_default"]);
});

test("staff set the country; billing follows only before credit history",async()=>{
  const org=await signup({signup_country:"US"});
  const moved=await staff("org_set_country",{org_id:org,country:"DE"});
  assert.equal(moved.statusCode,200,moved.body);assert.equal(moved.json().billing,"reassigned");
  assert.equal((await stored(org))?.source,"staff");assert.equal((await profile.organizationProfile(org)).currency,"EUR");
  assert.equal((await stored(org))?.code,"DE","an operator billing change keeps the staff record");

  await storage.saveGlobal(org,{data:{credits_ledger:[{ts:new Date().toISOString(),delta:5,reason:"fixture"}],credits_balance:5}});
  const locked=await staff("org_set_country",{org_id:org,country:"AT"});
  assert.equal(locked.json().billing,"locked");assert.equal(locked.json().billing_locked_reason,"credits_ledger");
  assert.equal((await stored(org))?.code,"AT");assert.equal((await profile.organizationProfile(org)).country,"DE","pricing stays on the billing profile");
  assert.equal((await staff("org_set_country",{org_id:org,country:"XX"})).statusCode,400);

  const list=await staff("customer_org_dashboard_data",{paginate:"1",per_page:"50",filters:JSON.stringify({country:"at"})});
  assert.equal(list.statusCode,200,list.body);
  assert.deepEqual(list.json().organizations.map((row:any)=>row.id),[org]);
  assert.equal(list.json().organizations[0].country_source,"staff");
});

test("country rules set capability values by country of record",async()=>{
  const caps=await import("../platform/capabilities.js"),flags=await import("../platform/app_flags.js");
  const fr=await signup({signup_country:"FR",phone:"+33612345602"}),us=await signup({});
  const key="firstmeasure.metric_measurements";
  assert.equal(await flags.isAppFlagEnabled(us,"firstmeasure","metric_measurements"),false);
  assert.equal((await staff("capability_country_rules_save",{rules:JSON.stringify([{countries:["us"],values:{nope:true}}])})).statusCode,400);
  const saved=await staff("capability_country_rules_save",{rules:JSON.stringify([{countries:["us","CA"],values:{[key]:true},note:"fixture"},{countries:["FR"],values:{[key]:false}}])});
  assert.equal(saved.statusCode,200,saved.body);assert.deepEqual(saved.json().rules[0].countries,["US","CA"]);
  assert.equal(await flags.isAppFlagEnabled(us,"firstmeasure","metric_measurements"),true);
  assert.equal(await flags.isAppFlagEnabled(fr,"firstmeasure","metric_measurements"),false);
  assert.equal((await caps.effectiveCapabilities(us)).values[key],true);
  assert.equal((await staff("capability_country_rules_get",{})).json().rules.length,2);
  await staff("capability_country_rules_save",{rules:"[]"});
  assert.equal(await flags.isAppFlagEnabled(us,"firstmeasure","metric_measurements"),false);
});

test("the backfill stores derived countries and never overwrites a record",async()=>{
  const legacy=await signup({});
  await storage.saveGlobal(legacy,{data:{contact:{address:"Hauptstrasse 1, 10115 Berlin, Germany"}}});
  await storage.mutateGlobal(legacy,current=>{const data={...(current.data as any)};delete data.country;delete data.commercial_profile;return {data};});
  // mutateGlobal merges; remove the keys with a replace save instead.
  const current=(await storage.readGlobal(legacy)).data as any;delete current.country;delete current.commercial_profile;
  await storage.saveGlobal(legacy,{data:current},{replace:true});
  const staffSet=await signup({});await staff("org_set_country",{org_id:staffSet,country:"IE"});
  const dry=await country.backfillOrganizationCountries({orgIds:[legacy,staffSet]});
  assert.equal(dry.already_set,1);assert.deepEqual(dry.changed,[{org_id:legacy,code:"DE",source:"contact"}]);
  assert.equal(await stored(legacy),null,"a dry run writes nothing");
  await country.backfillOrganizationCountries({orgIds:[legacy,staffSet],write:true});
  assert.equal((await stored(legacy))?.code,"DE");assert.equal((await stored(staffSet))?.code,"IE");
});
