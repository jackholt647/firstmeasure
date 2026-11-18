import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

// FM-549: on a phone the portal's own bar carries the tab's name, so the Equipment app shows no second header; its views and
// actions fit one row, filters fold behind one button, drawers and editors are bottom sheets, and Maintenance works with the
// portal's promise-based dialogs.
test('equipment fits a phone: one header, one toolbar row, folded filters, bottom sheets', async () => {
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),headless:true});
  try {
    const page = await browser.newPage({viewport:{width:433,height:870},isMobile:true,hasTouch:true});
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await page.setContent('<meta name="viewport" content="width=device-width,initial-scale=1"><main id="app" style="height:100vh"></main>');
    await page.evaluate(() => {
      window.allUnits=[
        {id:'unit-1',name:'Truck 12',identifier:'T-12',status:'available',revision:1,type_id:'truck',license_plate:'C47821Z',year:'2021',make:'Ford',model:'F-250'},
        {id:'unit-2',name:'Dump trailer A',identifier:'TR-1',status:'down',revision:1}
      ];
      window.types=[{id:'truck',name:'Pickup truck',revision:1,kind:'vehicle',icon:'fa-truck-pickup'}];
      window.unitQueries=[]; window.workOrders=[{id:'wo-1',unit_id:'unit-1',title:'Brakes',status:'open'}]; window.created=[]; window.canceled=[];
      window.FirstMateEmbeddableApps={};
      window.Portal={apps:{registerPortalApp:app=>window.equipmentApp=app},navigation:{registerHandler(){},read:()=>({}),write(){}}};
      window.PlatformAPI={appFlags:{has:(_,flag)=>['maintenance'].includes(flag)}};
      // The portal replaces window.confirm/prompt with dialogs that answer later (platform-ui.js).
      window.confirm=()=>Promise.resolve(false);
      window.EquipmentAPI={
        units:async(_,options={})=>{unitQueries.push(options);const q=String(options.query||'').toLowerCase();return {units:allUnits.filter(u=>(!q||u.name.toLowerCase().includes(q))&&(!options.status||u.status===options.status))};},
        types:async()=>({types}),categories:async()=>({categories:[]}),yards:async()=>({yards:[]}),unit:async(_,id)=>({unit:allUnits.find(u=>u.id===id)}),
        workOrders:async()=>({work_orders:workOrders}),createWorkOrder:async(_,input)=>{created.push(input);return {work_order:{id:'wo-2',...input,status:'open'}};},cancelWorkOrder:async(_,id)=>{canceled.push(id);return {};}
      };
    });
    const source=await readFile(new URL('../../libraries/apps/equipment/app.js',import.meta.url),'utf8');
    await page.addScriptTag({content:source});
    await page.evaluate(()=>window.handle=equipmentApp.mount(document.querySelector('#app'),{orgId:'test'}));
    await page.locator('.eq-card').first().waitFor();

    // One header: the app's own title is hidden; views and the three fleet actions share one row.
    assert.equal(await page.locator('.eq-title').isVisible(),false);
    const row=await page.locator('.eq-top').evaluate(top=>[...top.children].filter(el=>el.offsetParent).map(el=>{const r=el.getBoundingClientRect();return {top:Math.round(r.top),bottom:Math.round(r.bottom),right:r.right};}));
    assert.equal(row.length,4,JSON.stringify(row));
    assert.ok(row.every(box=>box.top>=row[0].top-4&&box.bottom<=row[0].bottom+4),JSON.stringify(row));
    assert.ok(row.every(box=>box.right<=433),JSON.stringify(row));
    for (const name of ['Types','Facilities','Add unit']) assert.equal(await page.getByRole('button',{name,exact:true}).count(),1,name);
    assert.equal(await page.locator('.eq-shell').evaluate(el=>el.scrollWidth<=el.clientWidth),true);

    // Filters fold behind one button; the count of active filters shows on it.
    assert.equal(await page.locator('[data-eq-filter="status"]').isVisible(),false);
    await page.locator('[data-eq-filters-toggle]').click();
    await page.locator('[data-eq-filter="status"]').selectOption('down');
    await page.waitForFunction(()=>document.querySelectorAll('.eq-card').length===1);
    assert.equal(await page.locator('[data-eq-filters-toggle] b').textContent(),'1');
    await page.locator('.eq-count [data-eq-filters-clear]').click();
    await page.waitForFunction(()=>document.querySelectorAll('.eq-card').length===2);

    // Typing in search re-renders the fleet but keeps the caret (and the keyboard) in the box.
    await page.locator('[data-eq-filter="query"]').click();
    await page.keyboard.type('tru',{delay:20});
    await page.waitForFunction(()=>unitQueries.at(-1).query==='tru'&&document.querySelectorAll('.eq-card').length===1);
    await page.keyboard.type('ck',{delay:20});
    assert.equal(await page.locator('[data-eq-filter="query"]').inputValue(),'truck');
    await page.locator('[data-eq-filter="query"]').fill('');
    await page.waitForFunction(()=>document.querySelectorAll('.eq-card').length===2);

    // A unit opens as a bottom sheet across the screen; its photo tile stays beside the name, not over it.
    await page.locator('.eq-card').first().click();
    await page.locator('[data-eq-input="name"]').waitFor();
    await page.locator('.eq-drawer').evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
    const sheet=await page.locator('.eq-drawer').boundingBox();
    assert.ok(sheet.x===0&&Math.round(sheet.width)===433&&Math.round(sheet.y+sheet.height)===870,JSON.stringify(sheet));
    const tile=await page.locator('[data-eq-photo-pick]').boundingBox(), name=await page.locator('[data-eq-input="name"]').boundingBox();
    assert.ok(tile.x+tile.width<=name.x,JSON.stringify({tile,name}));
    assert.ok(await page.locator('[data-eq-input="name"]').evaluate(el=>parseFloat(getComputedStyle(el).fontSize)>=16));
    await page.locator('[data-eq-drawer-close]').click();
    await page.locator('.eq-drawer').waitFor({state:'detached'});

    // Maintenance: a new work order is a sheet (not a chain of prompts), and cancelling waits for the answer.
    await page.locator('[data-eq-view="maintenance"]').click();
    await page.locator('[data-eq-wo-new]').click();
    await page.locator('[data-eq-wo-back] .eq-catalog-modal').evaluate(el=>Promise.all(el.getAnimations().map(a=>a.finished)));
    const woSheet=await page.locator('[data-eq-wo-back] .eq-catalog-modal').boundingBox();
    assert.ok(Math.round(woSheet.width)===433&&Math.round(woSheet.y+woSheet.height)===870,JSON.stringify(woSheet));
    await page.locator('[data-eq-wo-unit]').selectOption('unit-2');
    await page.locator('[data-eq-wo-title]').fill('Fix the tailgate');
    await page.locator('[data-eq-wo-editor-save]').click();
    await page.locator('[data-eq-wo-back]').waitFor({state:'detached'});
    assert.deepEqual(await page.evaluate(()=>created),[{unit_id:'unit-2',title:'Fix the tailgate'}]);
    await page.locator('[data-eq-wo-cancel="wo-1"]').click();
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(()=>canceled),[]);
    const actions=await page.locator('.eq-wo-actions').first().boundingBox();
    assert.ok(actions.x+actions.width<=433-12,JSON.stringify(actions));

    // A desktop keeps its header and inline filters.
    await page.setViewportSize({width:1280,height:900});
    await page.locator('[data-eq-view="fleet"]').click();
    await page.locator('.eq-card').first().waitFor();
    assert.equal(await page.locator('.eq-title').isVisible(),true);
    assert.equal(await page.locator('[data-eq-filters-toggle]').isVisible(),false);
    assert.equal(await page.locator('[data-eq-filter="status"]').isVisible(),true);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
