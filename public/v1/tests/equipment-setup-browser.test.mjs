import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// GP-15: the equipment setup's pages (guided-experiences/equipment-setup.js) and the "how many locations" setup step
// (setup-steps/company-profile.js, part locations), mounted as the setup player mounts them, with the library entry
// put on dev (fixtures/equipment-setup-library.json) and the publication layer stubbed.
const library=JSON.parse(await readFile(new URL('./fixtures/equipment-setup-library.json',import.meta.url),'utf8'));
const options=library.guided_experience.find(entry=>entry.id==='equipment.setup').steps[0].options;

async function open(browser,width=1000){
  const page=await browser.newPage({viewport:{width,height:820}});
  await page.route('https://equipment.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.startsWith('/libraries/'))return route.fulfill({contentType:'text/javascript',body:await readFile(new URL('../../'+path.slice(1),import.meta.url),'utf8')});
    return route.fulfill({contentType:'text/html',body:'<html><head><meta name="viewport" content="width=device-width"></head><body style="margin:0;font:14px/1.5 system-ui,sans-serif;--primary:#d93025"><div class="gxs-step"><div class="gxs-titlebar"><h2>Your equipment</h2></div><main id="host" style="padding:16px"></main></div></body></html>'});
  });
  await page.goto('https://equipment.test/');
  return page;
}
async function mountSetup(page,{profile,status}){
  await page.evaluate(({options,profile,status})=>{
    window.__APP={userOrgId:'org1'};window.calls=[];window.completed=0;window.titles=[];window.changes=[];
    window.PlatformAPI={publication:{invoke:async(org,action,target,input,opts)=>{
      calls.push({org,action,target,input:structuredClone(input),key:opts?.idempotencyKey});
      if(window.failApply)throw Error('Equipment could not be saved.');
      const yards=input.facilities.map((row,at)=>({id:row.id||'yard_'+(at+1),name:row.name}));
      return {value:{answered:{applied:true},facilities:yards,equipment:input.equipment.map(row=>({key:row.key,type_id:'t_'+row.key,name:row.name,units:Object.fromEntries(Object.entries(row.units).map(([key,n])=>[yards[input.facilities.findIndex(f=>f.key===key)].id,n]))})),types:input.equipment.length,units:0,applied_at:'now',revision:1,units_added:0}};
    }}};
    const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    window.ctx={options,answer:{},esc,L:(key,fallback)=>typeof key==='object'?key.text:fallback,
      read:async(provider,exported)=>provider==='company-profile'?structuredClone(profile):structuredClone(status),
      change:(patch,summary)=>changes.push({patch,summary}),setTitle:text=>titles.push(text),complete:async()=>{completed++;}};
  },{options,profile,status});
  await page.evaluate(async()=>{const module=await import('/libraries/guided-experiences/equipment-setup.js');window.handle=module.mount(document.getElementById('host'),ctx);});
  await page.waitForSelector('[data-gxe-page=locations]');
}
const heading=page=>page.locator('.gxs-titlebar h2').innerText();

