import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('registered live to-do widget supports completion, edits, filters, denial and narrow layouts',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://widgets.test/**',async route=>{const p=new URL(route.request().url()).pathname;if(p.startsWith('/libraries/'))return route.fulfill({contentType:p.endsWith('.json')?'application/json; charset=utf-8':'application/javascript; charset=utf-8',body:await readFile(new URL('../../libraries/'+p.slice('/libraries/'.length),import.meta.url))});return route.fulfill({contentType:'text/html; charset=utf-8',body:'<style>body{font-family:Arial;background:#f7f8fa;margin:40px}#host{width:500px;max-width:100%}</style><div id="host"></div>'});});
  await page.goto('https://widgets.test/');await page.evaluate(()=>{
   window.__APP={userOrgId:'org'};window.calls=[];window.denied=false;
   window.items=[{id:'a',title:'Send roof estimate',project_id:'p',project_title:'Jane’s roof',priority:3,status:'ready',due_at:'2020-01-01'},{id:'b',title:'Test global to-do item',priority:0,status:'ready',due_at:new Date().toISOString()},{id:'c',title:'Call supplier',priority:1,status:'completed'}];
   window.PlatformAPI={publication:{read:async()=>denied?{status:'denied',message:'Access revoked'}:{status:'ready',value:structuredClone(items)},invoke:async(org,action,target,input,options)=>{calls.push({org,action,target,input,options});if(denied)throw Error('Not permitted');const i=items.find(i=>i.id===target.id);Object.assign(i,input);return {receipt:{status:'succeeded'},value:structuredClone(i)};}}};
  });
  for(const file of ['runtime.js','todo-widgets.js'])await page.addScriptTag({url:'/libraries/platform-widgets/'+file});
  await page.evaluate(()=>{window.handle=FirstMateWidgets.mount(document.querySelector('#host'),{id:'todos.list',version:'1',target:{scope:'organization',organizationId:'org'}},{surface:'assistant'});});
  await page.getByRole('button',{name:'Send roof estimate',exact:true}).waitFor();assert.equal(await page.locator('.ftw-row[data-tone=overdue]').count(),1);assert.equal(await page.getByText('Urgent',{exact:true}).count(),1);
  await mkdir(new URL('../../../output/todo-widget-20261006/',import.meta.url),{recursive:true});
  await page.screenshot({path:new URL('../../../output/todo-widget-20261006/desktop.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
  await page.locator('.ftw').screenshot({path:new URL('../../../output/todo-widget-20261006/desktop-widget.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
  await page.getByRole('checkbox',{name:'Complete Test global to-do item'}).click();await page.waitForFunction(()=>calls.length===1);assert.equal((await page.evaluate(()=>calls[0])).action,'work.todos.transition');
  await page.getByRole('button',{name:'Completed',exact:true}).click();await page.getByRole('button',{name:'Test global to-do item',exact:true}).waitFor();
  await page.getByRole('checkbox',{name:'Reopen Test global to-do item'}).click();await page.waitForFunction(()=>calls.length===2);assert.equal(await page.evaluate(()=>calls[1].input.allow_reopen),true);
  await page.getByRole('button',{name:'Open',exact:true}).click();await page.getByRole('button',{name:'Send roof estimate',exact:true}).click();await page.getByLabel('Title',{exact:true}).fill('Send revised estimate');await page.getByLabel('Priority').selectOption('1');await page.getByRole('button',{name:'Save changes'}).click();await page.getByRole('button',{name:'Send revised estimate',exact:true}).waitFor();
  const saved=await page.evaluate(()=>calls.at(-1));assert.equal(saved.action,'work.todos.patch');assert.equal(saved.target.id,'a');assert.ok(saved.options.idempotencyKey);assert.equal(saved.input.due_at,'2020-01-01');
  await page.getByLabel('Search to-dos').fill('global');assert.equal(await page.locator('.ftw-row').count(),1);await page.getByLabel('Search to-dos').fill('');
  await page.setViewportSize({width:390,height:844});await page.locator('body').evaluate(e=>e.style.margin='12px');const box=await page.locator('.ftw').boundingBox();assert.ok(box.x+box.width<=390);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:new URL('../../../output/todo-widget-20261006/mobile.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
  await page.locator('.ftw').screenshot({path:new URL('../../../output/todo-widget-20261006/mobile-widget.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
  await page.evaluate(()=>denied=true);await page.getByRole('checkbox',{name:'Complete Test global to-do item'}).click();await page.getByRole('alert').getByText('Not permitted').waitFor();assert.equal(await page.getByRole('checkbox',{name:'Complete Test global to-do item'}).getAttribute('aria-checked'),'false');
  await page.getByRole('button',{name:'Test global to-do item',exact:true}).click();assert.equal(await page.locator('.ftw-editor').isVisible(),true);
  await page.getByRole('button',{name:'Refresh to-dos'}).click();await page.getByText('Access revoked').waitFor();assert.equal(await page.locator('.ftw-row').count(),0);assert.equal(await page.locator('.ftw-editor').isVisible(),false);assert.equal(await page.locator('.ftw-editor').innerHTML(),'');
  await page.evaluate(()=>handle.destroy());assert.equal(await page.locator('#host').innerHTML(),'');assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
