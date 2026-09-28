import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

test('equipment keeps status visible, autosaves edited units, and parks unfinished views', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),headless:true});
  try {
    const page = await browser.newPage();
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.setContent('<main id="app"></main>');
    await page.evaluate(() => {
      window.unit={id:'unit-1',name:'Very long equipment name with ExtraLongUnbrokenEquipmentIdentifier',status:'reserved',status_event:{title:'Sample trailer reservation'},revision:1,type_id:'truck',color:'#ffffff'};
      window.types=[{id:'truck',name:'Truck',revision:1,kind:'vehicle',icon:'fa-truck',color:'#2563eb'}];
      window.routes=[]; window.programCalls=0; window.failSave=false; window.saveCalls=[]; window.saveDelay=0; window.inFlight=0; window.maxInFlight=0;
      window.FirstMateEmbeddableApps={};
      window.Portal={apps:{registerPortalApp:app=>window.equipmentApp=app},navigation:{registerHandler(){},read:()=>({}),write:(patch)=>routes.push(patch)}};
      window.PlatformAPI={appFlags:{has:(_,flag)=>['scheduling','maintenance'].includes(flag)}};
      window.EquipmentAPI={units:async()=>({units:[unit]}),types:async()=>({types}),createType:async(_,values)=>{const type={...values,id:'new-type',revision:1};types.push(type);return {type};},saveType:async(_,id,values)=>{const old=types.find(t=>t.id===id);if(values.expected_revision!==old.revision)throw Error('Type revision conflict');const type={...values,id,revision:old.revision+1};types=types.map(t=>t.id===id?type:t);return {type};},categories:async()=>({categories:[]}),yards:async()=>({yards:[]}),unit:async()=>({unit}),saveUnit:async(_,id,values)=>{saveCalls.push(structuredClone(values));inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);try{if(saveDelay)await new Promise(resolve=>setTimeout(resolve,saveDelay));if(failSave)throw Error('Save rejected');if(values.expected_revision!==unit.revision)throw Error('Revision conflict');unit={...unit,...values,revision:unit.revision+1};return {unit:structuredClone(unit)};}finally{inFlight--;}},workOrders:async()=>({work_orders:[]}),dueService:async()=>{programCalls++;return {};},servicePrograms:async()=>{programCalls++;return {};}};
    });
    const source=process.env.EQUIPMENT_APP_URL ? await (await fetch(process.env.EQUIPMENT_APP_URL)).text() : await readFile(new URL('../../libraries/apps/equipment/app.js',import.meta.url),'utf8');
    await page.addScriptTag({content:source});
    await page.evaluate(()=>window.handle=equipmentApp.mount(document.querySelector('#app'),{orgId:'test'}));
    await page.locator('.eq-card').waitFor();
    for (const width of [360,560,768,1280]) {
      await page.setViewportSize({width,height:900});
      const box=await page.locator('.eq-card').evaluate(card=>{const r=card.getBoundingClientRect(),badge=card.querySelector('.eq-card-status').getBoundingClientRect(),title=card.querySelector('strong');return {right:r.right,badgeRight:badge.right,top:badge.top,cardTop:r.top,titleLines:title.clientHeight/parseFloat(getComputedStyle(title).fontSize),overflow:card.scrollWidth>card.clientWidth};});
      assert.ok(box.badgeRight<=box.right,JSON.stringify(box));assert.ok(box.top-box.cardTop<20);assert.ok(box.titleLines>1.5);assert.equal(box.overflow,false);
    }
    const visualColors = async (selector) => page.locator(selector).evaluate(el => {
      const style=getComputedStyle(el);return {color:style.color,background:style.backgroundColor,border:style.borderTopColor,borderWidth:style.borderTopWidth};
    });
    assert.equal((await visualColors('.eq-card-media')).color,'rgb(217, 48, 37)');
    assert.deepEqual(await visualColors('.eq-card-media .eq-unit-color'),{color:'rgb(217, 48, 37)',background:'rgb(255, 255, 255)',border:'rgb(16, 24, 40)',borderWidth:'2px'});
    await page.locator('[data-eq-types-open]').click();
    await page.locator('[data-eq-type-add]').click();
    await page.locator('[data-eq-catalog-name]').fill('Trailer');
    await page.locator('[data-eq-catalog-kind][value="trailer"]').locator('..').click();
    assert.equal(await page.locator('[data-eq-catalog-color]').count(),0);
    assert.ok(await page.locator('[data-eq-catalog-icon]').count() >= 40);
    assert.equal(await page.locator('.eq-icon-options b').count(),0);
    const help=page.getByRole('button',{name:'About Vehicle',exact:true});
    await help.hover();
    await page.locator('#eq-kind-help-vehicle').waitFor({state:'visible'});
    assert.match(await page.locator('#eq-kind-help-vehicle').textContent(),/license plate.*Driver requirement/);
    await page.setViewportSize({width:360,height:900});
    await help.focus();
    const tooltipBox=await page.locator('#eq-kind-help-vehicle').boundingBox();
    assert.ok(tooltipBox.x>=0 && tooltipBox.x+tooltipBox.width<=360);
    await page.setViewportSize({width:1280,height:900});
    await help.click();
    assert.equal(await page.locator('[data-eq-catalog-kind][value="trailer"]').isChecked(),true);
    await page.locator('[data-eq-catalog-icon][value="fa-tractor"]').locator('..').click();
    await page.locator('[data-eq-catalog-save]').click();
    await page.locator('[data-eq-catalog-back]').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>types.find(t=>t.id==='new-type').icon),'fa-tractor');
    await page.locator('[data-eq-type-edit="truck"]').click();
    assert.equal(await page.locator('[data-eq-catalog-save]').count(),0);
    await page.locator('[data-eq-catalog-name]').fill('Pickup trucks');
    await page.waitForFunction(()=>types.find(t=>t.id==='truck').name==='Pickup trucks');
    assert.equal(await page.locator('#eqSavedToast').textContent(),'Saved');
    await page.locator('[data-eq-catalog-icon][value="fa-car"]').locator('..').click();
    await page.waitForFunction(()=>types.find(t=>t.id==='truck').icon==='fa-car');
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.locator('[data-eq-catalog-back]').waitFor({state:'detached'});
    await page.locator('[data-eq-types-close]').click();
    assert.equal((await visualColors('.eq-card-media')).color,'rgb(217, 48, 37)');
    assert.equal((await visualColors('.eq-card-media')).background,'rgb(242, 244, 247)');
    assert.equal(await page.locator('[data-eq-view="timeline"]').count(),0);
    await page.locator('.eq-card').click();
    const statusPanel=page.locator('.eq-unit-status');
    assert.equal(await statusPanel.locator('.eq-chip').count(),1);
    assert.equal(await page.locator('.eq-drawer-head .eq-chip').count(),0);
    assert.equal(await statusPanel.locator('.eq-status-details p').isVisible(),false);
    await statusPanel.locator('summary').click();
    assert.equal(await statusPanel.locator('.eq-status-details p').textContent(),'Sample trailer reservation');
    await statusPanel.locator('summary').click();
    await page.setViewportSize({width:360,height:900});
    assert.equal(await statusPanel.evaluate(el=>el.scrollWidth>el.clientWidth),false);
    await page.setViewportSize({width:1280,height:900});
    assert.equal(await page.locator('[data-eq-drawer-save]').count(),0);
    // Required fields are not sent blank; the draft remains available to fix.
    await page.locator('[data-eq-input="name"]').fill('');
    await page.locator('[data-eq-autosave-state="unit"].error').waitFor();
    assert.equal(await page.evaluate(()=>saveCalls.length),0);

    await page.evaluate(()=>failSave=true);
    await page.locator('[data-eq-input="name"]').fill('Updated equipment');
    await page.locator('[data-eq-input="color"]').fill('#333333');
    await page.locator('[data-eq-autosave-state="unit"].error').waitFor();
    await page.locator('[data-eq-drawer-close]').click();
    assert.equal(await page.locator('[data-eq-input="name"]').inputValue(),'Updated equipment');
    await page.evaluate(()=>failSave=false);
    await page.locator('[data-eq-autosave-retry]').click();
    await page.waitForFunction(()=>unit.name==='Updated equipment' && unit.color==='#333333');
    assert.equal(await page.locator('[data-eq-input="name"]').count(),1);
    assert.equal(await page.locator('#eqSavedToast').textContent(),'Saved');
    // A later edit must queue behind a slow request, preserving revisions and focus.
    await page.evaluate(()=>{saveDelay=700;saveCalls=[];});
    await page.locator('[data-eq-input="notes"]').fill('First draft');
    await page.waitForFunction(()=>inFlight===1);
    await page.locator('[data-eq-input="notes"]').fill('Latest draft');
    await page.waitForFunction(()=>unit.notes==='Latest draft' && inFlight===0);
    assert.equal(await page.evaluate(()=>maxInFlight),1);
    assert.equal(await page.locator('[data-eq-input="notes"]').inputValue(),'Latest draft');
    assert.equal(await page.locator('[data-eq-input="notes"]').evaluate(el=>document.activeElement===el),true);
    assert.equal(await page.evaluate(()=>saveCalls[1].expected_revision),await page.evaluate(()=>saveCalls[0].expected_revision+1));
    // Closing flushes a change before the typing debounce expires.
    await page.evaluate(()=>saveDelay=0);
    await page.locator('[data-eq-input="type_id"]').selectOption('new-type');
    await page.waitForFunction(()=>unit.type_id==='new-type');
    await page.locator('[data-eq-input="driver_requirement"]').selectOption('driver_license');
    await page.waitForFunction(()=>unit.operator_tag_overrides[0]?.tag_id==='driver_license');

    await page.locator('[data-eq-input="identifier"]').fill('ASSET-42');
    await page.locator('[data-eq-drawer-close]').click();
    await page.locator('[data-eq-input="name"]').waitFor({state:'detached'});
    assert.equal(await page.evaluate(()=>unit.identifier),'ASSET-42');
    assert.equal(await page.locator('.eq-card-name strong').textContent(),'Updated equipment');
    assert.equal(await page.evaluate(()=>routes.at(-1).equipmentItem),'');
    assert.equal((await visualColors('.eq-card-media .eq-unit-color')).background,'rgb(51, 51, 51)');
    assert.equal((await visualColors('.eq-card-media .eq-unit-color')).border,'rgb(255, 255, 255)');
    assert.equal((await visualColors('.eq-card-media')).color,'rgb(217, 48, 37)');
    await page.locator('[data-eq-view="maintenance"]').click();
    await page.locator('[data-eq-wo-new]').waitFor();
    assert.equal(await page.locator('[data-eq-program-new]').count(),0);
    assert.equal(await page.evaluate(()=>programCalls),0);
    await page.evaluate(()=>handle.applyRoute({tab:'equipment',equipmentView:'timeline'}));
    assert.equal(await page.locator('[data-eq-view="fleet"].on').count(),1);
    await page.locator('.eq-card').click();
    await page.locator('[data-eq-input="notes"]').fill('Saved when leaving equipment');
    await page.evaluate(()=>handle.destroy());
    await page.waitForFunction(()=>unit.notes==='Saved when leaving equipment');
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});