test('a roofer with two locations names them, checks its equipment, counts it per location and sees it set up',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser);
    await mountSetup(page,{profile:{industry:'roofing',company_type:'roofing_contractor',locations:2},status:{facilities:[],equipment:[]}});
    // Locations: one facility per location the company said it works out of.
    assert.equal(await heading(page),'Where do you keep your equipment?');
    assert.deepEqual(await page.locator('[data-gxe-loc-name]').evaluateAll(nodes=>nodes.map(node=>node.value)),['Main shop','Location 2']);
    await page.locator('[data-gxe-loc-name]').nth(1).fill('');
    await page.locator('[data-gxe-next]').click();
    assert.match(await page.locator('[data-gxe-error]').innerText(),/name/,'every location needs a name');
    await page.locator('[data-gxe-loc-name]').nth(1).fill('North yard');
    assert.equal(await page.evaluate(()=>[handle.backDepth(),handle.back()].join()),'0,false','the first page leaves Back to the sheet');
    await page.locator('[data-gxe-next]').click();

    // Equipment: the roofer's kinds in groups, checked like tiles; their own by name.
    await page.waitForSelector('[data-gxe-page=equipment]');
    assert.equal(await heading(page),'What equipment do you use?');
    const offered=await page.locator('[data-gxe-kind]').evaluateAll(nodes=>nodes.map(node=>node.dataset.gxeKind));
    for(const id of ['dump_truck','dump_trailer','dumpster_owned','dumpster_rented','portable_toilet','trailer'])assert.ok(offered.includes(id),id);
    assert.ok(!offered.includes('work_van'),'a roofer is not asked about service vans');
    assert.deepEqual(await page.locator('.gxe-group h3').allInnerTexts().then(list=>list.map(text=>text.toLowerCase())),['getting to the job','hauling debris','on the job site']);
    await page.locator('[data-gxe-next]').click();
    assert.match(await page.locator('[data-gxe-error]').innerText(),/at least one/);
    await page.locator('[data-gxe-kind=dump_truck]').click();
    assert.equal(await page.locator('[data-gxe-kind=dump_truck]').getAttribute('aria-pressed'),'true');
    await page.locator('[data-gxe-kind=dumpster_rented]').click();
    await page.locator('[data-gxe-own] input').fill('Lull <telehandler>');
    await page.locator('[data-gxe-own] button').click();
    assert.equal(await page.locator('[data-gxe-kind=custom_lull_telehandler]').getAttribute('aria-pressed'),'true','their own kind, picked');
    assert.equal(await page.evaluate(()=>[handle.backDepth(),handle.back()].join()),'1,true','the phone\'s back walks the pages');
    await page.waitForSelector('[data-gxe-page=locations]');
    await page.locator('[data-gxe-next]').click();
    await page.locator('[data-gxe-next]').click();

    // How many: a column per location; a rented kind has nothing to count.
    await page.waitForSelector('[data-gxe-page=units]');
    assert.equal(await heading(page),'How many do you have?');
    assert.deepEqual(await page.locator('.gxe-trow.head span').allInnerTexts().then(list=>list.filter(Boolean)),['Main shop','North yard']);
    assert.match(await page.locator('[data-gxe-unit-row=dumpster_rented]').innerText(),/rental company/);
    assert.equal(await page.locator('[data-gxe-unit-row=dumpster_rented] [data-gxe-count]').count(),0);
    const truck=page.locator('[data-gxe-unit-row=dump_truck] [data-gxe-count]');
    assert.deepEqual(await truck.locator('input').evaluateAll(nodes=>nodes.map(node=>node.value)),['1','0'],'one at the main shop to start');
    await truck.nth(0).locator('[data-gxe-plus]').click();
    await truck.nth(1).locator('[data-gxe-plus]').click();
    await page.locator('[data-gxe-unit-row=custom_lull_telehandler] [data-gxe-count]').nth(0).locator('[data-gxe-minus]').click();

    await page.evaluate(()=>{window.failApply=true;});
    await page.locator('[data-gxe-apply]').click();
    await page.waitForFunction(()=>calls.length===1);
    assert.match(await page.locator('[data-gxe-error]').innerText(),/could not be saved/,'a failed save stays on the page with the reason');
    await page.evaluate(()=>{window.failApply=false;window.changed=[];addEventListener('fm:equipment:changed',event=>changed.push(event.detail.source));});
    await page.locator('[data-gxe-apply]').click();
    await page.waitForSelector('[data-gxe-page=done]');
    const sent=await page.evaluate(()=>calls.at(-1));
    assert.equal(sent.action,'equipment.setup.apply');
    assert.deepEqual(sent.target,{scope:'organization',organizationId:'org1'});
    assert.match(sent.key,/^equipment\.setup:org1:/);
    assert.notEqual(sent.key,await page.evaluate(()=>calls[0].key),'a key of its own each time');
    assert.deepEqual(sent.input.facilities,[{key:'loc1',name:'Main shop'},{key:'loc2',name:'North yard'}]);
    const byKey=Object.fromEntries(sent.input.equipment.map(row=>[row.key,row]));
    assert.deepEqual(Object.keys(byKey),['dump_truck','dumpster_rented','custom_lull_telehandler']);
    assert.deepEqual(byKey.dump_truck.units,{loc1:2,loc2:1});
    assert.deepEqual(byKey.dump_truck.provides,[{item:'disposal.debris',capacity:10,per_load:true}]);
    assert.equal(byKey.dump_truck.category,'vehicles');
    assert.deepEqual([byKey.dumpster_rented.ownership,byKey.dumpster_rented.units],['rented',{}]);
    assert.deepEqual([byKey.custom_lull_telehandler.name,byKey.custom_lull_telehandler.units],['Lull telehandler',{loc1:0,loc2:0}],'their words, as plain text');

    // The finish says so, and Done finishes the setup.
    assert.equal(await heading(page),'We’ve set up your equipment');
    assert.equal(await page.locator('.gxe-done').innerText(),'You can adjust your equipment at any time in the Equipment tab.','the title says it is set up; the banner says what next');
    assert.deepEqual(await page.evaluate(()=>changed),['equipment.setup'],'the Equipment tab under the sheet reads its fleet again');
    assert.match(await page.locator('[data-gxe-done=dump_truck]').innerText(),/3 in your fleet · Main shop 2 · North yard 1/);
    assert.equal(await page.evaluate(()=>[handle.backDepth(),handle.back()].join()),'0,false','nothing to go back to once it is written');
    await page.locator('[data-gxe-finish]').click();
    await page.waitForFunction(()=>completed===1);
  }finally{await browser.close();}
});

