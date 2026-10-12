import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {chromium} from 'playwright-core';

test('native lifecycle actions filter correctly, emphasize only verbs and open shared user previews',async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 try{
  const page=await browser.newPage({viewport:{width:900,height:800}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://widgets.test/**',async route=>{
   const path=new URL(route.request().url()).pathname;
   if(path.startsWith('/libraries/')){
    const hosted=process.env.FM_ACTIVITY_WIDGET_FIXTURES&&/^\/libraries\/platform-widgets\/(runtime|grouped-widgets)\.js$/.test(path);
    return route.fulfill({contentType:'application/javascript',body:await readFile(hosted?join(process.env.FM_ACTIVITY_WIDGET_FIXTURES,path.split('/').pop()):new URL('../../'+path.slice(1),import.meta.url))});
   }
   return route.fulfill({contentType:'text/html',body:'<meta charset="utf-8"><style>body{font-family:Arial;margin:30px}#modal{position:fixed;inset:0;z-index:2147483100;background:white;padding:30px}#shell{height:720px;width:650px;display:flex;flex-direction:column;border:1px solid #eee}.r-preview{flex:1;min-height:0}</style><div id="modal"><section id="shell"><header class="r-modal-header"></header><main class="r-preview"></main></section></div>'});
  });
  await page.goto('http://widgets.test/');
  await page.evaluate(()=>{
   window.__APP={userOrgId:'org',userId:'viewer'};window.Portal={can:key=>key!=='channels.separate_project_notes'};window.resolved=[];window.activityCalls=0;window.extraNotes=[];
   window.PlatformRealtime={subscribe(_oid,_prefix,listener,options){window.activityEvent=listener;window.activityResync=options.onResync;return ()=>window.activityStopped=true;}};
   const at='2026-10-12T04:00:00Z';
   window.PlatformAPI={users:{list:async()=>({users:[{id:'crew',name:'Casey Nguyen'}]})},media:{list:async()=>({media:[{id:'pdf',metadata:{title:'Roof inspection report'},owner:{slot:'documents'}}]})},work:{plan:async()=>({plan:{id:'plan',title:'Sales pipeline',root_nodes:[{id:'todo',plan_id:'plan',title:'Tighten downspout strap',actionable:true},{id:'stage',plan_id:'plan',title:'Installation',actionable:false}]}}),activity:async()=>{activityCalls++;return {events:[
    {id:'task',type:'work.node.completed',plan_id:'plan',node_id:'todo',actor_user_id:'crew',created_at:at},
    {id:'stage',type:'work.node.completed',plan_id:'plan',node_id:'stage',created_at:at,payload:{reason:'child_rollup'}},
    {id:'event',type:'project.event_started',created_at:at,payload:{event:{title:'Roof inspection and estimate',scheduled_by_user_id:'crew'}}},
    {id:'check',type:'crew.checklist.item_completed',actor_user_id:'crew',created_at:at,payload:{title:'Verify flashing'}},
    ...Array.from({length:8},(_,i)=>({id:'photo'+i,type:'media.uploaded',actor_user_id:'crew',created_at:new Date(Date.parse(at)+i*1000).toISOString(),payload:{media_id:'photo'+i,file_name:'internal-image-'+i+'.jpg',content_type:'image/jpeg'}})),
    ...Array.from({length:5},(_,i)=>({id:'pdf'+i,type:'media.uploaded',actor_user_id:'crew',created_at:at,payload:{media_id:i===0?'pdf':'pdf'+i,file_name:'internal-document-'+i+'.pdf',content_type:'application/pdf'}})),
    {id:'email',type:'communication.received',created_at:at,payload:{channel:'email',sender_address:'taylor@example.test'}},
    {id:'unsafe',type:'task.completed',actor_user_id:'crew',created_at:at,payload:{title:'<img src=x onerror="window.bad=true">'}}
   ]};}},userActivity:{listForProject:async()=>({events:[{id:'audit',type:'work.node.completed',data:{occurred_at:at,metadata:{backed_work_event_id:'task'},actor_user_id:'crew'}}]})},publication:{resolveWidget:async(_org,input)=>{resolved.push(input);return {status:'ready',widget:{id:'user.summary',version:'1'}};},read:async()=>({status:'ready',value:{id:'crew',name:'Casey Nguyen',email:'casey@example.test',title:'Crew lead'}})}};
   window.ChannelsAPI={channels:{list:async(_oid,params)=>{if(params.initialize!==false)throw Error('Must not initialize channels');return {channels:[{id:'channel',project_id:'one',separate_notes:false}]};}},messages:{list:async()=>({channel:{separate_notes:false},messages:[{id:'note1',text:'Weather confirmed',created_at:at,author:{id:'crew',name:'Casey Nguyen'},metadata:{project_note:true}},{id:'note2',text:'Homeowner update',created_at:at,author:{id:'crew',name:'Casey Nguyen'}},...extraNotes]})}};
  });
  for(const file of ['project-trays/project-trays.js','platform-widgets/runtime.js'])await page.addScriptTag({url:'/libraries/'+file});
  await page.evaluate(async()=>{await FirstMateWidgets.ready;window.trays=FirstMateProjectTrays.mount(document.querySelector('#shell'),{project:{id:'one',contacts:[{name:'Taylor Chen',email:'taylor@example.test'}]}});});
  await page.getByRole('tab',{name:'Activity',exact:true}).click();
  await page.waitForFunction(()=>document.querySelectorAll('.fm-project-activity article').length===10);
  const task=page.locator('article').filter({hasText:'Tighten downspout strap'}),automatic=page.locator('article').filter({hasText:'Started Roof inspection and estimate'});
  assert.equal(await task.locator('strong').innerText(),'Completed');assert.equal(await task.locator('p').innerText(),'Completed Tighten downspout strap');
  assert.equal(await task.locator('p').evaluate(el=>getComputedStyle(el).fontWeight),'400');
  assert.equal(await task.locator('strong').evaluate(el=>getComputedStyle(el).fontWeight),'700');
  assert.equal(await automatic.getAttribute('data-fm-summary-type'),null);
  assert.equal(await task.getAttribute('data-fm-summary-type'),null,'activity rows do not trigger a user preview');
  assert.equal(await task.getByRole('button',{name:'Preview Casey Nguyen'}).getAttribute('data-fm-summary-type'),'summary.user');
  await task.locator('p').hover();await page.waitForTimeout(300);assert.equal(await page.locator('[role="tooltip"]').count(),0,'hovering the description does not open a preview');
  await task.locator('time').hover();await page.waitForTimeout(300);assert.equal(await page.locator('[role="tooltip"]').count(),0,'hovering the time does not open a preview');
  assert.equal(await page.locator('.fm-project-activity img').count(),0);assert.equal(await page.evaluate(()=>window.bad),undefined);
  await task.getByRole('button',{name:'Preview Casey Nguyen'}).hover();await page.locator('[role="tooltip"]').getByText('casey@example.test',{exact:true}).waitFor({timeout:5000});
  assert.equal(await page.locator('[role="tooltip"]').evaluate(el=>{const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.left+20,r.top+30));}),true,'preview must be above the actual project-window layer');
  assert.equal(await page.evaluate(()=>resolved.at(-1).type),'summary.user');assert.equal(await page.evaluate(()=>resolved.at(-1).target.id),'crew');
  await page.mouse.move(850,750);await page.locator('[role="tooltip"]').waitFor({state:'hidden'});
  await task.getByRole('button',{name:'Preview Casey Nguyen'}).focus();await page.locator('[role="tooltip"]').getByText('casey@example.test',{exact:true}).waitFor();
  await page.evaluate(()=>{window.originalTask=document.querySelector('.fm-activity-actor').closest('article');window.previousCalls=activityCalls;activityEvent({topic:'work.activity.created',payload:{project_id:'one'}});});
  await page.waitForFunction(()=>activityCalls>previousCalls&&document.querySelector('.fm-project-activity').getAttribute('aria-busy')==='false');
  assert.equal(await page.evaluate(()=>originalTask.isConnected),true,'unchanged auto refresh preserves hover anchors');
  assert.equal(await page.getByRole('button',{name:'Refresh activity'}).count(),0);assert.equal(await page.locator('.fm-activity-count').count(),0);
  const searchBox=await page.getByRole('searchbox',{name:'Search activity',exact:true}).boundingBox(),filterBox=await page.getByRole('button',{name:/^Filter activity:/}).boundingBox();assert.ok(filterBox.x>searchBox.x+searchBox.width);assert.ok(Math.abs(filterBox.y-searchBox.y)<2,'search and filter share one row');
  assert.equal(await page.locator('article').filter({hasText:'Received email from Taylor Chen'}).locator('strong').innerText(),'Received email');
  assert.equal(await page.locator('article').filter({hasText:'Uploaded 8 images'}).count(),1);assert.equal(await page.locator('article').filter({hasText:'Uploaded 5 documents'}).count(),1);
  assert.equal(await page.locator('article').filter({hasText:'internal-image'}).count(),0);
  const filter=page.getByRole('button',{name:/^Filter activity:/}),menu=page.getByRole('dialog',{name:'Activity filters'});
  await filter.click();await menu.getByRole('button',{name:'Only To-dos',exact:true}).click();assert.equal(await page.locator('article').count(),2);
  await menu.getByRole('checkbox',{name:'Field work & checklists',exact:true}).check();assert.equal(await page.locator('article').count(),3);
  await menu.getByRole('button',{name:'Only Workflow & stages',exact:true}).click();assert.equal(await page.locator('article').count(),1);assert.match(await page.locator('article').innerText(),/Installation/);
  await menu.getByRole('button',{name:'Only Scheduling',exact:true}).click();assert.equal(await page.locator('article').count(),1);assert.match(await page.locator('article').innerText(),/Roof inspection and estimate/);
  await menu.getByRole('button',{name:'Only Documents & signatures',exact:true}).click();assert.equal(await page.locator('article').count(),1);assert.match(await page.locator('article').innerText(),/Uploaded 5 documents/);
  await menu.getByRole('button',{name:'Only Files & photos',exact:true}).click();assert.equal(await page.locator('article').count(),1);assert.match(await page.locator('article').allInnerTexts().then(v=>v.join(' ')),/Uploaded 8 images/);
  await menu.getByRole('button',{name:'Only Notes',exact:true}).click();assert.equal(await page.locator('article').count(),2);assert.match(await page.locator('article').allInnerTexts().then(v=>v.join(' ')),/Weather confirmed/);
  await page.evaluate(()=>{extraNotes.push({id:'new-note',text:'Warranty delivered',created_at:'2026-10-12T04:02:00Z',author:{id:'crew',name:'Casey Nguyen'}});activityEvent({topic:'channels.message.created',payload:{project_id:'one'}});});
  await page.waitForFunction(()=>document.querySelectorAll('.fm-project-activity article').length===3);assert.equal(await menu.locator('.fm-activity-filter-option').filter({has:page.getByRole('checkbox',{name:'Notes',exact:true})}).locator('.fm-activity-filter-total').innerText(),'3');
  await menu.getByRole('button',{name:'All activity',exact:true}).click();await page.keyboard.press('Escape');
  const folder=new URL('../../../output/activity-readability-20261012/',import.meta.url);await mkdir(folder,{recursive:true});
  await page.screenshot({path:new URL('readable-activity.png',folder).pathname.replace(/^\/(\w:)/,'$1')});
  await page.evaluate(()=>trays.destroy());assert.equal(await page.evaluate(()=>activityStopped),true);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
