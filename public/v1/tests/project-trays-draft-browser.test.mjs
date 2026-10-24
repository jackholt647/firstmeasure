import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';

// A New Report is a project that is not saved yet. To Do, Activity and Agent open
// on it; only adding a to-do or messaging the agent saves it, once, and the open
// trays then switch to the saved project without remounting.
async function draftPage(browser){
 const page=await browser.newPage({viewport:{width:1280,height:860}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('http://draft.test/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('../../'+path.slice(1),import.meta.url))});
  return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><section id="shell" style="display:flex;flex-direction:column;height:760px;width:900px"><header class="r-modal-header"></header><main class="r-preview">New Report</main></section>'});
 });
 await page.goto('http://draft.test/');
 await page.evaluate(()=>{
  window.__APP={userOrgId:'org',userId:'user'};window.project=null;window.saves=0;
  window.reads={todo:[],work:[],audit:[],conversation:[]};window.creates=[];window.sent=[];
  window.Portal={can:()=>true,tabs:{activateTab(){}},util:{currentBranchId:()=>'default'}};
  window.PlatformAPI={
   actionItems:{list:async(_o,query)=>{reads.todo.push(query);return {items:creates.filter(item=>item.project_id===query.projectId)};},create:async(_o,item)=>{creates.push(item);return {action_item:item};}},
   work:{configuration:async()=>({}),activity:async(_o,q)=>{reads.work.push(q.projectId);return {events:[]};}},
   userActivity:{listForProject:async(_o,p)=>{reads.audit.push(p);return {events:[]};}}
  };
  const thread={id:'project-thread',subject_id:'project:p-new'};
  window.AssistantAPI={context:async()=>{throw Error('A project surface never reads the global context');},
   projectConversation:async(_o,p)=>{reads.conversation.push(p);return {thread};},thread:async()=>({thread,messages:[]}),
   send:async(o,t,b)=>{sent.push({t,message:b.message});return {thread,assistant_message:{role:'assistant',content:'On it.'}};}};
  window.ensureProject=async()=>{await new Promise(resolve=>setTimeout(resolve,30));saves++;window.project={id:'p-new',address:'12 Oak St'};return window.project;};
 });
 for(const file of ['platform-action-items/platform-action-items.js','window-manager/window-manager.js','doc-markdown/firstmate-markdown.js','platform-assistant/platform-assistant.js','project-trays/project-trays.js'])await page.addScriptTag({url:'/libraries/'+file});
 await page.evaluate(()=>{window.trays=FirstMateProjectTrays.mount(document.querySelector('#shell'),{orgId:'org',getProject:()=>window.project,ensureProject:()=>window.ensureProject()});});
 return {page,errors};
}
const counts=page=>page.evaluate(()=>({saves,todo:reads.todo.length,work:reads.work.length,conversation:reads.conversation.length}));

test('a draft project opens To Do, Activity and Agent without saving; the first to-do saves it once and the trays adopt it',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const {page,errors}=await draftPage(browser);
  await page.getByRole('tab',{name:'Activity',exact:true}).click();
  const activity=page.getByRole('tabpanel',{name:'Activity'});
  await activity.getByText('No activity yet').waitFor();
  assert.doesNotMatch(await activity.innerText(),/Select or create/);
  await page.getByRole('tab',{name:'To Do',exact:true}).click();
  const todo=page.getByRole('tabpanel',{name:'To Do'}),input=todo.getByRole('textbox',{name:'Add manual to-do'});
  await input.waitFor();
  assert.doesNotMatch(await todo.innerText(),/Select or create/);
  await page.getByRole('tab',{name:'Agent',exact:true}).click();
  const agent=page.getByRole('tabpanel',{name:'Agent'});
  await agent.locator('[data-fma=input]').waitFor();
  assert.match(await agent.locator('.fma-welcome').innerText(),/this project/);
  // Opening and switching trays reads nothing and never creates a project.
  for(const name of ['To Do','Activity','Agent','To Do'])await page.getByRole('tab',{name,exact:true}).click();
  assert.deepEqual(await counts(page),{saves:0,todo:0,work:0,conversation:0});
  const mounted=await todo.evaluate(node=>{node.dataset.mountedOnce='yes';return node.querySelector('.pai-today-list')!==null;});
  assert.equal(mounted,true);
  await input.fill('Call the homeowner');await input.press('Enter');
  await page.waitForFunction(()=>creates.length===1&&reads.todo.length>0);
  assert.equal(await page.evaluate(()=>saves),1);
  assert.deepEqual(await page.evaluate(()=>[creates[0].project_id,creates[0].title,reads.todo.at(-1).projectId]),['p-new','Call the homeowner','p-new']);
  await todo.getByText('Call the homeowner').waitFor();
  assert.equal(await todo.getAttribute('data-mounted-once'),'yes','the To Do tray adopted the project without remounting');
  // Activity and Agent adopted the saved project too.
  await page.getByRole('tab',{name:'Activity',exact:true}).click();
  await page.waitForFunction(()=>reads.work.includes('p-new'));
  assert.deepEqual(await page.evaluate(()=>[...new Set(reads.work)]),['p-new']);
  await page.getByRole('tab',{name:'Agent',exact:true}).click();
  await page.waitForFunction(()=>reads.conversation.includes('p-new'));
  assert.equal(await page.evaluate(()=>saves),1);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('messaging the agent on a draft saves the project once and sends to its conversation',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const {page,errors}=await draftPage(browser);
  await page.getByRole('tab',{name:'Agent',exact:true}).click();
  const agent=page.getByRole('tabpanel',{name:'Agent'});
  await agent.locator('[data-fma=input]').fill('What should I measure first?');
  assert.deepEqual(await counts(page),{saves:0,todo:0,work:0,conversation:0});
  await agent.locator('[data-fma=send]').click();
  await page.waitForFunction(()=>sent.length===1);
  assert.deepEqual(await page.evaluate(()=>[saves,reads.conversation,sent[0]]),[1,['p-new'],{t:'project-thread',message:'What should I measure first?'}]);
  await agent.getByText('On it.').waitFor();
  // A tray opened after the save belongs to the saved project.
  await page.getByRole('tab',{name:'To Do',exact:true}).click();
  await page.waitForFunction(()=>reads.todo.length===1);
  assert.equal(await page.evaluate(()=>reads.todo[0].projectId),'p-new');
  assert.equal(await page.evaluate(()=>saves),1);
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});

test('a failed save keeps the draft trays usable and reports it in the agent',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const {page}=await draftPage(browser);
  await page.evaluate(()=>{window.ensureProject=async()=>{throw Error('Enter a property address first.');};});
  await page.getByRole('tab',{name:'Agent',exact:true}).click();
  const agent=page.getByRole('tabpanel',{name:'Agent'});
  await agent.locator('[data-fma=input]').fill('Hello');await agent.locator('[data-fma=send]').click();
  await agent.getByText('Enter a property address first.').waitFor();
  assert.deepEqual(await counts(page),{saves:0,todo:0,work:0,conversation:0});
  assert.equal(await page.evaluate(()=>sent.length),0);
 }finally{await browser.close();}
});
