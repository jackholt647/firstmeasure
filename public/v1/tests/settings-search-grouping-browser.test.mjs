import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('People follows a search route while already open and releases its listener on destroy',async()=>{
 const source=await readFile(new URL('../../libraries/apps/people/people-settings.js',import.meta.url),'utf8');
 const browser=await chromium.launch({...(process.platform==='win32'?{channel:'chrome'}:{}),headless:true});
 try{
 const page=await browser.newPage();await page.setContent('<section class="active" id="fixture"></section>');
 await page.evaluate(()=>{
  window.route={sub:'people',settingsView:'users'};window.mounts=[];
  const views=new Map(['users','groups','departments','home','subcontractors'].map(id=>[id,host=>{mounts.push(id);host.textContent=id;return {destroy(){}};}]));
  window.FirstMatePeople={kit:{esc:String,t:(_,fallback)=>fallback,term:(_,fallback)=>fallback},views:{get:id=>views.get(id),register:(id,fn)=>views.set(id,fn)},data:{allows:()=>true,subscribe:()=>()=>{}},hoverCard:{hide(){}}};
  window.Portal={navigation:{read:()=>route,write:patch=>Object.assign(route,patch)}};
 });
 await page.addScriptTag({content:source});
 await page.evaluate(()=>{window.instance=FirstMatePeople.settings.mount(document.querySelector('#fixture'));});
 assert.equal(await page.locator('[data-people-view]').textContent(),'users');
 await page.evaluate(()=>{route.settingsView='departments';dispatchEvent(new CustomEvent('fm:route-state:updated'));});
 await page.waitForFunction(()=>document.querySelector('[data-people-view]').textContent==='departments');
 await page.evaluate(()=>{route.settingsView='users';dispatchEvent(new CustomEvent('fm:route-state:updated'));});
 await page.waitForFunction(()=>document.querySelector('[data-people-view]').textContent==='users');
 await page.evaluate(()=>{instance.destroy();route.settingsView='groups';dispatchEvent(new CustomEvent('fm:route-state:updated'));});
 await page.waitForTimeout(50);assert.deepEqual(await page.evaluate(()=>mounts),['users','departments','users']);
 }finally{await browser.close();}
});
