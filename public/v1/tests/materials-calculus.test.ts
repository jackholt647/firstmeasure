import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PublicationContext } from "../platform/publication/contracts.js";
let root: string;
let service: typeof import("../materials/calculus.js");
let storage: typeof import("../platform/storage.js");
const auth = { orgId: "calculus", userId: "owner", role: "owner", permissions: { "*": true }, capabilities: { effectiveByKey: { "platform.materials": true, "platform.documents": true, "platform.pricebook": true } }, applicationAccess: { management: { enabled: true, permissions: { "*": true } } } };
const ctx = { auth, organizationId: "calculus", executionKind: "api", mode: "command" } as unknown as PublicationContext;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "materials-calculus-"));
  process.env.NODE_ENV = "test"; process.env.PLATFORM_STORAGE_ROOT = root; process.env.PLATFORM_HEARTBEAT_DISABLED = "1";
  process.env.PRICEBOOK_STORAGE_ROOT = path.join(root, "pricebook");
  if (process.env.TEST_POSTGRES_URL) Object.assign(process.env, { FIRSTMATE_ENV: "test", FIRSTMEASURE_DATABASE_MODE: "postgres", DATABASE_URL: process.env.TEST_POSTGRES_URL, POSTGRES_POOL_MAX: "4", POSTGRES_AUTO_MIGRATE: "false", FIRSTMEASURE_ARTIFACT_STORAGE: "local" });
  storage = await import("../platform/storage.js"); service = await import("../materials/calculus.js");
  await storage.createOrganization({ id: "calculus" });
  (await import("../platform/publication/bootstrap.js")).initializePublication();
});
after(async () => {
  await (await import("./helpers/platform-fixture.js")).closePlatformFixtureStores();
  await (await import("../platform/publication/bindings.js")).closeBindingStoreForTests();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function project() { const id = `project_${randomUUID()}`; await storage.upsertDocument("calculus", "projects", { id, data: {} }); return id; }
const definition = (quantity=20) => ({ type: "materials_calculus", key: "roof", title: "Roof", bindings: {}, inputSchema: { type: "object", properties: { quantity: { type: "number", minimum: 0 } }, required: ["quantity"], additionalProperties: false }, defaults: { quantity }, source: `return {outputs:{lines:[{key:'shingles',product_id:'hdz',name:'HDZ',quantity:inputs.values.quantity,unit:'bundle',explanation:'Explicit quantity'}],warnings:[]}};` });
async function command(p: string, operation: string, input: Record<string, unknown>, revision?: number) { const ledger = await service.readMaterialsLedger(ctx,p); return service.materialsCommand(ctx,p,{key:randomUUID(),expected_revision:revision??ledger.revision,operation,input}); }
async function materialSet(p: string, quantity=20) {
  const created=await command(p,"create",{definition:definition(quantity)});const id=String(created.result.set_id);
  const evaluated=await command(p,"evaluate",{set_id:id,values:{}});
  await command(p,"apply",{set_id:id,evaluation_id:evaluated.result.evaluation_id});
  return (await service.readMaterialsLedger(ctx,p)).sets.find(s=>s.id===id)!;
}
test("independent duplicate materials retain their sets through a shared partial delivery",async()=>{
  const p=await project(),a=await materialSet(p),b=await materialSet(p);
  const ordered=await command(p,"order",{supplier:"Test supplier",lines:[{set_id:a.id,line_id:a.lines[0]!.id,quantity:20},{set_id:b.id,line_id:b.lines[0]!.id,quantity:20}]});
  assert.equal(ordered.ledger.orders[0]!.lines.length,2);
  assert.deepEqual(ordered.ledger.sets.map(s=>s.lines[0]!.quantity),[20,20]);
  const allocations=ordered.ledger.orders[0]!.lines.map(a=>a.id);
  const delivery=await command(p,"delivery",{title:"Shared delivery",date:"2026-10-10",allocations});
  await command(p,"receive",{allocation_id:allocations[0]!,quantity:7,delivery_id:delivery.result.delivery_id,reason:"Partial receipt"});
  const ledger=await service.readMaterialsLedger(ctx,p);
  assert.equal(ledger.sets[0]!.lines[0]!.balance.received,7);assert.equal(ledger.sets[1]!.lines[0]!.balance.received,0);
  await assert.rejects(command(p,"receive",{allocation_id:allocations[0]!,quantity:14,delivery_id:delivery.result.delivery_id,reason:"Too much"}),/exceeds/);
  await assert.rejects(command(p,"delivery",{title:"Duplicate",date:"2026-10-10",allocations}),/already assigned/);
  await command(p,"cancel",{allocation_id:allocations[0],quantity:2,reason:"Supplier cancellation"});
  await command(p,"return",{allocation_id:allocations[0],quantity:2,reason:"Damaged bundles returned"});
  await command(p,"price",{allocation_id:allocations[0],unit_cost:35,currency:"USD",reason:"Supplier quote"});
  await command(p,"price",{allocation_id:allocations[0],unit_cost:33,currency:"USD",reason:"Supplier credit"});
  const changed=await command(p,"reschedule",{delivery_id:delivery.result.delivery_id,date:"2026-10-12",reason:"Remaining shipment delayed"});
  assert.equal(changed.ledger.sets[0]!.lines[0]!.balance.outstanding,4);
  assert.equal(changed.ledger.sets[0]!.lines[0]!.balance.received,5);
  assert.equal(changed.ledger.orders[0]!.lines[0]!.unit_cost,33);
  assert.equal(changed.ledger.deliveries[0]!.date,"2026-10-12");
  assert.equal(((changed.ledger.events.filter(e=>e.operation==="price")[1]!.result as any).previous).unit_cost,35);
});
test("remove/add amendments retain commitments, expose excess and preserve immutable history",async()=>{
  const p=await project(),set=await materialSet(p,10),old=set.lines[0]!;
  await command(p,"order",{supplier:"Test",lines:[{set_id:set.id,line_id:old.id,quantity:10}]});
  const line={key:old.key,name:old.name,product_id:old.product_id,unit:old.unit,quantity:15,replaces:old.id};
  let changed=await command(p,"amend",{set_id:set.id,set_revision:1,remove:[old.id],add:[line],reason:"Larger roof"});
  assert.equal(changed.ledger.sets[0]!.lines[0]!.balance.outstanding,5);
  assert.equal(changed.ledger.orders[0]!.lines[0]!.quantity,10);
  assert.equal((changed.ledger.sets[0]!.history[1]!.removed as any[])[0]!.quantity,10);
  let current=changed.ledger.sets[0]!.lines[0]!;
  changed=await command(p,"amend",{set_id:set.id,set_revision:2,remove:[current.id],add:[{...line,replaces:current.id,quantity:8}],reason:"Reduced work"});
  assert.equal(changed.ledger.sets[0]!.lines[0]!.balance.excess,2);
  current=changed.ledger.sets[0]!.lines[0]!;
  changed=await command(p,"amend",{set_id:set.id,set_revision:3,remove:[current.id],add:[{...line,replaces:current.id,quantity:8,product_id:"other"}],reason:"Substitution"});
  assert.equal(changed.ledger.sets[0]!.lines[0]!.balance.outstanding,8);
  assert.equal(changed.ledger.unallocated[0]!.excess,10);
  await assert.rejects(command(p,"amend",{set_id:set.id,set_revision:1,remove:[],add:[],reason:"stale"}),/changed/);
});
test("atomic revision preconditions and durable receipts reject races and payload reuse",async()=>{
  const p=await project(),set=await materialSet(p,10),ledger=await service.readMaterialsLedger(ctx,p);
  const request={key:randomUUID(),expected_revision:ledger.revision,operation:"amend",input:{set_id:set.id,set_revision:1,remove:[set.lines[0]!.id],add:[],reason:"Remove work"}};
  const outcomes=await Promise.allSettled([service.materialsCommand(ctx,p,request),service.materialsCommand(ctx,p,{...request,key:randomUUID()})]);
  assert.equal(outcomes.filter(o=>o.status==="fulfilled").length,1);
  const winner=outcomes[0]!.status==="fulfilled"?request:null;
  if(winner){const repeated=await service.materialsCommand(ctx,p,winner);assert.equal(repeated.duplicate,true);await assert.rejects(service.materialsCommand(ctx,p,{...winner,input:{...winner.input,reason:"Different"}}),/different operation/);}
  const after=await service.readMaterialsLedger(ctx,p);assert.equal(after.sets[0]!.lines.length,0);assert.equal(after.sets[0]!.history.length,2);
});
test("invalid outputs, missing data and effects cannot replace accepted requirements",async()=>{
  const p=await project(),set=await materialSet(p);
  await assert.rejects(command(p,"evaluate",{set_id:set.id,values:{quantity:-2}}),/schema/);
  const bad={...definition(),source:"await api.actions.invoke('buy', {}); return {outputs:{lines:[]}};"};
  const created=await command(p,"create",{definition:bad});
  await assert.rejects(command(p,"evaluate",{set_id:created.result.set_id}),/cannot invoke/);
  assert.equal((await service.readMaterialsLedger(ctx,p)).sets[0]!.lines[0]!.quantity,20);
  await assert.rejects(command(p,"amend",{set_id:set.id,set_revision:1,remove:["not-a-line"],add:[],reason:"Invalid"}),/Removal/);
});
test("project and user authorization protects mutation and reads",async()=>{
  const p=await project(),other=await project(),set=await materialSet(p);
  await assert.rejects(service.readMaterialsLedger({...ctx,projectId:other},p),/outside/);
  const denied={...ctx,auth:{...ctx.auth!,role:"member",permissions:{view_materials:true,manage_projects:false}}};
  await assert.rejects(service.materialsCommand(denied,p,{key:randomUUID(),expected_revision:3,operation:"create",input:{definition:definition()}}),/not permitted/);
  await assert.rejects(command(other,"amend",{set_id:set.id,set_revision:1,remove:[],add:[],reason:"wrong project"}),/not found/);
});
test("per-line packaging rounds independently and malformed schemas are rejected",async()=>{
  const p=await project();
  const d={...definition(),source:`return {outputs:{lines:[{key:'one',product_id:'hdz',name:'HDZ',quantity:1.1,unit:'square',packaging:{unit:'bundle',coverage:1/3}},{key:'two',product_id:'hdz',name:'HDZ',quantity:1.1,unit:'square',packaging:{unit:'bundle',coverage:1/3}}]}};`};
  const c=await command(p,"create",{definition:d}),id=c.result.set_id;
  const e=await command(p,"evaluate",{set_id:id});const applied=await command(p,"apply",{set_id:id,evaluation_id:e.result.evaluation_id});
  assert.deepEqual(applied.ledger.sets[0]!.lines.map(l=>l.order_quantity),[4,4]);
  await assert.rejects(command(p,"order",{supplier:"Test",lines:[{set_id:id,line_id:applied.ledger.sets[0]!.lines[0]!.id,quantity:0.5}]}),/whole packages/);
  assert.throws(()=>service.validateDeliverables([definition(),definition()]),/unique/);
});

test("signed deliverables retain accepted values, publish once, and target exact amendment revisions",async()=>{
  const p=await project(),target=await materialSet(p,10);
  const docId=`doc_${randomUUID()}`,snapshotId=`snapshot_${randomUUID()}`;
  await storage.upsertDocument("calculus","documents",{id:docId,data:{project_id:p,params:{quantity:999},branch_id:"default"}});
  const {savePackage}=await import("../documents/signing/store.js");
  const recipe={...definition(),amendment:{set_id:target.id,revision:1,remove:[target.lines[0]!.id],replace_all:false},source:`return {outputs:{lines:[{key:'shingles',product_id:'hdz',name:'HDZ',quantity:inputs.document.params.quantity,unit:'bundle'}]}};`};
  const pkg={id:`package_${randomUUID()}`,organization_id:"calculus",document_id:docId,snapshot_id:snapshotId,status:"open",content:{title:"Change order",params:{quantity:15},outputs:{},materials_deliverables:[recipe]},receipts:{},signers:[],fields:{},created_at:new Date().toISOString(),expires_at:"",content_hash:"accepted-content",source_hash:"accepted-source",review_pdf:"",final_pdf:"",final_pdf_hash:"",disclosure:{version:"1",text:"test",hash:"test"},challenges:{}} as import("../documents/signing/model.js").SigningPackage;
  await savePackage(pkg);
  await assert.rejects(service.publishAcceptedMaterials("calculus",p,docId,snapshotId),/completed/);
  pkg.status="completed";pkg.completed_at=new Date().toISOString();await savePackage(pkg);
  await service.publishAcceptedMaterials("calculus",p,docId,snapshotId);
  const first=await service.readMaterialsLedger(ctx,p);
  await service.publishAcceptedMaterials("calculus",p,docId,snapshotId);
  assert.equal((await service.readMaterialsLedger(ctx,p)).revision,first.revision);
  assert.equal(first.sets.length,2);
  const produced=first.sets[1]!;
  const preview=await command(p,"evaluate",{set_id:produced.id});
  const applied=await command(p,"apply",{set_id:produced.id,evaluation_id:preview.result.evaluation_id});
  assert.equal(applied.ledger.sets[0]!.lines[0]!.quantity,15);
  assert.equal(applied.ledger.sets[1]!.lines.length,0);
  await assert.rejects(service.publishAcceptedMaterials("calculus",await project(),docId,snapshotId),/different project/);
});

test("calculus source publications preserve missing data, package coverage and revoked access",async()=>{
  const p=await project();
  const {readPublishedData}=await import("../platform/publication/providers.js");
  const measurements={provider:"materials-inputs",export:"measurements",target:{scope:"project" as const,organizationId:"calculus",projectId:p}};
  const missing=await readPublishedData(ctx,measurements);assert.equal(missing.status,"missing");
  const catalogRef={provider:"materials-inputs",export:"products",target:{scope:"organization" as const,organizationId:"calculus"}};
  const unavailable=await readPublishedData(ctx,catalogRef);assert.notEqual(unavailable.status,"ready");
  const {getOrganizationPricebook,saveOrganizationCatalog}=await import("../pricebook/storage.js");
  const catalog=await getOrganizationPricebook("calculus");
  await saveOrganizationCatalog("calculus",{...catalog.catalog,items:[...catalog.catalog.items,{id:"coverage_test",name:"Coverage test",unit:"square",order_packaging:{order_unit:"bundle",order_unit_plural:"bundles",packages_per_unit:3}}]},catalog.manifest.revision);
  const available=await readPublishedData(ctx,catalogRef);
  // Source access uses the current principal rather than an artifact's stored author.
  const denied={...ctx,auth:{...ctx.auth!,role:"member",permissions:{view_projects:true,view_pricebook:false}}};
  assert.equal((await readPublishedData(denied,catalogRef)).status,"denied");
  assert.equal(available.status,"ready");
  if(available.status==="ready")assert.equal((available.value as any[]).find(i=>i.id==="coverage_test").packaging.coverage,1/3);
  const recipe={...definition(),bindings:{measurements:{kind:"data",policy:"live",source:measurements}},source:"const m=await api.data.read('measurements');return {outputs:{lines:[]}};"};
  const c=await command(p,"create",{definition:recipe});
  await assert.rejects(command(p,"evaluate",{set_id:c.result.set_id}),/Select a project measurement/);
});

test("browser creates, reviews, amends and orders a material set against the real ledger service",async()=>{
  const {chromium}=await import("playwright-core");
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||"C:/Program Files/Google/Chrome/Application/chrome.exe",headless:true});
  try {
    const p=await project(),page=await browser.newPage({viewport:{width:1200,height:900}}),errors:string[]=[];
    page.on("pageerror",e=>errors.push(e.message));
    const source=await readFile(new URL("../../libraries/apps/materials/calculus-workspace.js",import.meta.url),"utf8");
    await page.route("https://materials.test/**",route=>route.fulfill({contentType:route.request().url().endsWith("workspace.js")?"text/javascript":"text/html",body:route.request().url().endsWith("workspace.js")?source:'<main id="materials" style="height:95vh"></main>'}));
    await page.exposeFunction("materialsRequest",async(_url:string,options?:{body:unknown})=>options?.body?service.materialsCommand(ctx,p,options.body):{ledger:await service.readMaterialsLedger(ctx,p)});
    await page.addInitScript({content:"window.__name = fn => fn;"});
    await page.goto("https://materials.test/");
    await page.evaluate(async(projectId)=>{(window as any).PlatformAPI={baseUrl:()=>"/v1/platform",request:(window as any).materialsRequest};const module=await import("https://materials.test/workspace.js" as string);await module.mountMaterialsCalculus(document.getElementById("materials"),{organizationId:"calculus",projectId});},p);
    await page.getByRole("button",{name:"New material set",exact:true}).click();
    let dialog=page.locator("dialog");
    await dialog.getByLabel("Material",{exact:true}).fill("HDZ shingles");await dialog.getByLabel("Product / SKU",{exact:true}).fill("hdz");await dialog.getByLabel("Quantity",{exact:true}).fill("10");await dialog.getByLabel("Unit",{exact:true}).fill("bundle");
    await dialog.getByRole("button",{name:"Create set",exact:true}).click();await dialog.waitFor({state:"detached"});
    await page.getByRole("button",{name:"Calculate preview",exact:true}).click();await page.locator("dialog").getByRole("button",{name:"Calculate preview",exact:true}).click();await page.locator("dialog").waitFor({state:"detached"});
    await page.getByRole("button",{name:/^Review /}).click();await page.locator("dialog").getByRole("button",{name:"Apply requirements",exact:true}).click();await page.locator("dialog").waitFor({state:"detached"});
    await page.getByRole("button",{name:"Record order",exact:true}).click();dialog=page.locator("dialog");await dialog.getByLabel("Supplier",{exact:true}).fill("Test supplier");await dialog.locator("[data-purchase]").fill("10");await dialog.getByRole("button",{name:"Record commitment"}).click();await dialog.waitFor({state:"detached"});
    await page.getByRole("button",{name:"Amend requirements"}).click();dialog=page.locator("dialog");await dialog.getByLabel("Quantity",{exact:true}).fill("15");await dialog.getByLabel("Reason",{exact:true}).fill("Added work");await dialog.getByRole("button",{name:"Review amendment"}).click();await dialog.getByRole("button",{name:"Apply amendment"}).click();await dialog.waitFor({state:"detached"});
    assert.equal((await service.readMaterialsLedger(ctx,p)).sets[0]!.lines[0]!.balance.outstanding,5);
    await mkdir(new URL("../../../output/materials-calculus-20261003/",import.meta.url),{recursive:true});
    await page.screenshot({path:new URL("../../../output/materials-calculus-20261003/materials-desktop.png",import.meta.url).pathname.replace(/^\/(\w:)/,"$1"),fullPage:true});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
    await page.screenshot({path:new URL("../../../output/materials-calculus-20261003/materials-mobile.png",import.meta.url).pathname.replace(/^\/(\w:)/,"$1"),fullPage:true});
    assert.deepEqual(errors,[]);
  } finally {await browser.close();}
});
