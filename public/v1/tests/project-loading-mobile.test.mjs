import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const read=p=>readFile(new URL('../../../'+p,import.meta.url),'utf8');
const portal=await read('public/portal/index.php');
const section=portal.slice(portal.indexOf('<div id="fmProjectRoutePrecover"'));
const css=section.split('<style>')[1].split('</style>')[0];
const shell=await read('public/libraries/apps/project-request/app.js');
for(const [width,height] of [[320,568],[390,844],[720,500],[740,900],[760,900],[761,900]])test(`project first-paint and managed loading geometry ${width}x${height}`,async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
 const page=await browser.newPage({viewport:{width,height}});
 await page.route('https://loading.test/**',r=>r.fulfill({contentType:'text/html',body:`<style>*{box-sizing:border-box}body{margin:0;font:14px Arial}main.main{margin-top:60px;height:calc(100vh - 60px)}</style><main class="main"></main>`}));
 await page.goto('https://loading.test/');
 await page.evaluate(()=>{document.body.insertAdjacentHTML('beforeend','<div id="fmProjectRoutePrecover" style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center"><div class="fm-pr-shell"><div class="fm-pr-header"><div class="fm-pr-tabs"><span>Overview Reports Photos</span></div><span class="fm-pr-close">&times;</span></div><div class="fm-pr-title"><span class="fm-pr-current">Reports</span><span class="fm-pr-project">Project</span></div><div class="fm-pr-body"><aside class="fm-pr-left"></aside><main class="fm-pr-content"><div class="fm-pr-content-card"></div></main></div></div></div>');});
 await page.addStyleTag({content:css});
 await page.addStyleTag({url:'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css'});await page.evaluate(()=>document.fonts.ready);
 const rect=selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
 const first=await page.evaluate(rect,'.fm-pr-shell');
 if(process.env.EVIDENCE_DIR)await page.screenshot({path:process.env.EVIDENCE_DIR+'/first-'+width+'.png'});
 if(width<=760){
  assert.deepEqual(first,{x:0,y:0,width,height});
  assert.deepEqual(await page.evaluate(rect,'.fm-pr-close'),{x:width-52,y:8,width:44,height:44});
  assert.equal(await page.locator('.fm-pr-tabs').evaluate(e=>getComputedStyle(e).visibility),'hidden');
  assert.equal(await page.locator('.fm-pr-content').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(255, 255, 255)');
 }else{assert.ok(first.y>0);assert.ok(first.width<width);}
 await page.evaluate(()=>{window.Portal={modules:{request:{openingHeader:()=>({title:'Project',identityHtml:'Project',pillsHtml:''})}}};});
 const start=shell.indexOf('  const css = `')+15;
 await page.addStyleTag({content:shell.slice(start,shell.indexOf('\n  `;',start))});
 for(const file of ['window-manager.js','window-shell.js','project-windows.js'])await page.addScriptTag({content:await read('public/libraries/window-manager/'+file)});
 await page.evaluate(()=>{window.record=FirstMateProjectWindows.open({id:'project_test'},{tab:'map'});});
 assert.equal(await page.locator('#fmProjectRoutePrecover').count(),0);
 if(width<=760){
  assert.deepEqual(await page.evaluate(rect,'.fm-project-frame'),first);
  assert.equal((await page.evaluate(rect,'.fm-project-loading-header')).y,0);
  assert.equal(await page.locator('.fm-project-window-loading').evaluate(e=>getComputedStyle(e).gap),'0px');
  assert.deepEqual(await page.evaluate(rect,'[data-window-action=close]'),{x:width-52,y:8,width:44,height:44});
  assert.equal(await page.locator('[data-window-action=minimize]').isVisible(),false);
 }
 await page.setViewportSize({width:390,height:600});
 await page.waitForFunction(()=>document.querySelector('.fm-project-frame').getBoundingClientRect().height===600);
 const resized=await page.evaluate(rect,'.fm-project-frame');
 for(const [key,value] of Object.entries({x:0,y:0,width:390,height:600}))assert.ok(Math.abs(resized[key]-value)<0.1,JSON.stringify(resized));
 await page.locator('[data-window-action=close]').click();assert.equal(await page.locator('.fm-project-frame').count(),0);
 }finally{await browser.close();}
});
