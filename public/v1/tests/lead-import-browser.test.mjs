import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('lead history filters sources, pages outcomes, opens projects and reviews uncertain deliveries on mobile',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[],reviews=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://leads.test/**',async route=>{
   const url=new URL(route.request().url());let data;
   if(url.pathname.endsWith('/connections'))data={connections:[{id:'lead-source',name:'Google leads',leadSource:true,enabled:true},{id:'photos',name:'Photos',leadSource:false}]};
   else if(url.pathname.endsWith('/review')){reviews.push(route.request().postDataJSON());data={state:'dismissed'};}
   else if(url.pathname.endsWith('/deliveries'))data={items:url.searchParams.has('after')?[{id:'second',state:'rejected',source_id:'email:default',external_id:'second',updated_at:new Date().toISOString(),attempts:1}]:[{id:'first',state:reviews.length?'dismissed':'uncertain',source_id:'connection:'+('a'.repeat(100)),external_id:'lead-'+('x'.repeat(150)),project_id:'project-1',updated_at:new Date().toISOString(),attempts:2}],next:url.searchParams.has('after')?null:'cursor'};
   else return route.fulfill({contentType:'text/html',body:'<style>body{margin:0}#root{height:100dvh}</style><main id="root"></main>'});
   await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
  });
  await page.goto('http://leads.test/');
  await page.evaluate(()=>{window.PlatformAPI={appFlags:{has:()=>true}};window.PlatformAssistant={mountSurface:(host,options)=>{window.assistantOptions=options;host.innerHTML='<div style="height:100%;display:flex;flex-direction:column;padding:16px;box-sizing:border-box"><strong>Assistant</strong><p>'+options.welcome+'</p><textarea style="margin-top:auto" aria-label="Message assistant"></textarea></div>';return {ready:Promise.resolve(),setDraft:value=>host.querySelector('textarea').value=value,destroy:()=>window.assistantDestroyed=true};}};window.FirstMateProjectWindows={open:project=>window.openedProject=project.id};});
  await page.addScriptTag({content:await readFile(new URL('../../libraries/apps/settings/connections.js',import.meta.url),'utf8')});
  await page.evaluate(async()=>{window.leadController=await window.FirstMateConnections.mountLeadSources(document.querySelector('#root'),{orgId:'org'});});
  await page.getByRole('button',{name:/Google leads.*Active/}).waitFor();
  const desktop=await page.evaluate(()=>{const main=document.querySelector('.il-main').getBoundingClientRect(),chat=document.querySelector('[data-chat]').getBoundingClientRect(),button=document.querySelector('[data-connect]').getBoundingClientRect();return {mainTop:main.top,chatTop:chat.top,chatBottom:chat.bottom,buttonWidth:button.width};});
  assert.equal(desktop.mainTop,desktop.chatTop);assert.equal(desktop.chatBottom,800);assert.ok(desktop.buttonWidth<180);
  await page.getByRole('button',{name:'Connect source'}).click();assert.match(await page.getByLabel('Message assistant').inputValue(),/branch default/);
  await mkdir('../../output/lead-ui-20261006/screenshots',{recursive:true});
  await page.screenshot({path:'../../output/lead-ui-20261006/screenshots/desktop.png'});
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Sources & deliveries'}).click();
  assert.equal(await page.getByRole('button',{name:'Photos'}).count(),0);
  await page.getByRole('button',{name:'Open project'}).click();assert.equal(await page.evaluate(()=>window.openedProject),'project-1');
  await page.getByRole('button',{name:'Load more'}).click();await page.getByText('rejected',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Review',exact:true}).click();
  await page.getByLabel('Outcome').selectOption('dismissed');await page.getByLabel('Review note').fill('Checked the retained project; discard this delivery.');
  await page.getByRole('button',{name:'Save review'}).click();await page.getByText('dismissed',{exact:true}).waitFor();
  assert.equal(reviews[0].decision,'dismissed');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no horizontal overflow');
  await page.screenshot({path:'../../output/lead-ui-20261006/screenshots/mobile-sources.png'});
  await page.getByRole('button',{name:'Assistant',exact:true}).click();
  assert.ok(await page.getByLabel('Message assistant').isVisible());assert.equal(await page.locator('.il-main').isVisible(),false);
  const chat=await page.locator('[data-chat]').boundingBox();assert.ok(chat.height>700);
  await page.screenshot({path:'../../output/lead-ui-20261006/screenshots/mobile-assistant.png'});
  await page.evaluate(()=>window.leadController?.destroy());assert.equal(await page.evaluate(()=>window.assistantDestroyed),true);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});


