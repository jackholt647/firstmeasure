import assert from "node:assert/strict";
import test,{before,after} from "node:test";
import {mkdtemp} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {stripeBillingFixture} from "./helpers/stripe-billing-fixture.js";
let billing:typeof import("../platform-billing/subscriptions.js"),store:typeof import("../platform-billing/storage.js"),service:typeof import("../platform-billing/service.js"),storage:typeof import("../platform/storage.js"),caps:typeof import("../platform/capabilities.js");
let sms:any,ai:any,free:any;
before(async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),"subscription-checkout-"));Object.assign(process.env,{NODE_ENV:"test",PLATFORM_STORAGE_ROOT:root,STRIPE_TEST_MODE:"true",STRIPE_SECRET_KEY:"sk_test_fixture",STRIPE_BASE_URL:"https://dev.1m8.ai/portal"});
  if(process.env.TEST_POSTGRES_URL)Object.assign(process.env,{FIRSTMEASURE_DATABASE_MODE:"postgres",DATABASE_URL:process.env.TEST_POSTGRES_URL,POSTGRES_AUTO_MIGRATE:"false",POSTGRES_POOL_MAX:"4"});
  await import("../platform/capability_defs.js");await import("../assistant/capabilities.js");billing=await import("../platform-billing/subscriptions.js");store=await import("../platform-billing/storage.js");service=await import("../platform-billing/service.js");storage=await import("../platform/storage.js");caps=await import("../platform/capabilities.js");
  for(const [product,capability,monthly] of [["sms","apps.messaging",3000],["ai","apps.assistant",3000],["free","apps.equipment",0]] as const) {
    const price=await service.createPrice({product_id:product,name:product,capability_key:capability,monthly_cents:monthly},"operator");await service.publishPrice(price.id,"operator");if(product==="sms")sms=price;if(product==="ai")ai=price;if(product==="free")free=price;
  }
});
after(async()=>{await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();});
async function org(id:string) {await storage.createOrganization({id,name:id});await caps.saveCapabilityValues(id,{"platform.expanded_access":true,"apps.messaging":true,"apps.assistant":true,"apps.equipment":true});await service.setAccount(id,true,"operator");}
test("first checkout charges first month; add-on charges only proration and preserves the paid plan",async()=>{
  const f=stripeBillingFixture();try{
    await org("checkout_delta");const original=(await storage.readGlobal("checkout_delta")).data;
    const q=await billing.quoteSubscription("checkout_delta",sms.id);assert.equal(q.current_monthly_cents,0);assert.equal(q.new_monthly_cents,3000);assert.equal(q.due_now_cents,3000);
    assert.equal((await store.records("checkout_delta","subscription")).length,0);
    const replies=await Promise.all([billing.acceptSubscription("checkout_delta",q.id,"owner"),billing.acceptSubscription("checkout_delta",q.id,"owner")]);assert.ok(replies.every(r=>r.paid));assert.equal(f.creates,1);
    const next=await billing.quoteSubscription("checkout_delta",ai.id);assert.equal(next.current_monthly_cents,3000);assert.equal(next.new_monthly_cents,6000);assert.equal(next.due_now_cents,1500);assert.equal(next.items.length,2);
    await billing.acceptSubscription("checkout_delta",next.id,"owner");assert.equal(f.mutations,1);assert.equal((await store.records("checkout_delta","subscription")).length,2);
    const update=f.calls.find(c=>c.route.startsWith("subscriptions/")&&c.fields.has("payment_behavior"))!;
    assert.equal(update.fields.get("payment_behavior"),"pending_if_incomplete");assert.equal(update.fields.get("proration_behavior"),"always_invoice");assert.equal(update.fields.get("proration_date"),String(next.proration_date));assert.equal(update.fields.get("items[1][price]"),null);
    assert.equal((await service.estimate("checkout_delta",new Date().toISOString().slice(0,7))).total_cents,0,"prepaid fees must not reappear in usage invoices");assert.deepEqual((await storage.readGlobal("checkout_delta")).data,original);
    const local=(await store.records<any>("checkout_delta","subscription"))[0];await billing.cancelRecurring("checkout_delta",local.id,"owner");assert.ok((await store.record<any>("checkout_delta","subscription",local.id)).ends_at);assert.equal([...f.subscriptions.values()][0].items.data.length,1);
  }finally{f.restore();}
});
test("declined and asynchronous add-on payments cannot grant access; verified retry activates once",async()=>{
  const f=stripeBillingFixture();try{
    await org("checkout_decline");await billing.acceptSubscription("checkout_decline",(await billing.quoteSubscription("checkout_decline",sms.id)).id,"owner");
    f.paid=false;const q=await billing.quoteSubscription("checkout_decline",ai.id);const result=await billing.acceptSubscription("checkout_decline",q.id,"owner");assert.ok("pending" in result&&result.pending);assert.ok("url" in result&&result.url?.startsWith("https://invoice.stripe.com"));
    assert.equal((await service.applyEntitlements("checkout_decline",{"apps.assistant":true}))["apps.assistant"],false);
    const sub=[...f.subscriptions.values()][0];sub.latest_invoice.status="paid";sub.items.data.push(sub.pending_update.item);sub.pending_update=null;
    await billing.reconcileSubscriptions("checkout_decline","test");await billing.reconcileSubscriptions("checkout_decline","test");assert.equal((await store.records("checkout_decline","subscription")).length,2);
    assert.equal((await service.applyEntitlements("checkout_decline",{"apps.assistant":true}))["apps.assistant"],true);
    const local=(await store.records<any>("checkout_decline","subscription")).find(s=>s.product_id===ai.product_id);local.paid_through="2000-01-01T00:00:00.000Z";await store.put("checkout_decline","subscription",local.id,local);sub.latest_invoice.status="open";sub.status="past_due";
    await billing.reconcileSubscriptions("checkout_decline","test");assert.equal((await service.applyEntitlements("checkout_decline",{"apps.assistant":true}))["apps.assistant"],false);
    sub.latest_invoice.status="paid";sub.status="active";await billing.reconcileSubscriptions("checkout_decline","test");assert.equal((await service.applyEntitlements("checkout_decline",{"apps.assistant":true}))["apps.assistant"],true);
  }finally{f.restore();}
});
test("lost responses reuse persisted requests and concurrent different quotes cannot double charge",async()=>{
  const f=stripeBillingFixture();try{
    await org("checkout_retry");const q=await billing.quoteSubscription("checkout_retry",sms.id);const competing=await billing.quoteSubscription("checkout_retry",ai.id);
    f.loseResponse=true;await assert.rejects(billing.acceptSubscription("checkout_retry",q.id,"owner"),/response was lost/);assert.equal((await store.records("checkout_retry","subscription")).length,0);
    await assert.rejects(billing.acceptSubscription("checkout_retry",competing.id,"owner"),{code:"billing_checkout_pending"});
    assert.equal((await billing.acceptSubscription("checkout_retry",q.id,"owner")).paid,true);assert.equal(f.creates,1);
    const keys=f.calls.filter(c=>c.route==="checkout/sessions").map(c=>c.key);assert.equal(keys[0],keys[1]);
    const upgrade=await billing.quoteSubscription("checkout_retry",ai.id);f.loseResponse=true;await assert.rejects(billing.acceptSubscription("checkout_retry",upgrade.id,"owner"));assert.equal((await billing.acceptSubscription("checkout_retry",upgrade.id,"owner")).paid,true);assert.equal(f.mutations,1);
  }finally{f.restore();}
});
test("stale quotes, changed amounts, wrong tenants and mismatched payments fail closed",async()=>{
  const f=stripeBillingFixture();try{
    await org("checkout_guards");let q=await billing.quoteSubscription("checkout_guards",sms.id);q.expires_at="2000-01-01T00:00:00.000Z";await store.put("checkout_guards","quote",q.id,q);
    await assert.rejects(billing.acceptSubscription("checkout_guards",q.id,"owner"),{code:"billing_quote_expired"});await assert.rejects(billing.acceptSubscription("another_org",q.id,"owner"),{code:"billing_quote_missing"});assert.equal(f.creates,0);
    q=await billing.quoteSubscription("checkout_guards",sms.id);f.paid=false;await billing.acceptSubscription("checkout_guards",q.id,"owner");const session=[...f.sessions.values()][0];session.payment_status="paid";session.amount_total++;
    await assert.rejects(billing.reconcileSubscriptions("checkout_guards","test"),{code:"billing_payment_mismatch"});assert.equal((await store.records("checkout_guards","subscription")).length,0);
    session.amount_total--;session.payment_status="unpaid";await billing.cancelPurchase("checkout_guards",q.id);assert.equal((await store.record<any>("checkout_guards","purchase",q.id)).status,"expired");
    f.paid=true;await billing.acceptSubscription("checkout_guards",(await billing.quoteSubscription("checkout_guards",sms.id)).id,"owner");
    const upgrade=await billing.quoteSubscription("checkout_guards",ai.id);f.proration++;await assert.rejects(billing.acceptSubscription("checkout_guards",upgrade.id,"owner"),{code:"billing_quote_changed"});assert.equal(f.mutations,0);
    await caps.saveCapabilityValues("checkout_guards",{"apps.assistant":false});await assert.rejects(billing.quoteSubscription("checkout_guards",ai.id),{code:"billing_feature_unavailable"});
  }finally{f.restore();}
});
test("free products activate without contacting Stripe",async()=>{
  const f=stripeBillingFixture();try{await org("checkout_free");const q=await billing.quoteSubscription("checkout_free",free.id);assert.equal(q.due_now_cents,0);await billing.acceptSubscription("checkout_free",q.id,"owner");assert.equal(f.calls.length,0);assert.equal((await store.records("checkout_free","subscription")).length,1);}finally{f.restore();}
});

