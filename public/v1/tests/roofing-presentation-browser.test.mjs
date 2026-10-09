import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
const require=createRequire(import.meta.url);
const libraries=path.resolve(import.meta.dirname,'../../libraries');
const launch=()=>chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});

test('the roofing presentation is a valid document made of slides, steps and assemblies',()=>{
 const M=require('../../libraries/doc-model/firstmate-doc-model.js');
 const P=require('../../libraries/doc-parts/firstmate-doc-parts.js');
 const deck=require('../../libraries/doc-present/templates/roofing-presentation.js');
 const present=require('../../libraries/doc-present/firstmate-doc-present.js');
 const doc=deck.build({M,P});
 const result=M.validateDocument(doc);
 assert.deepEqual(result.errors,[]);
 assert.deepEqual(M.paperDimensions(doc),{w_pt:960,h_pt:540});
 assert.deepEqual(doc.pages.map(page=>page.id),['cover','about','good_roof','anatomy','choose_shingles','choose_underlayment','choose_leak_barrier','addons','estimate','sign']);
 // Every step acts on a node of its own slide.
 for(const page of doc.pages){const ids=new Set();M.walkNodes({kind:'document',pages:[page]},node=>{ids.add(node.id);});
  for(const step of present.pageSteps(page))for(const action of step.actions)assert.ok(ids.has(action.node),`${page.id}: ${action.node}`);}
 // The layer slides share layer names so "Match & move" can carry the diagram.
 const layers=page=>page.children.map(node=>node.props?.morph_key).filter(Boolean);
 assert.deepEqual(layers(doc.pages[4]),layers(doc.pages[3]));
 assert.equal(doc.pages[4].transition.type,'morph');
 // A selection cannot lose an option's price.
 const price=M.assemblyParts(doc,'asm_shingles').find(part=>part.role==='option.price');
 assert.equal(M.partRemovalBlock(doc,[price.node.id]).assembly,'asm_shingles');
 assert.equal(P.pageForTarget(doc,{group:'underlayment_profile'}),'choose_underlayment');
 assert.equal(P.pageForTarget(doc,{addons:true}),'addons');
});

