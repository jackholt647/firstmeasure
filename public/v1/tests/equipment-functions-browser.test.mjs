import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright-core';

const launch = () => chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),headless:true});
const source = () => process.env.EQUIPMENT_APP_URL ? fetch(process.env.EQUIPMENT_APP_URL).then((response)=>response.text()) : readFile(new URL('../../libraries/apps/equipment/app.js',import.meta.url),'utf8');
async function mount(page, functions){
  await page.setContent('<main id="app"></main>');
  await page.evaluate((available) => {
    window.unit={id:'unit-1',name:'Dumpster 1',status:'available',revision:1,type_id:'dumpster',color:'#ffffff',provides:[]};
    window.types=[{id:'dumpster',name:'Dumpster',revision:1,kind:'other',icon:'fa-dumpster',provides:[{item:'disposal.debris',capacity:6,per_load:false},{item:'hidden.function',capacity:2,per_load:false}]},{id:'truck',name:'Truck',revision:1,kind:'vehicle',icon:'fa-truck',provides:[]}];
    window.created=[]; window.unitSaves=[]; window.functionCalls=0;
    window.FirstMateEmbeddableApps={};
    window.Portal={apps:{registerPortalApp:app=>window.equipmentApp=app},navigation:{registerHandler(){},read:()=>({}),write(){}}};
    window.PlatformAPI={appFlags:{has:()=>false}};
    window.EquipmentAPI={
      units:async()=>({units:[unit]}),types:async()=>({types}),categories:async()=>({categories:[]}),yards:async()=>({yards:[]}),unit:async()=>({unit}),
      functions:async()=>{functionCalls++;return {functions:available};},
      createType:async(_,values)=>{created.push(structuredClone(values));const type={...values,id:'new-type',revision:1};types.push(type);return {type};},
      saveType:async(_,id,values)=>{const old=types.find(t=>t.id===id);const type={...values,id,revision:old.revision+1};types=types.map(t=>t.id===id?type:t);return {type};},
      saveUnit:async(_,id,values)=>{unitSaves.push(structuredClone(values));unit={...unit,...values,revision:unit.revision+1};return {unit:structuredClone(unit)};}
    };
  }, functions);
  await page.addScriptTag({content:await source()});
  await page.evaluate(()=>window.handle=equipmentApp.mount(document.querySelector('#app'),{orgId:'test'}));
  await page.locator('.eq-card').waitFor();
}
const DEBRIS = {id:'disposal.debris',label:'Debris disposal',unit:'yd3',description:'Somewhere for the torn-off material to go.',per_load_default:true,schemas:[{id:'roofing',title:'Roofing',color:'#d49a22'}]};