test("SMS tier changes preserve used messages, pause at limit, and resume after renewal",async()=>{
 const f=stripeBillingFixture();try{
  const allowances=await import("../platform-billing/allowances.js");
  const basic=await service.createPrice({product_id:"sms",plan_key:"basic",name:"SMS Basic",capability_key:"apps.messaging",monthly_cents:3000,allowances:{sms_messages:2}},"operator");await service.publishPrice(basic.id,"operator");
  const advanced=await service.createPrice({product_id:"sms",plan_key:"advanced",name:"SMS Advanced",capability_key:"apps.messaging",monthly_cents:10000,allowances:{sms_messages:5}},"operator");await service.publishPrice(advanced.id,"operator");
  await org("sms_tiers");await billing.acceptSubscription("sms_tiers",(await billing.quoteSubscription("sms_tiers",basic.id)).id,"owner");
  const reservations=await Promise.all(["a","b","c"].map(id=>allowances.reserveSms("sms_tiers",id)));assert.equal(reservations.filter(Boolean).length,2);
  assert.equal(await allowances.reserveSms("sms_tiers","a"),true,"retry does not consume another message");assert.equal((await allowances.smsAllowance("sms_tiers"))?.paused,true);
  const q=await billing.quoteSubscription("sms_tiers",advanced.id);assert.equal(q.current_monthly_cents,3000);assert.equal(q.new_monthly_cents,10000);assert.ok(q.replaces_item_id);
  f.paid=false;await billing.acceptSubscription("sms_tiers",q.id,"owner");assert.equal((await allowances.smsAllowance("sms_tiers"))?.limit,2);
  const sub=[...f.subscriptions.values()][0];sub.latest_invoice.status="paid";sub.items.data=[sub.pending_update.item];sub.pending_update=null;f.paid=true;
  await billing.reconcileSubscriptions("sms_tiers","test");assert.equal(sub.items.data.length,1);assert.equal((await allowances.smsAllowance("sms_tiers"))?.used,2);assert.equal((await allowances.smsAllowance("sms_tiers"))?.limit,5);assert.equal(await allowances.reserveSms("sms_tiers","c"),true);
  sub.items.data[0].current_period_start=Math.floor(Date.now()/1000)+10;sub.items.data[0].current_period_end+=30*86400;
  await billing.reconcileSubscriptions("sms_tiers","test");assert.equal((await allowances.smsAllowance("sms_tiers"))?.used,0);
 }finally{f.restore();}
});
test("cancel, resume and cancel again are independent idempotent operations, including past due",async()=>{
 const f=stripeBillingFixture();try{
  await org("resume_plan");await billing.acceptSubscription("resume_plan",(await billing.quoteSubscription("resume_plan",sms.id)).id,"owner");
  const local=(await store.records<any>("resume_plan","subscription"))[0],sub=[...f.subscriptions.values()][0];
  sub.status="past_due";sub.latest_invoice.status="open";
  await billing.cancelRecurring("resume_plan",local.id,"owner");assert.equal(sub.cancel_at_period_end,true);
  await billing.resumeRecurring("resume_plan",local.id,"owner");assert.equal(sub.cancel_at_period_end,false);assert.equal((await store.record<any>("resume_plan","subscription",local.id)).ends_at,null);
  await billing.cancelRecurring("resume_plan",local.id,"owner");assert.equal(sub.cancel_at_period_end,true);
  const cancels=f.calls.filter(c=>c.fields.get("cancel_at_period_end")==="true");assert.notEqual(cancels[0]!.key,cancels[1]!.key);
  assert.match((await billing.customerPortal("resume_plan")).url,/^https:\/\/billing.stripe.com/);
  await assert.rejects(billing.customerPortal("wrong_org"),{code:"billing_customer_missing"});
 }finally{f.restore();}
});

