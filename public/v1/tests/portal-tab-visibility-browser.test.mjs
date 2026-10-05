import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('leaving standalone Channels reveals apps before and after it despite inline panel layout',async()=>{
 const core=await readFile(new URL('../../portal/scripts/core.js',import.meta.url),'utf8');
 const channels=await readFile(new URL('../../libraries/apps/channels/app.js',import.meta.url),'utf8');
 const panelCss=[...core.matchAll(/\s*(\.fm-tabpanel[^\n]*\{[^\n]*\})/g)].map(match=>match[1]).join('\n');
 const activate=core.slice(core.indexOf('  function activateTab('),core.indexOf('  // Credits helper'));
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1280,height:800}});
  await page.setContent(`<style>body{margin:0}.main-panels{height:700px;overflow:hidden}${panelCss}</style><nav>${['projects','channels','invoices','financials'].map(id=>`<button class="fm-link" data-tab="${id}">${id}</button>`).join('')}</nav><main class="main-panels">${['projects','channels','invoices','financials'].map(id=>`<div id="tab_${id}" class="fm-tabpanel full-bleed"></div>`).join('')}</main>`);
  await page.evaluate(()=>{
   window.TabRegistry={tabs:new Map(),mounted:new Set(),handles:new Map(),activeId:null};
   window.Portal={currentUser:{identity:{preferences:{left_column_channels:false}}},navigation:{read:()=>({}),registerHandler(){},registerSchema(){}},apps:{registerPortalApp(meta){TabRegistry.tabs.set(meta.tabId,meta);}}};
   window.FirstMateChannels={create(holder){holder.innerHTML='<div style="height:100%;background:#eee">Channels workspace</div>';return {state:{},refresh(){},destroy(){}};}};
   for(const id of ['projects','invoices','financials'])TabRegistry.tabs.set(id,{id,title:id,mount(root){root.innerHTML=`<button data-workspace="${id}" style="width:100%;height:100%">${id} workspace</button>`;}});
   for(const name of ['closeAdvancedAppMenu','updateMobileTabTitle','injectCSS','showPortalTabLoading','setRouteState'])window[name]=()=>{};
   window.terminologyLabel=(_key,title)=>title;
  });
  await page.addScriptTag({content:channels});
  await page.addScriptTag({content:activate+'\nwindow.activateTab=activateTab;document.querySelectorAll(".fm-link").forEach(button=>button.addEventListener("click",()=>activateTab(button.dataset.tab)));'});
  for(const width of [1280,600]){
   await page.setViewportSize({width,height:800});
   for(const id of ['invoices','financials','projects','invoices']){
    await page.locator('[data-tab="channels"]').click();
    assert.equal(await page.locator('#tab_channels').evaluate(el=>getComputedStyle(el).display),'flex');
    await page.locator(`[data-tab="${id}"]`).click();
    assert.equal(await page.locator('#tab_channels').evaluate(el=>getComputedStyle(el).display),'none',`Channels must hide when selecting ${id} at ${width}px`);
    const workspace=page.locator(`[data-workspace="${id}"]`);
    assert.ok(await workspace.isVisible());
    assert.equal(await workspace.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===el;}),true,`${id} receives pointer input`);
    // A delayed mount can finish after navigation and reapply an inline layout.
    await page.locator('#tab_channels').evaluate(el=>el.style.display='flex');
    assert.equal(await page.locator('#tab_channels').evaluate(el=>getComputedStyle(el).display),'none');
   }
  }
 }finally{await browser.close();}
});