test('an equipment type says which functions it provides, how much it holds and whether per load', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await mount(page, [DEBRIS]);
    await page.locator('[data-eq-types-open]').click();
    await page.locator('[data-eq-type-edit="dumpster"]').click();
    const row = page.locator('[data-eq-fn-row="disposal.debris"]');
    await row.waitFor();
    assert.equal(await page.locator('[data-eq-fn-row]').count(),1,'only functions the enabled scopes need are offered');
    assert.equal(await row.locator('[data-eq-fn-on]').isChecked(),true);
    assert.equal(await row.locator('[data-eq-fn-capacity]').inputValue(),'6');
    assert.equal(await row.locator('.eq-fn-capacity span').textContent(),'yd³');
    assert.equal(await row.locator('[data-eq-fn-per-load]').isChecked(),false);
    // Descriptions are tooltips, not body text.
    assert.equal(await page.locator('#eq-fn-help-0').isVisible(),false);
    await page.getByRole('button',{name:'About Debris disposal',exact:true}).hover();
    await page.locator('#eq-fn-help-0').waitFor({state:'visible'});
    // The kinds of work that need it are pills in their scope's colour, above the description.
    assert.deepEqual(await page.locator('#eq-fn-help-0 .eq-fn-scope').evaluateAll(nodes=>nodes.map(node=>[node.textContent,getComputedStyle(node).backgroundColor])),[['Roofing','rgb(212, 154, 34)']]);
    assert.match(await page.locator('#eq-fn-help-0').textContent(),/^Roofing\s*Somewhere for the torn-off material to go\.$/);assert.doesNotMatch(await page.locator('#eq-fn-help-0').textContent(),/Needed by/);
    // The amount is a plain, compact field with no stepper arrows.
    assert.equal(await row.locator('[data-eq-fn-capacity]').getAttribute('type'),'text');assert.ok((await row.locator('[data-eq-fn-capacity]').boundingBox()).height<=28);
    await page.getByRole('button',{name:'About per load',exact:true}).focus();
    assert.match(await page.locator('#eq-fn-load-help-0').textContent(),/emptied and used again.*like a dumpster/);
    const tip = await page.locator('#eq-fn-load-help-0').boundingBox(), modal = await page.locator('.eq-catalog-modal').boundingBox();
    assert.ok(tip.x >= modal.x && tip.x + tip.width <= modal.x + modal.width + 1, JSON.stringify({tip,modal}));
    // Edits save by themselves, and a stored function that is not offered here is kept.
    await row.locator('[data-eq-fn-capacity]').fill('10');
    await page.waitForFunction(()=>types.find(t=>t.id==='dumpster').provides.find(p=>p.item==='disposal.debris')?.capacity===10);
    await row.locator('.eq-fn-load').click();
    await page.waitForFunction(()=>types.find(t=>t.id==='dumpster').provides.find(p=>p.item==='disposal.debris')?.per_load===true);
    assert.deepEqual(await page.evaluate(()=>types.find(t=>t.id==='dumpster').provides),[{item:'hidden.function',capacity:2,per_load:false},{item:'disposal.debris',capacity:10,per_load:true}]);
    // Turning it off removes it and disables the rest of the row.
    await row.locator('label').first().click();
    await page.waitForFunction(()=>types.find(t=>t.id==='dumpster').provides.length===1);
    assert.equal(await row.locator('[data-eq-fn-capacity]').isDisabled(),true);
    assert.equal(await row.locator('[data-eq-fn-per-load]').isDisabled(),true);
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.locator('[data-eq-catalog-back]').waitFor({state:'detached'});
    // A new type is created with what it provides. No capacity typed is no capacity, not zero.
    await page.locator('[data-eq-type-add]').click();
    await page.locator('[data-eq-catalog-name]').fill('Dump trailer');
    const fresh = page.locator('[data-eq-fn-row="disposal.debris"]');
    assert.equal(await fresh.locator('[data-eq-fn-on]').isChecked(),false);
    assert.equal(await fresh.locator('[data-eq-fn-capacity]').isDisabled(),true);
    // Turning debris disposal on starts as per load, which is how it is usually met.
    await fresh.locator('label').first().click();
    assert.equal(await fresh.locator('[data-eq-fn-per-load]').isChecked(),true);
    await page.locator('[data-eq-catalog-save]').click();
    await page.locator('[data-eq-catalog-back]').waitFor({state:'detached'});
    assert.deepEqual(await page.evaluate(()=>created[0].provides),[{item:'disposal.debris',per_load:true}]);
    assert.equal(await page.evaluate(()=>functionCalls),1,'the list is read once');
    // Narrow screens: the row wraps instead of overflowing.
    await page.setViewportSize({width:360,height:900});
    await page.locator('[data-eq-type-edit="new-type"]').click();
    assert.equal(await page.locator('.eq-catalog-body').evaluate(el=>el.scrollWidth>el.clientWidth),false);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});

test('the type editor says so when no enabled scope needs a function, and a unit can hold a different amount than its type', async () => {
  const browser = await launch();
  try {
    const page = await browser.newPage();
    const errors=[]; page.on('pageerror', e=>errors.push(e.message));
    await mount(page, []);
    await page.locator('[data-eq-types-open]').click();
    await page.locator('[data-eq-type-edit="truck"]').click();
    assert.match(await page.locator('[data-eq-fn-empty]').textContent(),/None of your enabled scopes needs equipment/);
    assert.equal(await page.locator('[data-eq-fn-row]').count(),0);
    // With nothing offered, renaming the other type still keeps what it stored.
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.locator('[data-eq-type-edit="dumpster"]').click();
    await page.locator('[data-eq-catalog-name]').fill('Roll-off');
    await page.waitForFunction(()=>types.find(t=>t.id==='dumpster').name==='Roll-off');
    assert.equal(await page.evaluate(()=>types.find(t=>t.id==='dumpster').provides.length),2);
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.locator('[data-eq-catalog-back]').waitFor({state:'detached'});
    await page.locator('[data-eq-types-close]').click();
    // The unit: one field per function its type provides, blank meaning what the type holds.
    await page.locator('.eq-card').click();
    const capacity = page.locator('[data-eq-input="provides:disposal.debris"]');
    await capacity.waitFor();
    assert.equal(await page.locator('[data-eq-unit-capacity] input').count(),2);
    assert.equal(await capacity.inputValue(),'');
    assert.equal(await capacity.getAttribute('placeholder'),'6 from the type');
    await capacity.fill('8');
    await page.waitForFunction(()=>unit.provides?.[0]?.capacity===8);
    assert.deepEqual(await page.evaluate(()=>unit.provides),[{item:'disposal.debris',capacity:8}]);
    await capacity.fill('');
    await page.waitForFunction(()=>unit.provides?.length===0);
    // A type that provides nothing has nothing to override.
    await page.locator('[data-eq-input="type_id"]').selectOption('truck');
    await page.waitForFunction(()=>unit.type_id==='truck');
    assert.equal(await page.locator('[data-eq-unit-capacity]').count(),0);
    assert.deepEqual(await page.evaluate(()=>unitSaves.at(-1).provides),[]);
    assert.deepEqual(errors,[]);
  } finally { await browser.close(); }
});