test("usage auto-collection survives a lost response, cannot duplicate charges and isolates credit billing",async()=>{
 const f=stripeBillingFixture();try{
  const {collectInvoice}=await import("../platform-billing/collection.js");await org("auto_usage");
  await billing.acceptSubscription("auto_usage",(await billing.quoteSubscription("auto_usage",sms.id)).id,"owner");
  const original=(await storage.readGlobal("auto_usage")).data;
  await store.put("auto_usage","invoice","2020-01",{id:"2020-01",period:"2020-01",currency:"USD",total_cents:1250,status:"open",lines:[]});
  f.loseResponse=true;await assert.rejects(collectInvoice("auto_usage","2020-01"),/response was lost/);
  await collectInvoice("auto_usage","2020-01");await collectInvoice("auto_usage","2020-01");
  assert.equal((await store.record<any>("auto_usage","invoice","2020-01")).status,"paid");
  const creates=f.calls.filter(c=>c.route==="invoices");assert.equal(creates.length,2);assert.equal(creates[0]!.key,creates[1]!.key);assert.equal(creates[0]!.fields.get("collection_method"),"charge_automatically");
  assert.equal(f.calls.filter(c=>c.route==="invoiceitems").length,1);assert.deepEqual((await storage.readGlobal("auto_usage")).data,original);
  await store.put("auto_usage","invoice","2020-02",{id:"2020-02",period:"2020-02",currency:"USD",total_cents:500,status:"open",lines:[]});
  f.paid=false;await collectInvoice("auto_usage","2020-02");assert.equal((await store.record<any>("auto_usage","invoice","2020-02")).status,"open");
  const pending=(await store.record<any>("auto_usage","automatic-invoice","2020-02"));f.invoices.get(pending.stripe_id).status="paid";
  await collectInvoice("auto_usage","2020-02");assert.equal((await store.record<any>("auto_usage","invoice","2020-02")).status,"paid");
 }finally{f.restore();}
});
test("storage limits serialize uploads, credit replaced bytes, and retain files after cancellation",async()=>{
 await org("storage_quota");await caps.saveCapabilityValues("storage_quota",{"platform.free_storage_gb":0});
 const price=await service.createPrice({product_id:"storage",name:"Tiny storage fixture",capability_key:"platform.purchasable_storage",monthly_cents:5,allowances:{storage_bytes:10}},"operator");await service.publishPrice(price.id,"operator");
 const local=await service.subscribe("storage_quota",price.id,"storage-accept","owner");
 const upload=(id:string,n:number)=>storage.storeMediaUpload("storage_quota",{id,fileName:"fixture.txt",contentType:"text/plain",bytes:Buffer.alloc(n)});
 const result=await Promise.allSettled([upload("one",6),upload("two",6)]);assert.equal(result.filter(r=>r.status==="fulfilled").length,1);assert.equal((result.find(r=>r.status==="rejected") as PromiseRejectedResult).reason.code,"billing_storage_allowance");
 const media=await storage.listMedia("storage_quota");await upload(String(media[0]!.id),8);assert.equal((await storage.mediaStorageUsage("storage_quota")).used_bytes,8);
 await service.cancelSubscription("storage_quota",local.id,"owner");const ended=await store.record<any>("storage_quota","subscription",local.id);ended.ends_at="2000-01-01T00:00:00Z";await store.put("storage_quota","subscription",local.id,ended);assert.equal((await storage.mediaStorageUsage("storage_quota")).used_bytes,8);await assert.rejects(upload("three",1),{code:"billing_storage_allowance"});
});

