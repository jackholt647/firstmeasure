import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
const source = file => process.env.COLLABORATION_UI_ROOT ? path.resolve(process.env.COLLABORATION_UI_ROOT,'public/libraries/apps',file) : new URL('../../libraries/apps/'+file,import.meta.url);
const helper=await readFile(source('partners/shared-list.js'),'utf8');
const contactSource=await readFile(source('contacts/app.js'),'utf8');
test('sharing view isolates organizations, exhausts pages, deduplicates qualified identities and fails closed',async()=>{
 let org='local',failed=false;
 const incoming={resource:{owner_org_id:'other',type:'project',id:'same'},owner:{name:'Other'}};
 const second={resource:{owner_org_id:'second',type:'project',id:'same'},owner:{name:'Second'}};
 const requests=[];
 const window={Portal:{cfg:{orgId:'local'}},PlatformAPI:{request:async url=>{requests.push(url);if(failed)throw Object.assign(new Error('revoked'),{status:403});const u=new URL(url);return u.pathname.endsWith('/shared')?{items:[incoming,second],next_cursor:u.searchParams.has('after')?'':'page2'}:{items:[{status:'active',resource:{owner_org_id:'local',type:'project',id:'same'},recipient_org_id:'recipient',recipient:{name:'Recipient'}}]};}}};
 const ctx=vm.createContext({window,document:{getElementById:()=>true},URL,URLSearchParams,localStorage:{getItem:()=>null,setItem(){}},location:{origin:'https://fixture.test'}});vm.runInContext(helper,ctx);
 const view=window.FirstMateSharedList.create('project',()=>org);await view.load();assert.equal(view.incoming.length,2);assert.equal(requests.length,3);
 const change=(kind,checked)=>view.change({target:{checked,dataset:{sharingKind:kind},matches:selector=>selector==='[data-sharing-kind]'}});
 change('ours',false);assert.equal(view.matches({id:'same'}),false);assert.equal(view.matches({_shared:incoming}),true);
 view.change({target:{checked:false,dataset:{sharingOwner:'other'},matches:selector=>selector==='[data-sharing-owner]'}});assert.equal(view.matches({_shared:incoming}),false);assert.equal(view.matches({_shared:second}),true);
 org='new-org';assert.equal(view.incoming.length,0);assert.equal(view.mode,'owned');assert.equal(view.fields(),'');
 await view.load();failed=true;await view.load();assert.equal(view.incoming.length,0);assert.equal(view.badge({id:'same'}),'');
});
test('Contacts integrates shared identities into existing views without exposing local editors',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:850}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://fixture.test/**',r=>r.fulfill({contentType:'text/html',body:'<div id="mainPanels"><main id="app"></main></div>'}));await page.goto('https://fixture.test/');
  await page.evaluate(()=>{
   window.__APP={orgId:'local'};window.opened=[];
   window.Portal={cfg:{orgId:'local'},appFlags:{current:()=>({}),has:()=>true},tabs:{renderTabs(){},activateTab:id=>window.opened.push(id)},apps:{registerPortalApp:app=>{if(app.mount)window.app=app;}},util:{injectCSS:(id,css)=>{const s=document.createElement('style');s.textContent=css;document.head.append(s);}},modules:{contacts:{open:c=>window.opened.push(c.id)}},navigation:{read:()=>({}),registerSchema(){},registerHandler(){}}};
   window.PlatformAPI={projects:{list:async()=>({documents:[{id:'p',data:{contacts:[{id:'same',name:'Our contact',email:'same@example.test'}]}}]})},request:async url=>({items:url.includes('/shared?')?[{resource:{owner_org_id:'other',type:'contact',project_id:'p',id:'same'},data:{name:'External <b>contact</b>',email:'same@example.test'},owner:{name:'Other company'},operations:['read']}]:[]})};
  });
  await page.addScriptTag({content:helper});await page.addScriptTag({content:contactSource});await page.waitForFunction(()=>typeof window.app?.mount==='function');await page.evaluate(()=>window.app.mount(document.querySelector('#app')));
  await page.locator('[data-ct-open-contact^="shared:"]').waitFor();assert.equal(await page.locator('.ct-table-row').count(),2);assert.equal(await page.locator('.fm-shared-list').count(),0);
  await page.locator('[data-ct-manage] summary').click();await page.locator('[data-sharing-kind=ours]').uncheck();assert.equal(await page.locator('.ct-table-row').count(),1);assert.equal(await page.locator('.ct-list-contact strong').innerText(),'External <b>contact</b>');assert.equal(await page.locator('.ct-list-contact strong b').count(),0);
  await page.locator('[data-ct-open-contact^="shared:"]').click();assert.deepEqual(await page.evaluate(()=>window.opened),['partners']);
  await page.locator('[data-sharing-kind=ours]').check();await page.locator('[data-sharing-kind=received]').uncheck();assert.equal(await page.locator('.ct-table-row').count(),1);await page.locator('[data-ct-open-contact]').click();assert.deepEqual(await page.evaluate(()=>window.opened),['partners','same']);
  await page.locator('[data-sharing-kind=received]').check();await page.locator('[data-ct-manage] summary').click();await page.locator('#ctViewTiles').click();assert.equal(await page.locator('.ct-card').count(),2);
  await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('.ct-tools').evaluate(e=>e.getBoundingClientRect().right<=innerWidth));assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
