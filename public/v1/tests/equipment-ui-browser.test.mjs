import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

test('equipment keeps status visible, closes saved units, and parks unfinished views', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),headless:true});
  try {
    const page = await browser.newPage();
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.setContent('<main id="app"></main>');
    await page.evaluate(() => {
      window.unit={id:'unit-1',name:'Very long equipment name with ExtraLongUnbrokenEquipmentIdentifier',status:'available',revision:1};
      window.routes=[]; window.programCalls=0; window.failSave=false;
      window.FirstMateEmbeddableApps={};
      window.Portal={apps:{registerPortalApp:app=>window.equipmentApp=app},navigation:{registerHandler(){},read:()=>({}),write:(patch)=>routes.push(patch)}};
      window.PlatformAPI={appFlags:{has:(_,flag)=>['scheduling','maintenance'].includes(flag)}};
      window.EquipmentAPI={units:async()=>({units:[unit]}),types:async()=>({types:[]}),categories:async()=>({categories:[]}),yards:async()=>({yards:[]}),unit:async()=>({unit}),saveUnit:async(_,id,values)=>{if(failSave)throw Error('Save rejected');unit={...unit,...values,revision:unit.revision+1};return {unit};},workOrders:async()=>({work_orders:[]}),dueService:async()=>{programCalls++;return {};},servicePrograms:async()=>{programCalls++;return {};}};
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
    assert.equal(await page.locator('[data-eq-view="timeline"]').count(),0);
    await page.locator('.eq-card').click();
    await page.locator('[data-eq-input="name"]').fill('Updated equipment');
    await page.evaluate(()=>failSave=true);
    await page.locator('[data-eq-drawer-save]').click();
    await page.locator('[data-eq-unit-form-error].show').waitFor();
    assert.equal(await page.locator('[data-eq-drawer-save]').count(),1);
    await page.evaluate(()=>failSave=false);
    await page.locator('[data-eq-drawer-save]').click();
    await page.locator('[data-eq-drawer-save]').waitFor({state:'detached'});
    assert.equal(await page.locator('.eq-card-name strong').textContent(),'Updated equipment');
    assert.equal(await page.evaluate(()=>routes.at(-1).equipmentItem),'');
    await page.locator('[data-eq-view="maintenance"]').click();
    await page.locator('[data-eq-wo-new]').waitFor();
    assert.equal(await page.locator('[data-eq-program-new]').count(),0);
    assert.equal(await page.evaluate(()=>programCalls),0);
    await page.evaluate(()=>handle.applyRoute({tab:'equipment',equipmentView:'timeline'}));
    assert.equal(await page.locator('[data-eq-view="fleet"].on').count(),1);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

