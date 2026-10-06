import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const settings=await readFile(process.env.SETTINGS_PANE_SOURCE || new URL('../../libraries/apps/settings/company.js',import.meta.url),'utf8');
const paneCss=settings.slice(settings.indexOf('      .cs-pane{'),settings.indexOf('      .embedded-tab-only'));
const switchPanes=settings.match(/panel\.querySelectorAll\('\[data-settings-pane\]'\)\.forEach\([^\n]+/)[0];
const pricebook=await readFile(new URL('../../libraries/pricebook/firstmate-pricebook.js',import.meta.url),'utf8');

test('settings hide a mounted price book when another section is selected',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || (process.platform==='win32'?'C:/Program Files/Google/Chrome/Application/chrome.exe':'/usr/bin/chromium'),headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent(`<style>body{margin:0}main{width:100%;height:800px}${paneCss}</style><nav></nav><main><section class="cs-pane active" data-settings-pane="pricebook"></section><section class="cs-pane" data-settings-pane="company"><button>Company details</button></section><section class="cs-pane" data-settings-pane="money"><button>Money settings</button></section></main>`);
  await page.evaluate(({switchPanes})=>{
   window.fetch=async()=>({ok:true,json:async()=>({items:[]})});
   window.selectSection=new Function('which','const panel=document.querySelector("main");'+switchPanes);
   document.querySelector('nav').innerHTML=['pricebook','company','money'].map(id=>`<button data-section="${id}">${id}</button>`).join('');
   document.querySelector('nav').addEventListener('click',e=>{if(e.target.dataset.section)selectSection(e.target.dataset.section);});
  },{switchPanes});
  await page.addScriptTag({content:pricebook});
  await page.evaluate(()=>FirstMatePricebook.mount(document.querySelector('[data-settings-pane="pricebook"]')));
  await page.locator('.pb-win').waitFor();
  await page.evaluate(()=>{window.retainedPricebook=document.querySelector('.pb-win');});
  for(const width of [1400,600]){
   await page.setViewportSize({width,height:900});
   for(const section of ['company','money','pricebook','company']){
    await page.locator(`[data-section="${section}"]`).click();
    assert.equal(await page.locator('[data-settings-pane]:visible').count(),1);
    assert.equal(await page.locator(`[data-settings-pane="${section}"]`).isVisible(),true);
    assert.equal(await page.locator('.pb-win').isVisible(),section==='pricebook');
    if(section!=='pricebook'){
     const button=page.locator(`[data-settings-pane="${section}"] button`);
     assert.equal(await button.evaluate(e=>{const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e;}),true);
    }
    assert.equal(await page.evaluate(()=>retainedPricebook===document.querySelector('.pb-win')),true);
   }
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