test('a setup asked again starts from the fleet: its facilities, the kinds it made, checked, with their counts',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser,390);
    await mountSetup(page,{profile:{industry:'roofing',locations:1},status:{facilities:[{id:'yard_a',name:'Shop'},{id:'yard_b',name:'Lot'}],equipment:[{key:'dump_truck',type_id:'t1',name:'Dump trucks',units:{yard_a:2,yard_b:1}},{key:'custom_crane',type_id:'t2',name:'Crane',units:{yard_a:1}}]}});
    assert.deepEqual(await page.locator('[data-gxe-loc-name]').evaluateAll(nodes=>nodes.map(node=>node.value)),['Shop','Lot'],'the fleet has two facilities, more than the one location answered');
    assert.equal(await page.locator('[data-gxe-loc-remove]').count(),0,'a facility the fleet has is not removed here');
    await page.locator('[data-gxe-next]').click();
    assert.equal(await page.locator('[data-gxe-kind=dump_truck]').getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-gxe-kind=custom_crane]').getAttribute('aria-pressed'),'true','a kind of its own made before');
    await page.locator('[data-gxe-next]').click();
    assert.deepEqual(await page.locator('[data-gxe-unit-row=dump_truck] input').evaluateAll(nodes=>nodes.map(node=>node.value)),['2','1']);
    assert.match(await page.locator('[data-gxe-unit-row=dump_truck]').innerText(),/3 in your fleet now/);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no sideways scroll on a phone');
    // On a phone a kind's name has its own line and its counts sit below it, each named by its location.
    const layout=await page.evaluate(()=>{const row=document.querySelector('[data-gxe-unit-row=dump_truck]');const name=row.querySelector('.gxe-name').getBoundingClientRect(),cells=[...row.querySelectorAll('.gxe-cell')].map(cell=>cell.getBoundingClientRect());
      return {below:cells.every(cell=>cell.top>=name.bottom-1),labels:[...row.querySelectorAll('.gxe-at')].map(node=>getComputedStyle(node).display!=='none'?node.textContent:''),overlap:cells[0].right>cells[1].left};});
    assert.deepEqual(layout,{below:true,labels:['Shop','Lot'],overlap:false});
    await page.locator('[data-gxe-apply]').click();
    await page.waitForSelector('[data-gxe-page=done]');
    assert.deepEqual(await page.evaluate(()=>calls[0].input.facilities),[{key:'yard1',id:'yard_a',name:'Shop'},{key:'yard2',id:'yard_b',name:'Lot'}],'facilities go back by id');
  }finally{await browser.close();}
});

test('how many locations: one of the first three, or a number when more',async()=>{
  const browser=await chromium.launch({channel:'chrome',headless:true});
  try{
    const page=await open(browser);
    await page.evaluate(()=>{
      window.changes=[];
      const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.ctx={options:{part:'locations'},answer:{},esc,L:(key,fallback)=>typeof key==='object'?key.text:fallback,read:async(provider,exported)=>exported==='catalog'?{company_types:[],services:[]}:{locations:null},change:(patch,summary)=>changes.push({patch,summary})};
    });
    await page.evaluate(async()=>{const module=await import('/libraries/setup-steps/company-profile.js');window.step=module.mount(document.getElementById('host'),ctx);});
    await page.waitForSelector('[data-count]');
    assert.deepEqual(await page.locator('[data-count] strong').allInnerTexts(),['One location','Two','Three','More than three']);
    assert.equal(await page.evaluate(()=>step.valid()),false,'nothing chosen yet');
    await page.locator('[data-count="2"]').click();
    assert.deepEqual(await page.evaluate(()=>[step.valid(),step.answer(),step.summary()]),[true,{locations:2},'2 locations']);
    assert.equal(await page.locator('[data-more]').isVisible(),false);
    await page.locator('[data-count=more]').click();
    await page.locator('[data-more] input').fill('7');
    assert.deepEqual(await page.evaluate(()=>[step.valid(),step.answer()]),[true,{locations:7}]);
    await page.locator('[data-more] input').fill('40');
    assert.equal(await page.evaluate(()=>step.valid()),false,'at most 20');
    await page.locator('[data-count="1"]').click();
    assert.deepEqual(await page.evaluate(()=>[step.valid(),step.answer(),step.summary()]),[true,{locations:1},'One location']);
  }finally{await browser.close();}
});
