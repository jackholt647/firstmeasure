import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const base=new URL('../../libraries/apps/settings/',import.meta.url);
const engine=await readFile(new URL('search.js',base),'utf8');
const index=await readFile(new URL('search-index.js',base),'utf8');
const browser=await chromium.launch({...(process.platform==='win32'?{channel:'chrome'}:{}),headless:true});
test.after(()=>browser.close());
async function fixture(html=''){
 const page=await browser.newPage();await page.setContent(`<main id="settings">${html}</main>`);
 await page.addScriptTag({content:index});await page.addScriptTag({content:engine});return page;
}
test('generated coverage includes every shell category, unopened controls and tooltip-only terms',async()=>{
 const page=await fixture();try{
 const result=await page.evaluate(()=>{
  const api=FirstMateSettingsSearch;return {sections:api.catalog.filter(e=>e.kind==='section').map(e=>e.section),queries:Object.fromEntries(['notifications','connections','app download','roof pitch','waste','message templates','mesage templates','company language'].map(q=>[q,api.search(q)]))};
 });
 assert.equal(result.sections.length,28);assert.equal(new Set(result.sections).size,28);
 for(const q of ['notifications','connections','app download','roof pitch','waste','message templates','mesage templates','company language'])assert.ok(result.queries[q].length,q);
 assert.equal(result.queries.waste[0].title,'Waste');
 assert.equal(result.queries['roof pitch'][0].section,'reports');
 assert.equal(result.queries['message templates'][0].view,'templates');
 assert.equal(result.queries['mesage templates'][0].title,'Message templates');
 }finally{await page.close();}
});
test('HTML extraction reads label, help, tooltip and accessible names without indexing values',async()=>{
 const page=await fixture(`<section><h3>Delivery</h3><label for="delay">Delivery delay <small>Wait before dispatch</small></label><input id="delay" value="SECRET_VALUE" aria-describedby="help"><p id="help">Applies during holidays</p><label><strong>Enable receipts</strong><span data-fm-tooltip="Send a receipt after settlement">?</span><input type="checkbox" data-receipts></label><select aria-label="Default language"><option>PRIVATE_OPTION</option></select><textarea aria-label="Internal instructions">SECRET_TEXT</textarea><input type="hidden" aria-label="SECRET_HIDDEN" value="secret"><div data-settings-search-ignore><label>SECRET_IGNORED<input></label></div></section>`);
 try{
 const entries=await page.evaluate(()=>FirstMateSettingsSearch.extract(document.querySelector('main')).map(({element,...e})=>e));
 assert.ok(entries.some(e=>e.title==='Delivery delay'&&e.description.includes('holidays')&&e.description.includes('Wait before dispatch')));
 assert.ok(entries.some(e=>e.title==='Enable receipts'&&e.description.includes('settlement')));
 assert.ok(entries.some(e=>e.title==='Default language'));assert.ok(entries.some(e=>e.title==='Internal instructions'));
 assert.doesNotMatch(JSON.stringify(entries),/SECRET_|PRIVATE_OPTION/);
 }finally{await page.close();}
});
test('new HTML settings are discovered automatically and refresh after async rendering',async()=>{
 const page=await fixture('<section class="active" data-settings-pane="new_app"><h3>New app</h3></section>');
 try{
 await page.evaluate(()=>{FirstMateSettingsSearch.attach(document.querySelector('main'),[{id:'new_app',title:'New app'}],()=>({settingsView:'delivery'}));document.querySelector('section').insertAdjacentHTML('beforeend','<label>Dispatch grace period<input id="grace"></label>');});
 await page.waitForFunction(()=>FirstMateSettingsSearch.search('dispatch grace').length===1);
 const [entry]=await page.evaluate(()=>FirstMateSettingsSearch.search('dispatch grace').map(({element,...e})=>e));
 assert.equal(entry.section,'new_app');assert.equal(entry.view,'delivery');assert.equal(entry.selector,'[id="grace"]');
 await page.evaluate(()=>document.querySelector('label').remove());
 await page.waitForFunction(()=>FirstMateSettingsSearch.search('dispatch grace').length===0);
 }finally{await page.close();}
});
test('a rendered grid of toggle buttons keeps its own labels and focus targets',async()=>{
 const page=await fixture(`<section class="active" data-settings-pane="reports"><div>${['Waste','Pitch','Edges','Area','Images'].map((label,i)=>`<button aria-pressed="true" data-key="toggle_${i}" data-fm-tooltip="Help for ${label}"><span class="rp-label">${label}</span><span class="rp-state">On</span></button>`).join('')}</div></section>`);
 try{
 await page.evaluate(()=>{window.Portal={navigation:{navigate(){}}};FirstMateSettingsSearch.attach(document.querySelector('main'),[{id:'reports',title:'Reports'}],()=>({}));FirstMateSettingsSearch.open(FirstMateSettingsSearch.search('waste')[0]);});
 await page.waitForFunction(()=>document.activeElement?.getAttribute('data-key')==='toggle_0');
 const entries=await page.evaluate(()=>FirstMateSettingsSearch.search('waste').map(({element,...e})=>e));
 assert.equal(entries[0].kind,'control');assert.match(entries[0].description,/Help for Waste/);
 assert.equal(await page.locator('[data-key="toggle_0"]').getAttribute('aria-pressed'),'true');
 }finally{await page.close();}
});
test('available-section filtering and reattachment remove results after access changes',async()=>{
 const page=await fixture();try{
 const result=await page.evaluate(()=>{
  const api=FirstMateSettingsSearch;api.attach(document.querySelector('main'),[{id:'reports',title:'Reports'}],()=>({}));
  const before=api.search('waste').length,forbidden=api.search('company language').length;
  api.attach(document.querySelector('main'),[{id:'company',title:'Company'}],()=>({}));return {before,forbidden,after:api.search('waste').length,restricted:api.search('language',{sections:['my_settings']}).map(e=>e.section)};
 });
 assert.ok(result.before);assert.equal(result.forbidden,0);assert.equal(result.after,0);
 assert.deepEqual(result.restricted,[]);
 }finally{await page.close();}
});
test('Unicode, accents, short prefixes, token order and typo tolerance work without unrelated short-word fuzz',async()=>{
 const page=await fixture();try{
 const r=await page.evaluate(()=>{FirstMateSettingsIndex.entries=[{section:'x',tab:'Settings',title:'Échéance café'},{section:'x',tab:'Settings',title:'通知設定'},{section:'x',tab:'Settings',title:'Message templates'},{section:'x',tab:'Settings',title:'Blank state'}];const api=FirstMateSettingsSearch;return ['echeance cafe','通知','templ mesage','mess','bank','zzzzzz'].map(q=>api.search(q).map(e=>e.title));});
 assert.deepEqual(r,[['Échéance café'],['通知設定'],['Message templates'],['Message templates'],[],[]]);
 }finally{await page.close();}
});
test('selection opens the nested page, waits for async DOM, expands details and focuses without changing values',async()=>{
 const page=await fixture('<section class="active" data-settings-pane="reports"></section>');try{
 await page.evaluate(()=>{
  const pane=document.querySelector('section');window.nav=[];window.writes=0;
  document.addEventListener('change',()=>writes++);document.addEventListener('input',()=>writes++);
  window.Portal={navigation:{navigate:route=>{nav.push(route);setTimeout(()=>pane.innerHTML='<details><summary>Report options</summary><label>Waste allowance<input id="waste" value="12"></label></details>',60);}}};
  FirstMateSettingsSearch.attach(document.querySelector('main'),[{id:'reports',title:'Reports'}],()=>({settingsView:'customer'}));
  FirstMateSettingsSearch.open({section:'reports',view:'customer',title:'Waste allowance',selector:'[id="waste"]'});
 });
 await page.waitForFunction(()=>document.activeElement?.id==='waste');
 assert.equal(await page.locator('details').getAttribute('open'),'');assert.equal(await page.locator('#waste').inputValue(),'12');
 assert.equal(await page.evaluate(()=>writes),0);assert.equal(await page.evaluate(()=>nav[0].settingsView),'customer');
 }finally{await page.close();}
});
test('an unmounted observer releases its attachment and repeated mounts do not retain old entries',async()=>{
 const page=await fixture('<section data-settings-pane="x" class="active"><label>Only once<input></label></section>');try{
 const result=await page.evaluate(()=>{const api=FirstMateSettingsSearch;for(let i=0;i<10;i++)api.attach(document.querySelector('main'),[{id:'x',title:'X'}],()=>({}));return api.search('only once').length;});assert.equal(result,1);
 }finally{await page.close();}
});
test('real catalogue search remains responsive over repeated queries',async()=>{
 const page=await fixture();try{
 const elapsed=await page.evaluate(()=>{const start=performance.now();for(let i=0;i<100;i++)FirstMateSettingsSearch.search(['language','waste','notification','message templates'][i%4]);return performance.now()-start;});
 assert.ok(elapsed<2000,`100 searches took ${elapsed.toFixed(0)}ms`);
 }finally{await page.close();}
});
