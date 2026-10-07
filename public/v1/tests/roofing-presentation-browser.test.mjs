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
  assert.match(await shown('[data-part-assembly="asm_review"][data-part-role="review.value"]').first().innerText(),/GAF Timberline UHDZ/);
  assert.equal((await shown('[data-part-assembly="asm_total"][data-part-role="value"]').innerText()).trim(),'$'+((await total())/100).toLocaleString('en-US',{minimumFractionDigits:2}));
  await shown('[data-part-assembly="asm_review"][data-part-role="review.edit"]').nth(1).click();
  assert.equal(await page.evaluate(()=>player.position().page_id),'choose_underlayment');
  // Buttons on slides are nodes with an action.
  await page.evaluate(()=>player.goTo(8,'end',{animate:false}));
  // From the estimate: send it and skip the signature, or go and sign.
  await shown('[data-node-id="est_send"]').click();
  assert.equal(await page.evaluate(()=>window.lastAction),'send');
  await shown('[data-node-id="est_sign"]').click();
  await page.waitForFunction(()=>player.position().page_id==='sign');
  await page.waitForTimeout(700);
  await shown('[data-node-id="sign_accept"]').click();
  assert.equal(await page.evaluate(()=>window.lastAction),'sign');
  await shown('[data-node-id="sign_change"]').click();
  assert.equal(await page.evaluate(()=>player.position().page_id),'estimate');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
