import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

const libraries=new URL('../../libraries/',import.meta.url);
test('shared chrome preserves existing app header spacing and icon contrast',async()=>{
  const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  try{
    const page=await browser.newPage();
    const viewer=await readFile(new URL('apps/projects/viewer.js',libraries),'utf8');
    const rules=['v-head','v-title','v-title>i','v-title h1'].map(selector=>{
      const start=viewer.indexOf('.'+selector+'{');assert.ok(start>=0,selector);
      return viewer.slice(start,viewer.indexOf('}',start)+1);
    }).join('\n');
    const snapshot=()=>page.locator('#projects').evaluate(header=>{
      const s=getComputedStyle(header),icon=getComputedStyle(header.querySelector('i'));
      return {padding:s.padding,minHeight:s.minHeight,background:s.backgroundColor,gap:s.gap,iconColor:icon.color,iconBackground:icon.backgroundColor,iconMargin:icon.marginRight,font:getComputedStyle(header.querySelector('h1')).fontSize};
    });
    for(const width of [1280,600]){
      await page.setViewportSize({width,height:800});
      await page.setContent(`<style>body{margin:0;padding:22px;background:#f0f2f5;font:14px Arial;--primary:#d93025}${rules}</style><div class="v-head" id="projects" data-app-header><div class="v-title"><i class="fas fa-folder-open">▰</i><h1>My Projects</h1></div><button>Manage view</button></div><main></main>`);
      const before=await snapshot();
      await page.evaluate(()=>{delete window.AppChrome;window.FirstMateEmbeddableApps={escapeHtml:value=>String(value)};});
      await page.addScriptTag({content:await readFile(process.env.APP_CHROME_SOURCE || new URL('app-runtime/app-chrome.js',libraries),'utf8')});
      assert.deepEqual(await snapshot(),before,`existing header unchanged at ${width}px`);
      assert.notEqual(before.iconColor,before.iconBackground);
      await page.evaluate(()=>document.querySelector('main').innerHTML=AppChrome.header({title:'Communications',icon:'fa-inbox'}));
      assert.equal(await page.locator('header[data-app-header="shared"]').count(),1);
      assert.ok(await page.locator('header[data-app-header="shared"]').evaluate(e=>parseFloat(getComputedStyle(e).paddingLeft)>0));
    }
  }finally{await browser.close();}
});