test('lead workspace fits the settings shell with the real shared assistant and compact inbox',async()=>{
 const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1360,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://lead-layout.test/**',async route=>{
   const p=new URL(route.request().url()).pathname;
   if(p.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('../../libraries/'+p.slice(11),import.meta.url),'utf8')});
   if(p.startsWith('/v1/'))return route.fulfill({contentType:'application/json',body:JSON.stringify(p.endsWith('/conversation')?{thread:{id:'lead-thread',subject_id:'connection:setup'}}:p.endsWith('/connections')?{connections:[]}:{items:[],next:null})});
   return route.fulfill({contentType:'text/html',body:`<!doctype html><meta charset="utf-8"><style>body{margin:0;height:100dvh;font:14px system-ui}.cs-wrap.forms-wide .li-panel.active{height:100%}.cs-main>.cs-card{padding:24px;overflow:auto}.li-subtabs{height:36px;margin-bottom:18px}.cs-pane{display:none}.cs-pane.active{display:block}</style><main id="tab_company_settings"><div class="cs-wrap forms-wide"><div class="cs-layout"><div class="cs-main"><div class="cs-card"><section id="csPaneForms" class="cs-pane active"><div class="li-subtabs">Forms · Lead import</div><div id="liPanelEmail" class="li-panel active"><div id="inbox" class="cs-row"><div class="cs-lbl">Unique Lead Inbox</div><div class="li-emailBox"><div class="li-emailCopyBox"><div class="li-emailText">leads+example-branch@inbound.1m8.ai</div><button id="liCopyEmail" aria-label="Copy inbox">Copy</button></div><div class="li-muted">Give this inbox to lead providers that deliver by email.</div></div><div class="li-actions"><button id="liRefresh">Refresh inbox</button><button id="liRegenerate">Regenerate</button></div><div id="liStatus"></div></div><div data-lead-sources-panel></div></div></section></div></div></div></div></main>`});
  });
  await page.goto('http://lead-layout.test/');
  await page.evaluate(()=>{window.__APP={userOrgId:'org'};window.Portal={};window.PlatformAPI={appFlags:{has:()=>true}};window.AssistantAPI={thread:async()=>({thread:{id:'lead-thread',subject_id:'connection:setup'},messages:[]})};});
  for(const name of ['window-manager/window-manager.js','platform-assistant/platform-assistant.js','apps/settings/connections.js'])await page.addScriptTag({url:'/libraries/'+name});
  await page.evaluate(async()=>{window.controller=await FirstMateConnections.mountLeadSources(document.querySelector('[data-lead-sources-panel]'),{orgId:'org',inboxElement:document.querySelector('#inbox')});});
  await page.locator('.ic-chat [data-fma=input]').waitFor();
  const geometry=await page.evaluate(()=>{const root=document.querySelector('.il-root').getBoundingClientRect(),chat=document.querySelector('.ic-chat').getBoundingClientRect(),input=document.querySelector('[data-fma=input]').getBoundingClientRect(),inbox=document.querySelector('#inbox').getBoundingClientRect();document.querySelector('.il-main').insertAdjacentHTML('beforeend','<div style="height:1500px">Additional deliveries</div>');document.querySelector('.il-main').scrollTop=300;return {root,chat,input,inbox,after:document.querySelector('.ic-chat').getBoundingClientRect(),bodyScroll:document.scrollingElement.scrollTop};});
  assert.equal(geometry.chat.top,geometry.root.top);assert.equal(geometry.chat.bottom,900);assert.ok(geometry.input.bottom<=geometry.chat.bottom);assert.equal(geometry.after.top,geometry.chat.top);assert.equal(geometry.bodyScroll,0);assert.ok(geometry.inbox.height<160);
  await page.evaluate(()=>{document.querySelector('.il-main').lastElementChild.remove();document.querySelector('.il-main').scrollTop=0;});
  await page.screenshot({path:'../../output/lead-ui-20261006/screenshots/real-assistant-desktop.png'});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'../../output/lead-ui-20261006/screenshots/real-inbox-mobile.png'});
  await page.getByRole('button',{name:'Assistant',exact:true}).click();await page.screenshot({path:'../../output/lead-ui-20261006/screenshots/real-assistant-mobile.png'});
  assert.ok(await page.locator('.ic-chat [data-fma=input]').isVisible());assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.evaluate(()=>document.querySelector('#csPaneForms').classList.remove('active'));assert.equal(await page.locator('#csPaneForms').isVisible(),false,'leaving Leads hides its workspace');
  await page.evaluate(()=>window.controller.destroy());assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
