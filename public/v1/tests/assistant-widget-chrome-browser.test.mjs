import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('widget owns its card and header; shared close floats outside and inline dismissal can reopen',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://assistant.test/**',async route=>{const p=new URL(route.request().url()).pathname;if(p.startsWith('/libraries/'))return route.fulfill({contentType:p.endsWith('.json')?'application/json; charset=utf-8':'application/javascript; charset=utf-8',body:await readFile(new URL('../../libraries/'+p.slice('/libraries/'.length),import.meta.url))});return route.fulfill({contentType:'text/html; charset=utf-8',body:'<style>body{margin:0;font:14px Arial}.main{height:100vh}</style><main class="main"><div id="mainPanels"><section id="tab_assistant" class="active"></section></div></main>'});});
  await page.goto('https://assistant.test/');await page.evaluate(()=>{
   window.__APP={userOrgId:'org'};window.Portal={};const thread={id:'main'};
   const panel={type:'panel',id:'todo_panel',title:'To-do list',widgets:[{type:'platform_widget',title:'To-do list',widget:{id:'todos.list',version:'1',target:{scope:'organization',organizationId:'org'}}}]};
   window.messages=[{id:'a',role:'assistant',content:'Here are your to-dos.',data:{renders:[panel]}}];window.board=[{id:'board_todos',panel}];
   window.AssistantAPI={context:async()=>({main_thread:thread,threads:[thread],agents:[],dashboard:board}),thread:async()=>({thread,messages}),dashboard:{remove:async()=>{board=[];return {dashboard:[]};}}};
   window.PlatformAPI={publication:{read:async()=>({status:'ready',value:[{id:'t',title:'Test global to-do list item',status:'ready',priority:0}]})}};
  });
  for(const f of ['platform-widgets/runtime.js','platform-widgets/todo-widgets.js','window-manager/window-manager.js','platform-assistant/platform-assistant.js'])await page.addScriptTag({url:'/libraries/'+f});
  await page.evaluate(()=>PlatformAssistant.openFull());await page.locator('[data-fma=boardItems] .ftw').waitFor();
  const card=page.locator('[data-fma=boardItems] .fma-panel');assert.equal(await card.locator(':scope > header').count(),0);assert.equal(await card.locator('.ftw-head strong').count(),1);
  const style=await card.evaluate(e=>{const s=getComputedStyle(e);return {padding:s.padding,border:s.borderWidth,shadow:s.boxShadow};});assert.deepEqual(style,{padding:'0px',border:'0px',shadow:'none'});
  await page.waitForTimeout(350);const w=await card.locator('.ftw').boundingBox(),x=await card.locator('.fma-floating-close').boundingBox();assert.ok(x.x>=w.x+w.width-1&&x.y>=w.y-1,JSON.stringify({w,x}));assert.ok(x.x+x.width<=1440);
  await mkdir(new URL('../../../output/assistant-widget-chrome-20261006/',import.meta.url),{recursive:true});await page.waitForTimeout(350);await page.screenshot({path:new URL('../../../output/assistant-widget-chrome-20261006/side.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
  await page.getByRole('button',{name:'Close panel view',exact:true}).click();await page.locator('[data-fma=msgs] .ftw').waitFor();
  await page.locator('[data-fma=msgs]').getByRole('button',{name:'Close To-do list',exact:true}).click();assert.equal(await page.locator('[data-fma=msgs] .ftw').count(),0);
  await page.locator('[data-fma=msgs] [data-focus-panel=todo_panel]').click();await page.locator('[data-fma=msgs] .ftw').waitFor();
  await page.setViewportSize({width:390,height:844});await page.locator('[data-fma=msgs] .ftw').waitFor();assert.ok(await page.locator('[data-fma=msgs]').evaluate(e=>e.scrollWidth<=e.clientWidth+1));
  assert.equal(await page.locator('[data-fma=msgs] .fm-widget-expand').isVisible(),false);
  await page.screenshot({path:new URL('../../../output/assistant-widget-chrome-20261006/mobile.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
  await page.setViewportSize({width:1440,height:950});await page.getByRole('button',{name:'Open panel view',exact:true}).click();await page.locator('[data-fma=boardItems]').getByRole('button',{name:'Close To-do list',exact:true}).click();assert.equal(await page.locator('[data-fma=boardItems] .ftw').count(),0);assert.equal(await page.locator('[data-fma=msgs] .ftw').count(),0);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
