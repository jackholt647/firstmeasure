import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright-core';
test('To Do tray uses shared list, scopes reads to project, refreshes and switches safely',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage();await page.setContent('<div id="shell"><header class="r-modal-header"></header><main class="r-preview" style="height:600px"></main></div>');
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'user'};window.project={};window.reads=[];
   window.Portal={can:key=>key!=='channels.separate_project_notes'};
   window.PlatformAPI={actionItems:{list:async(org,query)=>{reads.push({org,query});return {items:[],action_items:[]};}},work:{configuration:async()=>({})}};
  });
  for(const f of ['platform-action-items/platform-action-items.js','project-trays/project-trays.js'])await page.addScriptTag({content:await readFile(new URL('../../libraries/'+f,import.meta.url),'utf8')});
  await page.evaluate(()=>window.trays=FirstMateProjectTrays.mount(document.querySelector('#shell'),{getProject:()=>project}));
  assert.deepEqual(await page.getByRole('tab').allTextContents(),['','','','']);
  assert.deepEqual(await page.getByRole('tab').evaluateAll(es=>es.map(e=>e.getAttribute('aria-label'))),['Notes','To Do','Activity','Agent']);
  await page.getByRole('tab',{name:'To Do',exact:true}).click();
  assert.match(await page.getByRole('tabpanel',{name:'To Do'}).innerText(),/Select or create a project/);
  assert.equal(await page.evaluate(()=>reads.length),0);
  await page.evaluate(()=>{project={id:'p1',address:'123 Main'};trays.update();});
  await page.waitForSelector('.pai-today-list');
  assert.equal(await page.evaluate(()=>reads[0].query.projectId),'p1');
  assert.equal(await page.locator('.pai-items-scroll').count(),1);
  await page.getByRole('button',{name:'Close project tray'}).click();
  await page.getByRole('tab',{name:'To Do',exact:true}).click();
  await page.waitForFunction(()=>reads.length===2);
  await page.evaluate(()=>{project={id:'p2'};trays.update();});
  await page.getByRole('tab',{name:'To Do',exact:true}).click();
  await page.waitForFunction(()=>reads.length===3);
  assert.deepEqual(await page.evaluate(()=>reads.map(r=>r.query.projectId)),['p1','p1','p2']);
  await page.evaluate(()=>trays.destroy());assert.equal(await page.locator('.fm-project-tray').count(),0);
 }finally{await browser.close();}
});
