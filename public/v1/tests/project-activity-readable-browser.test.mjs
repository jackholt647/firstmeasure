import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {chromium} from 'playwright-core';

test('native lifecycle actions filter correctly, emphasize only verbs and open shared user previews',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:900,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://widgets.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.startsWith('/libraries/'))return route.fulfill({contentType:'application/javascript',body:await readFile(new URL('../../'+path.slice(1),import.meta.url))});
   return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><style>body{font-family:Arial;margin:30px}#shell{height:650px;width:550px;display:flex;flex-direction:column;border:1px solid #eee}.r-preview{flex:1;min-height:0}</style><section id="shell"><header class="r-modal-header"></header><main class="r-preview"></main></section>'});
  });
  await page.goto('http://widgets.test/');
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'viewer'};window.Portal={can:()=>true};window.resolved=[];
   const at='2026-10-12T04:00:00Z';
   window.PlatformAPI={users:{list:async()=>({users:[{id:'crew',name:'Casey Nguyen'}]})},media:{list:async()=>({media:[{id:'pdf',metadata:{title:'Roof inspection report'},owner:{slot:'documents'}}]})},work:{plan:async()=>({plan:{id:'plan',title:'Sales pipeline',root_nodes:[{id:'todo',plan_id:'plan',title:'Tighten downspout strap',actionable:true},{id:'stage',plan_id:'plan',title:'Installation',actionable:false}]}}),activity:async()=>({events:[
    {id:'task',type:'work.node.completed',plan_id:'plan',node_id:'todo',actor_user_id:'crew',created_at:at},
    {id:'stage',type:'work.node.completed',plan_id:'plan',node_id:'stage',created_at:at,payload:{reason:'child_rollup'}},
    {id:'event',type:'project.event_started',created_at:at,payload:{event:{title:'Roof inspection and estimate',scheduled_by_user_id:'crew'}}},
    {id:'check',type:'crew.checklist.item_completed',actor_user_id:'crew',created_at:at,payload:{title:'Verify flashing'}},
    {id:'photo',type:'media.uploaded',actor_user_id:'crew',created_at:at,payload:{title:'Finished roof panorama'}},
    {id:'pdf',type:'media.uploaded',created_at:at,payload:{media_id:'pdf'}},
    {id:'unsafe',type:'task.completed',actor_user_id:'crew',created_at:at,payload:{title:'<img src=x onerror="window.bad=true">'}}
   ]})},userActivity:{listForProject:async()=>({events:[{id:'audit',type:'work.node.completed',data:{occurred_at:at,metadata:{backed_work_event_id:'task'},actor_user_id:'crew'}}]})},publication:{resolveWidget:async(_org,input)=>{resolved.push(input);return {status:'ready',widget:{id:'user.summary',version:'1'}};},read:async()=>({status:'ready',value:{id:'crew',name:'Casey Nguyen',email:'casey@example.test',title:'Crew lead'}})}};
  });
  for(const file of ['project-trays/project-trays.js','platform-widgets/runtime.js'])await page.addScriptTag({url:'/libraries/'+file});
  await page.evaluate(async()=>{await FirstMateWidgets.ready;window.trays=FirstMateProjectTrays.mount(document.querySelector('#shell'),{project:{id:'one'}});});
  await page.getByRole('tab',{name:'Activity',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.fm-project-activity article').length===7);
  const task=page.locator('article').filter({hasText:'Tighten downspout strap'}),automatic=page.locator('article').filter({hasText:'Started Roof inspection and estimate'});
  assert.equal(await task.locator('strong').innerText(),'Completed');assert.equal(await task.locator('p').innerText(),'Completed Tighten downspout strap');
  assert.equal(await task.locator('p').evaluate(el=>getComputedStyle(el).fontWeight),'400');
  assert.equal(await task.locator('strong').evaluate(el=>getComputedStyle(el).fontWeight),'700');
  assert.equal(await automatic.getAttribute('data-fm-summary-type'),null);
  assert.equal(await page.locator('.fm-project-activity img').count(),0);assert.equal(await page.evaluate(()=>window.bad),undefined);
  await task.hover();await page.locator('[role="tooltip"]').getByText('casey@example.test',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>resolved.at(-1).type),'summary.user');assert.equal(await page.evaluate(()=>resolved.at(-1).target.id),'crew');
  await page.mouse.move(850,750);await page.locator('[role="tooltip"]').waitFor({state:'hidden'});
  await task.getByRole('button',{name:'Preview Casey Nguyen'}).focus();await page.locator('[role="tooltip"]').getByText('casey@example.test',{exact:true}).waitFor();
  const filter=page.getByRole('button',{name:/^Filter activity:/}),menu=page.getByRole('dialog',{name:'Activity filters'});
  await filter.click();await menu.getByRole('button',{name:'Only To-dos',exact:true}).click();assert.equal(await page.locator('article').count(),2);
  await menu.getByRole('checkbox',{name:'Field work & checklists',exact:true}).check();assert.equal(await page.locator('article').count(),3);
  await menu.getByRole('button',{name:'Only Workflow & stages',exact:true}).click();assert.equal(await page.locator('article').count(),1);assert.match(await page.locator('article').innerText(),/Installation/);
  await menu.getByRole('button',{name:'Only Scheduling',exact:true}).click();assert.equal(await page.locator('article').count(),1);assert.match(await page.locator('article').innerText(),/Roof inspection and estimate/);
  await menu.getByRole('button',{name:'Only Documents & signatures',exact:true}).click();assert.equal(await page.locator('article').count(),1);assert.match(await page.locator('article').innerText(),/Roof inspection report/);
  await menu.getByRole('button',{name:'Only Files & photos',exact:true}).click();assert.equal(await page.locator('article').count(),1);assert.match(await page.locator('article').innerText(),/Finished roof panorama/);
  await menu.getByRole('button',{name:'All activity',exact:true}).click();await page.keyboard.press('Escape');
  const folder=new URL('../../../output/activity-readability-20261012/',import.meta.url);await mkdir(folder,{recursive:true});
  await page.screenshot({path:new URL('readable-activity.png',folder).pathname.replace(/^\/(\w:)/,'$1')});
  await page.evaluate(()=>trays.destroy());assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
