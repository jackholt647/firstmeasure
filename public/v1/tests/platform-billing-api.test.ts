import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import {mkdtemp} from "node:fs/promises";
import {createHmac} from "node:crypto";
import os from "node:os";
import path from "node:path";
import {access, mkdir} from "node:fs/promises";
import {stripeBillingFixture} from "./helpers/stripe-billing-fixture.js";
import {operatorFixtureClient} from "./helpers/platform-fixture.js";
let app:any, storage:typeof import("../platform/storage.js"), caps:typeof import("../platform/capabilities.js"), billing:typeof import("../platform-billing/storage.js");
before(async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"billing-api-"));
  Object.assign(process.env,{NODE_ENV:"test",FIRSTMATE_ENV:"test",PLATFORM_HEARTBEAT_DISABLED:"1",WORK_SCHEDULER_DISABLED:"1",EMAIL_OUTBOUND_DISABLED:"1",CUSTOMER_CALL_WORKER_DISABLED:"1",OPENAI_API_KEY:"",PLATFORM_STORAGE_ROOT:path.join(root,"platform"),CRM_STORAGE_ROOT:path.join(root,"crm"),FIRSTMEASURE_STORAGE_ROOT:path.join(root,"measure"),FIRSTMEASURE_INDEX_DB_PATH:path.join(root,"measure/index.sqlite"),MESSAGING_STORAGE_ROOT:path.join(root,"messaging"),PRICEBOOK_STORAGE_ROOT:path.join(root,"pricebook"),V1_LOG_LEVEL:"error",STRIPE_TEST_WEBHOOK_SECRET:"whsec_billing_fixture",STRIPE_TEST_MODE:"true",STRIPE_SECRET_KEY:"sk_test_billing_fixture",STRIPE_BASE_URL:"https://dev.1m8.ai/portal"});
  app=await (await import("../src/app.js")).buildApp();await app.ready();
  storage=await import("../platform/storage.js");caps=await import("../platform/capabilities.js");billing=await import("../platform-billing/storage.js");
});
after(async()=>{await app?.close();await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();});
async function owner(org:string,expanded=true,permissions?:Record<string,boolean>){
  await storage.createOrganization({id:org,name:"Billing fixture"});if(expanded)await caps.saveCapabilityValues(org,{"platform.expanded_access":true,"apps.messaging":true,"apps.assistant":true});
  const identity=await storage.createIdentity({email:`${org}@example.test`,name:"Billing owner"});const user="owner";
  await storage.addIdentityMembership(String(identity.id),org,user,"owner");
  await storage.upsertDocument(org,"users",{id:user,data:{identity_id:identity.id,email:identity.email,status:"active",org_permissions:{level:"owner",items:permissions||{}}}});
  const session=await storage.createAuthSession({identity_id:identity.id,organization_id:org,user_id:user,role:"owner"});
  const {env}=await import("../src/config/env.js");const signature=createHmac("sha256",env.platformSessionSecret).update(session.sessionId).digest("base64url");
  const headers={cookie:`fm_platform_session=${session.sessionId}.${signature}`,"x-platform-csrf":String(session.session.csrf_token)};
  return {headers,raw:(method:string,url:string,payload?:unknown)=>app.inject({method,url,payload,headers})};
}
test("API preserves legacy access, enforces tenants, CSRF and distinct read/write/operator permissions",async()=>{
  const legacy=await owner("billing_legacy",false);
  assert.equal((await legacy.raw("GET","/v1/platform-billing/organizations/billing_legacy")).statusCode,403);
  const customer=await owner("billing_customer");const base="/v1/platform-billing/organizations/billing_customer";
  assert.equal((await customer.raw("GET",base)).statusCode,200);
  assert.equal((await customer.raw("GET","/v1/platform-billing/organizations/billing_legacy")).statusCode,403);
  assert.equal((await customer.raw("PUT",base+"/account",{enforce:true})).statusCode,403);
  assert.equal((await customer.raw("POST",base+"/prices",{})).statusCode,403);
  assert.equal((await app.inject({method:"POST",url:base+"/refresh",headers:{cookie:customer.headers.cookie}})).statusCode,403);
  const reader=await owner("billing_reader",true,{manage_platform_billing:false,view_platform_billing:true});
  assert.equal((await reader.raw("GET","/v1/platform-billing/organizations/billing_reader")).statusCode,200);
  assert.equal((await reader.raw("POST","/v1/platform-billing/organizations/billing_reader/refresh")).statusCode,403);
  const denied=await owner("billing_denied",true,{manage_platform_billing:false,view_platform_billing:false});
  assert.equal((await denied.raw("GET","/v1/platform-billing/organizations/billing_denied")).statusCode,403);
});
test("operator configures a product; customer explicitly subscribes; collector recovers source usage once",async()=>{
  const customer=await owner("billing_flow");const operator=await operatorFixtureClient(app,"billing_flow");const base="/v1/platform-billing/organizations/billing_flow";
  const price=(await operator.request("POST",base+"/prices",{product_id:"agent_plan",name:"Agent plan",capability_key:"apps.assistant",monthly_cents:1200,rates:[{meter:"agents.runs",included:10,unit_quantity:1,unit_price_micros:100000}]})).price;
  assert.equal((await customer.raw("GET",base)).json().prices.length,0);
  await operator.request("POST",`${base}/prices/${price.id}/publish`);
  assert.equal((await customer.raw("POST",base+"/subscriptions",{price_id:price.id,request_key:"customer-accept"})).statusCode,400);
  assert.equal((await customer.raw("POST",base+"/subscriptions",{price_id:price.id,request_key:"customer-accept",accept_terms:true})).json().error,"billing_checkout_required");
  const stripeFixture=stripeBillingFixture();try {
    const quote=(await customer.raw("POST",base+"/subscription-quotes",{price_id:price.id})).json().quote;
    assert.equal((await customer.raw("POST",base+"/subscription-checkouts",{quote_id:quote.id})).statusCode,400);
    const response=await customer.raw("POST",base+"/subscription-checkouts",{quote_id:quote.id,accept_terms:true});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().paid,true);
    const session=[...stripeFixture.sessions.values()][0];const event={id:"evt_platform_fixture",type:"checkout.session.completed",livemode:false,data:{object:session}};
    const payload=JSON.stringify(event),timestamp=Math.floor(Date.now()/1000),signature=createHmac("sha256","whsec_billing_fixture").update(`${timestamp}.${payload}`).digest("hex");
    assert.equal((await app.inject({method:"POST",url:"/v1/platform/stripe-webhook-proxy",payload:{payload_base64:Buffer.from(payload).toString("base64"),signature:`t=${timestamp},v1=invalid`}})).statusCode,400);
    for(let i=0;i<2;i++)assert.equal((await app.inject({method:"POST",url:"/v1/platform/stripe-webhook-proxy",payload:{payload_base64:Buffer.from(payload).toString("base64"),signature:`t=${timestamp},v1=${signature}`}})).json().success,true);
  } finally {stripeFixture.restore();}
  await (await import("../agents/storage.js")).recordAgentRun({organization_id:"billing_flow",agent_id:"assistant",status:"success",input_tokens:123,output_tokens:45});
  await (await import("../agents/storage.js")).recordAgentRun({organization_id:"billing_flow",agent_id:"live_chat",status:"success",input_tokens:20,output_tokens:10});
  await (await import("../chat/storage.js")).createAiUsageEvent({organization_id:"billing_flow",kind:"agent_turn",model:"fixture",input_tokens:20,output_tokens:10});
  const {collectUsage}=await import("../platform-billing/metering.js");await collectUsage("billing_flow");await collectUsage("billing_flow");
  const rows=await billing.billingStore().prepare("SELECT * FROM platform_billing_usage WHERE organization_id=? AND meter=?").all("billing_flow","agents.runs");assert.equal(rows.length,1);assert.equal(rows[0]?.quantity,"1");
  assert.equal((await billing.billingStore().prepare("SELECT quantity FROM platform_billing_usage WHERE organization_id=? AND meter=?").get("billing_flow","chat.output_tokens"))?.quantity,"10");
  assert.equal((await billing.records<any>("billing_flow","subscription"))[0].price.monthly_cents,1200);
  const original=(await storage.readGlobal("billing_legacy")).data;
  await operator.request("PUT","/v1/platform-billing/organizations/billing_customer/account",{enforce:true});
  assert.deepEqual((await storage.readGlobal("billing_legacy")).data,original);
});
test("Stripe checkout retries reuse a session; settlement validates org, amount and mode without crediting FirstMeasure",async()=>{
  const customer=await owner("billing_pay");const base="/v1/platform-billing/organizations/billing_pay";
  const invoice={id:"2020-01",period:"2020-01",currency:"USD",lines:[],total_cents:1250,status:"open",created_at:"2020-02-04T00:00:00.000Z",actor:"test"};
  await billing.put("billing_pay","invoice",invoice.id,invoice);
  const original=(await storage.readGlobal("billing_pay")).data;const previous=globalThis.fetch;let creates=0,paid=false,wrong=false;
  globalThis.fetch=(async(url:any,options:any)=>{
    assert.ok(String(url).startsWith("https://api.stripe.com/v1/checkout/sessions"));
    if(options.method==="POST"){creates++;const fields=new URLSearchParams(options.body);assert.equal(fields.get("metadata[billing_kind]"),"platform_invoice");assert.equal(fields.get("line_items[0][price_data][unit_amount]"),"1250");}
    return new Response(JSON.stringify({id:"cs_test_fixture",url:"https://checkout.stripe.com/test",status:"open",payment_status:paid?"paid":"unpaid",livemode:false,currency:"usd",amount_total:wrong?1251:1250,payment_intent:"pi_test_fixture",metadata:{billing_kind:"platform_invoice",organization_id:"billing_pay",invoice_id:"2020-01"}}),{status:200,headers:{"content-type":"application/json"}});
  }) as typeof fetch;
  try {
    const blocked=await customer.raw("POST",base+"/invoices/2020-01/checkout");assert.equal(blocked.statusCode,400);assert.equal(blocked.json().error,"billing_automatic_collection");
    for(let i=0;i<2;i++)await (await import("../platform-billing/payments.js")).checkout("billing_pay","2020-01","legacy-recovery-test");assert.equal(creates,1);
    paid=true;wrong=true;const payments=await import("../platform-billing/payments.js");await assert.rejects(payments.reconcilePayments("billing_pay","test"),{code:"billing_payment_mismatch"});
    assert.equal((await billing.record<any>("billing_pay","invoice","2020-01")).status,"open");
    wrong=false;await payments.reconcilePayments("billing_pay","test");await payments.reconcilePayments("billing_pay","test");
    assert.equal((await billing.record<any>("billing_pay","invoice","2020-01")).status,"paid");
    assert.deepEqual((await storage.readGlobal("billing_pay")).data,original);
    await billing.put("billing_pay","invoice","2020-02",{...invoice,id:"2020-02",period:"2020-02"});
    const keys:string[]=[];let fail=true;
    globalThis.fetch=(async(_url:any,options:any)=>{keys.push(options.headers["Idempotency-Key"]);if(fail){fail=false;throw new Error("Connection interrupted after provider accepted the request");}return new Response(JSON.stringify({id:"cs_recovered",url:"https://checkout.stripe.com/recovered"}),{status:200});}) as typeof fetch;
    await assert.rejects(payments.checkout("billing_pay","2020-02","test"));
    assert.ok(await billing.record("billing_pay","checkout-attempt","2020-02"));
    await payments.checkout("billing_pay","2020-02","test");assert.equal(keys[0],keys[1]);
  }finally{globalThis.fetch=previous;}
});
test("browser renders real billing API, accepts subscriptions explicitly and fits a phone viewport",{skip:process.env.SKIP_BILLING_BROWSER==="1"},async()=>{
  const {chromium}=await import("playwright-core");
  const paths=[process.env.BILLING_BROWSER_PATH,"C:/Program Files/Google/Chrome/Application/chrome.exe","C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe","/usr/bin/chromium"].filter(Boolean) as string[];
  let executablePath="";for(const item of paths){try{await access(item);executablePath=item;break;}catch{}}
  assert.ok(executablePath,"A browser is required for billing UI acceptance.");
  const browser=await chromium.launch({executablePath,headless:true});const stripeFixture=stripeBillingFixture();
  const customer=await owner("billing_browser");const address=await app.listen({host:"127.0.0.1",port:0});
  const context=await browser.newContext({viewport:{width:1280,height:900}});const page=await context.newPage();const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
  try{
    const [cookieName,...value]=customer.headers.cookie.split("=");
    await context.addCookies([{name:cookieName!,value:value.join("="),url:address},{name:"fm_platform_session_csrf",value:customer.headers["x-platform-csrf"],url:address}]);
    await page.goto(address+"/v1/health/live");await page.setContent('<html><body style="font-family:Arial;margin:24px;background:#f9fafb"><main id="billing"></main></body></html>');
    await page.evaluate(base=>{(window as any).__APP={platformApiBase:base+"/v1/platform"};},address);
    await page.addScriptTag({path:path.resolve("../libraries/platform-api/platform-api.js")});await page.addScriptTag({path:path.resolve("../libraries/apps/settings/platform-billing.js")});
    await page.evaluate(()=> (window as any).FirstMatePlatformBilling.mount(document.querySelector("#billing"),{orgId:"billing_browser"}));
    await page.getByRole("button",{name:"Subscriptions",exact:true}).click();await page.getByRole("button",{name:"Review & add"}).click();
    assert.equal((await billing.records("billing_browser","subscription")).length,0);
    await page.getByRole("heading",{name:"Due today"}).waitFor();
    assert.match(await page.locator('dialog').innerText(),/Current monthly total/);assert.match(await page.locator('dialog').innerText(),/New monthly total/);
    await mkdir(path.resolve("../../output/platform-billing-ui"),{recursive:true});await page.screenshot({path:path.resolve("../../output/platform-billing-ui/checkout-desktop.png"),fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);await page.screenshot({path:path.resolve("../../output/platform-billing-ui/checkout-mobile.png"),fullPage:true});
    await page.getByRole("button",{name:"Continue to checkout"}).click();await page.getByRole("button",{name:"Cancel renewal"}).waitFor();
    assert.equal((await billing.records("billing_browser","subscription")).length,1);
    const setupPrice=await (await import("../platform-billing/service.js")).createPrice({product_id:"browser_sms",name:"SMS",description:"Customer text messaging",capability_key:"apps.messaging",monthly_cents:3000},"operator");
    await (await import("../platform-billing/service.js")).publishPrice(setupPrice.id,"operator");
    await page.evaluate(`(async()=>{
      await window.PlatformAPI.appFlags.load("billing_browser",{refresh:true});
      await window.FirstMatePlatformBilling.setup(document.querySelector('#billing'),{orgId:"billing_browser",capabilityKeys:['apps.messaging'],onReady:()=>{document.querySelector('#billing').textContent='SMS setup ready';}});
    })()`);
    await page.getByRole('button',{name:'Review & add',exact:true}).click();await page.getByRole('heading',{name:'Due today'}).waitFor();
    const review=await page.locator('dialog').innerText();assert.match(review,/\$12\.00/);assert.match(review,/\$42\.00/);assert.match(review,/\$15\.00/);
    await page.screenshot({path:path.resolve("../../output/platform-billing-ui/addon-mobile.png"),fullPage:true});
    await page.getByRole('button',{name:'Pay $15.00 USD & confirm'}).click();await page.getByText('SMS setup ready',{exact:true}).waitFor();
    await page.evaluate(()=> (window as any).FirstMatePlatformBilling.mount(document.querySelector("#billing"),{orgId:"billing_browser"}));
    await page.getByRole("button",{name:"Overview",exact:true}).click();
    await mkdir(path.resolve("../../output/platform-billing-ui"),{recursive:true});
    await page.screenshot({path:path.resolve("../../output/platform-billing-ui/desktop.png"),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:path.resolve("../../output/platform-billing-ui/mobile.png"),fullPage:true});
    const identity=await storage.findIdentityByEmail("notifications@1m8.ai");
    const auth=await storage.createAuthSession({identity_id:identity!.id,organization_id:"billing_flow",user_id:"fixture_operator",role:"owner"});
    const {env}=await import("../src/config/env.js");const signature=createHmac("sha256",env.platformSessionSecret).update(auth.sessionId).digest("base64url");
    await context.addCookies([{name:"fm_platform_session",value:`${auth.sessionId}.${signature}`,url:address},{name:"fm_platform_session_csrf",value:String(auth.session.csrf_token),url:address}]);
    await page.setViewportSize({width:1280,height:900});
    await page.evaluate(()=> (window as any).FirstMatePlatformBilling.mount(document.querySelector("#billing"),{orgId:"billing_flow"}));
    await page.getByRole("button",{name:"Pricing catalog",exact:true}).click();
    await page.getByLabel("Product ID").fill("browser_piece");await page.getByLabel("Display name").fill("Piece-rate product");await page.getByLabel("Feature or app").selectOption("apps.equipment");
    await page.getByRole("button",{name:"Add usage price"}).click();await page.getByLabel("Meter",{exact:true}).selectOption("chat.output_tokens");await page.getByLabel("Price (USD)",{exact:true}).fill("0.0001");
    assert.equal((await (await import("../platform-billing/service.js")).catalog(true)).some(p=>p.product_id==="browser_piece"),false);
    await page.getByRole("button",{name:"Save draft price"}).click();await page.getByRole("button",{name:"Publish price"}).waitFor();
    page.on("dialog",dialog=>dialog.accept());await page.getByRole("button",{name:"Publish price"}).click();await page.getByRole("button",{name:"Publish price"}).waitFor({state:"detached"});
    const product=(await (await import("../platform-billing/service.js")).catalog()).find(p=>p.product_id==="browser_piece");assert.equal(product?.rates[0]?.unit_price_micros,100);
    await page.screenshot({path:path.resolve("../../output/platform-billing-ui/catalog.png"),fullPage:true});
    assert.deepEqual(errors,[]);
  }finally{stripeFixture.restore();await browser.close();}
});
