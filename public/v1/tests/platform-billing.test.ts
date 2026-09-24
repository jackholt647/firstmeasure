import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let service:typeof import("../platform-billing/service.js"), store:typeof import("../platform-billing/storage.js");
before(async()=>{
  process.env.FIRSTMATE_ENV="test";
  process.env.PLATFORM_STORAGE_ROOT=await mkdtemp(path.join(os.tmpdir(),"platform-billing-test-"));
  if(process.env.TEST_POSTGRES_URL) Object.assign(process.env,{FIRSTMEASURE_DATABASE_MODE:"postgres",DATABASE_URL:process.env.TEST_POSTGRES_URL,POSTGRES_AUTO_MIGRATE:"false",POSTGRES_POOL_MAX:"4"});
  await import("../platform/capability_defs.js");
  service=await import("../platform-billing/service.js");store=await import("../platform-billing/storage.js");
});
after(async()=>{await store.closeBillingStore();await (await import("../src/database/postgres.js")).closePostgresPools();});
const priceInput={product_id:"sms",name:"SMS",capability_key:"apps.messaging",monthly_cents:1000,rates:[{meter:"sms.outbound_segments",included:100,unit_quantity:1,unit_price_micros:10000}]};
test("catalog protects FirstMeasure, validates rates, versions prices atomically and keeps drafts private",async()=>{
  await assert.rejects(service.createPrice({...priceInput,capability_key:"apps.billing"},"operator"),{code:"billing_capability_invalid"});
  await assert.rejects(service.createPrice({...priceInput,rates:[priceInput.rates[0],priceInput.rates[0]]},"operator"),{code:"billing_duplicate_meter"});
  const versions=await Promise.all(Array.from({length:6},()=>service.createPrice(priceInput,"operator")));
  assert.deepEqual(versions.map(v=>v.version).sort(),[1,2,3,4,5,6]);assert.equal((await service.catalog()).length,0);
  await service.publishPrice("sms_v1","operator");
  assert.equal((await service.catalog()).length,1);
  await assert.rejects(service.createPrice({...priceInput,product_id:"duplicate",capability_key:"apps.equipment"},"operator"),{code:"billing_meter_assigned"});
});
test("subscriptions are idempotent, pin prices and isolate organizations",async()=>{
  const results=await Promise.all(Array.from({length:8},()=>service.subscribe("org_one","sms_v1","request-one","customer")));
  assert.equal(new Set(results.map(s=>s.id)).size,1);
  await service.publishPrice("sms_v2","operator");
  assert.equal((await store.records<any>("org_one","subscription"))[0].price.id,"sms_v1");
  await assert.rejects(service.subscribe("org_one","sms_v2","request-one","customer"),{code:"billing_request_reused"});
  await assert.rejects(service.subscribe("org_one","sms_v2","request-two","customer"),{code:"billing_subscription_exists"});
  assert.equal((await store.records("org_other","subscription")).length,0);
  await assert.rejects(service.cancelSubscription("org_other",results[0]!.id,"other"),{code:"billing_subscription_missing"});
});
test("commercial gating is opt-in, respects active subscriptions and cancellation, and preserves FirstMeasure",async()=>{
  const flags={"apps.messaging":true,"apps.billing":true};
  assert.deepEqual(await service.applyEntitlements("gate",flags),flags);
  await service.setAccount("gate",true,"operator");
  assert.deepEqual(await service.applyEntitlements("gate",flags),{"apps.messaging":false,"apps.billing":true});
  const s=await service.subscribe("gate","sms_v1","gate-request","customer");
  assert.deepEqual(await service.applyEntitlements("gate",flags),flags);
  const cancelled=await service.cancelSubscription("gate",s.id,"customer");assert.ok(cancelled.ends_at!>new Date().toISOString());
  assert.deepEqual(await service.applyEntitlements("gate",flags),flags);
  await store.put("gate","subscription",s.id,{...cancelled,ends_at:"2020-01-01T00:00:00.000Z"});
  assert.equal((await service.applyEntitlements("gate",flags))["apps.messaging"],false);
});
test("usage deduplicates under concurrency and rejects conflicting evidence",async()=>{
  const results=await Promise.all(Array.from({length:12},()=>service.recordUsage("usage","sms.outbound_segments","provider-message",150,"2020-01-05T00:00:00Z")));
  assert.equal(results.filter(Boolean).length,1);
  await assert.rejects(service.recordUsage("usage","sms.outbound_segments","provider-message",151,"2020-01-05T00:00:00Z"),{code:"billing_usage_conflict"});
  await assert.rejects(service.recordUsage("usage","unknown","bad",1,"2020-01-05"),{code:"billing_usage_invalid"});
  await assert.rejects(service.recordUsage("usage","agents.runs","future",1,"2099-01-01"),{code:"billing_future_usage"});
});
test("rating accounts for allowances, time-weighted storage, adjustments and immutable monthly invoices",async()=>{
  const price=await service.createPrice({product_id:"storage",name:"Storage",capability_key:"platform.purchasable_storage",monthly_cents:0,rates:[{meter:"storage.bytes",included:1073741824,unit_quantity:1073741824,unit_price_micros:1_000_000} ]},"operator");
  await service.publishPrice(price.id,"operator");
  const sms=await service.subscribe("rating","sms_v1","rating-sms","customer");
  const storage=await service.subscribe("rating",price.id,"rating-storage","customer");
  for(const s of [sms,storage]) await store.put("rating","subscription",s.id,{...s,starts_at:"2020-01-01T00:00:00.000Z"});
  await service.recordUsage("rating","sms.outbound_segments","sms1",150,"2020-01-05");
  await service.recordUsage("rating","storage.bytes","snap1",2*1073741824,"2020-01-01");
  await service.recordUsage("rating","storage.bytes","snap2",4*1073741824,"2020-01-16");
  const estimate=await service.estimate("rating","2020-01","2020-02-01T00:00:00.000Z");
  assert.equal(estimate.total_cents,1253);assert.equal(estimate.lines.find(l=>l.meter==="storage.bytes")?.amount_cents,203);
  await service.addAdjustment("rating","2020-01",-100,"Courtesy credit","credit-request","operator");
  const invoices=await Promise.all(Array.from({length:8},()=>service.finalizeInvoice("rating","2020-01","operator")));
  assert.ok(invoices.every(i=>i.total_cents===1153));assert.equal((await store.records("rating","invoice")).length,1);
  await service.recordUsage("rating","sms.outbound_segments","late",999,"2020-01-30");
  assert.equal((await service.finalizeInvoice("rating","2020-01","operator")).total_cents,1153);
  await assert.rejects(service.addAdjustment("rating","2020-01",-1,"Late edit","another-request","operator"),{code:"billing_invoice_closed"});
  await assert.rejects(service.finalizeInvoice("rating",new Date().toISOString().slice(0,7),"operator"),{code:"billing_period_open"});
});
test("partial month subscriptions prorate base price and do not bill usage before activation",async()=>{
  const s=await service.subscribe("partial","sms_v1","partial-request","customer");
  await store.put("partial","subscription",s.id,{...s,starts_at:"2020-01-16T12:00:00.000Z"});
  await service.recordUsage("partial","sms.outbound_segments","before",10000,"2020-01-02");
  assert.equal((await service.estimate("partial","2020-01","2020-02-01T00:00:00.000Z")).total_cents,500);
});