test('choosing options on the slides changes the price, and the review leads back to each choice',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://deck.test/**',async route=>{const p=new URL(route.request().url()).pathname;
   try{return route.fulfill({contentType:p.endsWith('.html')?'text/html; charset=utf-8':'application/javascript; charset=utf-8',body:await readFile(path.join(libraries,p.replace(/^\/libraries\//,'')))});}catch{return route.fulfill({status:404,body:''});}});
  await page.goto('http://deck.test/libraries/doc-present/dev-present.html');
  await page.waitForFunction(()=>window.player);await page.evaluate(()=>player.ready());
  const total=()=>page.evaluate(()=>player.state().totals.total_cents);
  const shown=selector=>page.locator(`.fmdoc-page[data-fmdp-on] ${selector}`);
  const before=await total();
  await page.evaluate(()=>player.goTo(4,'end',{animate:false}));
  const options=shown('[data-part-assembly="asm_shingles"][data-part-role="option"]');
  assert.equal(await options.count(),3);
  assert.equal(await options.nth(1).getAttribute('aria-checked'),'true');
  assert.match(await options.nth(2).getAttribute('aria-label'),/GAF Timberline UHDZ, \$13,020/);
  await options.nth(2).click();
  await page.waitForFunction(()=>player.state().groups[0].options[2].selected);
  assert.equal(await options.nth(2).getAttribute('aria-checked'),'true');
  assert.equal(await options.nth(1).getAttribute('aria-checked'),'false','choosing one deselects the others');
  assert.equal(await total(),before+1302000-1089200);
  // Add-ons toggle independently.
  await page.evaluate(()=>player.goTo(7,'end',{animate:false}));
  const addons=shown('[data-part-assembly="asm_addons"][data-part-role="option"]');
  await addons.nth(0).click();await addons.nth(1).click();
  await page.waitForFunction(()=>player.state().addons.filter(a=>a.selected).length===2);
  assert.equal(await total(),before+1302000-1089200+248000+96000);
  // The estimate shows what was chosen and the same total; "Change" returns to that slide.
  await page.evaluate(()=>player.goTo(8,'end',{animate:false}));
  await page.waitForTimeout(500);
  // The total has cents and still fits its box.
  assert.ok(await shown('[data-part-assembly="asm_total"][data-part-role="value"]').evaluate(el=>{const run=el.querySelector('span');return run.getBoundingClientRect().right<=el.getBoundingClientRect().right+1;}),'the amount is not cut off');
  // Slides step on with the mouse: Next on a choice slide, and a drag.
  await page.evaluate(()=>player.goTo(4,'end',{animate:false}));
  await shown('[data-node-id="choose_shingles_next"]').click();
  await page.waitForFunction(()=>player.position().page_id==='choose_underlayment');
  await page.mouse.move(300,300);await page.mouse.down();await page.mouse.move(520,310,{steps:6});await page.mouse.up();
  await page.waitForFunction(()=>player.position().page_id==='choose_shingles');
  await page.evaluate(()=>player.goTo(8,'end',{animate:false}));
  await page.waitForTimeout(300);
  // Every selection sits beside its alternatives; clicking one switches it on the spot.
  const chips=shown('[data-part-assembly="asm_compare"][data-part-role="row.option"]');
  assert.equal(await chips.nth(2).getAttribute('aria-checked'),'true','the shingle chosen earlier');
  const beforeSwitch=await total();
  await chips.nth(5).click();
  await page.waitForFunction(()=>player.state().groups[1].options[2].selected);
  assert.equal(await total(),beforeSwitch+226800-142800,'switching underlayment on the estimate slide moves the total');
  // The i button opens that option's details over the total, and closes again.
  const detail=shown('[data-part-assembly="asm_estimate_detail"][data-part-role="detail"]');
  assert.equal(await detail.getAttribute('data-part-open'),null);
  await shown('[data-part-assembly="asm_compare"][data-part-role="row.option.info"]').nth(5).click();
  assert.equal(await detail.getAttribute('data-part-open'),'');
  assert.match(await shown('[data-part-assembly="asm_estimate_detail"][data-part-role="detail.title"]').innerText(),/GAF Tiger Paw/);
  assert.equal(await chips.nth(5).getAttribute('data-part-focus'),'','the row being looked at is marked');
  await shown('[data-part-assembly="asm_estimate_detail"][data-part-role="detail.close"]').click();
  assert.equal(await detail.getAttribute('data-part-open'),null);
  await page.waitForTimeout(350);
  assert.equal((await shown('[data-part-assembly="asm_total"][data-part-role="value"]').innerText()).trim(),'$'+((await total())/100).toLocaleString('en-US',{minimumFractionDigits:2}));
  // On a choice slide, Details opens beside the options without leaving the slide; a hidden slide's panel never shows through.
  await page.evaluate(()=>player.goTo(5,'end',{animate:false}));
  await shown('[data-part-assembly="asm_underlayment"][data-part-role="option.more"]').nth(1).click();
  assert.equal(await shown('[data-part-assembly="asm_underlayment_detail"][data-part-role="detail"]').getAttribute('data-part-open'),'');
  assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('[data-part-assembly="asm_estimate_detail"][data-part-role="detail"]')).visibility),'hidden');
  assert.equal(await page.evaluate(()=>player.position().page_id),'choose_underlayment');
  await page.keyboard.press('Escape');
  // Buttons on slides are nodes with an action.
  await page.evaluate(()=>player.goTo(8,'end',{animate:false}));
  // From the estimate: send it and skip the signature, or go and sign.
  await shown('[data-node-id="est_send"]').click();
  assert.equal(await page.evaluate(()=>window.lastAction),'send');
  await shown('[data-node-id="est_sign"]').click();
  await page.waitForFunction(()=>player.position().page_id==='sign');
  await page.waitForTimeout(700);
  assert.equal(await shown('[data-node-id="sign_widget"]').count(),0);
  await shown('[data-node-id="sign_accept"]').click();
  assert.equal(await page.evaluate(()=>window.lastAction),'sign');
  await shown('[data-node-id="sign_change"]').click();
  assert.equal(await page.evaluate(()=>player.position().page_id),'estimate');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('quick successive picks keep the last one on screen, and Details works when the estimate namespaces its groups',async()=>{
 const browser=await launch();try{
  const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://deck.test/**',async route=>{const p=new URL(route.request().url()).pathname;
   try{return route.fulfill({contentType:p.endsWith('.html')?'text/html; charset=utf-8':'application/javascript; charset=utf-8',body:await readFile(path.join(libraries,p.replace(/^\/libraries\//,'')))});}catch{return route.fulfill({status:404,body:''});}});
  await page.goto('http://deck.test/libraries/doc-present/dev-present.html');
  await page.waitForFunction(()=>window.player);await page.evaluate(()=>player.ready());
  // The same deck on a slow server whose group ids carry a scope-piece prefix.
  await page.evaluate(async()=>{
   const state=FMRoofingPresentation.priceSample(FMRoofingPresentation.sampleState());
   state.groups.forEach(group=>{group.id='piece_1:'+group.id;});
   window.server=JSON.parse(JSON.stringify(state));window.seen=[];
   document.querySelector('#host').replaceChildren();
   window.slow=FMDocPresent.mount(document.querySelector('#host'),{document:FMRoofingPresentation.build(),start:{page:5},live:{state,
    onInput:input=>new Promise(resolve=>setTimeout(()=>{seen.push(input.option);const group=server.groups.find(g=>g.id===input.group_id);group.options.forEach(o=>{o.selected=o.id===input.option;});resolve(JSON.parse(JSON.stringify(FMRoofingPresentation.priceSample(server))));},400))}});
   await slow.ready();
  });
  const options=page.locator('.fmdoc-page[data-fmdp-on] [data-part-assembly="asm_underlayment"][data-part-role="option"]');
  const checked=()=>options.evaluateAll(list=>list.map(el=>el.getAttribute('aria-checked')).join());
  const started=await page.evaluate(()=>slow.state().totals.total_cents);
  await options.nth(1).click();
  // The price moves at once, long before the slow server answers.
  assert.equal(await page.evaluate(()=>slow.state().totals.total_cents),started+168000-142800);
  assert.equal(await page.evaluate(()=>seen.length),0,'nothing has come back from the server yet');
  await page.waitForTimeout(150);await options.nth(2).click();
  assert.equal(await page.evaluate(()=>slow.state().totals.total_cents),started+226800-142800);
  // The answer to the first click arrives while the second is still on its way: nothing flips back.
  for(const wait of [120,200,200]){await page.waitForTimeout(wait);assert.equal(await checked(),'false,false,true');}
  await page.waitForFunction(()=>seen.length===2);
  assert.equal(await checked(),'false,false,true');
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(()=>slow.state().totals.total_cents),started+226800-142800,'the server agrees');
  // Details opens, and the option keeps its selected look.
  await page.locator('.fmdoc-page[data-fmdp-on] [data-part-assembly="asm_underlayment"][data-part-role="option.more"]').nth(1).click();
  assert.equal(await page.locator('.fmdoc-page[data-fmdp-on] [data-part-assembly="asm_underlayment_detail"][data-part-role="detail"]').getAttribute('data-part-open'),'');
  assert.match(await page.locator('.fmdoc-page[data-fmdp-on] [data-part-assembly="asm_underlayment_detail"][data-part-role="detail.title"]').innerText(),/FeltBuster/);
  assert.equal(await options.nth(1).evaluate(el=>getComputedStyle(el).outlineStyle),'solid','looking at an option does not change its outline');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
