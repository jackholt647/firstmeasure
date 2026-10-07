import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('call department controls stay hidden for one option and filter without mobile overflow',async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:850}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://departments.test/**',route=>route.fulfill({contentType:'text/html',body:'<style>body{margin:0;font-family:Arial}</style><main id="app"></main>'}));
  await page.goto('https://departments.test');
  await page.evaluate(()=>{
   window.__APP={orgId:'org',userId:'manager'};window.requests=[];
   window.context={enabled:true,show_selector:false,departments:[{id:'sales',label:'Inside sales'}],department_ids:['sales'],member_department_ids:['sales']};
   window.AppChrome={resolve:()=> 'history',header:()=>'',tabs:()=>''};
   window.Portal={navigation:{registerSchema(){},registerHandler(){},read:()=>({})},CustomerPhone:{refreshStatus:async()=>({}),status:{permissions:{manage:false}}}};
   window.CommsAPI={customer:async(_org,path)=>{window.requests.push(path);return {department_context:window.context,can_manage_departments:true,calls:[],scripts:[],columns:[],agents:[],tasks:[]};}};
  });
  for(const file of ['communications-ui.js','workspace.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/comms/'+file,import.meta.url),'utf8')});
  await page.addStyleTag({content:await readFile(new URL('../../libraries/apps/comms/communications.css',import.meta.url),'utf8')});
  await page.evaluate(()=>window.handle=Portal.CommunicationsWorkspace.mount(document.querySelector('#app'),{standalone:'history'}));
  await page.waitForFunction(()=>document.querySelector('[data-content]').getAttribute('aria-busy')==='false');
  assert.equal(await page.locator('[data-department]').count(),0);
  await page.evaluate(async()=>{window.context={...window.context,show_selector:true,departments:[...window.context.departments,{id:'production',label:'Production'}],department_ids:['sales','production']};await window.handle.refresh();});
  await page.locator('[data-department]').selectOption('production');
  await page.waitForFunction(()=>window.requests.some(p=>p.includes('department_id=production')));
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'department filter fits mobile toolbar');
  await mkdir(new URL('../../../output/organization-structure-20261007/screenshots/',import.meta.url),{recursive:true});
  await page.screenshot({path:new URL('../../../output/organization-structure-20261007/screenshots/calls-mobile.png',import.meta.url).pathname.replace(/^\/(C:)/,'$1')});
  await page.evaluate(()=>window.handle.destroy());
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
