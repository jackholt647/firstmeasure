import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import {mkdtemp,readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

// 1M8-214/220 and the Europe signup tickets: the country chosen at signup decides the
// billing profile, phones are sent as E.164, and the chosen language becomes the company's.
let app:any,profile:typeof import("../commerce/profile.js"),storage:typeof import("../platform/storage.js");
before(async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"signup-region-"));
  Object.assign(process.env,{NODE_ENV:"test",FIRSTMATE_ENV:"test",FIRSTMEASURE_DATABASE_MODE:"sqlite",DATABASE_URL:"",PLATFORM_HEARTBEAT_DISABLED:"1",WORK_SCHEDULER_DISABLED:"1",EMAIL_OUTBOUND_DISABLED:"1",CUSTOMER_CALL_WORKER_DISABLED:"1",FIRSTMEASURE_JOB_WORKERS:"0",V1_LOG_LEVEL:"error",FIRSTMEASURE_INDEX_DB_PATH:path.join(root,"measure/index.sqlite")});
  for(const name of ["PLATFORM","INTERNAL","CRM","FIRSTMEASURE","MESSAGING","CHANNELS","CALLS","PRICEBOOK"])process.env[name+"_STORAGE_ROOT"]=path.join(root,name.toLowerCase());
  app=await(await import("../src/app.js")).buildApp();await app.ready();
  profile=await import("../commerce/profile.js");storage=await import("../platform/storage.js");
});
after(async()=>{await app?.close();await(await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();});

function client(edgeCountry:string){
  let cookie="",csrf="";
  return {org:"",async raw(method:string,url:string,payload?:any){
    const response=await app.inject({method,url,payload,headers:{cookie,"cf-ipcountry":edgeCountry,...(csrf?{"x-platform-csrf":csrf}:{})}});
    const set=response.headers["set-cookie"];
    if(set){const pairs=(Array.isArray(set)?set:[set]).map((v:string)=>v.split(";")[0]||"");cookie=pairs.join("; ");csrf=decodeURIComponent(pairs.find((v:string)=>v.startsWith("fm_platform_session_csrf="))?.split("=")[1]||"");}
    return response;
  },async request(method:string,url:string,payload?:any){const result=await this.raw(method,url,payload);assert.ok(result.statusCode<400,result.body);return result.json();}};
}

test("a chosen country decides the billing profile even from a US connection",async()=>{
  const regions=await import("../commerce/regions.js");
  assert.deepEqual(regions.detectSignupCountry({"cf-ipcountry":"US"},{signup_country:"fr",signup_time_zone:"America/Chicago"}),{country:"FR",source:"signup_choice"});
  assert.equal(regions.detectSignupCountry({"cf-ipcountry":"US"},{signup_country:"ZZ"}).country,"US");

  const options=await client("US").request("GET","/v1/platform/auth/signup-options?time_zone=Europe%2FParis&locale=fr-FR");
  assert.equal(options.country,"US");assert.equal(options.language,"en-US");
  const fr=options.countries.find((c:any)=>c.code==="FR");assert.equal(fr.calling_code,"33");assert.equal(fr.language,"fr-FR");assert.equal(fr.name,"France");
  assert.ok(options.languages.some((l:any)=>l.code==="de-DE"));assert.deepEqual(options.domestic_countries,["US","CA"]);
  assert.equal((await client("").request("GET","/v1/platform/auth/signup-options?time_zone=Europe%2FBerlin")).country,"DE");

  const ben=client("US");
  const registration=await ben.request("POST","/v1/platform/auth/register",{email:"ben-eu@signup.example.test",password:"signup-region-password-1",company:"Europe fixture",signup_country:"FR",signup_time_zone:"America/New_York",phone:"06 12 34 56 78",phone_country:"FR"});
  ben.org=registration.organization.id;
  assert.equal(registration.identity.phone,"+33612345678");
  const saved=await profile.organizationProfile(ben.org);
  assert.equal(saved.country,"FR");assert.equal(saved.source,"signup_choice");assert.equal(saved.currency,"EUR");assert.equal(saved.measurement_system,"metric");
  const view=await ben.request("GET",`/v1/platform/organizations/${ben.org}/commerce`);
  assert.equal(view.currency,"EUR");assert.equal(view.report_prices.residential,25);assert.equal(view.report_prices.commercial,50);assert.equal(view.report_prices.gutters,5);
  const quote=await ben.request("GET","/v1/firstmeasure/report-expedite-options?project_type=residential");
  assert.equal(quote.options.find((o:any)=>o.key==="standard_3_6").unit_price,25);

  const us=client("US");
  const domestic=await us.request("POST","/v1/platform/auth/register",{email:"us-default@signup.example.test",password:"signup-region-password-2",phone:"(415) 555-0142"});
  assert.equal((await profile.organizationProfile(domestic.organization.id)).currency,"USD");
  assert.equal(domestic.identity.phone,"(415) 555-0142");
});

test("signup language becomes the company language for the app and reports",async()=>{
  const c=client("US");
  const registration=await c.request("POST","/v1/platform/auth/register",{email:"lang-de@signup.example.test",password:"signup-region-password-3",signup_country:"AT",signup_language:"de-DE",phone:"+43 664 1234567"});
  assert.equal(registration.identity.phone,"+436641234567");
  const language=await c.request("GET","/v1/platform/me/localization");
  assert.equal(language.enabled,true);assert.equal(language.context.locale,"de-DE");assert.equal(language.context.measurement_system,"metric");
  const {resolveOrderReportPreferences}=await import("../firstmeasure/report_preferences.js");
  assert.equal((await resolveOrderReportPreferences({organization_ref:{id:registration.organization.id}})).report_language,"de-DE");

  // A US account that picks another language gets report localization, still in USD and imperial.
  const es=client("US");
  const spanish=await es.request("POST","/v1/platform/auth/legacy-action",{action:"register",email:"lang-es@signup.example.test",password:"signup-region-password-4",signup_country:"US",signup_language:"es-ES",phone:"4155550143"});
  assert.equal(spanish.success,true,JSON.stringify(spanish));
  const spanishLanguage=await es.request("GET","/v1/platform/me/localization");
  assert.equal(spanishLanguage.context.locale,"es-ES");assert.equal(spanishLanguage.context.measurement_system,"imperial");
  assert.equal((await profile.organizationProfile(spanish.organization_id||spanish.organization?.id||spanish.org_id)).currency,"USD");
});

test("signup phones are E.164 with the chosen calling code and need eight digits after +",async()=>{
  const {signupE164,signupPhoneInput}=await import("../commerce/signup-options.js");
  const {normalizeIdentityPhone}=await import("../platform/identity_phone.js");
  assert.equal(signupE164("020 7946 0018","44"),"+442079460018");
  assert.equal(signupE164("0044 20 7946 0018","44"),"+442079460018");
  assert.equal(signupE164("1 (415) 555-0100","1"),"+14155550100");
  assert.equal(signupE164("+49 30 1234567","44"),"+49 30 1234567");
  assert.equal(signupPhoneInput({phone:"0612345678",signup_country:"FR"}),"+33612345678");
  assert.equal(signupPhoneInput({phone:"0612345678",signup_country:"FR",phone_country:"BE"}),"+32612345678");
  assert.equal(signupPhoneInput({phone:"4155550100"}),"4155550100");
  assert.equal(normalizeIdentityPhone("+3312345"),"");assert.equal(normalizeIdentityPhone("+33123456"),"+33123456");

  const source=await readFile(new URL("../../libraries/signup-region/signup-region.js",import.meta.url),"utf8");
  const context:any={URL,URLSearchParams,Intl,navigator:{language:"en-GB"}};context.globalThis=context;
  vm.runInNewContext(source,context);
  const lib=context.FirstMateSignupRegion;
  assert.equal(lib.e164("44","020 7946 0018"),"+442079460018");
  assert.equal(lib.e164("1","(415) 555-0100"),"+14155550100");
  assert.equal(lib.e164("44","+49 30 1234567"),"+49301234567");
  for(const [phone,valid] of [["+33123456",true],["+3312345",false],["+14155550100",true],["+1415555010",false],["+0123456789",false],["+1234567890123456",false]] as const)assert.equal(lib.validE164(phone),valid,phone);

  const rejected=await client("GB").raw("POST","/v1/platform/auth/register",{email:"short-phone@signup.example.test",password:"signup-region-password-5",signup_country:"GB",phone:"+44 1234"});
  assert.equal(rejected.statusCode,400);assert.equal(rejected.json().error,"invalid_phone_number");
});

test("operators can reassign a commercial profile only before credits or Stripe charges",async()=>{
  const owner=client("US");
  const registered=await owner.request("POST","/v1/platform/auth/register",{email:"reassign-owner@signup.example.test",password:"signup-region-password-6",phone:"(415) 555-0144"});
  const org=registered.organization.id,endpoint=`/v1/firstmeasure/admin/prices/organizations/${org}/commercial-profile`;
  assert.equal((await owner.raw("POST",endpoint,{country:"FR"})).statusCode,403);
  assert.equal((await owner.raw("PATCH",`/v1/platform/organizations/${org}/global`,{data:{commercial_profile:profile.profileForCountry("FR")}})).statusCode,403);

  const internal=await import("../internal/storage.js");
  await internal.saveInternalUser({email:"reassign-owner@signup.example.test",name:"Reassign operator",role:"admin",status:"active",permissions:{}});
  const status=await owner.request("GET",endpoint);
  assert.equal(status.reassignable,true);assert.equal(status.profile.currency,"USD");
  assert.equal((await owner.raw("POST",endpoint,{country:"QQ"})).statusCode,400);
  const moved=await owner.request("POST",endpoint,{country:"FR"});
  assert.equal(moved.previous.currency,"USD");assert.equal(moved.profile.currency,"EUR");assert.equal(moved.profile.source,"operator_reassigned");
  assert.equal((await owner.request("GET",`/v1/platform/organizations/${org}/commerce`)).report_prices.residential,25);
  const flags=(await storage.readGlobal(org)).data.app_flags as any;
  assert.equal(flags.firstmeasure.report_localization,true);assert.equal(flags.firstmeasure.metric_measurements,true);

  // The ledger has no currency field: once credits exist the profile is fixed.
  await storage.saveGlobal(org,{data:{credits_ledger:[{ts:new Date().toISOString(),delta:10,reason:"fixture"}],credits_balance:10}});
  const locked=await owner.request("GET",endpoint);assert.equal(locked.reassignable,false);assert.equal(locked.locked_reason,"credits_ledger");
  const refused=await owner.raw("POST",endpoint,{country:"US"});
  assert.equal(refused.statusCode,409);assert.equal(refused.json().error,"commercial_profile_in_use");
  assert.equal((await profile.organizationProfile(org)).currency,"EUR");

  // Stripe charges alone also fix it.
  const other=client("US");
  const second=(await other.request("POST","/v1/platform/auth/register",{email:"reassign-charged@signup.example.test",password:"signup-region-password-7",phone:"(415) 555-0145"})).organization.id;
  await storage.saveGlobal(second,{data:{stripe_fulfilled_sessions:{cs_test_fixture:{at:new Date().toISOString()}}}});
  const charged=await owner.raw("POST",`/v1/firstmeasure/admin/prices/organizations/${second}/commercial-profile`,{country:"FR"});
  assert.equal(charged.statusCode,409);assert.equal(charged.json().error,"commercial_profile_in_use");
});

test("the onboarding wizard formats account amounts in the organization's currency (1M8-215)",async()=>{
  const wizard=await readFile(new URL("../../libraries/apps/onboarding/wizard.js",import.meta.url),"utf8");
  const commerce=await readFile(new URL("../../libraries/platform-commerce/platform-commerce.js",import.meta.url),"utf8");
  assert.doesNotMatch(wizard,/\$\$\{|>\$</,"no hard-coded dollar amounts remain");
  const start=wizard.indexOf("  // Account amounts follow the organization's billing currency"),end=wizard.indexOf("  function bonusMinimumLoadAmount(");
  assert.ok(start>0&&end>start);
  const bonusStart=wizard.indexOf("  function bonusDollarsText("),bonusEnd=wizard.indexOf("  function customBonusPreviewHtml(");
  function run(view:any){
    const context:any={Intl,String,Number,Math};context.globalThis=context;context.window=context;
    vm.runInNewContext(commerce,context);
    if(view)context.PlatformCommerce.set(view);
    vm.runInNewContext("function bonusQuoteForAmount(a){return a>=100?{valid:true,total_account_value:a*1.5,bonus_dollars:a/2}:{valid:false,total_account_value:a,bonus_dollars:0};}\n"+wizard.slice(start,end)+wizard.slice(bonusStart,bonusEnd)+"\nthis.api={creditAmountText,creditCurrencyAffix,totalCreditsText,bonusDollarsText};",context);
    return context.api;
  }
  const prices={residential:25,commercial:50,multifamily:50,gutters:5,weather:5,instant_residential:2,instant_commercial:4,instant_multifamily:4};
  const eur=run({currency:"EUR",credit_display:"currency",report_prices:prices});
  assert.equal(eur.creditAmountText(100),"€100.00");assert.equal(eur.creditCurrencyAffix(),"€");
  assert.equal(eur.totalCreditsText(100),"€150.00 total credit");assert.equal(eur.bonusDollarsText(100),"+ €50.00 Bonus");
  const usd=run({currency:"USD",credit_display:"currency",report_prices:{...prices,residential:7}});
  assert.equal(usd.creditAmountText(100),"$100");assert.equal(usd.creditCurrencyAffix(),"$");assert.equal(usd.totalCreditsText(50),"$50 total credit");
  const credits=run({currency:"EUR",credit_display:"credits",report_prices:prices});
  assert.equal(credits.creditAmountText(100),"100 credits");assert.equal(credits.creditCurrencyAffix(),"");
  assert.equal(run(null).creditCurrencyAffix(),"","nothing is guessed before billing settings load");
});
