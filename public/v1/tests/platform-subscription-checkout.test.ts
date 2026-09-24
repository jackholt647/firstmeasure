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
