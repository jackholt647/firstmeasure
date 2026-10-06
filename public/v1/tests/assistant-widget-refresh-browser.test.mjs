import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('visible inventory targets retained instances, custom refresh animates todos and hard fallback reloads',{timeout:60000},async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1400,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://assistant.test/**',async route=>{const p=new URL(route.request().url()).pathname;if(p.startsWith('/libraries/'))return route.fulfill({contentType:p.endsWith('.json')?'application/json; charset=utf-8':'application/javascript; charset=utf-8',body:await readFile(new URL('../../libraries/'+p.slice('/libraries/'.length),import.meta.url))});return route.fulfill({contentType:'text/html; charset=utf-8',body:'<style>body{margin:0;font:14px Arial}.main{height:100vh}</style><main class="main"><div id="mainPanels"><section id="tab_assistant" class="active"></section></div></main>'});});
  await page.goto('https://assistant.test/');await page.evaluate(()=>{
   window.__APP={userOrgId:'org'};window.Portal={};const thread={id:'main'};
   const panel={type:'panel',id:'todo_panel',title:'To-do list',widgets:[{type:'platform_widget',title:'To-do list',widget:{id:'todos.list',version:'1',target:{scope:'organization',organizationId:'org'},config:{filter:'all'}}}]};
   window.messages=[{id:'a',role:'assistant',content:'Your tasks.',data:{renders:[panel]}}];window.board=[{id:'board_todos',panel}];window.items=[{id:'first',title:'First task',status:'ready',priority:0}];window.sent=[];window.animations=[];
   const animate=Element.prototype.animate;Element.prototype.animate=function(...args){animations.push(this.dataset.id);return animate.apply(this,args);};
   window.AssistantAPI={createThread:async()=>({thread}),context:async()=>({main_thread:thread,threads:[thread],agents:[],dashboard:board}),thread:async()=>({thread,messages}),dashboard:{remove:async()=>{board=[];return {dashboard:[]};}},send:async(org,id,b)=>{sent.push(b);items.push({id:'new'+sent.length,title:'New task '+sent.length,status:'ready',priority:0});const instance=b.ui_context.displayed_widgets[0];return {thread,assistant_message:{id:'reply'+sent.length,role:'assistant',content:'Added task.',data:{renders:instance?[{type:'widget_refresh',instance_id:instance.instance_id}]:[]}},dashboard:board};}};
   window.PlatformAPI={publication:{read:async()=>({status:'ready',value:structuredClone(items)})}};
  });
  for(const f of ['platform-widgets/runtime.js','platform-widgets/todo-widgets.js','window-manager/window-manager.js','platform-assistant/platform-assistant.js'])await page.addScriptTag({url:'/libraries/'+f});
  await page.evaluate(()=>PlatformAssistant.openFull());await page.getByRole('button',{name:'First task',exact:true}).waitFor();await page.getByText('Your tasks.',{exact:true}).waitFor();
  await page.waitForTimeout(350);await page.evaluate(()=>{window.originalWidget=document.querySelector('fm-platform-widget');window.originalRow=document.querySelector('[data-id=first]');});
  await page.locator('[data-fma=input]').fill('Add another task');await page.locator('[data-fma=send]').click();await page.getByRole('button',{name:'New task 1',exact:true}).waitFor();
  assert.equal(await page.locator('fm-platform-widget').count(),1);assert.equal(await page.evaluate(()=>originalWidget===document.querySelector('fm-platform-widget')),true);assert.equal(await page.evaluate(()=>originalRow===document.querySelector('[data-id=first]')),true);assert.ok(await page.evaluate(()=>animations.includes('new1')));
  assert.equal(await page.evaluate(()=>sent[0].ui_context.displayed_widgets[0].widget.id),'todos.list');
  await page.getByRole('button',{name:'Close panel view',exact:true}).click();await page.locator('[data-fma=msgs] .ftw').waitFor();
  await page.evaluate(()=>window.inlineWidget=document.querySelector('fm-platform-widget'));await page.getByLabel('Search to-dos').fill('task');
  await page.locator('[data-fma=input]').fill('Add a third task');await page.locator('[data-fma=send]').click();await page.getByRole('button',{name:'New task 2',exact:true}).waitFor();assert.equal(await page.getByLabel('Search to-dos').inputValue(),'task');assert.equal(await page.evaluate(()=>inlineWidget===document.querySelector('fm-platform-widget')),true);
  await page.getByRole('button',{name:'Close To-do list',exact:true}).click();await page.locator('[data-fma=input]').fill('No visible widget');await page.locator('[data-fma=send]').click();await page.waitForFunction(()=>sent.length===3);assert.deepEqual(await page.evaluate(()=>sent[2].ui_context.displayed_widgets),[]);
  await page.evaluate(async()=>{
   await FirstMateWidgets.ready;window.mounted=0;window.destroyed=0;window.custom=0;
   const def=id=>({id,version:'1',title:id,surfaces:['assistant'],sources:[],configSchema:{properties:{},additionalProperties:false},sizing:{mode:'content'}});
   FirstMateWidgets.register(def('test.hard'),root=>{mounted++;root.textContent='Hard';return {serialize:()=>({selected:'saved'}),destroy(){destroyed++;}};});
   FirstMateWidgets.register(def('test.soft'),root=>{root.textContent='Soft';return {refresh(){custom++;root.textContent='Updated';}};});
   const a=document.createElement('div'),b=document.createElement('div');document.body.append(a,b);window.hard=FirstMateWidgets.mount(a,{id:'test.hard',version:'1'},{surface:'assistant'});window.soft=FirstMateWidgets.mount(b,{id:'test.soft',version:'1'},{surface:'assistant'});await Promise.all([hard.ready,soft.ready]);await hard.refresh();await soft.refresh();
  });
  assert.ok(await page.evaluate(()=>FirstMateWidgets.visibleInstances().some(entry=>entry.widget.id==='test.hard')));assert.ok(await page.evaluate(()=>FirstMateWidgets.visibleInstances().some(entry=>entry.widget.id==='test.soft')));
  assert.deepEqual(await page.evaluate(()=>({mounted,destroyed,custom,state:hard.serialize().state})),{mounted:2,destroyed:1,custom:1,state:{selected:'saved'}});await page.addScriptTag({url:'/libraries/platform-widgets/forms-widgets.js'});
  await page.evaluate(async()=>{
   window.formRevision=1;window.previewUpdates=0;window.formData={form:{name:'Test form',status:'published'},totals:{views:2,starts:1,submissions:0,start_rate:50,completion_rate:0},daily:[{day:'2026-10-06',views:2,submissions:0}],steps:[],questions:[],recent:[],period_days:1};
   window.FormsAPI={get:async()=>({id:'form',name:'Test form',status:'published',revision:formRevision,definition:{steps:[]}}),insights:async()=>structuredClone(formData)};
   window.FirstMateForms={render:({target})=>{target.textContent='Embedded form';return {update(){previewUpdates++;},destroy(){target.replaceChildren();},reset(){}};}};
   for(const [name,id]of [['preview','forms.preview'],['submissions','forms.submissions']]){const el=document.createElement('div');el.id=name;document.body.append(el);window[name+'Handle']=FirstMateWidgets.mount(el,{id,version:'1',target:{scope:'organization',organizationId:'org'},config:{form_id:'form'}},{surface:'assistant'});await window[name+'Handle'].ready;}
  });
  await page.getByText('Embedded form',{exact:true}).waitFor();await page.locator('#submissions .ffs-tile').first().waitFor();
  await page.evaluate(async()=>{window.previewElement=document.querySelector('#preview [data-form]');formRevision++;formData.recent.push({id:'submission',created_at:'2026-10-06T12:00:00Z',contact:{name:'New lead'},summary:[]});formData.totals.submissions=1;await previewHandle.refresh();await submissionsHandle.refresh();});
  await page.getByText('New lead',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>previewElement===document.querySelector('#preview [data-form]')),true);assert.ok(await page.evaluate(()=>previewUpdates>0));assert.ok(await page.evaluate(()=>animations.includes('submission-submission')));
  await page.evaluate(async()=>{FormsAPI.get=async()=>{throw Error('Access revoked');};await previewHandle.refresh();});assert.equal(await page.getByText('Embedded form',{exact:true}).count(),0);await page.locator('#preview').getByText('Access revoked').waitFor();
  await page.addScriptTag({url:'/libraries/platform-widgets/payroll-widgets.js'});
  await page.evaluate(async()=>{
   window.payrollMounts=0;window.payrollRefreshes=0;
   window.FirstMatePayroll={mountView:({root})=>{payrollMounts++;root.textContent='Upcoming payroll';return {refresh(){payrollRefreshes++;},destroy(){},setActive(){}};}};
   PlatformAPI.publication.read=async()=>({status:'ready',value:[]});
   for(const id of ['payroll.upcoming','payroll.ledger']){const root=document.createElement('div');root.dataset.testPayroll=id;document.body.append(root);const handle=FirstMateWidgets.mount(root,{id,version:'1',target:{scope:'organization',organizationId:'org'}},{surface:'assistant'});await handle.ready;root.querySelector('input')?.setAttribute('value','retained');await handle.refresh();}
  });
  assert.deepEqual(await page.evaluate(()=>({mounts:payrollMounts,refreshes:payrollRefreshes})),{mounts:1,refreshes:1});assert.equal(await page.locator('[data-test-payroll="payroll.ledger"] input').inputValue(),'retained');
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