test("resuming a removed add-on cannot renew a different cancelled add-on",async()=>{
 const f=stripeBillingFixture();try{
  await org("resume_multiple");await billing.acceptSubscription("resume_multiple",(await billing.quoteSubscription("resume_multiple",sms.id)).id,"owner");await billing.acceptSubscription("resume_multiple",(await billing.quoteSubscription("resume_multiple",ai.id)).id,"owner");
  const locals=await store.records<any>("resume_multiple","subscription"),one=locals.find(s=>s.product_id==="sms"),two=locals.find(s=>s.product_id==="ai"),sub=[...f.subscriptions.values()][0];
  await billing.cancelRecurring("resume_multiple",one.id,"owner");await billing.cancelRecurring("resume_multiple",two.id,"owner");
  await billing.resumeRecurring("resume_multiple",one.id,"owner");assert.equal(sub.cancel_at_period_end,false);assert.equal(sub.items.data.length,1);assert.equal(sub.items.data[0].price.unit_amount,3000);
  assert.ok((await store.record<any>("resume_multiple","subscription",two.id)).ends_at);
  await billing.resumeRecurring("resume_multiple",two.id,"owner");assert.equal(sub.items.data.length,2);assert.equal((await store.record<any>("resume_multiple","subscription",two.id)).ends_at,null);
 }finally{f.restore();}
});

test("commercial accounts require an SMS plan and receive only free storage before upgrading",async()=>{
 const {reserveSms}=await import("../platform-billing/allowances.js");const {storageAllowance}=await import("../platform-billing/storage-allowance.js");
 await org("commercial_no_plan");assert.equal(await reserveSms("commercial_no_plan","unpaid-delivery"),false);assert.equal(await storageAllowance("commercial_no_plan"),1073741824);
 await service.setAccount("commercial_no_plan",false,"operator");assert.equal(await reserveSms("commercial_no_plan","legacy-delivery"),true);assert.equal(await storageAllowance("commercial_no_plan"),null);
});
