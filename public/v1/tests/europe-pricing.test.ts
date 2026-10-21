import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import {mkdtemp,readFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

// Outside the US and Canada (2026-10-21): €25 residential and €40 per commercial or multifamily
// structure, VAT included; €5 gutters; US rush tiers in euros on a European clock. All configurable.
let app:any,profile:typeof import("../commerce/profile.js");
before(async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"europe-pricing-"));
  Object.assign(process.env,{NODE_ENV:"test",FIRSTMATE_ENV:"test",FIRSTMEASURE_DATABASE_MODE:"sqlite",DATABASE_URL:"",PLATFORM_HEARTBEAT_DISABLED:"1",WORK_SCHEDULER_DISABLED:"1",EMAIL_OUTBOUND_DISABLED:"1",CUSTOMER_CALL_WORKER_DISABLED:"1",FIRSTMEASURE_JOB_WORKERS:"0",V1_LOG_LEVEL:"error",STRIPE_TEST_MODE:"1",STRIPE_SECRET_KEY:"sk_test_europe_fixture",STRIPE_TEST_SECRET_KEY:"sk_test_europe_fixture",STRIPE_BASE_URL:"https://dev.1m8.ai/portal",FIRSTMEASURE_INDEX_DB_PATH:path.join(root,"measure/index.sqlite")});
  for(const name of ["PLATFORM","INTERNAL","CRM","FIRSTMEASURE","MESSAGING","CHANNELS","CALLS","PRICEBOOK"])process.env[name+"_STORAGE_ROOT"]=path.join(root,name.toLowerCase());
  app=await(await import("../src/app.js")).buildApp();await app.ready();
  profile=await import("../commerce/profile.js");
});
after(async()=>{await app?.close();await(await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();});

function client(){
  let cookie="",csrf="";
  return {org:"",async raw(method:string,url:string,payload?:any){
    const response=await app.inject({method,url,payload,headers:{cookie,...(csrf?{"x-platform-csrf":csrf}:{})}});
    const set=response.headers["set-cookie"];
    if(set){const pairs=(Array.isArray(set)?set:[set]).map((v:string)=>v.split(";")[0]||"");cookie=pairs.join("; ");csrf=decodeURIComponent(pairs.find((v:string)=>v.startsWith("fm_platform_session_csrf="))?.split("=")[1]||"");}
    return response;
  },async request(method:string,url:string,payload?:any){const result=await this.raw(method,url,payload);assert.ok(result.statusCode<400,result.body);return result.json();}};
}
const accounts:Record<string,any>={};
async function account(country:string){
  if(accounts[country])return accounts[country];
  const c=client();
  const phone=country==="US"?"(415) 555-0190":"+33 6 12 34 56 9"+Object.keys(accounts).length;
  c.org=(await c.request("POST","/v1/platform/auth/register",{email:`${country.toLowerCase()}-pricing@europe.example.test`,password:"europe-pricing-password-1",signup_country:country,phone})).organization.id;
  return accounts[country]=c;
}

test("Europe prices €25 residential, €40 per commercial and multifamily structure and €5 gutters, VAT included",async()=>{
  const fr=await account("FR"),us=await account("US");
  const eu=await fr.request("GET",`/v1/platform/organizations/${fr.org}/commerce`);
  assert.equal(eu.currency,"EUR");assert.equal(eu.vat_included,true);
  assert.equal(eu.report_prices.residential,25);assert.equal(eu.report_prices.commercial,40);assert.equal(eu.report_prices.multifamily,40);assert.equal(eu.report_prices.gutters,5);
  const domestic=await us.request("GET",`/v1/platform/organizations/${us.org}/commerce`);
  assert.equal(domestic.vat_included,false);assert.equal(domestic.report_prices.residential,7);assert.equal(domestic.report_prices.commercial,12);assert.equal(domestic.report_prices.gutters,2);

  const {firstMeasureReportAmount}=await import("../firstmeasure/pricing.js");
  await profile.withOrganizationCommerce(fr.org,()=>{
    assert.equal(firstMeasureReportAmount({project_type:"residential",report_expedite_option:"standard_3_6",include_gutter_measurements:true}),30);
    assert.equal(firstMeasureReportAmount({project_type:"commercial",report_expedite_option:"standard_3_6",pins:[{},{},{}]}),120);
    assert.equal(firstMeasureReportAmount({project_type:"multifamily",report_expedite_option:"standard_3_6",pins:[{},{}]}),80);
  });
});

test("Europe expedite uses the US rush tiers in euros on a European clock",async()=>{
  const {buildReportExpediteOptions}=await import("../firstmeasure/expedite.js");
  const {pricingContext,DEFAULT_EXPEDITE_PRICING}=await import("../firstmeasure/pricing_config.js");
  const fr=await account("FR"),us=await account("US");
  const now=new Date("2026-10-21T09:00:00Z"); // 11:00 in Paris, 02:00 in Los Angeles.
  const usNow=new Date("2026-10-21T18:00:00Z"); // 11:00 in Los Angeles: the same local time of day.
  const quote=(org:string,type="residential",structures=1,property?:string,at=now):Promise<any>=>pricingContext.run({config:{...DEFAULT_EXPEDITE_PRICING},revision:0,now:at},()=>profile.withOrganizationCommerce(org,()=>
    property?profile.reportPropertyCountry.run(property,()=>buildReportExpediteOptions({projectType:type,structureCount:structures,now:at})):buildReportExpediteOptions({projectType:type,structureCount:structures,now:at})));
  const eu=await quote(fr.org),domestic=await quote(us.org,"residential",1,undefined,usNow);
  assert.deepEqual(eu.options.map((o:any)=>o.key),domestic.options.map((o:any)=>o.key),"every rush tier is offered in Europe");
  assert.equal(eu.vat_included,true);assert.equal(eu.time_zone,"Europe/Paris");assert.equal(domestic.time_zone,"America/Los_Angeles");
  for(const key of ["rush_1_3","rush_under_1"]){
    const e:any=eu.options.find((o:any)=>o.key===key),d:any=domestic.options.find((o:any)=>o.key===key);
    assert.ok(d.rush_delta>0);assert.equal(e.rush_delta,d.rush_delta,"the same tier numbers, in euros");assert.equal(e.unit_price,25+d.rush_delta);
  }
  const commercialEu=await quote(fr.org,"multifamily",2),commercialUs=await quote(us.org,"multifamily",2,undefined,usNow);
  const rush=(q:any)=>q.options.find((o:any)=>o.key==="rush_1_3").unit_price;
  assert.equal(commercialEu.options.find((o:any)=>o.key==="standard_3_6").unit_price,40);
  assert.equal(Math.round((rush(commercialEu)-40)*100),Math.round((rush(commercialUs)-12)*100),"structure surcharge matches the US tier");
  // The delivery window reads on the European clock: about 11:xx in Paris, not 02:xx Pacific.
  const window=eu.options.find((o:any)=>o.key==="rush_1_3").window_label;
  assert.match(window,/^12:00 PM - 2:00 PM$/);
  // A property's own country decides the clock, also for a US account ordering abroad.
  assert.equal((await quote(fr.org,"residential",1,"PT")).time_zone,"Europe/Lisbon");
  assert.equal((await quote(fr.org,"residential",1,"US")).time_zone,"Europe/Paris");

  // The company's configured time zone is used when it is European.
  const storage=await import("../platform/storage.js");
  await storage.upsertDocument(fr.org,"branch",{id:"default",data:{localization:{time_zone:"Europe/Dublin"}}});
  assert.equal((await quote(fr.org)).time_zone,"Europe/Dublin");
});

test("operators configure Europe prices and the default expedite time zone; customers see the change",async()=>{
  const fr=await account("FR"),endpoint="/v1/firstmeasure/admin/prices/commercial";
  assert.equal((await fr.raw("GET",endpoint)).statusCode,403);
  const internal=await import("../internal/storage.js");
  await internal.saveInternalUser({email:"fr-pricing@europe.example.test",name:"Pricing operator",role:"admin",status:"active",permissions:{}});
  const policy=await fr.request("GET",endpoint);
  assert.deepEqual(policy.config.international_prices,{residential:25,per_structure:40,gutters:5,vat_included:true,expedite_time_zone:"Europe/London"});
  assert.equal((await fr.raw("PUT",endpoint,{revision:policy.revision,config:{...policy.config,international_prices:{...policy.config.international_prices,expedite_time_zone:"Mars/Base"}}})).statusCode,400);
  const saved=await fr.request("PUT",endpoint,{revision:policy.revision,config:{...policy.config,international_prices:{...policy.config.international_prices,residential:29,per_structure:45,gutters:6,vat_included:false}}});
  const view=await fr.request("GET",`/v1/platform/organizations/${fr.org}/commerce`);
  assert.equal(view.report_prices.residential,29);assert.equal(view.report_prices.commercial,45);assert.equal(view.report_prices.multifamily,45);assert.equal(view.report_prices.gutters,6);assert.equal(view.vat_included,false);
  await fr.request("PUT",endpoint,{revision:saved.revision,config:{...saved.config,international_prices:policy.config.international_prices}});
  // A saved policy from before this change (with the retired expedite switch) still loads.
  assert.equal(profile.commercialPolicySchema.parse({international_expedite_enabled:false,multipliers:{domestic:1,international:2},currencies:{USD:{minor_digits:2,report_multiplier:1},EUR:{minor_digits:2,report_multiplier:1}}}).international_prices.per_structure,40);
});

test("Stripe credit checkout for a EUR account is in euros and states VAT included",async()=>{
  const fr=await account("FR"),us=await account("US"),calls:URLSearchParams[]=[],original=fetch;
  globalThis.fetch=(async(input:any,options:any={})=>{
    const url=new URL(String(input)),fields=new URLSearchParams(options.body);
    if(url.hostname!=="api.stripe.com")return new Response("unavailable",{status:503});
    if(url.pathname==="/v1/checkout/sessions")calls.push(fields);
    const value=url.pathname==="/v1/checkout/sessions"?{id:"cs_europe_"+calls.length,url:"https://checkout.stripe.com/c/test",mode:"payment",currency:fields.get("line_items[0][price_data][currency]")||"usd"}:{id:"cus_europe"};
    return new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}});
  }) as typeof fetch;
  try{
    assert.equal((await fr.request("POST","/v1/platform/portal-action",{action:"stripe_create_checkout",qty:100})).success,true);
    const eu=calls.at(-1)!;
    assert.equal(eu.get("line_items[0][price_data][currency]"),"eur");assert.equal(eu.get("line_items[0][price_data][unit_amount]"),"100");
    assert.match(eu.get("line_items[0][price_data][product_data][description]")||"",/€100 added to your FirstMate account\. VAT included\.$/);
    await us.request("POST","/v1/platform/portal-action",{action:"stripe_create_checkout",qty:100});
    assert.doesNotMatch(calls.at(-1)!.get("line_items[0][price_data][product_data][description]")||"",/VAT/);
  }finally{globalThis.fetch=original;}
});

test("browser prices read as VAT included for VAT-included accounts",async()=>{
  const source=await readFile(new URL("../../libraries/platform-commerce/platform-commerce.js",import.meta.url),"utf8");
  const context:any={Intl,String,Number};context.globalThis=context;vm.runInNewContext(source,context);
  const prices={residential:25,commercial:40,multifamily:40,gutters:5,weather:10,instant_residential:4,instant_commercial:8,instant_multifamily:8};
  assert.equal(context.PlatformCommerce.withVat("€25.00"),"€25.00","nothing is claimed before billing settings load");
  context.PlatformCommerce.set({currency:"EUR",credit_display:"currency",vat_included:true,report_prices:prices});
  assert.equal(context.PlatformCommerce.withVat(context.PlatformCommerce.credit(25)),"€25.00, VAT included");
  assert.equal(context.PlatformCommerce.withVat("€40.00 / structure",{vat_included:false}),"€40.00 / structure");
  const card=await readFile(new URL("../../libraries/apps/project-request/app.js",import.meta.url),"utf8");
  assert.match(card,/function typePriceLabel\(type\)[\s\S]{0,700}reportVatText\(text\)/);
});
