import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {stripeBillingFixture} from "./helpers/stripe-billing-fixture.js";

let app:any,profile:typeof import("../commerce/profile.js"),storage:typeof import("../platform/storage.js");
const accounts=new Map<string,any>();
before(async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"regional-commerce-"));
  Object.assign(process.env,{NODE_ENV:"test",FIRSTMATE_ENV:"test",FIRSTMEASURE_DATABASE_MODE:"sqlite",DATABASE_URL:"",PLATFORM_HEARTBEAT_DISABLED:"1",WORK_SCHEDULER_DISABLED:"1",EMAIL_OUTBOUND_DISABLED:"1",CUSTOMER_CALL_WORKER_DISABLED:"1",FIRSTMEASURE_JOB_WORKERS:"0",V1_LOG_LEVEL:"error",STRIPE_TEST_MODE:"1",STRIPE_SECRET_KEY:"sk_test_regional_fixture",STRIPE_TEST_SECRET_KEY:"sk_test_regional_fixture",STRIPE_BASE_URL:"https://dev.1m8.ai/portal",FIRSTMEASURE_INDEX_DB_PATH:path.join(root,"measure/index.sqlite")});
  for(const name of ["PLATFORM","INTERNAL","CRM","FIRSTMEASURE","MESSAGING","CHANNELS","CALLS","PRICEBOOK"])process.env[name+"_STORAGE_ROOT"]=path.join(root,name.toLowerCase());
  app=await(await import("../src/app.js")).buildApp();await app.ready();
  profile=await import("../commerce/profile.js");storage=await import("../platform/storage.js");
});
after(async()=>{await app?.close();await(await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();});

function client(country:string){
  let cookie="",csrf="";
  return {org:"",async raw(method:string,url:string,payload?:any,region=country){
    const response=await app.inject({method,url,payload,headers:{cookie,"cf-ipcountry":region,...(csrf?{"x-platform-csrf":csrf}:{})}});
    const set=response.headers["set-cookie"];
    if(set){const pairs=(Array.isArray(set)?set:[set]).map((v:string)=>v.split(";")[0]||"");cookie=pairs.join("; ");csrf=decodeURIComponent(pairs.find((v:string)=>v.startsWith("fm_platform_session_csrf="))?.split("=")[1]||"");}
    return response;
  },async request(method:string,url:string,payload?:any,region=country){const result=await this.raw(method,url,payload,region);assert.ok(result.statusCode<400,result.body);return result.json();}};
}

test("signup assigns organization prices, currency and localization once; customers cannot replace it",async()=>{
  const original=fetch;globalThis.fetch=(async()=>new Response("unavailable",{status:503})) as typeof fetch;
  try{
    for(const [country,currency,display,price,locale,units] of [
      ["US","USD","currency",7,"en-US","imperial"],["CA","USD","currency",7,"en-US","metric"],
      ["GB","USD","credits",14,"en-GB","metric"],["FR","EUR","currency",14,"en-GB","metric"],["JP","USD","credits",14,"en-GB","metric"]
    ] as const){
      const c=client(country);accounts.set(country,c);
      const registration=await c.request("POST","/v1/platform/auth/register",{email:country.toLowerCase()+"@regional.example.test",password:"regional-password-123",phone:country==="GB"?"+447700900001":"+120255501"+String(accounts.size).padStart(2,"0"),company:"Regional fixture",global:{commercial_profile:{currency:"JPY",tier:"domestic"}}});
      c.org=registration.organization.id;
      const view=await c.request("GET",`/v1/platform/organizations/${c.org}/commerce`,undefined,"US");
      assert.equal(view.currency,currency);assert.equal(view.credit_display,display);assert.equal(view.report_prices.residential,price);
      assert.equal(view.tier,undefined);assert.equal(view.multipliers,undefined);
      const language=await c.request("GET","/v1/platform/me/localization",undefined,"US");
      assert.equal(language.context.locale,locale);assert.equal(language.context.measurement_system,units);
      const saved=await profile.organizationProfile(c.org);assert.equal(saved.country,country);
      assert.equal((await c.raw("PATCH",`/v1/platform/organizations/${c.org}/global`,{data:{commercial_profile:{...saved,tier:"domestic"}}})).statusCode,country==="US"||country==="CA"?200:403);
      const prior=await storage.readGlobal(c.org);
      await c.request("PUT",`/v1/platform/organizations/${c.org}/global`,{data:{branding:{}}});
      await storage.saveGlobal(c.org,{data:prior.data});
      assert.equal((await profile.organizationProfile(c.org)).country,country);
      const quote=await c.request("GET","/v1/firstmeasure/report-expedite-options?project_type=residential");
      assert.equal(quote.options.find((o:any)=>o.key==="standard_3_6").unit_price,price);
    }
  }finally{globalThis.fetch=original;}
});

test("regional report pricing is isolated across concurrent requests, including rush, add-ons and exteriors",async()=>{
  const {firstMeasureReportAmount}=await import("../firstmeasure/pricing.js");
  const {exteriorQuote}=await import("../firstmeasure/exteriors.js");
  const input={project_type:"commercial",report_mode:"both",report_expedite_option:"rush_under_1",include_weather_report:true,pins:[{},{}]};
  const values=await Promise.all(Array.from({length:24},(_,i)=>profile.withOrganizationCommerce(accounts.get(i%2?"FR":"US").org,async()=>{await new Promise(r=>setTimeout(r,i%4));return [firstMeasureReportAmount(input),exteriorQuote(2).options[2]!.amount];})));
  values.forEach((value,i)=>assert.deepEqual(value,values[0]!.map(n=>n*(i%2?2:1))));
});

test("credit checkout locks integration currency, preserves presentment details and rejects mismatched settlement",async()=>{
  const original=fetch,sessions=new Map<string,any>(),calls:any[]=[];let seq=0;
  globalThis.fetch=(async(input:any,options:any={})=>{
    const url=new URL(String(input)),fields=new URLSearchParams(options.body);calls.push({url:url.pathname,fields});
    if(url.hostname!=="api.stripe.com")return new Response("unavailable",{status:503});
    let value:any;
    if(url.pathname==="/v1/customers")value={id:"cus_regional"};
    else if(url.pathname==="/v1/checkout/sessions"){
      const meta=Object.fromEntries([...fields].filter(([k])=>/^metadata\[/.test(k)).map(([k,v])=>[k.slice(9,-1),v]));
      value={id:"cs_regional_"+(++seq),url:"https://checkout.stripe.com/c/test",mode:"payment",livemode:false,status:"complete",payment_status:"paid",currency:fields.get("line_items[0][price_data][currency]")||"usd",amount_total:Number(meta.paid_minor),metadata:meta,presentment_details:{presentment_currency:"jpy",presentment_amount:7000}};sessions.set(value.id,value);
    }else if(url.pathname.startsWith("/v1/checkout/sessions/"))value=sessions.get(url.pathname.split("/").at(-1)!);
    else if(url.pathname==="/v1/payment_intents")value={id:"pi_regional_"+(++seq),status:"succeeded",livemode:false,currency:fields.get("currency"),amount:Number(fields.get("amount"))};
    else value={id:"cus_regional",invoice_settings:{}};
    return new Response(JSON.stringify(value),{status:200,headers:{"content-type":"application/json"}});
  }) as typeof fetch;
  try{
    for(const country of ["FR","JP"]){
      const c=accounts.get(country),created=await c.request("POST","/v1/platform/portal-action",{action:"stripe_create_checkout",qty:50});assert.equal(created.success,true,JSON.stringify(created));
      const fields=calls.filter(c=>c.url==="/v1/checkout/sessions").at(-1).fields;
      assert.equal(fields.get("line_items[0][price_data][currency]"),country==="FR"?"eur":"usd");
      assert.equal(fields.get("adaptive_pricing[enabled]"),country==="FR"?"false":"true");
      const session=sessions.get(created.session.id),currency=session.currency;session.currency="gbp";
      assert.equal((await c.request("POST","/v1/platform/portal-action",{action:"stripe_fulfill_session",session_id:session.id})).success,false);
      session.currency=currency;
      assert.equal((await c.request("POST","/v1/platform/portal-action",{action:"stripe_fulfill_session",session_id:session.id})).credited,50);
      await c.request("POST","/v1/platform/portal-action",{action:"stripe_fulfill_session",session_id:session.id});
      const ledger=(await storage.readGlobal(c.org)).data.credits_ledger as any[];
      assert.equal(ledger.length,1);assert.equal(ledger[0].meta.credit_currency,currency.toUpperCase());assert.equal(ledger[0].meta.presentment_details.presentment_currency,"jpy");
      await storage.saveGlobal(c.org,{data:{billing:{stripe:{customer_id:"cus_regional",default_payment_method:"pm_regional",payment_method_id:"pm_regional",has_payment_method:true},auto_topup:{enabled:true,threshold_dollars:50,topup_dollars:50,cooldown_minutes:0}}}});
      const charge=await c.request("POST",`/v1/platform/organizations/${c.org}/credits/charge`,{amount:7,reason:"order_submitted",meta:{charge_token:"regional-topup"}});
      assert.equal(charge.auto_topup.success,true,JSON.stringify(charge));
      const pi=calls.filter(c=>c.url==="/v1/payment_intents").at(-1).fields;assert.equal(pi.get("currency"),currency);assert.equal(pi.get("amount"),"5000");
    }
  }finally{globalThis.fetch=original;}
});

test("subscriptions use fixed EUR or USD prices, isolate Stripe price IDs and pin accepted prices",async()=>{
  const service=await import("../platform-billing/service.js"),billing=await import("../platform-billing/storage.js"),sub=await import("../platform-billing/subscriptions.js"),caps=await import("../platform/capabilities.js");
  const p=await service.createPrice({product_id:"regional_agents",name:"Agents",capability_key:"apps.assistant",monthly_cents:3000,rates:[{meter:"agents.runs",included:0,unit_quantity:1,unit_price_micros:100000} ]},"fixture");await service.publishPrice(p.id,"fixture");
  const fixture=stripeBillingFixture();
  try{
    for(const country of ["US","FR","JP"]){
      const c=accounts.get(country);await caps.saveCapabilityValues(c.org,{"platform.expanded_access":true,"apps.assistant":true});
      const q=await sub.quoteSubscription(c.org,p.id);assert.equal(q.price.currency,country==="FR"?"EUR":"USD");assert.equal(q.price.monthly_cents,country==="US"?3000:6000);
      assert.equal(q.price.regional_prices,undefined);await sub.acceptSubscription(c.org,q.id,"fixture");
      const saved=(await billing.records<any>(c.org,"subscription"))[0];assert.equal(saved.price.currency,q.price.currency);assert.equal(saved.price.monthly_cents,q.price.monthly_cents);
      const invoices=await billing.records<any>(c.org,"stripe-invoice");assert.equal(invoices[0].currency,q.price.currency);
    }
    assert.equal(fixture.calls.filter(c=>c.route==="prices"&&c.fields.has("unit_amount")).length,3);
    assert.equal(fixture.calls.filter(c=>c.route==="checkout/sessions").find(c=>c.fields.get("metadata[organization_id]")===accounts.get("FR").org)!.fields.get("adaptive_pricing[enabled]"),"false");
  }finally{fixture.restore();}
});

test("future currencies require explicit subscription prices and commercial revisions reject stale orders",async()=>{
  const regions=await import("../commerce/regions.js"),prices=await import("../commerce/prices.js"),billing=await import("../platform-billing/service.js");
  assert.equal(regions.regionLanguage("FR",["en-US","en-GB","fr-FR"]),"fr-FR");assert.equal(regions.regionLanguage("MX"),"en-US");
  assert.equal(regions.detectSignupCountry({}, {signup_locale:"en-US",signup_time_zone:"Europe/London"}).country,"GB");
  assert.equal(regions.detectSignupCountry({}, {signup_locale:"en-US",signup_time_zone:"Africa/Lagos"}).country,"NG");
  assert.equal(regions.regionLanguage("SN",["en-US","en-GB","fr-FR"]),"fr-FR");
  const policy=structuredClone(profile.DEFAULT_COMMERCIAL_POLICY);policy.currencies.JPY={minor_digits:0,report_multiplier:150};
  const jp=profile.profileForCountry("JP","fixture",policy);assert.equal(jp.currency,"JPY");assert.equal(jp.credit_display,"currency");
  const p=(await billing.catalog())[0]!;assert.throws(()=>prices.resolveRegionalPrice(p,jp,policy),{code:"billing_currency_price_missing"});
  const fixed=prices.resolveRegionalPrice({...p,regional_prices:{international:{JPY:{monthly_cents:8000,rates:p.rates}}}},jp,policy);assert.equal(fixed.monthly_cents,8000);assert.equal(fixed.minor_digits,0);
  profile.commerceContext.run({profile:jp,policy,revision:2},()=>{assert.throws(()=>profile.assertCommercialRevision({commercial_pricing_revision:1}),{code:"pricing_changed"});profile.assertCommercialRevision({commercial_pricing_revision:2});assert.equal(profile.creditMinorAmount(7),7);});
});

test("only internal administrators can revise policy; stale orders fail and accepted subscriptions stay fixed",async()=>{
  const us=accounts.get("US"),fr=accounts.get("FR"),endpoint="/v1/firstmeasure/admin/prices/commercial";
  assert.equal((await us.raw("GET",endpoint)).statusCode,403);
  const internal=await import("../internal/storage.js");
  await internal.saveInternalUser({email:"us@regional.example.test",name:"Regional administrator",role:"admin",status:"active",permissions:{}});
  const policy=await us.request("GET",endpoint);policy.config.multipliers.international=3;
  const saved=await us.request("PUT",endpoint,{revision:policy.revision,config:policy.config});assert.ok(saved.revision>policy.revision);
  assert.equal((await us.raw("PUT",endpoint,{revision:policy.revision,config:policy.config})).statusCode,409);
  const view=await fr.request("GET",`/v1/platform/organizations/${fr.org}/commerce`);assert.equal(view.report_prices.residential,21);
  await profile.withOrganizationCommerce(fr.org,()=>assert.throws(()=>profile.assertCommercialRevision({commercial_pricing_revision:0}),{code:"pricing_changed"}));
  const billing=await import("../platform-billing/storage.js");
  const subscription=(await billing.records<any>(fr.org,"subscription"))[0];assert.equal(subscription.price.monthly_cents,6000);assert.equal(subscription.price.currency,"EUR");
  assert.equal((await profile.organizationProfile(fr.org)).country,"FR");
});
