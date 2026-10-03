import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('project widgets fill trays and independent hosts; activity filters, paginates, retries and cleans up',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1180,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://widgets.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.startsWith('/libraries/'))return route.fulfill({contentType:path.endsWith('.json')?'application/json':'application/javascript',body:await readFile(new URL('../../'+path.slice(1),import.meta.url))});
   return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><style>body{margin:24px;font-family:Arial;background:#f5f6f8}#shell{display:flex;flex-direction:column;height:700px;width:750px;background:white;border:1px solid #e4e7ec;border-radius:10px;overflow:hidden}header{height:38px}.r-preview{padding:20px}#other{position:absolute;left:810px;top:24px;width:320px;height:360px;border:1px solid #e4e7ec}</style><section id="shell"><header class="r-modal-header"></header><main class="r-preview">Project overview</main></section><aside id="other"></aside>'});
  });
  await page.goto('http://widgets.test/');
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org'};window.Portal={can:key=>key!=='channels.separate_project_notes'};window.calls=[];window.fail=false;
   const now=new Date();const time=n=>new Date(+now-n*60000).toISOString();
   window.PlatformAPI={work:{activity:async(_org,q)=>{calls.push(q);if(fail)throw Error('Connection interrupted');return q.before?{events:[{id:'old',type:'report.created',payload:{summary:'Roof report completed'},created_at:'2025-01-01T12:00:00Z'}]}:{events:Array.from({length:100},(_,i)=>({id:'w'+i,type:i%2?'task.completed':'project.updated',payload:{summary:i%2?'Completed site inspection':'Updated project details',actor_name:'Alex Morgan'},created_at:time(i)})),next_before:'page2'};}},userActivity:{listForProject:async()=>({events:[{id:'w0',type:'file.uploaded',data:{summary:'Added roof reference photos'},created_at:time(1)},{id:'hidden',type:'channels.message.created',created_at:time(2)}]})}};
   window.Portal.ProjectNotes={mount:node=>{node.innerHTML='<textarea aria-label="Note draft"></textarea>';return {destroy(){node.replaceChildren();}};}};
   window.PlatformAssistant={mountProject:node=>{const el=document.createElement('div');el.textContent='Project agent';node.append(el);return {moveTo:parent=>parent.append(el),setCompact(){},destroy(){el.remove();}};}};
  });
  // Exercise the portal's load order: tray definitions precede the runtime.
  for(const file of ['project-trays/project-trays.js','platform-widgets/runtime.js','platform-action-items/platform-action-items.js'])await page.addScriptTag({url:'/libraries/'+file});
  assert.deepEqual(await page.evaluate(async()=> (await FirstMateWidgets.list()).filter(d=>d.id.startsWith('project.')).map(d=>[d.id,d.sizing.mode])),[['project.notes','fill'],['project.todo','fill'],['project.messages','fill'],['project.activity','fill'],['project.agent','fill']]);
  await page.evaluate(()=>{window.trays=FirstMateProjectTrays.mount(document.querySelector('#shell'),{project:{id:'one'}});});
  await page.getByRole('tab',{name:'Notes',exact:true}).click();await page.getByRole('textbox',{name:'Note draft'}).fill('Preserve this note');
  await page.getByRole('tab',{name:'Activity',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.fm-project-activity article').length===101);
  assert.equal(await page.locator('.fm-project-tray-panel[aria-label=Activity]').getAttribute('data-sizing'),'fill');
  assert.equal(await page.locator('.fm-project-activity p').first().evaluate(el=>getComputedStyle(el).fontSize),'11px');
  await page.getByRole('searchbox',{name:'Search activity'}).fill('reference');assert.equal(await page.locator('.fm-project-activity article').count(),1);
  await page.getByRole('searchbox').fill('');
  const filter=page.locator('#shell').getByRole('button',{name:/^Filter activity:/}),menu=page.locator('#shell').getByRole('dialog',{name:'Activity filters'});
  await filter.click();await menu.getByRole('checkbox',{name:'To-dos',exact:true}).check();assert.equal(await page.locator('.fm-project-activity article').count(),50);
  await menu.getByRole('checkbox',{name:'Files & photos',exact:true}).check();assert.equal(await page.locator('.fm-project-activity article').count(),51);
  assert.match(await filter.innerText(),/To-dos \+1/);
  await menu.getByRole('searchbox').fill('bill');assert.equal(await menu.getByRole('checkbox').count(),1);assert.equal(await menu.getByRole('checkbox',{name:'Payments & billing'}).count(),1);
  await menu.getByRole('searchbox').fill('');await menu.getByRole('button',{name:'Only Files & photos',exact:true}).click();assert.equal(await page.locator('.fm-project-activity article').count(),1);
  assert.equal(await menu.getByRole('checkbox',{name:'To-dos',exact:true}).isChecked(),false);
  await menu.getByRole('checkbox',{name:'Files & photos',exact:true}).uncheck();assert.equal(await page.locator('.fm-project-activity article').count(),101);
  await menu.getByRole('checkbox',{name:'To-dos',exact:true}).focus();await page.keyboard.press('Space');assert.equal(await page.locator('.fm-project-activity article').count(),50);
  await page.keyboard.press('Escape');assert.equal(await menu.count(),0);assert.equal(await filter.evaluate(el=>el===document.activeElement),true);assert.equal(await page.locator('.fm-project-content').getAttribute('data-tray-open'),'true');
  await page.getByRole('tab',{name:'Notes',exact:true}).click();await page.getByRole('tab',{name:'Activity',exact:true}).click();await filter.press('ArrowDown');assert.equal(await menu.getByRole('searchbox').evaluate(el=>el===document.activeElement),true);assert.equal(await menu.getByRole('checkbox',{name:'To-dos',exact:true}).isChecked(),true);
  await menu.getByRole('button',{name:'All activity',exact:true}).click();await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Load older activity'}).click();await page.getByText('Roof report completed',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Refresh activity'}).click();await page.waitForFunction(()=>!document.querySelector('.fm-activity-refresh').disabled);assert.equal(await page.getByText('Roof report completed',{exact:true}).count(),1);
  await page.evaluate(()=>window.fail=true);await page.getByRole('button',{name:'Refresh activity'}).click();await page.getByRole('alert').waitFor();assert.equal(await page.locator('.fm-project-activity article').count(),102);
  await page.evaluate(()=>window.fail=false);await page.getByRole('button',{name:'Refresh activity'}).click();await page.waitForFunction(()=>document.querySelector('[role=alert]').hidden);
  await page.evaluate(async()=>{window.other=FirstMateWidgets.mount(document.querySelector('#other'),{id:'project.activity',version:'1',target:{organizationId:'org',projectId:'two'}},{surface:'dashboard'});await other.ready;});
  await page.waitForFunction(()=>calls.some(c=>c.projectId==='two'));
  assert.ok(await page.locator('#other').evaluate(el=>el.scrollHeight<=el.clientHeight+1));
  await page.locator('#shell .fm-project-activity').evaluate(el=>el.scrollTop=0);
  await filter.click();
  await mkdir(new URL('../../../output/activity-filters-20261003/',import.meta.url),{recursive:true});
  await page.screenshot({path:new URL('../../../output/activity-filters-20261003/activity-filter.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1')});
  const bounds=await menu.boundingBox(),host=await page.locator('#shell').boundingBox();assert.ok(bounds.y+bounds.height<=host.y+host.height);
  await page.setViewportSize({width:390,height:640});await page.evaluate(()=>{document.querySelector('#shell').style.width='100%';document.querySelector('#shell').style.height='540px';document.querySelector('#other').hidden=true;});
  await page.waitForFunction(()=>{const menu=document.querySelector('#shell .fm-activity-filter-menu').getBoundingClientRect();return menu.right<=innerWidth&&menu.bottom<=document.querySelector('#shell').getBoundingClientRect().bottom;});
  await page.locator('#shell').getByRole('searchbox',{name:'Search activity',exact:true}).click();assert.equal(await menu.count(),0);
  await page.getByRole('tab',{name:'Notes',exact:true}).click();assert.equal(await menu.count(),0);assert.equal(await page.getByRole('textbox',{name:'Note draft'}).inputValue(),'Preserve this note');
  await page.getByRole('tab',{name:'Agent',exact:true}).click();await page.getByText('Project agent',{exact:true}).waitFor();
  await page.evaluate(()=>{trays.destroy();other.destroy();});
  assert.equal(await page.locator('.fm-activity-widget').count(),0);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
